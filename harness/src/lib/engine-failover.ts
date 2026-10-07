/**
 * engine-failover — basculer automatiquement d'un moteur LLM à un autre quand le premier ne peut
 * plus répondre, sans jamais basculer pour de mauvaises raisons. Module PUR (l'état persisté passe
 * par un petit magasin clé/valeur injecté), zéro dépendance.
 *
 * Le principe : quand le moteur qui devait servir un tour échoue sur une limite du FOURNISSEUR
 * (quota, rate-limit, surcharge), sur une AUTH morte (OAuth expiré, 401/403) ou sur un compte
 * PRÉPAYÉ vide (402), on rejoue le même tour sur l'autre moteur, on reste dessus jusqu'à l'heure de
 * retour annoncée, puis on retente le moteur préféré. Aucun sondage, aucun timer : c'est
 * l'expiration de la fenêtre qui ramène au préféré.
 *
 * Les quatre règles :
 *
 *  1. **Un épinglage humain prime, sauf quand obéir veut dire se taire.** Si l'humain a épinglé un
 *     moteur (`/model x`), un quota ne le contredit pas : il se lève seul, et il a choisi d'attendre.
 *     Mais une auth morte ou un solde prépayé à zéro ne se lèvent JAMAIS seuls. Respecter
 *     l'épinglage, là, c'est rendre l'agent muet jusqu'à ce que quelqu'un s'en aperçoive, ce que
 *     personne n'a demandé en tapant `/model`. Le tour suivant retente quand même le moteur épinglé
 *     (`resolveActiveEngine` le sert toujours en premier) : l'épinglage reste vrai, et le retour est
 *     immédiat dès que la panne est réparée.
 *  2. **Fournisseur ≠ réseau.** Changer de moteur ne répare pas un DNS mort : un aléa réseau
 *     (`isNetworkError`) se réessaie avec backoff sur le même moteur, il ne déclenche pas de bascule.
 *  3. **Jamais de bascule silencieuse.** `failoverHeaderHint` fournit une ligne d'entête à faire
 *     écrire en tête de la réponse : l'humain sait toujours quel moteur lui parle.
 *  4. **Anti ping-pong.** Si le moteur de secours échoue AUSSI, on ne rebascule pas en boucle : on
 *     pose `blockedUntilMs` (FAILOVER_BLOCK_MS) pendant lequel plus aucune bascule n'est tentée.
 *
 * Pièges vérifiés en production, d'où certains motifs :
 *  - la formule de quota la plus courante d'un CLI (« You've hit your session limit · resets 3am
 *    (UTC) ») ne contient ni « usage limit » ni « 429 » : sans motif dédié, le quota le plus banal
 *    se classait « erreur inconnue » et ne déclenchait ni retry ni bascule ;
 *  - une auth morte a le même effet pratique qu'un quota épuisé (moteur inutilisable) mais ne porte
 *    jamais d'heure de retour : la fenêtre prend alors FAILOVER_WINDOW_MS par défaut ;
 *  - « token expired » est un faux ami (fenêtre de contexte) : `isAuthError` exige un contexte d'auth.
 */

// ————— Classement des erreurs —————

/** Limites d'usage / surcharge côté fournisseur : « CE moteur est à bout, un autre passerait ». */
const QUOTA_PATTERNS = [
  /usage[ _]limit/,
  /limit reached/,
  /session limit/,
  /hit your .{0,24}limit/,
  /\bquota\b/,
  /rate[ _-]?limit/,
  /too many requests/,
  /overloaded/,
  /\b429\b/,
  /\b529\b/,
];

/** Aléas réseau passagers : « la MACHINE a hoqueté », l'autre moteur hoquetterait pareil. */
const NETWORK_PATTERNS = [
  /econnreset/,
  /econnrefused/,
  /etimedout/,
  /enotfound/,
  /eai_again/,
  /socket hang ?up/,
  /fetch failed/,
  /network (?:error|timeout)/,
  /connection (?:reset|refused|error|closed|timed? ?out)/,
  /temporarily unavailable/,
  /service unavailable/,
  /\b50[234]\b/,
];

/** Limite d'usage propre au fournisseur (quota, 429, surcharge). PUR. */
export function isQuotaError(message: string): boolean {
  const m = message.toLowerCase();
  return QUOTA_PATTERNS.some((r) => r.test(m));
}

/** Aléa réseau passager (DNS, socket, 502/503/504). PUR. */
export function isNetworkError(message: string): boolean {
  const m = message.toLowerCase();
  return NETWORK_PATTERNS.some((r) => r.test(m));
}

/** Union des deux : une erreur qui finira par se lever, donc à réessayer plutôt qu'à jeter. PUR. */
export function isTransientError(message: string): boolean {
  return isQuotaError(message) || isNetworkError(message);
}

/**
 * Compte PRÉPAYÉ à sec (402, « insufficient balance », « payment required »). PUR.
 * Distinct d'un quota : un quota se lève seul, un solde à zéro ne revient jamais sans recharge
 * humaine. C'est ce qui l'autorise à passer outre un épinglage (règle 1).
 */
export function isPrepaidExhaustedError(message: string): boolean {
  const m = message.toLowerCase();
  return /insufficient[ _](?:balance|credits?|funds)/.test(m) || /payment required/.test(m) || /\b402\b/.test(m);
}

/** Authentification morte (OAuth expiré, 401/403, login à refaire). PUR. */
export function isAuthError(message: string): boolean {
  const m = message.toLowerCase();
  if (/context (?:window|length)|max_tokens|token limit/.test(m)) return false; // faux amis
  return (
    /\boauth\b/.test(m) ||
    /unauthorized/.test(m) ||
    /\b401\b/.test(m) ||
    /\b403\b/.test(m) ||
    /authentication (?:error|failed|required)/.test(m) ||
    /not (?:logged in|authenticated)/.test(m) ||
    /(?:please |re-?)?(?:run|use) [`'"]?\/?(?:\w+ )?login/.test(m) ||
    /invalid (?:api key|credentials?|token)/.test(m) ||
    /(?:credentials?|session|refresh token|access token|auth token)[^.]{0,30}(?:expired|invalid|revoked)/.test(m)
  );
}

/** Panne qui ne se lèvera pas seule : seule famille autorisée à contredire un épinglage. PUR. */
export function isDeadEndError(message: string): boolean {
  return isAuthError(message) || isPrepaidExhaustedError(message);
}

const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Extrait de l'erreur l'instant (epoch ms) où la limite se lèvera, ou null. PUR, défensif.
 * Formes reconnues : date ISO, `retry-after: N` (secondes), « in N min/hours », horloge UTC
 * 12 h (`resets 6pm (UTC)`, `resets 9:20pm (UTC)`), horloge 24 h + date (`resets 12:24 on 9 Aug`,
 * supposée UTC), timestamp unix à 10 chiffres (`usage limit reached|1782140400`).
 * Horizon : rien au-delà de 7 jours (un nombre aberrant ne doit pas geler la bascule).
 */
export function parseRetryAfter(message: string, nowMs: number): number | null {
  const m = message;
  const horizon = nowMs + 7 * 24 * 3600_000;
  const ok = (t: number) => !Number.isNaN(t) && t > nowMs && t < horizon;

  const iso = m.match(/\b(\d{4}-\d{2}-\d{2}[tT][\d:]+(?:\.\d+)?(?:[zZ]|[+-]\d{2}:?\d{2})?)/);
  if (iso && ok(Date.parse(iso[1]))) return Date.parse(iso[1]);

  const ra = m.match(/retry[-\s]?after[:\s]+(\d+)/i);
  if (ra && ok(nowMs + Number(ra[1]) * 1000)) return nowMs + Number(ra[1]) * 1000;

  const dur = m.match(/(?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if (dur) {
    const u = dur[2].toLowerCase();
    const t = nowMs + Number(dur[1]) * (u.startsWith("h") ? 3600_000 : u.startsWith("m") ? 60_000 : 1000);
    if (ok(t)) return t;
  }

  const utcClock = m.match(/\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
  if (utcClock) {
    const hour12 = Number(utcClock[1]);
    const minute = Number(utcClock[2] ?? "0");
    if (hour12 >= 1 && hour12 <= 12 && minute <= 59) {
      const hour = (hour12 % 12) + (utcClock[3].toLowerCase() === "pm" ? 12 : 0);
      const now = new Date(nowMs);
      let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
      if (t <= nowMs) t += 24 * 3600_000; // heure déjà passée aujourd'hui → demain
      if (ok(t)) return t;
    }
  }

  const dateClock = m.match(/\bresets?\s+(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*/i);
  if (dateClock) {
    const [hour, minute, day] = [Number(dateClock[1]), Number(dateClock[2]), Number(dateClock[3])];
    const monthIdx = MONTH_ABBR[dateClock[4].toLowerCase()];
    if (hour <= 23 && minute <= 59 && day >= 1 && day <= 31 && monthIdx !== undefined) {
      const year = new Date(nowMs).getUTCFullYear();
      let t = Date.UTC(year, monthIdx, day, hour, minute);
      if (t <= nowMs) t = Date.UTC(year + 1, monthIdx, day, hour, minute);
      if (ok(t)) return t;
    }
  }

  const ts = m.match(/\b(1[0-9]{9})\b/);
  if (ts && ok(Number(ts[1]) * 1000)) return Number(ts[1]) * 1000;
  return null;
}

// ————— Décision de bascule —————

/** Faute d'heure de retour annoncée, durée passée sur le moteur de secours avant de retenter. */
export const FAILOVER_WINDOW_MS = 60 * 60_000; // 1 h
/** Borne haute de la fenêtre, même si l'erreur annonce un retour lointain. */
export const FAILOVER_WINDOW_CAP_MS = 6 * 3600_000; // 6 h
/** Après un DOUBLE échec, durée pendant laquelle aucune bascule n'est tentée (anti ping-pong). */
export const FAILOVER_BLOCK_MS = 30 * 60_000; // 30 min

/** État persisté. Tout à 0 / null = rien en cours. */
export interface FailoverState {
  /** epoch ms — tant que `now < untilMs`, les tours partent sur `engine`. */
  untilMs: number;
  /** epoch ms — tant que `now < blockedUntilMs`, aucune bascule n'est tentée. */
  blockedUntilMs: number;
  /** Moteur de secours pendant la fenêtre. */
  engine: string | null;
}

export const NO_FAILOVER: FailoverState = { untilMs: 0, blockedUntilMs: 0, engine: null };

/**
 * Moteur effectif pour CE tour. L'épinglage est consulté AVANT la fenêtre de secours (règle 1) :
 * un `/model x` explicite pendant un épisode renvoie bien sur x, même s'il échoue encore. PUR.
 */
export function resolveActiveEngine(p: {
  pinned: string | null;
  state: FailoverState;
  preferred: string;
  nowMs: number;
}): { engine: string; auto: boolean; reason: "pinned" | "failover" | "default" } {
  if (p.pinned) return { engine: p.pinned, auto: false, reason: "pinned" };
  if (p.state.engine && p.state.untilMs > p.nowMs) return { engine: p.state.engine, auto: true, reason: "failover" };
  return { engine: p.preferred, auto: false, reason: "default" };
}

/**
 * Faut-il rejouer CE tour sur `fallback` après l'échec de `failedEngine` ? PUR. Dit non par défaut.
 */
export function shouldFailover(p: {
  failedEngine: string;
  fallback: string;
  errorMessage: string;
  pinned: string | null;
  preferred: string;
  state: FailoverState;
  nowMs: number;
  enabled: boolean;
}): boolean {
  if (!p.enabled) return false;
  if (p.fallback === p.failedEngine) return false;
  // Règle 1 : un épinglage ne cède que devant une panne qui ne se lèvera pas seule.
  if (p.pinned && !isDeadEndError(p.errorMessage)) return false;
  // Le moteur à sauver est celui qui devait servir (l'épinglage passe avant la préférence) : un
  // échec du moteur de SECOURS ne déclenche pas une bascule de plus (c'est la règle 4).
  if (p.failedEngine !== (p.pinned ?? p.preferred)) return false;
  if (p.nowMs < p.state.blockedUntilMs) return false; // règle 4
  // Règle 2 : fournisseur à bout ou panne sans issue, jamais un simple aléa réseau.
  return isQuotaError(p.errorMessage) || isDeadEndError(p.errorMessage);
}

/** Fin de la fenêtre de secours : heure de retour annoncée (+5 s), sinon FAILOVER_WINDOW_MS ;
 *  bornée par FAILOVER_WINDOW_CAP_MS. PUR. */
export function failoverWindowUntil(errorMessage: string, nowMs: number): number {
  const resetsAt = parseRetryAfter(errorMessage, nowMs);
  const delay = resetsAt ? resetsAt - nowMs + 5000 : FAILOVER_WINDOW_MS;
  return nowMs + Math.min(Math.max(delay, 0), FAILOVER_WINDOW_CAP_MS);
}

/** Le moteur de secours a sauvé le tour : on reste dessus jusqu'au retour, l'anti-boucle est levé. PUR. */
export function afterFailoverSucceeded(errorMessage: string, nowMs: number, fallback: string): FailoverState {
  return { untilMs: failoverWindowUntil(errorMessage, nowMs), blockedUntilMs: 0, engine: fallback };
}

/** Le secours a échoué AUSSI : on ferme la bascule et on s'interdit d'en retenter une un moment.
 *  L'appelant retombe sur son retry avec backoff habituel (borné de son côté). PUR. */
export function afterFailoverFailed(nowMs: number): FailoverState {
  return { untilMs: 0, blockedUntilMs: nowMs + FAILOVER_BLOCK_MS, engine: null };
}

/** Après un tour réussi : un succès du PRÉFÉRÉ prouve qu'il est revenu → état effacé ; un succès
 *  du secours ne prouve rien sur le préféré → état inchangé. PUR. */
export function afterEngineSucceeded(engine: string, prev: FailoverState, preferred: string): FailoverState {
  return engine === preferred ? NO_FAILOVER : prev;
}

/**
 * Clé de session par moteur. Un id de session d'un CLI et un id de fil d'un autre vivent dans des
 * espaces différents : passer l'un à l'autre fait échouer la reprise. Le moteur préféré garde la
 * clé historique (aucune migration), les autres prennent un préfixe. PUR.
 */
export function engineSessionKey(scope: string, engine: string, preferred: string): string {
  return engine === preferred ? scope : `${engine}:${scope}`;
}

/** Ligne d'entête à faire écrire en tête de la réponse pendant une bascule (règle 3). PUR. */
export function failoverHeaderHint(failedEngine: string, fallback: string): string {
  return (
    "[entête-moteur] Commence ta réponse par cette ligne seule, puis saut de ligne :\n" +
    `⊙ ${fallback} · bascule auto (${failedEngine} indisponible : quota, auth ou solde)`
  );
}

// ————— Persistance (injectée) —————
//
// L'état DOIT survivre à un redémarrage du daemon : sinon un restart en plein épisode renvoie le
// tour suivant sur un moteur toujours mort. N'importe quel magasin clé/valeur convient (table
// `settings` SQLite, fichier JSON…). Une valeur absente ou illisible = rien en cours, jamais une
// exception : un état corrompu ne doit pas empêcher de répondre.

export interface KeyValueStore {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

const KEY_UNTIL = "engine_failover_until";
const KEY_BLOCKED = "engine_failover_blocked_until";
const KEY_ENGINE = "engine_failover_engine";

function readMs(store: KeyValueStore, key: string): number {
  const n = Number.parseInt(store.get(key) || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function readFailoverState(store: KeyValueStore): FailoverState {
  return {
    untilMs: readMs(store, KEY_UNTIL),
    blockedUntilMs: readMs(store, KEY_BLOCKED),
    engine: store.get(KEY_ENGINE) || null,
  };
}

/** Écrit "" plutôt que "0" pour un champ vide (un réglage vide se relit comme absent). */
export function writeFailoverState(store: KeyValueStore, s: FailoverState): void {
  store.set(KEY_UNTIL, s.untilMs > 0 ? String(s.untilMs) : "");
  store.set(KEY_BLOCKED, s.blockedUntilMs > 0 ? String(s.blockedUntilMs) : "");
  store.set(KEY_ENGINE, s.engine ?? "");
}
