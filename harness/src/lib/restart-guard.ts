/**
 * Garde-fou de REDEMARRAGE — « un restart demandé aboutit TOUJOURS, et rien ne se perd ».
 *
 * Le problème que ce module règle : un script de restart s'exécute DANS le réveil courant de
 * l'agent. Avant que `systemctl restart` n'ait réellement démarré le nouveau process, un message
 * entrant peut faire couper le réveil courant — et le process de restart meurt avant d'aboutir.
 * Résultat : le daemon tourne toujours sur l'ancien code, sans que personne ne le sache, jusqu'à
 * ce qu'un humain frustré relance manuellement (et casse parfois le correctif au passage).
 *
 * Deux verrous, indépendants (ceinture + bretelles) :
 *  1. Le lanceur de restart (cf. `bin/restart.ts`) détache le `systemctl` (setsid) → il survit à
 *     la mort du réveil qui l'a demandé.
 *  2. CE module : un DRAPEAU « restart en cours » en base. Tant qu'il est posé, l'orchestrateur ne
 *     démarre plus de nouveau réveil : il MET EN ATTENTE les évènements durables (déjà persistés
 *     en inbox) — ils seront rejoués au boot suivant, donc traités « juste après », jamais perdus.
 *
 * Et le corollaire d'acquittement : on n'acquitte QUE ce qui est réellement EN VOL (`in-flight`,
 * le ou les messages du réveil qui demande le restart), jamais tout le « pending » en bloc — sinon
 * un message arrivé pendant le restart serait acquitté sans avoir été lu → perdu. Ce qui n'est pas
 * en vol reste « pending » → rejoué au boot, sans doublon.
 *
 * Module pur (aucune I/O, aucune dépendance) : la persistance vit derrière les interfaces
 * `RestartStore` / `InboxAcker`, à faire remplir par ta propre couche de stockage (SQLite, fichier
 * JSON, ce que tu veux).
 */

/** Clé du drapeau (valeur = epoch ms de la demande de restart, en texte). */
export const RESTART_FLAG_KEY = "restart_pending_at";
/** Préfixe des clés « évènements en vol », une par voie. */
export const INFLIGHT_KEY_PREFIX = "inbox_inflight_";
/** Les voies de l'orchestrateur susceptibles de demander un restart (adapte à ton architecture :
 *  ici, une voie « conversation » et une voie « fond/tâches planifiées »). */
export const LANES = ["conv", "wake"] as const;
/**
 * Durée de vie du drapeau. Filet de sécurité : si le restart N'ABOUTIT PAS (permission refusée,
 * service manager en rade), le daemon ne doit pas rester sourd pour toujours. Passé ce délai,
 * l'orchestrateur relâche ce qu'il gardait et reprend son travail normal. Un restart réel prend
 * ~1-3 s : ce TTL ne joue qu'en cas d'échec.
 */
export const RESTART_HOLD_MS = 60_000;

/** Surface minimale attendue du stockage (→ testable avec un faux objet, sans vraie base). */
export interface RestartStore {
  getSetting(key: string): string | null | undefined;
  setSetting(key: string, value: string): void;
}

/** Surface d'acquittement d'inbox (ta base la remplit). */
export interface InboxAcker {
  markInboxDone(id: number): void;
}

/** Le drapeau brut est-il ACTIF à `now` ? PUR → testable.
 *  Vide/absent/illisible → non. Trop vieux (> ttl) → non (le restart a échoué : on reprend la
 *  main). Horodatage dans le futur (horloge qui recule) → actif, par prudence. */
export function holdActiveAt(raw: string | null | undefined, now: number, ttlMs: number = RESTART_HOLD_MS): boolean {
  const at = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(at) || at <= 0) return false;
  const age = now - at;
  if (age < 0) return true;
  return age <= ttlMs;
}

/** Pose le drapeau « restart en cours » (à appeler AVANT de lancer le redémarrage réel). */
export function markRestartPending(db: RestartStore, now: number = Date.now()): void {
  db.setSetting(RESTART_FLAG_KEY, String(now));
}

/** Retire le drapeau. Appelé au BOOT (le restart a abouti : le drapeau est périmé par nature) et
 *  quand le TTL expire sans restart (échec → on reprend la main). */
export function clearRestartPending(db: RestartStore): void {
  db.setSetting(RESTART_FLAG_KEY, "");
}

/** Un restart est-il en cours (drapeau posé et non périmé) ? */
export function restartHoldActive(db: RestartStore, now: number = Date.now(), ttlMs: number = RESTART_HOLD_MS): boolean {
  return holdActiveAt(db.getSetting(RESTART_FLAG_KEY), now, ttlMs);
}

/** Parse une liste d'ids d'inbox sérialisée (JSON). Défensif : jamais d'exception. PUR. */
export function parseIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  } catch {
    return [];
  }
}

/** Publie les ids d'inbox EN VOL sur une voie (liste vide = plus rien en vol).
 *  C'est ce que le lanceur de restart — un AUTRE process — lira pour acquitter juste ce qu'il faut. */
export function setInflight(db: RestartStore, lane: string, ids: number[]): void {
  db.setSetting(INFLIGHT_KEY_PREFIX + lane, ids.length > 0 ? JSON.stringify(ids) : "");
}

/** Tous les ids d'inbox actuellement en vol (toutes voies confondues), dédoublonnés. */
export function inflightIds(db: RestartStore, lanes: readonly string[] = LANES): number[] {
  const out = new Set<number>();
  for (const lane of lanes) for (const id of parseIds(db.getSetting(INFLIGHT_KEY_PREFIX + lane))) out.add(id);
  return [...out];
}

/** Oublie les vols en cours (au BOOT : les process qui les portaient sont morts). */
export function clearInflight(db: RestartStore, lanes: readonly string[] = LANES): void {
  for (const lane of lanes) db.setSetting(INFLIGHT_KEY_PREFIX + lane, "");
}

/**
 * Acquitte EXACTEMENT les messages en vol — jamais un « marquer tout le pending comme fait » en
 * bloc. Pourquoi c'est le cœur du fix : le message en vol est celui que l'agent vient de traiter
 * (il a déjà répondu, il demande le restart) → l'acquitter évite le doublon de rejeu au boot. Tout
 * le reste du « pending » — dont les messages arrivés PENDANT le restart — n'est PAS touché →
 * rejoué au boot, donc traité « juste après », jamais perdu. Renvoie le nombre d'ids acquittés.
 */
export function ackInflight(db: RestartStore & InboxAcker, lanes: readonly string[] = LANES): number {
  const ids = inflightIds(db, lanes);
  for (const id of ids) db.markInboxDone(id);
  clearInflight(db, lanes);
  return ids.length;
}
