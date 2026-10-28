// Synthese vocale open source, executee localement par le serveur Node (aucune cle API,
// aucun envoi de donnees a un tiers). Un fichier audio genere est le meme pour tout le
// monde, quel que soit le telephone -> voix homogenes pour toute la troupe.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const piper = require('./piper-node');
const { toWav, toMp3 } = require('./audio-encode');

const TTS_ROOT = path.join(__dirname, 'tts');
const CACHE_DIR = path.join(TTS_ROOT, 'cache');

// Voix francaises natives (Piper, MIT) d'homme et de femme, executees dans Node (voir piper-node.js).
const VOICES = {
  tom: { model: 'fr_FR-tom-medium', sid: 0 },
  siwis: { model: 'fr_FR-siwis-medium', sid: 0 },
  pierre: { model: 'fr_FR-upmc-medium', sid: 1 },
  jessica: { model: 'fr_FR-upmc-medium', sid: 0 },
  gilles: { model: 'fr_FR-gilles-low', sid: 0 },
};
// Anciens identifiants (deja enregistres dans les reglages des utilisateurs) -> voix actuelles.
const ALIASES = {
  melo_tres_grave: 'tom', melo_grave: 'pierre', melo_medium: 'siwis', melo_aigue: 'jessica', melo_tres_aigue: 'gilles',
};
const DEFAULT_VOICE = 'siwis';
// Ordre des voix attribuees par defaut aux personnages (alterne homme/femme) : identique a
// PIPER_VOICES dans public/app.js.
const DEFAULT_VOICE_ORDER = ['tom', 'siwis', 'pierre', 'jessica', 'gilles'];
function resolveVoiceId(id) {
  if (ALIASES[id]) return ALIASES[id];
  return VOICES[id] ? id : DEFAULT_VOICE;
}

function ffmpegBinaryPath() {
  if (process.platform === 'win32') return path.join(TTS_ROOT, 'bin', 'windows', 'ffmpeg.exe');
  return path.join(TTS_ROOT, 'bin', 'linux-tools', 'ffmpeg');
}

function cacheKey(text, voiceId) {
  return crypto.createHash('sha256').update(voiceId + ' ' + text).digest('hex');
}

// Le WAV brut se lit mal (voire pas du tout) selon navigateurs/appareils : on encode
// dans un format compresse universellement bien supporte, pour eliminer toute
// ambiguite de decodage cote client. FORMATS decrit les args ffmpeg par format
// (utilise aussi par la page de diagnostic /audio-test.html pour comparer).
const FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg', args: ['-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-write_xing', '0', '-f', 'mp3'] },
  // ADTS (flux AAC brut) plutot que M4A/MP4 : le conteneur MP4 a besoin de pouvoir
  // "seeker" pour ecrire son index, ce qui echoue en pipe (stdout non-seekable).
  aac: { ext: 'aac', mime: 'audio/aac', args: ['-codec:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'adts'] },
};

// inputArgs va avant -i (ex: forcer le format d'entree) ; outputArgs va apres
// (codec, filtres, decoupage -ss/-to...). Sans inputArgs, ffmpeg auto-detecte le
// format d'entree (webm, mp3, m4a, wav...) a partir du flux, pratique pour des
// fichiers uploades dont on ne connait pas le format a l'avance.
function runFfmpeg(inputBuf, inputArgs, outputArgs) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBinaryPath();
    const proc = spawn(bin, ['-y', ...inputArgs, '-i', 'pipe:0', ...outputArgs, 'pipe:1']);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.stdin.on('error', () => {}); // evite un crash process si le pipe est deja ferme
    proc.on('close', (code) => {
      if (code !== 0 || !chunks.length) return reject(new Error('ffmpeg a echoue : ' + stderr.slice(-300)));
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(inputBuf);
  });
}

function transcode(wavBuf, format) {
  return runFfmpeg(wavBuf, ['-f', 'wav'], FORMATS[format].args);
}

// Normalise n'importe quel fichier audio uploade (webm, m4a, mp3...) en WAV mono,
// pour un stockage/servage coherent des enregistrements des comediens.
function convertToWav(buf) {
  return runFfmpeg(buf, [], ['-ar', '44100', '-ac', '1', '-f', 'wav']);
}

// Decoupe un extrait [start, end[ (secondes) d'un enregistrement "lecture a table"
// pour l'assigner a une replique precise (voir /api/table-read/.../split).
function trimAudio(buf, startSec, endSec) {
  const outputArgs = ['-ss', String(startSec)];
  if (typeof endSec === 'number') outputArgs.push('-to', String(endSec));
  outputArgs.push('-ar', '44100', '-ac', '1', '-f', 'wav');
  return runFfmpeg(buf, [], outputArgs);
}

// format: 'wav' (aucun encodage), 'mp3' (par defaut, utilise par l'appli), 'aac' (via ffmpeg).
async function synthesize(text, voiceId, format) {
  format = format || 'mp3';
  const id = resolveVoiceId(voiceId);
  const voice = VOICES[id];

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const ext = format === 'wav' ? 'wav' : FORMATS[format].ext;
  // "node-2" : version du moteur, pour ne jamais reutiliser d'anciens fichiers en cache.
  const cachedFile = path.join(CACHE_DIR, cacheKey(text, id + ':node-2:' + format) + '.' + ext);
  if (fs.existsSync(cachedFile)) return fs.promises.readFile(cachedFile);

  const { samples, rate } = await piper.synthesize(voice.model, voice.sid, text);
  let out;
  if (format === 'wav') out = toWav(samples, rate);
  else if (format === 'mp3') out = await toMp3(samples, rate);
  else {
    if (!fs.existsSync(ffmpegBinaryPath())) throw new Error('ffmpeg non installe (format ' + format + ')');
    out = await transcode(toWav(samples, rate), format);
  }
  fs.writeFile(cachedFile, out, () => {}); // best-effort, ne bloque pas la reponse
  return out;
}

// Telecharge en arriere-plan les modeles de voix manquants (premier demarrage seulement).
async function warmup() {
  await piper.prefetch(Array.from(new Set(Object.values(VOICES).filter((v) => v.model).map((v) => v.model))));
  return true;
}

module.exports = { synthesize, warmup, resolveVoiceId, VOICES, FORMATS, DEFAULT_VOICE, DEFAULT_VOICE_ORDER, convertToWav, trimAudio };
