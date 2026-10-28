# Répétito — apprendre son texte de théâtre

Application web mobile-first pour apprendre ses répliques en troupe : import du texte, sélection du/des personnage(s), révision texte caché/révélé avec annotations de mise en scène, entraînement audio (synthèse vocale + pause à ton tour), suivi de progression. Plusieurs membres de la troupe peuvent utiliser la même pièce importée, chacun avec sa progression et ses annotations séparées.

## Démarrer en local

```bash
npm install
npm start
```

Le mode audio (synthèse vocale) tourne **entièrement dans le serveur Node**, sans Python, sans module natif et sans autre installation qu'`npm install` (express) : voix françaises d'homme et de femme (Piper : Tom, Pierre, Gilles, Siwis, Jessica). Les bibliothèques nécessaires sont livrées dans le dossier `vendor/`, et au premier démarrage le serveur télécharge tout seul les modèles de voix (~60 à 75 Mo par voix) — voir [tts/README.md](tts/README.md). Sans ces modèles, l'appli fonctionne quand même, avec la voix du navigateur de chaque téléphone en secours (moins homogène).

Puis ouvrir http://localhost:3000 (accessible aussi depuis un téléphone sur le même réseau Wi-Fi via `http://<IP-de-l-ordinateur>:3000`, mais voir la remarque HTTPS plus bas pour l'installation en PWA et l'anti-verrouillage d'écran).

Les données (pièces, utilisateurs, annotations, progression) sont stockées dans `data/db.json`, créé automatiquement au premier lancement. Pense à sauvegarder ce fichier régulièrement une fois la troupe active.


## Comptes et rôles

L'accès se fait par identifiant + mot de passe, avec deux rôles :
- **Administrateur** : accès complet — importer/modifier/supprimer des pièces, créer des comptes, choisir qui a accès à quelle pièce (partage nominatif, panneau "👥 Partage" sur l'écran d'une pièce), gérer les enregistrements de toute la troupe (écran dédié + découpage de lecture à table).
- **Utilisateur** : ne voit que les pièces qui lui ont été partagées par un admin, mais y a un accès complet (révision, mode audio, annotations, enregistrement personnel de ses propres répliques).

Seul un admin peut créer des comptes (écran "🔑 Gérer les comptes", accessible depuis la Bibliothèque). Il choisit juste un identifiant et un rôle ; **la personne définit elle-même son mot de passe à sa toute première connexion** (l'admin n'a jamais à connaître ou transmettre de mot de passe). Le tout premier compte créé sur une installation neuve devient automatiquement administrateur.

## Comment ça marche

1. **Importer une pièce** (admin) : coller le texte brut (personnage en MAJUSCULES suivi de `.`, `:` ou `-`, puis la réplique). L'appli détecte automatiquement actes, scènes, personnages et didascalies (texte entre parenthèses).
2. **Corriger le découpage** (admin) : l'étape d'aperçu permet de changer le type de chaque ligne (réplique / didascalie / nouvelle scène / nouvel acte), le nom du personnage, fusionner deux lignes mal coupées, ou en supprimer/ajouter. Le texte théâtral n'est jamais parfaitement homogène — cette étape rattrape les cas particuliers (répliques avec indication de jeu type `HARPAGON, à part.`, formats différents, etc.).
3. **Partager et distribuer les rôles** : l'admin partage la pièce aux comptes concernés, puis attribue à chacun le(s) personnage(s) qu'il joue (panneau "🎭 Distribution des rôles" sur l'écran de la pièce). Ce n'est plus l'utilisateur qui choisit son propre rôle.
4. **Mode révision** : les répliques du personnage choisi sont masquées (nom visible, texte à révéler au tap) ; celles des autres restent visibles pour le contexte. Chaque réplique a une zone de note libre (déplacement, geste, intention) visible même quand le texte est caché, et 3 boutons de statut (à revoir / en cours / acquise).
5. **Mode audio** : lit à voix haute (voix Piper côté serveur — même rendu pour tout le monde, secours automatique sur la voix du navigateur si le serveur est injoignable) les répliques des autres personnages, puis s'arrête automatiquement à ton tour en affichant ton annotation — tu dis ta réplique et tu appuies sur "Continuer" (ou reprise automatique après un délai réglable). Une case "Dire aussi mes répliques" permet d'inverser ce comportement pour une écoute continue de toute la scène, sans pause. Un bouton "Écouter cette réplique" permet d'entendre ta propre réplique avant ou après l'avoir dite, pour t'exercer/te corriger. Touche n'importe quelle réplique dans la liste pour reprendre la lecture à cet endroit précis. 5 voix différentes (de très grave à très aiguë) peuvent être assignées par personnage. Le texte entre parenthèses au milieu d'une réplique (ex. `Alors ? (Il hoche la tête.) Inquiète, elle insiste.`) est traité comme une didascalie : affiché en italique, jamais lu à voix haute. La toute première réplique d'une scène prend 3-4s à générer, les suivantes sont instantanées (mise en cache).
6. **Voix réelles des comédiens** : l'admin peut enregistrer n'importe quelle réplique depuis "🎙️ Gérer les enregistrements" (et importer/découper une lecture à table complète). Chaque utilisateur peut aussi, depuis "🎙️ Enregistrer mes répliques", s'enregistrer lui-même — mais uniquement sur les répliques du personnage qui lui a été attribué. Dans les deux cas, l'enregistrement remplace la synthèse pour toute la troupe dès qu'il est envoyé.
7. **Statistiques** : pourcentage de répliques acquises et liste des scènes à retravailler en priorité (les moins avancées en premier).

## Partage avec la troupe

Une pièce importée par l'admin n'est visible par les utilisateurs standards que s'il la leur partage explicitement (panneau "👥 Partage" sur l'écran de la pièce, partage nominatif compte par compte). Chaque personne a ses propres personnages sélectionnés, annotations et statuts de progression, stockés séparément côté serveur.

## Héberger en ligne (pour un accès depuis les téléphones de la troupe)

L'app est un simple serveur Node/Express sans base de données externe : n'importe quel hébergeur Node convient.

**Hébergement ne permettant qu'une seule application Node.js** (ex. Infomaniak) : `server.js` exporte l'app Express (`module.exports = app`) et ne démarre son propre serveur que si on le lance directement (`node server.js`). Il peut donc être monté sous un sous-dossier par une passerelle unique aux côtés d'autres outils — voir `../node-gateway/README.md`. Aucun chemin n'est codé en dur côté client (le préfixe de montage est déduit automatiquement au chargement), donc rien à changer entre un déploiement seul (racine) et un déploiement derrière la passerelle (`/repetito`).

Important : **l'installation en PWA (icône sur l'écran d'accueil) et l'anti-verrouillage d'écran (Wake Lock) exigent une connexion HTTPS** — ça ne marche de façon fiable qu'une fois déployé avec un vrai certificat (ou en local via `localhost`), pas en accédant au PC par IP locale en `http://`.

**Option simple (Render.com, Railway, Fly.io — offres gratuites/pas chères)** :
1. Pousser ce dossier sur un dépôt Git (GitHub/GitLab).
2. Créer un nouveau "Web Service" à partir du dépôt (Linux).
3. Commande de build : `npm install` — commande de démarrage : `npm start`.
4. Attention : sur ces plateformes le système de fichiers est souvent éphémère (les données peuvent être effacées à chaque redéploiement). Si le service le permet, monter un "disque persistant" sur `data/` et `tts/`. Vérifier surtout la **RAM disponible** : la synthèse vocale demande 500 à 800 Mo pendant l'usage.

**Option VPS perso (le plus fiable pour la durée, recommandée si vous utilisez la synthèse vocale)** :
1. Copier le dossier sur le serveur (Linux), `npm install` (puis, seulement si tu utilises l'enregistrement des voix des comédiens, `npm run setup-tts` pour installer ffmpeg).
2. Lancer avec un gestionnaire de process comme `pm2` : `pm2 start server.js --name repliques`.
3. Mettre un reverse proxy (nginx/Caddy) devant avec HTTPS (Let's Encrypt) pour un accès mobile confortable (obligatoire pour la PWA et le Wake Lock, voir ci-dessus).
4. Sauvegarder régulièrement `data/db.json`.

## Limites connues (bonus / futures évolutions)

- Le parseur est une aide automatique, pas magique : les cas ambigus (réplique avec indication du type `NOM, en aparté.` — avec une virgule) doivent être corrigés à la main dans l'aperçu d'import — c'est prévu pour ça. Le format `NOM (indication).` est en revanche bien reconnu.
- Les enregistrements vocaux (mode audio) restent dans le navigateur de chaque personne (IndexedDB) : pas de synchronisation entre appareils pour l'instant.
- Sans les modèles de voix (voir `tts/README.md`), ou si le serveur de synthèse vocale est indisponible, le mode audio bascule automatiquement sur la voix du navigateur de chaque téléphone (moins homogène mais fonctionnel).
- Les voix tournent dans un thread Node séparé (ONNX Runtime + eSpeak-NG en WebAssembly, embarqués dans `vendor/`, ~38 Mo) : la RAM monte à 500-800 Mo pendant l'usage et retombe à ~200 Mo après 5 minutes d'inactivité ; compter ~60 à 75 Mo de disque par voix téléchargée. Variables facultatives : `TTS_MAX_MODELS=1` (économise ~100 Mo, un peu plus lent si plusieurs voix alternent) et `TTS_IDLE_MS` (délai d'inactivité avant libération de la mémoire).


## Sécurité, sauvegardes et préparation des voix

- **Limite de tentatives de connexion** : au-delà de 8 échecs sur un même compte (ou 30 depuis une même adresse) en 15 minutes, la connexion et la récupération par code sont bloquées 15 minutes. Le compteur est en mémoire (remis à zéro au redémarrage).
- **Sauvegardes** : le serveur copie `data/db.json` dans `data/backups/` toutes les 6 heures (une copie par jour, 7 jours conservés). Le bouton « Télécharger une sauvegarde » (écran Comptes, administrateur) donne une copie à ranger ailleurs, sans les sessions ouvertes. **Restauration** : arrêter le serveur, remplacer `data/db.json` par le fichier voulu, redémarrer. Les enregistrements audio (`data/recordings/`) ne sont pas inclus.
- **Dictionnaire de prononciation** (écran Pièce, administrateur ou metteur en scène) : corrige les mots que la voix lit mal (« Gilles » → « Jile »). Appliqué par le serveur et les téléphones ; les fichiers hors-ligne concernés sont marqués « ancienne voix » et se remplacent par « Mettre à jour ».
- **Préparation des voix en tâche de fond** : à l'import ou à la modification d'une pièce (et quand le dictionnaire change), le serveur génère l'audio de toutes les répliques pour les voix par défaut et celles choisies par les comédiens : la première écoute est alors instantanée. Bouton « Préparer les voix maintenant » (administrateur). Désactivable avec la variable d'environnement `TTS_PREGEN=0`. Pendant la préparation, la mémoire reste à son niveau haut (le thread vocal ne s'arrête qu'après 5 minutes d'inactivité).
- **Import de fichiers** : à l'import d'une pièce, on peut choisir un fichier Word (.docx), PDF (avec du texte sélectionnable, pas un scan) ou texte. Le texte est extrait dans le navigateur (lecteur PDF : `public/vendor/pdfjs`, licence Apache 2.0) puis affiché pour vérification avant l'analyse.

## Rôles et droits

- **Utilisateur (comédien)** : voit ses pièces, révise, écoute, annote. Ne voit ni l'onglet « Mise en scène » ni l'onglet « Gestion » de l'écran Pièce.
- **Metteur en scène** : en plus, onglets « Mise en scène » (progression de la troupe, notes partagées, prononciation) et « Gestion », limité à **sa troupe** : partager une pièce avec l'une de ses troupes (sans pouvoir retirer le partage), distribuer les rôles aux membres de la troupe de la pièce, modifier le texte. Il ne peut ni importer ou supprimer une pièce, ni gérer les comptes, les troupes ou les sauvegardes.
- **Administrateur** : tout, y compris import/suppression de pièces, comptes, troupes, sauvegardes et préparation des voix.

Ces droits sont vérifiés côté serveur (un compte qui appellerait directement l'API reçoit une erreur 403), pas seulement masqués dans l'interface.

## Réinitialisation du mot de passe par mail

Chaque compte peut avoir une adresse mail (facultative, à ajouter à la création ou dans sa fiche, écran Comptes). Avec une adresse enregistrée, la personne peut réinitialiser elle-même son mot de passe depuis l'écran de connexion (« Mot de passe oublié ? ») : elle reçoit un code à 6 chiffres par mail, valable 30 minutes et à usage unique.

Sans adresse mail enregistrée pour un compte, seul l'administrateur peut réinitialiser son mot de passe (bouton « Réinitialiser le mot de passe » dans sa fiche).

**Envoi du mail** (`mailer.js`) : deux modes, aucun identifiant dans le code, tout se règle par variables d'environnement sur le serveur.

- **Par défaut (aucune configuration)** : passe par le programme `sendmail` déjà présent sur l'hébergement, comme le fait `mail()` en PHP — pas de boîte mail ni de mot de passe à créer. Fonctionne seulement si ce programme est accessible depuis le processus Node (pas garanti sur tous les hébergements, y compris s'il l'est pour PHP sur le même compte). `MAIL_FROM` (optionnelle mais recommandée, une adresse de ton propre domaine) fixe l'expéditeur ; sans elle, les mails partent de `repetito@localhost` et finissent souvent en spam. `SENDMAIL_PATH` force un chemin précis si le programme n'est pas trouvé automatiquement.
- **Via une vraie boîte mail (SMTP)**, si `SMTP_HOST` est défini :

  | Variable | Rôle | Exemple |
  |---|---|---|
  | `SMTP_HOST` | Serveur SMTP | `mail.infomaniak.com` |
  | `SMTP_PORT` | Port SMTP | `587` |
  | `SMTP_SECURE` | `1` pour du TLS direct (port 465), sinon absent | — |
  | `SMTP_USER` | Identifiant SMTP (souvent l'adresse mail complète) | `repetito@tondomaine.be` |
  | `SMTP_PASS` | Mot de passe de cette boîte mail | — |
  | `MAIL_FROM` | Adresse d'expédition (sinon `SMTP_USER`) | `repetito@tondomaine.be` |

Si l'envoi échoue dans les deux cas (programme `sendmail` introuvable, ou SMTP mal configuré), la demande de code répond avec un message clair (l'administrateur reste la solution de secours).
