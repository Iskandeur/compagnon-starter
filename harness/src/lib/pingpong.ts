/**
 * Continuité de conversation en GROUPE (« ping-pong ») — avec garde-fou anti-boucle.
 *
 * Le problème : dans un groupe où PLUSIEURS agents peuvent parler (ex. ton compagnon et celui
 * d'un proche, tous les deux always-on), le comportement par défaut « je ne me réveille que si on
 * me nomme » est trop strict pour un vrai échange à trois ou quatre : dès que l'autre répond sans
 * redire ton nom, le fil retombe et il faut re-taguer l'agent à chaque tour.
 *
 * Le piège à ne JAMAIS rater : deux agents allumés 24/7 dans le même groupe, qui se répondent l'un
 * à l'autre SANS plafond, forment un ping-pong INFINI — chaque réponse de l'un réveille l'autre, qui
 * répond, qui réveille le premier, etc. Ce n'est pas hypothétique : ça coûte des appels API en
 * boucle et ça spam le groupe jusqu'à ce qu'un humain s'en aperçoive et coupe manuellement. D'où
 * l'exigence : un BUDGET DE TOURS strictement borné, et une commande humaine explicite pour couper
 * la continuité à tout moment, quel que soit l'état du budget.
 *
 * Modèle : une fois l'agent NOMMÉ (mention explicite — cf. `mention-wake.ts`), le budget est
 * (re)chargé à `maxTurns`. Chaque message suivant d'un TIERS (jamais les messages de l'agent
 * lui-même — à filtrer en amont, avant d'appeler ce module) consomme un tour et réveille l'agent ;
 * à budget épuisé, l'agent se tait jusqu'à être renommé. La fenêtre ne s'ouvre donc JAMAIS sur la
 * seule initiative de l'agent : il faut toujours un déclencheur explicite (un nom ou une mention).
 *
 * Coupure humaine : prévois une commande (ex. `/pingpong off` ou `/pingpong stop`) qui remet le
 * budget à 0 et/ou désactive la continuité sur-le-champ — cf. `harness/docs/pingpong-groupes.md`
 * pour le câblage complet dans le routage des messages entrants.
 *
 * Module PUR (aucune I/O) sauf `readPingPong` / `setPingPongRemaining`, qui passent par une
 * interface de stockage minimale — remplis-la avec ta propre couche de persistance (SQLite,
 * fichier JSON, ce que tu veux).
 */

/** Plafond de tours par défaut (réglable à chaud via ta commande de pilotage, persisté en storage). */
export const DEFAULT_MAX_TURNS = 6;

export interface PingPongState {
  enabled: boolean;
  maxTurns: number;
  remaining: number;
}

export interface PingPongDecision {
  wake: boolean;
  remaining: number;
  reason: string;
}

/** Surface minimale de stockage attendue (→ testable avec un faux objet, sans vraie base). */
export interface PingPongStore {
  getSetting(key: string): string | null | undefined;
}
export interface PingPongWriter {
  setSetting(key: string, value: string): void;
}

/**
 * Décide si un message de GROUPE DÉVERROUILLÉ doit réveiller l'agent, et calcule le nouveau
 * budget. PUR.
 * - nommé/mentionné → réveil, budget rechargé à `maxTurns` (le déclencheur explicite qui
 *   ouvre/relance la fenêtre) ;
 * - continuité désactivée → pas de réveil (retour au « nommé seulement ») ;
 * - budget > 0 → réveil, budget -1 ;
 * - budget épuisé → pas de réveil (l'agent se tait jusqu'à être renommé).
 */
export function decideGroupWake(named: boolean, st: PingPongState): PingPongDecision {
  if (named) return { wake: true, remaining: st.maxTurns, reason: "nommé" };
  if (!st.enabled) return { wake: false, remaining: st.remaining, reason: "continuité off" };
  if (st.remaining > 0) return { wake: true, remaining: st.remaining - 1, reason: "continuité" };
  return { wake: false, remaining: 0, reason: "budget épuisé" };
}

const intSetting = (db: PingPongStore, key: string, fallback: number): number => {
  const n = Number.parseInt(db.getSetting(key) ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Lit l'état ping-pong depuis le storage (sentinelles : `pingpong="off"` coupe ; `pingpong_max` /
 *  `pingpong_rem` entiers). PUR sauf lecture storage. */
export function readPingPong(db: PingPongStore): PingPongState {
  return {
    enabled: db.getSetting("pingpong") !== "off",
    maxTurns: intSetting(db, "pingpong_max", DEFAULT_MAX_TURNS),
    remaining: intSetting(db, "pingpong_rem", 0),
  };
}

/** Persiste le budget restant (borné à ≥ 0). */
export function setPingPongRemaining(db: PingPongWriter, n: number): void {
  db.setSetting("pingpong_rem", String(Math.max(0, Math.trunc(n))));
}
