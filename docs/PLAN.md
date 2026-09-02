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

Trois modes sont prévus :

1. **Direct** : travail natif, rapide et compatible avec les machines modestes.
2. **Conteneur** : mode recommandé, via Docker sous Windows et Docker ou Podman sous Linux.
3. **Distant** : évolution permettant d'utiliser un autre PC ou un serveur personnel.

Le conteneur ne reçoit pas le socket Docker, les secrets du système ni un montage complet du disque hôte. Son accès réseau est configurable et ses ressources sont limitées. Ollama reste sur l'hôte afin que plusieurs tâches partagent une seule copie du modèle en mémoire.

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
- confirmation pour les commandes sensibles et les écritures hors projet ;
- journal des commandes et résultats ;
- aucun secret injecté automatiquement dans les conteneurs ;
- processus agent séparé pour éviter qu'un calcul bloque l'interface.

Le mode direct est présenté comme moins isolé que le mode conteneur. L'application ne promet pas une sécurité de machine virtuelle lorsqu'elle utilise seulement un conteneur.

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

### Phase 3 — Isolation locale

- Git worktree par thread ;
- runtime Docker sous Windows et Linux ;
- runtime Podman sous Linux ;
- limites de ressources et politiques réseau ;
- suspension, reprise et nettoyage des environnements.

État actuel : les worktrees sont actifs. Git, Docker et Podman sont diagnostiqués séparément. Un profil persistant par projet permet de choisir le mode direct ou conteneur, le runtime, l’image, les limites CPU/RAM et le réseau. En mode conteneur, les commandes autorisées de l’agent passent par un conteneur éphémère durci et nettoyé après l’exécution ; les opérations de fichiers restent appliquées au worktree hôte. La suspension/reprise de conteneurs et les volumes gérés avec limite dure de stockage restent à réaliser. L’interface ne prétend donc pas encore imposer une limite disque.

### Phase 4 — Fiabilité et expérience

- terminal intégré ;
- reprise après fermeture ou erreur ;
- compression des longues conversations ;
- diagnostic et recommandation de modèle ;
- gestion des téléchargements et de l'espace disque ;
- accessibilité et raccourcis clavier.

État actuel du terminal : xterm.js est relié à un PTY `node-pty` réel sous Windows et Linux. Une session unique est liée à l’identifiant d’un thread possédant un environnement projet actif ; le dossier effectif est résolu exclusivement dans le processus principal. Le terminal suit le profil worker direct ou conteneur, diffuse les sorties, accepte les entrées et redimensionnements validés, et nettoie l’arbre de processus ainsi que tout conteneur à la fermeture, à la suppression du thread ou à la fermeture de la fenêtre. L’historique du terminal et la reprise après redémarrage restent volontairement hors périmètre de cette tranche.

### Phase 5 — Distribution

- installateurs Windows et Linux ;
- mises à jour signées ;
- CI sur les deux systèmes ;
- assistant de première configuration ;
- documentation utilisateur et dépannage.

### Phase 6 — Extensions

- agents parallèles lorsque les tâches sont réellement indépendantes ;
- exécution sur un autre PC ou serveur ;
- client terminal ;
- plugins avec permissions déclaratives ;
- contrôle à distance et partage de threads.

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
