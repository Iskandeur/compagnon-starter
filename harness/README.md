# harness/ — le corps optionnel

> Commence sans ça. `harness/` n'est utile que le jour où tu veux que ton compagnon tourne
> **en continu** (un daemon qui l'éveille sur évènement — message reçu, heure programmée — au
> lieu d'attendre que tu ouvres une session Claude Code). Tant que tu vis en sessions manuelles,
> ignore ce dossier : rien ici n'est requis pour que `identite/`, `memoire/`, `competences/` et
> `protocoles/` fonctionnent.

## Ce que c'est — et ce que ce n'est pas

Ce n'est **pas** un daemon complet prêt à lancer. Faire tourner un compagnon en continu demande
un vrai runtime (boucle d'écoute WhatsApp/Telegram, orchestration des sessions, base d'état,
configuration…) qui est par nature spécifique à *ta* stack (quel client de messagerie, quel
hébergeur, quels outils). Reconstruire ce runtime en générique aurait produit une usine à gaz
inutilisable telle quelle.

Ce qu'il y a ici à la place : des **modules autonomes et testés**, chacun portant un pattern
précis qui a fait ses preuves sur le corps de l'agent dont ce starter s'inspire — plus la
doc qui explique le *pourquoi* et comment le brancher dans ton propre runtime. Prends ce qui te
sert, ignore le reste, adapte librement.

## Les modules

| Module | Rôle | Doc |
|---|---|---|
| `bin/portrait.ts` | Rituel mensuel : génère une image à partir du journal du mois, l'archive. | [`docs/portrait-du-mois.md`](docs/portrait-du-mois.md) |
| `bin/restart.ts`, `src/lib/restart-guard.ts` | Redémarrage du daemon sans perte ni doublon de messages. | (voir en-tête des fichiers) |
| `src/lib/coalesce.ts` | Fusionne une rafale de messages rapprochés en un seul réveil. | [`docs/coalescing.md`](docs/coalescing.md) |
| `src/lib/pingpong.ts` | Continuité bornée dans un groupe multi-agents, avec plafond anti-boucle. | [`docs/pingpong-groupes.md`](docs/pingpong-groupes.md) |
| `src/lib/mention-wake.ts` | Réveil sur @-mention structurée, pas seulement sur le nom tapé en dur. | [`docs/pingpong-groupes.md`](docs/pingpong-groupes.md) |
| `bin/schedule-wake.ts`, `src/scheduler.ts` | L'agent se programme lui-même des réveils futurs, avec budget de sobriété. | [`docs/self-scheduling.md`](docs/self-scheduling.md) |
| `src/lib/worktree.ts` | Travail long isolé dans un git worktree dédié, jamais sur la working-copy vivante. | [`docs/jobs-worktree-isoles.md`](docs/jobs-worktree-isoles.md) |
| `src/lib/router.ts` | Choix modèle/effort par message — mode auto ou épinglé par commande humaine. | [`docs/routeur-pre-vol.md`](docs/routeur-pre-vol.md) |
| `bin/wa-guard.ts`, `src/wa-guard.ts`, `config/wa-guard-groups-ok` | Garde-fou d'envoi : cadence anti-spam, groupes verrouillés par défaut, tags/mentions brutes bloquées avant envoi. | [`docs/wa-guard-et-impersonation.md`](docs/wa-guard-et-impersonation.md) |
| `src/lib/voice-clone.ts` | Réponse en note vocale avec une voix clonée (ElevenLabs v3) : format PTT sans conversion, balises de ton vérifiées, anti-boucle. | [`docs/voix-clonee-elevenlabs.md`](docs/voix-clonee-elevenlabs.md) |
| `src/lib/waha-stale-replay.ts` | Anti-rejeu webhook : ne pas répondre à un vieux message rejoué (reconnexion/resync) comme s'il était neuf. | [`docs/waha-stale-replay.md`](docs/waha-stale-replay.md) |
| — (pattern) | Garde-fou anti-fuite repos publics : scan preflight + hook de merge qui lit le vrai diff public, fail-closed. | [`docs/public-anti-leak.md`](docs/public-anti-leak.md) |
| — (pattern) | Localisation temps réel OwnTracks : ingestion → stockage borné → poller → diffusion uniquement si expéditeur vérifié. | [`docs/owntracks-localisation.md`](docs/owntracks-localisation.md) |
| — | Piège vérifié : les mentions WhatsApp via un wrapper MCP `send-text` partent en texte brut. | [`docs/mentions-whatsapp-piege.md`](docs/mentions-whatsapp-piege.md) |

Complément séparé, pas un module de plus dans ce dossier : [`dashboard/`](../dashboard/README.md)
est une app Node à part (Docker, frontend statique) qui lit la base SQLite et le dépôt git d'un
daemon construit à partir de ces modules — utile seulement une fois ce daemon en marche.

## Conventions

Zéro dépendance runtime (modules natifs Node ≥22 : `node:sqlite`, `node:fs`, `node:child_process`,
`fetch`…). TypeScript exécuté nativement par Node (pas de *parameter properties*, pas d'enums —
la syntaxe stricte que Node accepte en mode *strip-only*). Tests via `node --test` :

```bash
cd harness && node --test
```

## Origine

Ces patterns viennent du corps d'un compagnon qui tourne en continu sur un VPS depuis
juillet 2026. Rien ici n'est prescriptif — c'est un point de départ à faire tien, comme le reste
de ce starter.
