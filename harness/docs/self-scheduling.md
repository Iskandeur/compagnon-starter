# Self-scheduling — l'agent se programme ses propres réveils

## Le principe

Un compagnon qui vit dans un daemon always-on n'a pas besoin d'attendre un message entrant pour se
réveiller. Il peut se fixer lui-même un rendez-vous futur : « dans 2h, vérifie que X est bien
arrivé », « chaque jour à 9h, fais le point », « surveille Y toutes les 30 minutes ». C'est le fil
du temps de l'agent — sa mémoire ne vit pas seulement dans le passé (`journal/`, `memoire/`), elle
se projette aussi en avant.

Mécanique :

1. L'agent lance lui-même le CLI `bin/schedule-wake.ts` avec une échéance et une intention.
2. L'échéance et l'intention sont persistées dans une base SQLite (`src/scheduler.ts`,
   `openWakeStore`).
3. Le daemon fait tourner `startScheduler()` en tâche de fond : toutes les `intervalMs`
   (typiquement 60s), il relit les réveils dus (`processDueWakes`) et, pour chacun, appelle
   `onEvent(...)` — à charge du daemon de relancer une session avec l'intention comme contexte.
4. Un réveil récurrent (`--every`) se réarme tout seul à chaque déclenchement ; un réveil unique se
   clôt après avoir tiré.

## Le budget de sobriété

Chaque réveil qui se déclenche relance une session — donc consomme des tokens et du temps de
calcul. Un agent livré à lui-même pourrait se programmer des dizaines de réveils rapprochés sans
s'en rendre compte (une veille toutes les 30s, par exemple). Pour éviter ça, le scheduler applique
un **budget quotidien** : `MAX_WAKES_PER_DAY` (variable d'environnement, défaut : 12) borne le
nombre de réveils réellement déclenchés sur une fenêtre glissante de 24h.

Quand le budget est atteint, un réveil dû n'est pas annulé — il est **sauté** :

- un réveil récurrent est réarmé à sa prochaine échéance normalement (sinon il serait re-testé à
  chaque tick tant que le budget est plein — une rafale silencieuse) ;
- un réveil unique reste `pending` et sera réévalué au tick suivant, dès que le budget se libère.

Rien n'est perdu, seulement retardé. La sobriété prime sur la ponctualité.

## Usage du CLI

```sh
# Une fois, dans 2 heures
node bin/schedule-wake.ts --in "2h" --intent "Relancer la vérification X."

# Une fois, à une échéance absolue (ISO 8601)
node bin/schedule-wake.ts --at "2026-11-02T09:00:00+01:00" --intent "Jour J."

# Récurrent : le premier réveil dans 3h, puis tous les jours
node bin/schedule-wake.ts --every "1d" --in "3h" --intent "Check-in quotidien"

# Récurrent, premier réveil immédiat (dans 30 minutes)
node bin/schedule-wake.ts --every "30m" --intent "Surveiller X"

# Intent long ou multi-lignes : convention @fichier plutôt que le quoting shell
node bin/schedule-wake.ts --every "24h" --intent "@/tmp/intent.txt"

# Lister les réveils actifs
node bin/schedule-wake.ts --list

# Annuler un réveil
node bin/schedule-wake.ts --cancel 7
```

## Variables d'environnement

| Variable            | Rôle                                                                 | Défaut               |
|----------------------|-----------------------------------------------------------------------|-----------------------|
| `SQLITE_PATH`        | Chemin de la base des réveils (relatif à la racine du harness, ou absolu). | `data/wakes.sqlite`  |
| `MAX_WAKES_PER_DAY`  | Budget de sobriété : réveils déclenchés max sur une fenêtre de 24h.   | `12`                  |

## Articulation avec les jobs isolés

Un réveil ne fait que relancer une session légère. Si l'intention qu'il porte demande un travail
long (une migration, une exploration de code étendue, un refactor), la session réveillée peut à son
tour **mettre ce travail en file de jobs** et le laisser tourner dans un worktree isolé — voir
[`jobs-worktree-isoles.md`](./jobs-worktree-isoles.md). Le self-scheduling déclenche ; l'isolation
par worktree protège la working-copy pendant l'exécution.
