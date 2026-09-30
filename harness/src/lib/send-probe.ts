/**
 * Sonder avant de déclarer un envoi en échec — une erreur 5xx ne prouve pas que rien n'est parti.
 *
 * Le problème : un gateway de messagerie (WAHA pour WhatsApp, et la plupart des connecteurs qui
 * pilotent un client web) peut répondre une erreur serveur APRÈS avoir livré le message. L'échec
 * porte alors sur la lecture du reçu (l'objet qui porte l'id du message, perdu côté navigateur avant
 * d'être lu), pas sur l'envoi. Un agent qui relance « parce que ça a échoué » envoie le même message
 * deux fois à son humain.
 *
 * Le fix : sur un 5xx, relire les derniers messages du fil. Si un message envoyé par l'agent, au
 * corps STRICTEMENT identique, est apparu à l'instant, l'envoi a réussi : on renvoie son id et on ne
 * relance pas. Sinon, on lève l'erreur d'origine, inchangée.
 *
 * Trois règles qui font la sûreté du pattern :
 *  - un 4xx (session inexistante, destinataire invalide) prouve que rien n'est parti : on ne sonde pas ;
 *  - égalité STRICTE du corps : un faux négatif coûte un doublon, un faux positif coûterait un message
 *    jamais envoyé qu'on croirait parti — le second est bien pire, donc dans le doute on ne trouve rien ;
 *  - la sonde ne fait jamais échouer plus que l'erreur d'origine : si elle plante, on lève l'originale.
 *
 * La sonde est une LECTURE : elle ne doit pas consommer de quota d'envoi ni passer par un coupe-circuit
 * anti-flood (qui doit rester strictement sur les envois).
 *
 * Module pur, zéro dépendance — l'I/O (envoi, lecture du fil) est injecté par l'appelant.
 */

/** Réponse minimale d'un envoi : statut HTTP, id si succès, texte d'erreur sinon. */
export interface SendResult {
  ok: boolean;
  status: number;
  id?: string | null;
  errorText?: string;
}

/** Faut-il sonder le fil avant de conclure à l'échec ? Seulement sur une erreur serveur (5xx). */
export function shouldProbe(status: number): boolean {
  return status >= 500;
}

/**
 * Le message vient-il d'être envoyé par moi ? PUR.
 *
 * Cherche dans `msgs` (liste brute renvoyée par l'API « derniers messages du fil ») un message
 * `fromMe === true` dont le corps est STRICTEMENT égal à `text` et dont l'horodatage tombe dans la
 * fenêtre `withinMs` autour de `nowMs`. Renvoie son id, ou null.
 *
 * L'horodatage est attendu en SECONDES (forme WAHA : `timestamp`, ou `_data.t`). L'écart d'horloge est
 * toléré dans les deux sens : le gateway et l'agent n'ont pas forcément la même heure.
 */
export function pickRecentOwnMessage(msgs: unknown, text: string, nowMs: number, withinMs: number): string | null {
  const list: any[] = Array.isArray(msgs) ? msgs : [];
  for (const m of list) {
    if (m?.fromMe !== true) continue;
    const body: unknown = m?.body ?? m?._data?.body;
    if (typeof body !== "string" || body !== text) continue;
    const ts: unknown = m?.timestamp ?? m?._data?.t;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
    if (Math.abs(nowMs - ts * 1000) > withinMs) continue;
    const id: unknown = m?.id?._serialized ?? m?._data?.id?._serialized ?? m?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * Envoie, et sur un 5xx vérifie dans le fil avant de lever.
 *
 * `send` fait l'envoi réel ; `probe` relit le fil et renvoie l'id du message s'il y est déjà (typiquement
 * `pickRecentOwnMessage` sur la réponse de l'API messages). `warn` reçoit une ligne quand un doublon est
 * évité ou quand la sonde est indisponible.
 */
export async function sendWithProbe(deps: {
  send: () => Promise<SendResult>;
  probe: () => Promise<string | null>;
  warn?: (line: string) => void;
}): Promise<string | null> {
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const res = await deps.send();
  if (res.ok) return res.id ?? null;
  const err = new Error(`envoi échoué ${res.status} : ${(res.errorText ?? "").slice(0, 300)}`);
  if (shouldProbe(res.status)) {
    try {
      const found = await deps.probe();
      if (found) {
        warn(`le gateway a répondu ${res.status} APRÈS avoir livré le message (id=${found}) — doublon évité, pas de relance.`);
        return found;
      }
    } catch (e) {
      warn(`sonde indisponible (${String(e)}) — on s'en tient à l'erreur d'envoi.`);
    }
  }
  throw err;
}
