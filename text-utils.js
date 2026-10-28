// Texte lu par la synthese vocale : DOIT rester identique a la version du navigateur
// (public/app.js : splitInlineDirections, spokenTextOnly, applyPronunciations), sinon les
// fichiers prepares en avance par le serveur ne correspondraient pas a ce que demandent
// les telephones (ils ne seraient simplement pas reutilises).

// Separe les didascalies integrees a une replique, entre parentheses (non lues).
function splitInlineDirections(text) {
  const parts = [];
  const re = /\(([^()]*)\)/g;
  let lastIndex = 0, m;
  while ((m = re.exec(text || ''))) {
    if (m.index > lastIndex) parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    parts.push({ type: 'direction', value: m[0] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < (text || '').length) parts.push({ type: 'text', value: text.slice(lastIndex) });
  return parts;
}

function spokenTextOnly(text) {
  return splitInlineDirections(text).filter((p) => p.type === 'text').map((p) => p.value).join(' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Dictionnaire de prononciation d'une piece : [{ from: "Gilles", to: "Jile" }, ...]. Mot
// entier, sans tenir compte des majuscules ; les entrees les plus longues passent d'abord.
function applyPronunciations(text, entries) {
  if (!entries || !entries.length) return text;
  let out = text;
  entries.slice().sort((a, b) => b.from.length - a.from.length).forEach(({ from, to }) => {
    out = out.replace(new RegExp('(?<![\\p{L}\\p{N}])' + escapeRegExp(from) + '(?![\\p{L}\\p{N}])', 'giu'), to);
  });
  return out;
}

module.exports = { splitInlineDirections, spokenTextOnly, applyPronunciations };
