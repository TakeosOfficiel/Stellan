# Local Agent

Local Agent est une application de développement assistée par une IA locale. Elle vise à offrir une boucle complète — analyser une demande, modifier un projet, exécuter ses tests et présenter le diff Git — sur Windows et Linux, sans dépendre d'un service d'inférence cloud.

La version 0.1 fournit :

- affiche la première installation et les redémarrages du runtime dans une fenêtre de progression compacte, séparée des réglages ;
- crée et démarre automatiquement Ollama dans Docker, sans fenêtre de terminal ;
- détecte la version d’Ollama et les modèles installés lorsque son API locale répond ;
- active WSL 2 à la demande lorsque le composant Windows manque ;
- détecte la RAM, le processeur et le GPU ;
- installe et pilote son propre Docker headless dans WSL 2 sous Windows, sans Docker Desktop ;
- classe les modèles par usage : rapide, général, code, vision ou génération d'images ;
- recommande les modèles adaptés tout en laissant le choix à l'utilisateur ;
- télécharge le modèle choisi avec une progression visible ;
- propose une dictée privée au microphone avec Whisper large-v3-turbo, téléchargé à la première utilisation puis conservé dans le cache local ;
- conserve les threads et messages dans une base SQLite locale ;
- importe chaque projet Windows dans un disque Linux privé de 20 Go initialement, extensible selon l’espace disponible, sans modifier le dossier original ;
- crée un Git worktree isolé pour chaque conversation principale ;
- calcule automatiquement des limites CPU/RAM prudentes selon le PC et garde le réseau des workers fermé par défaut ;
- permet au coordinateur de créer automatiquement 2 à 4 chats workers persistants et visibles sous leur thread parent, avec des fichiers exclusifs et une détection des chevauchements avant exécution ;
- planifie les générations dans le processus principal, affiche leur état en cours ou en attente et laisse changer de thread sans les arrêter ;
- accepte plusieurs messages par thread pendant une génération, avec file persistante, édition, suppression, priorité immédiate et historique des états ;
- exécute les lectures, recherches, écritures, opérations Git et commandes de l’agent dans un conteneur persistant par thread ;
- ouvre un vrai terminal PTY directement dans le conteneur persistant du thread ;
- crée sur demande un portail de prévisualisation HTTP/WebSocket lié au thread, accessible uniquement via une URL loopback temporaire ;
- permet à l'agent de lire, rechercher, modifier, tester et présenter le diff Git ;
- affiche en permanence à droite un espace projet avec Changements, Review, Portails, Fichiers et Terminal ;
- exporte explicitement le résultat d'une conversation vers un nouveau dossier Windows, sans métadonnées Git ni liens symboliques ;
- borne le contexte et les sorties d'outils pour rester utilisable avec de petits modèles.

Sous Windows, Docker Desktop et Podman Desktop ne sont pas nécessaires. Local Agent crée une distribution WSL 2 privée nommée `LocalAgentRuntime`, y installe un moteur de conteneurs sans interface et télécharge automatiquement les images nécessaires. Ollama, ses modèles, les disques des projets et les workers résident dans ce runtime privé. Ils utilisent toujours le CPU, la RAM, le GPU et le stockage physiques du PC, mais ne sont pas installés directement dans Windows. Le téléchargement d’un modèle reste déclenché depuis le catalogue afin que l’utilisateur choisisse sa taille.

## Première configuration et Ollama

Au démarrage, Local Agent détecte automatiquement le CPU, la RAM, le GPU et WSL 2. Au premier lancement, il télécharge un Alpine Linux minimal dont la somme SHA-256 est contrôlée, l’importe dans son dossier privé puis installe le moteur headless. Il crée ensuite en arrière-plan le conteneur `local-agent-ollama`, lié uniquement à `127.0.0.1:11435`. Aucun `ollama serve` ne doit être lancé manuellement et aucune console n’est ouverte.

Les modèles sont conservés dans le volume nommé `local-agent-ollama-models`, à l’intérieur du disque virtuel privé WSL, pas dans le dossier utilisateur `.ollama`. Ils occupent néanmoins de l’espace sur le disque du PC. Le premier démarrage télécharge l’image `ollama/ollama`; avec un GPU NVIDIA détecté, Local Agent tente automatiquement l’accès GPU puis revient au CPU si le passthrough GPU n’est pas disponible.

Si WSL 2 manque, **Activer WSL 2** lance la commande officielle Windows avec une demande UAC. Un redémarrage du PC peut être nécessaire. Local Agent reprend ensuite automatiquement la création de son runtime privé.

Une API joignable sans modèle n’est pas encore prête pour une conversation. Installer explicitement un modèle du catalogue ; les recommandations décrivent la mémoire détectée mais ne remplacent jamais le choix de l’utilisateur. La catégorie de catalogue et le modèle sélectionné sont conservés lors des nouvelles vérifications.

## Tester toute la version 0.1

1. Lancer `pnpm dev` et laisser Local Agent préparer WSL 2, son moteur privé et Ollama automatiquement.
2. Dans **Modèles**, vérifier l’API locale sur le port 11435, puis installer le modèle de démarrage ou un modèle de code compatible avec les outils.
3. Dans **Agent**, ouvrir un projet : sous Windows, l’application en importe une copie dans un disque privé de 20 Go et laisse l’original intact. Elle crée ensuite le premier worktree ; le panneau droit doit afficher ses fichiers. Envoyer une demande de modification, puis consulter **Changes** et **Review**.
4. Dans le panneau droit du thread actif, ouvrir **Terminal**, vérifier les programmes interactifs et le redimensionnement, puis fermer le terminal ; le worker doit rester disponible pour les outils suivants.
5. Ajouter un `index.html`, ouvrir **Portals**, puis vérifier l’aperçu Chromium, l’URL, la copie, l’ouverture, le mode appareil, le rechargement et l’arrêt. L’URL loopback reste accessible uniquement depuis le même ordinateur et n’est jamais restaurée au redémarrage.
6. Lancer deux conversations du même projet, passer de l’une à l’autre et vérifier leurs indicateurs indépendants. Chacune possède son propre worktree et sa propre file : elles doivent pouvoir progresser simultanément dans les limites automatiquement calculées.
7. Pendant une génération, vérifier que la réponse apparaît progressivement et que le bouton des nouveaux messages ramène en bas après un défilement manuel. Envoyer ensuite plusieurs messages : ils doivent rester dans la file visible au-dessus du compositeur, sans apparaître dans la conversation. Modifier puis supprimer une entrée, utiliser **Envoyer maintenant**, et ouvrir le bouton d’historique séparé. Fermer puis rouvrir l’application : la génération active devient interrompue, tandis que les messages encore en attente sont conservés et reprennent dans l’ordre. Une confirmation supplémentaire protège les changements non enregistrés lors de la suppression du thread.

Sous Windows, l'application échoue sans toucher au dossier original si l'import privé ou la création du worktree ne réussit pas. Elle ne propose aucun repli silencieux en mode direct. Le panneau **Ressources du projet** permet de conserver le calcul automatique ou de choisir CPU et RAM, puis d’agrandir le stockage selon l’espace réellement libre avec une marge de sécurité. La réduction à chaud est refusée pour protéger le système de fichiers. Sous Linux, le mode direct historique reste disponible après confirmation lorsqu'un worktree est impossible.

Sans projet ouvert, le chat est verrouillé et demande d’ouvrir ou créer un dossier. Il ne présente donc pas un bloc de code comme un changement réellement appliqué. Les aperçus du panneau **Fichiers** sont des lectures bornées de fichiers texte appartenant au thread actif ; les fichiers binaires sont refusés.

Dans l’application Agent, un projet est désormais obligatoire : le compositeur reste verrouillé tant qu’un dépôt Git ou un dossier vierge n’a pas été choisi. Le sélecteur natif permet de créer ce dossier. Lorsqu’une demande se découpe en fichiers indépendants, le coordinateur peut lancer automatiquement `create_workers`. Chaque worker devient un chat enfant persistant, visible sous le thread principal avec sa directive, ses outils et sa réponse. Les workers enfants n’exécutent pas de commandes et ne peuvent écrire que leurs fichiers déclarés. Un même fichier attribué deux fois fait échouer le plan avant toute modification. Leurs résumés reviennent au coordinateur, qui reprend ensuite la main pour relire et tester l’ensemble ; une erreur interrompt les autres workers du lot.

Le bouton microphone du compositeur enregistre au maximum une minute, convertit le son en mono 16 kHz et le transcrit localement. Le modèle quantifié Whisper large-v3-turbo représente environ 750 Mo à télécharger lors de la première dictée ; il n’est pas inclus dans l’installeur. Les usages suivants fonctionnent depuis le cache sans connexion. Une normalisation déterministe comprend notamment « nouvelle ligne », « ouvre accolade » et « point-virgule », sans confier le texte dicté à un service cloud ni à un second LLM susceptible d’en changer le sens.

Une seule génération reste permise par conversation, mais les conversations principales possèdent des files indépendantes. Les workers enfants d’un même coordinateur respectent la limite calculée depuis le matériel ou choisie par l’utilisateur. Tous les outils de l’agent s’exécutent dans le conteneur persistant du thread. Sous Windows, les worktrees vivent dans le disque privé extensible du projet ; le bouton **Exporter ce projet** crée volontairement une copie Windows du résultat choisi. Le quota disque est global au projet et à ses worktrees, tandis que les limites CPU/RAM sont appliquées à chaque conteneur worker.

La file d’un thread appartient également au processus principal et à SQLite, pas au renderer. Chaque message est persisté avant confirmation, mais reste séparé de la conversation tant que son exécution n’a pas réellement commencé. Un seul message de ce thread peut être exécuté à la fois et les demandes futures ne sont jamais injectées dans le contexte du message courant. **Envoyer maintenant** place l’entrée choisie en tête, interrompt proprement la génération courante, puis la démarre ; les autres entrées gardent leur ordre. À la fermeture, seul le run réellement actif est marqué interrompu et les entrées en attente restent reprises au prochain lancement.

Le renderer ne choisit jamais le dossier du terminal : il transmet uniquement l’identifiant du thread actif, et le processus principal résout le worktree enregistré. Le PTY exécute `docker exec` dans le worker du thread ; fermer l’onglet termine seulement la session du shell, pas le conteneur persistant. Le conteneur et son volume privé sont supprimés avec le thread.

Le portail propose deux sources privées : il peut servir directement le `index.html` du projet dans l’aperçu Chromium intégré, ou se connecter à un serveur déjà lancé sur un port numérique. Dans ce second mode, Electron fixe la cible à `127.0.0.1` ou `::1`, démarre un proxy aléatoire lié à `127.0.0.1`, filtre les requêtes et vérifie le serveur à travers le proxy avant d’afficher l’état prêt. Le portail est éphémère, peut expirer après une durée choisie et est nettoyé à l’arrêt, à la suppression du thread et à la fermeture. Les accès LAN et public restent désactivés sans véritable tunnel et contrôles d’accès ; voir [`docs/PORTALS.md`](docs/PORTALS.md).

## Développement

Prérequis de développement : Node.js récent, pnpm 12 et Git. Sous Windows, WSL 2 doit être disponible pour tester le runtime privé ; sous Linux, Docker Engine reste utilisé directement.

```bash
pnpm install
pnpm dev
```

Vérifications disponibles :

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Paquets de distribution

Les paquets de la version courante sont générés dans `dist/`. En l'absence d'une icône de marque, la configuration utilise volontairement l'icône Electron par défaut.

```bash
# Répertoire non empaqueté pour la plateforme hôte (validation rapide)
pnpm package:dir

# AppImage et paquet deb Linux
pnpm package:linux

# Installateur NSIS Windows
pnpm package:windows

# Toutes les cibles configurées pour la plateforme hôte
pnpm package
```

Sur Windows, la commande utilise directement les outils natifs. Sur Linux ou macOS, Wine 2.0 ou plus récent avec la prise en charge 32 bits est requis (`wine32:i386` sur Debian) ; le script vérifie sa présence avant de lancer `electron-builder` et indique l'alternative officielle `electronuserland/builder:wine` s'il manque. Wine est nécessaire même sans certificat : `electron-builder` l'utilise pour modifier les ressources de l'exécutable puis exécute un installateur NSIS 32 bits temporaire afin de générer et extraire le programme de désinstallation. Les commandes reconstruisent toujours l'application avant de lancer `electron-builder` et désactivent la publication implicite.

La signature est facultative pour la version 0.1. Sans certificat, les artefacts sont **non signés** : Windows affiche alors un éditeur inconnu et peut déclencher Microsoft Defender SmartScreen. Ils ne doivent pas être présentés comme des builds de production authentifiés.

Pour signer l'installateur Windows, fournir le certificat et son mot de passe à `electron-builder`, puis exécuter exactement :

```bash
CSC_LINK=/chemin/vers/certificat.p12 \
CSC_KEY_PASSWORD='mot-de-passe-du-certificat' \
pnpm package:windows
```

`CSC_LINK` accepte aussi une URL ou un certificat encodé en base64 selon la documentation d'`electron-builder`. Ne jamais committer le certificat ni son mot de passe. Les paquets Linux produits ici ne sont pas signés ; leur signature et celle d'un dépôt de paquets doivent être gérées séparément lors de la publication.

Sans `CSC_LINK` ou `WIN_CSC_LINK`, une construction croisée désactive explicitement la recherche automatique de certificat et annonce qu'elle produit un artefact non signé. Pour produire et valider un installateur signé, utiliser un vrai certificat de signature de code, de préférence sur Windows. Un build Linux/macOS permet de contrôler la structure et le contenu de l'artefact, mais son installation, sa désinstallation et les avertissements SmartScreen doivent encore être testés sur Windows.

Le plan d'architecture, les limites de sécurité et les étapes de réalisation sont décrits dans [`docs/PLAN.md`](docs/PLAN.md).

La construction CI native Windows/Linux et le téléversement de ses artefacts non signés sont décrits dans [`docs/CI.md`](docs/CI.md).
