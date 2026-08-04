/**
 * Calculs purs autour des réveils programmés (self-scheduling, voir docs/self-scheduling.md).
 * Aucune I/O ici — tout est testable sans base ni horloge système (on passe `now` en paramètre).
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse une durée humaine en millisecondes.
 * Accepte des combinaisons : "2h", "30m", "1d", "90s", "1h30m".
 */
export function parseDuration(input: string): number {
  const re = /(\d+)\s*([smhd])/g;
  let ms = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    matched = true;
    ms += parseInt(m[1], 10) * UNIT_MS[m[2]];
  }
  if (!matched) throw new Error(`Durée invalide : "${input}" (ex: "2h", "30m", "1h30m").`);
  return ms;
}

export interface WakeWhen {
  in?: string; // durée relative, ex "2h"
  at?: string; // timestamp absolu ISO 8601
}

/** Calcule l'échéance epoch (ms) d'un réveil. */
export function computeDueAt(when: WakeWhen, now: number = Date.now()): number {
  if (when.at) {
    const t = Date.parse(when.at);
    if (Number.isNaN(t)) throw new Error(`--at invalide : "${when.at}" (attendu ISO 8601).`);
    return t;
  }
  if (when.in) return now + parseDuration(when.in);
  throw new Error("schedule-wake : fournis --in <durée>, --at <ISO> ou --every <durée>.");
}

/**
 * Prochaine échéance d'un réveil récurrent. PUR. Robuste au downtime : si on a raté plusieurs
 * créneaux (daemon arrêté), on saute directement au prochain créneau FUTUR (pas de rafale de
 * rattrapage). `recurrenceMs` doit être > 0.
 */
export function nextOccurrence(dueAt: number, recurrenceMs: number, now: number = Date.now()): number {
  let next = dueAt + recurrenceMs;
  if (next <= now) {
    const missed = Math.ceil((now - dueAt) / recurrenceMs);
    next = dueAt + missed * recurrenceMs;
    if (next <= now) next += recurrenceMs;
  }
  return next;
}
