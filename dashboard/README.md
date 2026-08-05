# dashboard/ — le tableau de bord opérateur (optionnel)

> Comme `harness/`, ce module suppose que tu as déjà un **daemon always-on** qui fait tourner ton
> compagnon (voir `harness/README.md`) — pas juste les sessions manuelles de la base du starter.
> Sans daemon, il n'y a rien à afficher : ignore ce dossier tant que tu en es aux sessions Claude
> Code ouvertes à la main.

Dashboard **principalement lecture seule** pour le harnais d'un compagnon always-on. Donne une vue
en direct sur l'état du daemon sans avoir à fouiller les logs/la base SQLite/le git log à la main.
Seule exception : le panneau **Réglages modèle**, qui relaie des commandes allowlistées vers le
daemon (proxy serveur, jamais un accès direct depuis le navigateur).

## Le couplage réel avec `harness/`

Ce dashboard n'est **pas autonome** : il lit, en lecture seule, deux choses produites par ton
propre daemon (pas par ce starter tel quel — `harness/` n'en fournit que des modules, pas un
daemon complet) :

- **la base SQLite du harnais** (`DASHBOARD_DB_PATH`) — tables `jobs`, `wakes`, `session_log`,
  `cost_log`, `settings`, `approvals`, et optionnellement `sensor_evals` si tu la journalises ;
- **le dépôt git du harnais** (`DASHBOARD_REPO_PATH`) — pour `git log` (panneau « appris
  récemment »), `knowledge/registry.json` (knowledge repos), et les fichiers de contexte statiques
  (`CLAUDE.md`, `harness/persona/*.md`).

Si ton propre daemon n'a pas ces tables/ce schéma, ou range son contexte ailleurs, **adapte les
requêtes SQL et les chemins avant de déployer** — ce dashboard documente les conventions du
harnais dont il est issu (voir `harness/README.md`), pas un standard universel. Chaque module
échoue proprement (liste vide / erreur explicite dans l'UI) plutôt que de planter si une
table/un fichier manque, pour te laisser adapter progressivement.

## Ce qui est affiché

- **État du daemon** : up/down (sonde `GET /health` côté harnais), SHA git déployé
  (`settings.daemon_git_sha`), dernière activité connue, état d'ouverture de la base SQLite.
- **Réglages modèle** : conversation principale, un groupe nommé, jobs de fond, cycle Dream —
  pilotables depuis le dashboard via `POST /api/settings` (proxy serveur → daemon `/settings`,
  Bearer `DASHBOARD_SETTINGS_TOKEN`). Voir section dédiée ci-dessous.
- **Jobs récents** (table `jobs`). `intent`/`result` sont réduits à un **aperçu une-ligne** côté
  API — testé en usage réel : ces champs sont souvent des **briefs complets** (parfois plusieurs
  milliers de caractères), pas de simples métadonnées. Un dashboard doit rester glançable, pas un
  visualiseur de transcript intégral.
- **Réveils programmés** (table `wakes`, en attente + récents).
- **💰 Usage & billing** : coût réel sur 7/30 jours (`cost_log`), par jour, par modèle/fournisseur,
  par catégorie (sessions/jobs/Dream). Voir section dédiée.
- **Sensors** : registre + cadence/prochaine échéance + décompte silencieux/réveils réels si tu
  journalises `sensor_evals`. Voir section dédiée.
- **Sessions récentes** (table `session_log` : scope, coût, source, modèle, effort), avec un lien
  direct par session (`/#/sessions/<id>`, routing 100% côté client).
- **Approbations récentes** (table `approvals` : description, type, statut — sans la commande
  brute).
- **Ce qui a été appris récemment** : `git log` filtré sur `journal/`, `memoire/`, `competences/`.
- **Contexte de session par défaut** : fichiers statiques injectés à chaque réveil normal du
  harnais. Voir section dédiée.
- **Liens GitHub** : ton repo principal + un éventuel repo public (statiques, à adapter dans
  `src/github-links.js`) + les **knowledge repos lus en direct** depuis
  `knowledge/registry.json` (métadonnées seulement). Voir section dédiée.
- **Cycle Dream** (si ton harnais en a un) : les vraies sessions journalisées (cliquables) + le
  template actuel du prompt (nouveau cycle + reprise après coupure). Voir section dédiée.

Tout est servi par une seule API HTTP en Node natif (`node:http`, `node:sqlite`,
`node:child_process` — zéro dépendance npm), avec un frontend statique vanilla JS/CSS (pas de
build step).

## Ce qui est délibérément EXCLU (et pourquoi)

| Donnée | Table/source | Raison |
|---|---|---|
| Contenu des webhooks entrants | `inbox.payload` | contenu de conversation brut |
| Messages en attente de validation | `outbox.body` | contenu de conversation |
| Identifiants de chat / numéros | `trust.chat_id` | PII |
| Titres de tâches personnelles | `task_messages.task_title` | contenu personnel |
| Résumé de session | `session_log.summary` | peut citer un extrait de conversation |
| Commande brute d'une approbation | `approvals.command` | peut contenir chemins/valeurs sensibles |
| Contenu des knowledge repos | — | jamais lu, seulement les métadonnées du registre (nom, lien, domaines, statut) |
| `session_log.scope` brut dans le panneau Usage & billing | `session_log.scope` | peut être un identifiant de conversation — regroupé en 3 catégories lisibles (sessions/job/dream) plutôt qu'exposé tel quel dans cette vue agrégée |
| Solde d'un fournisseur payant appelé en direct | API externe (ex. DeepSeek) | ce dashboard ne doit **jamais** détenir une clé API secrète lui-même — surface de secret non justifiée pour un dashboard lecture-seule ; il lit seulement ce que le harnais y a déjà écrit, si tu as câblé ça côté harnais |
| Uptime précis du process daemon | `/proc/<pid>` | nécessiterait `--pid=host` (visibilité sur tous les process de l'hôte) pour un gain marginal — la sonde `/health` suffit pour up/down |

Tout ceci reste de toute façon **derrière le PIN** (`ACCESS_PIN`), mais l'exclusion est délibérée :
mieux vaut réduire la surface exposée que compter uniquement sur le PIN.

## Connexion : PIN, cookie signé, ou lien direct

Gate PIN (`src/access-gate.js`) : cookie signé HMAC, sans état serveur — pas de session store à
invalider, un logout jette juste le cookie côté client. Vide (`ACCESS_PIN` non défini) = gate
désactivée, à réserver aux déploiements strictement privés.

**Connexion par lien** : `https://<url>/?pin=123456` connecte directement, sans taper le PIN — le
serveur lit le query param `pin` sur un chargement de page (GET, hors `/api/*`) et, s'il
correspond, pose le cookie de session comme le ferait `/login`. Le client (`public/app.js`) retire
ensuite `pin` de l'URL affichée (`history.replaceState`), sans recharger la page ni perdre le hash
`#/sessions/<id>` éventuel.

**Compromis sécurité assumé** : un PIN dans une URL peut fuiter (historique navigateur, capture
d'écran partagée). Acceptable si l'URL elle-même est déjà éphémère (tunnel Cloudflare *quick*,
régénérée à chaque redémarrage) et jamais indexée/partagée hors de son contexte d'usage — sinon,
préfère toujours taper le PIN à la main plutôt que de distribuer des liens qui le contiennent.

## Panneau Réglages modèle

Route `GET /api/model-settings` : lit les clés `settings` utiles (`model`, `effort`, `engine`,
`codex_model`, `provider`, `deepseek_model`) pour quatre portées : global, un **groupe** nommé
(`config.groupChatId` — adapte/retire ce scope si tu n'as pas ce cas d'usage), `jobs`, `dream`. Le
panneau renvoie l'alias stable du groupe, jamais son chat_id réel.

Pour une portée non globale, « Hérite du global » veut dire que ses clés propres sont absentes et
que le harnais retombe, au lancement, sur les réglages globaux — pas une référence à la ligne
juste au-dessus dans l'UI.

Route `POST /api/settings` : reçoit `{ "command": "/model jobs opus" }`, relaie côté serveur vers
`DASHBOARD_SETTINGS_URL` avec un `Bearer DASHBOARD_SETTINGS_TOKEN`. Le navigateur ne voit jamais ce
token. Si le token manque, le panneau reste visible mais les actions sont désactivées — ton daemon
doit garder sa **propre** allowlist de commandes côté serveur : ce proxy ne doit jamais devenir un
accès shell déguisé.

## Panneau 💰 Usage & billing

Route `GET /api/usage?days=<n>` (défaut/plafond : 30/90 jours), requête SQL directe sur
`cost_log.cost_usd` — pas de nouvelle dépendance, pas de calcul supplémentaire côté client au-delà
du rendu.

**⚠️ Piège vécu** : ne construis pas ce panneau sur `session_log` si c'est un UPSERT par
`session_id` chez toi — seul le DERNIER coût de chaque fil survivrait, et sommer sous-compterait le
dépensé réel. Préfère un journal **append-only** dédié (une ligne par tour, `cost_log` ici).

Trois vues, toutes bornées à la fenêtre demandée :
- **Totaux** : dépense sur les 7 et les 30 derniers jours.
- **Par jour** : barres CSS horizontales (pas de lib de charting — zéro dépendance).
- **Par modèle** : `model` n'a pas de colonne `provider` dédiée ; ce panneau déduit le fournisseur
  depuis le slug (`codex`/`gpt-*` → Codex, `deepseek-*` → DeepSeek, sinon Claude).
- **Par catégorie** : `scope` est regroupé en 3 buckets lisibles (`sessions`/`job`/`dream`) plutôt
  qu'exposé brut (il peut valoir un identifiant de conversation).

## Panneau Sensors

Liste les **sensors** enregistrés côté harnais (typiquement `harness/src/sensors/index.ts` si tu
suis la convention `harness/` — pré-filtres déterministes zéro-token qui décident si un réveil
mérite une vraie session). Le nom du registre est lu **tel quel** (regex texte sur un bloc
`REGISTRY`, pas d'exécution TypeScript) — pour ne jamais dupliquer/faire dériver une liste codée en
dur.

Pour chaque sensor, la cadence et la prochaine échéance viennent de la ligne `wakes` correspondante
(en préférant la ligne `pending` actuelle). Le décompte silencieux/réveils réels sur une fenêtre de
24h nécessite une table `sensor_evals` optionnelle côté harnais (une ligne par évaluation) : sans
elle, `wakes` seul ne distingue pas un tick silencieux (`changed:false`) d'un réveil réel
(`changed:true`), puisqu'un scheduler ré-arme typiquement la MÊME ligne à chaque évaluation.

## Panneau Contexte de session par défaut

Liste les fichiers **statiques** du dépôt qui composent le contexte injecté à chaque réveil normal
du harnais (`src/context-files.js`, lu depuis le dépôt monté en lecture seule) : `CLAUDE.md`,
`.claude/settings.json` (auto-chargés par le CLI Claude Code), `harness/persona/corps-vps.md`
(injecté explicitement à chaque réveil, si ton harnais suit cette convention), et
`harness/persona/dream.md` (cas particulier, seulement pour un cycle Dream).

**Relis ces fichiers à la main avant d'activer ce panneau** (recherche de clés API/tokens/secrets)
— ils sont censés être du contenu d'identité/protocole statique, mais c'est à toi de le vérifier
pour ton propre dépôt avant de l'exposer, même derrière un PIN. Taille plafonnée à 100 Ko par
fichier par prudence.

## Liens GitHub

Panneau `GET /api/github` — pas d'appel API GitHub live (des liens + une description courte
suffisent). Deux entrées **statiques** (`src/github-links.js`, à adapter avec tes propres URLs) :
ton repo principal et un éventuel repo public/portfolio. Les **knowledge repos**, eux, sont lus
**dynamiquement** depuis `knowledge/registry.json` — si tu ajoutes un repo au registre, ce panneau
suit tout seul, sans redéploiement.

**🔒 Métadonnées uniquement — jamais le contenu ni les détails d'accès.** Sont délibérément exclus
de l'API : `notes`/`path`/`remote` du registre (souvent le lieu où vivent des détails d'accès ou de
token), et bien sûr le contenu des repos eux-mêmes (les clones ne sont même pas dans le dépôt
monté). Un test verrouille cette exclusion (`src/knowledge-repos.test.js`).

## Cycle Dream (si ton harnais en a un)

Demande initiale possible : pouvoir cliquer sur une session Dream pour voir le prompt/contexte avec
lequel elle a démarré. Ça suppose que ton harnais **journalise** chaque cycle Dream abouti comme un
réveil normal (`source: "dream"`, scope dédié pour ne pas détourner le fil conversationnel
principal) — sinon la liste reste vide, ce qui est un fait à afficher, pas une erreur.

Le **template du prompt** (`src/dream-prompt.js`) reste affiché à côté comme repli utile — « ce que
recevrait une NOUVELLE session Dream maintenant », reconstruit depuis `harness/persona/dream.md`.
Le prompt exact reçu par une session PASSÉE n'est archivé nulle part par défaut : si `dream.md` a
changé depuis, ce template en diffère — l'avertissement est exposé dans l'API et dans l'UI plutôt
qu'enfoui dans un commentaire.

## Déploiement

```bash
cp .env.example .env      # ACCESS_PIN, ACCESS_SESSION_SECRET (openssl rand -hex 32), chemins hôte
docker compose up -d --build
docker compose logs -f tunnel   # récupère l'URL https://xxx.trycloudflare.com
```

Ou en local sans Docker, une fois `.env` chargé dans ton shell :

```bash
npm start   # node src/server.js — écoute sur PORT (défaut 8080)
```

- L'app écoute en interne sur `:8080`, exposée à `127.0.0.1:${HOST_PORT:-8790}` côté hôte —
  jamais directement sur Internet.
- Le tunnel Cloudflare est un **quick tunnel** (`cloudflared tunnel --url ...`) : URL éphémère
  `*.trycloudflare.com`, régénérée à chaque redémarrage du conteneur `tunnel`. Pas de DNS/domaine
  dédié pour ce v1 — à remplacer par un tunnel nommé/domaine fixe si tu veux une URL stable.
- Base SQLite et dépôt git montés en **lecture seule** (`:ro`) ; `node:sqlite` est en plus ouvert
  avec `readOnly: true` (double barrière — le process ne pourrait pas écrire même sans le `:ro`).

## Tests

```bash
cd dashboard && npm test   # node --test — 23 tests, aucune dépendance externe requise
```

Couvre : la logique du gate PIN (`src/access-gate.test.js`), le parsing du registre des sensors
(`src/sensors-registry.test.js`), la lecture des fichiers de contexte
(`src/context-files.test.js`), les liens GitHub statiques (`src/github-links.test.js`), la
reconstruction du template Dream (`src/dream-prompt.test.js`), la lecture du registre des knowledge
repos — dont l'exclusion des champs sensibles — (`src/knowledge-repos.test.js`), et l'agrégation de
coût du panneau Usage & billing sur une vraie base sqlite de test (`src/db.test.js`).

Le test « le VRAI registre du dépôt principal … » (`knowledge-repos.test.js`) lit
`DASHBOARD_REPO_PATH` (défaut `/repo`) : il vérifie pour de vrai que ton registre remonte quand ton
dépôt est monté, et se contente de passer là où il ne l'est pas :

```bash
DASHBOARD_REPO_PATH=/home/<user>/mon-compagnon npm test
```
