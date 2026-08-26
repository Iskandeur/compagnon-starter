/**
 * `voice-audit` — détecteurs mécaniques de « tics de LLM » dans TES messages sortants, en français.
 *
 * D'où ça vient. Le skill `humanizer` (github.com/blader/humanizer, 33 motifs, adossé au guide
 * « Signs of AI writing » de Wikipédia) est écrit pour de la prose encyclopédique **anglaise**. Ce
 * module en retient uniquement ce qui survit à la traduction vers du **chat en français**, et
 * uniquement ce qui se compte sans appeler un LLM — l'audit doit être gratuit, sinon il ne tournera
 * jamais assez souvent pour servir.
 *
 * Pourquoi mécaniser plutôt que « faire attention ». Une règle qu'on se rappelle ne tient pas ; un
 * compteur, lui, tient. Se relire une fois ne suffit pas — un tic qui revient sur 100 messages ne
 * se voit pas message par message, seulement dans l'agrégat.
 *
 * ⚠️ Ce n'est PAS un détecteur d'IA et ça ne cherche pas à te faire passer pour humain auprès de
 * quelqu'un qui l'ignorerait. Le but est qu'un message se lise comme quelqu'un qui écrit à
 * quelqu'un, pas comme un essai. Un compteur haut est un signal à regarder, jamais un verdict :
 * `humanizer` lui-même insiste sur les faux positifs (§ « What NOT to flag »), et une énumération
 * honnête vaut mieux qu'une phrase tordue pour tomber sous un seuil.
 *
 * Tout ici est PUR (pas d'I/O, zéro dépendance) — la récupération de tes propres messages (WhatsApp,
 * Telegram, journal…) et le CLI qui les nourrit à ce module vivent côté appelant, hors de ce fichier.
 */

export interface VoiceHit {
  detector: string;
  excerpt: string;
}

export interface VoiceReport {
  /** Texte réellement analysé (code, URLs et gabarits retirés). */
  analyzed: string;
  hits: VoiceHit[];
  /** Nombre de tics par 1000 caractères analysés — comparable entre un message court et un long. */
  per1000: number;
  countsByDetector: Record<string, number>;
}

/**
 * Un message écrit par TON daemon lui-même (gabarit de redémarrage, réponse de commande, notice
 * système…) n'a pas d'auteur humain à auditer — l'inclure mesurerait un gabarit, pas ta voix.
 *
 * Générique à dessein : plutôt que deviner tes propres gabarits, tu les passes en paramètre. Deux
 * familles suffisent dans la pratique : des PRÉFIXES littéraux (un message de statut commence
 * toujours par la même icône/phrase) et des PATTERNS plus larges (une réponse de commande a une
 * forme, pas un préfixe fixe). Si ton daemon fabrique aussi un compte-rendu de secours qui RECOPIE
 * une consigne interne sous ton nom (ça arrive : un rapport de tâche qui échoue et que le daemon
 * résume lui-même) — ce texte-là pollue lourdement un audit de voix. Détecte-le à sa signature
 * propre et exclus-le de la même façon, avec un pattern dédié plutôt qu'un préfixe.
 */
export interface DaemonTemplateSpec {
  prefixes?: string[];
  patterns?: RegExp[];
}

export function isDaemonTemplate(body: string, spec: DaemonTemplateSpec = {}): boolean {
  const t = body.trim();
  if (spec.prefixes?.some((p) => t.startsWith(p))) return true;
  if (spec.patterns?.some((re) => re.test(t))) return true;
  return false;
}

/**
 * Retire ce qui n'est pas de la prose : blocs de code, code inline, URLs. Sans ça, un message qui
 * contient un JSON ou trois liens fait chuter le taux par 1000 caractères et l'audit se ment à
 * lui-même. PUR.
 */
export function stripNonProse(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
}

/** Découpe en phrases (approximatif mais suffisant : ponctuation forte ou saut de ligne). PUR. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const clip = (s: string, n = 90): string => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** Un détecteur : un nom, et une fonction qui rend les extraits fautifs d'un texte déjà nettoyé. */
export interface Detector {
  name: string;
  /** Ce que le motif coûte à la lecture, en une ligne (affiché par le CLI). */
  why: string;
  run: (text: string) => string[];
}

/** Toutes les occurrences d'un motif, rendues comme extraits courts. */
function matches(text: string, re: RegExp, pad = 40): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    out.push(clip(text.slice(Math.max(0, i - pad), i + m[0].length + pad).replace(/\s+/g, " ")));
  }
  return out;
}

/** Un passage en gras façon chat (`*…*`), et s'il OUVRE sa ligne. La distinction n'est pas
 *  cosmétique : un gras en tête de ligne sert de titre de section dans un message long (structure
 *  légitime), un gras au milieu d'une phrase est de l'emphase — celui qu'on reproche d'habitude.
 *  Les compter ensemble mélange les deux. PUR. */
export function boldSpans(text: string): Array<{ excerpt: string; leadsLine: boolean }> {
  const out: Array<{ excerpt: string; leadsLine: boolean }> = [];
  for (const m of text.matchAll(/\*[^*\n]{2,80}\*/g)) {
    const i = m.index ?? 0;
    const before = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
    // « • », « - », « 1) » et l'espace comptent comme du décor de puce, pas comme du texte.
    out.push({ excerpt: m[0], leadsLine: /^[\s•\-–*]*(?:\d+[.)]\s*)?$/.test(before) });
  }
  return out;
}

export const DETECTORS: Detector[] = [
  {
    name: "tiret-cadratin",
    why: "personne ne tape « — » au pouce sur un téléphone : c'est de la typo d'essai dans une fenêtre de chat",
    run: (t) => matches(t, /—/g, 35),
  },
  {
    name: "gras-inline",
    why: "le gras à outrance : souligner un bout de phrase au milieu d'une phrase, c'est crier — quand tout est important, rien ne l'est",
    run: (t) => boldSpans(t).filter((b) => !b.leadsLine).map((b) => b.excerpt),
  },
  {
    name: "negation-parallele",
    why: "« ce n'est pas X, c'est Y » — le tic n°1 de la prose LLM (humanizer §9) ; dire Y suffit presque toujours",
    run: (t) => [
      ...matches(t, /\b(?:ce n'est|c'était|ce n'était|c'est) pas\b[^.!?\n]{2,70}[,—]\s*(?:c'est|c'était|mais)\b/gi, 10),
      ...matches(t, /\bpas\s+(?:un|une|le|la|du|des|de la)\b[^.!?\n]{2,60}\s+mais\s+(?:un|une|le|la|du|des)\b/gi, 10),
      ...matches(t, /[,—]\s*pas\s+(?:un|une|le|la|du|des|de la)\b[^.!?\n]{0,40}[.!?\n]/gi, 25),
    ],
  },
  {
    name: "annonce-de-plan",
    why: "annoncer la structure avant de la livrer (humanizer §28) : « Deux choses, dans l'ordre » ne dit rien que la suite ne dise",
    run: (t) =>
      matches(
        t,
        /\b(?:deux|trois|quatre|cinq)\s+(?:choses|points|trucs|axes|façons|manières|questions|raisons|remarques|niveaux|morceaux)\b/gi,
        25,
      ),
  },
  {
    name: "couverture",
    why: "empiler les précautions (humanizer §24) : une seule suffit, sinon l'info se dilue",
    run: (t) =>
      matches(
        t,
        /\b(?:probablement|sans doute|a priori|apparemment|vraisemblablement|possiblement|en principe|il semblerait|dans une certaine mesure)\b/gi,
        25,
      ),
  },
  {
    name: "cheville",
    why: "formules creuses (humanizer §23) : « à noter que », « au niveau de », « afin de » — à couper sans perte",
    run: (t) =>
      matches(
        t,
        // ⚠️ Deux pièges JS sur le français, tous deux muets. (1) `/i` ne replie PAS les accents
        // (`/à/i` ne matche pas « À ») → initiales accentuées énumérées à la main. (2) `\b` est
        // défini sur l'ASCII : il ne s'ouvre pas devant « À », donc un `\b(?:à noter que)` rate
        // TOUTES les occurrences en début de phrase sans rien signaler. D'où la frontière
        // Unicode explicite.
        /(?<![\p{L}\p{N}])(?:afin de|[àÀ] noter que|il est important de|il convient de|dans le but de|au niveau de|force est de constater|il est [àÀ] noter)(?![\p{L}\p{N}])/giu,
        25,
      ),
  },
  {
    name: "punchline",
    why: "la chute fabriquée (humanizer §31) : finir sur une formule courte et frappante à chaque message sonne écrit, pas parlé",
    run: (t) => {
      const ss = sentences(t);
      const last = ss[ss.length - 1];
      if (!last) return [];
      return /^(?:bref|verdict|résultat|conclusion|moralité|donc)\b/i.test(last) && last.length <= 60 ? [clip(last)] : [];
    },
  },
];

/** Détecteurs mesurés mais volontairement HORS du score (trop de faux positifs sur du français réel :
 *  une énumération honnête a la même forme qu'une figure de style). Gardés pour l'œil, pas pour la note. */
export const INDICATIVE_DETECTORS: Detector[] = [
  {
    name: "gras-titre",
    why: "indicatif seulement — un gras en tête de ligne structure un message long, ce n'est pas le « gras à outrance »",
    run: (t) => boldSpans(t).filter((b) => b.leadsLine).map((b) => b.excerpt),
  },
  {
    name: "regle-de-trois",
    why: "indicatif seulement — la cadence ternaire est aussi celle d'une liste légitime",
    run: (t) => matches(t, /(?:\b[\wÀ-ÿ'’]+(?:\s+[\wÀ-ÿ'’]+){0,2}),\s+(?:[\wÀ-ÿ'’]+(?:\s+[\wÀ-ÿ'’]+){0,2}),\s+(?:et|ou)\s+[\wÀ-ÿ'’]+/gi, 10),
  },
];

export interface TicSelection {
  /** Les noms retenus, dédoublonnés, dans l'ordre demandé. */
  tics: string[];
  /** Vrai si l'un d'eux est *indicatif* : ces détecteurs ne tournent qu'avec `--indicatif`, donc les
   *  demander l'impose — sinon la colonne afficherait 0,00 sans avoir jamais compté. */
  needsIndicatif: boolean;
  /** Nom inconnu → message d'erreur. Un tic mal orthographié DOIT crier : une colonne à zéro se lit
   *  comme une victoire, et c'est exactement le mensonge qu'un instrument ne doit pas produire. */
  error?: string;
}

/** Quels tics un rapport doit détailler. Sans ce choix, une expérience sur un troisième tic se
 *  mesurerait à l'aveugle : l'instrument continuerait d'afficher seulement les deux par défaut. PUR. */
export function resolveTics(names: string[], defaults: string[] = ["tiret-cadratin", "gras-inline"]): TicSelection {
  const known = [...DETECTORS, ...INDICATIVE_DETECTORS];
  const asked = names.length > 0 ? names : defaults;
  const tics = asked.filter((n, i) => asked.indexOf(n) === i);
  const unknown = tics.filter((n) => !known.some((d) => d.name === n));
  if (unknown.length > 0) {
    return {
      tics: [],
      needsIndicatif: false,
      error: `détecteur inconnu ${unknown.map((u) => `« ${u} »`).join(", ")}. Connus : ${known.map((d) => d.name).join(", ")}.`,
    };
  }
  return { tics, needsIndicatif: tics.some((n) => INDICATIVE_DETECTORS.some((d) => d.name === n)) };
}

/** Audite un message. `extra` permet d'ajouter des détecteurs (les indicatifs, en revue manuelle). PUR. */
export function auditMessage(body: string, extra: Detector[] = []): VoiceReport {
  const analyzed = stripNonProse(body);
  const hits: VoiceHit[] = [];
  const countsByDetector: Record<string, number> = {};
  for (const d of [...DETECTORS, ...extra]) {
    const found = d.run(analyzed);
    countsByDetector[d.name] = found.length;
    for (const excerpt of found) hits.push({ detector: d.name, excerpt });
  }
  const scored = hits.filter((h) => DETECTORS.some((d) => d.name === h.detector)).length;
  const per1000 = analyzed.length === 0 ? 0 : (scored * 1000) / analyzed.length;
  return { analyzed, hits, per1000, countsByDetector };
}

export interface CorpusMessage {
  id?: string;
  timestamp?: number;
  body: string;
}

export interface CorpusReport {
  /** Messages réellement audités (gabarits du daemon exclus). */
  kept: number;
  skippedTemplates: number;
  totalChars: number;
  countsByDetector: Record<string, number>;
  per1000ByDetector: Record<string, number>;
  /** Tics **par message** — l'unité dans laquelle une cible du type « ≤ 1 tiret par message » se
   *  vérifie. Le taux par 1000 caractères ne dit PAS la même chose : si tes messages rallongent, le
   *  taux par caractère peut rester stable pendant que le taux par message grimpe. Affiche les deux. */
  perMessageByDetector: Record<string, number>;
  /** Les messages les plus chargés, pour vérifier à la main plutôt que croire un chiffre seul. */
  worst: Array<{ id?: string; timestamp?: number; per1000: number; chars: number; hits: VoiceHit[] }>;
}

/** Bornes d'une fenêtre temporelle (ms epoch), pour **figer** un corpus. */
export interface WindowSpec {
  since?: number;
  until?: number;
}

/** Restreint le corpus à une fenêtre temporelle. PUR.
 *
 *  Pourquoi ça existe. Une fenêtre définie comme « les N derniers messages » se termine toujours
 *  *maintenant* : une ligne de base prise à un instant T n'est donc **pas re-mesurable** avec la
 *  même commande le lendemain — le corpus a glissé, et deux exécutions ne comparent plus la même
 *  chose (piège vécu : une commande rejouée telle quelle affichait « stable » alors que la fenêtre
 *  glissante était encore composée à 77 % de l'ancien corpus). Avec `since` on mesure ce qui a été
 *  écrit *depuis* une ligne de base ; avec `until` on rejoue cette ligne de base à l'identique. */
export function selectWindow(messages: CorpusMessage[], spec: WindowSpec): CorpusMessage[] {
  return messages.filter((m) => {
    if (m.timestamp === undefined) return spec.since === undefined && spec.until === undefined;
    if (spec.since !== undefined && m.timestamp <= spec.since) return false;
    if (spec.until !== undefined && m.timestamp > spec.until) return false;
    return true;
  });
}

/** true si la limite de récupération a pu couper la fenêtre demandée avant son début. PUR.
 *
 *  `hitLimit` = la récupération a rendu autant de messages qu'on en demandait (donc il en reste
 *  peut-être plus vieux, non récupérés). Sans ce contrôle, un `since` trop ancien mesurerait un
 *  bout de fenêtre en le présentant comme la fenêtre entière — une troncature silencieuse qui se
 *  lit « j'ai tout couvert ». Mieux vaut un avertissement bruyant qu'un chiffre faux et propre. */
export function windowTruncated(fetched: CorpusMessage[], spec: WindowSpec, hitLimit: boolean): boolean {
  if (spec.since === undefined || !hitLimit) return false;
  const stamps = fetched.map((m) => m.timestamp).filter((t): t is number => typeof t === "number");
  if (stamps.length === 0) return false;
  return Math.min(...stamps) > spec.since;
}

/** Agrège l'audit sur un corpus. Le taux par 1000 caractères est calculé sur le TOTAL du corpus, pas
 *  comme moyenne des taux par message : sinon un message de 2 caractères pèse autant qu'un message
 *  de 2000 (erreur stock/flux classique). PUR. */
export function auditCorpus(messages: CorpusMessage[], extra: Detector[] = [], templateSpec: DaemonTemplateSpec = {}): CorpusReport {
  const counts: Record<string, number> = {};
  const worst: CorpusReport["worst"] = [];
  let totalChars = 0;
  let kept = 0;
  let skippedTemplates = 0;
  for (const m of messages) {
    if (isDaemonTemplate(m.body, templateSpec)) {
      skippedTemplates++;
      continue;
    }
    const r = auditMessage(m.body, extra);
    if (r.analyzed.length === 0) continue;
    kept++;
    totalChars += r.analyzed.length;
    for (const [k, v] of Object.entries(r.countsByDetector)) counts[k] = (counts[k] ?? 0) + v;
    if (r.hits.length > 0) {
      worst.push({ id: m.id, timestamp: m.timestamp, per1000: r.per1000, chars: r.analyzed.length, hits: r.hits });
    }
  }
  worst.sort((a, b) => b.per1000 - a.per1000);
  const per1000ByDetector: Record<string, number> = {};
  const perMessageByDetector: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    per1000ByDetector[k] = totalChars === 0 ? 0 : (v * 1000) / totalChars;
    perMessageByDetector[k] = kept === 0 ? 0 : v / kept;
  }
  return { kept, skippedTemplates, totalChars, countsByDetector: counts, per1000ByDetector, perMessageByDetector, worst };
}
