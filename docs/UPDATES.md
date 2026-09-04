# Mises à jour obligatoires

Stellan vérifie `https://update.stellan.takeos.fr` avant de démarrer Ollama ou de reprendre les workers. Une version plus récente est téléchargée sans choix utilisateur, puis l’application redémarre automatiquement. NSIS utilise son fichier blockmap et AppImage sa blockmap intégrée pour ne récupérer que les blocs modifiés. Les modèles, projets et runtimes sont hors du dossier applicatif et ne sont pas retéléchargés.

## Arborescence HTTPS

```text
/var/www/update.stellan.takeos.fr/
├── windows/
│   ├── latest.yml
│   ├── Stellan-<version>-win-x64.exe
│   └── Stellan-<version>-win-x64.exe.blockmap
└── linux/
    ├── latest-linux.yml
    └── Stellan-<version>-linux-x86_64.AppImage
```

Conserver les anciens installateurs, AppImages et blockmaps : ils permettent le téléchargement différentiel depuis une ancienne version. Les manifestes `latest*.yml` doivent avoir `Cache-Control: no-cache, no-store, must-revalidate`; les artefacts versionnés peuvent avoir `Cache-Control: public, max-age=31536000, immutable`. Nginx sert nativement les requêtes `Range` nécessaires. HTTPS est obligatoire.

Exemple Nginx :

```nginx
server {
    listen 443 ssl http2;
    server_name update.stellan.takeos.fr;
    root /var/www/update.stellan.takeos.fr;

    location ~ ^/(windows/latest\.yml|linux/latest-linux\.yml)$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        try_files $uri =404;
    }
    location / {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }
}
```

## Publication atomique

1. Incrémenter obligatoirement `version` dans `package.json`.
2. Construire les deux plateformes. Pour une vraie distribution, signer le NSIS Windows.
3. Depuis une machine contenant tous les artefacts :

```bash
STELLAN_UPDATE_SSH=deploy@update.stellan.takeos.fr \
STELLAN_UPDATE_ROOT=/var/www/update.stellan.takeos.fr \
./scripts/deploy-updates.sh
```

Le script vérifie tous les fichiers, transfère vers un répertoire temporaire, publie d’abord les binaires et blockmaps, puis remplace les manifestes en dernier. Il n’efface jamais une ancienne version.

## Amorçage

Les versions déjà distribuées sans `electron-updater` ne peuvent évidemment pas apprendre seules à se mettre à jour. Les utilisateurs devront installer une seule fois la première version qui contient ce mécanisme. Toutes les versions suivantes passeront par le VPS.

Une panne de vérification ou de téléchargement bloque le démarrage avec un message demandant de vérifier la connexion et de contacter le support Stellan. Il n’existe ni bouton pour ignorer la mise à jour, ni retour automatique vers une ancienne version.
