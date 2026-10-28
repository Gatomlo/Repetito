// Thread de synthese vocale : le calcul (eSpeak + ONNX Runtime en WebAssembly) dure 1 a 3 s
// par replique et occuperait sinon tout le serveur (donc les autres applis de la passerelle).
// Les demandes sont traitees une par une. Voir piper-node.js, qui l'arrete apres inactivite
// pour rendre toute sa memoire (la memoire WebAssembly ne diminue jamais d'elle-meme).
const { parentPort } = require('worker_threads');
const engine = require('./piper-engine');

let chain = Promise.resolve();
parentPort.on('message', (job) => {
  chain = chain.then(async () => {
    try {
      const { samples, rate } = await engine.synthesize(job.model, job.sid, job.text);
      parentPort.postMessage({ id: job.id, samples, rate }, [samples.buffer]);
    } catch (e) {
      parentPort.postMessage({ id: job.id, error: (e && e.message) || String(e) });
    }
  });
});
