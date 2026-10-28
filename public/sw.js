// Coquille hors ligne : precache l'app (HTML/JS/CSS/icones) et les donnees de lecture
// (liste des pieces, texte d'une piece, etat/annotations/progression) en strategie
// "reseau d'abord, repli sur le cache" -- toujours a jour quand il y a du reseau, mais
// utilisable hors connexion avec la derniere version connue.
// L'audio (TTS et enregistrements) n'est PAS gere ici : il est mis en cache a la demande
// par l'appli elle-meme (bouton "Audio hors-ligne"), dans un cache separe que ce
// service worker ne touche jamais.
// Chemin de montage (ex. '/repetito' derriere une passerelle, '' a la racine), deduit
// de la portee (scope) avec laquelle ce service worker a ete enregistre.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const SHELL_CACHE = 'repetito-shell-v3';
const SHELL_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/app.js',
  BASE + '/style.css',
  BASE + '/manifest.json',
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-180.png',
  BASE + '/icons/icon-512.png',
];
const CACHEABLE_API_PREFIXES = [BASE + '/api/plays', BASE + '/api/state/'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('repetito-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isCacheableApi(pathname) {
  return CACHEABLE_API_PREFIXES.some((p) => pathname.startsWith(p)) && !pathname.endsWith('/share');
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match(BASE + '/index.html');
      if (shell) return shell;
    }
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // laisse passer les ecritures (POST/PUT/DELETE) sans interception
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isShellAsset = SHELL_ASSETS.includes(url.pathname) || req.mode === 'navigate';
  const isApi = url.pathname.startsWith(BASE + '/api/') && isCacheableApi(url.pathname);
  if (isShellAsset || isApi) event.respondWith(networkFirst(req));
});
