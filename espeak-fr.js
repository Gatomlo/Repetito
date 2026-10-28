// Phonetisation francaise pour le moteur vocal Piper : eSpeak-NG
// compile en WebAssembly, execute directement dans Node (aucun programme externe).
const { loadEspeakFactory } = require('./vendor-libs');
let espPromise = null;
function getEspeak() {
  if (!espPromise) {
    espPromise = (async () => {
      const init = await loadEspeakFactory();
      const esp = new (await init()).eSpeakNGWorker();
      esp.set_voice('fr');
      return esp;
    })().catch((e) => { espPromise = null; throw e; });
  }
  return espPromise;
}

const PUNCT = /([,;:.!?…]+)/;
const PUNCT_ONLY = /^[,;:.!?…]+$/;

// Le modele de voix ne connait ni "…", ni les tirets longs, ni les guillemets : ils seraient
// supprimes en silence (donc plus de pause). On normalise le texte avant de le lire :
// abreviations developpees (sinon "M." est epele "em"), tirets de dialogue et guillemets
// retires, points de suspension unifies, mots ecrits tout en majuscules remis en minuscules.
function normalizeFrench(text) {
  return String(text)
    .replace(/[  ]/g, ' ')
    .replace(/[’‘`´]/g, "'")
    .replace(/[«»“”„"]/g, ' ')
    .replace(/\bMM\.?(?=\s)/g, 'Messieurs')
    .replace(/\bM\.(?=\s)/g, 'Monsieur')
    .replace(/\bMlle\.?/g, 'Mademoiselle')
    .replace(/\bMme\.?/g, 'Madame')
    .replace(/\bDr\.?(?=\s)/g, 'Docteur')
    .replace(/\bPr\.?(?=\s)/g, 'Professeur')
    .replace(/\bn°\s*/gi, 'numéro ')
    .replace(/&/g, ' et ')
    .replace(/\betc\./gi, 'et cetera.')
    .replace(/(?<![\p{L}])\p{Lu}{2,}(?![\p{L}])/gu, (w) => w.toLowerCase())
    .replace(/[—–]/g, ',')
    .replace(/\.{3,}|…/g, '…')
    .replace(/(^|[.!?…]\s*),\s*/g, '$1') // tiret de dialogue en debut de phrase : rien a lire
    .replace(/\s+/g, ' ')
    .trim();
}

// eSpeak ne conserve pas la ponctuation (pauses/intonation) : on phonetise les segments
// entre ponctuations, puis on la remet a sa place. "…" devient une virgule (intonation
// suspendue) ; la pause plus longue est ajoutee entre les enonces (voir splitUtterances).
function phonemize(esp, text) {
  let out = '';
  for (const part of text.split(PUNCT)) {
    if (!part.trim()) continue;
    if (PUNCT_ONLY.test(part)) { out = out.trimEnd() + part.replace(/…+/g, ',') + ' '; continue; }
    const ipa = esp.synthesize_ipa(part).ipa.replace(/[_-]/g, '').replace(/\s+/g, ' ').trim();
    out += ipa + ' ';
  }
  return out.trim();
}

// Silence (en secondes) apres un enonce selon sa ponctuation finale.
function pauseAfter(text) {
  const last = text.trim().slice(-1);
  if ('.!?'.includes(last)) return 0.4;
  if (last === '…') return 0.45;
  if (',;:'.includes(last)) return 0.2;
  return 0.06; // coupure au milieu d'une phrase trop longue
}

// Decoupe le texte en "enonces" lus separement : une phrase = un enonce (bonne intonation,
// pause precise), coupee aux points de suspension, puis aux virgules, puis aux mots si elle
// depasse la limite du modele.
function splitUtterances(esp, rawText, maxPhonemes) {
  const text = normalizeFrench(rawText);
  const out = [];
  const tooLong = (t) => phonemize(esp, t).length > maxPhonemes;
  const push = (t) => { t = t.trim(); if (t) out.push({ text: t, pause: pauseAfter(t) }); };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    for (const part of sentence.split(/(?<=…)\s*/)) {
      if (!part.trim()) continue;
      if (!tooLong(part)) { push(part); continue; }
      // Trop long : on coupe entre propositions (apres une virgule, un point-virgule...), en
      // regroupant les propositions tant que ca tient ; aux mots seulement si une seule
      // proposition est deja trop longue.
      const pushFit = (t) => {
        if (!tooLong(t)) { push(t); return; }
        let words = '';
        for (const w of t.split(/\s+/)) {
          const next = words ? words + ' ' + w : w;
          if (words && tooLong(next)) { push(words); words = w; } else words = next;
        }
        push(words);
      };
      let piece = '';
      for (const clause of part.split(/(?<=[,;:])\s+/)) {
        const next = piece ? piece + ' ' + clause : clause;
        if (!piece || !tooLong(next)) { piece = next; continue; }
        pushFit(piece);
        piece = clause;
      }
      pushFit(piece);
    }
  }
  if (out.length) out[out.length - 1].pause = 0;
  return out;
}

module.exports = { getEspeak, phonemize, splitUtterances, normalizeFrench };
