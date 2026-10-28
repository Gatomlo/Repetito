# Répétito — CLAUDE.md

**Objectif** : appli web mobile-first pour apprendre ses répliques de théâtre en troupe (import du texte, révision texte caché, mode audio TTS, enregistrements des comédiens, progression). Voir [README.md](README.md) pour le détail fonctionnel.

**Stack** : Node ≥18 + Express (`server.js`, exporte l'app, ne démarre que si lancé directement), front vanilla JS/HTML/CSS dans `public/` (PWA : `sw.js`, `manifest.json`), stockage JSON dans `data/db.json` (pas de BDD externe).

**Fichiers clés**
- `server.js` : API (auth admin/user, pièces `/api/plays`, état utilisateur `/api/state`, enregistrements, lecture à table).
- `public/app.js`, `index.html`, `style.css` : toute l'interface.
- `text-utils.js` : parsing/découpage du texte importé.
- TTS 100 % Node : `tts.js`, `tts-worker.js`, `piper-engine.js`, `piper-node.js`, `espeak-fr.js`, `audio-encode.js`, `pregen.js` ; libs livrées dans `vendor/` (onnxruntime, espeak, lamejs), modèles de voix téléchargés dans `tts/voices/` (ignorés par git, voir `tts/README.md`).
- `mailer.js` : mail de réinitialisation de mot de passe (sendmail ou SMTP via variables `SMTP_*`, `MAIL_FROM`).

**Données non évidentes** : `data/` (db.json, backups, recordings) et `tts/{bin,voices,cache}` sont ignorés par git — à sauvegarder séparément. Chaque utilisateur a sa progression/annotations (`/api/state/:playId`).

**Commandes** : `npm install`, `npm start` (http://localhost:3000), `npm run setup-tts` (ffmpeg, enregistrements).

**Déploiement** : serveur Node seul ou monté sous `/repetito` derrière `../node-gateway` ; HTTPS requis pour PWA/Wake Lock. Dépôt GitHub : `Gatomlo/Repetito`.

**Méthode** : tester par API/ligne de commande avant les captures ; garder ce fichier à jour si l'architecture ou le déploiement change.
