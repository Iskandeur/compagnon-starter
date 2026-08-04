/**
 * Coalescing des messages entrants — fusionner une rafale en UN SEUL réveil.
 *
 * Le problème : un humain qui écrit vite envoie souvent 3-4 messages courts d'affilée plutôt qu'un
 * seul message long. Sans rien faire, chacun déclenche son propre réveil de l'agent → réponses
 * fragmentées, coût multiplié, et parfois une réponse au message 1 qui ne tient déjà plus compte du
 * message 3 arrivé entre-temps.
 *
 * Le fix, à latence bornée (jamais plus que la fenêtre configurée) :
 *  - **pendant un réveil en cours** : les messages suivants du même chat sont accumulés puis
 *    fusionnés au prochain tour (zéro délai ajouté — ils partent dès que l'agent se libère) ;
 *  - **agent libre** : une petite **fenêtre de grâce** (~2 s par défaut) s'ouvre au premier message ;
 *    tout ce qui arrive du même chat pendant la fenêtre est fusionné en un seul évènement ;
 *  - **signal d'attente** : un mot-clé (ex. « att » pour « attends ») envoyé SEUL dans un message
 *    rallonge la fenêtre — l'humain n'a pas fini d'écrire. Ce signal n'est jamais transmis comme
 *    contenu à traiter, il ne fait que déclencher l'attente.
 *
 * Module pur pour les prédicats (`isCoalesceable`, `isWaitSignal`, `planEnqueue`, `mergeMessages`),
 * plus une petite classe `GraceCoalescer` qui orchestre buffer + fenêtre + file, injectable dans un
 * test (timers réels, valeurs faibles) sans dépendre d'un orchestrateur applicatif complet.
 */

/** Évènement entrant minimal sur lequel le coalescing raisonne. Généralise à n'importe quel canal
 *  de messagerie (WhatsApp, Telegram, Slack...) : seul `chatId` + le contenu comptent ici. */
export interface CoalesceEvent {
  /** Identifiant de conversation. Les messages du même `chatId` sont fusionnables entre eux. */
  chatId?: string;
  /** Contenu textuel. */
  body: string;
  /** Marque les messages non-texte (vocal, image, réaction...) — jamais fusionnés, traités seuls. */
  voice?: unknown;
  reaction?: unknown;
  image?: unknown;
}

/** Fusionne plusieurs évènements d'un même chat en un seul (corps concaténés, ligne par ligne).
 *  Les métadonnées (hors `body`) sont celles du DERNIER évènement de la rafale. PUR → testable. */
export function mergeMessages<T extends CoalesceEvent>(events: T[]): T {
  const last = events[events.length - 1];
  const body = events.map((e) => e.body).filter((b) => b.trim().length > 0).join("\n");
  return { ...last, body };
}

/** Un message texte « simple » (ni commande, ni vocal, ni réaction, ni image) est-il fusionnable
 *  dans une rafale ? Les autres types sont traités seuls et tout de suite. PUR → testable. */
export function isCoalesceable(ev: CoalesceEvent): boolean {
  return !!ev.chatId && !ev.voice && !ev.reaction && !ev.image && !ev.body.trim().startsWith("/");
}

/** Signal de contrôle « attends » : l'humain a envoyé le token SEUL dans un message (ex. « att »).
 *  Ce n'est pas du contenu à traiter — ça rallonge la fenêtre d'attente avant de traiter la pile.
 *  PUR → testable. Insensible à la casse / aux espaces ; doit être TOUT le message. */
export function isWaitSignal(ev: CoalesceEvent, token: string): boolean {
  return isCoalesceable(ev) && ev.body.trim().toLowerCase() === token.toLowerCase();
}

/** Décision de routage à l'arrivée d'un évènement (PUR → testable) :
 *  - `buffer`   : fusionnable + un réveil est déjà en cours → accumulé, versé au prochain tour ;
 *  - `grace`    : fusionnable + agent libre + fenêtre de grâce active → on attend brièvement la
 *                 suite d'une rafale ;
 *  - `dispatch` : tout le reste (non-fusionnable, ou grâce désactivée) → traité tout de suite. */
export function planEnqueue(ev: CoalesceEvent, opts: { processing: boolean; graceMs: number }): "buffer" | "grace" | "dispatch" {
  if (!isCoalesceable(ev)) return "dispatch";
  if (opts.processing) return "buffer";
  if (opts.graceMs > 0) return "grace";
  return "dispatch";
}

export interface GraceCoalescerConfig {
  /** Fenêtre de grâce quand l'agent est libre (ms). 0 = désactivée (dispatch immédiat). */
  graceMs: number;
  /** Mot-clé qui, seul dans un message, rallonge la fenêtre (ex. "att"). Vide = signal désactivé. */
  waitSignalToken: string;
  /** Durée de la fenêtre rallongée par le signal d'attente (ms). */
  waitSignalMs: number;
  /** Traite un évènement (déjà fusionné si rafale). Doit résoudre quand le traitement est fini. */
  handle: (ev: CoalesceEvent) => Promise<void>;
}

/**
 * Orchestration minimale du coalescing : une file séquentielle (« un traitement à la fois »), un
 * buffer pour les messages qui arrivent pendant un traitement, et une fenêtre de grâce (+ signal
 * d'attente) pour les messages qui arrivent alors que l'agent est libre. Regroupe TOUJOURS par
 * `chatId` — deux chats distincts ne se fusionnent jamais entre eux.
 */
export class GraceCoalescer {
  private readonly cfg: GraceCoalescerConfig;
  private readonly queue: CoalesceEvent[] = [];
  private readonly buffer = new Map<string, CoalesceEvent[]>();
  private readonly graceBuffer = new Map<string, CoalesceEvent[]>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  constructor(cfg: GraceCoalescerConfig) {
    this.cfg = cfg;
  }

  /** Point d'entrée : à appeler pour chaque évènement entrant. */
  enqueue(ev: CoalesceEvent): void {
    // Signal « attends » : rallonge la fenêtre (sans rien ajouter à la pile). Sans effet si un
    // traitement tourne déjà (on ne peut pas suspendre un tour en cours).
    if (this.cfg.waitSignalToken && isWaitSignal(ev, this.cfg.waitSignalToken)) {
      if (!this.processing && this.cfg.waitSignalMs > 0) this.armGrace(this.cfg.waitSignalMs);
      return;
    }
    switch (planEnqueue(ev, { processing: this.processing, graceMs: this.cfg.graceMs })) {
      case "buffer": {
        const key = ev.chatId ?? "";
        const buf = this.buffer.get(key) ?? [];
        buf.push(ev);
        this.buffer.set(key, buf);
        return;
      }
      case "grace": {
        const key = ev.chatId ?? "";
        const buf = this.graceBuffer.get(key) ?? [];
        buf.push(ev);
        this.graceBuffer.set(key, buf);
        // Timer armé une seule fois depuis le 1er message (latence bornée). Un « att » peut le rallonger.
        if (!this.graceTimer) this.armGrace(this.cfg.graceMs);
        return;
      }
      default: {
        // Non-fusionnable (ou grâce off) : on vide d'abord une rafale en attente (ordre préservé),
        // puis on enfile cet évènement et on pompe.
        this.drainGraceToQueue();
        this.queue.push(ev);
        void this.pump();
      }
    }
  }

  /** (Re)arme le timer de la fenêtre de grâce à `ms` depuis maintenant. */
  private armGrace(ms: number): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.flushGrace(), ms);
    this.graceTimer.unref?.();
  }

  /** Verse la rafale accumulée pendant la fenêtre de grâce dans la file (fusionnée par chat) et
   *  désarme le timer. NE pompe PAS (l'appelant décide quand). */
  private drainGraceToQueue(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.graceBuffer.size === 0) return;
    for (const events of this.graceBuffer.values()) {
      this.queue.push(events.length === 1 ? events[0] : mergeMessages(events));
    }
    this.graceBuffer.clear();
  }

  /** Fin de la fenêtre de grâce (timer) : on verse la rafale fusionnée et on lance le traitement. */
  private flushGrace(): void {
    this.drainGraceToQueue();
    void this.pump();
  }

  /** Verse le buffer accumulé pendant un traitement (fusionné par chat) dans la file. */
  private drainBuffer(): void {
    if (this.buffer.size === 0) return;
    for (const events of this.buffer.values()) {
      this.queue.push(events.length === 1 ? events[0] : mergeMessages(events));
    }
    this.buffer.clear();
  }

  /** Boucle séquentielle : un évènement à la fois, jamais deux `handle()` en vol simultanément. */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const ev = this.queue.shift() as CoalesceEvent;
        await this.cfg.handle(ev);
        this.drainBuffer();
      }
    } finally {
      this.processing = false;
    }
  }
}
