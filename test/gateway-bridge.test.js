// Connexion centralisee de node-gateway : req.gateway (pose par la passerelle) donne, via /api/auth/gateway, un
// jeton pour le compte local de meme nom (ou e-mail) ; aucun compte cree. Ce jeton tombe des que la passerelle
// ne se porte plus garante. Un jeton local normal n'est jamais touche. Hors passerelle : inchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repetito-gw-'));
process.env.REPETITO_DATA_DIR = dir;
const express = require('express');
const app = require('../server');

let srv, base, localToken;
const gw = (login, role = 'member', email = null) => ({ 'x-test-gateway': JSON.stringify({ app: 'repetito', role, user: { login, name: login, email, isSuper: false } }) });
const bridge = (headers = {}) => fetch(base + '/api/auth/gateway', { headers });
const plays = (token, headers = {}) => fetch(base + '/api/plays', { headers: { Authorization: 'Bearer ' + token, ...headers } });

test.before(async () => {
  const outer = express();
  outer.use((req, res, next) => { const h = req.get('x-test-gateway'); if (h) req.gateway = JSON.parse(h); next(); });
  outer.use('/rep', app);
  srv = http.createServer(outer);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/rep`;
  try {
    // le tout premier login cree le compte administrateur
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'thomas', password: 'motdepasse' }) });
    assert.equal(r.status, 200);
    localToken = (await r.json()).token;
  } catch (e) { srv.close(); throw e; }
});
test.after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); setImmediate(() => process.exit(0)); });

test('identifiant de la passerelle -> jeton pour le compte local de meme nom', async () => {
  const r = await bridge(gw('THOMAS'));
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.user.name, 'thomas');
  assert.equal(s.user.role, 'admin');
  assert.notEqual(s.token, localToken);
  assert.equal((await plays(s.token, gw('thomas'))).status, 200, 'jeton valable tant que la passerelle garantit');
});

test('le jeton passerelle tombe des que la passerelle ne se porte plus garante', async () => {
  const { token } = await (await bridge(gw('thomas'))).json();
  assert.equal((await plays(token)).status, 401, 'sans passerelle (deconnexion / droit retire)');
  assert.equal((await plays(token, gw('autre'))).status, 401, 'autre compte');
});

test('jeton local normal inchange, hors passerelle comme derriere elle', async () => {
  assert.equal((await plays(localToken)).status, 200);
  assert.equal((await plays(localToken, gw('autre'))).status, 200);
});

test('aucun compte cree : inconnu, anonyme ou sans droit => 204 (login normal)', async () => {
  for (const h of [gw('inconnu'), {}, { 'x-test-gateway': JSON.stringify({ app: 'repetito', role: null, user: { login: 'thomas' } }) }]) {
    assert.equal((await bridge(h)).status, 204);
  }
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'inconnu', password: 'xxxx' }) });
  assert.equal(r.status, 404, 'le compte n\'existe toujours pas');
});
