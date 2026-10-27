/* =========================================================================
 *  AIRA IA - Sensor de tokens y conmutacion automatica de IA
 *
 *  QUE HACE:
 *   - Lleva la cuenta de los tokens que consume cada proveedor de IA
 *     (Gemini, OpenAI, OpenRouter) leyendo el "usage" que devuelve cada uno.
 *   - Guarda el consumo en data/ai-usage.json para que no se pierda al
 *     reiniciar el servidor.
 *   - Cuando a una IA le quedan menos tokens que la reserva (o el proveedor
 *     responde "cuota agotada"), la marca como agotada y la siguiente
 *     consulta pasa automaticamente a la IA 2 (y luego a la IA 3).
 *   - Consulta a OpenRouter los creditos reales de la cuenta (si hay clave),
 *     como dato extra de control.
 *
 *  Se configura con variables de entorno (todas opcionales):
 *     AI_TOKENS_GEMINI / AI_TOKENS_OPENAI / AI_TOKENS_OPENROUTER  (presupuesto)
 *     AI_TOKEN_RESERVE      -> colchon minimo antes de cambiar de IA (800)
 *     AI_TOKEN_WINDOW_HOURS -> cada cuantas horas se reinicia la cuenta (24)
 *     AI_QUOTA_COOLDOWN_MIN -> minutos de castigo tras "cuota agotada" (60)
 *     AI_FALLBACK_ORDER     -> orden de respaldo: gemini,openrouter,openai
 * =========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const LABELS = { gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' };

function num(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Peticion HTTPS simple que devuelve JSON (o null). Nunca lanza. */
function httpJson(options, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { done({ status: res.statusCode || 0, data: JSON.parse(data) }); }
          catch (e) { done({ status: res.statusCode || 0, data: null }); }
        });
      });
    } catch (e) { return done(null); }
    req.on('error', () => done(null));
    req.setTimeout(timeoutMs || 5000, () => { req.destroy(); done(null); });
    req.end();
  });
}

/** Clasifica el error de un proveedor: ¿fue por falta de tokens/cuota? */
function classifyError(err) {
  const message = String((err && err.message) || '');
  const status = Number(err && err.status) || 0;
  const retryAfter = Number(err && err.retryAfter) || 0;
  const quotaPattern = /quota|cuota|saldo|exhaust|insufficient|billing|credit|resource_exhausted|too many requests|rate.?limit|limite de (uso|peticiones|tokens)|sin tokens|agotad/i;
  const quota = status === 402 || status === 429 || quotaPattern.test(message);
  // Falta de saldo/cuota real => castigo largo. Un 429 temporal => solo 2 min.
  const hardQuota = /quota|cuota|saldo|exhaust|insufficient|billing|credit|agotad/i.test(message);
  return {
    quota,
    cooldownMs: retryAfter > 0 ? retryAfter * 1000 : (hardQuota ? 0 : (status === 429 ? 2 * 60 * 1000 : 0)),
    reason: message || 'Sin detalle del proveedor.'
  };
}

/**
 * Crea el sensor.
 * providers: { nombre: { key: () => string, budget: number, model: () => string } }
 */
function createQuota(opts) {
  const options = opts || {};
  const providers = options.providers || {};
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const stateFile = path.join(dataDir, 'ai-usage.json');

  const reserve = Math.max(0, num(options.reserve, 800));
  const windowHours = Math.max(1, num(options.windowHours, 24));
  const windowMs = windowHours * 60 * 60 * 1000;
  const cooldownMs = Math.max(1, num(options.cooldownMinutes, 60)) * 60 * 1000;
  const primary = String(options.primary || '').trim() || Object.keys(providers)[0] || 'gemini';

  // Prioridad fija: la IA principal es "IA 1", el resto son respaldos "IA 2", "IA 3".
  const preferredOrder = [primary].concat(
    (Array.isArray(options.fallbackOrder) ? options.fallbackOrder : [])
      .map((n) => String(n || '').trim())
      .filter((n) => n && n !== primary)
  ).concat(Object.keys(providers).filter((n) => n !== primary && (options.fallbackOrder || []).indexOf(n) === -1));

  const state = { providers: {}, lastSwitch: null };

  function priority(name) {
    const i = preferredOrder.indexOf(name);
    return i === -1 ? 99 : i;
  }

  /** Orden de roles para una IA principal pedida: [IA1, IA2, IA3]. */
  function rolesFor(requested) {
    const first = providers[requested] ? requested : primary;
    const list = [first];
    (Array.isArray(options.fallbackOrder) ? options.fallbackOrder : []).forEach((n) => {
      if (providers[n] && list.indexOf(n) === -1) list.push(n);
    });
    Object.keys(providers).forEach((n) => {
      if (list.indexOf(n) === -1) list.push(n);
    });
    return list;
  }

  function roleOf(name, requested) {
    const i = rolesFor(requested).indexOf(name);
    return i === -1 ? priority(name) : i;
  }

  function label(name) {
    return LABELS[name] || name;
  }

  function configured(name) {
    const p = providers[name];
    try { return Boolean(p && p.key && p.key()); } catch (e) { return false; }
  }

  function ensure(name) {
    const now = Date.now();
    let r = state.providers[name];
    if (!r || typeof r !== 'object') {
      r = state.providers[name] = {
        windowStart: now, used: 0, exhaustedUntil: 0, exhaustedReason: '',
        lastError: '', lastUsedAt: 0, credits: null, creditsAt: 0
      };
    }
    // Reinicio automatico de la ventana (diaria por defecto).
    if (!r.windowStart || now - r.windowStart >= windowMs) {
      r.windowStart = now;
      r.used = 0;
      r.exhaustedUntil = 0;
      r.exhaustedReason = '';
      r.lastError = '';
    }
    return r;
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && raw.providers && typeof raw.providers === 'object') {
        Object.keys(raw.providers).forEach((name) => {
          if (!providers[name]) return;
          const saved = raw.providers[name] || {};
          const r = ensure(name);
          ['windowStart', 'used', 'exhaustedUntil', 'lastUsedAt', 'creditsAt'].forEach((k) => {
            if (Number.isFinite(Number(saved[k]))) r[k] = Number(saved[k]);
          });
          ['exhaustedReason', 'lastError'].forEach((k) => {
            if (typeof saved[k] === 'string') r[k] = saved[k];
          });
          if (saved.credits && typeof saved.credits === 'object') r.credits = saved.credits;
        });
        if (raw.lastSwitch && typeof raw.lastSwitch === 'object') state.lastSwitch = raw.lastSwitch;
      }
    } catch (e) { /* primer arranque o archivo dañado: se ignora */ }
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, providers: state.providers, lastSwitch: state.lastSwitch }, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      console.warn('[AIRA] No se pudo guardar el consumo de tokens: ' + (e && e.message));
    }
  }

  function limitFor(name) {
    const p = providers[name] || {};
    const limit = Math.max(0, num(p.budget, 0));
    return limit > 0 ? limit : null;
  }

  function remaining(name) {
    const limit = limitFor(name);
    if (limit == null) return null;
    return Math.max(0, limit - ensure(name).used);
  }

  function saturated(name) {
    const r = ensure(name);
    if (r.exhaustedUntil > Date.now()) return true;
    const rem = remaining(name);
    return rem != null && rem <= reserve;
  }

  function available(name) {
    if (!providers[name] || !configured(name)) return false;
    return !saturated(name);
  }

  function score(name) {
    const rem = remaining(name);
    const limit = limitFor(name);
    if (rem == null || !limit) return 0.5; // sin presupuesto declarado: prioridad media
    return rem / limit;
  }

  /** Orden de intento: la IA 1 si tiene saldo; despues las que mas tokens tengan. */
  function order(requested, allowFallback) {
    const first = providers[requested] ? requested : primary;
    const list = [];
    if (configured(first)) list.push(first);
    if (allowFallback !== false) {
      Object.keys(providers)
        .filter((n) => n !== first && configured(n))
        .sort((a, b) => (score(b) - score(a)) || (priority(a) - priority(b)))
        .forEach((n) => list.push(n));
    }
    const usable = list.filter(available);
    if (usable.length) return usable;
    // Todos agotados: se intenta igual, empezando por el que mas saldo tenga.
    return list.slice().sort((a, b) => (score(b) - score(a)) || (priority(a) - priority(b)));
  }

  function markExhausted(name, reason, untilMs) {
    const r = ensure(name);
    const floor = untilMs && untilMs > Date.now() ? untilMs : Date.now() + cooldownMs;
    r.exhaustedUntil = Math.max(r.exhaustedUntil || 0, floor);
    r.exhaustedReason = String(reason || 'Cuota agotada');
    save();
    console.warn('[AIRA] ' + label(name) + ' marcada como agotada: ' + r.exhaustedReason);
  }

  /** Guarda el consumo real que informo el proveedor. */
  function recordSuccess(name, usage, model, requested) {
    const r = ensure(name);
    const total = Math.max(0, Number(
      usage && (usage.total != null ? usage.total : (usage.totalTokenCount != null ? usage.totalTokenCount : usage.total_tokens))
    ) || 0);
    if (total > 0) {
      r.used += total;
      r.lastUsedAt = Date.now();
      const lim = limitFor(name);
      if (lim != null && lim - r.used <= reserve) {
        markExhausted(name, 'Se agotó el presupuesto de tokens (' + r.used + '/' + lim + ').', r.windowStart + windowMs);
      }
    } else {
      r.lastUsedAt = Date.now();
    }
    if (model) r.model = model;
    r.lastError = '';
    save();
    return entry(name, requested);
  }

  /** Guarda un fallo. Si es de cuota, castiga al proveedor y permite el cambio. */
  function recordFailure(name, err) {
    const r = ensure(name);
    const info = classifyError(err);
    r.lastError = info.reason;
    if (info.quota) {
      const until = Date.now() + (info.cooldownMs || cooldownMs);
      r.exhaustedUntil = Math.max(r.exhaustedUntil || 0, until);
      r.exhaustedReason = 'El proveedor informó falta de cuota o límite: ' + info.reason;
    }
    save();
    return info;
  }

  function markSwitch(from, to, reason) {
    if (!from || !to || from === to) return null;
    const prev = state.lastSwitch;
    // No repetir el aviso en cada mensaje mientras siga respondiendo la misma IA.
    if (prev && prev.from === from && prev.to === to && Date.now() - prev.at < 10 * 60 * 1000) return null;
    state.lastSwitch = { from, to, reason: String(reason || ''), at: Date.now() };
    save();
    console.warn('[AIRA] Cambio automático de IA: ' + label(from) + ' -> ' + label(to) + ' (' + state.lastSwitch.reason + ')');
    return state.lastSwitch;
  }

  function entry(name, requested) {
    const r = ensure(name);
    const limit = limitFor(name);
    const rem = remaining(name);
    const p = providers[name] || {};
    let model = '';
    try { model = p.model ? p.model() : ''; } catch (e) { model = ''; }
    const exhausted = saturated(name);
    const roleIndex = roleOf(name, requested);
    return {
      name,
      label: label(name),
      slot: roleIndex + 1,
      role: 'IA ' + (roleIndex + 1),
      configured: configured(name),
      model: model || r.model || '',
      limit,
      used: Math.round(r.used),
      remaining: rem == null ? null : Math.round(rem),
      percent: limit ? Math.max(0, Math.min(100, Math.round((rem / limit) * 100))) : null,
      exhausted,
      exhaustedUntil: r.exhaustedUntil > Date.now() ? r.exhaustedUntil : 0,
      exhaustedReason: exhausted && r.exhaustedUntil > Date.now() ? r.exhaustedReason : '',
      lastError: r.lastError || '',
      lastUsedAt: r.lastUsedAt || 0,
      windowStart: r.windowStart,
      windowResetsAt: r.windowStart + windowMs,
      credits: r.credits || null,
      creditsAt: r.creditsAt || 0
    };
  }

  function snapshot(requested) {
    const first = providers[requested] ? requested : primary;
    const sorted = Object.keys(providers).sort((a, b) => roleOf(a, first) - roleOf(b, first));
    const list = order(first, options.allowFallback !== false);
    return {
      updatedAt: Date.now(),
      reserve,
      windowHours,
      primary: first,
      active: list[0] || null,
      order: list,
      lastSwitch: state.lastSwitch,
      providers: sorted.map((n) => entry(n, first))
    };
  }

  /** OpenRouter publica los creditos reales de la cuenta. Solo informativo. */
  async function refreshExternal(force) {
    const name = 'openrouter';
    if (!providers[name] || !configured(name)) return;
    const r = ensure(name);
    if (!force && Date.now() - (r.creditsAt || 0) < 60000) return;
    const res = await httpJson({
      method: 'GET',
      hostname: 'openrouter.ai',
      path: '/api/v1/key',
      headers: { Authorization: 'Bearer ' + providers[name].key() }
    }, 5000);
    r.creditsAt = Date.now();
    const data = res && res.data && res.data.data;
    if (data && typeof data === 'object') {
      r.credits = {
        limit: data.limit == null ? null : Number(data.limit),
        remaining: data.limit_remaining == null ? null : Number(data.limit_remaining),
        usage: data.usage == null ? null : Number(data.usage),
        freeTier: Boolean(data.is_free_tier)
      };
    }
    save();
  }

  load();

  return {
    snapshot,
    order,
    available,
    recordSuccess,
    recordFailure,
    markSwitch,
    markExhausted,
    refreshExternal,
    classifyError,
    /** Para pruebas/administracion: borra la cuenta local. */
    reset() {
      state.providers = {};
      state.lastSwitch = null;
      save();
    },
    _stateFile: stateFile
  };
}

module.exports = { createQuota, classifyError };
