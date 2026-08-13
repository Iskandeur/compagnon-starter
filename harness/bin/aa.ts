#!/usr/bin/env node
/**
 * `aa` — Artificial Analysis en CLI de consultation à la demande.
 * Complète ../src/lib/artificial-analysis.ts (déjà dans le starter) avec une interface simple.
 *
 *   aa.ts top [--n 15]    # top N par indice d'intelligence
 *   aa.ts value [--n 15]  # top N par ratio qualité/prix (le « deepseek flash »)
 *   aa.ts recent [--days 45] [--notable-only]   # sorties récentes
 *   aa.ts search <texte>  # recherche par nom / créateur
 *
 * ⚠️ Quota free tier = 100 req/jour. Chaque invocation fetch les 3 pages = 3 requêtes.
 * Clé lue dans `ARTIFICIAL_ANALYSIS_API_KEY` (process.env).
 */
import { parseArgs } from "node:util";
import {
  fetchAllLanguageModels,
  sortByIntelligence,
  sortByValue,
  releasedWithin,
  isNotable,
  blendedPrice,
  valueRatio,
  type AaModel,
} from "../src/lib/artificial-analysis.ts";

const { values, positionals } = parseArgs({
  options: {
    n: { type: "string", default: "15" },
    days: { type: "string" },
    "notable-only": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const cmd = positionals[0] as string | undefined;
const n = Math.max(1, Math.min(50, Number.parseInt(values.n ?? "15", 10) || 15));

async function main(): Promise<void> {
  if (cmd === "top") return table(sortByIntelligence((await load()).models).slice(0, n), "Top par indice d'intelligence");
  if (cmd === "value") return table(sortByValue((await load()).models).slice(0, n), "Top par ratio qualité/prix");
  if (cmd === "recent") return recent();
  if (cmd === "search") return search(positionals[1]);
  console.error("commandes: top [--n N] | value [--n N] | recent [--days N] [--notable-only] | search <texte>");
  process.exit(1);
}

async function load() {
  return fetchAllLanguageModels();
}

function fmtPrice(m: AaModel): string {
  const p = blendedPrice(m);
  return p != null ? `$${p.toFixed(2)}/M` : "—";
}

function table(models: AaModel[], title: string): void {
  console.log(`=== ${title} ===`);
  for (const m of models) {
    const idx = m.intelligenceIndex != null ? m.intelligenceIndex : "?";
    const vr = valueRatio(m);
    console.log(`  ${m.name} (${m.creator ?? "?"}) | idx ${idx} | ${fmtPrice(m)}${vr != null ? ` | ratio ${vr.toFixed(1)}` : ""} | ${m.releaseDate ?? "—"} | ${m.slug}`);
  }
}

async function recent(): Promise<void> {
  const days = Number.parseInt(values.days ?? "45", 10) || 45;
  const { models } = await load();
  let list = releasedWithin(models, Date.now(), days).sort(
    (a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""),
  );
  if (values["notable-only"]) list = list.filter(isNotable);
  table(list, `Sorties récentes (${days} j)${values["notable-only"] ? " — notables seulement" : ""}`);
}

async function search(term: string | undefined): Promise<void> {
  if (!term) {
    console.error("search : fournir un texte (ex. `aa.ts search deepseek`)");
    process.exit(1);
  }
  const { models } = await load();
  const q = term.toLowerCase();
  const hits = models.filter(
    (m) => m.name.toLowerCase().includes(q) || (m.creator ?? "").toLowerCase().includes(q) || m.slug.toLowerCase().includes(q),
  );
  table(hits.slice(0, n), `Recherche « ${term} »`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
