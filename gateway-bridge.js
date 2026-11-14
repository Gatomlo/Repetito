'use strict';
// Pont avec la connexion centralisee de node-gateway (voir son README, "Comptes et droits").
// COPIE DE REFERENCE : le meme fichier est copie tel quel dans lib/gateway-bridge.js de chaque outil.
//
// La passerelle pose req.gateway = { app, user: { login, name, email, isSuper } | null, role: 'admin' | 'member' | null }
// cote serveur, dans le meme process : un client ne peut pas le fabriquer. En mode autonome
// (outil lance seul), req.gateway est absent et tout ce module est sans effet.

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
  };
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Rattache l'identite a UN compte local de la liste (jamais plus d'un) : e-mail identique d'abord,
// sinon identifiant identique. Retourne l'element de `rows`, ou null. Aucune creation de compte.
//   fields : noms des colonnes de `rows` ({ email: 'email', login: 'username' } par defaut ; null = ignore)
function matchLocal(id, rows, fields) {
  if (!id || !Array.isArray(rows)) return null;
  const f = Object.assign({ email: 'email', login: 'username' }, fields || {});
  const by = (col, value) => {
    if (!col || !value) return null;
    const hits = rows.filter((r) => norm(r[col]) === norm(value));
    return hits.length === 1 ? hits[0] : null;
  };
  return by(f.email, id.email) || by(f.login, id.login);
}

module.exports = { identity, matchLocal };
