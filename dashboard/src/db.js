import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * Lecture SEULE de la base du harnais. Ouverte en `readOnly: true` (SQLite refuse toute écriture
 * au niveau moteur, pas seulement via le bind mount `:ro` du conteneur — défense en profondeur).
 *
 * Tables volontairement EXCLUES de ce dashboard, documentées aussi dans le README :
 *  - `inbox`   : payload BRUT des webhooks entrants (contenu de conversation).
 *  - `outbox`  : corps de messages EN ATTENTE de validation (contenu de conversation).
 *  - `trust`   : chat_id (numéros de téléphone / identifiants — PII).
 *  - `task_messages` : titres de tâches personnelles.
 *  - `session_log.summary` : peut contenir un extrait de ce qui se passait dans la session —
 *    exposé nulle part par l'API ci-dessous, même si la colonne existe en base.
 *  - `approvals.command` : la commande shell brute d'une demande d'approbation (peut contenir
 *    des chemins/valeurs sensibles) — seule la description est exposée.
 *
 * Piège vécu : `jobs.intent`/`jobs.result` ne sont PAS de simples métadonnées — ce sont des briefs
 * complets (parfois plusieurs milliers de caractères), qui peuvent citer du contenu perso. Un
 * dashboard doit rester glançable, pas un visualiseur de transcript complet → tout texte libre est
 * réduit à un aperçu une-ligne (`preview`) avant de sortir de ce module, même derrière le PIN.
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

export function dbStatus() {
  return { path: config.dbPath, ok: getDb() !== null, error: openError?.message ?? null };
}

export function listJobs(limit = 20) {
  const d = getDb();
  if (!d) return [];
  const rows = d.prepare("SELECT id, intent, status, result, created_at, updated_at FROM jobs ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ ...r, intent: preview(r.intent), result: preview(r.result, 220) }));
}

export function listWakes(limit = 20) {
  const d = getDb();
  if (!d) return { pending: [], recent: [] };
  const pending = d
    .prepare("SELECT id, due_at, intent, created_by, status, recurrence_ms, sensor FROM wakes WHERE status = 'pending' ORDER BY due_at LIMIT ?")
    .all(limit)
    .map((r) => ({ ...r, intent: preview(r.intent) }));
  const recent = d
    .prepare("SELECT id, due_at, intent, created_by, status, recurrence_ms, sensor FROM wakes WHERE status != 'pending' ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({ ...r, intent: preview(r.intent) }));
  return { pending, recent };
}

/**
 * Cadence/statut des wakes portant un sensor nommé (colonne `wakes.sensor`) — pour le panneau
 * Sensors. Un sensor récurrent reste `status='pending'` en permanence si ton scheduler ré-arme la
 * MÊME ligne (`due_at` avancé) qu'il ait déclenché ou non. Donc ceci donne la cadence et la
 * prochaine échéance connues, PAS un historique des évaluations passées — ce dernier n'est pas
 * persisté en base à moins que tu journalises aussi `sensor_evals` (voir README, section Sensors).
 */
export function listSensorWakes() {
  const d = getDb();
  if (!d) return [];
  return d.prepare("SELECT id, sensor, due_at, recurrence_ms, status FROM wakes WHERE sensor IS NOT NULL ORDER BY sensor, id").all();
}

/**
 * Décompte réel des évaluations d'un sensor depuis `sinceMs` (table `sensor_evals`, optionnelle
 * côté harnais) : combien de ticks sont restés silencieux (`changed:false`, zéro token) vs. ont
 * réellement réveillé une session (`changed:true`). Table absente (base pas migrée) → zéros,
 * jamais de crash (même best-effort que le reste de ce module en lecture seule).
 */
export function sensorEvalCounts(sensor, sinceMs) {
  const d = getDb();
  if (!d) return { changedTrue: 0, changedFalse: 0, lastAt: null };
  try {
    const row = d
      .prepare(
        `SELECT
           SUM(CASE WHEN changed = 1 THEN 1 ELSE 0 END) AS changedTrue,
           SUM(CASE WHEN changed = 0 THEN 1 ELSE 0 END) AS changedFalse,
           MAX(ts) AS lastAt
         FROM sensor_evals WHERE sensor = ? AND ts >= ?`,
      )
      .get(sensor, sinceMs);
    return { changedTrue: row?.changedTrue ?? 0, changedFalse: row?.changedFalse ?? 0, lastAt: row?.lastAt ?? null };
  } catch {
    return { changedTrue: 0, changedFalse: 0, lastAt: null };
  }
}

export function listSessions(limit = 20) {
  const d = getDb();
  if (!d) return [];
  // `summary` délibérément exclu de la sélection (cf. note en tête de fichier).
  return d
    .prepare("SELECT session_id, scope, first_seen, last_seen, last_cost_usd, source, model, effort FROM session_log ORDER BY last_seen DESC LIMIT ?")
    .all(limit);
}

/**
 * Sessions du cycle nocturne Dream (`source = 'dream'`), la plus récente d'abord — si ton harnais
 * a ce genre de cycle et le journalise avec ce marqueur (voir `dream-prompt.js`). Liste vide sinon,
 * pas une erreur. Mêmes exclusions que `listSessions` (pas de `summary`).
 */
export function listDreamSessions(limit = 20) {
  const d = getDb();
  if (!d) return [];
  return d
    .prepare(
      "SELECT session_id, scope, first_seen, last_seen, last_cost_usd, source, model, effort FROM session_log WHERE source = 'dream' ORDER BY last_seen DESC LIMIT ?",
    )
    .all(limit);
}

/** Une session précise par id complet (lien /#/sessions/<id> du dashboard). null si absente —
 *  même exclusion de `summary` que listSessions. */
export function getSessionById(id) {
  const d = getDb();
  if (!d) return null;
  return (
    d
      .prepare("SELECT session_id, scope, first_seen, last_seen, last_cost_usd, source, model, effort FROM session_log WHERE session_id = ?")
      .get(id) ?? null
  );
}

export function listApprovals(limit = 20) {
  const d = getDb();
  if (!d) return [];
  // `command` délibérément exclu de la sélection (cf. note en tête de fichier).
  return d
    .prepare("SELECT id, description, kind, status, created_at, decided_at FROM approvals ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({ ...r, description: preview(r.description) }));
}

export function getSetting(key) {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

// Identifiant interne (chat_id) d'un groupe multi-agents nommé — vient de config.groupChatId
// (GROUP_CHAT_ID), jamais codé en dur ici. Utilisé uniquement pour lire les clés SQLite : l'API ne
// le renvoie jamais et le navigateur ne peut pas choisir un chat_id arbitraire. Adapte `label` et
// l'id de ce scope à TON propre groupe (ou retire-le si tu n'as pas ce cas d'usage).
const MODEL_SCOPES = [
  { id: "global", label: "Conversation", scopeArg: "", settingScope: "global" },
  {
    id: "group",
    label: "Groupe",
    scopeArg: "group",
    get settingScope() {
      return config.groupChatId;
    },
  },
  { id: "jobs", label: "Jobs de fond", scopeArg: "jobs", settingScope: "jobs" },
  { id: "dream", label: "Cycle Dream", scopeArg: "dream", settingScope: "dream" },
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

/** Réglages modèle/effort affichables par le panneau opérateur.
 *  Le groupe est la seule portée non-global/jobs/dream exposée par défaut : son chat_id reste une
 *  constante interne (config). Les pseudo-scopes `jobs`/`dream` sont des clés dédiées
 *  (`model:jobs`, etc.), pas des chat_id. */
export function modelSettings() {
  const d = getDb();
  if (!d) return { scopes: [] };
  return {
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
  };
}

export function lastActivityAt() {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT MAX(last_seen) AS ts FROM session_log").get();
  return row?.ts ?? null;
}

/** `session_log` n'a pas de colonne `provider` dédiée : on déduit depuis le marqueur/modèle stocké. */
function providerOf(model) {
  if (!model) return "inconnu";
  if (model === "codex" || model.startsWith("gpt-")) return "codex";
  return model.startsWith("deepseek") ? "deepseek" : "claude";
}

/**
 * Stats de coût réel sur `cost_log` — un journal APPEND-ONLY (une ligne PAR TOUR). Couvre
 * sessions/réveils/Dream/jobs de fond si ton harnais écrit ce journal (voir README, panneau
 * Usage & billing, pour le piège à éviter si tu comptes plutôt sur `session_log`).
 *
 * ⚠️ NE PAS revenir sur `session_log` pour ces totaux : si c'est un UPSERT par session_id, seul le
 * DERNIER coût de chaque fil survit, donc sommer sous-compte le dépensé réel.
 *
 * `byCategory` regroupe par `scope` en 3 buckets lisibles plutôt que d'exposer le `scope` brut
 * (qui peut être un identifiant de conversation) : `job` (JOB_SCOPE), `dream` (DREAM_SCOPE), et
 * `sessions` pour tout le reste.
 */
export function usageSummary(days = 30) {
  const sinceMs = Date.now() - days * 86400000;
  const since7Ms = Date.now() - 7 * 86400000;
  const d = getDb();
  if (!d) return { sinceMs, days, totalUsd: 0, totalUsd7: 0, byDay: [], byModel: [], byCategory: [] };

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
      `SELECT CASE WHEN scope = 'job' THEN 'job' WHEN scope = 'dream' THEN 'dream' ELSE 'sessions' END AS category,
              SUM(cost_usd) AS usd, COUNT(*) AS n
       FROM cost_log WHERE ts >= ? GROUP BY category ORDER BY usd DESC`,
    )
    .all(sinceMs);

  return {
    sinceMs,
    days,
    totalUsd: totalRow?.usd ?? 0,
    totalUsd7: total7Row?.usd ?? 0,
    byDay,
    byModel,
    byCategory,
  };
}

/**
 * Solde DeepSeek, S'IL a été écrit en base par ton daemon (réglages `deepseek_balance_usd` /
 * `deepseek_balance_checked_at`). `null` si ton harnais n'écrit pas encore ces clés. Ce dashboard
 * ne doit JAMAIS appeler l'API DeepSeek lui-même (ça exigerait de dupliquer une clé API secrète
 * ici, une surface de secret que ce dashboard lecture-seule n'a jamais eue) — il lit seulement ce
 * que le harnais y a déjà écrit, si tu as câblé ça côté harnais.
 */
export function deepseekBalance() {
  const usd = getSetting("deepseek_balance_usd");
  if (usd === null) return null;
  const checkedAt = getSetting("deepseek_balance_checked_at");
  return { usd: Number(usd), checkedAt: checkedAt ? Number(checkedAt) : null };
}
