/* =========================================================================
 *  AIRA IA - Servidor intermedio (proxy) para el Centro Educativo Los Pinos
 *  Asistente Inteligente de Reconocimiento y Asistencia
 *
 *  QUE HACE:
 *   - Guarda la API Key en el SERVIDOR (nunca llega al navegador).
 *   - Recibe las preguntas del chatbot desde la pagina y las reenvia al
 *     modelo real (Google Gemini, OpenAI u OpenRouter).
 *   - Sirve la pagina index.html en la raiz, para que todo quede en un
 *     mismo dominio.
 *
 *  COMO USARLO:
 *   1) Copia .env.example  ->  .env   y completa tus claves.
 *   2) node server.js
 *   3) Abre http://localhost:3000
 *
 *  Requiere Node.js 18 o superior (no necesita dependencias externas).
 * =========================================================================*/

'use strict';

const http = require('http');
const faceServer = require('./face-server'); // IA 2 facial (opcional, carga perezosa)
const { createQuota } = require('./ai-quota'); // sensor de tokens + cambio de IA
const https = require('https');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------
 *  1. Cargar configuracion (.env) - sin dependencias externas
 * ------------------------------------------------------------------ */
const ROOT = __dirname;

function loadEnvFile(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return;
  const content = fs.readFileSync(full, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile('.env');

function cleanKey(v) {
  return String(v || '')
    .replace(/[\r\n\t]/g, '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/^bearer\s+/i, '')
    .trim();
}

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  defaultProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    // Si el modelo principal esta saturado (503) o falla, se prueban estos en orden.
    fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-3.6-flash').split(',').map((m) => m.trim()).filter(Boolean)
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },
  openrouter: {
    // Se limpia por si se pego con espacios, comillas, saltos de linea o "Bearer ".
    apiKey: cleanKey(process.env.OPENROUTER_API_KEY),
    // NVIDIA Nemotron (gratis en OpenRouter)
    model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free',
    // Opcionales: OpenRouter los usa para identificar tu app
    siteUrl: process.env.OPENROUTER_SITE_URL || '',
    siteName: process.env.OPENROUTER_SITE_NAME || 'AIRA IA - Veltrix'
  },
  // Si el proveedor elegido falla, prueba los demas que tengan clave.
  // Tiempo maximo de espera por proveedor antes de pasar al siguiente (el ultimo espera mas).
  providerTimeoutMs: Math.max(3000, parseInt(process.env.AI_TIMEOUT_MS || '25000', 10)),
  fallback: (process.env.AI_FALLBACK || 'true').toLowerCase() !== 'false',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMinute: Math.max(
    1,
    parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10)
  )
};

/* ------------------------------------------------------------------
 *  1.b Sensor de tokens (cuenta el saldo de cada IA y cambia solo)
 * ------------------------------------------------------------------ */
const QUOTA = createQuota({
  providers: {
    gemini: {
      key: () => CONFIG.gemini.apiKey,
      budget: parseFloat(process.env.AI_TOKENS_GEMINI || '1000000'),
      model: () => CONFIG.gemini.model
    },
    openai: {
      key: () => CONFIG.openai.apiKey,
      budget: parseFloat(process.env.AI_TOKENS_OPENAI || '2000000'),
      model: () => CONFIG.openai.model
    },
    openrouter: {
      key: () => CONFIG.openrouter.apiKey,
      budget: parseFloat(process.env.AI_TOKENS_OPENROUTER || '500000'),
      model: () => CONFIG.openrouter.model
    }
  },
  dataDir: path.join(ROOT, 'data'),
  primary: CONFIG.defaultProvider,
  fallbackOrder: (process.env.AI_FALLBACK_ORDER || 'gemini,openrouter,openai')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  allowFallback: CONFIG.fallback,
  reserve: parseInt(process.env.AI_TOKEN_RESERVE || '800', 10),
  windowHours: parseFloat(process.env.AI_TOKEN_WINDOW_HOURS || '24'),
  cooldownMinutes: parseFloat(process.env.AI_QUOTA_COOLDOWN_MIN || '60')
});

/** Resumen corto y discreto del sensor para /api/health (sin nombres de IA). */
function quotaSummary(requested) {
  const snap = QUOTA.snapshot(requested || CONFIG.defaultProvider);
  const configured = snap.providers.filter((p) => p.configured);
  let remaining = 0, limit = 0, hasRemaining = false, hasLimit = false;
  configured.forEach((p) => {
    if (p.remaining != null && isFinite(p.remaining)) { remaining += Number(p.remaining); hasRemaining = true; }
    if (p.limit != null && isFinite(p.limit) && p.limit > 0) { limit += Number(p.limit); hasLimit = true; }
  });
  return {
    configuradas: configured.length,
    agotadas: configured.filter((p) => p.exhausted).length,
    tokensRestantes: hasRemaining ? remaining : null,
    tokensLimite: hasLimit ? limit : null
  };
}

/** Version anonima del sensor para la pagina: solo numeros, sin proveedores. */
function quotaCompact(requested) {
  const snap = QUOTA.snapshot(requested || CONFIG.defaultProvider);
  return {
    providers: snap.providers.map((p) => ({
      configured: p.configured,
      remaining: p.remaining,
      limit: p.limit,
      exhausted: p.exhausted
    }))
  };
}

/* ------------------------------------------------------------------
 *  2. Sistema de prompts (personalidad de AIRA)
 * ------------------------------------------------------------------ */
const AIRA_SYSTEM_PROMPT = [
  'Eres AIRA IA (Asistente Inteligente de Reconocimiento y Asistencia),',
  'el asistente del proyecto Asistencia Digital, desarrollado por el equipo',
  'Code Nexus del grupo 1EMS. Responde siempre en espanol, de forma clara,',
  'calida y profesional.',
  'SOBRE LA PAGINA: la plataforma se llama VELTRIX (Veltrix Smart System) y es',
  'el sistema web del Centro Educativo Los Pinos. El nombre fue pasando por un',
  'proceso de desarrollo y varias versiones hasta quedar finalmente como',
  'VELTRIX. Sus siglas significan: V de Virtual, E de Expert, L de Learning,',
  'T de Technology, R de Response, I de Intelligence y X de eXchange.',
  'La pagina organiza la informacion en pestanas, maneja roles de usuario',
  '(Administrador y Coordinador) con inicio de sesion, e incluye reconocimiento',
  'facial, una agenda escolar, notificaciones, gestion de permisos y el propio',
  'chatbot AIRA IA. Solo los usuarios de rango alto (administrador o coordinador)',
  'pueden modificar datos y la agenda publica; el resto solo puede verlos.',
  'EQUIPO: Code Nexus esta integrado por Lucas Bonette, Facundo Pintos y',
  'Justin Fagundez. Se reparten los roles de lider, programador, investigador,',
  'disenador, documentador y comunicador. Contacto: codenexusjfl@gmail.com.',
  'PROBLEMA: el pasaje de lista tradicional es lento y quita tiempo de clase;',
  'a veces la marca de falta se anula al guardar; y los profesores con varias',
  'horas seguidas se olvidan de volver a pasar lista.',
  'SOLUCION: un sistema de asistencia digital basado en RFID. Hay un dispositivo',
  'en la entrada y cada alumno tiene una tarjeta con chip; al pasarla, el sistema',
  'lo marca con la hora en tiempo real. Un reloj interno pasa la lista automatica',
  'en cada cambio de hora. Tambien incluye reconocimiento facial para confirmar',
  'la identidad.',
  'TECNICA: programado en Arduino (C/C++) con placa ESP32. El sensor lee la',
  'tarjeta, verifica que no se haya pasado mas de una vez, junta la UID con la',
  'hora y crea un archivo CSV que se envia a una base de datos; la pagina lo',
  'muestra y permite modificar datos o cargar justificaciones.',
  'METODOLOGIAS: usan RUCK (division de roles, estilo empresarial) y SDD',
  '(Spec-Driven Development: definir requerimientos y luego desarrollar).',
  'Contaron con el apoyo de la empresa Sunny Data.',
  'ESTADO: en desarrollo, con un prototipo y un simulador; trabajando en una',
  'base de datos permanente y en mejorar la interfaz.',
  'FUTURO: terminar el prototipo con sensor y tarjeta, registrar y ver los datos',
  'en la web, detectar cuando un alumno se va y vuelve avisando al administrador,',
  'y lograr que el sistema se use en varias escuelas, liceos y trabajos.',
  'RECOMENDACION: cada vez que el usuario pregunte algo sobre el equipo Code Nexus,',
  'sus integrantes, quien te creo o como contactarlos, responde brevemente y al final',
  'termina diciendo: Para conocer mas de la empresa visita la web oficial. No escribas la',
  'URL ni inventes enlaces: el sistema agrega solo el link "Conoce mas sobre nosotros...".',
  'Si no sabes algo, dilo con honestidad en lugar de inventar datos.',
  'Se breve: usa parrafos cortos y listas cuando sea util.'
].join(' ');

/* ------------------------------------------------------------------
 *  3. Utilidades HTTP
 * ------------------------------------------------------------------ */

/** Hace una peticion HTTPS y devuelve el texto de la respuesta. */
function httpsRequest(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, headers: res.headers || {}, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 45000, () => {
      req.destroy(new Error('La respuesta del modelo tardo demasiado (timeout).'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Segundos que pidio el proveedor esperar (header Retry-After). */
function retryAfterSeconds(headers) {
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readJsonBody(req, limitBytes) {
  const max = limitBytes || 200 * 1024; // 200 KB
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('El cuerpo de la peticion es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON invalido en la peticion.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload, origin) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ------------------------------------------------------------------
 *  4. Control de origen (CORS) y de velocidad (rate limit)
 * ------------------------------------------------------------------ */
function resolveAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (CONFIG.allowedOrigins.includes('*')) return origin || '*';
  if (origin && CONFIG.allowedOrigins.includes(origin)) return origin;
  return null; // no autorizado
}

const rateBuckets = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  // Limpieza: evita que el Map crezca sin limite con muchas IPs.
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) {
      if (!value || now > value.resetAt) rateBuckets.delete(key);
    }
  }
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= CONFIG.rateLimitPerMinute,
    remaining: Math.max(0, CONFIG.rateLimitPerMinute - bucket.count),
    resetAt: bucket.resetAt
  };
}

/* ------------------------------------------------------------------
 *  5. Llamadas a los modelos reales
 * ------------------------------------------------------------------ */

/** Normaliza el historial que llega del navegador. */
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-12)
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
    )
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, 4000)
    }));
}

/** Google Gemini */
async function callGemini(message, history, modelOverride, timeoutMs) {
  const model = modelOverride || CONFIG.gemini.model;
  if (!CONFIG.gemini.apiKey) {
    const err = new Error(
      'Falta GEMINI_API_KEY en el archivo .env del servidor.'
    );
    err.code = 'NO_KEY';
    throw err;
  }

  const contents = normalizeHistory(history).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: AIRA_SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  });

  const options = {
    method: 'POST',
    hostname: 'generativelanguage.googleapis.com',
    path:
      '/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-goog-api-key': CONFIG.gemini.apiKey
    }
  };

  const res = await httpsRequest(options, payload, timeoutMs || 15000);
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('Gemini devolvio una respuesta ilegible.');
  }
  if (res.statusCode >= 400) {
    const msg =
      (data && data.error && data.error.message) ||
      'Error ' + res.statusCode + ' de Gemini.';
    const err = new Error(msg);
    err.code = 'PROVIDER';
    err.status = res.statusCode;
    err.retryAfter = retryAfterSeconds(res.headers);
    throw err;
  }
  const parts =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts;
  const text =
    Array.isArray(parts) && parts.length
      ? parts.map((p) => p.text || '').join('').trim()
      : '';
  const um = (data && data.usageMetadata) || null;
  return {
    text: text || 'No pude generar una respuesta esta vez. Intenta de nuevo.',
    provider: 'gemini',
    model,
    usage: um ? {
      total: um.totalTokenCount,
      prompt: um.promptTokenCount,
      completion: um.candidatesTokenCount
    } : null
  };
}

/** Gemini con varios modelos: si uno esta saturado o falla, prueba el siguiente. */
async function callGeminiChain(message, history) {
  const models = [CONFIG.gemini.model].concat(CONFIG.gemini.fallbackModels).filter((m, i, a) => a.indexOf(m) === i);
  // Presupuesto de tiempo total para toda la cadena (no por modelo).
  const deadline = Date.now() + Math.max(6000, CONFIG.providerTimeoutMs - 500);
  let lastErr;
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 2500) break;
    try {
      return await callGemini(message, history, model, Math.min(15000, left));
    } catch (e) {
      if (e && e.code === 'NO_KEY') throw e;
      lastErr = e;
      console.warn('[AIRA] gemini (' + model + ') fallo: ' + (e && e.message));
    }
  }
  throw lastErr;
}

/** OpenAI */
async function callOpenAI(message, history) {
  if (!CONFIG.openai.apiKey) {
    const err = new Error(
      'Falta OPENAI_API_KEY en el archivo .env del servidor.'
    );
    err.code = 'NO_KEY';
    throw err;
  }

  const messages = [{ role: 'system', content: AIRA_SYSTEM_PROMPT }].concat(
    normalizeHistory(history).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }))
  );
  messages.push({ role: 'user', content: message });

  const payload = JSON.stringify({
    model: CONFIG.openai.model,
    messages,
    temperature: 0.7,
    max_tokens: 1024
  });

  const options = {
    method: 'POST',
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: 'Bearer ' + CONFIG.openai.apiKey
    }
  };

  const res = await httpsRequest(options, payload);
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('OpenAI devolvio una respuesta ilegible.');
  }
  if (res.statusCode >= 400) {
    const msg =
      (data && data.error && data.error.message) ||
      'Error ' + res.statusCode + ' de OpenAI.';
    const err = new Error(msg);
    err.code = 'PROVIDER';
    err.status = res.statusCode;
    err.retryAfter = retryAfterSeconds(res.headers);
    throw err;
  }
  const text =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content
      ? data.choices[0].message.content.trim()
      : '';
  const usage = (data && data.usage) || null;
  return {
    text: text || 'No pude generar una respuesta esta vez. Intenta de nuevo.',
    provider: 'openai',
    model: CONFIG.openai.model,
    usage: usage ? {
      total: usage.total_tokens,
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens
    } : null
  };
}

/** OpenRouter (NVIDIA Nemotron) - API compatible con OpenAI */
async function callOpenRouter(message, history) {
  if (!CONFIG.openrouter.apiKey) {
    const err = new Error(
      'Falta OPENROUTER_API_KEY en las variables de entorno del servidor.'
    );
    err.code = 'NO_KEY';
    throw err;
  }

  const messages = [{ role: 'system', content: AIRA_SYSTEM_PROMPT }].concat(
    normalizeHistory(history).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }))
  );
  messages.push({ role: 'user', content: message });

  const payload = JSON.stringify({
    model: CONFIG.openrouter.model,
    messages,
    temperature: 0.7,
    // Margen extra: los modelos "thinking" gastan tokens razonando antes de responder.
    max_tokens: 2048
  });

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Authorization: 'Bearer ' + CONFIG.openrouter.apiKey,
    'X-Title': CONFIG.openrouter.siteName
  };
  if (CONFIG.openrouter.siteUrl) headers['HTTP-Referer'] = CONFIG.openrouter.siteUrl;

  const options = {
    method: 'POST',
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    headers
  };

  const res = await httpsRequest(options, payload);
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error('OpenRouter devolvio una respuesta ilegible.');
  }
  if (res.statusCode >= 400 || (data && data.error)) {
    const status = res.statusCode >= 400 ? res.statusCode : 502;
    let msg =
      (data && data.error && data.error.message) ||
      'Error ' + status + ' de OpenRouter.';
    if (status === 429) {
      msg = 'El modelo gratuito esta saturado o llego al limite. Intenta de nuevo en unos segundos.';
    }
    const err = new Error(msg);
    err.code = 'PROVIDER';
    err.status = status;
    err.retryAfter = retryAfterSeconds(res.headers);
    throw err;
  }
  const raw =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const usage = (data && data.usage) || null;
  return {
    text: text || 'No pude generar una respuesta esta vez. Intenta de nuevo.',
    provider: 'openrouter',
    model: CONFIG.openrouter.model,
    usage: usage ? {
      total: usage.total_tokens,
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens
    } : null
  };
}

/** Elige el proveedor y, si falla, prueba los otros con clave configurada. */
const PROVIDERS = {
  gemini: { call: callGeminiChain, key: () => CONFIG.gemini.apiKey },
  openai: { call: callOpenAI, key: () => CONFIG.openai.apiKey },
  openrouter: { call: callOpenRouter, key: () => CONFIG.openrouter.apiKey }
};

async function callProvider(provider, message, history) {
  const requested = PROVIDERS[provider] ? provider : CONFIG.defaultProvider;
  // El sensor decide el orden: IA 1 si tiene tokens, si no la IA 2, luego la IA 3.
  const order = QUOTA.order(requested, CONFIG.fallback);
  const withTimeout = (p, ms, name) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(name + ' tardo mas de ' + Math.round(ms / 1000) + ' s en responder.')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  let lastErr;
  let switchReason = '';
  const skipped = [];

  if (!order.length) {
    const err = new Error(
      'No hay ninguna IA configurada. Carga GEMINI_API_KEY, OPENROUTER_API_KEY u OPENAI_API_KEY en el servidor.'
    );
    err.code = 'NO_KEY';
    throw err;
  }

  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const isLast = i === order.length - 1;

    // Si el sensor ya la marco sin tokens, no se gasta una llamada (salvo que
    // sea la unica opcion: ahi se intenta igual como ultimo recurso).
    if (!QUOTA.available(name)) {
      skipped.push(name);
      if (order.filter((n) => QUOTA.available(n)).length > 0) {
        console.warn('[AIRA] Se omite ' + name + ' (sin tokens o cuota agotada).');
        continue;
      }
    }

    const t0 = Date.now();
    try {
      const r = await withTimeout(
        PROVIDERS[name].call(message, history),
        isLast ? 60000 : CONFIG.providerTimeoutMs,
        name
      );
      const sensor = QUOTA.recordSuccess(name, r.usage, r.model, requested);
      const quota = quotaCompact(requested);
      if (name !== requested) {
        // El cambio se registra solo del lado del servidor: el navegador no
        // recibe ningun dato que delate que se cambio de IA.
        QUOTA.markSwitch(requested, name, switchReason || 'La IA principal no tiene tokens disponibles.');
      }
      console.log('[AIRA] respondio ' + name + ' en ' + (Date.now() - t0) + ' ms' +
        (sensor.remaining == null ? '' : ' (quedan ~' + sensor.remaining + ' tokens)'));
      return {
        text: r.text,
        quota
      };
    } catch (e) {
      lastErr = e;
      const info = QUOTA.recordFailure(name, e);
      if (info.quota && !switchReason) {
        switchReason = e.code === 'NO_KEY'
          ? 'La clave no está configurada.'
          : 'La IA respondió que no tiene tokens/cuota disponible.';
      }
      console.warn('[AIRA] ' + name + ' fallo: ' + (e && e.message));
    }
  }

  const snap = QUOTA.snapshot(requested);
  const exhausted = snap.providers
    .filter((p) => p.configured && p.exhausted)
    .map((p) => p.label + (p.exhaustedReason ? ' (' + p.exhaustedReason + ')' : ''));
  let msg = lastErr && lastErr.message ? lastErr.message : 'No se pudo contactar a ninguna IA.';
  if (exhausted.length) {
    // El detalle queda solo en el log del servidor: la respuesta al navegador
    // no debe revelar que IA se agoto ni que hubo un cambio de proveedor.
    console.warn('[AIRA] Sin tokens: ' + exhausted.join(' · ') + ' | ultimo error: ' + msg);
    msg = 'La IA no tiene saldo disponible en este momento.';
  }
  const err = new Error(msg);
  err.code = lastErr && lastErr.code === 'NO_KEY' ? 'NO_KEY' : 'NO_QUOTA';
  err.status = lastErr && lastErr.status ? lastErr.status : 429;
  throw err;
}

/* ------------------------------------------------------------------
 *  6. Archivos estaticos (la pagina del colegio)
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath).split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';

  // Evita salir de la carpeta public/
  const normalized = path
    .normalize(rel)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]/, '');
  const filePath = path.join(ROOT, 'public', normalized);

  if (!filePath.startsWith(path.join(ROOT, 'public'))) {
    res.writeHead(403);
    return res.end('Acceso denegado');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------
 *  7. Servidor
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'desconocida';

  /* --- CORS previo --- */
  if (req.method === 'OPTIONS') {
    const origin = resolveAllowedOrigin(req);
    res.writeHead(origin ? 204 : 403, {
      'Access-Control-Allow-Origin': origin || 'null',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    });
    return res.end();
  }

  /* --- Estado del servidor --- */
  if (urlPath === '/api/health') {
    const healthProvider = (new URLSearchParams((req.url.split('?')[1] || '')).get('provider') || CONFIG.defaultProvider).toLowerCase();
    return sendJson(
      res,
      200,
      {
        ok: true,
        service: 'AIRA IA backend',
        providerPorDefecto: CONFIG.defaultProvider,
        geminiConfigurado: Boolean(CONFIG.gemini.apiKey),
        openaiConfigurado: Boolean(CONFIG.openai.apiKey),
        openrouterConfigurado: Boolean(CONFIG.openrouter.apiKey),
        modeloOpenRouter: CONFIG.openrouter.model,
        iaFacialServidor: faceServer.status().available,
        tokens: quotaSummary(healthProvider)
      },
      resolveAllowedOrigin(req)
    );
  }

  /* --- Sensor de tokens: saldo de cada IA y cual esta activa --- */
  if (urlPath === '/api/ai/quota' && req.method === 'GET') {
    const origin = resolveAllowedOrigin(req);
    if (!origin) return sendJson(res, 403, { error: 'Origen no autorizado.' });
    const qs = new URLSearchParams((req.url.split('?')[1] || ''));
    const requested = (qs.get('provider') || CONFIG.defaultProvider).toLowerCase();
    try { await QUOTA.refreshExternal(qs.get('refresh') === '1'); } catch (e) { /* informativo */ }
    // La pagina pide ?compact=1 y recibe solo numeros, sin nombres ni cambios.
    // El detalle completo queda disponible para administracion en esta misma ruta.
    if (qs.get('compact') === '1') return sendJson(res, 200, quotaCompact(requested), origin);
    return sendJson(res, 200, QUOTA.snapshot(requested), origin);
  }

  /* --- Reiniciar la cuenta de tokens (solo administracion) --- */
  if (urlPath === '/api/ai/quota/reset' && req.method === 'POST') {
    const origin = resolveAllowedOrigin(req);
    if (!origin) return sendJson(res, 403, { error: 'Origen no autorizado.' });
    if ((process.env.ENABLE_QUOTA_RESET || 'false').toLowerCase() !== 'true') {
      return sendJson(res, 403, { error: 'Reinicio deshabilitado (ENABLE_QUOTA_RESET=true para activarlo).' }, origin);
    }
    QUOTA.reset();
    return sendJson(res, 200, QUOTA.snapshot(CONFIG.defaultProvider), origin);
  }

  /* --- IA 2 facial en el servidor --- */
  if (urlPath === '/api/face/status') {
    const st = faceServer.status();
    if (new URLSearchParams(req.url.split('?')[1] || '').get('warm') === '1' && st.available) {
      try { await faceServer.load(); } catch (e) { /* el error queda en status */ }
    }
    return sendJson(res, 200, faceServer.status(), resolveAllowedOrigin(req));
  }
  if ((urlPath === '/api/face/verify' || urlPath === '/api/face/embed') && req.method === 'POST') {
    const origin = resolveAllowedOrigin(req);
    if (!origin) return sendJson(res, 403, { error: 'Origen no autorizado.' });
    const rl = checkRateLimit(ip);
    if (!rl.allowed) return sendJson(res, 429, { error: 'Demasiadas consultas seguidas.' }, origin);
    let body;
    try { body = await readJsonBody(req, 3 * 1024 * 1024); }
    catch (e) { return sendJson(res, 400, { error: e.message }, origin); }
    try {
      const out = urlPath === '/api/face/verify' ? await faceServer.verify(body) : await faceServer.embedEndpoint(body);
      return sendJson(res, 200, out, origin);
    } catch (e) {
      return sendJson(res, e.code === 'NO_FACE_LIB' ? 503 : 500, { error: e.message || 'Error en la IA facial.' }, origin);
    }
  }

  /* --- Prueba rapida desde el navegador (sin respaldo automatico) ---
   *  Abrir:  /api/test?provider=openrouter   o   /api/test?provider=gemini
   *  Muestra que IA respondio de verdad, cuanto tardo y el error si fallo.
   *  Se desactiva con ENABLE_TEST=false.                                  */
  if (urlPath === '/api/test' && req.method === 'GET') {
    if ((process.env.ENABLE_TEST || 'true').toLowerCase() === 'false') {
      return sendJson(res, 404, { error: 'Ruta no encontrada.' });
    }
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return sendJson(res, 429, { error: 'Demasiadas consultas. Espera un momento.' }, '*');
    }
    const qs = new URLSearchParams((req.url.split('?')[1] || ''));
    const name = (qs.get('provider') || CONFIG.defaultProvider).toLowerCase();
    const q = (qs.get('q') || 'Hola, presentate en una frase.').slice(0, 300);
    if (!PROVIDERS[name]) {
      return sendJson(res, 400, { ok: false, error: 'Proveedor desconocido. Usa openrouter, gemini u openai.' }, '*');
    }
    const t0 = Date.now();
    try {
      const r = await PROVIDERS[name].call(q, []);
      const sensor = QUOTA.recordSuccess(name, r.usage, r.model);
      return sendJson(res, 200, { ok: true, provider: r.provider, model: r.model, ms: Date.now() - t0, respuesta: r.text, tokens: sensor, quota: QUOTA.snapshot(name) }, '*');
    } catch (e) {
      QUOTA.recordFailure(name, e);
      const fail = { ok: false, provider: name, ms: Date.now() - t0, error: e.message || 'Error desconocido', status: e.status || null };
      if (name === 'openrouter') {
        const k = CONFIG.openrouter.apiKey;
        fail.claveDetectada = { largo: k.length, empiezaCon: k.slice(0, 6), esperado: 'empieza con sk-or- y tiene unos 70 caracteres' };
      }
      return sendJson(res, 200, fail, '*');
    }
  }

  /* --- Chat con AIRA --- */
  if (urlPath === '/api/chat' && req.method === 'POST') {
    const origin = resolveAllowedOrigin(req);
    if (!origin) {
      return sendJson(res, 403, {
        error: 'Origen no autorizado. Revisa ALLOWED_ORIGINS en el .env.'
      });
    }

    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return sendJson(
        res,
        429,
        { error: 'Demasiadas consultas seguidas. Espera un momento por favor.' },
        origin
      );
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, origin);
    }

    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : '';
    if (!message) {
      return sendJson(res, 400, { error: 'Falta el mensaje.' }, origin);
    }

    const provider = (body.provider || CONFIG.defaultProvider).toLowerCase();

    try {
      const result = await callProvider(provider, message, body.history);
      return sendJson(res, 200, result, origin);
    } catch (e) {
      const status = e.code === 'NO_KEY' ? 503 : (e.code === 'NO_QUOTA' ? 429 : 502);
      return sendJson(
        res,
        status,
        {
          error: e.message || 'No se pudo contactar al modelo.',
          quota: QUOTA.snapshot(provider),
          sinTokens: e.code === 'NO_QUOTA'
        },
        origin
      );
    }
  }

  /* --- Pagina y recursos estaticos --- */
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, urlPath);
  }

  sendJson(res, 404, { error: 'Ruta no encontrada.' });
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log('');
  console.log('  ============================================');
  console.log('   AIRA IA - Servidor del Centro Educativo Los Pinos');
  console.log('  ============================================');
  console.log('   Direccion : http://localhost:' + CONFIG.port);
  console.log('   Proveedor : ' + CONFIG.defaultProvider);
  console.log('   Gemini    : ' + (CONFIG.gemini.apiKey ? 'configurado si' : 'SIN CLAVE'));
  console.log('   OpenAI    : ' + (CONFIG.openai.apiKey ? 'configurado si' : 'SIN CLAVE'));
  console.log('   OpenRouter: ' + (CONFIG.openrouter.apiKey ? 'configurado si (' + CONFIG.openrouter.model + ')' : 'SIN CLAVE'));
  console.log('   Limite    : ' + CONFIG.rateLimitPerMinute + ' mensajes por minuto e IP');
  const snap = QUOTA.snapshot(CONFIG.defaultProvider);
  snap.providers.forEach((p) => {
    console.log(
      '   ' + p.role + ' ' + p.label.padEnd(10) + ': ' +
      (p.configured
        ? (p.remaining == null ? 'sin presupuesto declarado' : p.remaining + ' tokens restantes' + (p.exhausted ? ' (AGOTADA)' : ''))
        : 'SIN CLAVE')
    );
  });
  console.log('  ============================================');
  console.log('');
  // Consulta los creditos de OpenRouter (informativo, no bloquea el arranque).
  QUOTA.refreshExternal(true).catch(() => {});
});
