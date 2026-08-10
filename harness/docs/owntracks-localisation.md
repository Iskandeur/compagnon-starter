# Localisation temps réel (OwnTracks) — servir la position d'une personne, sans exposer son historique

## Le problème

Vouloir savoir « où est mon humain » sans le demander : un flux de position continu. Deux exigences
contraires : la fraîcheur (temps réel) et la **sobriété** (on ne stocke pas tout l'historique de
déplacements de quelqu'un, et la position ne doit JAMAIS fuiter vers un tiers).

## Le pipeline complet (pattern vérifié en production, 2026-08)

1. **Émission** — l'app **OwnTracks** (mode HTTP) sur le téléphone envoie des pings
   (`POST /location`) avec `tst` (l'horodatage réel, capturé au capteur — pas à l'arrivée serveur,
   car la position peut se mettre en file quand le téléphone n'a pas de réseau) + `batt` (batterie).
2. **Ingestion** — un serveur HTTP minimal authentifie sur un en-tête `Authorization: Basic`
   (l'app OwnTracks ne peut pas envoyer d'en-têtes arbitraires, mais envoie `Basic` quand login ET
   mot de passe sont remplis), compare le mot de passe contre une table lisible seulement par un rôle
   privilégié, et insère le ping dans une base.
3. **Stockage borné** — la table ne garde que les **10 derniers relevés** (une seule requête de
   purge par insert), jamais l'historique complet.
4. **Polling** — un poller (toutes les ~minute) tire le dernier ping et écrit un **fichier JSON
   local** que le processus consommateur lit — on ne lit jamais Postgres directement depuis le
   processus qui tourne.
5. **Enrichissement** — adresse humaine + fuseau via Nominatim (avec `accept-language` réglé, sinon
   noms de lieux multilingues) et une API de fuseau/coordonnées.
6. **Sécurité de diffusion (le point non négociable)** — le bloc de position n'est injecté dans le
   contexte de l'agent QUE si l'expéditeur du message est **vérifié** (l'humain, pas un tiers). Si
   un inconnu demande « où est-il ? », l'information n'existe même pas dans le tour — elle est
   absente avant d'être protégée. Voir `docs/waha-stale-replay.md` pour la famille de garde-fous de
   vérification d'expéditeur.

## Code — principes

```ts
// Le bloc d'état consommé par l'agent (extrait) — fail-closed :
export async function positionBlock(nowMs, verified) {
  if (!verified) return ""; // tiers → l'info n'existe pas dans ce tour
  const loc = JSON.parse(await fs.readFile(LOCAL_FILE, "utf8"));
  return `[État — ${loc.address} | heure locale ${loc.localTime} | batterie ${loc.batt}%]`;
}
```

## Pièges

- **`tst` du payload, jamais l'heure d'arrivée serveur** — sinon les positions mises en file quand le
  téléphone est hors réseau arrivent toutes avec la même heure.
- **Ne jamais lire Postgres depuis le processus consommateur** : un poller qui écrit un fichier JSON
  découple et simplifie (et évite d'ouvrir une connexion DB dans l'agent).
- **Vérification d'expéditeur AVANT l'injection** — c'est le garde-fou qui rend la donnée utilisable.
- Sur Android : l'app exige la localisation « Toujours autoriser » (pas « Pendant l'utilisation »)
  et d'être exclue de l'optimisation batterie — sinon le flux se coupe au bout de quelques heures.
