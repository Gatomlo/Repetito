// Moteur Piper execute dans le thread de synthese (voir tts-worker.js) : phonetique eSpeak-NG
// + ONNX Runtime, tous deux en WebAssembly. Les modeles (.onnx) sont deja telecharges par
// piper-node.js ; seuls les deux derniers utilises restent en memoire.
const path = require('path');
const fs = require('fs');
const { getEspeak, phonemize, splitUtterances } = require('./espeak-fr');
const { getOrt } = require('./vendor-libs');

const VOICES_DIR = path.join(__dirname, 'tts', 'voices');
const MAX_PHONEMES = 120; // segments courts : la memoire WebAssembly grossit avec la longueur du texte et ne redescend pas
const MAX_LOADED = parseInt(process.env.TTS_MAX_MODELS, 10) || 2; // mettre 1 pour economiser ~100 Mo de RAM (plus lent si plusieurs voix alternent)

const loaded = new Map(); // nom -> { promise } dans l'ordre d'usage (le plus ancien d'abord)

async function loadModel(name) {
  const onnx = path.join(VOICES_DIR, name + '.onnx');
  const ort = await getOrt();
  const cfg = JSON.parse(fs.readFileSync(onnx + '.json', 'utf8'));
  const session = await ort.InferenceSession.create(fs.readFileSync(onnx), { executionProviders: ['wasm'], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false });
  return { ort, cfg, session };
}

function getModel(name) {
  let entry = loaded.get(name);
  if (entry) { loaded.delete(name); loaded.set(name, entry); return entry.promise; } // marque comme recent
  entry = { promise: loadModel(name) };
  entry.promise.catch(() => { if (loaded.get(name) === entry) loaded.delete(name); });
  loaded.set(name, entry);
  while (loaded.size > MAX_LOADED) {
    const [oldName, old] = loaded.entries().next().value;
    loaded.delete(oldName);
    old.promise.then((m) => m.session.release && m.session.release()).catch(() => {});
  }
  return entry.promise;
}

async function synthChunk(esp, m, sid, text) {
  const { ort, cfg, session } = m;
  const map = cfg.phoneme_id_map;
  const ids = [...map['^']];
  for (const ch of phonemize(esp, text)) {
    if (map[ch]) { ids.push(...map[ch]); ids.push(...map['_']); }
  }
  ids.push(...map['$']);
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([cfg.inference.noise_scale, cfg.inference.length_scale, cfg.inference.noise_w]), [3]),
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(sid || 0)]), [1]);
  const res = await session.run(feeds);
  return res[session.outputNames[0]].data;
}

async function synthesize(modelName, sid, text) {
  const [esp, m] = await Promise.all([getEspeak(), getModel(modelName)]);
  const rate = m.cfg.audio.sample_rate;
  // Chaque enonce est lu separement, suivi d'un silence adapte a sa ponctuation.
  const all = [];
  for (const u of splitUtterances(esp, text, MAX_PHONEMES)) {
    all.push(await synthChunk(esp, m, sid, u.text));
    if (u.pause) all.push(new Float32Array(Math.round(rate * u.pause)));
  }
  const joined = new Float32Array(all.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of all) { joined.set(a, o); o += a.length; }
  return { samples: joined, rate };
}

module.exports = { synthesize };
