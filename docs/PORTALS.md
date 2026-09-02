# Portails de prévisualisation

## État livré

La première tranche fournit un portail de prévisualisation **LOCAL uniquement** pour un thread de projet actif. L’utilisateur ouvre explicitement le panneau du thread, saisit un port numérique et démarre le portail. Le processus principal Electron crée alors un proxy HTTP sur un port aléatoire de `127.0.0.1` et affiche son URL seulement après un contrôle de disponibilité effectué à travers ce proxy.

Le portail prend en charge HTTP ordinaire, les sous-chemins, redirections, cookies et les upgrades WebSocket utilisés par le rechargement à chaud. L’interface permet de copier ou ouvrir l’URL, puis d’arrêter immédiatement le portail. Cette URL n’est accessible que depuis le même ordinateur : elle n’est ni publique ni disponible sur le réseau local.

L’état existe uniquement en mémoire. Il n’est pas enregistré en SQLite et aucun portail n’est restauré après un redémarrage. Il est supprimé lors de l’arrêt explicite, de la suppression du thread, de la fermeture de sa fenêtre ou de l’application.

## Architecture livrée

```text
Navigateur local ───▶ proxy Electron aléatoire ───▶ 127.0.0.1:port
                      écoute 127.0.0.1              ou [::1]:port
```

Le renderer transmet seulement l’identifiant du thread actif et un entier de port compris entre 1 et 65535. Il ne peut fournir ni hôte amont ni URL. Le processus principal vérifie la fenêtre, la frame principale, la propriété de session, le thread sélectionné, le projet persistant et l’environnement actif. Il choisit ensuite une cible fixe parmi `127.0.0.1` et `::1` ; l’en-tête `Host` d’une requête ne participe jamais au routage.

Chaque portail possède au plus une cible. Son URL utilise un port de proxy choisi par le système afin d’éviter les collisions prévisibles. Un changement de port exige l’arrêt préalable du portail existant.

## Limites de sécurité appliquées

- écoute du proxy exclusivement sur `127.0.0.1` ;
- cible exclusivement numérique sur `127.0.0.1` ou `::1`, sans DNS ni hôte fourni par le renderer ;
- refus de `CONNECT`, des cibles en forme absolue et des cibles commençant par `//` ;
- validation stricte de `Host` contre l’autorité exacte du portail ;
- suppression des en-têtes hop-by-hop, des noms cités par `Connection`, des identifiants proxy et de tous les en-têtes `Forwarded`/`X-Forwarded-*` entrants ;
- définition interne de `Host`, `X-Forwarded-For`, `X-Forwarded-Host` et `X-Forwarded-Proto` ;
- assainissement équivalent des en-têtes de réponse ;
- limite d’en-têtes de 16 Kio, corps de requête de 10 Mio, 64 connexions, 100 requêtes par socket et délais stricts ;
- sockets HTTP et WebSocket détruits avant la fermeture du serveur ;
- contrôle HTTP via le proxy avant de passer à l’état prêt ;
- aucun shell, connecteur ou processus enfant utilisé par cette tranche.

Le proxy ne constitue pas une frontière d’authentification entre processus locaux. Un processus local peut joindre l’URL tant que le portail fonctionne, comme il peut généralement joindre le serveur amont lui-même. Le portail réduit l’exposition et empêche le routage arbitraire ; il ne transforme pas un service local en service multi-utilisateur sûr.

## LAN et accès public : volontairement indisponibles

Les modes LAN et public expérimental décrits dans les premières explorations ne sont pas implémentés. L’interface les indique comme indisponibles et ne prétend pas fournir d’accès public.

Avant d’ajouter ces modes, Local Agent devra au minimum :

1. attribuer de façon vérifiable le processus qui écoute au thread et au projet concernés, y compris sur Windows et pour les conteneurs ;
2. définir une authentification, une expiration, une révocation et une protection contre les requêtes intersites ;
3. traiter le pare-feu, les interfaces réseau et le nettoyage des connecteurs sur Windows et Linux ;
4. tester les pannes et l’absence de reprise silencieuse après redémarrage.

Cloudflare Quick Tunnels reste une possibilité de recherche, pas une fonction annoncée. Une URL `trycloudflare.com` est publique pour toute personne qui la possède, sans SLA et sans authentification implicite. Aucun binaire `cloudflared`, jeton, condition d’utilisation ou état public n’est présent dans l’application actuelle.

## Vérification couverte

Les tests automatisés couvrent : cible fixe, propriété de fenêtre, thread/environnement actif, frame IPC principale, contrat preload sans hôte, `Host`, forme absolue, `CONNECT`, taille de requête, délais, en-têtes entrants et sortants, HTTP, upgrade WebSocket, arrêt explicite et nettoyages par propriétaire/application. Le smoke local réel utilise deux serveurs loopback et fait circuler HTTP et des octets après un upgrade `101`.

Restent à valider manuellement sur les applications empaquetées Windows et Linux : comportement des pare-feu/antivirus, HMR de frameworks représentatifs et fermeture forcée par le système d’exploitation. L’attribution du processus amont au projet n’est pas encore disponible ; c’est la raison principale pour laquelle aucune exposition LAN ou publique n’est proposée.

## Sources externes pour la suite

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Applications auto-hébergées avec Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Jetons et rotation des tunnels](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
