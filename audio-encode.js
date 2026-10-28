// Encodage audio en JavaScript pur (aucun ffmpeg) pour les voix de synthese.
const { loadLame } = require('./vendor-libs');

// Le vocodeur peut depasser legerement l'amplitude max, ce qui ecrete le signal 16 bits
// et produit un grésillement audible : on ramene le pic sous 92 % du plein echelle.
function toInt16(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const gain = peak > 0.92 ? 0.92 / peak : 1;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain * 32767)));
  return out;
}

function toWav(samples, rate) {
  const pcm = toInt16(samples);
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

// MP3 mono via lamejs (fork @breezystack, embarque dans vendor/).
async function toMp3(samples, rate) {
  const { Mp3Encoder } = await loadLame();
  const enc = new Mp3Encoder(1, rate, 64);
  const pcm = toInt16(samples);
  const out = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (b.length) out.push(Buffer.from(b));
  }
  const end = enc.flush();
  if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}

// Telecharge un fichier de modele s'il est absent (ecriture atomique via .part) ; les
// appels simultanes pour un meme fichier partagent le meme telechargement.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const downloads = new Map();
function ensureFile(dest, url) {
  if (fs.existsSync(dest)) return Promise.resolve();
  if (downloads.has(dest)) return downloads.get(dest);
  const p = (async () => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    console.log('Voix : telechargement de ' + path.basename(dest) + '...');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Telechargement impossible (' + res.status + ') : ' + url);
    const part = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    fs.renameSync(part, dest);
  })().finally(() => downloads.delete(dest));
  downloads.set(dest, p);
  return p;
}

module.exports = { toWav, toMp3, ensureFile };
