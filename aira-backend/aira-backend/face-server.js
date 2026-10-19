/* =========================================================================
 *  AIRA IA - IA 2 facial en el SERVIDOR (Human + TensorFlow.js, backend WASM)
 *  Modulo OPCIONAL: se carga solo cuando se usa. Si faltan las librerias o
 *  no alcanza la memoria, el resto del servidor (chat) sigue funcionando.
 *  Se instala con `npm install` (ver package.json / render.yaml).
 * =========================================================================*/
'use strict';
const path = require('path');
const fs = require('fs');

// Node (undici) no soporta fetch('file://...'); Human lo usa para leer los modelos.
// Parche: si la URL es file://, se lee del disco y se devuelve como Response.
(function () {
  const realFetch = global.fetch;
  if (!realFetch || realFetch.__airaFilePatched) return;
  const patched = async function (input, init) {
    const u = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
    if (u.startsWith('file://')) {
      const p = require('url').fileURLToPath(u);
      const buf = await fs.promises.readFile(p);
      const ct = p.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      return new Response(buf, { status: 200, headers: { 'content-type': ct } });
    }
    return realFetch.call(this, input, init);
  };
  patched.__airaFilePatched = true;
  global.fetch = patched;
})();

const ENV_SIM = parseFloat(process.env.FACE_MIN_SIM || '0.55');
const ENV_GAP = parseFloat(process.env.FACE_MIN_GAP || '0.04');
const LIVENESS = (process.env.FACE_LIVENESS || 'true').toLowerCase() !== 'false';
const state = { human: null, loading: null, error: null };

/** Carpeta dist de Human. Se busca sin depender del campo "exports" del paquete. */
function humanDist() {
  try { return path.dirname(require.resolve('@vladmandic/human')); }
  catch (e) { return path.join(__dirname, 'node_modules', '@vladmandic', 'human', 'dist'); }
}

function libs() {
  try {
    const jpeg = require('jpeg-js');
    const dist = humanDist();
    // Ruta ABSOLUTA: no pasa por "exports", asi que no se bloquea.
    const file = path.join(dist, 'human.node-wasm.js');
    if (!fs.existsSync(file)) {
      let lista = '';
      try { lista = fs.readdirSync(dist).filter((f) => /node/.test(f) && /\.js$/.test(f)).join(', '); } catch (e2) { /* nada */ }
      throw new Error('No existe ' + file + ' (archivos node en dist: ' + (lista || 'ninguno') + ')');
    }
    const mod = require(file);
    return { jpeg, Human: mod.Human || mod.default || mod };
  } catch (e) {
    const err = new Error('Faltan las librerias de la IA facial del servidor (npm install): ' + e.message);
    err.code = 'NO_FACE_LIB';
    throw err;
  }
}

async function load() {
  if (state.human) return state.human;
  if (!state.loading) {
    state.loading = (async () => {
      const { Human } = libs();
      const base = path.resolve(humanDist(), '..');
      let wasmDir;
      try { wasmDir = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')); }
      catch (e) { wasmDir = path.join(base, '..', '..', '@tensorflow', 'tfjs-backend-wasm', 'dist'); }
      const wasm = wasmDir + path.sep;
      const h = new Human({
        backend: 'wasm', wasmPath: wasm, debug: false,
        modelBasePath: 'file://' + path.join(base, 'models') + '/',
        filter: { enabled: false }, gesture: { enabled: false }, body: { enabled: false },
        hand: { enabled: false }, object: { enabled: false }, segmentation: { enabled: false },
        face: { enabled: true, detector: { rotation: false, maxDetected: 2 }, mesh: { enabled: true },
                iris: { enabled: false }, emotion: { enabled: false }, description: { enabled: true },
                antispoof: { enabled: LIVENESS }, liveness: { enabled: LIVENESS } }
      });
      await h.load();
      state.human = h; state.error = null;
      return h;
    })().catch((e) => { state.loading = null; state.error = e.message; throw e; });
  }
  return state.loading;
}

function status() {
  let available = true, error = state.error;
  try { libs(); } catch (e) { available = false; error = e.message; }
  return { version: 'face-server v3', available, loaded: !!state.human, error: error || null };
}

function toTensor(h, jpeg, dataUrl) {
  const m = /^data:image\/jpe?g;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Imagen invalida (se espera JPEG en base64).');
  const raw = jpeg.decode(Buffer.from(m[1], 'base64'), { useTArray: true, maxMemoryUsageInMB: 64 });
  const rgb = new Uint8Array(raw.width * raw.height * 3);
  for (let i = 0, j = 0; i < raw.data.length; i += 4) { rgb[j++] = raw.data[i]; rgb[j++] = raw.data[i + 1]; rgb[j++] = raw.data[i + 2]; }
  return h.tf.tensor3d(rgb, [raw.height, raw.width, 3], 'int32');
}

const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const dot = (a, b) => { if (a.length !== b.length) return -1; let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

/** Embedding promedio de varias fotos (una persona, rostro unico y claro). */
async function embedMany(images) {
  const h = await load();
  const { jpeg } = libs();
  const list = (Array.isArray(images) ? images : []).slice(0, 8);
  const embs = []; let real = 1, live = 1;
  for (const img of list) {
    const t3 = toTensor(h, jpeg, img), t4 = h.tf.expandDims(t3, 0);
    try {
      const r = await h.detect(t4);
      const f = r.face && r.face.length === 1 ? r.face[0] : null;
      if (f && f.embedding && f.embedding.length && (f.faceScore == null || f.faceScore >= 0.6)) {
        embs.push(Array.from(f.embedding));
        if (f.real != null) real = Math.min(real, f.real);
        if (f.live != null) live = Math.min(live, f.live);
      }
    } finally { h.tf.dispose([t3, t4]); }
  }
  if (embs.length < Math.max(1, Math.ceil(list.length / 2))) return { emb: null, real, live };
  const mean = new Array(embs[0].length).fill(0);
  embs.forEach((v) => v.forEach((x, i) => (mean[i] += x / embs.length)));
  return { emb: unit(mean), real, live };
}

/** Registro: devuelve la huella (embedding) para guardarla en el alumno. */
async function embedEndpoint(body) {
  const e = await embedMany(body.images);
  return { faceOk: !!e.emb, embedding: e.emb ? e.emb.map((x) => Math.round(x * 1000) / 1000) : null, real: e.real, live: e.live };
}

/** Asistencia: compara contra los candidatos y aplica los umbrales DEL SERVIDOR
 *  (el navegador solo puede pedir umbrales mas estrictos, nunca mas flojos). */
async function verify(body) {
  const e = await embedMany(body.images);
  const minSim = Math.max(ENV_SIM, Number(body.minSim) || 0);
  const minGap = Math.max(ENV_GAP, Number(body.minGap) || 0);
  const out = { ok: true, faceOk: !!e.emb, liveOk: true, real: e.real, live: e.live, minSim, minGap, ranked: [] };
  if (!e.emb) return out;
  if (LIVENESS || body.liveness) out.liveOk = e.real >= 0.5 && e.live >= 0.5;
  out.ranked = (Array.isArray(body.candidates) ? body.candidates.slice(0, 10) : [])
    .filter((c) => c && Array.isArray(c.d2) && c.d2.length)
    .map((c) => ({ id: String(c.id), sim: dot(e.emb, unit(c.d2.map(Number))) }))
    .sort((a, b) => b.sim - a.sim);
  return out;
}

module.exports = { status, load, verify, embedEndpoint };
