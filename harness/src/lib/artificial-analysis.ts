/**
 * artificial-analysis — client de l'API Artificial Analysis (artificialanalysis.ai).
 *
 * POURQUOI : artificialanalysis.ai expose gratuitement (clé free tier `aa_…`) des benchmarks
 * indépendants des modèles LLM du marché — utile comme veille pour repérer un modèle qui offre un
 * excellent ratio qualité/prix (le pattern « DeepSeek Flash » : indice élevé, prix très bas).
 *
 * API : GET https://artificialanalysis.ai/api/v2/language/models/free → 200 modèles/page, ~3 pages.
 * Authentification : header `x-api-key: <aa_…>`. **Quota free tier = 100 requêtes/JOUR** (lu sur les
 * headers `X-RateLimit-*`) — c'est LA contrainte : une veille quotidienne (~3 req/scan) tient large,
 * jamais un canal rapproché (quelques minutes). Clé lue dans `ARTIFICIAL_ANALYSIS_API_KEY` (.env).
 *
 * Le free tier expose : les indices composites (intelligence/coding/agentic), les prix in/out
 * (input/output par 1M tokens), les perfs médianes (tokens/s, TTF, E2E). Pas : context window,
 * tokens, percentiles, providers (réservés Pro).
 */
export const AA_BASE_URL = "https://artificialanalysis.ai/api/v2";
export const AA_API_KEY_ENV = "ARTIFICIAL_ANALYSIS_API_KEY";

/** Une entrée de la réponse free tier (normalisée — champs serveur → noms courts). */
export interface AaModel {
  id: string;
  name: string;
  slug: string;
  releaseDate: string | null; // ISO "2026-07-31" | null
  creator: string | null; // ex. "DeepSeek", "Anthropic"
  intelligenceIndex: number | null; // AA Intelligence Index composite (v4.x)
  codingIndex: number | null;
  agenticIndex: number | null;
  priceIn: number | null; // $/1M tokens input
  priceOut: number | null; // $/1M tokens output
  speedTokensPerSec: number | null; // median output tokens/s
  timeToFirstTokenSec: number | null; // median
  endToEndSec: number | null; // median
}

export interface AaPagination {
  page: number;
  page_size: number;
  total_pages: number;
  has_more: boolean;
}

export interface AaModelsResponse {
  tier: string;
  intelligence_index_version: number;
  pagination: AaPagination;
  data: AaModel[];
}

interface RawFreeModel {
  id: string;
  name: string;
  slug: string;
  release_date: string | null;
  model_creator: { id: string; name: string } | null;
  evaluations: {
    artificial_analysis_intelligence_index: number | null;
    artificial_analysis_coding_index: number | null;
    artificial_analysis_agentic_index: number | null;
  };
  pricing: {
    price_1m_input_tokens: number | null;
    price_1m_output_tokens: number | null;
  };
  performance: {
    median_output_tokens_per_second: number | null;
    median_time_to_first_token_seconds: number | null;
    median_end_to_end_response_time_seconds: number | null;
  };
}

/** Pur, testable — transforme un item serveur en notre forme normalisée. */
export function normalizeModel(raw: RawFreeModel): AaModel {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    releaseDate: raw.release_date,
    creator: raw.model_creator?.name ?? null,
    intelligenceIndex: raw.evaluations?.artificial_analysis_intelligence_index ?? null,
    codingIndex: raw.evaluations?.artificial_analysis_coding_index ?? null,
    agenticIndex: raw.evaluations?.artificial_analysis_agentic_index ?? null,
    priceIn: raw.pricing?.price_1m_input_tokens ?? null,
    priceOut: raw.pricing?.price_1m_output_tokens ?? null,
    speedTokensPerSec: raw.performance?.median_output_tokens_per_second ?? null,
    timeToFirstTokenSec: raw.performance?.median_time_to_first_token_seconds ?? null,
    endToEndSec: raw.performance?.median_end_to_end_response_time_seconds ?? null,
  };
}

/** Normalise le contenu `data` d'une page (le serveur renvoie déjà notre shape pour le free tier). */
export function normalizePage(rawData: Array<Record<string, unknown>>): AaModel[] {
  return rawData.map((d) => normalizeModel(d as unknown as RawFreeModel));
}

function apiKey(): string {
  const k = (process.env[AA_API_KEY_ENV] ?? "").trim();
  if (!k) throw new Error(`${AA_API_KEY_ENV} absente du .env — voir harness/config/.env.example`);
  return k;
}

/**
 * Fetch TOUTES les pages de /language/models/free (le free tier = 3 pages × 200). ~3 requêtes.
 * Retourne aussi les headers quota pour un CLI de consultation (limit/remaining/reset).
 */
export async function fetchAllLanguageModels(
  timeoutMs = 20000,
): Promise<{ models: AaModel[]; quota: { limit: number; remaining: number; resetAtEpochSec: number } }> {
  const key = apiKey();
  const models: AaModel[] = [];
  let page = 1;
  let quota = { limit: 0, remaining: 0, resetAtEpochSec: 0 };
  for (;;) {
    const r = await fetch(`${AA_BASE_URL}/language/models/free?page=${page}`, {
      headers: { "x-api-key": key, "user-agent": "compagnon-veille/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} (page ${page})`);
    const limit = Number(r.headers.get("x-ratelimit-limit") ?? 0);
    const remaining = Number(r.headers.get("x-ratelimit-remaining") ?? 0);
    const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0);
    if (limit) quota = { limit, remaining, resetAtEpochSec: reset };
    const body = (await r.json()) as { pagination: AaPagination; data: Array<Record<string, unknown>> };
    models.push(...normalizePage(body.data));
    if (!body.pagination.has_more) break;
    page += 1;
  }
  return { models, quota };
}

// ─── Pure : ce qui fait la valeur pour la veille ─────────────────────────────────────────────────
/** Prix « mélangé » in/out en $/1M (la mesure la plus juste du coût réel d'usage). Null si inconnu. */
export function blendedPrice(m: AaModel): number | null {
  if (m.priceIn == null || m.priceOut == null) return null;
  return (m.priceIn + m.priceOut) / 2;
}

/**
 * Ratio qualité/prix : intelligenceIndex / prix mélangé. Le signal « deepseek flash » — un modèle
 * avec un ratio très haut a des capacités proches du sommet pour une fraction du prix. Null si un
 * ingrédient manque.
 */
export function valueRatio(m: AaModel): number | null {
  if (m.intelligenceIndex == null) return null;
  const p = blendedPrice(m);
  if (!p || p <= 0) return null;
  return m.intelligenceIndex / p;
}

/**
 * Un modèle est-il « intéressant » ? Deux portes d'entrée (OR) :
 *  - FRONTIER : intelligenceIndex ≥ 40 (≈ p90 de la base, le peloton de tête) ;
 *  - VALEUR : intelligenceIndex ≥ 25 (le plancher de « capable » — exclut les petits modèles qui
 *    ne servent à rien en usage sérieux) ET ratio qualité/prix ≥ 40 (capable ET pas cher).
 * Seuils exportés pour ajuster sans changer le contrat — à recalibrer sur ta propre base au besoin.
 */
export const FRONTIER_IDX_MIN = 40;
export const VALUE_IDX_MIN = 25;
export const VALUE_RATIO_MIN = 40;

export function isNotable(m: AaModel): boolean {
  if ((m.intelligenceIndex ?? 0) >= FRONTIER_IDX_MIN) return true;
  if ((m.intelligenceIndex ?? 0) < VALUE_IDX_MIN) return false;
  const vr = valueRatio(m);
  return vr != null && vr >= VALUE_RATIO_MIN;
}

/** Tri descendant par indice d'intelligence (les null finissent en bas). */
export function sortByIntelligence(models: AaModel[]): AaModel[] {
  return [...models].sort(
    (a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1),
  );
}

/** Tri descendant par ratio qualité/prix. */
export function sortByValue(models: AaModel[]): AaModel[] {
  return [...models].sort((a, b) => (valueRatio(b) ?? -1) - (valueRatio(a) ?? -1));
}

/** Modèles sortis dans la fenêtre [now - windowDays, now] (null releaseDate → exclus). */
export function releasedWithin(models: AaModel[], nowMs: number, windowDays: number): AaModel[] {
  const cutoff = nowMs - windowDays * 24 * 3600 * 1000;
  return models.filter((m) => {
    if (!m.releaseDate) return false;
    const t = Date.parse(m.releaseDate);
    return Number.isFinite(t) && t >= cutoff && t <= nowMs;
  });
}

/**
 * Les modèles NOTABLES et RÉCENTS pas encore vus — le cœur d'un sensor de veille.
 *  - `seen` : clé = slug, valeur = date ISO (registre « déjà signalé »).
 *  - Ne garde que ce qui est notable ET sorti dans la fenêtre : un modèle frontière sorti il y a
 *    8 mois mais ajouté hier à la base ne compte PAS (pas une nouvelle, juste un backfill).
 *  - Une exception assumée : la fenêtre est généreuse (45 j) — un modèle intéressant sorti un peu
 *    avant l'installation du sensor est quand même signalé une fois, plutôt que jamais.
 */
export const NEW_RELEASE_WINDOW_DAYS = 45;

export function diffAaModels(
  models: AaModel[],
  seen: Record<string, string>,
  nowMs: number,
): AaModel[] {
  return releasedWithin(models, nowMs, NEW_RELEASE_WINDOW_DAYS).filter(
    (m) => !seen[m.slug] && isNotable(m),
  );
}
