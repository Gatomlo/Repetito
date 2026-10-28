// Synthese vocale Piper (voix francaises natives, licence MIT ; voix sous licences libres)
// executee entierement dans Node.js, sans executable ni module natif : eSpeak-NG + ONNX
// Runtime en WebAssembly (embarques dans vendor/), dans un thread separe (tts-worker.js).
// Les modeles (~60-75 Mo chacun) sont telecharges dans tts/voices/ au premier besoin.
const path = require('path');
const { Worker } = require('worker_threads');
const { ensureFile } = require('./audio-encode');

const VOICES_DIR = path.join(__dirname, 'tts', 'voices');
const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/';
// nom du modele -> dossier dans le depot Hugging Face
const MODEL_PATHS = {
  'fr_FR-tom-medium': 'tom/medium/',
  'fr_FR-siwis-medium': 'siwis/medium/',
  'fr_FR-upmc-medium': 'upmc/medium/', // 2 voix : jessica (0, femme), pierre (1, homme)
  'fr_FR-gilles-low': 'gilles/low/',
};
const IDLE_MS = parseInt(process.env.TTS_IDLE_MS, 10) || 5 * 60 * 1000; // inactivite avant liberation de la memoire
const JOB_TIMEOUT_MS = 2 * 60 * 1000;

async function ensureModelFiles(name) {
  if (!MODEL_PATHS[name]) throw new Error('Modele Piper inconnu : ' + name);
  const base = MODEL_PATHS[name] + name;
  const onnx = path.join(VOICES_DIR, name + '.onnx');
  await ensureFile(onnx + '.json', HF_BASE + base + '.onnx.json');
  await ensureFile(onnx, HF_BASE + base + '.onnx');
}

let worker = null;
let idleTimer = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

function failAll(err) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function stopWorker() {
  if (!worker) return;
  const w = worker;
  worker = null;
  w.terminate();
}

function armIdle() {
  clearTimeout(idleTimer);
  if (pending.size === 0 && worker) idleTimer = setTimeout(() => { if (pending.size === 0) stopWorker(); }, IDLE_MS);
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'tts-worker.js'));
  w.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve({ samples: m.samples, rate: m.rate });
    armIdle();
  });
  w.on('error', (e) => { if (worker === w) worker = null; failAll(e); });
  w.on('exit', () => { if (worker === w) worker = null; failAll(new Error('Moteur vocal arrete')); });
  worker = w;
  return w;
}

async function synthesize(modelName, sid, text) {
  await ensureModelFiles(modelName);
  return new Promise((resolve, reject) => {
    clearTimeout(idleTimer);
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Synthese trop longue (delai depasse)'));
      stopWorker(); // le thread est peut-etre bloque : on le relance a la prochaine demande
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    getWorker().postMessage({ id, model: modelName, sid, text });
  });
}

// Telecharge en arriere-plan les modeles des voix proposees, sans bloquer le demarrage.
async function prefetch(names) {
  for (const name of names) {
    try { await ensureModelFiles(name); } catch (e) { console.error('Voix Piper indisponible (' + name + ') :', e.message); }
  }
}

module.exports = { synthesize, prefetch, MODEL_PATHS };
