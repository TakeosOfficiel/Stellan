# Intégration continue multiplateforme

Le dépôt est hébergé par Amp. Amp sait envoyer un webhook `post-receive`, mais ne fournit pas de moteur d'exécution CI natif documenté. Un workflow GitHub Actions placé dans ce dépôt ne s'exécuterait donc pas. Le fichier [`.buildkite/pipeline.yml`](../.buildkite/pipeline.yml) fournit à la place une définition portable pour un service Buildkite relié au dépôt.

## Agents requis

Configurer deux agents x64 natifs :

- une file `linux-x64` sur Linux avec Node.js, Corepack et les bibliothèques système nécessaires à Electron/AppImage ;
- une file `windows-x64` sur Windows avec Node.js et Corepack.

Le pipeline active exactement `pnpm@12.0.0`, la version déclarée dans `package.json`, puis installe le lockfile avec `--frozen-lockfile`. Chaque système exécute `typecheck`, les tests et le build. Linux construit un AppImage et un paquet deb ; Windows construit l'installateur NSIS sur Windows, sans Wine.

Pour automatiser les exécutions, relier le service CI au dépôt Amp et configurer le webhook `post-receive` du projet Amp. Les identifiants éventuellement nécessaires au clonage d'un dépôt privé relèvent de la connexion entre le service CI et l'hébergeur, pas du build. Le pipeline lui-même ne lit aucun secret applicatif et ne publie aucune release.

## Artefacts non signés

La découverte automatique de certificat est désactivée avec `CSC_IDENTITY_AUTO_DISCOVERY=false`, et `electron-builder` reçoit `--publish never`. Les sorties attendues sont contrôlées comme fichiers non vides avant leur téléversement par Buildkite :

- `ci-artifacts/unsigned/windows/Stellan-<version>-win-x64.exe` ;
- `ci-artifacts/unsigned/linux/Stellan-<version>-linux-x86_64.AppImage` ;
- `ci-artifacts/unsigned/linux/Stellan-<version>-linux-amd64.deb`.

Ces fichiers sont explicitement **non signés**. Ils servent à la validation CI et ne constituent pas des releases authentifiées.

## Exécution manuelle sur un agent

Après activation de la version pnpm et installation des dépendances verrouillées :

```text
corepack enable
corepack prepare pnpm@12.0.0 --activate
pnpm install --frozen-lockfile
node scripts/ci/run.cjs linux    # sur Linux x64
node scripts/ci/run.cjs windows  # sur Windows x64
```

Le script refuse une cible différente du système hôte et une version pnpm différente de celle déclarée. Il nettoie `dist/` avant l'empaquetage afin qu'un ancien fichier ne puisse pas satisfaire le contrôle d'artefacts.
