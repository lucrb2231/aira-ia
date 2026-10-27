/* =========================================================================
 *  AIRA IA - IA 2 facial en el SERVIDOR (Human + TensorFlow.js)
 *  Modulo OPCIONAL: se carga solo cuando se usa. Si faltan las librerias o
 *  no alcanza la memoria, el resto del servidor (chat) sigue funcionando.
 *  Se instala con `npm install` (ver package.json / render.yaml).
 *
 *  REVISION v5:
 *   - Corrige la carga de modelos en Node 22: el build WASM usa `fetch`,
 *     que no entiende `file://`. Se parchea solo para leer archivos locales.
 *   - El respaldo CPU usa el mismo build WASM + backend CPU (no requiere
 *     tfjs-node ni compilacion nativa).
 *   - Verifica que los modelos realmente se hayan cargado antes de detectar
 *     (evita que un modelo incompleto tumbe todo el servidor).
 *   - Si el backend WASM no esta disponible, reintenta con CPU (mas lento
 *     pero funciona en cualquier hosting).
 *   - Informa si realmente se pudo comprobar el anti-foto (liveChecked), para
 *     no dar por "persona real" cuando el modelo antispoof no cargo.
 *   - Acepta hasta 200 candidatos y descarta huellas con formato invalido.
 *   - Valida tamaño/formato de las imagenes antes de decodificarlas.
 * =========================================================================*/
'use strict';
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const ENV_SIM = parseFloat(process.env.FACE_MIN_SIM || '0.55');
const ENV_GAP = parseFloat(process.env.FACE_MIN_GAP || '0.04');
const MIN_FACE_SCORE = parseFloat(process.env.FACE_MIN_SCORE || '0.6');
const LIVENESS = (process.env.FACE_LIVENESS || 'true').toLowerCase() !== 'false';
const MAX_IMAGES = Math.max(1, Math.min(8, parseInt(process.env.FACE_MAX_IMAGES || '8', 10)));
const MAX_CANDIDATES = Math.max(1, Math.min(500, parseInt(process.env.FACE_MAX_CANDIDATES || '200', 10)));
const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // ~3 MB de JPEG en base64 por foto
const state = { human: null, loading: null, error: null, backend: null, livenessReady: null };
const attemptsLog = [];

/** Human (build Node/WASM) descarga los modelos con `fetch`. Node 22 no
 *  soporta `file://` en fetch, asi que lo resolvemos leyendo el archivo. */
let fileFetchInstalled = false;
function installFileFetch() {
  if (fileFetchInstalled) return;
  fileFetchInstalled = true;
  if (typeof Response !== 'function') {
    throw new Error('Node 18 o superior es necesario para la IA facial (falta Response).');
  }
  const original = typeof global.fetch === 'function' ? global.fetch : null;
  global.fetch = async function airaFileFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith('file://')) {
      const file = fileURLToPath(url);
      const data = await fs.promises.readFile(file);
      const type = file.toLowerCase().endsWith('.json') ? 'application/json' : 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type } });
    }
    if (original) return original(input, init);
    throw new Error('fetch no esta disponible en este Node.');
  };
}

/** Carpeta dist de Human. Se busca sin depender del campo "exports" del paquete. */
function humanDist() {
  try { return path.dirname(require.resolve('@vladmandic/human')); }
  catch (e) { return path.join(__dirname, 'node_modules', '@vladmandic', 'human', 'dist'); }
}

function humanBuild() {
  // El build "node-wasm" tambien sirve para CPU: no exige tfjs-node nativo.
  const candidates = ['human.node-wasm.js', 'human.node.js'];
  for (const name of candidates) {
    const file = path.join(humanDist(), name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Verifica que existan las librerias sin cargarlas (para /status). */
function checkLibs() {
  try {
    require.resolve('jpeg-js');
    const builds = ['human.node-wasm.js', 'human.node.js']
      .map((f) => path.join(humanDist(), f))
      .filter((f) => fs.existsSync(f));
    if (!builds.length) throw new Error('No se encontro human.node.js ni human.node-wasm.js en ' + humanDist());
    return { ok: true, builds };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function libs() {
  const check = checkLibs();
  if (!check.ok) {
    const err = new Error('Faltan las librerias de la IA facial del servidor (npm install): ' + check.error);
    err.code = 'NO_FACE_LIB';
    throw err;
  }
  try {
    return { jpeg: require('jpeg-js'), builds: check.builds };
  } catch (e) {
    const err = new Error('Faltan las librerias de la IA facial del servidor (npm install): ' + e.message);
    err.code = 'NO_FACE_LIB';
    throw err;
  }
}

/** Ruta de los modelos (carpeta models del paquete @vladmandic/human). */
function modelsDir() {
  return path.join(path.resolve(humanDist(), '..'), 'models');
}

function wasmDir() {
  try { return path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')); }
  catch (e) { return path.join(path.resolve(humanDist(), '..'), '..', '..', '@tensorflow', 'tfjs-backend-wasm', 'dist'); }
}

async function createHuman(backend) {
  installFileFetch();
  const build = humanBuild();
  if (!build) throw new Error('No se encontro el build de Human (human.node-wasm.js ni human.node.js).');
  if (backend === 'cpu') {
    // Registra el backend CPU en la misma copia de tfjs que usa Human.
    try { require('@tensorflow/tfjs-backend-cpu'); }
    catch (e) { throw new Error('No se pudo cargar el backend CPU: ' + (e && e.message)); }
  }
  const mod = require(build);
  const Human = mod.Human || mod.default || mod;
  const h = new Human({
    backend,
    ...(backend === 'wasm' ? { wasmPath: wasmDir() + path.sep } : {}),
    debug: false,
    modelBasePath: 'file://' + modelsDir() + '/',
    filter: { enabled: false }, gesture: { enabled: false }, body: { enabled: false },
    hand: { enabled: false }, object: { enabled: false }, segmentation: { enabled: false },
    face: {
      enabled: true,
      detector: { rotation: false, maxDetected: 2 },
      mesh: { enabled: true },
      iris: { enabled: false },
      emotion: { enabled: false },
      description: { enabled: true },
      antispoof: { enabled: LIVENESS },
      liveness: { enabled: LIVENESS }
    }
  });
  try {
    await h.load();
    // Human no siempre rechaza cuando falla la descarga de un modelo:
    // comprobamos de verdad que esten cargados antes de usarlo.
    const loaded = typeof h.models.loaded === 'function' ? h.models.loaded() : [];
    const required = ['blazeface', 'facemesh', 'faceres'];
    const missing = required.filter((name) => !loaded.includes(name));
    if (missing.length) throw new Error('Modelos faciales incompletos (faltan: ' + missing.join(', ') + ').');
    const livenessReady = loaded.includes('antispoof') && loaded.includes('liveness');
    return { h, backend, livenessReady, models: loaded };
  } catch (e) {
    try { if (typeof h.reset === 'function') h.reset(); } catch (err) { /* nada */ }
    throw e;
  }
}

async function load() {
  if (state.human) return state.human;
  if (!state.loading) {
    state.loading = (async () => {
      libs();
      const errors = [];
      for (const backend of ['wasm', 'cpu']) {
        try {
          const made = await createHuman(backend);
          state.human = made.h;
          state.backend = made.backend;
          state.livenessReady = made.livenessReady;
          state.error = null;
          attemptsLog.push(backend + ': ok');
          return made.h;
        } catch (e) {
          errors.push(backend + ': ' + (e && e.message));
          attemptsLog.push(backend + ': ' + (e && e.message));
        }
      }
      throw new Error('No se pudo cargar el modelo facial. ' + errors.join(' | '));
    })().catch((e) => { state.loading = null; state.error = e.message; throw e; });
  }
  return state.loading;
}

function status() {
  const check = checkLibs();
  const models = modelsDir();
  let modelsOk = false;
  try {
    modelsOk = ['blazeface.json', 'facemesh.json', 'faceres.json'].every((f) => fs.existsSync(path.join(models, f)));
  } catch (e) { modelsOk = false; }
  return {
    version: 'face-server v5',
    available: check.ok,
    loaded: !!state.human,
    backend: state.backend,
    liveness: LIVENESS,
    livenessReady: state.livenessReady,
    modelsOk,
    modelsPath: models,
    error: check.ok ? (state.error || null) : check.error,
    attempts: attemptsLog.slice(-4),
    minSim: ENV_SIM,
    minGap: ENV_GAP
  };
}

function toTensor(h, jpeg, dataUrl) {
  const raw = String(dataUrl || '');
  if (raw.length > MAX_IMAGE_CHARS) throw new Error('La imagen es demasiado grande.');
  const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=\s]+)$/.exec(raw);
  if (!m) throw new Error('Imagen invalida (se espera JPEG en base64).');
  let decoded;
  try {
    decoded = jpeg.decode(Buffer.from(m[1], 'base64'), { useTArray: true, maxMemoryUsageInMB: 96 });
  } catch (e) {
    throw new Error('No se pudo decodificar la imagen JPEG: ' + (e && e.message));
  }
  const rgb = new Uint8Array(decoded.width * decoded.height * 3);
  for (let i = 0, j = 0; i < decoded.data.length; i += 4) {
    rgb[j++] = decoded.data[i]; rgb[j++] = decoded.data[i + 1]; rgb[j++] = decoded.data[i + 2];
  }
  return h.tf.tensor3d(rgb, [decoded.height, decoded.width, 3], 'int32');
}

const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const dot = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

/** Embedding promedio de varias fotos (una persona, rostro unico y claro). */
async function embedMany(images) {
  const h = await load();
  const { jpeg } = libs();
  const list = (Array.isArray(images) ? images : []).slice(0, MAX_IMAGES);
  if (!list.length) return { emb: null, real: 1, live: 1, liveChecked: false, used: 0 };
  const embs = [];
  let real = 1, live = 1, liveChecked = false;
  for (const img of list) {
    let t3, t4;
    try {
      t3 = toTensor(h, jpeg, img);
      t4 = h.tf.expandDims(t3, 0);
      const r = await h.detect(t4);
      const f = r.face && r.face.length === 1 ? r.face[0] : null;
      if (f && f.embedding && f.embedding.length && (f.faceScore == null || f.faceScore >= MIN_FACE_SCORE)) {
        embs.push(Array.from(f.embedding));
        if (f.real != null) { real = Math.min(real, f.real); liveChecked = true; }
        if (f.live != null) { live = Math.min(live, f.live); liveChecked = true; }
      }
    } catch (e) {
      console.warn('[AIRA face] fotograma descartado: ' + (e && e.message));
    } finally {
      if (t3 && t4) { try { h.tf.dispose([t3, t4]); } catch (e) { /* nada */ } }
    }
  }
  if (embs.length < Math.max(1, Math.ceil(list.length / 2))) {
    return { emb: null, real, live, liveChecked, used: embs.length };
  }
  const mean = new Array(embs[0].length).fill(0);
  embs.forEach((v) => v.forEach((x, i) => (mean[i] += x / embs.length)));
  return { emb: unit(mean), real, live, liveChecked, used: embs.length };
}

/** Registro: devuelve la huella (embedding) para guardarla en el alumno. */
async function embedEndpoint(body) {
  const e = await embedMany(body && body.images);
  return {
    faceOk: !!e.emb,
    embedding: e.emb ? e.emb.map((x) => Math.round(x * 1000) / 1000) : null,
    real: e.real,
    live: e.live,
    liveChecked: e.liveChecked,
    framesUsed: e.used,
    minSim: ENV_SIM,
    minGap: ENV_GAP
  };
}

/** Asistencia: compara contra los candidatos y aplica los umbrales DEL SERVIDOR
 *  (el navegador solo puede pedir umbrales mas estrictos, nunca mas flojos). */
async function verify(body) {
  const e = await embedMany(body && body.images);
  const minSim = Math.max(ENV_SIM, Number(body && body.minSim) || 0);
  const minGap = Math.max(ENV_GAP, Number(body && body.minGap) || 0);
  const out = {
    ok: true,
    faceOk: !!e.emb,
    liveOk: true,
    liveChecked: e.liveChecked,
    real: e.real,
    live: e.live,
    framesUsed: e.used,
    minSim,
    minGap,
    ranked: [],
    skipped: 0
  };
  if (!e.emb) return out;
  if (LIVENESS || (body && body.liveness)) {
    // Si se exige anti-foto y no se pudo comprobar (modelo ausente o sin
    // valores real/live), NO se da por verificada: liveOk=false.
    out.liveOk = e.liveChecked && e.real >= 0.5 && e.live >= 0.5;
    out.liveRequired = true;
  }

  const seen = new Set();
  const list = (body && Array.isArray(body.candidates) ? body.candidates : [])
    .slice(0, MAX_CANDIDATES)
    .filter((c) => c && Array.isArray(c.d2) && c.d2.length === e.emb.length);
  out.skipped = (body && Array.isArray(body.candidates) ? body.candidates.length : 0) - list.length;

  out.ranked = list
    .map((c) => ({ id: String(c.id), sim: dot(e.emb, unit(c.d2.map(Number))) }))
    .filter((c) => {
      if (c.sim < -0.5 || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 20);
  return out;
}

module.exports = { status, load, verify, embedEndpoint };
