/**
 * groq-extract — extraction de faits durables (personnes) depuis un texte, via un LLM Groq rapide
 * et gratuit (free tier, sans carte bancaire — voir console.groq.com/docs).
 *
 * POURQUOI : repérer EN DIRECT, dans les messages qui passent, des faits durables sur des personnes
 * (qui, quoi) pour alimenter une mémoire (people-memory-mcp ou équivalent) — sans que ton agent
 * doive tout relire manuellement à froid. Deux règles à respecter si tu adaptes ce module :
 *  - FALLBACK : si Groq est KO ou rate-limité, ne JAMAIS bloquer le traitement du message en cours —
 *    on renvoie juste aucune extraction pour ce tour (`extractDurableFacts` n'échoue donc jamais).
 *  - AUDIT : ceci ne fait QUE proposer des candidats. Ça n'écrit RIEN dans ta base mémoire toute
 *    seule — la doctrine « jamais écraser un fait existant sans confirmation » reste appliquée en
 *    aval, par qui consomme ces candidats. Extraction = suggestion, pas écriture aveugle.
 *
 * API Groq = endpoint chat/completions compatible OpenAI. Clé : `GROQ_API_KEY` (la même clé sert
 * aussi à la transcription vocale Whisper, si tu utilises ce pattern-là ailleurs — deux usages,
 * une seule clé).
 */
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_EXTRACT_MODEL = "llama-3.3-70b-versatile";

export interface FactCandidate {
  /** Nom de la personne tel que mentionné dans le texte (peut être un prénom seul). */
  subject: string;
  /** Le fait durable lui-même, formulé en une phrase autonome et datable. */
  fact: string;
  /** Confiance du modèle — "low" = à vérifier avant d'écrire quoi que ce soit. */
  confidence: "low" | "medium" | "high";
}

const SYSTEM_PROMPT = `Tu extrais des FAITS DURABLES sur des PERSONNES nommées, depuis un message.
Un fait durable = un rôle, une relation, une décision, un événement daté, une affiliation — quelque
chose qui reste vrai/pertinent dans plusieurs mois. PAS : de la small talk, une émotion passagère,
une question, un fait déjà évident ou trivial, une information sur l'expéditeur du message lui-même
sauf s'il s'agit d'un fait sur SA relation avec une autre personne nommée.
Si le texte ne contient AUCUN fait durable sur une personne nommée, renvoie une liste vide.
Réponds UNIQUEMENT en JSON, forme : {"facts": [{"subject": "Nom", "fact": "...", "confidence": "low"|"medium"|"high"}]}`;

/** Pur, testable — construit le payload envoyé à l'API (séparé du fetch pour pouvoir le vérifier). */
export function buildExtractionMessages(text: string): Array<{ role: string; content: string }> {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
}

/** Pur, testable — parse la réponse JSON du modèle. Tolérant : JSON invalide/inattendu → []. */
export function parseExtractionResponse(raw: string): FactCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const facts = (parsed as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];
  const validConfidence = new Set(["low", "medium", "high"]);
  return facts
    .filter((f): f is Record<string, unknown> => f !== null && typeof f === "object")
    .map((f) => ({
      subject: typeof f.subject === "string" ? f.subject.trim() : "",
      fact: typeof f.fact === "string" ? f.fact.trim() : "",
      confidence: validConfidence.has(f.confidence as string) ? (f.confidence as FactCandidate["confidence"]) : "low",
    }))
    .filter((f) => f.subject.length > 0 && f.fact.length > 0);
}

/**
 * Appelle Groq pour extraire des candidats depuis `text`. NE JETTE JAMAIS : toute erreur (clé
 * absente, rate-limit, timeout, réponse malformée) renvoie `[]` — c'est le contrat FALLBACK : ne
 * jamais bloquer un tour de message pour ça.
 */
export async function extractDurableFacts(
  text: string,
  apiKey: string | undefined,
  opts: { model?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<FactCandidate[]> {
  if (!apiKey || !text.trim()) return [];
  const doFetch = opts.fetchFn ?? fetch;
  try {
    const res = await doFetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? GROQ_EXTRACT_MODEL,
        messages: buildExtractionMessages(text),
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return [];
    return parseExtractionResponse(content);
  } catch {
    return [];
  }
}
