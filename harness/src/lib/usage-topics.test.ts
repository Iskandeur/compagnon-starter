import { test } from "node:test";
import assert from "node:assert/strict";
import { categorizeSummary, computeTopicBreakdown, EXAMPLE_TOPIC_RULES } from "./usage-topics.ts";

test("categorizeSummary : reconnaît les catégories d'exemple", () => {
  assert.equal(categorizeSummary("[VEILLE] scan quotidien des flux").key, "veille");
  assert.equal(categorizeSummary("Redémarrage du service après déploiement").key, "infra");
  assert.equal(categorizeSummary("job #42 : ajoute un endpoint REST").key, "dev");
  assert.equal(categorizeSummary("Ajoute un rendez-vous au calendrier vendredi").key, "agenda");
  assert.equal(categorizeSummary("Anniversaire de ma fille ce week-end").key, "perso");
});

test("categorizeSummary : résumé absent/vide → sans_resume ; texte non reconnu → conversation", () => {
  assert.equal(categorizeSummary(null).key, "sans_resume");
  assert.equal(categorizeSummary(undefined).key, "sans_resume");
  assert.equal(categorizeSummary("   ").key, "sans_resume");
  assert.equal(categorizeSummary("Tu es là ?").key, "conversation");
});

test("computeTopicBreakdown : compte, pourcentage, tri décroissant", () => {
  const summaries = [
    "[VEILLE] scan 1",
    "[VEILLE] scan 2",
    "job #1 : corrige un bug",
    "Salut, ça va ?",
  ];
  const breakdown = computeTopicBreakdown(summaries);
  assert.equal(breakdown[0].key, "veille");
  assert.equal(breakdown[0].count, 2);
  assert.equal(breakdown[0].pct, 50);
  const total = breakdown.reduce((s, b) => s + b.count, 0);
  assert.equal(total, summaries.length);
  const pctTotal = breakdown.reduce((s, b) => s + b.pct, 0);
  assert.ok(Math.abs(pctTotal - 100) < 1e-9);
});

test("computeTopicBreakdown : liste vide → tableau vide, pas de division par zéro", () => {
  assert.deepEqual(computeTopicBreakdown([]), []);
});

test("EXAMPLE_TOPIC_RULES : chaque règle a une clé et un libellé uniques", () => {
  const keys = EXAMPLE_TOPIC_RULES.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});
