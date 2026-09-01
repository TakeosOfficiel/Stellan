# Local Agent

Local Agent est une application de développement assistée par une IA locale. Elle vise à offrir une boucle complète — analyser une demande, modifier un projet, exécuter ses tests et présenter le diff Git — sur Windows et Linux, sans dépendre d'un service d'inférence cloud.

La première tranche de l'application Electron est en cours de construction. Son assistant de configuration :

- détecte Ollama, sa version et les modèles installés ;
- ouvre l'installation officielle d'Ollama à la demande ;
- détecte la RAM, le processeur et le GPU ;
- classe les modèles par usage : rapide, général, code, vision ou génération d'images ;
- recommande les modèles adaptés tout en laissant le choix à l'utilisateur ;
- télécharge le modèle choisi avec une progression visible.

Ollama n'est pas obligatoire pour ouvrir l'interface. Aucun logiciel ni modèle n'est installé sans une action explicite de l'utilisateur.

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

Le plan d'architecture, les limites de sécurité et les étapes de réalisation sont décrits dans [`docs/PLAN.md`](docs/PLAN.md).
