// Chargement des bibliotheques embarquees dans vendor/ (voir vendor/README.md) : ONNX
// Runtime (WebAssembly), eSpeak-NG (WebAssembly) et l'encodeur MP3. Elles sont livrees avec
// l'appli au lieu d'etre installees par npm : aucune installation a reussir sur le serveur.
const path = require('path');
const { pathToFileURL } = require('url');

const VENDOR = path.join(__dirname, 'vendor');
const toUrl = (...parts) => pathToFileURL(path.join(VENDOR, ...parts)).href;

let ortPromise = null;
function getOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import(toUrl('onnxruntime', 'ort.wasm.min.mjs'));
      ort.env.wasm.numThreads = 1; // syntheses sequentielles : un thread suffit et limite la memoire
      ort.env.wasm.wasmPaths = pathToFileURL(path.join(VENDOR, 'onnxruntime') + path.sep).href;
      return ort;
    })().catch((e) => { ortPromise = null; throw e; });
  }
  return ortPromise;
}

async function loadEspeakFactory() {
  return (await import(toUrl('espeak', 'espeak-ng.mjs'))).default;
}

async function loadLame() {
  return import(toUrl('lamejs', 'lamejs.mjs'));
}

module.exports = { getOrt, loadEspeakFactory, loadLame };
