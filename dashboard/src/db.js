import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * Lecture SEULE de la base de ton harnais. Ouverte en `readOnly: true` (SQLite refuse toute
 * écriture au niveau moteur, pas seulement via le bind mount `:ro` du conteneur — défense en
 * profondeur).
 *
 * ⚠️ CONTRAT DE DONNÉES. Ce module suppose un schéma plus riche que ce que le harnais MINIMAL de
 * ce starter fournit par défaut (`harness/src/scheduler.ts` n'écrit que `wakes`/`wake_fires`).
 * Chaque fonction ci-dessous ATTRAPE les erreurs SQL (table/colonne manquante) et retombe sur une
 * valeur vide plutôt que de planter la requête HTTP — donc un déploiement minimal reste utilisable
 * (les panneaux concernés affichent juste "aucune donnée"), et tu actives progressivement chaque
 * panneau en étendant ton propre schéma. Voir dashboard/README.md, section "Contrat de données",
 * pour le détail table par table (colonnes attendues, panneau concerné).
 *
 * Champs volontairement JAMAIS exposés par ce module, quelle que soit ta propre base — si tu
 * étends le schéma, garde cette discipline :
 *  - le contenu BRUT de messages entrants/sortants (webhooks, boîte d'envoi) ;
 *  - les identifiants de conversation / numéros (PII) ;
 *  - un résumé de session pouvant citer un extrait de conversation ;
 *  - la commande brute d'une demande d'approbation (peut contenir des chemins/valeurs sensibles).
 *
 * Texte libre venant d'une table type "jobs"/"approvals" (intent, résultat, description) : réduit
 * à un aperçu une-ligne (`preview`) avant de sortir de ce module, même derrière le PIN — ce genre
 * de champ peut être un brief complet de plusieurs milliers de caractères citant du contenu perso,
 * pas une simple métadonnée. Un dashboard doit rester glançable, pas un visualiseur de transcript.
 */

/** Aperçu une-ligne d'un champ texte libre : espaces normalisés, tronqué à `max` caractères. */
function preview(text, max = 180) {
  if (typeof text !== "string" || text.length === 0) return text;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

let db = null;
let openError = null;
// Chemin pour lequel `db`/`openError` ci-dessus sont valides — permet aux tests de rouvrir une
// base fraîche en changeant `config.dbPath` entre deux cas (sinon le premier handle ouvert
// resterait caché indéfiniment, `config.dbPath` n'étant lu qu'une fois au premier appel).
let openedForPath = null;

function getDb() {
  if (openedForPath === config.dbPath) return db;
  db = null;
  openError = null;
  openedForPath = config.dbPath;
  try {
    if (!existsSync(config.dbPath)) throw new Error(`fichier introuvable : ${config.dbPath}`);
    db = new DatabaseSync(config.dbPath, { readOnly: true });
  } catch (e) {
    openError = e;
    console.error(`[db] impossible d'ouvrir la base (${config.dbPath}) :`, e.message);
  }
  return db;
}

/** Exécute `fn(db)` et retombe sur `fallback` si la base est absente OU si la requête échoue (ex.
 *  table/colonne manquante — schéma pas encore étendu côté daemon). Jamais bloquant. */
function query(fn, fallback) {
  const d = getDb();
  if (!d) return fallback;
  try {
    return fn(d);
  } catch (e) {
    console.error("[db] requête échouée (schéma pas encore étendu ?) :", e.message);
    return fallback;
  }
}

export function dbStatus() {
  return { path: config.dbPath, ok: getDb() !== null, error: openError?.message ?? null };
}

/** Attend une table `jobs(id, intent, status, result, created_at, updated_at)`. */
export function listJobs(limit = 20) {
  return query(
    (d) =>
      d
        .prepare("SELECT id, intent, status, result, created_at, updated_at FROM jobs ORDER BY id DESC LIMIT ?")
        .all(limit)
        .map((r) => ({ ...r, intent: preview(r.intent), result: preview(r.result, 220) })),
    [],
  );
}

/** Attend une table `wakes(id, due_at, intent, status, recurrence_ms)` — c'est exactement ce que
 *  `harness/src/scheduler.ts` de ce starter écrit déjà : ce panneau fonctionne dès le premier
 *  déploiement, sans rien étendre. */
export function listWakes(limit = 20) {
  return query((d) => {
    const pending = d
      .prepare("SELECT id, due_at, intent, status, recurrence_ms FROM wakes WHERE status = 'pending' ORDER BY due_at LIMIT ?")
      .all(limit)
      .map((r) => ({ ...r, intent: preview(r.intent) }));
    const recent = d
      .prepare("SELECT id, due_at, intent, status, recurrence_ms FROM wakes WHERE status != 'pending' ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ ...r, intent: preview(r.intent) }));
    return { pending, recent };
  }, { pending: [], recent: [] });
}

/** Attend une table `session_log(session_id, scope, first_seen, last_seen, last_cost_usd, summary,
 *  source, model, effort)` — un historique de sessions, une ligne par fil. `summary` délibérément
 *  jamais sélectionné (cf. note en tête de fichier). */
export function listSessions(limit = 20) {
  return query(
    (d) =>
      d
        .prepare("SELECT session_id, scope, first_seen, last_seen, last_cost_usd, source, model, effort FROM session_log ORDER BY last_seen DESC LIMIT ?")
        .all(limit),
    [],
  );
}

/**
 * Occurrences d'un rituel nocturne (`source = 'nightly'`), la plus récente d'abord — voir
 * `src/dream-prompt.js` pour le panneau associé. Optionnel : liste vide si ton harnais n'a pas ce
 * concept, ou n'écrit pas encore cette valeur de `source`.
 */
export function listDreamSessions(limit = 20) {
  return query(
    (d) =>
      d
        .prepare(
          "SELECT session_id, scope, first_seen, last_seen, last_cost_usd, source, model, effort FROM session_log WHERE source = 'nightly' ORDER BY last_seen DESC LIMIT ?",
        )
        .all(limit),
    [],
  );
}

/** Une session précise par id complet (lien `/#/sessions/<id>`). null si absente — même exclusion
 *  de `summary` que `listSessions`. */
export function getSessionById(id) {
  return query(
    (d) =>
      d
        .prepare("SELECT session_id, scope, first_seen, last_seen, last_cost_usd, source, model, effort FROM session_log WHERE session_id = ?")
        .get(id) ?? null,
    null,
  );
}

/** Attend une table `approvals(id, description, kind, status, created_at, decided_at, command)` —
 *  `command` délibérément exclu de la sélection (cf. note en tête de fichier). */
export function listApprovals(limit = 20) {
  return query(
    (d) =>
      d
        .prepare("SELECT id, description, kind, status, created_at, decided_at FROM approvals ORDER BY id DESC LIMIT ?")
        .all(limit)
        .map((r) => ({ ...r, description: preview(r.description) })),
    [],
  );
}

/** Attend une table clé/valeur `settings(key, value, updated_at)`. */
export function getSetting(key) {
  return query((d) => d.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null, null);
}

// Portées du panneau Réglages modèle. `group` est un exemple de portée additionnelle scopée à un
// groupe (config.groupScopeId, ex. un chat_id WhatsApp) — jamais codée en dur, jamais renvoyée par
// l'API. Adapte/retire cette portée si tu n'as pas ce besoin ; ajoute les tiennes sur le même modèle.
const MODEL_SCOPES = [
  { id: "global", label: "Conversation", scopeArg: "", settingScope: "global" },
  {
    id: "group",
    label: "Groupe",
    scopeArg: "group",
    get settingScope() {
      return config.groupScopeId;
    },
  },
  { id: "jobs", label: "Jobs de fond", scopeArg: "jobs", settingScope: "jobs" },
  { id: "nightly", label: "Rituel nocturne", scopeArg: "nightly", settingScope: "nightly" },
];

function scopedSettingRow(d, key, settingScope) {
  const dbKey = settingScope === "global" ? key : `${key}:${settingScope}`;
  const row = d.prepare("SELECT value, updated_at FROM settings WHERE key = ?").get(dbKey);
  return { value: row?.value ?? "", updatedAt: row?.updated_at ?? null };
}

function modeFromSettings(scopeId, s) {
  if (s.provider.value === "deepseek") return "deepseek";
  if (s.engine.value === "codex") return "codex";
  if (s.engine.value === "claude") return "claude";
  if (s.model.value) return "claude";
  const ownEffort = s.effort.value && s.effort.value !== "auto";
  if (scopeId !== "global" && !s.model.value && !s.provider.value && !s.engine.value && !ownEffort) return "inherit";
  return "auto";
}

/** Réglages modèle/effort affichables par le panneau opérateur. Attend une table `settings`
 *  clé/valeur avec des clés `model`/`effort`/`engine`/`codex_model`/`provider`/`deepseek_model`
 *  (globales ou suffixées `:<scope>`) — un exemple de convention, adapte-la à la tienne. */
export function modelSettings() {
  return query((d) => ({
    scopes: MODEL_SCOPES.map((scope) => {
      const settings = {
        model: scopedSettingRow(d, "model", scope.settingScope),
        effort: scopedSettingRow(d, "effort", scope.settingScope),
        engine: scopedSettingRow(d, "engine", scope.settingScope),
        codexModel: scopedSettingRow(d, "codex_model", scope.settingScope),
        provider: scopedSettingRow(d, "provider", scope.settingScope),
        deepseekModel: scopedSettingRow(d, "deepseek_model", scope.settingScope),
      };
      return {
        id: scope.id,
        label: scope.label,
        scopeArg: scope.scopeArg,
        mode: modeFromSettings(scope.id, settings),
        settings,
      };
    }),
  }), { scopes: [] });
}

export function lastActivityAt() {
  return query((d) => d.prepare("SELECT MAX(last_seen) AS ts FROM session_log").get()?.ts ?? null, null);
}

/** `session_log` n'a pas forcément de colonne `provider` dédiée : déduit depuis le marqueur/modèle
 *  stocké — adapte si ta convention diffère. */
function providerOf(model) {
  if (!model) return "inconnu";
  if (model === "codex" || model.startsWith("gpt-")) return "codex";
  return model.startsWith("deepseek") ? "deepseek" : "claude";
}

/**
 * Stats de coût réel. Attend un journal APPEND-ONLY `cost_log(ts, scope, session_id, engine,
 * model, cost_usd)` — une ligne PAR TOUR, pas un upsert par session : un journal append-only est
 * important pour un total fiable (un upsert par session_id sous-compterait le dépensé réel, seul
 * le dernier coût de chaque fil survivrait à une somme).
 *
 * `byCategory` regroupe par `scope` en 3 buckets lisibles plutôt que d'exposer le `scope` brut (qui
 * peut valoir un identifiant de conversation) : `job`, `nightly` (rituel nocturne, cf.
 * `dream-prompt.js`), et `sessions` pour tout le reste.
 */
export function usageSummary(days = 30) {
  const sinceMs = Date.now() - days * 86400000;
  const since7Ms = Date.now() - 7 * 86400000;
  return query((d) => {
    const totalRow = d.prepare("SELECT SUM(cost_usd) AS usd FROM cost_log WHERE ts >= ?").get(sinceMs);
    const total7Row = d.prepare("SELECT SUM(cost_usd) AS usd FROM cost_log WHERE ts >= ?").get(since7Ms);

    const byDay = d
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, SUM(cost_usd) AS usd, COUNT(*) AS n
         FROM cost_log WHERE ts >= ? GROUP BY day ORDER BY day`,
      )
      .all(sinceMs);

    const byModel = d
      .prepare(
        `SELECT COALESCE(model, 'inconnu') AS model, SUM(cost_usd) AS usd, COUNT(*) AS n
         FROM cost_log WHERE ts >= ? GROUP BY model ORDER BY usd DESC`,
      )
      .all(sinceMs)
      .map((r) => ({ ...r, provider: providerOf(r.model === "inconnu" ? null : r.model) }));

    const byCategory = d
      .prepare(
        `SELECT CASE WHEN scope = 'job' THEN 'job' WHEN scope = 'nightly' THEN 'nightly' ELSE 'sessions' END AS category,
                SUM(cost_usd) AS usd, COUNT(*) AS n
         FROM cost_log WHERE ts >= ? GROUP BY category ORDER BY usd DESC`,
      )
      .all(sinceMs);

    return { sinceMs, days, totalUsd: totalRow?.usd ?? 0, totalUsd7: total7Row?.usd ?? 0, byDay, byModel, byCategory };
  }, { sinceMs, days, totalUsd: 0, totalUsd7: 0, byDay: [], byModel: [], byCategory: [] });
}

/**
 * Solde d'un fournisseur externe (ex. DeepSeek), SI ton daemon l'a écrit en base (clés
 * `deepseek_balance_usd` / `deepseek_balance_checked_at`). Optionnel — ce dashboard ne doit jamais
 * appeler une API externe avec une clé secrète lui-même (ça dupliquerait cette clé dans un
 * conteneur qui n'en a par ailleurs jamais eu besoin) ; il lit seulement ce que le daemon a déjà
 * écrit, s'il le fait.
 */
export function deepseekBalance() {
  const usd = getSetting("deepseek_balance_usd");
  if (usd === null) return null;
  const checkedAt = getSetting("deepseek_balance_checked_at");
  return { usd: Number(usd), checkedAt: checkedAt ? Number(checkedAt) : null };
}
