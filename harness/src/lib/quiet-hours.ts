/**
 * Heures calmes — réduire la concurrence des jobs de fond quand l'humain est éveillé. PUR.
 *
 * Problème : l'agent et son humain partagent souvent UNE seule souscription LLM, avec une fenêtre
 * de quota glissante (quelques heures). Plusieurs jobs de fond qui tournent en pleine journée
 * mangent cette fenêtre, et c'est l'humain qui se retrouve sans quota au moment où il veut
 * travailler. Le remède n'est pas de moins travailler, c'est de travailler MOINS FORT pendant ses
 * heures d'éveil : la concurrence tombe à 1 dans la plage, puis remonte la nuit.
 *
 * ⚠️ Le fuseau est la moitié du problème. Un serveur tourne typiquement en UTC, l'humain vit
 * ailleurs. Une plage « 08:00-20:00 » comparée à l'heure UTC nue est fausse d'une ou deux heures,
 * et l'écart change deux fois par an avec l'heure d'été : figer un offset (« +02:00 ») casse aussi.
 * D'où : l'heure locale se résout par `Intl.DateTimeFormat` avec un nom de zone IANA, jamais par
 * un offset. Le test du fuseau dans `quiet-hours.test.ts` échoue pour une comparaison UTC nue
 * comme pour un offset figé.
 *
 * Usage, dans la boucle du runner de jobs (relu à CHAQUE tour, pour qu'un changement de réglage
 * prenne effet sans redémarrer le daemon) :
 *   const n = effectiveConcurrency(settings.get("quiet_hours"), JOBS_CONCURRENCY, Date.now());
 * avec un réglage du genre "08:00-20:00 Europe/Paris" (zone omise → `defaultTz`).
 */

/** Zone par défaut si le réglage n'en nomme pas. "UTC" est un repli neutre : nomme toujours la
 *  zone de TON humain dans le réglage, sinon la plage sera décalée. */
export const DEFAULT_QUIET_TZ = "UTC";

/** Concurrence pendant les heures calmes : une lane, pas zéro (rien ne s'arrête, tout ralentit). */
export const QUIET_CONCURRENCY = 1;

export interface QuietHours {
  /** Minutes depuis minuit, heure LOCALE de `tz`. */
  startMin: number;
  endMin: number;
  /** Zone IANA (ex. "Europe/Paris", "America/New_York"). */
  tz: string;
}

/** "08:00-20:00" ou "08:00-20:00 Europe/Paris" → plage. `null` sur vide/invalide : réglage absent
 *  ou mal tapé = pas de bridage, jamais de crash du runner. */
export function parseQuietHours(raw: string | null | undefined, defaultTz: string = DEFAULT_QUIET_TZ): QuietHours | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(?:\s+(\S+))?$/.exec(s);
  if (!m) return null;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const startMin = h1 * 60 + m1;
  const endMin = h2 * 60 + m2;
  // Bornes identiques : 24 h/24 ou 0 h/24 selon l'interprétation. On refuse plutôt que de choisir.
  if (startMin === endMin) return null;
  return { startMin, endMin, tz: m[5]?.trim() || defaultTz };
}

/** Minutes depuis minuit dans la zone `tz` pour un epoch ms (via Intl, heure d'été comprise).
 *  Lève si la zone est inconnue : c'est `inQuietHours` qui décide du sens de la panne. */
export function localMinutes(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return (get("hour") % 24) * 60 + get("minute");
}

/**
 * L'instant `ts` tombe-t-il dans la plage calme ? Gère le passage de minuit ("22:00-06:00").
 *
 * Sens de la panne : une zone inconnue rend `false`, on ne bride pas. Un bridage fantôme serait
 * pire qu'un bridage manquant : il gèlerait la file sans que rien ne le dise.
 */
export function inQuietHours(spec: QuietHours | null, ts: number): boolean {
  if (!spec) return false;
  let min: number;
  try {
    min = localMinutes(ts, spec.tz);
  } catch {
    return false;
  }
  return spec.startMin < spec.endMin
    ? min >= spec.startMin && min < spec.endMin
    : min >= spec.startMin || min < spec.endMin; // plage à cheval sur minuit
}

/** Concurrence à appliquer MAINTENANT. `base` = la concurrence de démarrage. Ne l'augmente jamais. */
export function effectiveConcurrency(
  rawSetting: string | null | undefined,
  base: number,
  ts: number,
  defaultTz: string = DEFAULT_QUIET_TZ,
): number {
  return inQuietHours(parseQuietHours(rawSetting, defaultTz), ts) ? Math.min(base, QUIET_CONCURRENCY) : base;
}

/** Rendu lisible d'un réglage, pour une commande /status ou un rapport. */
export function describeQuietHours(rawSetting: string | null | undefined, defaultTz: string = DEFAULT_QUIET_TZ): string {
  const spec = parseQuietHours(rawSetting, defaultTz);
  if (!spec) return "aucune (les jobs tournent à pleine concurrence 24 h/24)";
  try {
    localMinutes(0, spec.tz);
  } catch {
    // Même sens de panne qu'inQuietHours : ne pas annoncer un bridage qui n'aura pas lieu.
    return `aucune (zone inconnue « ${spec.tz} » : les jobs tournent à pleine concurrence)`;
  }
  const hm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  return `${hm(spec.startMin)}–${hm(spec.endMin)} (${spec.tz}) → concurrence ${QUIET_CONCURRENCY}`;
}
