# Local Agent

Local Agent est une application de développement assistée par une IA locale. Elle vise à offrir une boucle complète — analyser une demande, modifier un projet, exécuter ses tests et présenter le diff Git — sur Windows et Linux, sans dépendre d'un service d'inférence cloud.

La version 0.1 fournit :

- détecte Ollama, sa version et les modèles installés ;
- ouvre l'installation officielle d'Ollama à la demande ;
- détecte la RAM, le processeur et le GPU ;
- vérifie séparément Git, Docker et Podman et recommande le runtime worker disponible ;
- classe les modèles par usage : rapide, général, code, vision ou génération d'images ;
- recommande les modèles adaptés tout en laissant le choix à l'utilisateur ;
- télécharge le modèle choisi avec une progression visible ;
- conserve les threads et messages dans une base SQLite locale ;
- crée un Git worktree isolé par thread lorsque le projet le permet ;
- conserve un profil worker par projet avec mode direct ou conteneur, limites CPU/RAM, image et politique réseau ;
- exécute les commandes autorisées dans Docker ou Podman lorsque le profil conteneur est activé ;
- ouvre un vrai terminal PTY par thread dans son worktree actif, en mode direct ou dans le conteneur du profil worker ;
- demande une confirmation avant chaque écriture ou commande ;
- permet à l'agent de lire, rechercher, modifier, tester et présenter le diff Git ;
- borne le contexte et les sorties d'outils pour rester utilisable avec de petits modèles.

Ollama n'est pas obligatoire pour ouvrir l'interface. Aucun logiciel ni modèle n'est installé sans une action explicite de l'utilisateur.

## Tester toute la version 0.1

1. Installer Ollama depuis le bouton de l'application ou depuis son site officiel.
2. Lancer `pnpm dev`, ouvrir l'onglet **Modèles**, puis installer le modèle de démarrage ou un modèle de code compatible avec les outils.
3. Dans **Agent**, ouvrir un dépôt Git, envoyer une demande de modification, contrôler les confirmations natives, puis utiliser **Voir les changements**.
4. Dans un thread de projet actif, ouvrir **Terminal**, vérifier les programmes interactifs et le redimensionnement, puis fermer le panneau pour arrêter tout l’arbre de processus.
5. Arrêter une génération pour vérifier l'annulation, fermer puis rouvrir l'application pour vérifier la persistance, et supprimer le thread. Une confirmation supplémentaire protège les changements non enregistrés.

Pour un dossier qui ne permet pas de créer un worktree Git, l'application explique que l'isolation est indisponible et exige une confirmation avant d'utiliser le dossier original en mode direct.

Le renderer ne choisit jamais le dossier du terminal : il transmet uniquement l’identifiant du thread explicitement marqué actif, et le processus principal résout le worktree enregistré. Les entrées et dimensions sont bornées et validées, le PTY est limité à une session par thread et tous les appels IPC exigent la frame principale autorisée. Le mode direct lance `cmd.exe` sous Windows et Bash (ou `sh`) sous Linux avec un tableau d’arguments, sans interpolation de commande. Le mode conteneur reprend l’image, le réseau et les limites du profil worker et détruit explicitement son conteneur à la fermeture. L’historique du terminal n’est pas persisté et un terminal fermé ne peut pas être repris.

## Développement

Prérequis : Node.js récent, pnpm 12 et Git. Ollama peut être installé séparément pour tester sa détection.

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
