(function () {
  'use strict';

  // Chemin de montage de l'app (ex. '/repetito' quand une passerelle Node monte
  // plusieurs outils sous des sous-dossiers, '' si servie a la racine). Deduit de
  // l'URL reelle utilisee pour charger ce script (via la balise <script src="app.js">,
  // volontairement relative) : fonctionne sans configuration a coder en dur.
  const BASE = (() => {
    try {
      const scriptUrl = document.currentScript && document.currentScript.src;
      if (!scriptUrl) return '';
      return new URL('.', scriptUrl).pathname.replace(/\/$/, '');
    } catch (e) { return ''; }
  })();

  // ================= Regex de parsing =================
  const ACT_RE = /^(ACTE|ACT)\b/i;
  const SCENE_RE = /^(SC[ÈE]NES?|SCENE)\b/i;
  const STAGE_DIRECTION_RE = /^\(.*\)$/;
  const CUE_RE = /^([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒ][A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒ0-9'’ \-.]{0,45}?)\s*(?:\(([^()]*)\)\s*)?(?:[:.\-–—]\s*(.*))?$/;

  const STATUS_LABELS = { a_revoir: 'À revoir', en_cours: 'En cours', acquise: 'Acquise' };

  // ================= Utilitaires DOM =================
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function elHTML(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Une replique peut contenir une didascalie entre parentheses au milieu du texte
  // (ex: "Alors ? (Il hoche la tete.) Inquiete, elle insiste.") : a isoler visuellement
  // et a exclure de la synthese vocale.
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
  function renderInlineText(text) {
    return splitInlineDirections(text).map((p) => (
      p.type === 'direction' ? `<span class="inline-direction">${escapeHtml(p.value)}</span>` : escapeHtml(p.value)
    )).join('');
  }
  function spokenTextOnly(text) {
    return splitInlineDirections(text).filter((p) => p.type === 'text').map((p) => p.value).join(' ').replace(/\s+/g, ' ').trim();
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // Dictionnaire de prononciation : DOIT rester identique a text-utils.js (cote serveur), pour
  // que les fichiers prepares en avance par le serveur correspondent a ce que demande le telephone.
  function applyPronunciations(text, entries) {
    if (!entries || !entries.length) return text;
    let out = text;
    entries.slice().sort((a, b) => b.from.length - a.from.length).forEach(({ from, to }) => {
      out = out.replace(new RegExp('(?<![\\p{L}\\p{N}])' + escapeRegex(from) + '(?![\\p{L}\\p{N}])', 'giu'), to);
    });
    return out;
  }
  // Texte envoye a la synthese vocale : sans didascalies, avec le dictionnaire de la piece.
  function ttsText(text) { return applyPronunciations(spokenTextOnly(text), currentPlay && currentPlay.pronunciations); }
  function hashText(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2200);
  }
  function debounce(fn, ms) {
    let h;
    return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
  }

  function authHeaders() {
    return session && session.token ? { Authorization: 'Bearer ' + session.token } : {};
  }
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, authHeaders(), opts.body ? { 'Content-Type': 'application/json' } : {});
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && !path.startsWith('/api/auth/')) { clearSession(); location.reload(); throw new Error('Session expirée'); }
    if (!res.ok) {
      let msg = 'Erreur serveur';
      try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
      toast(msg);
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  // ================= Parsing du texte collé =================
  // Produit une liste plate de "tokens" : {type:'act'|'scene'|'line'|'direction', title?, character?, text?}
  function parsePlayTokens(raw) {
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const tokens = [];
    let openLine = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { openLine = false; continue; }
      if (ACT_RE.test(line)) { tokens.push({ type: 'act', title: line }); openLine = false; continue; }
      if (SCENE_RE.test(line)) { tokens.push({ type: 'scene', title: line }); openLine = false; continue; }
      if (STAGE_DIRECTION_RE.test(line)) { tokens.push({ type: 'direction', text: line.replace(/^\(|\)$/g, '') }); openLine = false; continue; }
      const m = CUE_RE.exec(line);
      if (m) {
        const namePart = m[1].trim();
        const inlineNote = (m[2] || '').trim();
        const rest = (m[3] || '').trim();
        const isAllCaps = namePart.length >= 2 && namePart.length <= 45 &&
          namePart === namePart.toUpperCase() && /[A-ZÀ-Ü]/.test(namePart) && !/\d{2,}/.test(namePart);
        if (isAllCaps) {
          const text = inlineNote ? `(${inlineNote}) ${rest}`.trim() : rest;
          tokens.push({ type: 'line', character: namePart.replace(/[.:]+$/, '').trim(), text });
          openLine = true;
          continue;
        }
      }
      if (openLine && tokens.length) {
        const last = tokens[tokens.length - 1];
        last.text = (last.text ? last.text + ' ' : '') + line;
      } else {
        tokens.push({ type: 'line', character: null, text: line });
        openLine = true;
      }
    }
    return tokens;
  }

  // Transforme la liste plate corrigee en structure imbriquee actes > scenes > lignes
  function nestTokens(tokens) {
    const acts = [];
    let currentAct = null;
    let currentScene = null;
    function ensureAct(title) {
      currentAct = { title: title || `Acte ${acts.length + 1}`, scenes: [] };
      acts.push(currentAct);
      currentScene = null;
    }
    function ensureScene(title) {
      if (!currentAct) ensureAct();
      currentScene = { title: title || `Scène ${currentAct.scenes.length + 1}`, lines: [] };
      currentAct.scenes.push(currentScene);
    }
    tokens.forEach((t) => {
      if (t.type === 'act') { ensureAct(t.title); return; }
      if (t.type === 'scene') { ensureScene(t.title); return; }
      if (!currentScene) ensureScene();
      if (t.type === 'direction') {
        currentScene.lines.push({ id: t.id, character: null, text: (t.text || '').trim(), isStageDirection: true });
      } else {
        const character = t.character ? t.character.trim().toUpperCase() : null;
        currentScene.lines.push({ id: t.id, character, text: (t.text || '').trim(), isStageDirection: false });
      }
    });
    // Modification d'une piece existante : les repliques deja connues gardent leur identifiant,
    // les nouvelles en recoivent un unique. Import initial : identifiants positionnels.
    const preserving = tokens.some((t) => t.id);
    const stamp = Date.now().toString(36);
    let seq = 0;
    const usedIds = new Set();
    const characters = new Set();
    acts.forEach((a, ai) => {
      a.id = 'a' + ai;
      a.scenes.forEach((s, si) => {
        s.id = a.id + 's' + si;
        s.lines.forEach((l, li) => {
          if (preserving) {
            if (!l.id || usedIds.has(l.id)) l.id = 'n' + stamp + (seq++).toString(36);
          } else {
            l.id = s.id + 'l' + li;
          }
          usedIds.add(l.id);
          if (l.character) characters.add(l.character);
        });
      });
    });
    return { acts, characters: Array.from(characters).sort() };
  }

  // ================= Etat de l'application =================
  let user = null;
  let plays = [];
  let currentPlay = null;
  let userState = { selectedCharacters: [], annotations: {}, progress: {}, voices: {} };
  let importTokens = [];
  let editingPlayId = null;
  let screenStack = []; // pile de navigation pour les ecrans "secondaires" (import, enregistrements, lecture a table...)
  let passwordChangeIsMandatory = false; // true si la modale vient du mot de passe temporaire (pas d'annulation possible)

  let session = null; // { token, user: {id, name, role} }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem('tr_session') || 'null'); } catch (e) { return null; }
  }
  function saveSession(s) { localStorage.setItem('tr_session', JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem('tr_session'); session = null; user = null; }
  function isAdmin() { return !!(user && user.role === 'admin'); }
  function isDirector() { return !!(user && user.role === 'director'); }
  function applyRoleVisibility() {
    $all('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
    $all('.director-only').forEach((el) => el.classList.toggle('hidden', !(isAdmin() || isDirector())));
  }

  // ================= Synchronisation differee (annotations/progression saisies hors-ligne) =================
  // Le PUT d'etat envoie toujours l'etat complet (pas de diff) : il suffit donc de garder
  // une copie locale par piece + un marqueur "en attente" pour pouvoir renvoyer la copie
  // complete des qu'on retrouve le reseau, meme si l'appli a change de piece entre-temps.
  function pendingSyncMap() {
    try { return JSON.parse(localStorage.getItem('tr_pending_sync') || '{}'); } catch (e) { return {}; }
  }
  function setPendingSync(playId, pending) {
    const map = pendingSyncMap();
    if (pending) map[playId] = true; else delete map[playId];
    localStorage.setItem('tr_pending_sync', JSON.stringify(map));
    updateSyncBadge();
  }
  function localStateKey(playId) { return 'tr_local_state_' + playId; }
  function saveLocalStateBackup(playId, state) {
    try { localStorage.setItem(localStateKey(playId), JSON.stringify(state)); } catch (e) { /* quota depassee : tant pis */ }
  }
  function loadLocalStateBackup(playId) {
    try { return JSON.parse(localStorage.getItem(localStateKey(playId)) || 'null'); } catch (e) { return null; }
  }
  // Derniere position consultee (scene en revision, scene+index en audio), par piece et
  // par appareil (localStorage, pas synchronise) : permet de rouvrir l'appli exactement
  // ou on l'avait laissee plutot que de toujours repartir de la premiere scene.
  function lastPosKey(playId) { return 'tr_last_pos_' + playId; }
  function loadLastPos(playId) {
    try { return JSON.parse(localStorage.getItem(lastPosKey(playId)) || 'null') || {}; } catch (e) { return {}; }
  }
  function saveLastPos(playId, patch) {
    try { localStorage.setItem(lastPosKey(playId), JSON.stringify(Object.assign(loadLastPos(playId), patch))); }
    catch (e) { /* quota depassee : tant pis, pas bloquant */ }
  }
  function updateSyncBadge() {
    const has = Object.keys(pendingSyncMap()).length > 0;
    const badge = $('#sync-badge');
    if (badge) badge.classList.toggle('hidden', !has);
  }
  async function flushPendingSync() {
    const ids = Object.keys(pendingSyncMap());
    if (!ids.length) return;
    let okCount = 0;
    for (const id of ids) {
      const isCurrent = currentPlay && currentPlay.id === id;
      const body = isCurrent
        ? { annotations: userState.annotations, progress: userState.progress, voices: userState.voices }
        : loadLocalStateBackup(id);
      if (!body) { setPendingSync(id, false); continue; }
      try {
        await api('/api/state/' + id, { method: 'PUT', body });
        setPendingSync(id, false);
        okCount++;
      } catch (e) { /* toujours hors-ligne : on reessaiera au prochain retour de reseau */ }
    }
    if (okCount > 0) toast(okCount === ids.length ? 'Modifications synchronisées' : `${okCount}/${ids.length} pièces synchronisées`);
  }

  const saveState = debounce(async () => {
    if (!currentPlay) return;
    const playId = currentPlay.id;
    const snapshot = { annotations: userState.annotations, progress: userState.progress, voices: userState.voices };
    saveLocalStateBackup(playId, snapshot);
    try {
      await api('/api/state/' + playId, { method: 'PUT', body: snapshot });
      setPendingSync(playId, false);
    } catch (e) { setPendingSync(playId, true); /* hors-ligne : synchronisation differee au retour du reseau */ }
  }, 500);

  function isMine(character) { return !!character && userState.selectedCharacters.includes(character); }

  function findSceneByKey(key) {
    for (const a of currentPlay.acts) for (const s of a.scenes) if (s.id === key) return { act: a, scene: s };
    return null;
  }
  function allScenesFlat() {
    const out = [];
    currentPlay.acts.forEach((a) => a.scenes.forEach((s) => out.push({ act: a, scene: s })));
    return out;
  }
  function fillSceneSelect(selectEl, keepValue) {
    selectEl.innerHTML = '';
    allScenesFlat().forEach(({ act, scene }) => {
      const opt = document.createElement('option');
      opt.value = scene.id;
      opt.textContent = act.title + ' — ' + scene.title;
      selectEl.appendChild(opt);
    });
    if (keepValue) selectEl.value = keepValue;
  }
  function computeOverallProgress() {
    let total = 0, done = 0;
    currentPlay.acts.forEach((a) => a.scenes.forEach((s) => s.lines.forEach((l) => {
      if (l.isStageDirection || !isMine(l.character)) return;
      total++;
      if (userState.progress[l.id] === 'acquise') done++;
    })));
    return { pct: total ? Math.round((done / total) * 100) : 0, total, done };
  }

  // ================= Navigation =================
  const SCREENS = ['library', 'import', 'play', 'revision', 'audio', 'stats', 'recordings', 'tableread', 'accounts', 'directornotes'];
  const TOP_LEVEL_SCREENS = ['library', 'play', 'revision', 'audio', 'stats'];
  const TITLES = {
    library: 'Bibliothèque',
    import: () => (editingPlayId ? 'Modifier la pièce' : 'Importer une pièce'),
    play: () => (currentPlay ? currentPlay.title : 'Pièce'),
    revision: 'Mode révision',
    audio: 'Mode audio',
    stats: 'Statistiques',
    recordings: 'Enregistrements',
    tableread: 'Lecture à table',
    accounts: 'Comptes',
    directornotes: 'Notes de mise en scène',
  };
  function showScreen(name) {
    SCREENS.forEach((s) => $('#screen-' + s).classList.toggle('active', s === name));
    $('#btn-back').classList.toggle('hidden', TOP_LEVEL_SCREENS.includes(name));
    $all('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
    const t = TITLES[name];
    $('#topbar-title').textContent = typeof t === 'function' ? t() : t;
    window.scrollTo(0, 0);
    if (name !== 'audio') stopAudioPlayback();
    activeScreenName = name;
    if (name === 'revision' || name === 'audio') acquireWakeLock(); else releaseWakeLock();
  }
  // Pour un "drill-down" vers un ecran secondaire (import, enregistrements, lecture a
  // table...) : empile l'ecran courant pour que le bouton retour revienne exactement
  // en arriere, meme sur plusieurs niveaux (ex: Pièce -> Enregistrements -> Lecture a table).
  function pushScreen(name) {
    if (activeScreenName) screenStack.push(activeScreenName);
    showScreen(name);
  }

  // ---- Wake Lock : empeche l'ecran de se verrouiller pendant la revision/repetition ----
  let activeScreenName = null;
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* refuse (hors focus, batterie faible...) : tant pis, pas bloquant */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (activeScreenName === 'revision' || activeScreenName === 'audio')) acquireWakeLock();
  });

  // ================= Ecran : bibliothèque =================
  async function refreshLibrary() {
    plays = await api('/api/plays');
    renderLibrary();
  }
  function renderLibrary() {
    const list = $('#library-list');
    list.innerHTML = '';
    if (!plays.length) {
      list.appendChild(el('p', 'hint', "Aucune pièce importée pour l'instant. Ajoute la première !"));
      return;
    }
    plays.forEach((p) => {
      const card = el('div', 'play-card');
      card.innerHTML = `
        <h3>${escapeHtml(p.title)}</h3>
        <div class="meta">${p.stats.acts} acte(s) · ${p.stats.scenes} scène(s) · ${p.stats.lines} répliques · importée par ${escapeHtml(p.createdByName)}</div>
        <div class="meta">Personnages : ${escapeHtml(p.characters.join(', ') || '—')}</div>
        <div class="actions"><button class="btn btn-primary btn-sm" data-open="${p.id}">Ouvrir</button></div>`;
      list.appendChild(card);
    });
  }
  async function openPlay(id) {
    try {
      currentPlay = await api('/api/plays/' + id);
    } catch (e) { toast('Pièce indisponible hors-ligne pour le moment'); return; }
    // Le personnage joue est distribue par l'administrateur (currentPlay.roles), jamais
    // choisi par l'utilisateur : toujours derive de la piece, meme hors-ligne (cache SW).
    const myRole = (currentPlay.roles && currentPlay.roles[user.id]) || [];
    if (pendingSyncMap()[id]) {
      // Des modifications faites hors-ligne n'ont pas encore ete envoyees au serveur :
      // on garde la copie locale (annotations/progression/voix) plutot que d'ecraser
      // avec la version (perimee) du serveur.
      const backup = loadLocalStateBackup(id) || { annotations: {}, progress: {}, voices: {} };
      userState = Object.assign({ selectedCharacters: myRole }, backup);
    } else {
      try { userState = await api('/api/state/' + id); }
      catch (e) {
        const backup = loadLocalStateBackup(id) || { annotations: {}, progress: {}, voices: {} };
        userState = Object.assign({ selectedCharacters: myRole }, backup);
      }
    }
    renderPlayScreen();
    showScreen('play');
  }

  // ================= Ecran : import / edition =================
  function resetImportForm() {
    editingPlayId = null;
    $('#import-heading').textContent = 'Importer une pièce';
    $('#btn-back-to-paste').textContent = '← Recommencer';
    $('#import-title').value = '';
    $('#import-text').value = '';
    $('#import-step-paste').classList.remove('hidden');
    $('#import-step-preview').classList.add('hidden');
  }
  function flattenPlayToTokens(play) {
    const tokens = [];
    play.acts.forEach((a) => {
      tokens.push({ type: 'act', title: a.title });
      a.scenes.forEach((s) => {
        tokens.push({ type: 'scene', title: s.title });
        s.lines.forEach((l) => {
          if (l.isStageDirection) tokens.push({ type: 'direction', text: l.text, id: l.id });
          else tokens.push({ type: 'line', character: l.character || '', text: l.text, id: l.id });
        });
      });
    });
    return tokens;
  }
  function openPlayEditor() {
    if (!currentPlay) return;
    editingPlayId = currentPlay.id;
    importTokens = flattenPlayToTokens(currentPlay);
    $('#import-heading').textContent = 'Modifier la pièce';
    $('#btn-back-to-paste').textContent = '← Annuler';
    $('#import-title').value = currentPlay.title;
    renderImportPreview();
    $('#import-step-paste').classList.add('hidden');
    $('#import-step-preview').classList.remove('hidden');
    pushScreen('import');
  }
  // ---- Outils de nettoyage des didascalies (import et modification d'une piece) ----
  // Didascalies entre parentheses placees au debut ou a la fin d'une replique : sorties en
  // cartes a part. Celles au milieu d'une phrase restent integrees (italique, non lues).
  function splitParentheticals(tokens) {
    const out = [];
    let count = 0;
    tokens.forEach((t) => {
      if (t.type !== 'line' || !t.text) { out.push(t); return; }
      let text = t.text.trim(), m;
      const before = [], after = [];
      while ((m = /^\(([^()]*)\)\s*([\s\S]+)$/.exec(text))) { before.push(m[1].trim()); text = m[2].trim(); }
      while ((m = /^([\s\S]+?)\s*\(([^()]*)\)$/.exec(text))) { after.unshift(m[2].trim()); text = m[1].trim(); }
      if (!before.length && !after.length) { out.push(t); return; }
      count += before.length + after.length;
      before.filter(Boolean).forEach((d) => out.push({ type: 'direction', text: d }));
      out.push(Object.assign({}, t, { text }));
      after.filter(Boolean).forEach((d) => out.push({ type: 'direction', text: d }));
    });
    return { tokens: out, count };
  }
  // Didascalies collees a la fin d'une replique sans parentheses (typique d'un PDF, ou le
  // italique est perdu) : une phrase qui commence par "Il/Elle/Ils/Elles" ou par le nom d'un
  // personnage, apres au moins une phrase de texte, et tout ce qui suit. Ce ne sont que des
  // SUGGESTIONS : l'utilisateur valide chacune (une replique peut aussi commencer par "Il").
  function findGluedDirections(tokens) {
    const names = Array.from(new Set(tokens.filter((t) => t.type === 'line' && t.character).map((t) => t.character.trim().toLowerCase()))).filter(Boolean);
    const startsLikeAction = (sentence) => {
      if (/^(Il|Elle|Ils|Elles)\s+\p{Ll}/u.test(sentence)) return true;
      const first = sentence.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '');
      return /^\p{Lu}/u.test(first) && names.includes(first.toLowerCase()) && /^\S+\s+\p{Ll}/u.test(sentence);
    };
    const found = [];
    tokens.forEach((t, index) => {
      if (t.type !== 'line' || !t.text) return;
      const sentences = t.text.trim().split(/(?<=[.!?…])\s+/);
      for (let i = 1; i < sentences.length; i++) {
        if (startsLikeAction(sentences[i])) {
          found.push({ index, before: sentences.slice(0, i).join(' '), direction: sentences.slice(i).join(' ') });
          break;
        }
      }
    });
    return found;
  }
  // Numeros de page restes dans le texte : "toi. 5 Docile" -> "toi. Docile", "... piteux. 6" -> "... piteux."
  function cleanPageNumbers(tokens) {
    let count = 0;
    const out = [];
    tokens.forEach((t) => {
      if ((t.type === 'line' || t.type === 'direction') && typeof t.text === 'string') {
        if (/^\d{1,3}$/.test(t.text.trim()) && !t.character) { count++; return; } // ligne reduite a un numero
        const cleaned = t.text
          .replace(/([.!?…)»])\s+\d{1,3}\s+(?=[A-ZÀ-ÝÉ])/g, (m, p) => { count++; return p + ' '; })
          .replace(/([.!?…)»])\s+\d{1,3}$/g, (m, p) => { count++; return p; });
        if (cleaned !== t.text) { out.push(Object.assign({}, t, { text: cleaned })); return; }
      }
      out.push(t);
    });
    return { tokens: out, count };
  }
  function renderGluedSuggestions(found) {
    const box = $('#direction-suggest');
    box.innerHTML = '';
    if (!found.length) {
      box.appendChild(el('p', 'hint', 'Aucune didascalie collée repérée.'));
      box.classList.remove('hidden');
      return;
    }
    box.appendChild(el('p', 'hint', `${found.length} réplique(s) contiennent peut-être une didascalie à la fin. Décoche celles qui sont en réalité du texte dit par le personnage.`));
    found.forEach((f, n) => {
      const row = el('label', 'glued-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.n = String(n);
      row.appendChild(cb);
      const body = el('span', 'glued-body');
      const who = importTokens[f.index].character;
      body.appendChild(el('span', 'glued-line', (who ? who + ' : ' : '') + f.before));
      body.appendChild(el('span', 'glued-dir', '🎬 ' + f.direction));
      row.appendChild(body);
      box.appendChild(row);
    });
    const actions = el('div', 'direction-tools-actions');
    const apply = el('button', 'btn btn-primary btn-sm', 'Détacher les didascalies cochées');
    apply.type = 'button';
    apply.addEventListener('click', () => {
      const chosen = $all('#direction-suggest input[type=checkbox]').filter((c) => c.checked).map((c) => found[+c.dataset.n]);
      chosen.sort((a, b) => b.index - a.index).forEach((f) => {
        const t = importTokens[f.index];
        importTokens.splice(f.index, 1, Object.assign({}, t, { text: f.before }), { type: 'direction', text: f.direction });
      });
      box.classList.add('hidden');
      renderImportPreview();
      toast(chosen.length + ' didascalie(s) détachée(s)');
    });
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Annuler');
    cancel.type = 'button';
    cancel.addEventListener('click', () => box.classList.add('hidden'));
    actions.appendChild(apply); actions.appendChild(cancel);
    box.appendChild(actions);
    box.classList.remove('hidden');
  }
  function renderImportPreview() {
    const chars = new Set(importTokens.filter((t) => t.type === 'line' && t.character).map((t) => t.character.toUpperCase()));
    const nLines = importTokens.filter((t) => t.type === 'line').length;
    $('#preview-summary').textContent = `${nLines} répliques détectées, ${chars.size} personnage(s) : ${Array.from(chars).join(', ')}`;
    const container = $('#preview-list');
    container.innerHTML = '';
    importTokens.forEach((t, i) => container.appendChild(renderTokenRow(t, i)));
  }
  function renderTokenRow(t, i) {
    const row = el('div', 'token-row type-' + t.type);
    row.dataset.index = String(i);

    const head = el('div', 'token-head');
    const typeSelect = document.createElement('select');
    typeSelect.className = 'type-select';
    typeSelect.dataset.field = 'type';
    typeSelect.innerHTML = `
      <option value="line">Réplique</option>
      <option value="direction">Didascalie</option>
      <option value="scene">Nouvelle scène</option>
      <option value="act">Nouvel acte</option>`;
    typeSelect.value = t.type;
    head.appendChild(typeSelect);

    if (t.type === 'line') {
      const charInput = document.createElement('input');
      charInput.className = 'char-input';
      charInput.dataset.field = 'character';
      charInput.placeholder = 'PERSONNAGE';
      charInput.value = t.character || '';
      head.appendChild(charInput);
    }
    row.appendChild(head);

    if (t.type === 'act' || t.type === 'scene') {
      const titleInput = document.createElement('input');
      titleInput.className = 'title-input';
      titleInput.dataset.field = 'title';
      titleInput.value = t.title || '';
      titleInput.placeholder = t.type === 'act' ? "Titre de l'acte" : 'Titre de la scène';
      row.appendChild(titleInput);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'text-input';
      ta.dataset.field = 'text';
      ta.rows = 1;
      ta.value = t.text || '';
      row.appendChild(ta);
    }

    const actions = el('div', 'row-actions');
    actions.innerHTML = `<button type="button" class="btn btn-ghost btn-sm" data-act="merge-up">⬆ Fusionner</button>${t.type === 'line' ? '<button type="button" class="btn btn-ghost btn-sm" data-act="detach" title="Sélectionne d\'abord un passage dans la réplique">✂️ Didascalie</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" data-act="delete">🗑</button>`;
    row.appendChild(actions);
    return row;
  }

  // ================= Ecran : pièce (vue d'ensemble) =================
  // Onglets de l'ecran Piece : Piece / Audio / Mise en scene / Gestion (les deux derniers ne
  // s'affichent que pour les roles concernes). On revient sur "Piece" a chaque nouvelle piece.
  let playTab = 'piece', playTabPlayId = null;
  function showPlayTab(name) {
    const btn = document.querySelector('.play-tab-btn[data-play-tab="' + name + '"]');
    if (!btn || btn.classList.contains('hidden')) name = 'piece';
    playTab = name;
    $all('.play-tab-btn').forEach((b) => { b.classList.toggle('active', b.dataset.playTab === name); b.setAttribute('aria-selected', b.dataset.playTab === name ? 'true' : 'false'); });
    $all('.play-tab-content').forEach((c) => c.classList.toggle('active', c.dataset.tab === name));
  }
  function renderPlayScreen() {
    if (!currentPlay) return;
    if (playTabPlayId !== currentPlay.id) { playTabPlayId = currentPlay.id; playTab = 'piece'; }
    showPlayTab(playTab);
    $('#play-title').textContent = currentPlay.title;
    renderCharacterPicker();
    renderVoicePicker();
    renderSceneList();
    updatePlayProgress();
    renderOfflineAudioStatus();
    updateRecordingsPanelText();
    if (isAdmin() || isDirector()) { renderSharePicker(); renderRoleAssignment(); }
    if (isAdmin() || isDirector()) { renderTroupeStats(); renderPronunciations(); refreshPregenStatus(); }
    $('#play-search-input').value = '';
    $('#play-search-results').innerHTML = '';
  }
  async function renderTroupeStats() {
    const box = $('#troupe-stats');
    if (!box || !currentPlay) return;
    box.innerHTML = '';
    let data;
    try { data = await api(`/api/plays/${currentPlay.id}/troupe-stats`); } catch (e) { return; }
    if (!data.members.length) { box.appendChild(el('p', 'hint', "Assigne d'abord la pièce à une troupe et distribue les rôles.")); return; }
    data.members.forEach((m) => {
      const row = el('div', 'troupe-stat-row');
      const charLabel = m.characters.length ? m.characters.join(', ') : 'Aucun rôle';
      row.appendChild(el('div', 'troupe-stat-name', `${m.name} — ${charLabel}`));
      if (m.pct == null) {
        row.appendChild(el('div', 'hint', 'Pas de réplique à suivre'));
      } else {
        const barWrap = el('div', 'progress-bar');
        const fill = el('div', 'progress-fill');
        fill.style.width = m.pct + '%';
        barWrap.appendChild(fill);
        row.appendChild(barWrap);
        row.appendChild(el('div', 'hint', `${m.doneLines}/${m.totalLines} acquises (${m.pct}%)`));
      }
      box.appendChild(row);
    });
  }
  // ================= Ecran : notes de mise en scene (metteur en scene / admin) =================
  // Deux sources distinctes affichees cote a cote pour chaque replique : la remarque du
  // metteur en scene (partagee, ecrite ici) et les notes personnelles de chaque comedien
  // (privees ailleurs dans l'appli, mais visibles ici en lecture pour le metteur en scene).
  let dnSceneKey = null;
  let dnAllAnnotations = [];
  async function renderDirectorNotesScreen() {
    if (!currentPlay) return;
    if (!dnSceneKey || !findSceneByKey(dnSceneKey)) {
      const flat = allScenesFlat();
      dnSceneKey = flat.length ? flat[0].scene.id : null;
    }
    try { dnAllAnnotations = (await api(`/api/plays/${currentPlay.id}/all-annotations`)).members; } catch (e) { dnAllAnnotations = []; }
    if (!dnSceneKey) { $('#dn-lines').innerHTML = '<p class="hint">Cette pièce ne contient aucune scène.</p>'; return; }
    fillSceneSelect($('#dn-scene-select'), dnSceneKey);
    renderDirectorNotesLines(findSceneByKey(dnSceneKey).scene);
  }
  function stepDnScene(delta) {
    const flat = allScenesFlat();
    const idx = flat.findIndex((f) => f.scene.id === dnSceneKey);
    const next = flat[idx + delta];
    if (!next) { toast(delta > 0 ? 'Dernière scène' : 'Première scène'); return; }
    dnSceneKey = next.scene.id;
    $('#dn-scene-select').value = dnSceneKey;
    renderDirectorNotesLines(next.scene);
  }
  function notesForLine(lineId) {
    return dnAllAnnotations
      .filter((m) => m.annotations[lineId])
      .map((m) => ({ name: m.name, note: m.annotations[lineId] }));
  }
  function renderDirectorNotesLines(scene) {
    const box = $('#dn-lines');
    box.innerHTML = '';
    scene.lines.forEach((l, li) => {
      if (l.isStageDirection) return;
      const card = el('div', 'line-card');
      card.dataset.lineId = l.id;
      card.appendChild(el('div', 'line-meta', `réplique ${li + 1}/${scene.lines.length}`));
      if (l.character) card.appendChild(el('div', 'character-name', l.character));
      card.appendChild(elHTML('div', 'line-text', renderInlineText(l.text)));

      const dirBox = el('div', 'annotation-box director-note-box');
      const dirLabel = el('div', 'field-label', '🎬 Remarque du metteur en scène (visible par toute la troupe)');
      const ta = document.createElement('textarea');
      ta.placeholder = 'Intention, déplacement, rythme…';
      ta.value = (currentPlay.directorNotes && currentPlay.directorNotes[l.id]) || '';
      const saveNote = debounce(async () => {
        try {
          const result = await api(`/api/plays/${currentPlay.id}/director-notes`, { method: 'PUT', body: { lineId: l.id, note: ta.value.trim() } });
          currentPlay.directorNotes = result.directorNotes;
        } catch (e) { /* toast deja affiche */ }
      }, 400);
      ta.addEventListener('input', saveNote);
      dirBox.appendChild(dirLabel); dirBox.appendChild(ta);
      card.appendChild(dirBox);

      const personal = notesForLine(l.id);
      if (personal.length) {
        const box2 = el('div', 'personal-notes-box');
        box2.appendChild(el('div', 'field-label', '📝 Notes personnelles des comédiens'));
        personal.forEach((p) => box2.appendChild(el('div', 'hint', `${p.name} : ${p.note}`)));
        card.appendChild(box2);
      }
      box.appendChild(card);
    });
  }
  // Export imprimable complet, reserve au metteur en scene/admin : texte de la piece,
  // remarques partagees et notes personnelles de chacun sur chaque replique.
  function exportDirectorNotesPdf() {
    if (!currentPlay) return;
    const parts = [];
    currentPlay.acts.forEach((a) => {
      parts.push(`<h2>${escapeHtml(a.title)}</h2>`);
      a.scenes.forEach((s) => {
        parts.push(`<h3>${escapeHtml(s.title)}</h3>`);
        s.lines.forEach((l) => {
          if (l.isStageDirection) { parts.push(`<p class="pdf-direction">(${escapeHtml(l.text)})</p>`); return; }
          parts.push(`<p class="pdf-line"><strong>${escapeHtml(l.character || '')}</strong> ${escapeHtml(l.text)}</p>`);
          const dirNote = currentPlay.directorNotes && currentPlay.directorNotes[l.id];
          if (dirNote) parts.push(`<p class="pdf-note pdf-note-director">🎬 Metteur en scène : ${escapeHtml(dirNote)}</p>`);
          notesForLine(l.id).forEach((p) => parts.push(`<p class="pdf-note">📝 ${escapeHtml(p.name)} : ${escapeHtml(p.note)}</p>`));
        });
      });
    });
    printHtmlDocument(currentPlay.title + ' — notes de mise en scène', parts.join('\n'));
  }
  // ================= Prononciation, preparation des voix, sauvegarde, import de fichier =================
  // ---- Dictionnaire de prononciation de la piece (admin / metteur en scene) ----
  function pronRow(from, to) {
    const row = el('div', 'pron-row');
    const a = document.createElement('input');
    a.type = 'text'; a.placeholder = 'Mot écrit'; a.value = from; a.maxLength = 60; a.setAttribute('aria-label', 'Mot écrit');
    const b = document.createElement('input');
    b.type = 'text'; b.placeholder = 'Se dit…'; b.value = to; b.maxLength = 100; b.setAttribute('aria-label', 'Se prononce');
    a.addEventListener('input', savePronunciationsDebounced);
    b.addEventListener('input', savePronunciationsDebounced);
    const test = el('button', 'btn btn-ghost btn-sm', '🔊');
    test.type = 'button'; test.title = 'Écouter';
    test.addEventListener('click', async () => {
      const text = (b.value || a.value).trim();
      if (!text || !currentPlay) return;
      try { await playOnce(text, currentPlay.characters[0]); } catch (e) { toast('Écoute impossible : ' + (e.message || 'voix indisponible')); }
    });
    const del = el('button', 'btn btn-ghost btn-sm', '✕');
    del.type = 'button'; del.title = 'Supprimer';
    del.addEventListener('click', () => { row.remove(); savePronunciations(); });
    row.appendChild(a); row.appendChild(el('span', 'pron-arrow', '→')); row.appendChild(b); row.appendChild(test); row.appendChild(del);
    return row;
  }
  function renderPronunciations() {
    const box = $('#pron-list');
    if (!box || !currentPlay) return;
    box.innerHTML = '';
    const entries = currentPlay.pronunciations || [];
    entries.forEach((e) => box.appendChild(pronRow(e.from, e.to)));
    if (!entries.length) box.appendChild(el('p', 'hint pron-empty', 'Aucun mot corrigé pour le moment.'));
  }
  async function savePronunciations() {
    if (!currentPlay) return;
    const entries = $all('#pron-list .pron-row').map((r) => {
      const inputs = r.querySelectorAll('input');
      return { from: inputs[0].value.trim(), to: inputs[1].value.trim() };
    }).filter((e) => e.from && e.to);
    try {
      const res = await api(`/api/plays/${currentPlay.id}/pronunciations`, { method: 'PUT', body: { entries } });
      currentPlay.pronunciations = res.pronunciations;
      refreshPregenStatus();
      renderOfflineAudioStatus();
    } catch (e) { /* toast deja affiche */ }
  }
  const savePronunciationsDebounced = debounce(savePronunciations, 900);

  // ---- Preparation des voix par le serveur (voir pregen.js) ----
  let pregenTimer = null;
  async function refreshPregenStatus() {
    clearTimeout(pregenTimer);
    const box = $('#pregen-status');
    if (!box || !currentPlay || !(isAdmin() || isDirector())) return;
    let st;
    try { st = (await api(`/api/plays/${currentPlay.id}/pregenerate`)).status; } catch (e) { return; }
    if (!st) box.textContent = "Voix du serveur : pas de préparation lancée depuis le dernier démarrage (elles se génèrent alors à la première écoute).";
    else if (st.running) box.textContent = `⏳ Préparation des voix du serveur : ${st.done}/${st.total} répliques…`;
    else box.textContent = `✓ Voix du serveur préparées (${st.done}/${st.total} répliques).` + (st.failed ? ` ⚠ ${st.failed} échec(s) : ${st.error || 'erreur'}` : '');
    if (st && st.running && activeScreenName === 'play') pregenTimer = setTimeout(refreshPregenStatus, 3000);
  }

  // ---- Sauvegarde (ecran comptes) ----
  async function renderBackupStatus() {
    const box = $('#backup-status');
    if (!box) return;
    try {
      const r = await api('/api/admin/backups');
      if (!r.backups.length) box.textContent = 'Aucune copie automatique pour le moment (la première est faite peu après le démarrage du serveur).';
      else box.textContent = `Dernière copie automatique : ${new Date(r.backups[0].modifiedAt).toLocaleString('fr-FR')} · ${r.backups.length} copie${r.backups.length > 1 ? 's' : ''} conservée${r.backups.length > 1 ? 's' : ''}.`;
    } catch (e) { box.textContent = ''; }
  }
  async function downloadBackup() {
    try {
      const res = await fetch(BASE + '/api/admin/backup', { headers: authHeaders() });
      if (!res.ok) throw new Error('Téléchargement impossible');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'repetito-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Sauvegarde téléchargée');
    } catch (e) { toast(e.message || 'Échec du téléchargement'); }
  }

  // ---- Import d'un fichier (texte, Word, PDF) : le texte est extrait dans le navigateur ----
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Un .docx est une archive ZIP : on lit son repertoire central pour retrouver word/document.xml.
  async function extractDocxText(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Ce fichier n'est pas un document Word (.docx) valide");
    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    let target = null;
    for (let n = 0; n < count; n++) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const csize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true), extraLen = view.getUint16(off + 30, true), commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
      if (name === 'word/document.xml') { target = { method, csize, localOff }; break; }
      off += 46 + nameLen + extraLen + commentLen;
    }
    if (!target) throw new Error('Contenu du document Word introuvable');
    const start = target.localOff + 30 + view.getUint16(target.localOff + 26, true) + view.getUint16(target.localOff + 28, true);
    const raw = bytes.subarray(start, start + target.csize);
    const xmlBytes = target.method === 0 ? raw : await inflateRaw(raw);
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(xmlBytes), 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paragraphs = [];
    for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
      let text = '';
      const walk = (node) => {
        for (const c of Array.from(node.childNodes)) {
          if (c.nodeType !== 1) continue;
          if (c.localName === 't') text += c.textContent;
          else if (c.localName === 'tab') text += '\t';
          else if (c.localName === 'br' || c.localName === 'cr') text += '\n';
          else walk(c);
        }
      };
      walk(p);
      paragraphs.push(text);
    }
    return paragraphs.join('\n');
  }
  // pdf.js (Apache 2.0, dossier public/vendor/pdfjs) n'est charge qu'au moment d'importer un PDF.
  async function extractPdfText(buffer) {
    const pdfjs = await import(BASE + '/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = BASE + '/vendor/pdfjs/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const lines = [];
      let current = '', lastY = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(current); current = ''; }
        current += item.str;
        if (item.hasEOL) { lines.push(current); current = ''; lastY = null; } else lastY = y;
      }
      if (current) lines.push(current);
      pages.push(lines.map((l) => l.replace(/\s+$/, '')).join('\n'));
    }
    return pages.join('\n');
  }
  async function importFileToText(file) {
    const name = file.name.toLowerCase();
    let text;
    if (name.endsWith('.docx')) text = await extractDocxText(await file.arrayBuffer());
    else if (name.endsWith('.pdf')) text = await extractPdfText(await file.arrayBuffer());
    else if (name.endsWith('.doc')) throw new Error("Ancien format Word (.doc) non géré : enregistre-le en .docx (Fichier → Enregistrer sous).");
    else text = await file.text();
    return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function updateRecordingsPanelText() {
    if (isAdmin()) {
      $('#recordings-panel-title').textContent = '🎙️ Voix réelles des comédiens';
      $('#recordings-panel-hint').textContent = "Enregistre la vraie voix d'un comédien sur ses répliques : les autres l'entendront à la place de la synthèse. Répliques non enregistrées → voix synthétique automatiquement.";
      $('#btn-goto-recordings').textContent = '🎙️ Gérer les enregistrements';
    } else {
      $('#recordings-panel-title').textContent = '🎙️ Ma voix réelle';
      $('#recordings-panel-hint').textContent = userState.selectedCharacters.length
        ? `Enregistre ta voix sur les répliques de ${userState.selectedCharacters.join(', ')} : la troupe l'entendra à la place de la synthèse.`
        : "Demande d'abord à l'administrateur de t'attribuer un personnage.";
      $('#btn-goto-recordings').textContent = '🎙️ Enregistrer mes répliques';
    }
  }
  // ---- Choix des scenes a telecharger pour l'audio hors-ligne ----
  // Selection memorisee par piece et par appareil ; par defaut : les scenes ou je joue
  // (ou toutes si aucun role ne m'est attribue).
  let offlineSelection = null;      // Set d'ids de scenes
  let offlineSelectionPlayId = null;
  let offlinePerScene = [];         // { act, scene, total, ok, stale, mine, mineCount } pour la piece courante
  let offlineLastStats = { count: 0, bytes: 0 };
  function offlineSceneStorageKey(playId) { return 'tr_offline_scenes_' + playId; }
  function defaultOfflineSelection() {
    const flat = allScenesFlat();
    const mine = flat.filter((f) => f.scene.lines.some((l) => !l.isStageDirection && isMine(l.character))).map((f) => f.scene.id);
    return new Set(mine.length ? mine : flat.map((f) => f.scene.id));
  }
  function loadOfflineSelection(playId) {
    const valid = new Set(allScenesFlat().map((f) => f.scene.id));
    try {
      const raw = JSON.parse(localStorage.getItem(offlineSceneStorageKey(playId)));
      if (Array.isArray(raw)) return new Set(raw.filter((id) => valid.has(id)));
    } catch (e) { /* pas de selection enregistree */ }
    return defaultOfflineSelection();
  }
  function saveOfflineSelection() {
    try { localStorage.setItem(offlineSceneStorageKey(offlineSelectionPlayId), JSON.stringify(Array.from(offlineSelection))); } catch (e) { /* tant pis */ }
  }
  function selectedOfflineLines(play) {
    const lines = [];
    play.acts.forEach((a) => a.scenes.forEach((s) => {
      if (!offlineSelection || !offlineSelection.has(s.id)) return;
      s.lines.forEach((l) => { if (!l.isStageDirection && spokenTextOnly(l.text)) lines.push(l); });
    }));
    return lines;
  }
  // Texte de synthese + libelle du bouton, calcules a partir de la selection courante.
  function updateOfflineSummary() {
    const { count, bytes } = offlineLastStats;
    const downloadBtn = $('#btn-download-offline-audio');
    const clearBtn = $('#btn-clear-offline-audio');
    const picked = offlinePerScene.filter((p) => offlineSelection.has(p.scene.id));
    const toDo = picked.reduce((n, p) => n + (p.total - p.ok), 0);
    const staleSel = picked.reduce((n, p) => n + p.stale, 0);
    const totalAll = offlinePerScene.reduce((n, p) => n + p.total, 0);
    const staleAll = offlinePerScene.reduce((n, p) => n + p.stale, 0);
    let text = count === 0 ? 'Aucun audio téléchargé pour cette pièce.' : `${count}/${totalAll} répliques disponibles hors-ligne (${formatBytes(bytes)}).`;
    if (staleAll) text += ` ${staleAll} utilisent une ancienne voix.`;
    $('#offline-audio-status').textContent = text;
    downloadBtn.disabled = false;
    if (!picked.length) { downloadBtn.textContent = '📥 Coche au moins une scène'; downloadBtn.disabled = true; }
    else if (!toDo) { downloadBtn.textContent = '✓ Les scènes cochées sont à jour'; downloadBtn.disabled = true; }
    else if (staleSel) downloadBtn.textContent = `📥 Mettre à jour avec les nouvelles voix (${toDo} répliques)`;
    else downloadBtn.textContent = `📥 Télécharger les scènes cochées (${toDo} répliques)`;
    clearBtn.classList.toggle('hidden', count === 0);
  }
  function renderOfflineSceneList() {
    const box = $('#offline-scene-list');
    box.innerHTML = '';
    let currentAct = null;
    offlinePerScene.forEach((p) => {
      if (p.act !== currentAct) { currentAct = p.act; box.appendChild(el('div', 'offline-act-title', p.act.title)); }
      const row = el('label', 'offline-scene-row' + (p.mine ? ' mine' : ''));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = offlineSelection.has(p.scene.id);
      cb.addEventListener('change', () => {
        if (cb.checked) offlineSelection.add(p.scene.id); else offlineSelection.delete(p.scene.id);
        saveOfflineSelection();
        updateOfflineSummary();
      });
      row.appendChild(cb);
      const info = el('span', 'offline-scene-info');
      info.appendChild(el('span', 'offline-scene-title', (p.mine ? '🎭 ' : '') + p.scene.title));
      info.appendChild(el('span', 'offline-scene-meta', `${p.total} répliques${p.mine ? ` · ${p.mineCount} à moi` : ''} · ⏱️ ${formatDuration(estimateSceneDurationSeconds(p.scene))}`));
      row.appendChild(info);
      let chip = '—', cls = '';
      if (p.total && p.ok === p.total) { chip = '✓ téléchargée'; cls = 'ok'; }
      else if (p.stale) { chip = `⚠ ${p.stale} ancienne(s) voix`; cls = 'stale'; }
      else if (p.ok) { chip = `${p.ok}/${p.total}`; cls = 'partial'; }
      row.appendChild(el('span', 'offline-scene-chip ' + cls, chip));
      box.appendChild(row);
    });
  }
  async function renderOfflineAudioStatus() {
    if (!currentPlay) return;
    const play = currentPlay;
    const playId = play.id;
    const stats = await offlineAudioStats(playId);
    const perScene = [];
    for (const { act, scene } of allScenesFlat()) {
      const lines = scene.lines.filter((l) => !l.isStageDirection && spokenTextOnly(l.text));
      let ok = 0, stale = 0;
      for (const l of lines) {
        const st = await offlineStatus(playId, l);
        if (st === 'ok') ok++; else if (st === 'stale') stale++;
      }
      const mineLines = lines.filter((l) => isMine(l.character));
      perScene.push({ act, scene, total: lines.length, ok, stale, mine: mineLines.length > 0, mineCount: mineLines.length });
    }
    if (!currentPlay || playId !== currentPlay.id) return; // la piece a change pendant l'attente
    offlinePerScene = perScene;
    offlineLastStats = stats;
    if (offlineSelectionPlayId !== playId || !offlineSelection) { offlineSelection = loadOfflineSelection(playId); offlineSelectionPlayId = playId; }
    $('#offline-scene-picker').classList.toggle('hidden', !perScene.length);
    renderOfflineSceneList();
    updateOfflineSummary();
  }
  async function renderSharePicker() {
    let troupes = [];
    try { troupes = await api('/api/troupes'); } catch (e) { troupes = []; }
    const sel = $('#share-troupe-select');
    sel.innerHTML = (isAdmin() ? '<option value="">— Aucune —</option>' : '') + troupes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    sel.value = currentPlay.troupeId || '';
    sel.onchange = async () => {
      try {
        const result = await api('/api/plays/' + currentPlay.id + '/troupe', { method: 'PUT', body: { troupeId: sel.value || null } });
        currentPlay.troupeId = result.troupeId;
        renderRoleAssignment();
      } catch (e) { sel.value = currentPlay.troupeId || ''; /* toast deja affiche */ }
    };
  }
  // Combobox generique : champ de recherche + liste filtrable, pour choisir un element
  // dans une liste qui peut devenir longue (comptes...) sans faire exploser la page.
  function createSearchableSelect({ items, getId, getLabel, currentId, placeholder, allowNone, noneLabel, onSelect }) {
    const wrap = el('div', 'combobox');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'combobox-input';
    input.placeholder = placeholder || 'Rechercher…';
    input.autocomplete = 'off';
    const list = el('div', 'combobox-options hidden');
    wrap.appendChild(input);
    wrap.appendChild(list);
    const labelOf = (id) => { const found = items.find((it) => getId(it) === id); return found ? getLabel(found) : ''; };
    input.value = currentId ? labelOf(currentId) : '';
    function renderOptions(filter) {
      list.innerHTML = '';
      const q = (filter || '').trim().toLowerCase();
      if (allowNone && (!q || (noneLabel || '').toLowerCase().includes(q))) {
        const opt = el('div', 'combobox-option combobox-option-none', noneLabel || 'Aucun');
        opt.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = ''; list.classList.add('hidden'); onSelect(null); });
        list.appendChild(opt);
      }
      const matches = items.filter((it) => getLabel(it).toLowerCase().includes(q));
      if (!matches.length) list.appendChild(el('div', 'combobox-option combobox-option-empty', 'Aucun résultat'));
      matches.forEach((it) => {
        const id = getId(it);
        const opt = el('div', 'combobox-option' + (id === currentId ? ' selected' : ''), getLabel(it));
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = getLabel(it);
          list.classList.add('hidden');
          onSelect(id);
        });
        list.appendChild(opt);
      });
      list.classList.remove('hidden');
    }
    input.addEventListener('focus', () => renderOptions(''));
    input.addEventListener('input', () => renderOptions(input.value));
    input.addEventListener('blur', () => { setTimeout(() => list.classList.add('hidden'), 150); });
    return wrap;
  }
  // Variante multi-selection (tags retirables + recherche pour en ajouter) : un compte
  // peut appartenir a plusieurs troupes.
  function createMultiSelect({ items, getId, getLabel, currentIds, placeholder, onChange }) {
    const wrap = el('div', 'combobox multiselect');
    const tags = el('div', 'multiselect-tags');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'combobox-input';
    input.placeholder = placeholder || 'Ajouter…';
    input.autocomplete = 'off';
    const list = el('div', 'combobox-options hidden');
    wrap.appendChild(tags);
    wrap.appendChild(input);
    wrap.appendChild(list);
    let selected = (currentIds || []).slice();
    function renderTags() {
      tags.innerHTML = '';
      selected.forEach((id) => {
        const it = items.find((x) => getId(x) === id);
        if (!it) return;
        const tag = el('button', 'chip selected multiselect-tag', getLabel(it) + ' ✕');
        tag.type = 'button';
        tag.addEventListener('click', () => {
          selected = selected.filter((x) => x !== id);
          renderTags();
          onChange(selected.slice());
        });
        tags.appendChild(tag);
      });
    }
    function renderOptions(filter) {
      list.innerHTML = '';
      const q = (filter || '').trim().toLowerCase();
      const candidates = items.filter((it) => !selected.includes(getId(it)) && getLabel(it).toLowerCase().includes(q));
      if (!candidates.length) list.appendChild(el('div', 'combobox-option combobox-option-empty', 'Aucun résultat'));
      candidates.forEach((it) => {
        const opt = el('div', 'combobox-option', getLabel(it));
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selected.push(getId(it));
          input.value = '';
          list.classList.add('hidden');
          renderTags();
          onChange(selected.slice());
        });
        list.appendChild(opt);
      });
      list.classList.remove('hidden');
    }
    input.addEventListener('focus', () => renderOptions(input.value));
    input.addEventListener('input', () => renderOptions(input.value));
    input.addEventListener('blur', () => { setTimeout(() => list.classList.add('hidden'), 150); });
    renderTags();
    return wrap;
  }
  function renderCharacterPicker() {
    const box = $('#character-picker');
    box.innerHTML = '';
    if (!userState.selectedCharacters.length) {
      box.appendChild(el('p', 'hint', "Aucun rôle attribué pour l'instant — demande à l'administrateur."));
      return;
    }
    userState.selectedCharacters.forEach((c) => {
      box.appendChild(el('span', 'chip selected chip-readonly', c));
    });
  }
  // ---- Distribution des roles (admin) : qui joue quel(s) personnage(s) ----
  // Vue par personnage (pas par utilisateur) : la liste de lignes depend du nombre de
  // personnages de la piece (generalement quelques-uns), pas du nombre de comptes --
  // reste gerable meme avec une troupe de 50 ou 100 comediens. Un personnage = un seul
  // comedien a la fois ; le champ de recherche filtre les comptes candidats.
  async function renderRoleAssignment() {
    const box = $('#role-assignment');
    if (!box) return;
    box.innerHTML = '';
    let users = [];
    try { users = await api('/api/users'); } catch (e) { return; }
    const troupeId = currentPlay.troupeId;
    const relevant = users.filter((u) => u.id === user.id || (troupeId && (u.troupeIds || []).includes(troupeId)));
    if (!relevant.length) { box.appendChild(el('p', 'hint', "Assigne d'abord la pièce à une troupe ci-dessus.")); return; }
    const roles = currentPlay.roles || {};
    const assignedTo = {};
    Object.entries(roles).forEach(([uid, chars]) => chars.forEach((c) => { assignedTo[c] = uid; }));
    currentPlay.characters.forEach((c) => {
      const row = el('div', 'role-row');
      row.appendChild(el('div', 'role-row-name', c));
      const combo = createSearchableSelect({
        items: relevant,
        getId: (u2) => u2.id,
        getLabel: (u2) => u2.name + (u2.role === 'admin' ? ' (admin)' : ''),
        currentId: assignedTo[c] || null,
        placeholder: 'Rechercher un compte…',
        allowNone: true,
        noneLabel: 'Non attribué',
        onSelect: async (userId) => {
          const previousUserId = assignedTo[c] || null;
          try {
            const result = await api(`/api/plays/${currentPlay.id}/roles`, { method: 'PUT', body: { character: c, userId } });
            currentPlay.roles = result.roles;
            if (userId === user.id || previousUserId === user.id) {
              userState.selectedCharacters = result.roles[user.id] || [];
              renderCharacterPicker(); renderSceneList(); updatePlayProgress();
            }
          } catch (e) { /* toast deja affiche */ }
          renderRoleAssignment();
        },
      });
      row.appendChild(combo);
      box.appendChild(row);
    });
  }
  // Ouvre le dialogue d'impression du navigateur sur un document HTML autonome, via une
  // iframe cachee plutot qu'un window.open : evite le blocage par les bloqueurs de popup
  // (window.open est parfois refuse meme depuis un clic direct selon le navigateur/webview).
  // L'utilisateur choisit ensuite "Enregistrer en PDF" dans la boite de dialogue.
  function printHtmlDocument(title, bodyHtml) {
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 800px; margin: 30px auto; padding: 0 24px; color: #222; }
  h1 { text-align: center; }
  h2 { margin-top: 32px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  h3 { margin-top: 20px; color: #555; font-weight: normal; font-style: italic; }
  .pdf-line { margin: 10px 0; line-height: 1.5; }
  .pdf-direction { margin: 6px 0 6px 20px; font-style: italic; color: #666; }
  .pdf-note { margin: 2px 0 12px 20px; font-style: italic; color: #a3235a; font-size: 0.9em; }
  .pdf-note-director { color: #6a1b9a; font-weight: bold; }
  @media print { body { margin: 0; padding: 0 15px; } }
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body></html>`;
    const old = document.getElementById('pdf-export-frame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'pdf-export-frame';
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    document.body.appendChild(frame);
    frame.contentWindow.document.open();
    frame.contentWindow.document.write(html);
    frame.contentWindow.document.close();
    setTimeout(() => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* ignore */ }
    }, 300);
  }
  // Export imprimable du texte complet de la piece, avec les notes personnelles de
  // l'utilisateur courant et les remarques du metteur en scene (visibles par toute la troupe).
  function exportPlayPdf() {
    if (!currentPlay) return;
    const parts = [];
    currentPlay.acts.forEach((a) => {
      parts.push(`<h2>${escapeHtml(a.title)}</h2>`);
      a.scenes.forEach((s) => {
        parts.push(`<h3>${escapeHtml(s.title)}</h3>`);
        s.lines.forEach((l) => {
          if (l.isStageDirection) {
            parts.push(`<p class="pdf-direction">(${escapeHtml(l.text)})</p>`);
            return;
          }
          parts.push(`<p class="pdf-line"><strong>${escapeHtml(l.character || '')}</strong> ${escapeHtml(l.text)}</p>`);
          const dirNote = currentPlay.directorNotes && currentPlay.directorNotes[l.id];
          if (dirNote) parts.push(`<p class="pdf-note pdf-note-director">🎬 Metteur en scène : ${escapeHtml(dirNote)}</p>`);
          const note = userState.annotations[l.id];
          if (note) parts.push(`<p class="pdf-note">🎭 ${escapeHtml(note)}</p>`);
        });
      });
    });
    printHtmlDocument(currentPlay.title, parts.join('\n'));
  }
  function sceneStatus(scene) {
    const mineLines = scene.lines.filter((l) => !l.isStageDirection && isMine(l.character));
    if (!mineLines.length) return 'na';
    const statuses = mineLines.map((l) => userState.progress[l.id] || 'none');
    if (statuses.every((s) => s === 'acquise')) return 'done';
    if (statuses.every((s) => s === 'none')) return 'none';
    return 'progress';
  }
  // Estimation de la duree d'une scene a voix haute : somme des mots des repliques
  // (didascalies exclues, elles ne sont pas dites) au rythme regle en mode audio
  // (#audio-wpm), plus une seconde par replique pour la respiration/l'echange entre
  // comediens. Volontairement distincte d'estimateSpeakingSeconds (pas de plancher de 3s
  // ni de marge par replique) : ces a-coups n'ont de sens que pour une seule reprise
  // automatique, pas pour additionner la duree de toute une piece.
  function estimateSceneDurationSeconds(scene) {
    const wpm = parseInt($('#audio-wpm').value, 10) || 130;
    let words = 0, lineCount = 0;
    scene.lines.forEach((l) => {
      if (l.isStageDirection) return;
      words += (spokenTextOnly(l.text).match(/\S+/g) || []).length;
      lineCount++;
    });
    return Math.round((words / wpm) * 60 + lineCount);
  }
  function formatDuration(sec) {
    const min = Math.round(sec / 60);
    if (min < 1) return '< 1 min';
    if (min < 60) return '~' + min + ' min';
    const h = Math.floor(min / 60), m = min % 60;
    return '~' + h + 'h' + (m ? String(m).padStart(2, '0') : '');
  }
  function renderSceneList() {
    const box = $('#scene-list');
    box.innerHTML = '';
    let totalSec = 0;
    currentPlay.acts.forEach((a) => {
      const block = el('div', 'act-block');
      block.appendChild(el('div', 'act-title', a.title));
      a.scenes.forEach((s) => {
        const status = sceneStatus(s);
        const mineCount = s.lines.filter((l) => !l.isStageDirection && isMine(l.character)).length;
        const durationSec = estimateSceneDurationSeconds(s);
        totalSec += durationSec;
        const row = el('div', 'scene-row');
        row.innerHTML = `<div class="dot status-${status}"></div>
          <div class="scene-info"><div class="title">${escapeHtml(s.title)}</div>
          <div class="sub">${s.lines.length} lignes${mineCount ? ` · ${mineCount} à moi` : ''} · ⏱️ ${formatDuration(durationSec)}</div></div>`;
        row.addEventListener('click', () => { revSceneKey = s.id; renderRevision(); showScreen('revision'); });
        block.appendChild(row);
      });
      box.appendChild(block);
    });
    $('#play-duration-total').textContent = currentPlay.acts.length
      ? `⏱️ Durée totale estimée à voix haute : ${formatDuration(totalSec)} (au rythme réglé en mode audio)`
      : '';
  }
  // ---- Recherche de texte dans toute la piece ----
  // Recherche cote client (pas d'appel serveur) : la piece entiere est deja chargee en
  // memoire (currentPlay), donc une simple recherche de sous-chaine sur chaque replique
  // suffit, meme pour des pieces de plusieurs centaines de repliques.
  function searchPlayLines(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results = [];
    currentPlay.acts.forEach((a) => a.scenes.forEach((s) => s.lines.forEach((l) => {
      if (!l.text) return;
      const idx = l.text.toLowerCase().indexOf(q);
      if (idx !== -1) results.push({ act: a, scene: s, line: l, idx });
    })));
    return results;
  }
  function renderPlaySearchResults(query) {
    const box = $('#play-search-results');
    box.innerHTML = '';
    if (!query.trim()) return;
    const results = searchPlayLines(query);
    if (!results.length) { box.appendChild(el('p', 'hint', 'Aucun résultat.')); return; }
    const qLen = query.trim().length;
    const canDirectorNotes = isAdmin() || isDirector();
    results.slice(0, 40).forEach(({ act, scene, line, idx }) => {
      const before = (idx > 30 ? '…' : '') + line.text.slice(Math.max(0, idx - 30), idx);
      const match = line.text.slice(idx, idx + qLen);
      const after = line.text.slice(idx + qLen, idx + qLen + 30) + (idx + qLen + 30 < line.text.length ? '…' : '');
      const row = el('div', 'search-result-row');
      row.innerHTML = `<div class="search-result-meta">${escapeHtml(act.title)} · ${escapeHtml(scene.title)}${line.character ? ' · ' + escapeHtml(line.character) : ''}</div>
        <div class="search-result-snippet">${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}</div>
        <div class="search-result-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-dest="revision">📖 Révision</button>
          <button type="button" class="btn btn-ghost btn-sm" data-dest="audio">🔊 Audio</button>
          ${canDirectorNotes && !line.isStageDirection ? '<button type="button" class="btn btn-ghost btn-sm" data-dest="director">🎬 Notes de m.e.s.</button>' : ''}
        </div>`;
      row.querySelector('[data-dest="revision"]').addEventListener('click', () => jumpToSearchResultRevision(scene, line));
      row.querySelector('[data-dest="audio"]').addEventListener('click', () => jumpToSearchResultAudio(scene, line));
      const dirBtn = row.querySelector('[data-dest="director"]');
      if (dirBtn) dirBtn.addEventListener('click', () => jumpToSearchResultDirectorNotes(scene, line));
      box.appendChild(row);
    });
    if (results.length > 40) box.appendChild(el('p', 'hint', `+ ${results.length - 40} autres résultats — précise ta recherche.`));
  }
  // Attend qu'une carte apparaisse dans le DOM (rendue de facon asynchrone selon l'ecran
  // cible) puis la fait defiler dans la vue avec un bref surlignage, pour montrer
  // precisement la replique trouvee par la recherche plutot que juste la scene.
  function scrollToAndHighlight(selector) {
    requestAnimationFrame(() => {
      const card = $(selector);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('search-highlight');
      setTimeout(() => card.classList.remove('search-highlight'), 2000);
    });
  }
  // Ouvre le mode revision sur la scene trouvee et revele/scrolle jusqu'a la replique
  // exacte (meme si c'est normalement une replique masquee), puisque l'utilisateur la
  // cherchait deliberement.
  function jumpToSearchResultRevision(scene, line) {
    revSceneKey = scene.id;
    fillSceneSelect($('#rev-scene-select'), revSceneKey);
    revRevealed.clear();
    revRevealed.add(line.id);
    renderRevLines(findSceneByKey(revSceneKey));
    showScreen('revision');
    scrollToAndHighlight('#rev-lines [data-line-id="' + line.id + '"]');
  }
  // Meme principe pour le mode audio : change de scene si besoin, affiche la liste, puis
  // reutilise jumpToLine (comme un clic sur la ligne) pour se positionner et lancer la
  // lecture a cet endroit precis.
  async function jumpToSearchResultAudio(scene, line) {
    audioSceneKey = scene.id;
    fillSceneSelect($('#audio-scene-select'), audioSceneKey);
    clearAudioLoop();
    showScreen('audio');
    await renderAudioLines(scene);
    jumpToLine(line.id);
  }
  // Et pour les notes de mise en scene (admin/metteur en scene) : ouvre l'ecran dedie sur
  // la bonne scene et scrolle jusqu'a la replique (les didascalies n'y sont pas listees).
  async function jumpToSearchResultDirectorNotes(scene, line) {
    dnSceneKey = scene.id;
    pushScreen('directornotes');
    await renderDirectorNotesScreen();
    scrollToAndHighlight('#dn-lines [data-line-id="' + line.id + '"]');
  }
  function updatePlayProgress() {
    const { pct } = computeOverallProgress();
    $('#play-progress-pct').textContent = pct + '%';
    $('#play-progress-fill').style.width = pct + '%';
  }

  // Voix serveur (Piper, open source, meme rendu pour tout le monde). Les voix
  // du navigateur ne servent plus que de secours si le serveur ne repond pas. L'ordre
  // alterne homme/femme : c'est celui des voix attribuees par defaut aux personnages.
  const PIPER_VOICES = [
    { id: 'tom', label: 'Tom — homme' },
    { id: 'siwis', label: 'Siwis — femme' },
    { id: 'pierre', label: 'Pierre — homme' },
    { id: 'jessica', label: 'Jessica — femme' },
    { id: 'gilles', label: 'Gilles — homme' },
  ];
  // Anciens identifiants deja enregistres dans les reglages (memes correspondances que cote serveur).
  const LEGACY_VOICE_IDS = { melo_tres_grave: 'tom', melo_grave: 'pierre', melo_medium: 'siwis', melo_aigue: 'jessica', melo_tres_aigue: 'gilles' };
  function currentVoiceId(character) {
    const saved = userState.voices[character];
    return LEGACY_VOICE_IDS[saved] || saved || defaultVoiceId(character);
  }
  function defaultVoiceId(character) {
    const idx = currentPlay ? currentPlay.characters.indexOf(character) : -1;
    return PIPER_VOICES[idx >= 0 ? idx % PIPER_VOICES.length : 0].id;
  }
  let availableVoices = [];
  function loadVoices() {
    availableVoices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  }
  function renderVoicePicker() {
    const box = $('#voice-picker');
    box.innerHTML = '';
    if (!currentPlay) return;
    currentPlay.characters.forEach((c) => {
      const row = el('div', 'voice-row');
      const span = el('span', null, c);
      const select = document.createElement('select');
      select.dataset.char = c;
      const current = currentVoiceId(c);
      PIPER_VOICES.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.id; opt.textContent = v.label;
        if (current === v.id) opt.selected = true;
        select.appendChild(opt);
      });
      row.appendChild(span); row.appendChild(select);
      box.appendChild(row);
    });
  }

  // ================= Ecran : révision =================
  let revSceneKey = null;
  const revRevealed = new Set();
  function ensureRevSceneKey() {
    if (revSceneKey && findSceneByKey(revSceneKey)) return;
    const saved = currentPlay ? loadLastPos(currentPlay.id).revSceneKey : null;
    if (saved && findSceneByKey(saved)) { revSceneKey = saved; return; }
    const flat = allScenesFlat();
    revSceneKey = flat.length ? flat[0].scene.id : null;
  }
  function renderRevision() {
    if (!currentPlay) return;
    ensureRevSceneKey();
    revRevealed.clear();
    if (!revSceneKey) { $('#rev-lines').innerHTML = '<p class="hint">Cette pièce ne contient aucune scène.</p>'; return; }
    fillSceneSelect($('#rev-scene-select'), revSceneKey);
    renderRevLines(findSceneByKey(revSceneKey));
  }
  function renderRevLines(found) {
    if (!found) return;
    const { act, scene } = found;
    if (currentPlay) saveLastPos(currentPlay.id, { revSceneKey: scene.id });
    const box = $('#rev-lines');
    box.innerHTML = '';
    const hideOthers = $('#rev-hide-others').checked;
    const partner = $('#rev-partner-mode').checked;
    scene.lines.forEach((l, li) => {
      box.appendChild(renderLineCard(l, { actTitle: act.title, sceneTitle: scene.title, index: li + 1, total: scene.lines.length, hideOthers, partner }));
    });
  }
  // Mode partenaire : deux gros boutons par replique du comedien (✓ juste / ✗ a revoir), qui
  // enregistrent sa progression. Aucun defilement automatique : le partenaire avance a son rythme.
  function renderVerdictRow(l, card) {
    const row = el('div', 'verdict-row');
    const ko = el('button', 'verdict-btn verdict-btn-ko', '✗ À revoir');
    const ok = el('button', 'verdict-btn verdict-btn-ok', '✓ Juste');
    ko.type = 'button'; ok.type = 'button';
    const paint = () => {
      const st = userState.progress[l.id];
      card.classList.toggle('verdict-ok', st === 'acquise');
      card.classList.toggle('verdict-ko', st === 'a_revoir');
      ok.classList.toggle('active', st === 'acquise');
      ko.classList.toggle('active', st === 'a_revoir');
    };
    const set = (st) => {
      if (userState.progress[l.id] === st) delete userState.progress[l.id]; else userState.progress[l.id] = st;
      saveState();
      paint();
      updatePlayProgress();
      renderSceneList();
    };
    ko.addEventListener('click', () => set('a_revoir'));
    ok.addEventListener('click', () => set('acquise'));
    row.appendChild(ko); row.appendChild(ok);
    paint();
    return row;
  }
  function renderLineCard(l, opts) {
    const card = el('div', 'line-card');
    if (l.isStageDirection) {
      card.classList.add('direction');
      card.dataset.lineId = l.id;
      card.textContent = '(' + l.text + ')';
      return card;
    }
    const mine = isMine(l.character);
    if (mine) card.classList.add('mine');
    card.dataset.lineId = l.id;

    card.appendChild(el('div', 'line-meta', `${opts.actTitle} · ${opts.sceneTitle} · réplique ${opts.index}/${opts.total}`));
    if (l.character) card.appendChild(el('div', 'character-name', l.character));

    // Mode partenaire : tout est affiche en clair (la personne qui ecoute lit mon texte).
    const shouldHide = !opts.partner && (mine || (opts.hideOthers && l.character));
    if (shouldHide) {
      const revealed = revRevealed.has(l.id);
      const reveal = revealed
        ? elHTML('div', 'reveal-area revealed', renderInlineText(l.text))
        : el('div', 'reveal-area', mine ? 'Ta réplique — touche pour révéler' : 'Touche pour révéler');
      reveal.addEventListener('click', () => {
        if (revRevealed.has(l.id)) revRevealed.delete(l.id); else revRevealed.add(l.id);
        renderRevLines(findSceneByKey(revSceneKey));
      });
      card.appendChild(reveal);
    } else {
      card.appendChild(elHTML('div', 'line-text', renderInlineText(l.text)));
    }

    // Remarque du metteur en scene : partagee par toute la troupe (contrairement a la
    // note personnelle ci-dessous), donc affichee a tous, meme sur les repliques des autres.
    const dirNote = currentPlay.directorNotes && currentPlay.directorNotes[l.id];
    if (dirNote) card.appendChild(el('div', 'director-note', '🎬 ' + dirNote));

    if (mine && opts.partner) {
      card.appendChild(renderVerdictRow(l, card));
    } else if (mine) {
      const annBox = el('div', 'annotation-box');
      const hasNote = !!userState.annotations[l.id];
      const toggle = el('button', 'annotation-toggle', hasNote ? '📝 Note de mise en scène (modifier)' : '📝 Ajouter une note de mise en scène');
      toggle.type = 'button';
      const ta = document.createElement('textarea');
      ta.placeholder = 'Déplacement, geste, regard, intention…';
      ta.value = userState.annotations[l.id] || '';
      ta.classList.toggle('hidden', !hasNote);
      toggle.addEventListener('click', () => { ta.classList.toggle('hidden'); if (!ta.classList.contains('hidden')) ta.focus(); });
      const saveNote = debounce(() => {
        const v = ta.value.trim();
        if (v) userState.annotations[l.id] = v; else delete userState.annotations[l.id];
        saveState();
      }, 400);
      ta.addEventListener('input', saveNote);
      annBox.appendChild(toggle); annBox.appendChild(ta);
      card.appendChild(annBox);

      const statusRow = el('div', 'status-row');
      ['a_revoir', 'en_cours', 'acquise'].forEach((st) => {
        const b = el('button', 'status-btn st-' + st + (userState.progress[l.id] === st ? ' active' : ''), STATUS_LABELS[st]);
        b.type = 'button';
        b.addEventListener('click', () => {
          if (userState.progress[l.id] === st) delete userState.progress[l.id];
          else userState.progress[l.id] = st;
          saveState();
          statusRow.querySelectorAll('.status-btn').forEach((btn) => btn.classList.remove('active'));
          if (userState.progress[l.id]) statusRow.querySelector('.st-' + userState.progress[l.id]).classList.add('active');
          updatePlayProgress();
          renderSceneList();
        });
        statusRow.appendChild(b);
      });
      card.appendChild(statusRow);
    }
    return card;
  }
  function stepRevScene(delta) {
    const flat = allScenesFlat();
    const idx = flat.findIndex((f) => f.scene.id === revSceneKey);
    const next = flat[idx + delta];
    if (!next) { toast(delta > 0 ? 'Dernière scène' : 'Première scène'); return; }
    revSceneKey = next.scene.id;
    revRevealed.clear();
    $('#rev-scene-select').value = revSceneKey;
    renderRevLines(next);
  }

  // ================= Ecran : audio =================
  let audioSceneKey = null;
  let audioIndex = -1;
  let audioPlaying = false;
  let audioTimerHandle = null;
  let audioRevealed = new Set(); // ids des repliques demasquees manuellement (cf. cases "cacher")
  let loopStart = null, loopEnd = null; // index de repliques (scene courante) pour boucler un passage

  function clearAudioLoop() {
    loopStart = null; loopEnd = null;
    $('#audio-loop-clear').classList.add('hidden');
    $('#audio-loop-status').classList.add('hidden');
  }
  function updateAudioLoopStatus() {
    const status = $('#audio-loop-status');
    if (loopStart != null && loopEnd != null) {
      status.textContent = `🔁 Boucle active : répliques ${loopStart + 1} à ${loopEnd + 1}`;
      status.classList.remove('hidden');
      $('#audio-loop-clear').classList.remove('hidden');
    } else if (loopStart != null) {
      status.textContent = `🔁 Début marqué à la réplique ${loopStart + 1} — marque la fin`;
      status.classList.remove('hidden');
    } else {
      status.classList.add('hidden');
      $('#audio-loop-clear').classList.add('hidden');
    }
  }

  function renderAudioScene() {
    if (!currentPlay) return;
    clearAudioLoop();
    const saved = loadLastPos(currentPlay.id);
    if (!audioSceneKey || !findSceneByKey(audioSceneKey)) {
      audioSceneKey = (saved.audioSceneKey && findSceneByKey(saved.audioSceneKey)) ? saved.audioSceneKey : null;
      if (!audioSceneKey) {
        const flat = allScenesFlat();
        audioSceneKey = flat.length ? flat[0].scene.id : null;
      }
    }
    audioRevealed.clear();
    stopAudioPlayback(); // remet audioIndex a -1 : reapplique juste apres si on revient sur la meme scene
    const found = findSceneByKey(audioSceneKey);
    if (found && saved.audioSceneKey === audioSceneKey && typeof saved.audioIndex === 'number' && saved.audioIndex >= 0 && saved.audioIndex < found.scene.lines.length) {
      audioIndex = saved.audioIndex;
    }
    if (!audioSceneKey) { $('#audio-lines').innerHTML = '<p class="hint">Cette pièce ne contient aucune scène.</p>'; return; }
    fillSceneSelect($('#audio-scene-select'), audioSceneKey);
    renderAudioLines(found.scene).then(() => {
      if (audioIndex >= 0) highlightAudioLine(found.scene.lines[audioIndex].id);
    });
  }
  // { activeId, takes: [...] } par replique -> la prise actuellement utilisee (ou null).
  function activeTake(entry) {
    if (!entry || !entry.activeId) return null;
    return (entry.takes || []).find((t) => t.id === entry.activeId) || null;
  }
  async function renderAudioLines(scene) {
    if (currentPlay) saveLastPos(currentPlay.id, { audioSceneKey: scene.id });
    const box = $('#audio-lines');
    box.innerHTML = '';
    let recordings = {};
    try { recordings = await api('/api/recordings/' + currentPlay.id); } catch (e) { /* tant pis, pas de repere */ }
    const hideMine = $('#audio-hide-mine').checked;
    const hideOthers = $('#audio-hide-others').checked;
    scene.lines.forEach((l, li) => {
      const mine = isMine(l.character);
      const card = el('div', 'line-card' + (l.isStageDirection ? ' direction' : '') + (mine ? ' mine' : ''));
      card.dataset.lineId = l.id;
      if (l.isStageDirection) { card.textContent = '(' + l.text + ')'; box.appendChild(card); return; }
      card.appendChild(el('div', 'line-meta', `réplique ${li + 1}/${scene.lines.length}`));
      if (l.character) {
        const active = activeTake(recordings[l.id]);
        const nameLine = el('div', 'character-name', l.character);
        if (active) nameLine.appendChild(el('span', 'hint', ' 🎙️ voix de ' + active.recordedByName));
        card.appendChild(nameLine);
      }
      const shouldHide = l.character && ((mine && hideMine) || (!mine && hideOthers));
      if (shouldHide) {
        const revealed = audioRevealed.has(l.id);
        const reveal = revealed
          ? elHTML('div', 'reveal-area revealed', renderInlineText(l.text))
          : el('div', 'reveal-area', mine ? 'Ta réplique — touche pour révéler' : 'Touche pour révéler');
        reveal.addEventListener('click', (e) => {
          e.stopPropagation(); // ne doit pas aussi faire sauter la lecture a cette ligne
          if (audioRevealed.has(l.id)) audioRevealed.delete(l.id); else audioRevealed.add(l.id);
          renderAudioLines(scene);
        });
        card.appendChild(reveal);
      } else {
        card.appendChild(elHTML('div', 'line-text', renderInlineText(l.text)));
      }
      box.appendChild(card);
    });
  }
  function stepAudioScene(delta) {
    const flat = allScenesFlat();
    const idx = flat.findIndex((f) => f.scene.id === audioSceneKey);
    const next = flat[idx + delta];
    if (!next) { toast(delta > 0 ? 'Dernière scène' : 'Première scène'); return; }
    audioSceneKey = next.scene.id;
    $('#audio-scene-select').value = audioSceneKey;
    stopAudioPlayback();
    clearAudioLoop();
    renderAudioLines(next.scene);
  }
  function highlightAudioLine(lineId) {
    $all('#audio-lines .line-card').forEach((c) => c.classList.toggle('current', c.dataset.lineId === lineId));
    const cur = $all('#audio-lines .line-card').find((c) => c.dataset.lineId === lineId);
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ================= Audio hors-ligne (telecharge a la demande, stocke dans le navigateur) =================
  // Cache separe de celui du service worker : jamais nettoye automatiquement, uniquement
  // par l'utilisateur (bouton "Supprimer"). Cle synthetique (jamais fetchee sur le reseau,
  // seulement lue/ecrite via l'API Cache) : /__offline-audio/<pieceId>/<repliqueId>.
  const OFFLINE_AUDIO_CACHE = 'repetito-audio-v1';
  function offlineAudioKey(playId, lineId) { return '/__offline-audio/' + playId + '/' + lineId; }
  function formatBytes(n) {
    if (!n) return '0 Ko';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' Ko';
    return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  }
  // Chaque fichier hors-ligne porte la voix qui l'a genere (en-tete X-Voice ; "rec" pour un
  // vrai enregistrement de comedien). Si la voix du personnage change, ou si le moteur vocal
  // change (TTS_VERSION), le fichier est "perime" : il est re-telecharge par « Mettre a jour »
  // et n'est plus prefere a la synthese du serveur quand on est en ligne. Les fichiers
  // anciens, sans en-tete, sont consideres comme perimes.
  const TTS_VERSION = 'piper2';
  function ttsStamp(character, ttsInput) { return currentVoiceId(character) + '|' + TTS_VERSION + '|' + hashText(ttsInput); }
  function isStaleOffline(res, character, ttsInput) {
    const stamp = res.headers.get('X-Voice') || '';
    if (stamp === 'rec') return false;
    if (!(res.headers.get('Content-Type') || '').startsWith('audio/mpeg')) return false; // enregistrement de comedien
    return stamp !== ttsStamp(character, ttsInput);
  }
  async function getOfflineAudio(playId, lineId, character, ttsInput) {
    if (!window.caches) return null;
    try {
      const cache = await caches.open(OFFLINE_AUDIO_CACHE);
      const res = await cache.match(offlineAudioKey(playId, lineId));
      if (!res) return null;
      return { buf: await res.arrayBuffer(), type: res.headers.get('Content-Type') || 'audio/mpeg', stale: isStaleOffline(res, character, ttsInput) };
    } catch (e) { return null; }
  }
  // 'missing' (a telecharger), 'stale' (voix changee : a re-telecharger) ou 'ok'.
  async function offlineStatus(playId, line) {
    if (!window.caches) return 'missing';
    try {
      const cache = await caches.open(OFFLINE_AUDIO_CACHE);
      const res = await cache.match(offlineAudioKey(playId, line.id));
      if (!res) return 'missing';
      return isStaleOffline(res, line.character, ttsText(line.text)) ? 'stale' : 'ok';
    } catch (e) { return 'missing'; }
  }
  async function putOfflineAudio(playId, lineId, arrayBuf, mimeType, stamp) {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
    await cache.put(offlineAudioKey(playId, lineId), new Response(arrayBuf, {
      headers: { 'Content-Type': mimeType, 'Content-Length': String(arrayBuf.byteLength), 'X-Voice': stamp },
    }));
  }
  function speakableLines(play) {
    const lines = [];
    play.acts.forEach((a) => a.scenes.forEach((s) => s.lines.forEach((l) => {
      if (!l.isStageDirection && spokenTextOnly(l.text)) lines.push(l);
    })));
    return lines;
  }
  // Taille lue depuis l'en-tete Content-Length (pas besoin de relire chaque fichier entier).
  async function offlineAudioStats(playId) {
    if (!window.caches) return { count: 0, bytes: 0 };
    try {
      const cache = await caches.open(OFFLINE_AUDIO_CACHE);
      const keys = await cache.keys();
      const prefix = offlineAudioKey(playId, '');
      let count = 0, bytes = 0;
      for (const k of keys) {
        if (!new URL(k.url).pathname.startsWith(prefix)) continue;
        const res = await cache.match(k);
        count++;
        bytes += parseInt((res && res.headers.get('Content-Length')) || '0', 10);
      }
      return { count, bytes };
    } catch (e) { return { count: 0, bytes: 0 }; }
  }
  async function clearOfflineAudio(playId) {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
    const keys = await cache.keys();
    const prefix = offlineAudioKey(playId, '');
    await Promise.all(keys.filter((k) => new URL(k.url).pathname.startsWith(prefix)).map((k) => cache.delete(k)));
  }
  let offlineDownloadCancelled = false;
  // onProgress(done, totalLines, failed, estimatedTotalBytes) : l'estimation est calculee
  // une fois, a partir des toutes premieres repliques telechargees dans cette session,
  // puis affichee telle quelle (le compteur reel, lui, grossit ensuite ligne par ligne).
  async function downloadOfflineAudio(play, onProgress, onlyLines) {
    offlineDownloadCancelled = false;
    const lines = onlyLines || speakableLines(play);
    const toFetch = [];
    for (const l of lines) { if ((await offlineStatus(play.id, l)) !== 'ok') toFetch.push(l); }
    let done = lines.length - toFetch.length, failed = 0;
    let sampleBytes = 0, sampleCount = 0, estimatedTotal = null;
    const SAMPLE_SIZE = Math.min(5, toFetch.length);
    for (let i = 0; i < toFetch.length; i++) {
      if (offlineDownloadCancelled) break;
      const l = toFetch[i];
      try {
        const recRes = await fetch(`${BASE}/api/recordings/${play.id}/${l.id}`, { headers: authHeaders() });
        let buf, mime, stamp;
        if (recRes.ok) { buf = await recRes.arrayBuffer(); mime = 'audio/webm'; stamp = 'rec'; }
        else {
          const spoken = ttsText(l.text);
          const voiceId = currentVoiceId(l.character);
          buf = await fetchTtsBuffer(spoken, voiceId);
          mime = 'audio/mpeg';
          stamp = ttsStamp(l.character, spoken);
        }
        await putOfflineAudio(play.id, l.id, buf, mime, stamp);
        sampleBytes += buf.byteLength;
        sampleCount++;
      } catch (e) { failed++; }
      done++;
      if (estimatedTotal === null && sampleCount >= SAMPLE_SIZE && sampleCount > 0) {
        estimatedTotal = Math.round((sampleBytes / sampleCount) * toFetch.length);
      }
      onProgress(done, lines.length, failed, estimatedTotal);
    }
    const stats = await offlineAudioStats(play.id);
    return { total: lines.length, failed, bytes: stats.bytes };
  }
  let audioGeneration = 0;
  let currentTtsAudio = null;
  function speakLineBrowser(spoken, onEnd) {
    if (!window.speechSynthesis) { onEnd(); return; }
    const u = new SpeechSynthesisUtterance(spoken);
    u.lang = 'fr-FR';
    u.rate = parseFloat($('#audio-rate').value) || 1;
    const fr = availableVoices.find((v) => v.lang && v.lang.toLowerCase().startsWith('fr'));
    if (fr) u.voice = fr;
    u.onend = onEnd;
    u.onerror = onEnd;
    window.speechSynthesis.speak(u);
  }
  async function fetchTtsBuffer(text, voiceId, attempt) {
    try {
      const res = await fetch(BASE + '/api/tts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ text, voice: voiceId }),
      });
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = j.detail || j.error || ''; } catch (e2) { /* corps non JSON */ }
        throw new Error(detail || ('erreur ' + res.status));
      }
      return await res.arrayBuffer();
    } catch (e) {
      // Reseau mobile parfois instable (tunnel, connexion faible) : une seconde tentative
      // suffit souvent avant de basculer sur la voix de secours du navigateur.
      if (!attempt) return fetchTtsBuffer(text, voiceId, 1);
      throw e;
    }
  }
  // Voix serveur (Piper) en priorite pour un rendu identique sur tous les appareils ;
  // repli sur la voix du navigateur si le serveur echoue. Lecture via <audio> (element
  // natif) plutot que l'API Web Audio : plus fiable sur mobile pour ce type de flux.
  let ttsFailureShown = false;
  async function speakLine(l, onEnd, staleOffline) {
    const spoken = spokenTextOnly(l.text);
    if (!spoken) { onEnd(); return; }
    const gen = audioGeneration;
    const voiceId = currentVoiceId(l.character);
    try {
      const arrayBuf = await fetchTtsBuffer(ttsText(l.text), voiceId);
      if (gen !== audioGeneration) return;
      const url = URL.createObjectURL(new Blob([arrayBuf], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      audio.playbackRate = parseFloat($('#audio-rate').value) || 1;
      currentTtsAudio = audio;
      audio.onended = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
      audio.onerror = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
      await audio.play();
    } catch (e) {
      if (gen !== audioGeneration) return;
      if (!ttsFailureShown) {
        ttsFailureShown = true;
        toast('Voix du serveur indisponible (' + (e.message || 'erreur') + ') : voix du téléphone utilisée', 6000);
      }
      if (staleOffline) {
        // Serveur injoignable : mieux vaut l'ancien fichier hors-ligne que la voix du telephone.
        const url = URL.createObjectURL(new Blob([staleOffline.buf], { type: staleOffline.type }));
        const audio = new Audio(url);
        audio.playbackRate = parseFloat($('#audio-rate').value) || 1;
        currentTtsAudio = audio;
        audio.onended = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
        audio.onerror = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
        audio.play().catch(() => speakLineBrowser(spoken, onEnd));
        return;
      }
      speakLineBrowser(spoken, onEnd);
    }
  }
  // Lecture ponctuelle independante de la sequence principale (bouton "Ecouter cette
  // replique" sur l'ecran de mon tour). Coupe toute lecture ponctuelle precedente pour
  // eviter que deux sources se superposent et produisent un son sature/grésillant.
  let previewAudio = null;
  async function playOnce(text, character, lineId) {
    if (previewAudio) { try { previewAudio.pause(); } catch (e) { /* ignore */ } previewAudio = null; }
    const found = lineId && currentPlay ? await getOfflineAudio(currentPlay.id, lineId, character, text) : null;
    const offline = found && (!found.stale || !navigator.onLine) ? found : null; // voix perimee : on prefere la synthese actuelle si en ligne
    const arrayBuf = offline ? offline.buf : await fetchTtsBuffer(text, currentVoiceId(character));
    const url = URL.createObjectURL(new Blob([arrayBuf], { type: offline ? offline.type : 'audio/mpeg' }));
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); if (previewAudio === audio) previewAudio = null; };
    previewAudio = audio;
    await audio.play();
    return audio;
  }
  function jumpToLine(lineId) {
    const found = findSceneByKey(audioSceneKey);
    if (!found) return;
    const idx = found.scene.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) return;
    stopAudioPlayback();
    audioIndex = idx;
    audioPlaying = true;
    audioPaused = false;
    updateAudioPauseButton();
    showAudioFloatingBar();
    advanceAudio(found.scene);
  }
  // Priorite a la vraie voix d'un comedien si elle a ete enregistree pour cette
  // replique precise (partagee par le serveur) ; repli sur la voix synthetique sinon.
  async function playLineAudio(l, onEnd) {
    const gen = audioGeneration;
    const found = await getOfflineAudio(currentPlay.id, l.id, l.character, ttsText(l.text));
    const offline = found && (!found.stale || !navigator.onLine) ? found : null; // voix perimee : on prefere la synthese actuelle si en ligne
    if (offline) {
      if (gen !== audioGeneration) return;
      const url = URL.createObjectURL(new Blob([offline.buf], { type: offline.type }));
      const audio = new Audio(url);
      audio.playbackRate = parseFloat($('#audio-rate').value) || 1;
      currentTtsAudio = audio;
      audio.onended = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
      audio.onerror = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
      await audio.play();
      return;
    }
    try {
      const res = await fetch(`${BASE}/api/recordings/${currentPlay.id}/${l.id}`, { headers: authHeaders() });
      if (gen !== audioGeneration) return;
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        if (gen !== audioGeneration) return;
        const url = URL.createObjectURL(new Blob([arrayBuf], { type: 'audio/webm' }));
        const audio = new Audio(url);
        audio.playbackRate = parseFloat($('#audio-rate').value) || 1;
        currentTtsAudio = audio;
        audio.onended = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) onEnd(); };
        audio.onerror = () => { URL.revokeObjectURL(url); if (gen === audioGeneration) speakLine(l, onEnd); };
        await audio.play();
        return;
      }
    } catch (e) { /* pas d'enregistrement disponible : on utilise la voix synthetique */ }
    if (gen !== audioGeneration) return;
    speakLine(l, onEnd, found && found.stale ? found : null);
  }
  function advanceAudio(scene) {
    if (!audioPlaying) return;
    // Boucle : une fois la fin marquee depassee, on revient au debut marque plutot que
    // de continuer — pratique pour retravailler un passage precis sans tout reecouter.
    if (loopStart != null && loopEnd != null && audioIndex > loopEnd) audioIndex = loopStart;
    if (audioIndex >= scene.lines.length) {
      const flat = allScenesFlat();
      const curIdx = flat.findIndex((f) => f.scene.id === audioSceneKey);
      const next = flat[curIdx + 1];
      // Mode voiture : enchaine sur la scene suivante plutot que de s'arreter, pour une
      // repetition mains-libres sur toute la piece.
      if (next && $('#audio-auto-resume').checked) {
        toast('▶ Scène suivante : ' + next.scene.title);
        audioSceneKey = next.scene.id;
        $('#audio-scene-select').value = audioSceneKey;
        audioIndex = 0;
        clearAudioLoop();
        renderAudioLines(next.scene);
        advanceAudio(next.scene);
        return;
      }
      toast(next ? 'Fin de la scène 🎉' : 'Fin de la pièce 🎉');
      stopAudioPlayback();
      return;
    }
    const l = scene.lines[audioIndex];
    if (currentPlay) saveLastPos(currentPlay.id, { audioSceneKey: scene.id, audioIndex });
    highlightAudioLine(l.id);
    if (l.isStageDirection) {
      $('#audio-current').textContent = '(' + l.text + ')';
      audioIndex++;
      audioTimerHandle = setTimeout(() => advanceAudio(scene), 500);
      return;
    }
    if (isMine(l.character) && !$('#audio-speak-mine').checked) { showAudioCue(l); return; }
    $('#audio-current').textContent = (l.character ? l.character + ' : ' : '') + spokenTextOnly(l.text);
    playLineAudio(l, () => {
      if (!audioPlaying) return;
      audioIndex++;
      audioTimerHandle = setTimeout(() => advanceAudio(scene), 300);
    });
  }
  // Estime le temps necessaire pour dire une replique a voix haute, a partir de son
  // nombre de mots (les didascalies ne sont pas comptees, on ne les dit pas). Utilise
  // pour le mode voiture : une replique de 2 lignes et une de demi-page n'ont pas
  // besoin de la meme pause avant la reprise automatique.
  function estimateSpeakingSeconds(text) {
    const words = (text.match(/\S+/g) || []).length;
    const wpm = parseInt($('#audio-wpm').value, 10) || 130;
    return Math.max(3, Math.round((words / wpm) * 60) + 2); // +2s de marge, 3s minimum
  }
  let currentCueLine = null;
  let audioPaused = false;
  function showAudioFloatingBar() { $('#audio-floating-bar').classList.remove('hidden'); }
  function hideAudioFloatingBar() { $('#audio-floating-bar').classList.add('hidden'); }
  function updateAudioPauseButton() {
    $('#audio-pause').textContent = audioPaused ? '▶ Reprendre' : '⏸ Pause';
  }
  // Pause "au plus simple" : coupe la lecture en cours sans avancer l'index (le meme
  // garde-fou "if (!audioPlaying) return" deja present partout empeche toute callback
  // en vol de faire progresser la lecture pendant la pause). La reprise rejoue la
  // replique en cours depuis son debut plutot que de tenter un rattrapage a la seconde
  // pres, plus fiable entre TTS serveur, voix du navigateur et enregistrements.
  function pauseAudioPlayback() {
    if (!audioPlaying) return;
    audioPlaying = false;
    audioPaused = true;
    audioGeneration++;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (currentTtsAudio) { try { currentTtsAudio.pause(); } catch (e) { /* ignore */ } }
    if (previewAudio) { try { previewAudio.pause(); } catch (e) { /* ignore */ } }
    clearTimeout(audioTimerHandle);
    $('#audio-timer-display').classList.add('hidden');
    updateAudioPauseButton();
  }
  function resumeAudioPlayback() {
    if (!audioPaused) return;
    audioPaused = false;
    audioPlaying = true;
    updateAudioPauseButton();
    const found = findSceneByKey(audioSceneKey);
    if (!found) return;
    if (!$('#audio-cue').classList.contains('hidden')) showAudioCue(currentCueLine);
    else advanceAudio(found.scene);
  }
  function showAudioCue(l) {
    currentCueLine = l;
    $('#audio-current').textContent = '';
    $('#audio-cue').classList.remove('hidden');
    $('#audio-cue-actions').classList.remove('hidden');
    $('#audio-cue-character').textContent = l.character;
    $('#audio-cue-note').textContent = userState.annotations[l.id] || '(aucune note de mise en scène)';

    const timerSec = $('#audio-auto-resume').checked ? estimateSpeakingSeconds(spokenTextOnly(l.text)) : 0;
    const disp = $('#audio-timer-display');
    clearTimeout(audioTimerHandle);
    if (timerSec > 0) {
      disp.classList.remove('hidden');
      let remaining = timerSec;
      disp.textContent = `Reprise automatique dans ${remaining}s…`;
      const tick = () => {
        remaining--;
        if (remaining <= 0) { continueAfterCue(); return; }
        disp.textContent = `Reprise automatique dans ${remaining}s…`;
        audioTimerHandle = setTimeout(tick, 1000);
      };
      audioTimerHandle = setTimeout(tick, 1000);
    } else {
      disp.classList.add('hidden');
    }
  }
  function continueAfterCue() {
    // Garde-fou : un double-tap sur "Continuer" faisait sauter une ligne (deux increments).
    if ($('#audio-cue').classList.contains('hidden')) return;
    clearTimeout(audioTimerHandle);
    $('#audio-cue').classList.add('hidden');
    $('#audio-cue-actions').classList.add('hidden');
    $('#audio-timer-display').classList.add('hidden');
    if (!audioPlaying) return;
    audioIndex++;
    const found = findSceneByKey(audioSceneKey);
    if (found) advanceAudio(found.scene);
  }
  function stopAudioPlayback() {
    audioPlaying = false;
    audioPaused = false;
    audioGeneration++;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (currentTtsAudio) { try { currentTtsAudio.pause(); } catch (e) { /* ignore */ } currentTtsAudio = null; }
    if (previewAudio) { try { previewAudio.pause(); } catch (e) { /* ignore */ } previewAudio = null; }
    clearTimeout(audioTimerHandle);
    const cueBox = $('#audio-cue'); if (cueBox) cueBox.classList.add('hidden');
    $('#audio-cue-actions').classList.add('hidden');
    hideAudioFloatingBar();
    const disp = $('#audio-timer-display'); if (disp) disp.classList.add('hidden');
    audioIndex = -1;
    const cur = $('#audio-current'); if (cur) cur.textContent = '';
    $all('#audio-lines .line-card').forEach((c) => c.classList.remove('current'));
  }

  // ================= Ecran : gestion des comptes (admin) =================
  function showTempPassword(name, tempPassword, email) {
    const box = $('#temp-password-box');
    const emailHint = email
      ? `Avec l'adresse ${escapeHtml(email)} enregistrée, elle pourra aussi réinitialiser elle-même son mot de passe (« Mot de passe oublié ? »).`
      : "Aucune adresse mail enregistrée : sans elle, seul toi pourras réinitialiser son mot de passe (tu peux l'ajouter plus tard dans sa fiche).";
    box.innerHTML = `<h3>🔑 Mot de passe temporaire pour ${escapeHtml(name)}</h3>
      <p class="hint">Communique-le à la personne (il ne sera plus jamais affiché) : elle devra le changer à sa première connexion.</p>
      <p style="font-size:22px; font-weight:700; letter-spacing:2px; text-align:center; padding:10px; background:var(--accent-light); border-radius:10px;">${escapeHtml(tempPassword)}</p>
      <p class="hint">${emailHint}</p>`;
    box.classList.remove('hidden');
  }
  async function renderTroupesPanel() {
    const box = $('#troupes-list');
    box.innerHTML = '';
    let troupes = [];
    try { troupes = await api('/api/troupes'); } catch (e) { return; }
    if (!troupes.length) { box.appendChild(el('p', 'hint', 'Aucune troupe pour le moment.')); return; }
    troupes.forEach((t) => {
      const card = el('div', 'play-card');
      card.appendChild(el('h3', null, t.name));
      const actions = el('div', 'actions');
      const renameBtn = el('button', 'btn btn-ghost btn-sm', '✏️ Renommer');
      renameBtn.type = 'button';
      renameBtn.addEventListener('click', async () => {
        const name = prompt('Nouveau nom de la troupe :', t.name);
        if (name == null) return;
        const trimmed = name.trim();
        if (!trimmed || trimmed === t.name) return;
        try {
          await api('/api/troupes/' + t.id, { method: 'PUT', body: { name: trimmed } });
          renderTroupesPanel();
          renderAccountsScreen();
          if (currentPlay) renderSharePicker();
        } catch (e) { /* toast deja affiche */ }
      });
      actions.appendChild(renameBtn);
      const delBtn = el('button', 'btn btn-danger btn-sm', 'Supprimer');
      delBtn.type = 'button';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Supprimer la troupe "${t.name}" ? Les comptes et pièces qui lui sont liés perdront ce lien (mais restent intacts).`)) return;
        await api('/api/troupes/' + t.id, { method: 'DELETE' });
        renderTroupesPanel();
        renderAccountsScreen();
      });
      actions.appendChild(delBtn);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }
  // Liste de comptes concue pour beaucoup de membres : recherche, filtres (troupe, role),
  // pagination, lignes compactes aux details depliables, et actions groupees sur la selection.
  const accountsState = { users: [], troupes: [], search: '', troupe: '', role: '', page: 1, selected: new Set(), expanded: null };
  const ACCOUNTS_PER_PAGE = 20;
  const ROLE_LABELS = { admin: 'Administrateur', director: 'Metteur en scène', user: 'Utilisateur' };
  const plainText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function filteredAccounts() {
    const q = plainText(accountsState.search.trim());
    return accountsState.users.filter((u) => {
      if (q && !plainText(u.name).includes(q)) return false;
      const tf = accountsState.troupe;
      if (tf === '__none') { if ((u.troupeIds || []).length) return false; }
      else if (tf && !(u.troupeIds || []).includes(tf)) return false;
      const rf = accountsState.role;
      if (rf === 'pending') { if (!u.mustChangePassword) return false; }
      else if (rf && u.role !== rf) return false;
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  }
  function fillTroupeSelects() {
    const { troupes } = accountsState;
    const filter = $('#accounts-filter-troupe');
    const keep = accountsState.troupe;
    filter.innerHTML = '<option value="">Toutes les troupes</option><option value="__none">Sans troupe</option>'
      + troupes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    filter.value = troupes.some((t) => t.id === keep) || keep === '__none' ? keep : '';
    accountsState.troupe = filter.value;
    const bulk = $('#bulk-account-troupe');
    const keepBulk = bulk.value;
    bulk.innerHTML = '<option value="">— Aucune —</option>' + troupes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    bulk.value = troupes.some((t) => t.id === keepBulk) ? keepBulk : '';
  }
  async function renderAccountsScreen() {
    let users = [], troupes = [];
    try { users = await api('/api/users'); } catch (e) { return; }
    try { troupes = await api('/api/troupes'); } catch (e) { troupes = []; }
    accountsState.users = users;
    accountsState.troupes = troupes;
    const ids = new Set(users.map((u) => u.id));
    accountsState.selected = new Set(Array.from(accountsState.selected).filter((id) => ids.has(id)));
    if (accountsState.expanded && !ids.has(accountsState.expanded)) accountsState.expanded = null;
    fillTroupeSelects();
    renderAccountsList();
    renderBackupStatus();
  }
  function renderAccountsBulkBar() {
    const bar = $('#accounts-bulkbar');
    const n = accountsState.selected.size;
    bar.classList.toggle('hidden', !n);
    if (!n) return;
    bar.innerHTML = '';
    bar.appendChild(el('strong', null, `${n} sélectionné${n > 1 ? 's' : ''}`));
    if (accountsState.troupes.length) {
      const sel = document.createElement('select');
      sel.innerHTML = accountsState.troupes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      bar.appendChild(sel);
      const run = async (action) => {
        try {
          const result = await api('/api/users/bulk-troupe', { method: 'POST', body: { userIds: Array.from(accountsState.selected), troupeId: sel.value, action } });
          toast(`${result.changed} compte${result.changed > 1 ? 's' : ''} modifié${result.changed > 1 ? 's' : ''}`);
          renderAccountsScreen();
        } catch (e) { /* toast deja affiche */ }
      };
      const add = el('button', 'btn btn-primary btn-sm', '+ Ajouter à la troupe');
      add.type = 'button'; add.addEventListener('click', () => run('add'));
      const rem = el('button', 'btn btn-ghost btn-sm', 'Retirer de la troupe');
      rem.type = 'button'; rem.addEventListener('click', () => run('remove'));
      bar.appendChild(add); bar.appendChild(rem);
    }
    const clear = el('button', 'btn btn-ghost btn-sm', 'Désélectionner');
    clear.type = 'button';
    clear.addEventListener('click', () => { accountsState.selected.clear(); renderAccountsList(); });
    bar.appendChild(clear);
  }
  function renderAccountsList() {
    const { users, troupes } = accountsState;
    const all = filteredAccounts();
    const pages = Math.max(1, Math.ceil(all.length / ACCOUNTS_PER_PAGE));
    accountsState.page = Math.min(Math.max(1, accountsState.page), pages);
    const start = (accountsState.page - 1) * ACCOUNTS_PER_PAGE;
    $('#accounts-count').textContent = all.length === users.length ? String(users.length) : `${all.length} / ${users.length}`;
    $('#accounts-select-all').checked = all.length > 0 && all.every((u) => accountsState.selected.has(u.id));
    $('#accounts-select-all-label').textContent = `Tout sélectionner (${all.length})`;
    renderAccountsBulkBar();

    const box = $('#accounts-list');
    box.innerHTML = '';
    if (!all.length) box.appendChild(el('p', 'hint', users.length ? 'Aucun compte ne correspond à la recherche.' : 'Aucun compte pour le moment.'));
    const troupeName = (id) => (troupes.find((t) => t.id === id) || {}).name || '?';
    all.slice(start, start + ACCOUNTS_PER_PAGE).forEach((u) => box.appendChild(renderAccountRow(u, troupeName)));

    const pager = $('#accounts-pager');
    pager.innerHTML = '';
    if (pages > 1) {
      const prev = el('button', 'btn btn-ghost btn-sm', '‹ Précédent');
      prev.type = 'button'; prev.disabled = accountsState.page <= 1;
      prev.addEventListener('click', () => { accountsState.page--; renderAccountsList(); $('#accounts-search').scrollIntoView({ block: 'start' }); });
      const next = el('button', 'btn btn-ghost btn-sm', 'Suivant ›');
      next.type = 'button'; next.disabled = accountsState.page >= pages;
      next.addEventListener('click', () => { accountsState.page++; renderAccountsList(); $('#accounts-search').scrollIntoView({ block: 'start' }); });
      pager.appendChild(prev);
      pager.appendChild(el('span', 'hint', `Page ${accountsState.page} / ${pages}`));
      pager.appendChild(next);
    }
  }
  function renderAccountRow(u, troupeName) {
    const open = accountsState.expanded === u.id;
    const row = el('div', 'account-row' + (open ? ' open' : ''));
    const main = el('div', 'account-main');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'account-check';
    cb.checked = accountsState.selected.has(u.id);
    cb.setAttribute('aria-label', 'Sélectionner ' + u.name);
    cb.addEventListener('change', () => {
      if (cb.checked) accountsState.selected.add(u.id); else accountsState.selected.delete(u.id);
      $('#accounts-select-all').checked = filteredAccounts().every((x) => accountsState.selected.has(x.id));
      renderAccountsBulkBar();
    });
    main.appendChild(cb);
    const info = el('div', 'account-info');
    const nameLine = el('div', 'account-name');
    nameLine.appendChild(document.createTextNode(u.name));
    if (u.role !== 'user') nameLine.appendChild(el('span', 'tag tag-role', ROLE_LABELS[u.role] || u.role));
    if (u.mustChangePassword) { const w = el('span', 'tag tag-warn', '⚠ mot de passe temporaire'); nameLine.appendChild(w); }
    info.appendChild(nameLine);
    const tags = el('div', 'account-tags');
    const tIds = u.troupeIds || [];
    if (!tIds.length) tags.appendChild(el('span', 'tag tag-none', 'sans troupe'));
    tIds.slice(0, 3).forEach((id) => tags.appendChild(el('span', 'tag', troupeName(id))));
    if (tIds.length > 3) tags.appendChild(el('span', 'tag', '+' + (tIds.length - 3)));
    tags.appendChild(el('span', 'tag' + (u.email ? '' : ' tag-none'), u.email ? '✉️ ' + u.email : 'pas de mail'));
    info.appendChild(tags);
    main.appendChild(info);
    const toggle = el('button', 'btn btn-ghost btn-sm', open ? 'Fermer ▴' : 'Gérer ▾');
    toggle.type = 'button';
    toggle.addEventListener('click', () => { accountsState.expanded = open ? null : u.id; renderAccountsList(); });
    main.appendChild(toggle);
    row.appendChild(main);
    if (open) row.appendChild(renderAccountDetail(u));
    return row;
  }
  function renderAccountDetail(u) {
    const { troupes } = accountsState;
    const box = el('div', 'account-detail');
    if (u.id !== user.id) {
      const roleSelect = document.createElement('select');
      [['user', 'Utilisateur'], ['director', 'Metteur en scène'], ['admin', 'Administrateur']].forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = label; opt.selected = u.role === value;
        roleSelect.appendChild(opt);
      });
      roleSelect.addEventListener('change', async () => {
        try { await api('/api/users/' + u.id, { method: 'PUT', body: { role: roleSelect.value } }); renderAccountsScreen(); }
        catch (e) { /* toast deja affiche */ }
      });
      box.appendChild(el('div', 'field-label', 'Rôle'));
      box.appendChild(roleSelect);
    }
    if (troupes.length) {
      box.appendChild(el('div', 'field-label', 'Troupe(s)'));
      box.appendChild(createMultiSelect({
        items: troupes,
        getId: (t) => t.id,
        getLabel: (t) => t.name,
        currentIds: u.troupeIds || [],
        placeholder: 'Ajouter une troupe…',
        onChange: async (troupeIds) => {
          try { await api('/api/users/' + u.id + '/troupes', { method: 'PUT', body: { troupeIds } }); u.troupeIds = troupeIds; }
          catch (e) { /* toast deja affiche */ }
        },
      }));
    }
    box.appendChild(el('div', 'field-label', 'Adresse mail'));
    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'Pour la réinitialisation par mail (optionnelle)';
    emailInput.value = u.email || '';
    const saveEmail = debounce(async () => {
      const email = emailInput.value.trim();
      try { const res = await api('/api/users/' + u.id, { method: 'PUT', body: { email } }); u.email = res.email; }
      catch (e) { /* toast deja affiche */ }
    }, 500);
    emailInput.addEventListener('input', saveEmail);
    box.appendChild(emailInput);
    const actions = el('div', 'actions');
    const resetBtn = el('button', 'btn btn-ghost btn-sm', 'Réinitialiser le mot de passe');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', async () => {
      if (!confirm(`Générer un nouveau mot de passe temporaire pour ${u.name} ? L'ancien ne fonctionnera plus.`)) return;
      const result = await api('/api/users/' + u.id + '/reset-password', { method: 'POST' });
      showTempPassword(u.name, result.tempPassword);
      $('#temp-password-box').scrollIntoView({ block: 'center' });
      renderAccountsScreen();
    });
    actions.appendChild(resetBtn);
    if (u.id !== user.id) {
      const delBtn = el('button', 'btn btn-danger btn-sm', 'Supprimer');
      delBtn.type = 'button';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Supprimer le compte de ${u.name} ? Ses annotations et sa progression seront perdues.`)) return;
        await api('/api/users/' + u.id, { method: 'DELETE' });
        accountsState.expanded = null;
        renderAccountsScreen();
      });
      actions.appendChild(delBtn);
    }
    box.appendChild(actions);
    return box;
  }
  // Resultat d'une creation en lot : tableau + copie + fiches imprimables (une par personne).
  function showBulkResult(result) {
    const box = $('#bulk-result-box');
    const rows = result.created || [];
    box.innerHTML = '';
    box.appendChild(el('h3', null, `🔑 ${rows.length} compte${rows.length > 1 ? 's' : ''} créé${rows.length > 1 ? 's' : ''}`));
    box.appendChild(el('p', 'hint', "Mots de passe temporaires : ils ne seront plus jamais affichés. Copie ou imprime cette liste maintenant ; chaque personne changera son mot de passe à sa première connexion. Pense à ajouter l'adresse mail de chacun dans sa fiche pour qu'elle puisse se réinitialiser elle-même plus tard."));
    if ((result.skipped || []).length) {
      box.appendChild(el('p', 'hint', `Ignorés (${result.skipped.length}) : ` + result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')));
    }
    if (rows.length) {
      const wrap = el('div', 'bulk-table-wrap');
      const table = document.createElement('table');
      table.className = 'bulk-table';
      table.innerHTML = '<thead><tr><th>Identifiant</th><th>Mot de passe temporaire</th></tr></thead><tbody>'
        + rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td><code>${escapeHtml(r.tempPassword)}</code></td></tr>`).join('')
        + '</tbody>';
      wrap.appendChild(table);
      box.appendChild(wrap);
      const actions = el('div', 'actions');
      const copy = el('button', 'btn btn-ghost btn-sm', '📋 Copier la liste');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        const text = 'Identifiant\tMot de passe temporaire\n' + rows.map((r) => `${r.name}\t${r.tempPassword}`).join('\n');
        try { await navigator.clipboard.writeText(text); toast('Liste copiée'); } catch (e) { toast('Copie impossible : sélectionne le tableau à la main'); }
      });
      const print = el('button', 'btn btn-ghost btn-sm', '🖨️ Imprimer les fiches');
      print.type = 'button';
      print.addEventListener('click', () => {
        const cards = rows.map((r) => `<div style="page-break-inside:avoid; border:1px dashed #888; border-radius:8px; padding:12px 16px; margin:12px 0;">
          <div style="font-size:18px"><strong>${escapeHtml(r.name)}</strong></div>
          <div>Mot de passe temporaire : <strong>${escapeHtml(r.tempPassword)}</strong></div>
          <div style="font-size:12px; color:#666">À la première connexion, choisis ton propre mot de passe.</div>
        </div>`).join('');
        printHtmlDocument('Répétito — accès des comptes', cards);
      });
      actions.appendChild(copy);
      actions.appendChild(print);
      box.appendChild(actions);
    }
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'start' });
  }

  // ================= Ecran : enregistrements (voix reelles, partagees) =================
  let recSceneKey = null;
  function renderRecordingsScreen() {
    if (!currentPlay) return;
    if (!recSceneKey || !findSceneByKey(recSceneKey)) {
      const flat = allScenesFlat();
      recSceneKey = flat.length ? flat[0].scene.id : null;
    }
    if (!recSceneKey) { $('#rec-lines').innerHTML = '<p class="hint">Cette pièce ne contient aucune scène.</p>'; return; }
    fillSceneSelect($('#rec-scene-select'), recSceneKey);
    renderRecordingsLines(findSceneByKey(recSceneKey).scene);
  }
  function stepRecScene(delta) {
    const flat = allScenesFlat();
    const idx = flat.findIndex((f) => f.scene.id === recSceneKey);
    const next = flat[idx + delta];
    if (!next) { toast(delta > 0 ? 'Dernière scène' : 'Première scène'); return; }
    recSceneKey = next.scene.id;
    $('#rec-scene-select').value = recSceneKey;
    renderRecordingsLines(next.scene);
  }
  async function renderRecordingsLines(scene) {
    const box = $('#rec-lines');
    box.innerHTML = '';
    let recordings = {};
    try { recordings = await api('/api/recordings/' + currentPlay.id); } catch (e) { /* tant pis */ }
    scene.lines.forEach((l, li) => {
      if (l.isStageDirection) return;
      const card = el('div', 'line-card');
      card.appendChild(el('div', 'line-meta', `réplique ${li + 1}/${scene.lines.length}`));
      if (l.character) card.appendChild(el('div', 'character-name', l.character));
      card.appendChild(elHTML('div', 'line-text', renderInlineText(l.text)));
      const entry = recordings[l.id];
      const active = activeTake(entry);
      if (active) card.appendChild(el('div', 'hint', '🎙️ Enregistré par ' + active.recordedByName));

      const row = el('div', 'status-row');
      // Un utilisateur non-admin ne peut enregistrer que les repliques du/des personnage(s)
      // que l'administrateur lui a attribue(s) (verifie aussi cote serveur).
      const canRecord = isAdmin() || isMine(l.character);
      if (canRecord) {
        const recBtn = el('button', 'btn btn-ghost btn-sm', '🎙️ Enregistrer');
        recBtn.type = 'button';
        let localRecorder = null, localChunks = [], localStream = null;
        recBtn.addEventListener('click', async () => {
          if (localRecorder && localRecorder.state === 'recording') { localRecorder.stop(); return; }
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localChunks = [];
            localRecorder = new MediaRecorder(localStream);
            localRecorder.ondataavailable = (e) => { if (e.data.size > 0) localChunks.push(e.data); };
            localRecorder.onstop = async () => {
              localStream.getTracks().forEach((t) => t.stop());
              const blob = new Blob(localChunks, { type: 'audio/webm' });
              try {
                await fetch(`${BASE}/api/recordings/${currentPlay.id}/${l.id}`, {
                  method: 'POST', headers: Object.assign({ 'Content-Type': 'audio/webm' }, authHeaders()), body: blob,
                });
                toast('Enregistrement sauvegardé et partagé (nouvelle prise)');
              } catch (e) { toast('Échec de l\'envoi'); }
              renderRecordingsLines(scene);
            };
            localRecorder.start();
            recBtn.textContent = "⏹ Arrêter l'enregistrement";
          } catch (e) { toast('Micro indisponible : ' + e.message); }
        });
        row.appendChild(recBtn);
      } else if (!active) {
        row.appendChild(el('div', 'hint', "Pas ton personnage"));
      }

      if (active) {
        const playBtn = el('button', 'btn btn-ghost btn-sm', '▶ Écouter');
        playBtn.type = 'button';
        // Balise <audio> native : impossible d'y joindre l'en-tete d'autorisation, on
        // passe le jeton en parametre d'URL (accepte en secours par le serveur).
        playBtn.addEventListener('click', () => { new Audio(`${BASE}/api/recordings/${currentPlay.id}/${l.id}?token=${session.token}`).play(); });
        row.appendChild(playBtn);
      }

      card.appendChild(row);

      // Gestion des prises (admin) : plusieurs enregistrements peuvent coexister pour la
      // meme replique (ex. lecture a table + reprise individuelle) — on choisit laquelle
      // est active, ou on supprime celles qu'on ne veut plus garder.
      if (isAdmin() && entry && entry.takes && entry.takes.length) {
        const takesBox = el('div', 'takes-list hidden');
        const toggleBtn = el('button', 'btn btn-ghost btn-sm', `🎞️ Prises (${entry.takes.length})`);
        toggleBtn.type = 'button';
        toggleBtn.addEventListener('click', () => {
          if (!takesBox.classList.contains('hidden')) { takesBox.classList.add('hidden'); return; }
          renderTakesList(takesBox, l.id, entry, scene);
          takesBox.classList.remove('hidden');
        });
        row.appendChild(toggleBtn);
        card.appendChild(takesBox);
      }
      box.appendChild(card);
    });
  }
  function renderTakesList(box, lineId, entry, scene) {
    box.innerHTML = '';
    const sorted = entry.takes.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    sorted.forEach((t) => {
      const isActiveTake = t.id === entry.activeId;
      const row = el('div', 'take-row' + (isActiveTake ? ' active' : ''));
      const sourceLabel = t.source === 'table' ? ' (lecture à table)' : '';
      row.appendChild(el('div', 'take-label', (isActiveTake ? '✓ ' : '') + t.recordedByName + sourceLabel + ' — ' + new Date(t.updatedAt).toLocaleString('fr-FR')));
      const actions = el('div', 'take-actions');
      const playBtn = el('button', 'btn btn-ghost btn-sm', '▶');
      playBtn.type = 'button';
      playBtn.addEventListener('click', () => { new Audio(`${BASE}/api/recordings/${currentPlay.id}/${lineId}/takes/${t.id}?token=${session.token}`).play(); });
      actions.appendChild(playBtn);
      if (!isActiveTake) {
        const useBtn = el('button', 'btn btn-ghost btn-sm', '✓ Utiliser');
        useBtn.type = 'button';
        useBtn.addEventListener('click', async () => {
          try {
            await api(`/api/recordings/${currentPlay.id}/${lineId}/active`, { method: 'PUT', body: { takeId: t.id } });
            renderRecordingsLines(scene);
          } catch (e) { /* toast deja affiche */ }
        });
        actions.appendChild(useBtn);
      }
      const delBtn = el('button', 'btn btn-ghost btn-sm', '🗑');
      delBtn.type = 'button';
      delBtn.addEventListener('click', async () => {
        if (!confirm('Supprimer cette prise ?')) return;
        try {
          await api(`/api/recordings/${currentPlay.id}/${lineId}/takes/${t.id}`, { method: 'DELETE' });
          renderRecordingsLines(scene);
        } catch (e) { /* toast deja affiche */ }
      });
      actions.appendChild(delBtn);
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  // ================= Ecran : decoupage d'une lecture a table =================
  let tableReadBlob = null;
  let tableReadMarks = {};
  let tableReadScope = 'full'; // 'full' (toute la piece) ou l'id d'une scene
  function fillTableReadScopeSelect(keepValue) {
    const sel = $('#tableread-scope-select');
    fillSceneSelect(sel);
    const fullOpt = document.createElement('option');
    fullOpt.value = 'full';
    fullOpt.textContent = 'Toute la pièce';
    sel.insertBefore(fullOpt, sel.firstChild);
    sel.value = keepValue || 'full';
  }
  function formatTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  async function loadTableReadMaster(fileOrBlob) {
    tableReadBlob = fileOrBlob;
    tableReadMarks = {};
    $('#tableread-audio').src = URL.createObjectURL(fileOrBlob);
    $('#tableread-editor-panel').classList.remove('hidden');
    toast("Envoi de l'enregistrement au serveur…");
    try {
      await fetch(`${BASE}/api/table-read/${currentPlay.id}/${tableReadScope}`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': fileOrBlob.type || 'application/octet-stream' }, authHeaders()),
        body: fileOrBlob,
      });
      toast('Enregistrement importé — commence à marquer les répliques');
    } catch (e) { toast("Échec de l'envoi au serveur"); }
    renderTableReadLines();
  }
  function updateTableReadSplitButton() {
    const n = Object.keys(tableReadMarks).length;
    const btn = $('#btn-tableread-split');
    btn.classList.toggle('hidden', n === 0);
    btn.textContent = `✂️ Découper et enregistrer ${n} réplique(s) marquée(s)`;
  }
  function renderTableReadLines() {
    const box = $('#tableread-lines');
    box.innerHTML = '';
    if (!currentPlay) return;
    const scopedScenes = tableReadScope === 'full'
      ? allScenesFlat()
      : allScenesFlat().filter(({ scene }) => scene.id === tableReadScope);
    scopedScenes.forEach(({ act: a, scene: s }) => {
      box.appendChild(el('div', 'act-title', a.title + ' — ' + s.title));
      s.lines.forEach((l) => {
        if (l.isStageDirection) return;
        const card = el('div', 'line-card');
        if (l.character) card.appendChild(el('div', 'character-name', l.character));
        card.appendChild(elHTML('div', 'line-text', renderInlineText(l.text)));
        const row = el('div', 'status-row');
        const marked = tableReadMarks[l.id] != null;
        const markBtn = el('button', 'btn btn-ghost btn-sm' + (marked ? ' active' : ''), marked ? '⏱ ' + formatTime(tableReadMarks[l.id]) : '⏱ Marquer ici');
        markBtn.type = 'button';
        markBtn.addEventListener('click', () => {
          tableReadMarks[l.id] = $('#tableread-audio').currentTime;
          renderTableReadLines();
        });
        row.appendChild(markBtn);
        if (marked) {
          const clearBtn = el('button', 'btn btn-ghost btn-sm', '✕');
          clearBtn.type = 'button';
          clearBtn.addEventListener('click', () => { delete tableReadMarks[l.id]; renderTableReadLines(); });
          row.appendChild(clearBtn);
        }
        card.appendChild(row);
        box.appendChild(card);
      });
    });
    updateTableReadSplitButton();
  }

  // ================= Ecran : stats =================
  function renderStats() {
    if (!currentPlay) return;
    const { pct, total, done } = computeOverallProgress();
    $('#stats-pct').textContent = pct + '%';
    $('#stats-fill').style.width = pct + '%';
    $('#stats-detail').textContent = total
      ? `${done} / ${total} répliques acquises (personnage(s) : ${userState.selectedCharacters.join(', ') || 'aucun'})`
      : "Choisis ton personnage dans l'onglet Pièce pour suivre ta progression.";

    const rows = [];
    currentPlay.acts.forEach((a) => a.scenes.forEach((s) => {
      const mineLines = s.lines.filter((l) => !l.isStageDirection && isMine(l.character));
      if (!mineLines.length) return;
      const doneCount = mineLines.filter((l) => userState.progress[l.id] === 'acquise').length;
      rows.push({ act: a.title, scene: s.title, key: s.id, pct: Math.round((doneCount / mineLines.length) * 100), doneCount, total: mineLines.length });
    }));
    rows.sort((a, b) => a.pct - b.pct);
    const box = $('#stats-scenes');
    box.innerHTML = '';
    if (!rows.length) { box.appendChild(el('p', 'hint', "Aucune scène avec des répliques pour ton personnage pour l'instant.")); return; }
    rows.forEach((r) => {
      const card = el('div', 'play-card');
      card.innerHTML = `<h3>${escapeHtml(r.act)} — ${escapeHtml(r.scene)}</h3>
        <div class="progress-bar"><div class="progress-fill" style="width:${r.pct}%"></div></div>
        <div class="meta">${r.doneCount}/${r.total} acquises (${r.pct}%)</div>
        <div class="actions"><button type="button" class="btn btn-ghost btn-sm" data-goto="${r.key}">Réviser cette scène</button></div>`;
      box.appendChild(card);
    });
  }

  // ================= Cablage des evenements =================
  function wireEvents() {
    window.addEventListener('online', () => { if (user) flushPendingSync(); });
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#login-name').value.trim();
      const password = $('#login-password').value;
      if (!username || !password) return;
      try {
        const result = await api('/api/auth/login', { method: 'POST', body: { username, password } });
        session = result; user = result.user; saveSession(session);
        if (user.mustChangePassword) { passwordChangeIsMandatory = true; $('#btn-cancel-password').classList.add('hidden'); $('#current-password-field').classList.add('hidden'); $('#modal-change-password').classList.remove('hidden'); }
        else { boot(); }
      } catch (e) { /* le message d'erreur est deja affiche par api() */ }
    });

    // Recuperation par mail en deux etapes : (1) demander un code a partir de l'identifiant,
    // (2) le saisir avec le nouveau mot de passe. L'identifiant est garde entre les deux
    // (pour "Renvoyer le code" sans le retaper).
    let recoveryUsername = '';
    function showRecoveryStep1() {
      $('#login-form').classList.add('hidden');
      $('#btn-show-recovery').classList.add('hidden');
      $('#recovery-form').classList.add('hidden');
      $('#recovery-request-form').classList.remove('hidden');
    }
    function backToLogin() {
      $('#recovery-request-form').classList.add('hidden');
      $('#recovery-form').classList.add('hidden');
      $('#login-form').classList.remove('hidden');
      $('#btn-show-recovery').classList.remove('hidden');
    }
    async function requestRecoveryCode(username) {
      try {
        const result = await api('/api/auth/request-reset', { method: 'POST', body: { username } });
        recoveryUsername = username;
        $('#recovery-sent-hint').textContent = result.message || "Un code vient d'être envoyé par mail.";
        $('#recovery-request-form').classList.add('hidden');
        $('#recovery-form').classList.remove('hidden');
        $('#recovery-form').reset();
      } catch (e) { /* toast deja affiche */ }
    }
    $('#btn-show-recovery').addEventListener('click', showRecoveryStep1);
    $('#btn-hide-recovery').addEventListener('click', backToLogin);
    $('#btn-cancel-recovery').addEventListener('click', backToLogin);
    $('#recovery-request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#recovery-name').value.trim();
      if (!username) return;
      await requestRecoveryCode(username);
    });
    $('#btn-resend-recovery').addEventListener('click', async () => {
      if (!recoveryUsername) return;
      await requestRecoveryCode(recoveryUsername);
      toast('Nouveau code demandé');
    });
    $('#recovery-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#recovery-code').value.trim();
      const newPassword = $('#recovery-new-password').value;
      if (!recoveryUsername || !code || !newPassword) return;
      try {
        await api('/api/auth/reset-with-code', { method: 'POST', body: { username: recoveryUsername, code, newPassword } });
        toast('Mot de passe mis à jour — connecte-toi avec ton nouveau mot de passe');
        $('#login-name').value = recoveryUsername;
        recoveryUsername = '';
        backToLogin();
      } catch (e) { /* toast deja affiche */ }
    });

    $('#change-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const p1 = $('#new-password-1').value, p2 = $('#new-password-2').value;
      if (p1 !== p2) { toast('Les deux mots de passe ne correspondent pas'); return; }
      const body = { newPassword: p1 };
      if (!passwordChangeIsMandatory) body.currentPassword = $('#current-password').value;
      try {
        await api('/api/auth/change-password', { method: 'POST', body });
        user.mustChangePassword = false;
        session.user.mustChangePassword = false;
        saveSession(session);
        $('#modal-change-password').classList.add('hidden');
        $('#current-password').value = ''; $('#new-password-1').value = ''; $('#new-password-2').value = '';
        toast('Mot de passe mis à jour');
        if (passwordChangeIsMandatory) boot();
      } catch (e) { /* le message d'erreur est deja affiche par api() */ }
    });
    $('#btn-cancel-password').addEventListener('click', () => {
      $('#modal-change-password').classList.add('hidden');
      $('#current-password').value = ''; $('#new-password-1').value = ''; $('#new-password-2').value = '';
    });

    // ---- Menu utilisateur (hamburger) ----
    function closeUserMenu() {
      $('#user-menu').classList.add('hidden');
      $('#user-menu-backdrop').classList.add('hidden');
    }
    $('#btn-menu').addEventListener('click', () => {
      if (!user) return;
      $('#user-menu-name').textContent = user.name;
      $('#user-menu-role').textContent = user.role === 'admin' ? 'Administrateur' : 'Utilisateur';
      $('#user-menu').classList.remove('hidden');
      $('#user-menu-backdrop').classList.remove('hidden');
    });
    $('#user-menu-backdrop').addEventListener('click', closeUserMenu);
    $('#menu-change-password').addEventListener('click', () => {
      closeUserMenu();
      passwordChangeIsMandatory = false;
      $('#btn-cancel-password').classList.remove('hidden');
      $('#current-password-field').classList.remove('hidden');
      $('#modal-change-password').classList.remove('hidden');
    });
    $('#menu-goto-accounts').addEventListener('click', () => {
      closeUserMenu();
      $('#temp-password-box').classList.add('hidden');
      renderTroupesPanel();
      renderAccountsScreen();
      pushScreen('accounts');
    });
    $('#menu-logout').addEventListener('click', async () => {
      closeUserMenu();
      if (!user) return;
      if (confirm('Se déconnecter de ce compte (' + user.name + ') ?')) {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* tant pis */ }
        clearSession();
        location.reload();
      }
    });
    $('#btn-back').addEventListener('click', () => showScreen(screenStack.pop() || 'library'));

    $all('.nav-btn').forEach((b) => b.addEventListener('click', async () => {
      screenStack = []; // navigation directe via les onglets : on repart d'une pile vide
      let dest = b.dataset.nav;
      if (dest !== 'library' && !currentPlay) { toast('Choisis d\'abord une pièce dans Bibliothèque'); dest = 'library'; }
      if (dest === 'library') await refreshLibrary();
      if (dest === 'play') renderPlayScreen();
      if (dest === 'revision') renderRevision();
      if (dest === 'audio') renderAudioScene();
      if (dest === 'stats') renderStats();
      showScreen(dest);
    }));

    // ---- Bibliotheque ----
    $('#library-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-open]');
      if (!btn) return;
      await openPlay(btn.dataset.open);
    });
    $('#btn-new-play').addEventListener('click', () => { resetImportForm(); pushScreen('import'); });
    $('#install-tip-close').addEventListener('click', () => {
      localStorage.setItem('tr_install_tip_dismissed', '1');
      $('#install-tip').classList.add('hidden');
    });

    $('#btn-create-account').addEventListener('click', async () => {
      const name = $('#new-account-name').value.trim();
      const email = $('#new-account-email').value.trim();
      const role = $('#new-account-role').value;
      if (!name) { toast('Donne un identifiant'); return; }
      try {
        const created = await api('/api/users', { method: 'POST', body: { name, email, role } });
        $('#new-account-name').value = '';
        $('#new-account-email').value = '';
        showTempPassword(created.name, created.tempPassword, created.email);
        renderAccountsScreen();
      } catch (e) { /* toast deja affiche */ }
    });
    $('#btn-create-troupe').addEventListener('click', async () => {
      const name = $('#new-troupe-name').value.trim();
      if (!name) { toast('Donne un nom à la troupe'); return; }
      try {
        await api('/api/troupes', { method: 'POST', body: { name } });
        $('#new-troupe-name').value = '';
        renderTroupesPanel();
        renderAccountsScreen();
      } catch (e) { /* toast deja affiche */ }
    });

    // ---- Liste des comptes : recherche, filtres, selection, creation en lot ----
    $('#accounts-search').addEventListener('input', debounce((e) => { accountsState.search = e.target.value; accountsState.page = 1; renderAccountsList(); }, 150));
    $('#accounts-filter-troupe').addEventListener('change', (e) => { accountsState.troupe = e.target.value; accountsState.page = 1; renderAccountsList(); });
    $('#accounts-filter-role').addEventListener('change', (e) => { accountsState.role = e.target.value; accountsState.page = 1; renderAccountsList(); });
    $('#accounts-select-all').addEventListener('change', (e) => {
      const all = filteredAccounts();
      if (e.target.checked) all.forEach((u) => accountsState.selected.add(u.id)); else all.forEach((u) => accountsState.selected.delete(u.id));
      renderAccountsList();
    });
    $('#btn-create-bulk').addEventListener('click', async () => {
      const names = $('#bulk-account-names').value;
      if (!names.trim()) { toast('Écris au moins un identifiant (un par ligne)'); return; }
      const troupeId = $('#bulk-account-troupe').value;
      try {
        const result = await api('/api/users/bulk', { method: 'POST', body: { names, role: $('#bulk-account-role').value, troupeIds: troupeId ? [troupeId] : [] } });
        $('#bulk-account-names').value = '';
        showBulkResult(result);
        renderAccountsScreen();
      } catch (e) { /* toast deja affiche */ }
    });

    $all('.play-tab-btn').forEach((b) => b.addEventListener('click', () => { showPlayTab(b.dataset.playTab); window.scrollTo(0, 0); }));

    // ---- Prononciation, preparation des voix, sauvegarde, fichier d'import ----
    $('#btn-add-pron').addEventListener('click', () => {
      const box = $('#pron-list');
      const empty = box.querySelector('.pron-empty');
      if (empty) empty.remove();
      const row = pronRow('', '');
      box.appendChild(row);
      row.querySelector('input').focus();
    });
    $('#btn-pregen').addEventListener('click', async () => {
      if (!currentPlay) return;
      try { await api(`/api/plays/${currentPlay.id}/pregenerate`, { method: 'POST' }); toast('Préparation des voix lancée'); refreshPregenStatus(); }
      catch (e) { /* toast deja affiche */ }
    });
    $('#btn-download-backup').addEventListener('click', downloadBackup);
    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const status = $('#import-file-status');
      status.textContent = 'Lecture du fichier…';
      try {
        const text = await importFileToText(file);
        if (!text) throw new Error('Aucun texte trouvé dans ce fichier (un PDF scanné, en image, ne peut pas être lu : il faut un PDF avec du texte sélectionnable).');
        $('#import-text').value = text;
        if (!$('#import-title').value.trim()) $('#import-title').value = file.name.replace(/\.[^.]+$/, '');
        status.textContent = `✓ ${text.length} caractères extraits de « ${file.name} » : vérifie le texte ci-dessous, puis clique sur « Analyser ».`;
      } catch (err) { status.textContent = '⚠ ' + (err.message || 'Lecture impossible'); }
      e.target.value = '';
    });

    // ---- Import ----
    $('#btn-parse').addEventListener('click', () => {
      const text = $('#import-text').value;
      if (!text.trim()) { toast("Colle d'abord le texte de la pièce"); return; }
      const split = splitParentheticals(parsePlayTokens(text));
      importTokens = split.tokens;
      if (!importTokens.length) { toast('Aucune ligne détectée'); return; }
      renderImportPreview();
      if (split.count) toast(split.count + ' didascalie(s) entre parenthèses mise(s) en cartes à part');
      $('#import-step-paste').classList.add('hidden');
      $('#import-step-preview').classList.remove('hidden');
    });
    $('#btn-back-to-paste').addEventListener('click', () => {
      if (editingPlayId) { editingPlayId = null; renderPlayScreen(); showScreen(screenStack.pop() || 'play'); return; }
      $('#import-step-paste').classList.remove('hidden');
      $('#import-step-preview').classList.add('hidden');
    });
    $('#preview-list').addEventListener('input', (e) => {
      const row = e.target.closest('.token-row'); if (!row) return;
      const t = importTokens[+row.dataset.index];
      const field = e.target.dataset.field;
      if (field === 'character') t.character = e.target.value;
      else if (field === 'text') t.text = e.target.value;
      else if (field === 'title') t.title = e.target.value;
    });
    $('#preview-list').addEventListener('change', (e) => {
      const row = e.target.closest('.token-row'); if (!row) return;
      if (e.target.dataset.field !== 'type') return;
      const i = +row.dataset.index;
      const t = importTokens[i];
      const newType = e.target.value;
      if ((newType === 'act' || newType === 'scene') && !(t.type === 'act' || t.type === 'scene')) {
        t.title = t.text || t.title || '';
        delete t.character; delete t.text;
      } else if ((newType === 'line' || newType === 'direction') && (t.type === 'act' || t.type === 'scene')) {
        t.text = t.title || t.text || '';
        delete t.title;
        if (newType === 'line' && t.character === undefined) t.character = '';
      }
      t.type = newType;
      renderImportPreview();
    });
    $('#preview-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const row = btn.closest('.token-row');
      const i = +row.dataset.index;
      if (btn.dataset.act === 'delete') { importTokens.splice(i, 1); renderImportPreview(); }
      else if (btn.dataset.act === 'detach') {
        const ta = row.querySelector('textarea');
        const from = ta.selectionStart, to = ta.selectionEnd;
        const chosen = ta.value.slice(from, to).trim().replace(/^\(|\)$/g, '').trim();
        if (!chosen) { toast("Sélectionne d'abord, dans la réplique, le passage à transformer en didascalie"); return; }
        const t = importTokens[i];
        const before = ta.value.slice(0, from).trim(), after = ta.value.slice(to).trim();
        const parts = [];
        if (before) parts.push(Object.assign({}, t, { text: before }));
        parts.push({ type: 'direction', text: chosen });
        if (after) parts.push(before ? { type: 'line', character: t.character, text: after } : Object.assign({}, t, { text: after }));
        importTokens.splice(i, 1, ...parts);
        renderImportPreview();
      }
      else if (btn.dataset.act === 'merge-up') {
        if (i === 0) return;
        const prev = importTokens[i - 1]; const cur = importTokens[i];
        if (!['line', 'direction'].includes(prev.type) || !['line', 'direction'].includes(cur.type)) {
          toast('Fusion possible seulement entre répliques/didascalies'); return;
        }
        // Une didascalie absorbee dans une replique doit garder ses parentheses
        // pour rester identifiable (non masquee dans la voix, mise en italique).
        const curText = cur.type === 'direction' ? `(${(cur.text || '').trim()})` : (cur.text || '');
        prev.text = (prev.text ? prev.text + ' ' : '') + curText;
        importTokens.splice(i, 1);
        renderImportPreview();
      }
    });
    $('#btn-fix-parens').addEventListener('click', () => {
      const r = splitParentheticals(importTokens);
      importTokens = r.tokens;
      renderImportPreview();
      toast(r.count ? r.count + ' didascalie(s) sortie(s) en cartes à part' : 'Aucune didascalie entre parenthèses à sortir');
    });
    $('#btn-find-glued').addEventListener('click', () => renderGluedSuggestions(findGluedDirections(importTokens)));
    $('#btn-fix-pages').addEventListener('click', () => {
      const r = cleanPageNumbers(importTokens);
      importTokens = r.tokens;
      renderImportPreview();
      toast(r.count ? r.count + ' numéro(s) de page retiré(s)' : 'Aucun numéro de page repéré');
    });
    $('#btn-add-token').addEventListener('click', () => {
      importTokens.push({ type: 'line', character: '', text: '' });
      renderImportPreview();
      const list = $('#preview-list');
      if (list.lastElementChild) list.lastElementChild.scrollIntoView({ behavior: 'smooth' });
    });
    $('#btn-save-play').addEventListener('click', async () => {
      const title = $('#import-title').value.trim();
      if (!title) { toast('Donne un titre à la pièce'); return; }
      const cleaned = importTokens.filter((t) => t.type !== 'line' || (t.text && t.text.trim()) || (t.character && t.character.trim()));
      const { acts, characters } = nestTokens(cleaned);
      if (!acts.length) { toast('Aucun contenu à enregistrer'); return; }
      if (editingPlayId) {
        const play = await api('/api/plays/' + editingPlayId, { method: 'PUT', body: { title, acts, characters } });
        toast('Pièce mise à jour !');
        editingPlayId = null;
        await refreshLibrary();
        await openPlay(play.id);
        return;
      }
      const play = await api('/api/plays', { method: 'POST', body: { title, acts, characters } });
      toast('Pièce enregistrée !');
      await refreshLibrary();
      await openPlay(play.id);
    });

    // ---- Pièce ----
    $('#voice-picker').addEventListener('change', (e) => {
      const sel = e.target.closest('select'); if (!sel) return;
      const c = sel.dataset.char;
      if (sel.value) userState.voices[c] = sel.value; else delete userState.voices[c];
      saveState();
    });
    $('#btn-goto-next-weak').addEventListener('click', () => {
      let best = null, bestScore = -1;
      currentPlay.acts.forEach((a) => a.scenes.forEach((s) => {
        const mineLines = s.lines.filter((l) => !l.isStageDirection && isMine(l.character));
        if (!mineLines.length) return;
        const doneCount = mineLines.filter((l) => userState.progress[l.id] === 'acquise').length;
        const remaining = mineLines.length - doneCount;
        if (remaining > bestScore) { bestScore = remaining; best = s; }
      }));
      if (!best) { toast("Demande d'abord à l'administrateur de t'attribuer un personnage"); return; }
      revSceneKey = best.id;
      renderRevision();
      showScreen('revision');
    });
    $('#btn-edit-play').addEventListener('click', openPlayEditor);
    $('#btn-export-pdf').addEventListener('click', exportPlayPdf);
    $('#play-search-input').addEventListener('input', debounce((e) => renderPlaySearchResults(e.target.value), 200));

    // ---- Audio hors-ligne ----
    $('#btn-download-offline-audio').addEventListener('click', async () => {
      if (!currentPlay) return;
      const play = currentPlay;
      const downloadBtn = $('#btn-download-offline-audio');
      const progressBar = $('#offline-audio-progress');
      const progressFill = $('#offline-audio-progress-fill');
      downloadBtn.disabled = true;
      $('#btn-cancel-offline-audio').classList.remove('hidden');
      progressBar.classList.remove('hidden');
      progressFill.style.width = '0%';
      const { total, failed } = await downloadOfflineAudio(play, (done, totalLines, f, estimatedTotalBytes) => {
        progressFill.style.width = Math.round((done / totalLines) * 100) + '%';
        const est = estimatedTotalBytes != null ? ` (≈ ${formatBytes(estimatedTotalBytes)} au total estimés)` : '';
        $('#offline-audio-status').textContent = `Téléchargement… ${done}/${totalLines}${est}`;
      }, selectedOfflineLines(play));
      progressBar.classList.add('hidden');
      $('#btn-cancel-offline-audio').classList.add('hidden');
      downloadBtn.disabled = false;
      if (offlineDownloadCancelled) toast('Téléchargement annulé');
      else if (failed > 0) toast(`Téléchargement terminé, ${failed}/${total} répliques indisponibles`);
      else toast('Audio hors-ligne prêt');
      if (currentPlay && currentPlay.id === play.id) renderOfflineAudioStatus();
    });
    $('#btn-cancel-offline-audio').addEventListener('click', () => { offlineDownloadCancelled = true; });
    const setOfflineSelection = (set) => { offlineSelection = set; saveOfflineSelection(); renderOfflineSceneList(); updateOfflineSummary(); };
    $('#offline-sel-mine').addEventListener('click', () => {
      const mine = offlinePerScene.filter((p) => p.mine).map((p) => p.scene.id);
      if (!mine.length) { toast("Aucun personnage ne t'est attribué : coche les scènes à la main"); return; }
      setOfflineSelection(new Set(mine));
    });
    $('#offline-sel-all').addEventListener('click', () => setOfflineSelection(new Set(offlinePerScene.map((p) => p.scene.id))));
    $('#offline-sel-none').addEventListener('click', () => setOfflineSelection(new Set()));
    $('#btn-clear-offline-audio').addEventListener('click', async () => {
      if (!currentPlay) return;
      if (!confirm("Supprimer TOUT l'audio hors-ligne téléchargé pour cette pièce (toutes les scènes) ?")) return;
      await clearOfflineAudio(currentPlay.id);
      renderOfflineAudioStatus();
      toast('Audio hors-ligne supprimé');
    });
    $('#btn-delete-play').addEventListener('click', async () => {
      if (!confirm('Supprimer définitivement "' + currentPlay.title + '" pour toute la troupe ?')) return;
      await api('/api/plays/' + currentPlay.id, { method: 'DELETE' });
      currentPlay = null;
      await refreshLibrary();
      showScreen('library');
    });

    // ---- Revision ----
    $('#rev-scene-select').addEventListener('change', (e) => {
      revSceneKey = e.target.value; revRevealed.clear();
      renderRevLines(findSceneByKey(revSceneKey));
    });
    $('#rev-prev-scene').addEventListener('click', () => stepRevScene(-1));
    $('#rev-next-scene').addEventListener('click', () => stepRevScene(1));
    $('#rev-hide-others').addEventListener('change', () => renderRevLines(findSceneByKey(revSceneKey)));
    // Mode partenaire : preference memorisee sur l'appareil ; rend "masquer les autres" sans objet.
    const partnerBox = $('#rev-partner-mode');
    try { partnerBox.checked = localStorage.getItem('tr_partner_mode') === '1'; } catch (e) { /* tant pis */ }
    $('#rev-hide-others').disabled = partnerBox.checked;
    partnerBox.addEventListener('change', () => {
      try { localStorage.setItem('tr_partner_mode', partnerBox.checked ? '1' : '0'); } catch (e) { /* tant pis */ }
      $('#rev-hide-others').disabled = partnerBox.checked;
      revRevealed.clear();
      renderRevLines(findSceneByKey(revSceneKey));
    });

    // ---- Audio ----
    $('#audio-scene-select').addEventListener('change', (e) => {
      audioSceneKey = e.target.value; stopAudioPlayback(); clearAudioLoop(); renderAudioLines(findSceneByKey(audioSceneKey).scene);
    });
    $('#audio-prev-scene').addEventListener('click', () => stepAudioScene(-1));
    $('#audio-next-scene').addEventListener('click', () => stepAudioScene(1));
    $('#audio-hide-mine').addEventListener('change', () => { audioRevealed.clear(); renderAudioLines(findSceneByKey(audioSceneKey).scene); });
    $('#audio-hide-others').addEventListener('change', () => { audioRevealed.clear(); renderAudioLines(findSceneByKey(audioSceneKey).scene); });
    $('#audio-lines').addEventListener('click', (e) => {
      const card = e.target.closest('.line-card');
      if (!card || card.classList.contains('direction')) return;
      jumpToLine(card.dataset.lineId);
    });
    $('#audio-hear-line').addEventListener('click', async () => {
      if (!currentCueLine) return;
      const spoken = spokenTextOnly(currentCueLine.text);
      if (!spoken) { toast('Rien à écouter pour cette réplique'); return; }
      try { await playOnce(ttsText(currentCueLine.text), currentCueLine.character, currentCueLine.id); }
      catch (e) { speakLineBrowser(spoken, () => {}); }
    });
    $('#btn-goto-voices').addEventListener('click', () => {
      renderPlayScreen();
      showScreen('play');
      showPlayTab('audio');
      requestAnimationFrame(() => $('#voice-picker').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    });

    // ---- Enregistrements (voix reelles) ----
    $('#btn-goto-recordings').addEventListener('click', () => {
      renderRecordingsScreen();
      pushScreen('recordings');
    });
    $('#rec-scene-select').addEventListener('change', (e) => {
      recSceneKey = e.target.value;
      renderRecordingsLines(findSceneByKey(recSceneKey).scene);
    });
    $('#rec-prev-scene').addEventListener('click', () => stepRecScene(-1));
    $('#rec-next-scene').addEventListener('click', () => stepRecScene(1));

    // ---- Notes de mise en scene (metteur en scene / admin) ----
    $('#btn-goto-director-notes').addEventListener('click', () => {
      renderDirectorNotesScreen();
      pushScreen('directornotes');
    });
    $('#dn-scene-select').addEventListener('change', (e) => {
      dnSceneKey = e.target.value;
      renderDirectorNotesLines(findSceneByKey(dnSceneKey).scene);
    });
    $('#dn-prev-scene').addEventListener('click', () => stepDnScene(-1));
    $('#dn-next-scene').addEventListener('click', () => stepDnScene(1));
    $('#btn-export-director-notes-pdf').addEventListener('click', exportDirectorNotesPdf);

    // ---- Lecture a table ----
    $('#btn-goto-tableread').addEventListener('click', () => {
      fillTableReadScopeSelect(recSceneKey);
      tableReadScope = $('#tableread-scope-select').value;
      tableReadBlob = null;
      tableReadMarks = {};
      pushScreen('tableread');
      $('#tableread-audio').removeAttribute('src');
      $('#tableread-editor-panel').classList.add('hidden');
      renderTableReadLines();
    });
    $('#tableread-scope-select').addEventListener('change', (e) => {
      tableReadScope = e.target.value;
      tableReadBlob = null;
      tableReadMarks = {};
      $('#tableread-audio').removeAttribute('src');
      $('#tableread-editor-panel').classList.add('hidden');
      renderTableReadLines();
    });
    $('#tableread-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) loadTableReadMaster(file);
    });
    let tableReadRecorder = null, tableReadChunks = [], tableReadStream = null;
    $('#tableread-record').addEventListener('click', async () => {
      if (tableReadRecorder && tableReadRecorder.state === 'recording') { tableReadRecorder.stop(); return; }
      try {
        tableReadStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tableReadChunks = [];
        tableReadRecorder = new MediaRecorder(tableReadStream);
        tableReadRecorder.ondataavailable = (e) => { if (e.data.size > 0) tableReadChunks.push(e.data); };
        tableReadRecorder.onstop = () => {
          tableReadStream.getTracks().forEach((t) => t.stop());
          $('#tableread-record').textContent = '🎙️ Enregistrer maintenant dans le navigateur';
          $('#tableread-record-status').classList.add('hidden');
          loadTableReadMaster(new Blob(tableReadChunks, { type: 'audio/webm' }));
        };
        tableReadRecorder.start();
        $('#tableread-record').textContent = "⏹ Arrêter l'enregistrement";
        $('#tableread-record-status').textContent = 'Enregistrement en cours…';
        $('#tableread-record-status').classList.remove('hidden');
      } catch (e) { toast('Micro indisponible : ' + e.message); }
    });
    $('#btn-tableread-split').addEventListener('click', async () => {
      const entries = Object.entries(tableReadMarks).map(([lineId, start]) => ({ lineId, start }));
      entries.sort((a, b) => a.start - b.start);
      const segments = entries.map((e, i) => ({ lineId: e.lineId, start: e.start, end: entries[i + 1] ? entries[i + 1].start : undefined }));
      toast('Découpage en cours…');
      try {
        const result = await api(`/api/table-read/${currentPlay.id}/${tableReadScope}/split`, { method: 'POST', body: { segments } });
        const okCount = result.results.filter((r) => r.ok).length;
        toast(`${okCount}/${segments.length} répliques enregistrées`);
        tableReadMarks = {};
        renderTableReadLines();
      } catch (e) { toast('Échec du découpage'); }
    });

    $('#audio-play').addEventListener('click', () => {
      // Garde-fou : un double-tap declenchait deux lectures superposees (son sature/grésillant).
      if (audioPlaying) return;
      if (!userState.selectedCharacters.length) { toast("Demande d'abord à l'administrateur de t'attribuer un personnage"); return; }
      const found = findSceneByKey(audioSceneKey);
      if (!found) return;
      if (audioIndex < 0) audioIndex = 0;
      audioPlaying = true;
      audioPaused = false;
      updateAudioPauseButton();
      showAudioFloatingBar();
      advanceAudio(found.scene);
    });
    $('#audio-stop').addEventListener('click', stopAudioPlayback);
    $('#audio-stop-floating').addEventListener('click', stopAudioPlayback);
    $('#audio-pause').addEventListener('click', () => { audioPaused ? resumeAudioPlayback() : pauseAudioPlayback(); });
    $('#audio-continue').addEventListener('click', continueAfterCue);
    $('#audio-loop-start').addEventListener('click', () => {
      if (audioIndex < 0) { toast('Lance la lecture avant de marquer une boucle'); return; }
      loopStart = audioIndex;
      if (loopEnd != null && loopEnd <= loopStart) loopEnd = null;
      updateAudioLoopStatus();
    });
    $('#audio-loop-end').addEventListener('click', () => {
      if (audioIndex < 0) { toast('Lance la lecture avant de marquer une boucle'); return; }
      if (loopStart == null) { toast("Marque d'abord le début de la boucle"); return; }
      if (audioIndex <= loopStart) { toast('La fin doit être après le début'); return; }
      loopEnd = audioIndex;
      updateAudioLoopStatus();
    });
    $('#audio-loop-clear').addEventListener('click', clearAudioLoop);

    // ---- Stats ----
    $('#stats-scenes').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-goto]'); if (!btn) return;
      revSceneKey = btn.dataset.goto;
      renderRevision();
      showScreen('revision');
    });
  }

  // ================= Demarrage =================
  async function boot() {
    $('#screen-login').classList.remove('active');
    $('#shell').classList.remove('hidden');
    applyRoleVisibility();
    await refreshLibrary();
    showScreen('library');
    renderInstallTip();
    updateSyncBadge();
    if (navigator.onLine) flushPendingSync();
  }

  // ---- Suggestion d'installation en PWA (icone sur l'ecran d'accueil) ----
  function renderInstallTip() {
    const box = $('#install-tip');
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone || localStorage.getItem('tr_install_tip_dismissed') === '1') { box.classList.add('hidden'); return; }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    $('#install-tip-text').textContent = isIOS
      ? "📲 Installe l'appli : bouton Partager puis « Sur l'écran d'accueil »."
      : "📲 Installe l'appli sur ton téléphone : menu du navigateur (⋮) puis « Installer l'application » ou « Ajouter à l'écran d'accueil ».";
    box.classList.remove('hidden');
  }

  function init() {
    session = loadSession();
    user = session ? session.user : null;
    wireEvents();
    if (window.speechSynthesis) {
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    // Coquille hors-ligne : le SW cache l'app et les donnees de lecture en "reseau
    // d'abord" (toujours a jour en ligne, disponible hors connexion sinon). Il ne
    // touche jamais au cache audio hors-ligne, gere separement par l'appli.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(BASE + '/sw.js', { scope: BASE + '/' }).catch(() => {});
    }
    if (user) {
      if (user.mustChangePassword) { passwordChangeIsMandatory = true; $('#btn-cancel-password').classList.add('hidden'); $('#current-password-field').classList.add('hidden'); $('#shell').classList.remove('hidden'); $('#modal-change-password').classList.remove('hidden'); }
      else boot();
    } else {
      $('#screen-login').classList.add('active');
    }
  }
  init();
})();
