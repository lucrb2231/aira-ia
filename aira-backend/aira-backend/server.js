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

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  defaultProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    // Thinking Machines Inkling (gratis en OpenRouter)
    model: process.env.OPENROUTER_MODEL || 'thinkingmachines/inkling:free',
    // Opcionales: OpenRouter los usa para identificar tu app
    siteUrl: process.env.OPENROUTER_SITE_URL || '',
    siteName: process.env.OPENROUTER_SITE_NAME || 'AIRA IA - Veltrix'
  },
  // Si el proveedor elegido falla, prueba los demas que tengan clave.
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
  'Si no sabes algo, dilo con honestidad en lugar de inventar datos.',
  'Se breve: usa parrafos cortos y listas cuando sea util.'
].join(' ');

/* ------------------------------------------------------------------
 *  3. Utilidades HTTP
 * ------------------------------------------------------------------ */

/** Hace una peticion HTTPS y devuelve el texto de la respuesta. */
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => {
      req.destroy(new Error('La respuesta del modelo tardo demasiado (timeout).'));
    });
    if (body) req.write(body);
    req.end();
  });
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
async function callGemini(message, history) {
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
      encodeURIComponent(CONFIG.gemini.model) +
      ':generateContent',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-goog-api-key': CONFIG.gemini.apiKey
    }
  };

  const res = await httpsRequest(options, payload);
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
  return {
    text: text || 'No pude generar una respuesta esta vez. Intenta de nuevo.',
    provider: 'gemini',
    model: CONFIG.gemini.model
  };
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
  return {
    text: text || 'No pude generar una respuesta esta vez. Intenta de nuevo.',
    provider: 'openai',
    model: CONFIG.openai.model
  };
}

/** OpenRouter (Thinking Machines: Inkling) - API compatible con OpenAI */
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
    throw err;
  }
  const raw =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  const text = typeof raw === 'string' ? raw.trim() : '';
  return {
    text: text || 'No pude generar una respuesta esta vez. Intenta de nuevo.',
    provider: 'openrouter',
    model: CONFIG.openrouter.model
  };
}

/** Elige el proveedor y, si falla, prueba los otros con clave configurada. */
const PROVIDERS = {
  gemini: { call: callGemini, key: () => CONFIG.gemini.apiKey },
  openai: { call: callOpenAI, key: () => CONFIG.openai.apiKey },
  openrouter: { call: callOpenRouter, key: () => CONFIG.openrouter.apiKey }
};

async function callProvider(provider, message, history) {
  const first = PROVIDERS[provider] ? provider : CONFIG.defaultProvider;
  const order = [PROVIDERS[first] ? first : 'gemini'];
  if (CONFIG.fallback) {
    Object.keys(PROVIDERS).forEach((name) => {
      if (!order.includes(name) && PROVIDERS[name].key()) order.push(name);
    });
  }
  let lastErr;
  for (const name of order) {
    try {
      return await PROVIDERS[name].call(message, history);
    } catch (e) {
      lastErr = e;
      console.warn('[AIRA] ' + name + ' fallo: ' + (e && e.message));
    }
  }
  throw lastErr;
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
        modeloOpenRouter: CONFIG.openrouter.model
      },
      resolveAllowedOrigin(req)
    );
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
      return sendJson(res, 200, { ok: true, provider: r.provider, model: r.model, ms: Date.now() - t0, respuesta: r.text }, '*');
    } catch (e) {
      return sendJson(res, 200, { ok: false, provider: name, ms: Date.now() - t0, error: e.message || 'Error desconocido', status: e.status || null }, '*');
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

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return sendJson(res, 400, { error: 'Falta el mensaje.' }, origin);
    }

    const provider = (body.provider || CONFIG.defaultProvider).toLowerCase();

    try {
      const result = await callProvider(provider, message, body.history);
      return sendJson(res, 200, result, origin);
    } catch (e) {
      const status = e.code === 'NO_KEY' ? 503 : 502;
      return sendJson(
        res,
        status,
        { error: e.message || 'No se pudo contactar al modelo.' },
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
  console.log('  ============================================');
  console.log('');
});
