/**
 * Garde-fou d'envoi WhatsApp — la ceinture de sécurité *mécanique* (pas comportementale).
 *
 * Contexte : une rafale de messages envoyés d'un coup, souvent vers plusieurs destinataires, est
 * exactement le signal que les plateformes de messagerie (WhatsApp/Meta en tête) traitent comme du
 * spam et sanctionnent — jusqu'au bannissement du numéro. Un fix purement comportemental (« je fais
 * attention ») ne suffit pas : un agent qui raisonne peut se tromper, halluciner une urgence,
 * ou simplement mal évaluer une rafale légitime. D'où un garde-fou qui ne dépend PAS du jugement de
 * l'agent au moment de l'envoi, branché en hook PreToolUse sur les outils d'envoi WhatsApp.
 *
 * Quatre verrous :
 *  1. **HOLD** — si le hold d'envoi est actif (ex. canal en cours de reconnexion), rien ne part.
 *  2. **Cadence** — espacement minimal entre 2 envois + plafonds glissants (5 min / 1 h).
 *  3. **Fan-out** — nombre de destinataires DISTINCTS par heure / par jour (le vrai signal spam
 *     côté plateforme). Le chat du principal (l'humain que l'agent sert) est exempté du fan-out
 *     (jamais du reste).
 *  4. **Groupes verrouillés par défaut** — un envoi vers un groupe exige une allowlist EXPLICITE
 *     (fichier versionné) ; et un canal « lecture seule » par design (le canal personnel de
 *     l'humain, utilisé pour LIRE ses messages, pas pour parler à sa place) refuse tout envoi via
 *     ce module — l'impersonation exige une validation humaine explicite à chaque fois, jamais
 *     automatique (cf. `harness/docs/wa-guard-et-impersonation.md`).
 *
 * Ce module est pur (aucune I/O) pour rester testable ; l'I/O vit dans `bin/wa-guard.ts`.
 */

/** Un envoi déjà effectué (persisté côté I/O — état runtime, hors de ce module). */
export type SendEvent = { ts: number; chat: string; tool: string };

export type GuardLimits = {
  /** Espacement minimal entre deux envois, ms. */
  minGapMs: number;
  /** Plafond d'envois sur 5 minutes. */
  maxPer5min: number;
  /** Plafond d'envois sur 1 heure. */
  maxPerHour: number;
  /** Destinataires distincts max sur 1 heure (hors le principal). */
  maxChatsPerHour: number;
  /** Destinataires distincts max sur 24 h (hors le principal). */
  maxChatsPerDay: number;
};

export const DEFAULT_LIMITS: GuardLimits = {
  minGapMs: 4_000,
  maxPer5min: 10,
  maxPerHour: 40,
  maxChatsPerHour: 3,
  maxChatsPerDay: 8,
};

/** Chat du principal (exempté du fan-out) — placeholder générique, à surcharger via WA_GUARD_OWNER
 *  (variable d'env) dans ton propre déploiement. Ne JAMAIS committer un vrai numéro ici. */
export const OWNER_CHAT = "0000000000@c.us";

export type GuardRequest = {
  tool: string;
  chat: string;
  /** Hold d'envoi actif ? */
  hold: boolean;
  /** Envoi vers des groupes déverrouillés (allowlist versionnée, cf. `groupUnlocked`) ? */
  groupsUnlocked: boolean;
  /** Chat du principal (exempté du fan-out). */
  owner?: string;
};

export type GuardDecision = { allow: boolean; reason: string };

/**
 * Outils considérés comme « envoi » (donc soumis au garde-fou). Convention de nommage attendue :
 * `mcp__whatsapp_<session>__<verbe>`, avec deux sessions distinctes possibles :
 *  - `own`   : le numéro dédié de l'agent — il y parle en son nom, envoi normal ;
 *  - `human` : le numéro personnel de l'humain — l'agent y LIT, il n'y envoie jamais directement
 *              (cf. règle 0 de `decide`, plus bas).
 * Adapte les noms de session à ta propre config MCP si elle diffère.
 */
export function isSendTool(tool: string): boolean {
  return /^mcp__whatsapp_(own|human)__(send-|status-send-|forward-message)/.test(tool);
}

/** Endpoints REST qui envoient réellement quelque chose. En minuscules : le chemin est normalisé
 *  avant comparaison, une casse différente ne doit pas ouvrir une porte dérobée. */
const API_CALL_SEND_PATHS = new Set([
  "/api/forwardmessage",
  "/api/send/buttons/reply",
  "/api/send/link-custom-preview",
  "/api/sendbuttons",
  "/api/sendcontactvcard",
  "/api/sendfile",
  "/api/sendimage",
  "/api/sendlinkpreview",
  "/api/sendlist",
  "/api/sendlocation",
  "/api/sendpoll",
  "/api/sendpollvote",
  "/api/sendseen",
  "/api/sendtext",
  "/api/sendvideo",
  "/api/sendvoice",
]);

/** `/api/{session}/status/(text|image|video|voice)` — l'équivalent « statut » des envois ci-dessus. */
const API_CALL_STATUS_SEND_RE = /^\/api\/[^/]+\/status\/(text|image|video|voice)$/;

function normalizeApiCallPath(input: Record<string, unknown> | undefined): string {
  const raw = typeof input?.path === "string" ? input.path : "";
  return raw.split("?")[0].replace(/\/+$/, "").toLowerCase();
}

/**
 * Un appel `api-call` générique est-il, DE FAIT, un envoi ?
 *
 * ⚠️ La raison d'être de cette fonction : la plupart des wrappers MCP exposent, à côté des outils
 * `send-*` dédiés, un `api-call` passe-partout qui atteint les mêmes endpoints REST. Sans ce test,
 * tout le garde-fou (cadence, fan-out, verrou des groupes, tags bruts) se contourne en une ligne —
 * et il se contourne précisément par le chemin que la doc recommande pour les mentions. Un
 * garde-fou qui ne couvre que la porte principale ne garde rien.
 */
export function isApiCallSend(tool: string, input: Record<string, unknown> | undefined): boolean {
  if (!/^mcp__whatsapp_(own|human)__api-call$/.test(tool)) return false;
  const method = typeof input?.method === "string" ? input.method.toUpperCase() : "";
  if (method !== "POST") return false;
  const path = normalizeApiCallPath(input);
  return API_CALL_SEND_PATHS.has(path) || API_CALL_STATUS_SEND_RE.test(path);
}

/** Clés dont la valeur finit sous les yeux du destinataire. Tout le reste (identifiants, options
 *  techniques) n'a pas à être scanné : on cherche du texte PUBLIÉ, pas des métadonnées. */
const PUBLIC_TEXT_KEYS = new Set([
  "text",
  "body",
  "caption",
  "description",
  "title",
  "message",
  "footer",
  "button",
  "buttons",
  "name",
  "options",
  "rowId",
  "url",
]);

function collectPublicText(value: unknown, key: string | undefined, out: string[]): void {
  if (typeof value === "string") {
    if (key === "body") {
      // `body` d'un `api-call` peut arriver en JSON stringifié (cf. `parsedBody`) — recurser dans sa
      // vraie forme plutôt que de scanner l'enveloppe comme un bloc de texte opaque.
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          collectPublicText(parsed, key, out);
          return;
        }
      } catch {
        /* pas du JSON valide : traité comme texte brut ci-dessous */
      }
    }
    if (key && PUBLIC_TEXT_KEYS.has(key) && value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPublicText(item, key, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value)) collectPublicText(child, childKey, out);
}

/**
 * `body` d'un `api-call` peut arriver en OBJET ou en CHAÎNE JSON selon la façon dont l'appelant a
 * sérialisé ses paramètres — le schéma de l'outil ne déclare souvent aucun type pour ce champ, donc
 * rien ne force le parsing en amont. Sans ce détour, `body.mentions` paraît absent alors qu'il est
 * rempli, et une mention correctement formée se fait refuser à tort.
 */
function parsedBody(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const raw = input?.body;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Un « @ » suivi d'un identifiant numérique long : la forme d'un tag brut, celle qui s'affiche en
 *  clair chez le destinataire au lieu de mentionner quelqu'un. */
const RAW_MENTION_RE = /@\d{6,}/;

/**
 * Le tag/mention de cet envoi est-il correctement formé ? Voir `docs/mentions-whatsapp-piege.md`.
 *
 *  - outil `send-*` (aucun champ `mentions` exposé) + tag brut dans le texte → refus : il faut
 *    passer par `api-call POST /api/send…` avec `body.mentions` ;
 *  - `api-call` reconnu comme un envoi + tag brut + `body.mentions` absent ou vide → refus, le
 *    champ a été oublié ;
 *  - `body.mentions` rempli, ou aucun tag brut détecté → laisse passer.
 *
 * Le refus porte un message qui dit QUOI FAIRE, pas seulement « interdit » : ce garde-fou se
 * déclenche au moment où l'agent croyait avoir fini, et une erreur sans issue le pousse à ruser.
 */
export function decideMentionFormat(tool: string, input: Record<string, unknown> | undefined): GuardDecision {
  const apiSend = isApiCallSend(tool, input);
  if (!apiSend && !isSendTool(tool)) return { allow: true, reason: "pas un envoi" };

  const texts: string[] = [];
  collectPublicText(input, undefined, texts);
  if (!texts.some((t) => RAW_MENTION_RE.test(t))) return { allow: true, reason: "aucun tag brut détecté" };

  if (apiSend) {
    const body = parsedBody(input) ?? {};
    const mentions = Array.isArray(body.mentions) ? body.mentions : [];
    if (mentions.length > 0) return { allow: true, reason: "mention déclarée via body.mentions" };
    return {
      allow: false,
      reason:
        "Tag brut « @<numéro> » détecté mais body.mentions est vide/absent — ajoute " +
        'mentions:["<numéro>@c.us"] ou ["<lid>@lid"] dans le body avant d\'envoyer, sinon le tag ' +
        "s'affichera en clair.",
    };
  }
  return {
    allow: false,
    reason:
      `Tag brut « @<numéro> » détecté dans un envoi via ${tool} (pas de champ mentions). ` +
      "Passe par mcp__whatsapp_*__api-call (POST /api/sendText, body.mentions:[\"<numéro>@c.us\" ou \"<lid>@lid\"]), " +
      "ou adresse-toi par le prénom sans @.",
  };
}

const HOUR = 3_600_000;

/** Décision du garde-fou. Pure : on lui passe l'historique et l'instant. */
export function decide(events: SendEvent[], req: GuardRequest, limits: GuardLimits, now: number): GuardDecision {
  // 0. Impersonation : le canal humain n'envoie JAMAIS directement via cet outil. C'est un choix de
  //    conception, pas une limitation technique : parler à la place d'un humain sur son propre
  //    numéro doit toujours passer par une validation humaine explicite AVANT l'envoi (cf. doc).
  if (req.tool.startsWith("mcp__whatsapp_human__")) {
    return {
      allow: false,
      reason:
        "Envoi refusé : ce canal est READ-ONLY par design. Pour parler au nom de l'humain, passe par " +
        "ton propre circuit de validation explicite (demande → accord → envoi) — jamais un envoi direct.",
    };
  }

  // 1. Hold (ex. canal en cours de reconnexion, ou explicitement gelé).
  if (req.hold) {
    return { allow: false, reason: "Envoi refusé : HOLD actif (canal en réparation ou gelé). Attends le GO explicite avant de réessayer." };
  }

  // 2. Groupes : le multi-destinataires est le vecteur de ban le plus lourd côté plateforme.
  if (req.chat.endsWith("@g.us") && !req.groupsUnlocked) {
    return {
      allow: false,
      reason:
        "Envoi refusé : message vers un GROUPE non déverrouillé. Route par le principal (il transfère), " +
        "ou déverrouille ce groupe après son accord explicite (allowlist VERSIONNÉE → commit).",
    };
  }

  const recent = events.filter((e) => e.ts > now - 24 * HOUR);
  const last = recent.reduce((m, e) => Math.max(m, e.ts), 0);

  // 3. Cadence.
  if (last && now - last < limits.minGapMs) {
    const wait = Math.ceil((limits.minGapMs - (now - last)) / 1000);
    return { allow: false, reason: `Envoi refusé : cadence. Attends ~${wait}s entre deux messages (anti-rafale).` };
  }
  const in5 = recent.filter((e) => e.ts > now - 5 * 60_000).length;
  if (in5 >= limits.maxPer5min) {
    return { allow: false, reason: `Envoi refusé : ${in5} messages en 5 min (plafond ${limits.maxPer5min}). Regroupe en UN message et reprends dans quelques minutes.` };
  }
  const inHour = recent.filter((e) => e.ts > now - HOUR).length;
  if (inHour >= limits.maxPerHour) {
    return { allow: false, reason: `Envoi refusé : ${inHour} messages dans l'heure (plafond ${limits.maxPerHour}).` };
  }

  // 4. Fan-out (hors le principal) — le signal spam le plus lourd côté plateforme.
  const owner = req.owner || OWNER_CHAT;
  if (req.chat !== owner) {
    const distinct = (since: number) =>
      new Set(recent.filter((e) => e.ts > since && e.chat !== owner).map((e) => e.chat));
    const h = distinct(now - HOUR);
    if (!h.has(req.chat) && h.size >= limits.maxChatsPerHour) {
      return { allow: false, reason: `Envoi refusé : déjà ${h.size} destinataires distincts dans l'heure (plafond ${limits.maxChatsPerHour}). C'est exactement le motif de ban le plus fréquent — passe par le principal.` };
    }
    const d = distinct(now - 24 * HOUR);
    if (!d.has(req.chat) && d.size >= limits.maxChatsPerDay) {
      return { allow: false, reason: `Envoi refusé : ${d.size} destinataires distincts sur 24 h (plafond ${limits.maxChatsPerDay}).` };
    }
  }

  return { allow: true, reason: "ok" };
}

/**
 * Parse le contenu du fichier d'allowlist groupe en set de chatIds autorisés. Une ligne = un
 * groupe (`…@g.us`) ; `#` commente ; `*` = tous les groupes. Un préfixe `!` (`!<id>@g.us`) reste un
 * groupe AUTORISÉ à l'envoi (le `!` est retiré ici) mais marque, pour `parseRestrictedGroups`, un
 * groupe RESTREINT (cf. cette fonction). Rendu pur (pas d'I/O) pour rester testable — la lecture du
 * fichier vit dans `bin/wa-guard.ts`.
 */
export function parseGroupAllowlist(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    out.add(t.startsWith("!") ? t.slice(1).trim() : t);
  }
  return out;
}

/**
 * Groupes marqués `!<id>@g.us` dans l'allowlist : envoi autorisé (cf. `parseGroupAllowlist`) mais en
 * régime RESTREINT — deux effets combinés :
 *  1. SANS continuité de conversation — l'agent répond quand on le tague, il ne reste pas engagé
 *     sur les messages suivants (contrairement au régime par défaut sur un groupe déverrouillé) ;
 *  2. Seul le PRINCIPAL peut invoquer l'agent dans ce groupe — un tag par un tiers du groupe est
 *     ignoré, silencieusement.
 * Utile pour des groupes où l'agent doit rester disponible mais pilotable par une seule personne.
 * Rendu pur, même fichier source que `parseGroupAllowlist` (pas de 2ᵉ liste qui pourrait diverger).
 */
export function parseRestrictedGroups(content: string): Set<string> {
  const out = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("!")) continue;
    const id = t.slice(1).trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Ce groupe est-il déverrouillé selon l'allowlist ? `*` ouvre tous les groupes ; une allowlist
 * VIDE (fichier présent mais sans entrée) = rétrocompat d'un geste « touch = tout ouvrir ». Sinon,
 * seuls les chatIds listés passent.
 */
export function groupUnlocked(allow: Set<string>, chat: string): boolean {
  if (allow.size === 0) return true;
  return allow.has("*") || allow.has(chat);
}

/**
 * Extrait le chatId de l'input d'un outil d'envoi (best-effort, plusieurs conventions de nommage).
 *
 * ⚠️ Regarde AUSSI dans `body` : sur un `api-call`, le destinataire est niché là et pas à la racine.
 * Sans ce repli, la cadence et le verrou des groupes s'appliquaient à un chat `"?"` — c'est-à-dire à
 * personne, donc à rien.
 */
export function chatOf(input: Record<string, unknown> | undefined): string {
  if (!input) return "?";
  const pick = (o: Record<string, unknown>): unknown => o.chatId ?? o.to ?? o.chat_id ?? o.participant;
  const direct = pick(input);
  if (typeof direct === "string" && direct) return direct;
  const body = parsedBody(input);
  const nested = body ? pick(body) : undefined;
  return typeof nested === "string" && nested ? nested : "?";
}
