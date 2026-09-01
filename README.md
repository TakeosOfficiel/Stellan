# Local Agent

Local Agent est une application de développement assistée par une IA locale. Elle vise à offrir une boucle complète — analyser une demande, modifier un projet, exécuter ses tests et présenter le diff Git — sur Windows et Linux, sans dépendre d'un service d'inférence cloud.

La première tranche de l'application Electron est en cours de construction. Elle démarre sur un diagnostic local qui détecte Ollama, sa version et les modèles installés. Ollama n'est pas obligatoire pour lancer l'interface.

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
