/**
 * « Ce message me réveille-t-il ? » — détection d'adressage en groupe (anti-bruit).
 *
 * Dans un groupe, un agent always-on ne doit PAS se réveiller sur chaque message : le coût (appel
 * IA) et le bruit (répondre à des messages qui ne lui sont pas destinés) seraient ingérables. La
 * règle : on ne réveille l'agent que s'il est explicitement ADRESSÉ. Il y a deux façons distinctes
 * d'adresser quelqu'un, et il faut les traiter TOUTES LES DEUX — les confondre laisse des trous :
 *
 * 1. Le nom en dur dans le texte : "Hey Compagnon, tu peux ?" — un simple test de sous-chaîne
 *    (avec limite de mot, `\b`, pour éviter un faux positif du genre "Marceau" qui contient "Marc").
 *
 * 2. La MENTION STRUCTURÉE : sur WhatsApp (et la plupart des messageries), taguer quelqu'un avec
 *    "@" produit un CHAMP DÉDIÉ dans le message (liste d'identifiants mentionnés), distinct du
 *    texte affiché. Un message peut très bien contenir "@Compagnon" en texte SANS qu'aucune vraie
 *    mention structurée n'ait été postée (ex. quelqu'un tape le nom à la main, ou pire — cf.
 *    `mentions-whatsapp-piege.md` — un outil qui envoie le texte mais oublie le champ mentions).
 *    Inversement, une vraie mention structurée peut viser un numéro/id qui n'apparaît nulle part
 *    dans le texte lisible. Se fier au texte SEUL fait rater les vraies mentions et peut réagir à
 *    de faux positifs (quelqu'un qui parle DE l'agent sans s'adresser à lui).
 *
 * Ce module combine les deux, PUREMENT (aucune I/O) : à toi de brancher, en amont, le parsing du
 * payload de ta messagerie pour extraire `mentionedIds` (cf. `mentions-whatsapp-piege.md` pour le
 * cas WhatsApp/WAHA — le champ s'y appelle `mentionedJidList` côté API).
 */

export interface MentionWakeInput {
  /** Texte brut du message. */
  body: string;
  /** Nom de l'agent tel qu'il apparaît en toutes lettres (ex. "Compagnon"). */
  agentName: string;
  /** Identifiants propres à l'agent (numéro(s), id(s) de session) pour le repérage en texte brut
   *  (ex. quelqu'un tape "@33600000000" sans que ce soit une vraie mention structurée). Optionnel. */
  agentIds?: string[];
  /** Mentions STRUCTURÉES réellement présentes dans le message (extraites du payload de ta
   *  messagerie, PAS du texte) — la liste des identifiants explicitement tagués. Optionnel. */
  mentionedIds?: string[];
}

export interface MentionWakeDecision {
  addressed: boolean;
  /** Comment l'adressage a été détecté — utile pour logguer/débugger le routage. */
  via: "name" | "text-id" | "structured-mention" | "none";
}

/** Échappe une chaîne pour l'utiliser telle quelle dans un `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * L'agent est-il adressé dans ce message ? PUR → testable.
 * Ordre de vérification (le premier qui matche gagne, pour un `via` lisible) :
 *  1. Nom en toutes lettres, en limite de mot (insensible à la casse).
 *  2. Un de ses ids repéré comme "@id" DANS LE TEXTE (heuristique texte — pas une vraie mention).
 *  3. Un de ses ids présent dans les mentions STRUCTURÉES du message (la vraie mention WhatsApp).
 */
export function isAddressedByMention(input: MentionWakeInput): MentionWakeDecision {
  const { body, agentName, agentIds = [], mentionedIds = [] } = input;

  if (agentName.length > 0) {
    const re = new RegExp(`\\b${escapeRegExp(agentName)}\\b`, "i");
    if (re.test(body)) return { addressed: true, via: "name" };
  }

  if (agentIds.some((id) => id.length > 0 && body.includes("@" + id))) {
    return { addressed: true, via: "text-id" };
  }

  if (agentIds.some((id) => id.length > 0 && mentionedIds.includes(id))) {
    return { addressed: true, via: "structured-mention" };
  }

  return { addressed: false, via: "none" };
}

/** Raccourci booléen quand tu n'as pas besoin du détail `via`. */
export function wakesOnMention(input: MentionWakeInput): boolean {
  return isAddressedByMention(input).addressed;
}
