const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const tts = require('./tts');
const pregen = require('./pregen');
const mailer = require('./mailer');

// Filet de securite : une erreur imprevue (ex. process enfant, pipe ferme) ne doit
// jamais faire tomber tout le serveur pour toute la troupe. On log et on continue.
// Uniquement quand Repetito tourne seul : monte par la passerelle, le process est
// partage avec d'autres outils et c'est elle qui decide quoi faire de ces erreurs.
if (require.main === module) {
  process.on('uncaughtException', (err) => console.error('Erreur non interceptee (ignoree) :', err));
  process.on('unhandledRejection', (err) => console.error('Promesse rejetee non geree (ignoree) :', err));
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Stockage : simple fichier JSON avec file d'ecriture ----------
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, usersByName: {}, plays: {}, states: {}, recordings: {}, sessions: {}, troupes: {} }, null, 2));
  }
}
ensureDb();

let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
if (!db.recordings) db.recordings = {}; // migrations douces pour les bases existantes
if (!db.sessions) db.sessions = {};
if (!db.troupes) db.troupes = {};
// Migration : les anciens comptes (avant l'authentification) n'ont ni mot de passe ni role.
// Le premier d'entre eux devient admin ; il choisira son mot de passe a la premiere connexion.
let firstLegacy = true;
Object.values(db.users).forEach((u) => {
  if (!u.role) { u.role = firstLegacy ? 'admin' : 'user'; firstLegacy = false; }
  // Migration : un compte pouvait avoir une seule troupe (troupeId) ; desormais plusieurs (troupeIds).
  if (!u.troupeIds) { u.troupeIds = u.troupeId ? [u.troupeId] : []; delete u.troupeId; }
  // Migration : le code de recuperation permanent est remplace par un code a usage unique
  // envoye par mail (voir /api/auth/request-reset). Un compte doit avoir une adresse mail.
  if (u.recoveryCodeHash !== undefined) delete u.recoveryCodeHash;
  if (u.email === undefined) u.email = '';
});
Object.values(db.plays).forEach((p) => { delete p.sharedWith; if (!p.roles) p.roles = {}; if (p.troupeId === undefined) p.troupeId = null; if (!p.directorNotes) p.directorNotes = {}; if (!p.pronunciations) p.pronunciations = []; });
// Migration : chaque replique n'avait qu'un seul enregistrement (ecrase a chaque
// nouvelle prise) ; desormais plusieurs prises sont gardees, avec une "active".
// Renomme aussi le fichier existant <ligne>.wav en <ligne>__legacy.wav pour suivre
// la nouvelle convention de nommage (une prise = un fichier <ligne>__<idPrise>.wav).
Object.keys(db.recordings || {}).forEach((playId) => {
  const lines = db.recordings[playId];
  Object.keys(lines).forEach((lineId) => {
    const entry = lines[lineId];
    if (entry && Array.isArray(entry.takes)) return; // deja au nouveau format
    if (!entry || !entry.recordedBy) { delete lines[lineId]; return; }
    const takeId = 'legacy';
    const recDir = path.join(DATA_DIR, 'recordings', playId);
    const oldFile = path.join(recDir, lineId + '.wav');
    const newFile = path.join(recDir, lineId + '__' + takeId + '.wav');
    try { if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) fs.renameSync(oldFile, newFile); } catch (e) { /* tant pis, prise perdue */ }
    lines[lineId] = {
      activeId: takeId,
      takes: [{ id: takeId, recordedBy: entry.recordedBy, recordedByName: entry.recordedByName, updatedAt: entry.updatedAt, source: entry.source }],
    };
  });
});

let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain
    .then(() => fs.promises.writeFile(DB_FILE, snapshot))
    .catch((err) => console.error('Erreur ecriture DB', err));
  return writeChain;
}

function uid() {
  return crypto.randomUUID();
}

// ---------- Authentification (identifiant + mot de passe, roles admin/user) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function publicUser(u) { return { id: u.id, name: u.name, role: u.role, mustChangePassword: !!u.mustChangePassword, troupeIds: u.troupeIds || [] }; }
// Sans caracteres ambigus (0/O, 1/l/I) pour rester lisible/dictable a l'oral.
function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[crypto.randomInt(chars.length)];
  return pw;
}
function makeSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, createdAt: Date.now() };
  persist();
  return { token, user: publicUser(db.users[userId]) };
}

// Autorise le jeton via l'en-tete Authorization (cas normal, tous les appels fetch())
// ou via ?token= en secours (les balises <audio src> natives ne peuvent pas envoyer
// d'en-tetes personnalises).
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : null) || (req.query.token || '').toString() || null;
  const session = token && db.sessions[token];
  if (!session || !db.users[session.userId]) return res.status(401).json({ error: 'Non authentifié — reconnecte-toi.' });
  req.user = db.users[session.userId];
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Reservé à l'administrateur" });
  next();
}
// Metteur en scene : role intermediaire, peut consulter la progression de sa troupe
// mais n'a aucun des autres droits d'administration (comptes, pieces, roles...).
const VALID_ROLES = ['admin', 'user', 'director'];
function requireAdminOrDirector(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'director') {
    return res.status(403).json({ error: "Reservé à l'administrateur ou au metteur en scène" });
  }
  next();
}
function canAccessPlay(user, play) {
  if (user.role === 'admin') return true;
  if (play.troupeId && (user.troupeIds || []).includes(play.troupeId)) return true;
  return false;
}
function findLineInPlay(play, lineId) {
  for (const a of play.acts) for (const s of a.scenes) for (const l of s.lines) if (l.id === lineId) return l;
  return null;
}

// ---------- Limite de tentatives (anti devinette de mot de passe) ----------
// En memoire (repart a zero au redemarrage). Deux compteurs : par adresse IP, et par
// couple compte + IP (plus strict), pour ne pas bloquer un compte depuis le monde entier.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || '?';
}
function blockedSeconds(keys) {
  const now = Date.now();
  let wait = 0;
  keys.forEach((k) => { const e = attempts.get(k); if (e && e.blockedUntil > now) wait = Math.max(wait, Math.ceil((e.blockedUntil - now) / 1000)); });
  return wait;
}
function recordFailure(key, max) {
  const now = Date.now();
  let e = attempts.get(key);
  if (!e || now - e.first > WINDOW_MS) { e = { count: 0, first: now, blockedUntil: 0 }; attempts.set(key, e); }
  e.count++;
  if (e.count >= max) e.blockedUntil = now + WINDOW_MS;
}
function tooManyAttempts(res, seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return res.status(429).json({ error: 'Trop de tentatives échouées. Réessaie dans ' + minutes + ' minute' + (minutes > 1 ? 's' : '') + '.' });
}
setInterval(() => {
  const now = Date.now();
  attempts.forEach((e, k) => { if (now - e.first > WINDOW_MS && e.blockedUntil < now) attempts.delete(k); });
}, 10 * 60 * 1000).unref();

// Connexion : verification normale du mot de passe. Exception unique : si aucun compte
// n'existe encore dans tout le systeme, le tout premier login cree le compte
// administrateur avec le mot de passe choisi (bootstrap initial de l'installation).
app.post('/api/auth/login', (req, res) => {
  const username = (req.body.username || '').toString().trim();
  const password = (req.body.password || '').toString();
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  const key = username.toLowerCase();
  const ipKey = 'ip:' + clientIp(req), userKey = 'u:' + key + ':' + clientIp(req);
  const wait = blockedSeconds([ipKey, userKey]);
  if (wait) return tooManyAttempts(res, wait);
  let id = db.usersByName[key];
  if (!id) {
    if (Object.keys(db.users).length > 0) {
      recordFailure(ipKey, 30); recordFailure(userKey, 8);
      return res.status(404).json({ error: "Compte inconnu. Demande à l'administrateur de te créer un compte." });
    }
    if (password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum)' });
    id = uid();
    db.users[id] = { id, name: username, passwordHash: hashPassword(password), role: 'admin', mustChangePassword: false, createdAt: Date.now() };
    db.usersByName[key] = id;
    persist();
    return res.json(makeSession(id));
  }
  const user = db.users[id];
  if (!verifyPassword(password, user.passwordHash)) {
    recordFailure(ipKey, 30); recordFailure(userKey, 8);
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  attempts.delete(userKey);
  res.json(makeSession(id));
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const newPassword = (req.body.newPassword || '').toString();
  if (newPassword.length < 4) return res.status(400).json({ error: 'Nouveau mot de passe trop court (4 caractères minimum)' });
  // Changement obligatoire (mot de passe temporaire) : la session valide suffit, pas
  // besoin de reverifier l'ancien. Changement volontaire (futur) : verification normale.
  if (!req.user.mustChangePassword) {
    const currentPassword = (req.body.currentPassword || '').toString();
    if (!verifyPassword(currentPassword, req.user.passwordHash)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  }
  req.user.passwordHash = hashPassword(newPassword);
  req.user.mustChangePassword = false;
  persist();
  res.json({ ok: true });
});

// Recuperation de compte en self-service par mail, en deux etapes :
// 1) l'utilisateur demande un code (request-reset) ; s'il a une adresse mail enregistree,
//    un code a 6 chiffres, valable 30 minutes et a usage unique, lui est envoye.
// 2) il saisit ce code + son nouveau mot de passe (reset-with-code).
// Reponse volontairement generique a l'etape 1 (meme si le compte ou l'adresse n'existe
// pas) pour ne pas laisser deviner quels identifiants existent depuis l'exterieur.
function generateResetCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
app.post('/api/auth/request-reset', async (req, res) => {
  const username = (req.body.username || '').toString().trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Identifiant requis' });
  const ipKey = 'reqip:' + clientIp(req), userKey = 'req:' + username + ':' + clientIp(req);
  const wait = blockedSeconds([ipKey, userKey]);
  if (wait) return tooManyAttempts(res, wait);
  recordFailure(ipKey, 30); recordFailure(userKey, 5); // limite les demandes, succes ou pas
  const id = db.usersByName[username];
  const user = id && db.users[id];
  const generic = { ok: true, message: 'Si ce compte existe et a une adresse mail enregistrée, un code vient de lui être envoyé (valable 30 minutes).' };
  if (!user || !user.email) return res.json(generic);
  if (!mailer.isConfigured()) return res.status(503).json({ error: "L'envoi de mail n'est pas configuré sur ce serveur — demande à l'administrateur de réinitialiser ton mot de passe." });
  const code = generateResetCode();
  user.resetCodeHash = hashPassword(code);
  user.resetCodeExpires = Date.now() + 30 * 60 * 1000;
  persist();
  try { await mailer.sendResetCode(user.email, user.name, code); }
  catch (e) {
    console.error('Envoi du mail de reinitialisation echoue :', e.message);
    return res.status(502).json({ error: "Échec de l'envoi du mail. Réessaie plus tard ou contacte l'administrateur." });
  }
  res.json(generic);
});
app.post('/api/auth/reset-with-code', (req, res) => {
  const username = (req.body.username || '').toString().trim().toLowerCase();
  const code = (req.body.code || '').toString().trim();
  const newPassword = (req.body.newPassword || '').toString();
  if (!username || !code || !newPassword) return res.status(400).json({ error: 'Identifiant, code et nouveau mot de passe requis' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Nouveau mot de passe trop court (4 caractères minimum)' });
  const ipKey = 'rcip:' + clientIp(req), userKey = 'rc:' + username + ':' + clientIp(req);
  const wait = blockedSeconds([ipKey, userKey]);
  if (wait) return tooManyAttempts(res, wait);
  const id = db.usersByName[username];
  const user = id && db.users[id];
  const invalid = () => { recordFailure(ipKey, 30); recordFailure(userKey, 8); return res.status(401).json({ error: 'Code invalide ou expiré' }); };
  if (!user || !user.resetCodeHash || !user.resetCodeExpires || user.resetCodeExpires < Date.now()) return invalid();
  if (!verifyPassword(code, user.resetCodeHash)) return invalid();
  attempts.delete(userKey);
  delete user.resetCodeHash;
  delete user.resetCodeExpires;
  user.passwordHash = hashPassword(newPassword);
  user.mustChangePassword = false;
  Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === user.id) delete db.sessions[t]; });
  persist();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) delete db.sessions[token];
  persist();
  res.json({ ok: true });
});

// ---------- Sauvegardes (admin) ----------
// Copie datee de data/db.json toutes les 6 h (celle du jour est rafraichie), 7 jours gardes,
// dans data/backups/. Le bouton "Telecharger une sauvegarde" donne une copie hors du
// serveur (les sessions en cours en sont retirees). Restauration : remplacer data/db.json
// par le fichier voulu, puis redemarrer.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 7;
async function makeBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await writeChain;
    const name = 'db-' + new Date().toISOString().slice(0, 10) + '.json';
    await fs.promises.copyFile(DB_FILE, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - BACKUP_KEEP)).forEach((f) => fs.unlink(path.join(BACKUP_DIR, f), () => {}));
  } catch (e) { console.error('Sauvegarde automatique impossible :', e.message); }
}
setTimeout(makeBackup, 15 * 1000).unref();
setInterval(makeBackup, 6 * 60 * 60 * 1000).unref();

app.get('/api/admin/backups', requireAuth, requireAdmin, (req, res) => {
  let list = [];
  try {
    list = fs.readdirSync(BACKUP_DIR).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse()
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, modifiedAt: st.mtimeMs }; });
  } catch (e) { /* pas encore de sauvegarde */ }
  res.json({ backups: list, keep: BACKUP_KEEP });
});
app.get('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
  const snapshot = Object.assign({}, db, { sessions: {} });
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="repetito-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.send(JSON.stringify(snapshot, null, 2));
});

// ---------- Gestion des comptes (admin uniquement) ----------
app.get('/api/users', requireAuth, requireAdminOrDirector, (req, res) => {
  let list = Object.values(db.users);
  if (req.user.role !== 'admin') {
    const mine = new Set(req.user.troupeIds || []);
    list = list.filter((u) => u.id === req.user.id || (u.troupeIds || []).some((t) => mine.has(t)));
  }
  res.json(list.map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email || '', mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt, troupeIds: u.troupeIds || [] })));
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'user';
  const email = (req.body.email || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse mail invalide' });
  const key = name.toLowerCase();
  if (db.usersByName[key]) return res.status(409).json({ error: 'Ce nom existe déjà' });
  const id = uid();
  const tempPassword = generateTempPassword();
  db.users[id] = {
    id, name, passwordHash: hashPassword(tempPassword), mustChangePassword: true, role, createdAt: Date.now(), email,
  };
  db.usersByName[key] = id;
  persist();
  res.json({ id, name, role, email, tempPassword });
});

// Creation de plusieurs comptes d'un coup (une troupe entiere) : un identifiant par ligne.
// Les noms deja pris (ou invalides) sont ignores et signales, les autres sont crees avec
// leur mot de passe temporaire et leur code de recuperation, renvoyes une seule fois.
app.post('/api/users/bulk', requireAuth, requireAdmin, (req, res) => {
  const raw = Array.isArray(req.body.names) ? req.body.names : (req.body.names || '').toString().split(/\r?\n/);
  const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'user';
  const troupeIds = Array.isArray(req.body.troupeIds) ? Array.from(new Set(req.body.troupeIds.filter((id) => db.troupes[id]))) : [];
  const names = raw.map((n) => n.toString().trim().slice(0, 40)).filter(Boolean);
  if (!names.length) return res.status(400).json({ error: 'Aucun identifiant fourni' });
  if (names.length > 200) return res.status(400).json({ error: '200 comptes maximum à la fois' });
  const created = [], skipped = [];
  const seen = new Set();
  names.forEach((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped.push({ name, reason: 'en double dans la liste' }); return; }
    seen.add(key);
    if (db.usersByName[key]) { skipped.push({ name, reason: 'existe déjà' }); return; }
    const id = uid();
    const tempPassword = generateTempPassword();
    db.users[id] = {
      id, name, passwordHash: hashPassword(tempPassword), mustChangePassword: true, role, createdAt: Date.now(),
      email: '', troupeIds: troupeIds.slice(),
    };
    db.usersByName[key] = id;
    created.push({ id, name, tempPassword });
  });
  if (created.length) persist();
  res.json({ created, skipped });
});

// Ajoute ou retire une troupe a plusieurs comptes d'un coup (selection dans la liste).
app.post('/api/users/bulk-troupe', requireAuth, requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.userIds) ? req.body.userIds : [];
  const troupeId = (req.body.troupeId || '').toString();
  const remove = req.body.action === 'remove';
  if (!db.troupes[troupeId]) return res.status(404).json({ error: 'Troupe introuvable' });
  let changed = 0;
  ids.forEach((id) => {
    const u = db.users[id];
    if (!u) return;
    const has = (u.troupeIds || []).includes(troupeId);
    if (remove && has) { u.troupeIds = u.troupeIds.filter((t) => t !== troupeId); changed++; }
    else if (!remove && !has) { u.troupeIds = (u.troupeIds || []).concat(troupeId); changed++; }
  });
  if (changed) persist();
  res.json({ ok: true, changed });
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  if (VALID_ROLES.includes(req.body.role)) u.role = req.body.role;
  if (typeof req.body.email === 'string') {
    const email = req.body.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse mail invalide' });
    u.email = email;
  }
  persist();
  res.json({ id: u.id, name: u.name, role: u.role, email: u.email || '', mustChangePassword: !!u.mustChangePassword });
});

app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  const tempPassword = generateTempPassword();
  u.passwordHash = hashPassword(tempPassword);
  u.mustChangePassword = true;
  Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === u.id) delete db.sessions[t]; });
  persist();
  res.json({ ok: true, tempPassword });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer ton propre compte' });
  delete db.users[u.id];
  delete db.usersByName[u.name.toLowerCase()];
  delete db.states[u.id];
  Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === u.id) delete db.sessions[t]; });
  Object.values(db.plays).forEach((p) => { if (p.roles) delete p.roles[u.id]; });
  persist();
  res.json({ ok: true });
});

// ---------- Troupes (regrouper des comptes pour partager des pieces a beaucoup de monde
// sans avoir a cocher chaque compte individuellement) ----------
app.get('/api/troupes', requireAuth, requireAdminOrDirector, (req, res) => {
  let list = Object.values(db.troupes);
  if (req.user.role !== 'admin') list = list.filter((t) => (req.user.troupeIds || []).includes(t.id));
  res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/troupes', requireAuth, requireAdmin, (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const id = uid();
  db.troupes[id] = { id, name: name.slice(0, 100), createdAt: Date.now() };
  persist();
  res.json(db.troupes[id]);
});

app.put('/api/troupes/:id', requireAuth, requireAdmin, (req, res) => {
  const t = db.troupes[req.params.id];
  if (!t) return res.status(404).json({ error: 'Troupe introuvable' });
  const name = (req.body.name || '').toString().trim();
  if (name) t.name = name.slice(0, 100);
  persist();
  res.json(t);
});

app.delete('/api/troupes/:id', requireAuth, requireAdmin, (req, res) => {
  if (!db.troupes[req.params.id]) return res.status(404).json({ error: 'Troupe introuvable' });
  delete db.troupes[req.params.id];
  Object.values(db.users).forEach((u) => { u.troupeIds = (u.troupeIds || []).filter((id) => id !== req.params.id); });
  Object.values(db.plays).forEach((p) => { if (p.troupeId === req.params.id) p.troupeId = null; });
  persist();
  res.json({ ok: true });
});

// Un compte peut appartenir a plusieurs troupes (ex. plusieurs ateliers de la meme
// personne) : on remplace la liste complete a chaque appel.
app.put('/api/users/:id/troupes', requireAuth, requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Compte introuvable' });
  const troupeIds = Array.isArray(req.body.troupeIds) ? req.body.troupeIds.filter((id) => db.troupes[id]) : [];
  u.troupeIds = Array.from(new Set(troupeIds));
  persist();
  res.json(publicUser(u));
});

// ---------- Pieces ----------
app.get('/api/plays', requireAuth, (req, res) => {
  const visible = Object.values(db.plays).filter((p) => canAccessPlay(req.user, p));
  const list = visible.map((p) => ({
    id: p.id,
    title: p.title,
    createdByName: p.createdByName,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    characters: p.characters,
    troupeId: req.user.role === 'admin' ? (p.troupeId || null) : undefined,
    stats: {
      acts: p.acts.length,
      scenes: p.acts.reduce((s, a) => s + a.scenes.length, 0),
      lines: p.acts.reduce((s, a) => s + a.scenes.reduce((s2, sc) => s2 + sc.lines.length, 0), 0),
    },
  }));
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(list);
});

app.get('/api/plays/:id', requireAuth, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Cette pièce ne t\'a pas été partagée' });
  res.json(p);
});

app.post('/api/plays', requireAuth, requireAdmin, (req, res) => {
  const { title, acts, characters } = req.body;
  if (!title || !Array.isArray(acts)) return res.status(400).json({ error: 'Donnees invalides' });
  const id = uid();
  const play = {
    id,
    title: title.trim().slice(0, 200),
    acts,
    characters: characters || [],
    createdBy: req.user.id,
    createdByName: req.user.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    roles: {},
    troupeId: null,
    directorNotes: {},
    pronunciations: [],
  };
  db.plays[id] = play;
  persist();
  pregen.start(play, db);
  res.json(play);
});

app.put('/api/plays/:id', requireAuth, requireAdminOrDirector, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Accès refusé' });
  const { title, acts, characters } = req.body;
  if (typeof title === 'string' && title.trim()) p.title = title.trim().slice(0, 200);
  if (Array.isArray(acts)) p.acts = acts;
  if (Array.isArray(characters)) p.characters = characters;
  p.updatedAt = Date.now();
  persist();
  if (Array.isArray(acts) || Array.isArray(characters)) pregen.start(p, db);
  res.json(p);
});

// Une piece n'est visible que par l'administrateur et la troupe a laquelle elle est
// assignee (pas de partage individuel compte par compte).
app.put('/api/plays/:id/troupe', requireAuth, requireAdminOrDirector, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Accès refusé' });
  const troupeId = req.body.troupeId || null;
  if (req.user.role !== 'admin' && (!troupeId || !(req.user.troupeIds || []).includes(troupeId))) {
    return res.status(403).json({ error: 'Tu ne peux partager la pièce qu\'avec tes propres troupes' });
  }
  if (troupeId && !db.troupes[troupeId]) return res.status(404).json({ error: 'Troupe introuvable' });
  p.troupeId = troupeId;
  persist();
  res.json({ troupeId: p.troupeId });
});

// Distribution des roles (qui joue quel personnage) : decision de production, reservee
// a l'administrateur et au metteur en scene (de sa troupe). Un personnage = un seul comedien a la fois (vue par personnage,
// pas par utilisateur, pour rester gerable meme avec beaucoup de comptes partages).
app.put('/api/plays/:id/roles', requireAuth, requireAdminOrDirector, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Accès refusé' });
  const character = (req.body.character || '').toString();
  if (!p.characters.includes(character)) return res.status(400).json({ error: 'Personnage inconnu' });
  const userId = req.body.userId || null;
  if (userId && !db.users[userId]) return res.status(404).json({ error: 'Compte introuvable' });
  if (userId && req.user.role !== 'admin' && !(userId === req.user.id || (p.troupeId && (db.users[userId].troupeIds || []).includes(p.troupeId)))) {
    return res.status(403).json({ error: 'Ce compte ne fait pas partie de la troupe de la pièce' });
  }
  if (!p.roles) p.roles = {};
  Object.keys(p.roles).forEach((uid) => {
    p.roles[uid] = p.roles[uid].filter((c) => c !== character);
    if (!p.roles[uid].length) delete p.roles[uid];
  });
  if (userId) {
    if (!p.roles[userId]) p.roles[userId] = [];
    p.roles[userId].push(character);
  }
  persist();
  res.json({ roles: p.roles });
});

// Remarques du metteur en scene sur une replique : contrairement aux notes
// personnelles (privees, stockees dans /api/state), celles-ci vivent sur la piece
// elle-meme et sont visibles par toute la troupe (mise en scene collective).
app.put('/api/plays/:id/director-notes', requireAuth, requireAdminOrDirector, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Accès refusé' });
  const lineId = (req.body.lineId || '').toString();
  if (!findLineInPlay(p, lineId)) return res.status(400).json({ error: 'Réplique introuvable' });
  const note = (req.body.note || '').toString().trim().slice(0, 2000);
  if (!p.directorNotes) p.directorNotes = {};
  if (note) p.directorNotes[lineId] = note; else delete p.directorNotes[lineId];
  persist();
  res.json({ directorNotes: p.directorNotes });
});

// Dictionnaire de prononciation de la piece : [{ from, to }] (ex. "Gilles" -> "Jile") ;
// applique par les telephones et par le serveur avant la synthese vocale.
app.put('/api/plays/:id/pronunciations', requireAuth, requireAdminOrDirector, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Accès refusé' });
  const entries = (Array.isArray(req.body.entries) ? req.body.entries : [])
    .map((e) => ({ from: ((e && e.from) || '').toString().trim().slice(0, 60), to: ((e && e.to) || '').toString().trim().slice(0, 100) }))
    .filter((e) => e.from && e.to)
    .slice(0, 300);
  p.pronunciations = entries;
  persist();
  pregen.start(p, db);
  res.json({ pronunciations: entries });
});

// Preparation des voix en tache de fond (voir pregen.js) : lancement manuel et suivi.
app.post('/api/plays/:id/pregenerate', requireAuth, requireAdmin, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p) return res.status(404).json({ error: 'Piece introuvable' });
  const st = pregen.start(p, db);
  res.json({ status: st });
});
app.get('/api/plays/:id/pregenerate', requireAuth, requireAdminOrDirector, (req, res) => {
  const p = db.plays[req.params.id];
  if (!p || !canAccessPlay(req.user, p)) return res.status(403).json({ error: 'Accès refusé' });
  res.json({ status: pregen.getStatus(p.id) });
});

app.delete('/api/plays/:id', requireAuth, requireAdmin, (req, res) => {
  const playId = req.params.id;
  if (!db.plays[playId]) return res.status(404).json({ error: 'Piece introuvable' });
  delete db.plays[playId];
  pregen.cancel(playId);
  Object.values(db.states).forEach((u) => delete u[playId]);
  delete db.recordings[playId];
  // Enregistrements (toutes les prises) et enregistrements de lecture a table de cette
  // piece : sinon ils restent orphelins sur le disque indefiniment.
  fs.rm(path.join(RECORDINGS_DIR, playId), { recursive: true, force: true }, () => {});
  fs.readdir(MASTERS_DIR, (err, files) => {
    if (err) return;
    files.filter((f) => f.startsWith(playId + '__')).forEach((f) => fs.unlink(path.join(MASTERS_DIR, f), () => {}));
  });
  persist();
  res.json({ ok: true });
});

// ---------- Etat par utilisateur (annotations, progression, voix) ----------
// Le personnage joue (selectedCharacters) n'est plus choisi par l'utilisateur : c'est
// l'administrateur qui le distribue (voir /api/plays/:id/roles/:userId ci-dessus).
app.get('/api/state/:playId', requireAuth, (req, res) => {
  const play = db.plays[req.params.playId];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).json({ error: 'Accès refusé' });
  const stored = (db.states[req.user.id] && db.states[req.user.id][req.params.playId]) || {
    annotations: {}, progress: {}, voices: {},
  };
  res.json({
    selectedCharacters: (play.roles && play.roles[req.user.id]) || [],
    annotations: stored.annotations || {},
    progress: stored.progress || {},
    voices: stored.voices || {},
  });
});

// Vue d'ensemble de la progression de la troupe sur une piece (admin ou metteur en
// scene) : pour chaque membre de la troupe assignee, son personnage et son taux de
// repliques "acquises". Contrairement aux stats personnelles (/api/state), ceci
// agrege les progressions de tout le monde, pas seulement celle de l'appelant.
app.get('/api/plays/:id/troupe-stats', requireAuth, requireAdminOrDirector, (req, res) => {
  const play = db.plays[req.params.id];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).json({ error: 'Accès refusé' });
  const members = Object.values(db.users).filter((u) => play.troupeId && (u.troupeIds || []).includes(play.troupeId));
  const roles = play.roles || {};
  const stats = members.map((u) => {
    const characters = roles[u.id] || [];
    const myLines = [];
    play.acts.forEach((a) => a.scenes.forEach((s) => s.lines.forEach((l) => {
      if (!l.isStageDirection && characters.includes(l.character)) myLines.push(l);
    })));
    const state = (db.states[u.id] && db.states[u.id][play.id]) || { progress: {} };
    const doneLines = myLines.filter((l) => state.progress[l.id] === 'acquise').length;
    return {
      userId: u.id, name: u.name, characters,
      totalLines: myLines.length, doneLines,
      pct: myLines.length ? Math.round((doneLines / myLines.length) * 100) : null,
    };
  });
  stats.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ playId: play.id, title: play.title, members: stats });
});

// Notes personnelles de chaque membre de la troupe sur ses propres repliques (admin ou
// metteur en scene uniquement) : permet de suivre les intentions de jeu de chacun sans
// devoir demander individuellement a chaque comedien.
app.get('/api/plays/:id/all-annotations', requireAuth, requireAdminOrDirector, (req, res) => {
  const play = db.plays[req.params.id];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).json({ error: 'Accès refusé' });
  const members = Object.values(db.users).filter((u) => play.troupeId && (u.troupeIds || []).includes(play.troupeId));
  const roles = play.roles || {};
  const result = members
    .map((u) => ({
      userId: u.id,
      name: u.name,
      characters: roles[u.id] || [],
      annotations: (db.states[u.id] && db.states[u.id][play.id] && db.states[u.id][play.id].annotations) || {},
    }))
    .filter((m) => Object.keys(m.annotations).length > 0);
  result.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ members: result });
});

app.put('/api/state/:playId', requireAuth, (req, res) => {
  const play = db.plays[req.params.playId];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).json({ error: 'Accès refusé' });
  const { annotations, progress, voices } = req.body;
  if (!db.states[req.user.id]) db.states[req.user.id] = {};
  db.states[req.user.id][req.params.playId] = {
    annotations: annotations && typeof annotations === 'object' ? annotations : {},
    progress: progress && typeof progress === 'object' ? progress : {},
    voices: voices && typeof voices === 'object' ? voices : {},
  };
  persist();
  res.json({ ok: true });
});

// ---------- Enregistrements vocaux partages (voix reelle des comediens) ----------
// Quand un comedien s'enregistre sur "ses" repliques (mode audio), l'enregistrement
// est envoye ici et devient disponible pour toute la troupe : au lieu de la voix
// synthetique, les autres entendent sa vraie voix sur ce personnage. Repli automatique
// sur la synthese vocale pour les repliques non enregistrees.
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
const MASTERS_DIR = path.join(DATA_DIR, 'table-read-masters');

function isValidId(id) { return /^[A-Za-z0-9_-]+$/.test(id || ''); }
function recordingFile(playId, lineId, takeId) {
  return path.join(RECORDINGS_DIR, playId, lineId + '__' + takeId + '.wav');
}
function activeTakeFile(playId, lineId) {
  const entry = db.recordings[playId] && db.recordings[playId][lineId];
  if (!entry || !entry.activeId) return null;
  return recordingFile(playId, lineId, entry.activeId);
}

app.post('/api/recordings/:playId/:lineId', requireAuth, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const { playId, lineId } = req.params;
  const play = db.plays[playId];
  if (!play) return res.status(404).json({ error: 'Piece introuvable' });
  if (!canAccessPlay(req.user, play)) return res.status(403).json({ error: 'Accès refusé' });
  if (req.user.role !== 'admin') {
    const line = findLineInPlay(play, lineId);
    const myCharacters = (play.roles && play.roles[req.user.id]) || [];
    if (!line || !line.character || !myCharacters.includes(line.character)) {
      return res.status(403).json({ error: "Tu ne peux enregistrer que les répliques de ton personnage" });
    }
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Audio manquant' });
  try {
    const wav = await tts.convertToWav(req.body);
    const takeId = crypto.randomBytes(6).toString('hex');
    const dir = path.join(RECORDINGS_DIR, playId);
    fs.mkdirSync(dir, { recursive: true });
    await fs.promises.writeFile(recordingFile(playId, lineId, takeId), wav);
    if (!db.recordings[playId]) db.recordings[playId] = {};
    if (!db.recordings[playId][lineId]) db.recordings[playId][lineId] = { activeId: null, takes: [] };
    const entry = db.recordings[playId][lineId];
    entry.takes.push({ id: takeId, recordedBy: req.user.id, recordedByName: req.user.name, updatedAt: Date.now(), source: 'ligne' });
    entry.activeId = takeId; // la prise la plus recente devient active, comme avant
    persist();
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur enregistrement', err.message);
    res.status(500).json({ error: "Echec de l'enregistrement (format audio non reconnu ?)" });
  }
});

// Audio de la prise ACTIVE (utilise partout pendant les repetitions/le mode audio).
app.get('/api/recordings/:playId/:lineId', requireAuth, (req, res) => {
  const play = db.plays[req.params.playId];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).end();
  const file = activeTakeFile(req.params.playId, req.params.lineId);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'no-cache');
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

// Ecoute d'une prise precise (pas forcement l'active), pour comparer avant de choisir.
app.get('/api/recordings/:playId/:lineId/takes/:takeId', requireAuth, (req, res) => {
  const play = db.plays[req.params.playId];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).end();
  if (!isValidId(req.params.takeId)) return res.status(400).end();
  const file = recordingFile(req.params.playId, req.params.lineId, req.params.takeId);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'no-cache');
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

// Choisit quelle prise (parmi celles gardees) est la prise active.
app.put('/api/recordings/:playId/:lineId/active', requireAuth, requireAdmin, (req, res) => {
  const { playId, lineId } = req.params;
  const entry = db.recordings[playId] && db.recordings[playId][lineId];
  if (!entry) return res.status(404).json({ error: 'Aucune prise pour cette réplique' });
  const takeId = (req.body.takeId || '').toString();
  if (!entry.takes.some((t) => t.id === takeId)) return res.status(404).json({ error: 'Prise introuvable' });
  entry.activeId = takeId;
  persist();
  res.json({ ok: true, activeId: takeId });
});

// Supprime une prise precise (garde les autres). Si c'etait l'active, promeut la plus
// recente restante ; s'il n'en reste aucune, la replique redevient sans enregistrement.
app.delete('/api/recordings/:playId/:lineId/takes/:takeId', requireAuth, requireAdmin, (req, res) => {
  const { playId, lineId, takeId } = req.params;
  const entry = db.recordings[playId] && db.recordings[playId][lineId];
  if (!entry) return res.status(404).json({ error: 'Aucune prise pour cette réplique' });
  const idx = entry.takes.findIndex((t) => t.id === takeId);
  if (idx === -1) return res.status(404).json({ error: 'Prise introuvable' });
  fs.unlink(recordingFile(playId, lineId, takeId), () => {}); // best-effort
  entry.takes.splice(idx, 1);
  if (entry.activeId === takeId) {
    const remaining = entry.takes.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    entry.activeId = remaining.length ? remaining[0].id : null;
  }
  if (!entry.takes.length) delete db.recordings[playId][lineId];
  persist();
  res.json({ ok: true, activeId: entry.activeId || null });
});

// Liste des repliques deja enregistrees pour une piece (pour afficher un repere dans l'appli).
app.get('/api/recordings/:playId', requireAuth, (req, res) => {
  const play = db.plays[req.params.playId];
  if (!play || !canAccessPlay(req.user, play)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(db.recordings[req.params.playId] || {});
});

// ---------- Lecture a table (reserve a l'administrateur : outil de production) ----------
// "scope" = 'full' (toute la piece) ou l'id d'une scene precise (ex. 'a0s0') : chaque
// portee garde son propre fichier maitre, pour pouvoir enregistrer/decouper scene par
// scene (le cas le plus frequent en pratique) sans que l'une n'ecrase l'autre.
app.post('/api/table-read/:playId/:scope', requireAuth, requireAdmin, express.raw({ type: () => true, limit: '300mb' }), (req, res) => {
  const { playId, scope } = req.params;
  if (!db.plays[playId]) return res.status(404).json({ error: 'Piece introuvable' });
  if (!isValidId(scope)) return res.status(400).json({ error: 'Portee invalide' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Audio manquant' });
  fs.mkdirSync(MASTERS_DIR, { recursive: true });
  fs.writeFile(path.join(MASTERS_DIR, playId + '__' + scope + '.bin'), req.body, (err) => {
    if (err) return res.status(500).json({ error: "Echec de l'upload" });
    res.json({ ok: true });
  });
});

app.post('/api/table-read/:playId/:scope/split', requireAuth, requireAdmin, async (req, res) => {
  const { playId, scope } = req.params;
  if (!db.plays[playId]) return res.status(404).json({ error: 'Piece introuvable' });
  if (!isValidId(scope)) return res.status(400).json({ error: 'Portee invalide' });
  const masterFile = path.join(MASTERS_DIR, playId + '__' + scope + '.bin');
  if (!fs.existsSync(masterFile)) return res.status(404).json({ error: 'Aucun enregistrement de lecture a table trouve' });
  const segments = Array.isArray(req.body.segments) ? req.body.segments : [];
  if (!segments.length) return res.status(400).json({ error: 'Aucun segment fourni' });
  const masterBuf = await fs.promises.readFile(masterFile);
  const results = [];
  for (const seg of segments) {
    try {
      const wav = await tts.trimAudio(masterBuf, seg.start, seg.end);
      const takeId = crypto.randomBytes(6).toString('hex');
      const dir = path.join(RECORDINGS_DIR, playId);
      fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(recordingFile(playId, seg.lineId, takeId), wav);
      if (!db.recordings[playId]) db.recordings[playId] = {};
      if (!db.recordings[playId][seg.lineId]) db.recordings[playId][seg.lineId] = { activeId: null, takes: [] };
      const entry = db.recordings[playId][seg.lineId];
      entry.takes.push({ id: takeId, recordedBy: req.user.id, recordedByName: req.user.name, updatedAt: Date.now(), source: 'table' });
      entry.activeId = takeId;
      results.push({ lineId: seg.lineId, ok: true });
    } catch (err) {
      results.push({ lineId: seg.lineId, ok: false, error: err.message });
    }
  }
  persist();
  res.json({ results });
});

// ---------- Synthese vocale (Piper, dans Node) ----------
app.post('/api/tts', requireAuth, async (req, res) => {
  const text = (req.body.text || '').toString().slice(0, 2000).trim();
  const voice = (req.body.voice || '').toString();
  if (!text) return res.status(400).json({ error: 'Texte requis' });
  try {
    const audio = await tts.synthesize(text, voice);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(audio);
  } catch (err) {
    console.error('Erreur TTS', err.message);
    res.status(500).json({ error: 'Echec de la synthese vocale', detail: err.message });
  }
});

// Variante GET pour test direct dans le navigateur (lien cliquable / <audio> natif),
// hors du pipeline JS de l'appli : sert a diagnostiquer si un souci vient du fichier
// audio lui-meme ou de la lecture cote client. Reservee a l'admin (outil de diagnostic).
app.get('/api/tts', requireAuth, requireAdmin, async (req, res) => {
  const text = (req.query.text || 'Ceci est un test de la voix.').toString().slice(0, 2000).trim();
  const voice = (req.query.voice || '').toString();
  const format = ['wav', 'aac'].includes(req.query.format) ? req.query.format : 'mp3';
  try {
    const audio = await tts.synthesize(text, voice, format);
    res.set('Content-Type', format === 'wav' ? 'audio/wav' : (tts.FORMATS[format] ? tts.FORMATS[format].mime : 'audio/mpeg'));
    res.send(audio);
  } catch (err) {
    res.status(500).send('Echec : ' + err.message);
  }
});

// Tonalite pure generee mathematiquement (aucun lien avec Piper/ffmpeg) : sert de
// reference "son forcement propre" pour verifier que l'appareil/reseau du testeur
// lit n'importe quel audio correctement. Reservee a l'admin (outil de diagnostic).
app.get('/api/test-tone', requireAuth, requireAdmin, (req, res) => {
  const sampleRate = 44100, seconds = 2, freq = 440;
  const n = sampleRate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 500, (n - i) / 500); // evite un clic au debut/fin
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 20000 * fade);
    data.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  res.set('Content-Type', 'audio/wav');
  res.send(Buffer.concat([header, data]));
});

// Telecharge en arriere-plan les modeles de voix manquants (premier demarrage seulement),
// sans bloquer le demarrage. Fait dans tous les cas, que l'app soit lancee seule ou montee
// par une passerelle (voir plus bas).
tts.warmup().then(() => console.log('Voix de synthese pretes.'));

// Lancee seule (node server.js) : demarre son propre serveur HTTP comme avant.
// Chargee par une passerelle (require('.../server.js')) : exporte juste l'app Express,
// montee sur une route par la passerelle — pas de app.listen() ici dans ce cas.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Répétito disponible sur http://localhost:${PORT}`));
}
module.exports = app;
