# Plan de réalisation

## 1. Vision

Construire une application de bureau Windows et Linux capable de :

- discuter avec une IA exécutée localement ;
- comprendre, lire et modifier un dépôt de code ;
- lancer des commandes et des tests ;
- isoler chaque tâche dans un environnement dédié ;
- présenter les changements Git ;
- conserver et reprendre les conversations ;
- adapter les modèles et les limites de ressources au matériel disponible.

Après l'installation d'un modèle, le cœur du produit doit rester utilisable sans connexion Internet.

## 2. Architecture

```text
┌──────────────────────────────────────────┐
│ Application Electron                    │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Interface React                    │  │
│  │ Chat │ Fichiers │ Diff │ Terminal │  │
│  └─────────────────┬──────────────────┘  │
│                    │ IPC sécurisé         │
│  ┌─────────────────▼──────────────────┐  │
│  │ Processus agent                    │  │
│  │ contexte │ outils │ permissions    │  │
│  └──────┬───────────────┬─────────────┘  │
└─────────┼───────────────┼────────────────┘
          │               │
          ▼               ▼
┌─────────────────┐  ┌─────────────────────┐
│ Ollama          │  │ Environnement tâche │
│ Modèle local    │  │ natif ou conteneur  │
└─────────────────┘  └──────────┬──────────┘
                                ▼
                     Fichiers │ Git │ Tests
```

### Choix techniques initiaux

| Domaine | Choix |
| --- | --- |
| Application | Electron |
| Interface | React et TypeScript |
| Styles | Tailwind CSS |
| État de l'interface | Zustand |
| Agent | TypeScript dans un processus séparé |
| Inférence | Ollama derrière une interface interchangeable |
| Dictée | Whisper large-v3-turbo quantifié via Transformers.js |
| Persistance | SQLite avec migrations |
| Terminal | xterm.js |
| Isolation | Docker ou Podman et Git worktrees |
| Validation | Zod |
| Tests | Vitest et Playwright |
| Monorepo | pnpm workspaces |

Electron est retenu pour privilégier une implémentation cohérente en TypeScript et un accès mature aux fichiers, terminaux et processus sur Windows et Linux. Le moteur d'agent reste découplé de l'interface afin de permettre un futur client terminal ou web.

## 3. Organisation du dépôt

```text
local-agent/
├── apps/
│   └── desktop/
│       ├── main/                 # Processus Electron
│       ├── preload/              # API limitée exposée à React
│       └── renderer/             # Interface React
├── packages/
│   ├── agent/                    # Boucle de décision et contexte
│   ├── models/                   # Ollama et futurs fournisseurs
│   ├── tools/                    # Fichiers, terminal, Git, recherche
│   ├── runtime/                  # Exécution native, Docker et Podman
│   ├── workspaces/               # Projets, worktrees et tâches
│   ├── storage/                  # SQLite et migrations
│   ├── permissions/              # Politiques de sécurité
│   └── shared/                   # Types et contrats communs
├── tests/
│   ├── integration/
│   └── e2e/
├── docs/
└── scripts/
```

Les packages ne seront créés que lorsqu'une tranche fonctionnelle les nécessite. Cette arborescence définit les frontières visées, pas une obligation de créer des modules vides.

## 4. Boucle de l'agent

```text
Demande
   │
   ▼
Analyse du contexte
   │
   ▼
Choix d'un outil ──────▶ Vérification de la politique
   │                              │
   ▼                              ▼
Exécution ◀────────────── Autorisation éventuelle
   │
   ▼
Observation du résultat
   │
   ├──▶ nouvelle action
   └──▶ réponse finale
```

La boucle est une machine à états explicite, annulable et persistée sous forme d'événements. Une limite d'étapes empêche les boucles infinies.

### Outils initiaux

- lister et lire des fichiers ;
- rechercher précisément avec `rg` ;
- appliquer des modifications contrôlées ;
- exécuter une commande ;
- lancer les tests ;
- consulter le statut et le diff Git ;
- annuler les modifications produites par l'agent.

Les opérations déterministes restent confiées aux outils classiques plutôt qu'au modèle.

## 5. Environnements de travail locaux

Chaque thread peut posséder un Git worktree indépendant et, lorsque disponible, un conteneur. Le cycle de vie d'un environnement est `création`, `actif`, `suspendu`, `terminé` ou `erreur`.

Trois cibles sont prévues :

1. **Runtime privé WSL 2** : cible principale et automatique sous Windows, sans Docker Desktop.
2. **Podman local** : backend compatible à stabiliser après Docker.
3. **Distant** : évolution permettant d'utiliser un autre PC ou un serveur personnel.

Le conteneur worker ne reçoit pas le socket du moteur, les secrets du système ni un montage complet du disque hôte. Son accès réseau est fermé par défaut et ses ressources sont limitées. Ollama s’exécute dans un conteneur séparé et partage ses modèles entre les threads via le volume `local-agent-ollama-models`, stocké dans le disque virtuel WSL privé.

## 6. Adaptation au matériel

L'assistant de démarrage détecte :

- le système d'exploitation, le processeur et la RAM ;
- le GPU et la VRAM lorsqu'ils sont détectables ;
- Ollama, Git, Docker et Podman ;
- les modèles déjà installés.

Il propose ensuite un profil ajustable :

| Profil | Modèle indicatif |
| --- | --- |
| Minimal | 3B à 7B quantifié |
| Standard | 7B à 14B |
| Puissant | 14B à 32B |
| Expert | Configuration manuelle |

La sélection finale dépendra des modèles disponibles et de mesures locales, pas uniquement de leur nombre de paramètres. Un seul gros modèle est chargé à la fois. Un petit modèle rapide ne sera ajouté que si les mesures montrent un bénéfice réel.

## 7. Persistance

SQLite conserve au minimum :

- les projets ;
- les threads et leur environnement ;
- les messages ;
- les appels d'outils et leurs résultats ;
- les autorisations ;
- les paramètres matériels et modèles.

Les secrets sont placés dans le coffre sécurisé du système d'exploitation, jamais dans SQLite. Les migrations sont versionnées et testées.

## 8. Sécurité

- isolation stricte entre le renderer Electron et Node.js ;
- `contextIsolation` activé et `nodeIntegration` désactivé ;
- API preload minimale et contrats IPC validés avec Zod ;
- restriction des opérations aux projets explicitement ouverts ;
- refus des écritures hors projet et journalisation des outils, commandes et résultats ;
- aucun secret injecté automatiquement dans les conteneurs ;
- processus agent séparé pour éviter qu'un calcul bloque l'interface.

L’application ne promet pas une sécurité de machine virtuelle : le projet est monté en lecture-écriture dans le worker afin que les modifications restent visibles sur l’hôte.

## 9. Phases de réalisation

### Phase 1 — Tranche verticale

- monorepo TypeScript et application Electron ;
- fenêtre React fonctionnelle sous Windows et Linux ;
- détection et diagnostic d'Ollama ;
- sélection d'un modèle installé ;
- conversation avec réponse en streaming ;
- stockage local des paramètres et conversations ;
- tests unitaires du fournisseur Ollama et test de démarrage de l'interface.

### Phase 2 — Agent de développement

- ouverture explicite d'un projet ;
- lecture et recherche des fichiers ;
- appels d'outils structurés ;
- exécution contrôlée de commandes ;
- modification du code ;
- statut et diff Git ;
- annulation d'une génération en cours.

À la fin de cette phase, le produit fournit la boucle utile complète : demande, analyse, modification, tests et diff.

État actuel : l’ouverture d’un projet crée immédiatement un thread et son environnement. Le chat reste au centre tandis qu’un workbench permanent à droite regroupe les changements Git, la review du diff, les portails, l’explorateur de fichiers texte et le terminal du thread actif. Sans projet, les demandes de modification sont redirigées vers l’ouverture explicite d’un dossier plutôt que simulées par un simple bloc de code dans le chat.

Le coordinateur dispose aussi de `create_workers` pour déléguer automatiquement deux à quatre sous-tâches. Chaque worker possède désormais un chat enfant durable rattaché au thread principal, avec sa directive, son exécution, ses outils et sa réponse consultables séparément. Chaque worker reçoit une liste exclusive de fichiers, les commandes restent réservées au coordinateur et tout chevauchement est rejeté avant le lancement. Les résumés sont renvoyés au coordinateur après l’exécution parallèle. Des worktrees enfants et une fusion Git interactive pourront remplacer le partage contrôlé du worktree parent dans une évolution ultérieure.

La dictée utilise directement le microphone du renderer avec une permission Electron limitée à l’audio de la frame principale. Le PCM borné est transmis au processus principal, où Transformers.js exécute Whisper large-v3-turbo quantifié. Les poids sont téléchargés à la demande dans le dossier utilisateur puis réutilisés hors ligne ; ils ne gonflent pas l’installeur. Une petite normalisation de commandes vocales de code reste déterministe afin de ne pas réinterpréter la demande.

### Phase 3 — Isolation locale

- Git worktree par thread ;
- runtime WSL 2 headless géré par l’application sous Windows ;
- Docker Engine direct sous Linux ;
- runtime Podman sous Linux ;
- limites de ressources et politiques réseau ;
- suspension, reprise et nettoyage des environnements.

État actuel : les worktrees sont actifs. Sous Windows, l’application télécharge et vérifie Alpine, importe la distribution `LocalAgentRuntime`, installe Moby/Docker Engine sans interface et pilote toutes ses commandes via `wsl.exe`. Sous Linux, Docker Engine direct reste utilisé. Un profil persistant par projet configure l’image, les limites CPU/RAM, le réseau et le plafond de workers. Chaque thread possède un conteneur persistant durci ; lectures, recherches, écritures, Git, commandes et terminal y sont exécutés. Un volume `local-agent-worker-data-<thread>` conserve ses données internes et est supprimé avec le thread. Le projet reste un montage du worktree hôte. Aucune limite disque dure portable n’est annoncée.

### Phase 4 — Fiabilité et expérience

- terminal intégré ;
- reprise après fermeture ou erreur ;
- compression des longues conversations ;
- diagnostic et recommandation de modèle ;
- gestion des téléchargements et de l'espace disque ;
- accessibilité et raccourcis clavier.

État actuel du terminal : xterm.js est relié à un PTY `node-pty` qui lance `docker exec -it` dans le worker persistant du thread. Fermer le terminal arrête le shell sans supprimer le worker. Le conteneur et son volume privé sont nettoyés lors de la suppression explicite du thread. L’historique du terminal reste hors périmètre.

État actuel des portails : un thread de projet actif peut servir automatiquement son `index.html` dans un aperçu Chromium intégré ou créer un proxy HTTP/WebSocket vers un serveur local déjà lancé. Les deux modes restent liés uniquement à `127.0.0.1` sur un port aléatoire. Le renderer transmet seulement le thread, la source, une durée bornée et éventuellement le port cible ; Electron valide le propriétaire, la frame, le thread et l’environnement. Le serveur statique bloque les sorties du projet, y compris par lien symbolique, tandis que le proxy fixe l’amont à `127.0.0.1` ou `::1`, assainit les requêtes et contrôle sa disponibilité. L’URL peut être copiée, ouverte, prévisualisée avec plusieurs formats d’appareil et arrêtée. L’état n’est jamais persisté et les sockets sont nettoyés avec le thread, la fenêtre, l’expiration ou l’application. L’accès LAN, Cloudflare et toute promesse d’accès public restent désactivés jusqu’à l’ajout d’un véritable tunnel et de contrôles d’accès.

État actuel de la reprise agent : le processus principal journalise dans SQLite chaque exécution et les transitions ordonnées des appels d’outils avec leurs arguments et résultats. Une annulation, une erreur ou un redémarrage marque atomiquement l’exécution et les outils encore actifs comme interrompus. Le contexte envoyé au modèle est reconstruit depuis cet historique principal puis borné déterministement à 60 000 caractères en conservant les échanges récents et les paires appel/résultat ; les éléments surdimensionnés sont tronqués, sans prétendre produire un résumé sémantique. La reprise automatique d’une génération interrompue et la réduction sémantique des anciens échanges restent à réaliser.

### Phase 5 — Distribution

- installateurs Windows et Linux ;
- mises à jour signées ;
- CI sur les deux systèmes ;
- assistant de première configuration ;
- documentation utilisateur et dépannage.

État actuel : les paquets Windows et Linux et leur construction CI non signée sont configurés. Au lancement, une fenêtre compacte affiche la progression de la première installation ou du redémarrage du runtime ; les diagnostics techniques ne surchargent plus les réglages de modèles. Local Agent crée ou redémarre en arrière-plan `local-agent-ollama`, tente le GPU NVIDIA puis le CPU, expose l’API uniquement sur `127.0.0.1:11435` et conserve les modèles dans le disque virtuel privé. Le choix et le téléchargement du modèle restent visibles dans le catalogue ; aucun Ollama natif, Docker Desktop ni terminal séparé n’est lancé.

Les mises à jour automatiques signées, la signature des artefacts, les smoke tests natifs empaquetés et un diagnostic indépendant de l’installation avant toute tentative de démarrage restent à réaliser. L’état « installation inconnue » est donc volontaire lorsque l’API ne répond pas encore.

### Phase 6 — Extensions

- agents parallèles lorsque les tâches sont réellement indépendantes ;
- exécution sur un autre PC ou serveur ;
- client terminal ;
- plugins avec permissions déclaratives ;
- contrôle à distance et partage de threads.

Première tranche réalisée pour les agents parallèles locaux : chaque profil projet persiste un plafond de workers simultanés, initialisé prudemment depuis les cœurs CPU et la RAM détectés. Un ordonnanceur FIFO par projet dans le processus principal applique ce plafond et conserve l’invariant d’une génération active par thread. Les événements IPC portent l’identifiant du thread et de la requête ; le renderer conserve donc séparément les états `queued`/`running`, les sorties partielles et l’activité des outils pendant les changements de thread. L’annulation retire une entrée de file ou interrompt son worker, et la suppression d’un thread refuse de nettoyer son environnement tant que l’un de ces états existe.

Tranche suivante réalisée pour la conversation en file : plusieurs messages peuvent être persistés pendant qu’un run du même thread travaille. SQLite conserve leur ordre et leur contenu ; une entrée en attente reste hors de la conversation et n’y apparaît qu’au démarrage réel de son run. Le processus principal permet de modifier ou supprimer uniquement cette entrée encore en attente, de la placer en tête avec **Envoyer maintenant**, puis d’interrompre le run courant avant de la démarrer. Le contexte de chaque run est reconstruit jusqu’à son propre message et exclut les demandes futures. L’interface affiche la file directement au-dessus du compositeur avec ses actions, tandis qu’un bouton séparé ouvre l’historique des états en cours, terminés, interrompus et en erreur.

Après une fermeture ou un redémarrage, le journal marque uniquement les runs réellement actifs comme interrompus ; les entrées en attente restent durables et sont replanifiées au chargement suivant. Un profil ou runtime invalide bloque leur démarrage sans basculer vers l'hôte. Les threads en worktree sont parallélisables ; ceux qui partagent le même dossier projet sont sérialisés. Le plafond ne promet pas une exécution simultanée du modèle : Ollama garde sa propre politique de concurrence et de chargement. Restent hors de ces tranches la réservation dynamique de ressources entre Ollama et les workers, la suspension de workers, plusieurs modèles coordonnés et l’exécution distante.

## 10. Stratégie de vérification

- tests unitaires des contrats, politiques et transitions de l'agent ;
- fournisseur de modèle factice pour des tests déterministes ;
- tests d'intégration avec un serveur compatible Ollama simulé ;
- tests des outils dans des dépôts Git temporaires ;
- tests de sécurité des chemins et commandes ;
- parcours Playwright de la création d'un thread au premier message ;
- smoke tests empaquetés sur Windows et Linux ;
- test facultatif avec un vrai modèle local, séparé de la CI obligatoire.

## 11. Critères du premier produit utilisable

La première version est considérée fonctionnelle lorsqu'un utilisateur peut :

1. installer et ouvrir l'application ;
2. vérifier qu'Ollama est disponible et choisir un modèle ;
3. ouvrir un dépôt Git ;
4. demander une modification ;
5. voir et autoriser les outils utilisés ;
6. exécuter les tests du projet ;
7. examiner le diff final ;
8. fermer puis reprendre le thread sans perdre son historique.

## 12. Périmètre initial volontairement limité

La première version n'inclut pas de plateforme cloud, collaboration, application mobile, marketplace ou orchestration systématique de plusieurs modèles. Ces fonctions ne doivent pas retarder la boucle principale. L'ordre retenu est : tranche native fonctionnelle, agent de code, puis isolation par conteneur sans réécriture du cœur.
