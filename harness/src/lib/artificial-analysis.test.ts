import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModel,
  blendedPrice,
  valueRatio,
  isNotable,
  sortByIntelligence,
  sortByValue,
  releasedWithin,
  diffAaModels,
  FRONTIER_IDX_MIN,
  VALUE_RATIO_MIN,
  type AaModel,
} from "./artificial-analysis.ts";

/** Un modèle de base (DeepSeek V4 Flash 0731, exemple type « super ratio qualité/prix »). */
const BASE: AaModel = {
  id: "id1",
  name: "DeepSeek V4 Flash 0731 (Reasoning, Max Effort)",
  slug: "deepseek-v4-flash",
  releaseDate: "2026-07-31",
  creator: "DeepSeek",
  intelligenceIndex: 51.8,
  codingIndex: 69.1,
  agenticIndex: null,
  priceIn: 0.14,
  priceOut: 0.28,
  speedTokensPerSec: 100,
  timeToFirstTokenSec: 1,
  endToEndSec: 5,
};

function model(over: Partial<AaModel>): AaModel {
  return { ...BASE, ...over };
}

test("normalizeModel : mappe la forme serveur (camel) vers nos noms courts", () => {
  const m = normalizeModel({
    id: "x",
    name: "GLM-4.5V",
    slug: "glm-4-5v",
    release_date: "2025-08-11",
    model_creator: { id: "c", name: "Z AI" },
    evaluations: {
      artificial_analysis_intelligence_index: 6.8,
      artificial_analysis_coding_index: null,
      artificial_analysis_agentic_index: null,
    },
    pricing: { price_1m_input_tokens: 0.6, price_1m_output_tokens: 1.8 },
    performance: {
      median_output_tokens_per_second: 104.27,
      median_time_to_first_token_seconds: 1.85,
      median_end_to_end_response_time_seconds: 6.64,
    },
  });
  assert.equal(m.slug, "glm-4-5v");
  assert.equal(m.creator, "Z AI");
  assert.equal(m.intelligenceIndex, 6.8);
  assert.equal(m.priceIn, 0.6);
  assert.equal(m.speedTokensPerSec, 104.27);
});

test("blendedPrice : moyenne in/out", () => {
  assert.ok(Math.abs((blendedPrice(model({ priceIn: 0.14, priceOut: 0.28 })) ?? 0) - 0.21) < 1e-9);
  assert.equal(blendedPrice(model({ priceIn: null, priceOut: 0.28 })), null);
});

test("valueRatio : idx / prix mélangé (deepseek flash ≈ 51.8/0.21 ≈ 246)", () => {
  const vr = valueRatio(BASE);
  assert.ok(vr !== null);
  assert.ok(Math.abs(vr - 51.8 / 0.21) < 0.01);
  assert.equal(valueRatio(model({ intelligenceIndex: null })), null);
  assert.equal(valueRatio(model({ priceIn: null })), null);
  assert.equal(valueRatio(model({ priceIn: 0, priceOut: 0 })), null);
});

test("isNotable : frontier (idx ≥ 40) OU (capable ET bon ratio) → notable", () => {
  assert.equal(isNotable(model({ intelligenceIndex: FRONTIER_IDX_MIN })), true);
  // idx 30, prix haut → ni frontier ni bon ratio → pas notable
  assert.equal(isNotable(model({ intelligenceIndex: 30, priceIn: 10, priceOut: 10 })), false);
  // idx capable + presque gratuit (type Ling 3.0 Flash : 37.8 / 0.145 ≈ 260) → notable
  assert.equal(isNotable(model({ intelligenceIndex: 30, priceIn: 0.07, priceOut: 0.22 })), true);
  // idx < 25 même super bon marché (type Qwen3.5 4B : idx 20.4, ratio 227) → PAS notable (trop faible)
  assert.equal(isNotable(model({ intelligenceIndex: 20, priceIn: 0.05, priceOut: 0.1 })), false);
});

test("sortByIntelligence : descendant, null en fin", () => {
  const list = [
    model({ slug: "b", intelligenceIndex: 40 }),
    model({ slug: "a", intelligenceIndex: 60 }),
    model({ slug: "c", intelligenceIndex: null }),
  ];
  assert.deepEqual(sortByIntelligence(list).map((m) => m.slug), ["a", "b", "c"]);
});

test("sortByValue : descendant par ratio, null en fin", () => {
  const list = [
    model({ slug: "cheap", intelligenceIndex: 30, priceIn: 0.07, priceOut: 0.22 }), // ratio ~206
    model({ slug: "pricey", intelligenceIndex: 60, priceIn: 5, priceOut: 25 }), // ratio ~4
    model({ slug: "noprice", intelligenceIndex: 50, priceIn: null }),
  ];
  assert.deepEqual(sortByValue(list).map((m) => m.slug), ["cheap", "pricey", "noprice"]);
});

test("releasedWithin : filtre sur la fenêtre, exclus null/invalide", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  const list = [
    model({ slug: "old", releaseDate: "2026-05-01" }),
    model({ slug: "recent", releaseDate: "2026-08-01" }),
    model({ slug: "nodate", releaseDate: null }),
    model({ slug: "future", releaseDate: "2026-09-01" }),
  ];
  const got = releasedWithin(list, now, 45);
  assert.deepEqual(got.map((m) => m.slug), ["recent"]);
});

test("diffAaModels : notable + récent + non vu → signalé ; vu ou ancien ou banal → silencieux", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  const list = [
    model({ slug: "new-notable", intelligenceIndex: 45, releaseDate: "2026-08-05" }), // ✓
    model({ slug: "seen", intelligenceIndex: 45, releaseDate: "2026-08-05" }), // dans seen
    model({ slug: "old-notable", intelligenceIndex: 45, releaseDate: "2026-03-01" }), // hors fenêtre
    model({ slug: "recent-banal", intelligenceIndex: 15, priceIn: 5, priceOut: 5, releaseDate: "2026-08-05" }), // pas notable
    model({ slug: "deepseek", intelligenceIndex: 51.8, priceIn: 0.14, priceOut: 0.28, releaseDate: "2026-07-31" }), // ✓ ratio
  ];
  const fresh = diffAaModels(list, { seen: "2026-08-10T12:00:00Z" }, now);
  assert.deepEqual(
    fresh.map((m) => m.slug).sort(),
    ["deepseek", "new-notable"],
  );
});
