/**
 * INTERRUPTION D'UN TOUR EN COURS PAR UNE RÉACTION — « j'ai envoyé le mauvais message, arrête ».
 *
 * Le problème : un compagnon persistant traite un message en tâche longue (plusieurs dizaines de
 * secondes à plusieurs minutes de raisonnement). Quand l'humain réalise, deux secondes après avoir
 * appuyé sur envoyer, qu'il s'est trompé, il n'a aucun moyen de rattraper : l'agent réfléchit déjà,
 * et un « non attends, oublie » arrive derrière dans la file — donc APRÈS le tour qu'il voulait
 * annuler. Il paie le calcul, il lit une réponse hors sujet, il réécrit.
 *
 * Le geste : il pose une réaction (🛑 par défaut) sur N'IMPORTE quel message du fil — le sien comme
 * un de l'agent. Aucune cible à viser précisément : dans l'urgence d'un « zut, je me suis trompé »,
 * exiger le bon message serait une friction de plus au pire moment.
 *
 * ⚠️ POURQUOI CE MODULE EST PUR (aucune I/O), et c'est TOUT l'enjeu : la décision « ceci est un
 * stop » doit être prise **synchroniquement à l'arrivée du webhook**, dans le chemin d'`enqueue`,
 * jamais dans le handler qui ne s'exécute qu'une fois la lane libre. Un stop qui attend son tour
 * dans la file s'exécute après le tour qu'il devait tuer, et n'interrompt donc rien du tout. Câbler
 * ce prédicat au mauvais endroit produit une fonctionnalité qui a l'air de marcher (les tests
 * passent, l'accusé part) et qui n'annule jamais rien.
 *
 * Périmètre volontairement étroit, et chaque restriction est un garde-fou :
 *  - un seul canal (celui où l'humain principal parle à l'agent), jamais un canal en lecture seule
 *    ni un canal inconnu ;
 *  - seulement une réaction dont l'AUTEUR est l'humain principal — un tiers dans un groupe ne peut
 *    pas couper la parole à l'agent ;
 *  - jamais l'écho des réactions posées par l'agent lui-même (accusés de réception du type 👀/✅),
 *    qui remontent par le même webhook et porteraient sinon l'agent à s'auto-interrompre.
 *
 * Ce module ne fait que DÉCIDER et FORMULER. L'exécution (tuer le process du tour, vider la file en
 * attente, acquitter ce qui a été abandonné pour qu'il ne soit pas rejoué au démarrage suivant)
 * appartient à l'orchestrateur, qui branche `cancelledTurnError()` sur son `AbortController`.
 */

/** Emoji par défaut du stop. À choisir HORS de tout autre usage de réaction dans ton système : si
 *  le même emoji sert ailleurs (validation d'une action sensible, déclenchement d'un traitement),
 *  un geste d'urgence deviendra ambigu exactement le jour où il doit être sans ambiguïté. */
export const DEFAULT_CANCEL_REACT_EMOJI = "🛑";

/**
 * Marqueur porté par l'erreur d'un tour tué à la demande.
 *
 * Pourquoi un drapeau et pas le texte du message : `AbortSignal.reason` traverse plusieurs couches
 * (moteur d'inférence, wrappers, journalisation) qui peuvent tronquer ou reformater une chaîne. Le
 * drapeau, lui, survit — et c'est lui qui distingue « l'humain a dit stop » d'une vraie panne.
 */
const CANCELLED_FLAG = "turnCancelledByUser";

/** Évènement entrant minimal sur lequel le prédicat raisonne. */
export interface CancelReactionInput {
  /** Canal de transport (ex. `"whatsapp"`, `"telegram"`). */
  source?: string;
  /** Compte/conversation logique par lequel l'évènement arrive (ex. `"principal"`, `"readonly"`). */
  channel?: string;
  /** Vrai si l'évènement est l'écho d'une action de l'agent lui-même. */
  fromMe?: boolean;
  /** La réaction, si l'évènement en est une. */
  reaction?: { emoji: string; targetMsgId: string };
}

export interface CancelReactionOptions {
  /** Emoji actif. Chaîne vide = fonctionnalité éteinte par configuration. */
  emoji: string;
  /**
   * L'auteur de la réaction est-il l'humain principal ? Calculé par l'appelant, qui seul connaît sa
   * table de correspondance : en 1:1 l'auteur est le chat lui-même, en groupe c'est l'expéditeur
   * réel de la réaction, qui n'est pas le chat.
   */
  isPrincipalAuthor: boolean;
  /** Transport accepté. Défaut `"whatsapp"`. */
  source?: string;
  /** Canaux depuis lesquels un stop est recevable. Défaut : `["principal"]`. */
  allowedChannels?: string[];
}

/**
 * Cette réaction est-elle l'ordre « arrête ce que tu fais » ? Fonction pure → testable sans
 * orchestrateur, et surtout appelable dans le chemin synchrone d'arrivée d'un webhook.
 */
export function isCancelTurnReaction(ev: CancelReactionInput, o: CancelReactionOptions): boolean {
  if (!ev.reaction) return false;
  if (!o.emoji) return false; // emoji vide = désactivé par configuration
  if (ev.source !== (o.source ?? "whatsapp")) return false;
  const allowed = o.allowedChannels ?? ["principal"];
  if (!ev.channel || !allowed.includes(ev.channel)) return false;
  if (ev.fromMe) return false; // écho des accusés posés par l'agent — jamais un ordre
  if (!o.isPrincipalAuthor) return false; // un tiers ne coupe pas la parole
  return ev.reaction.emoji === o.emoji;
}

/** L'erreur à poser comme `AbortSignal.reason` : le moteur la relèvera telle quelle. */
export function cancelledTurnError(emoji: string): Error {
  const err = new Error(`Tour interrompu à la demande (réaction ${emoji}).`);
  (err as Error & Record<string, unknown>)[CANCELLED_FLAG] = true;
  return err;
}

/**
 * Ce rejet vient-il d'un stop demandé ?
 *
 * Sert à NE PAS le traiter comme une panne, et c'est la moitié du travail : sans ce test, un tour
 * tué déclenche tout le protocole d'échec — réessai, bascule sur un moteur de secours, alerte
 * « évènement mort ». L'agent relancerait donc exactement le calcul que l'humain venait d'annuler.
 */
export function isCancelledTurn(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as Record<string, unknown>)[CANCELLED_FLAG] === true;
}

/**
 * Confirmation à renvoyer. TOUJOURS une réponse, jamais un silence : sans accusé, l'humain ne sait
 * pas si son stop est arrivé à temps — et il réagit une deuxième fois, ou renvoie son message en
 * doublon. Le cas « rien à interrompre » mérite donc sa phrase, autant que le cas où ça a mordu.
 *
 * Les messageries grand public ne rendent pas le markdown : `*gras*` en asterisque simple sur
 * WhatsApp, jamais `**gras**`. Adapte à ton transport.
 */
export function cancelConfirmationText(o: { aborted: boolean; dropped: number }): string {
  if (!o.aborted && o.dropped === 0) return "🛑 Rien en cours de mon côté, rien à interrompre.";
  const bits: string[] = [];
  if (o.aborted) bits.push("le tour en cours");
  if (o.dropped > 0) bits.push(o.dropped === 1 ? "1 message en attente" : `${o.dropped} messages en attente`);
  return `🛑 Stop. J'ai lâché ${bits.join(" et ")}. Renvoie-moi la bonne version quand tu veux.`;
}
