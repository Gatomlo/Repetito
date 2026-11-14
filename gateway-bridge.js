'use strict';
// Pont avec la connexion centralisee de node-gateway (voir son README, "Comptes et droits").
// COPIE DE REFERENCE : le meme fichier est copie tel quel dans lib/gateway-bridge.js de chaque outil.
//
// La passerelle pose req.gateway = { app, user: { login, name, email, isSuper } | null, role: 'admin' | 'member' | null }
// cote serveur, dans le meme process : un client ne peut pas le fabriquer. En mode autonome
// (outil lance seul), req.gateway est absent et tout ce module est sans effet.

// Vrai si l'outil est monte derriere la passerelle (req.gateway existe, meme pour un visiteur anonyme).
// Sert a fermer, dans ce cas seulement, des portes ouvertes en mode autonome (ex. creation du mot de passe
// admin par le premier visiteur) : derriere la passerelle, c'est elle qui authentifie.
function behindGateway(req) {
  return !!(req && req.gateway);
}

// Identite transmise par la passerelle, ou null (anonyme, ou connecte sans droit sur cet outil).
// minRole 'admin' : refuse un simple "member".
function identity(req, minRole) {
  const g = req && req.gateway;
  if (!g || !g.user || !g.role) return null;
  if (minRole === 'admin' && g.role !== 'admin') return null;
  return {
    role: g.role,
    login: String(g.user.login || '').trim(),
    email: g.user.email ? String(g.user.email).trim() : '',
    name: String(g.user.name || g.user.login || '').trim(),
    // Compte local choisi par l'administrateur de la passerelle (identifiant ou e-mail de l'outil), ou ''.
    local: g.local ? String(g.local).trim() : '',
  };
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Rattache l'identite a UN compte local de la liste (jamais plus d'un) : d'abord le compte choisi par
// l'administrateur (id.local), sinon e-mail identique, sinon identifiant identique. Retourne l'element de `rows`, ou null. Aucune creation de compte.
//   fields : noms des colonnes de `rows` ({ email: 'email', login: 'username' } par defaut ; null = ignore)
function matchLocal(id, rows, fields) {
  if (!id || !Array.isArray(rows)) return null;
  const f = Object.assign({ email: 'email', login: 'username' }, fields || {});
  // Rattachement explicite (passerelle > « compte dans l'outil ») : il l'emporte et n'a PAS de repli sur
  // l'egalite d'identifiants (un mauvais choix ne doit jamais ouvrir le compte de quelqu'un d'autre).
  if (id.local) {
    const hits = rows.filter((r) => (f.email && norm(r[f.email]) === norm(id.local)) || (f.login && norm(r[f.login]) === norm(id.local)));
    return hits.length === 1 ? hits[0] : null;
  }
  const by = (col, value) => {
    if (!col || !value) return null;
    const hits = rows.filter((r) => norm(r[col]) === norm(value));
    return hits.length === 1 ? hits[0] : null;
  };
  return by(f.email, id.email) || by(f.login, id.login);
}

module.exports = { identity, matchLocal, behindGateway };
