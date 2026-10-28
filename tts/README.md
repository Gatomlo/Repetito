# Synthèse vocale (100 % Node.js)

Les voix tournent **dans le serveur Node**, dans un thread séparé (`tts-worker.js`) : eSpeak-NG et ONNX Runtime en WebAssembly, embarqués dans `vendor/`. Aucun Python, aucun programme externe, aucun module natif, aucune clé API. Voir `piper-node.js` et `tts.js`.

## Voix

| Identifiant | Voix | Moteur | Remarque |
|---|---|---|---|
| `tom` | Tom, homme | Piper | rapide |
| `pierre` | Pierre, homme | Piper (modèle upmc) | rapide |
| `gilles` | Gilles, homme | Piper | rapide, qualité un peu plus basse |
| `siwis` | Siwis, femme | Piper | rapide, voix par défaut |
| `jessica` | Jessica, femme | Piper (modèle upmc) | rapide |

Les anciens identifiants `melo_*` (réglages déjà enregistrés) sont convertis automatiquement, voir `ALIASES` dans `tts.js`.

## Installation

Rien à faire à part `npm install` (express) et uploader le dossier `vendor/`. Au premier démarrage, le serveur télécharge les modèles manquants (Hugging Face) dans `tts/voices/`. Le journal affiche « Voix : téléchargement de … ».

Si le serveur n'a pas accès à Internet, copier à la main les fichiers `.onnx` et `.onnx.json` correspondants (dépôt `rhasspy/piper-voices`, dossier `fr/fr_FR`) dans `tts/voices/`.

## Ressources

Le calcul se fait dans un thread séparé qui ne ralentit pas le reste du serveur (ni les autres applis d'une passerelle). Il prend environ 0,5 s par seconde d'audio ; chaque réplique n'est calculée qu'une fois, le résultat étant mis en cache dans `tts/cache/`.

Mémoire : 500 à 800 Mo pendant l'usage, puis ~200 Mo après 5 minutes sans demande (le thread s'arrête et rend sa mémoire ; la demande suivante prend ~7 s le temps de tout recharger). Réglages facultatifs par variables d'environnement : `TTS_MAX_MODELS=1` (un seul modèle gardé en mémoire, ~100 Mo en moins) et `TTS_IDLE_MS` (délai avant arrêt, 300000 par défaut).

## Licences

Piper et ses voix : MIT / licences libres des jeux de données. eSpeak-NG : GPL-3.0 ; ONNX Runtime : MIT ; lamejs : LGPL-3.0 (voir `vendor/README.md`).

## Prononciation et préparation en avance

Le dictionnaire de prononciation d'une pièce est appliqué au texte avant la synthèse (`text-utils.js` côté serveur, `applyPronunciations` dans `public/app.js` : les deux doivent rester identiques, sinon les fichiers préparés en avance par `pregen.js` ne correspondent plus à ce que demandent les téléphones). `TTS_PREGEN=0` désactive la préparation automatique.
