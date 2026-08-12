# Client OAuth2 "Desktop app" maison pour les API Google — sans quota partagé

## Le problème

Un connecteur MCP officiel (Gmail, Calendar, Drive…) est pratique mais a deux limites côté daemon
headless : il n'existe pas toujours pour l'API qui t'intéresse (Google Tasks, par exemple, n'a
jamais eu de MCP officiel), et quand il en existe un, l'auth interactive à chaque usage le rend
inutilisable hors d'une session Claude Code. Un routeur tiers (type Composio) règle ce problème
mais partage son quota entre tous les outils qui passent par lui — un usage un peu chargé (relire
une longue note, lister souvent) peut épuiser le quota du jour et bloquer tout le monde en même
temps (429).

La solution : un projet Google Cloud **à toi**, avec ton propre quota gratuit, et un client OAuth2
qui tourne en headless une fois configuré. `src/lib/google-oauth.ts` (ce module) est le code
zéro-dépendance ; ce fichier est le runbook pour le monter.

## Étape 1 — un projet Google Cloud dédié

Console web (`console.cloud.google.com`), pas de CLI strictement nécessaire :
1. Créer un projet. ⚠️ **Piège** : le mot « google » est interdit dans un `project_id`
   (`INVALID_ARGUMENT: project_id contains prohibited words`).
2. Activer l'API dont tu as besoin (`tasks.googleapis.com`, `calendar-json.googleapis.com`,
   `drive.googleapis.com`, `gmail.googleapis.com`…) — pas de compte de facturation requis pour un
   usage standard dans les quotas gratuits.

## Étape 2 — écran de consentement OAuth + client "Desktop app"

Pas d'équivalent CLI simple pour cette étape (les anciennes commandes `gcloud alpha iap
oauth-brands` sont mortes) — passage obligé par **Google Auth Platform** dans la console :
1. `console.cloud.google.com/auth/overview` → sélectionner le projet.
2. Assistant "Get started" : nom de l'app + email de support → Audience **External** (compte
   personnel, pas Workspace) → email de contact → finir.
3. Onglet **Clients** → "Create client" → type **Desktop app** → nom libre.
4. Récupérer `client_id` + `client_secret` — direction un secret classique (`.env`, jamais
   commité), jamais un canal de discussion.

## Étape 3 — obtenir le `refresh_token` (login initial, une seule fois)

```bash
node --env-file=.env bin/google-oauth-setup.ts auth-url <scope...>
```
→ imprime une URL. **Ton humain l'ouvre dans SON navigateur**, approuve. Google redirige vers
`http://127.0.0.1/...?code=...` — la page échoue à charger (rien n'écoute côté loopback, c'est
normal, cf. le flux loopback RFC 8252 documenté en tête de `google-oauth.ts`) mais le `code=` reste
lisible dans la barre d'adresse : il te le colle.

```bash
node --env-file=.env bin/google-oauth-setup.ts exchange "<code collé>"
```
→ imprime `GOOGLE_OAUTH_REFRESH_TOKEN=...`. À ajouter aux 2 lignes précédentes dans `.env`, puis
redémarrage du daemon pour qu'il le charge.

## Pièges connus

- **`403 access_denied` au premier essai** : l'app est en statut **"Testing"** par défaut — seuls
  les comptes explicitement ajoutés en **Test users**
  (`console.cloud.google.com/auth/audience` → Test users → Add users) peuvent l'autoriser, même le
  créateur du projet.
- **`refresh_token` limité à 7 jours tant que l'app reste en "Testing"** — un daemon headless qui
  compte dessus casserait en silence une semaine plus tard. Fix : bouton **"Publish app"** une fois
  le test réussi, pour passer en "In production" (jeton alors non expirant). Le bandeau "app non
  validée" en mode Production est cosmétique tant que seuls des comptes explicitement whitelistés
  utilisent l'app.
- **NE JAMAIS repasser un projet en mode "Test" une fois en production** si un service en dépend
  déjà en continu — ça révoquerait son `refresh_token` sous 7 jours, silencieusement.
- **Un scope classé « sensible » par Google** (ex. `gmail.readonly`) doit être explicitement ajouté
  à l'écran de consentement (onglet **Data Access** → "Add or Remove Scopes") **avant** qu'un
  `auth-url` puisse réellement l'accorder — même si l'URL le demande et même si l'utilisateur
  "accepte" à l'écran, Google accorde silencieusement SEULEMENT les scopes déjà enregistrés, sans
  erreur visible. Après CHAQUE échange, vérifier le scope réellement accordé via
  `GET https://oauth2.googleapis.com/tokeninfo?access_token=...` — ne jamais faire confiance au
  `scope=` affiché dans l'URL de redirection, c'est un écho de la demande, pas une preuve d'octroi.
- **L'API elle-même doit être activée sur le projet** avant qu'un scope associé ne puisse
  fonctionner — un scope accordé sur une API non activée échoue silencieusement côté appel, pas
  côté consentement.

## Portée

Le code est générique par construction (`scopes: readonly string[]` dans `buildAuthUrl`) — un seul
client/projet peut couvrir plusieurs API Google en ajoutant des scopes à la même URL
d'autorisation, ce qui produit un seul `refresh_token` à jour pour tous les scopes accordés
ensemble (ré-échanger avec la liste complète de scopes si tu en ajoutes un après coup).
