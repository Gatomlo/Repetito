# Bibliothèques embarquées

Ces fichiers sont livrés **avec l'appli** (à uploader avec le reste) : le serveur n'a rien d'autre à installer que `express` (`npm install`). Ils servent à la synthèse vocale, voir `vendor-libs.js`.

| Dossier | Contenu | Licence |
|---|---|---|
| `onnxruntime/` | ONNX Runtime Web 1.30.0 (WebAssembly) : exécute les modèles de voix | MIT |
| `espeak/` | eSpeak-NG compilé en WebAssembly (`@echogarden/espeak-ng-emscripten` 0.3.5) : phonétique française | GPL-3.0 |
| `lamejs/` | lamejs (fork `@breezystack/lamejs` 1.2.7) : encodeur MP3 en JavaScript | LGPL-3.0 |

Total : environ 38 Mo.
