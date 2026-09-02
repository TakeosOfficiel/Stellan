# Portails de prévisualisation

## Objectif

Un portail rend un serveur web d’un projet accessible sans exposer arbitrairement la machine. Trois niveaux sont prévus :

1. **Local** : accessible uniquement sur la machine ; mode par défaut.
2. **Réseau local** : activation explicite, protégée par un jeton de session.
3. **Public expérimental** : URL temporaire fournie par Cloudflare Quick Tunnels.

Le produit ne possède actuellement aucun relais cloud. Il ne doit donc pas présenter une URL temporaire gratuite comme un service privé, permanent ou garanti.

## Architecture retenue

```text
Navigateur ───▶ connecteur optionnel ───▶ proxy Local Agent ───▶ serveur du projet
               Cloudflare public         port aléatoire local    127.0.0.1:port
```

Le connecteur ne reçoit jamais directement une cible choisie par l’agent. Local Agent démarre un proxy dédié sur une adresse de boucle locale et lui associe une seule cible validée. Pour un conteneur, le port du service doit être publié uniquement sur la boucle locale de l’hôte.

État persistant prévu :

```ts
type PortalScope = 'loopback' | 'lan' | 'public-experimental'
type PortalStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

type Portal = {
  id: string
  projectPath: string
  targetPort: number
  scope: PortalScope
  status: PortalStatus
  provider: 'none' | 'cloudflare-quick'
  publicUrl?: string
}
```

La configuration peut être conservée, mais pas les PID ni les anciennes URL temporaires. Après un redémarrage, tout portail revient à l’état arrêté et une exposition publique n’est jamais réactivée silencieusement.

## Première tranche livrable

- proxy HTTP local lié à un projet et à un port explicitement approuvé ;
- HTTP, WebSocket et rechargement à chaud ;
- indicateur visible tant qu’un accès réseau est actif ;
- bouton d’arrêt immédiat et nettoyage à la fermeture de l’application ;
- mode LAN protégé, avec avertissement concernant le pare-feu ;
- Quick Tunnel facultatif lancé sans shell avec `--no-autoupdate` ;
- contrôle de disponibilité à travers le proxy avant d’afficher l’état prêt ;
- acceptation explicite des conditions Cloudflare avant la première utilisation.

La commande publique envisagée est :

```text
cloudflared tunnel --url http://127.0.0.1:<port-du-proxy> --no-autoupdate
```

Quick Tunnels est réservé au développement : pas de SLA, URL `trycloudflare.com` temporaire, maximum documenté de 200 requêtes simultanées et absence de SSE. Son URL est publique pour toute personne qui la possède ; elle n’est pas une authentification.

## Invariants de sécurité

- écoute locale par défaut et activation publique toujours manuelle ;
- cible limitée à `127.0.0.1` ou `::1`, avec port numérique et processus attribuable au projet ;
- refus des sockets Docker, chemins UNC, réseaux bridge, adresses link-local et services de métadonnées cloud ;
- origine fixe par portail : l’en-tête `Host` ne choisit jamais la destination ;
- rejet de `CONNECT`, des requêtes en forme absolue et des en-têtes proxy non fiables ;
- suppression des en-têtes hop-by-hop et définition interne des en-têtes de transfert ;
- limites de taille, délais et nombre de connexions ;
- aucun jeton dans les journaux, URL, rapports de crash ou paramètres ordinaires ;
- arrêt de l’entrée réseau avant l’arrêt du proxy, puis terminaison de tout l’arbre du connecteur ;
- aucune restauration automatique d’une exposition LAN ou publique.

Un tunnel Cloudflare nommé pourra être ajouté ensuite pour les utilisateurs qui possèdent un compte et un domaine. Son jeton devra être conservé dans le coffre du système et Cloudflare Access sera recommandé par défaut. Local Agent ne demandera pas de clé API globale et ne créera pas de tunnel dans un compte partagé par le produit.

## Vérification requise

- tests Windows et Linux des collisions de ports et du nettoyage des processus ;
- HTTP, WebSocket, redirections, cookies et sous-chemins ;
- tests Host/SSRF/`CONNECT` et usurpation des en-têtes de transfert ;
- expiration et révocation des accès LAN ;
- panne DNS, connecteur interrompu, cible arrêtée et fermeture de l’application ;
- contrôle qu’un service local étranger au projet ne peut pas être sélectionné ;
- confirmation qu’aucune exposition n’est reprise après redémarrage.

## Sources externes

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Installation de Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/)
- [Applications auto-hébergées avec Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Jetons et rotation des tunnels](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [Téléchargements et plateformes prises en charge](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
- [Licence Apache 2.0 de cloudflared](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)

L’implémentation n’est pas encore présente dans la version 0.1. Cette documentation fixe les limites à respecter afin de ne pas transformer une fonction de prévisualisation en proxy ouvert ou en promesse de service cloud inexistante.
