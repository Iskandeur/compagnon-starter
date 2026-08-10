/**
 * Anti-rejeu webhook de messagerie — ne pas traiter un vieux message rejoué comme s'il venait d'arriver.
 *
 * Le problème : un gateway de webhook (WAHA pour WhatsApp, et la plupart des connecteurs du même
 * genre) tamponne l'heure de RÉCEPTION sur chaque évènement, pas l'horodatage réel du message. Si le
 * connecteur rejoue un vieux message (reconnexion de session, resync après un restart, retry
 * différé), il traverse le pipeline comme s'il était neuf — avec l'heure du jour. L'agent répond
 * alors à un message potentiellement déjà traité des jours plus tôt, en double, sans le reconnaître.
 *
 * Le fix, à deux étages :
 *  1. le gateway capture AUSSI l'horodatage réel du message (`msgTs`, donné par le connecteur) à
 *     côté de l'heure de réception (`ts`) — deux champs, jamais confondus ;
 *  2. au moment d'enfiler l'évènement, on compare `ts - msgTs` : au-delà d'une fenêtre (ex. 30 min,
 *     large pour un vrai retard de livraison, court pour attraper un rejeu de plusieurs heures/jours),
 *     on PREFIXE le corps d'un avertissement explicite au lieu de le traiter comme neuf.
 *
 * On ne supprime jamais le message : un message réellement retardé (téléphone hors réseau) doit
 * rester visible, juste correctement contextualisé. L'avertissement dit à l'agent de vérifier
 * l'historique réel avant de répondre comme si c'était neuf.
 *
 * Module pur, zéro dépendance — adapte le type `WahaEvent` à ton évènement entrant.
 */

/** Évènement entrant minimal sur lequel l'anti-rejeu raisonne. Généralise à n'importe quel canal :
 *  seul `msgTs` (horodatage réel, côté connecteur) + `ts` (réception) + `source` comptent. */
export interface WahaEvent {
  /** Provenance — n'applique l'anti-rejeu qu'aux messages du connecteur (pas aux réveils internes). */
  source: string;
  /** Horodatage réel du message, tel que rapporté par le connecteur (ms). undefined si absent. */
  msgTs?: number;
  /** Horodatage de réception par le gateway (ms) — en pratique `Date.now()` au moment du webhook. */
  ts: number;
  /** Corps du message. */
  body: string;
}

/** « Un msg WhatsApp est-il suspect d'être un rejeu » — écart réel→réception au-delà de la fenêtre. */
export function isStaleReplay(ev: WahaEvent, windowMs: number): boolean {
  if (!ev.msgTs) return false; // sans horodatage réel connu, rien à comparer — on laisse passer
  return ev.ts - ev.msgTs > windowMs;
}

/** Formate une durée courte en français (« 2 min », « 3 j ») — local au module, zéro dépendance. */
export function formatGap(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} j`;
}

/** Annote un évènement rejoué : corps préfixé d'un avertissement, évènement jamais muté. PUR. */
export function annotateStaleWahaReplay<T extends WahaEvent>(ev: T, windowMs: number): T {
  if (ev.source !== "whatsapp" || !isStaleReplay(ev, windowMs)) return ev;
  const warning =
    `[⚠️ MESSAGE POTENTIELLEMENT PÉRIMÉ — horodatage réel il y a ${formatGap(ev.ts - ev.msgTs!)}. ` +
    `Probable rejeu du connecteur (reconnexion/resync), pas un message qui vient d'arriver. ` +
    `Vérifie l'historique réel avant d'y répondre comme si c'était neuf — ce sujet a peut-être ` +
    `déjà été traité.]`;
  return { ...ev, body: `${warning}\n\n${ev.body}` };
}
