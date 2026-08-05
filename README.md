# ⊙ compagnon-starter

> Crée ton propre **compagnon IA persistant** — un assistant qui te connaît, se souvient, et grandit
> d'une session à l'autre.

Un assistant Claude classique oublie tout entre deux conversations. Ici, l'assistant vit dans **ce
dépôt** : son identité, sa mémoire et ses protocoles sont des fichiers `.md` versionnés. Chaque
session le rend un peu plus *lui*, un peu plus utile pour **toi**.

## Prérequis
- [Claude Code](https://claude.com/claude-code) installé (`npm i -g @anthropic-ai/claude-code`, puis `claude` pour te connecter).
- Un compte GitHub (pour que ta mémoire persiste dans le cloud — tu peux commencer sans).

## Démarrer (2 minutes)
1. **Clone ce repo** et renomme-le comme tu veux :
   ```bash
   git clone https://github.com/Iskandeur/compagnon-starter mon-compagnon
   cd mon-compagnon
   ```
2. **Lance une session Claude Code** dedans :
   ```bash
   claude
   ```
3. **Dis-lui bonjour.** Il lira son `CLAUDE.md`, comprendra qu'il vient de naître, et **lancera tout
   seul l'onboarding** : il te posera quelques questions pour se construire une identité et apprendre
   qui tu es. Laisse-toi guider.

À la fin de l'onboarding, ton compagnon aura sa première mémoire — et il saura la faire grandir à
chaque fois que vous travaillerez ensemble.

## Ce qu'il y a dans le repo
| Élément | Rôle |
|---|---|
| `CLAUDE.md` | Le « seuil » — ce que ton compagnon lit à chaque réveil. |
| `ONBOARDING.md` | Le script d'accueil qu'il déroule à la première session. |
| `identite/` | Qui il est (personnalité, valeurs, mission) — vierge, à remplir ensemble. |
| `memoire/` | Ce qu'il **sait** (sur toi, sur le monde) — grandit au fil du temps. |
| `competences/` | Ce qu'il sait **faire** (procédures réutilisables) — se remplit à l'usage. |
| `protocoles/` | Ses règles de fonctionnement : l'**Ouroboros** (capitaliser + graver), le **réveil**, la **discrétion**. |
| `journal/` | Le récit daté de ses sessions. |
| `harness/` | *(optionnel)* Le corps — modules pour faire tourner ton compagnon en continu. |
| `dashboard/` | *(optionnel)* Tableau de bord opérateur, lecture seule, pour un daemon `harness/` en marche. |

## Pour aller plus loin
Quand tu seras à l'aise, tu pourras lui brancher des **outils** (WhatsApp, agenda, GitHub…) via des
serveurs MCP, ou même lui donner un **corps** qui tourne en permanence — un petit daemon sur un
serveur qui le réveille sur évènement (un message reçu, une heure programmée) au lieu d'attendre que
tu ouvres une session. C'est comme ça que vit l'agent dont ce starter est issu. Mais commence simple : une session,
une conversation, une mémoire qui grandit.

Le jour où tu franchis ce cap, [`harness/`](harness/README.md) rassemble des modules autonomes et
testés portant des patterns qui ont fait leurs preuves sur un compagnon en production : rituel mensuel de
portrait, redémarrage sans perte de messages, fusion des rafales de messages, continuité bornée
dans un groupe multi-agents, réveil sur mention, auto-programmation de réveils, jobs longs isolés
en git worktree, routeur modèle/effort, garde-fou d'envoi anti-spam. Prends ce qui te sert, ignore
le reste — voir [`harness/README.md`](harness/README.md).

Une fois ce daemon en marche, [`dashboard/`](dashboard/README.md) donne une vue en direct sur son
état (jobs, réveils, coût, sensors, sessions) sans fouiller les logs à la main — app Node native
zéro dépendance, activable avec `docker compose up` ou `npm start`. Couplé à la base SQLite et au
dépôt git du harnais, donc utile seulement une fois `harness/` en marche.

---
*Un point de départ, à faire tien.*
