#!/usr/bin/env node
/**
 * `usage-topics` — répartition de l'usage d'un compagnon par SUJET (pas par canal), à partir des
 * résumés de `session_log`. Catégorisation par mots-clés dans `../src/lib/usage-topics.ts` — les
 * règles fournies (`EXAMPLE_TOPIC_RULES`) sont un point de départ à réécrire contre TES propres
 * résumés, pas une taxonomie universelle. `--json` pour la sortie machine (ex. un dashboard).
 *
 *   usage-topics.ts          # tableau lisible
 *   usage-topics.ts --json   # {total, breakdown:[{key,label,count,pct}]}, trié par count desc
 */
import { computeTopicBreakdown } from "../src/lib/usage-topics.ts";
import { resolveDbPath } from "../src/lib/db-path.ts";

async function main(): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
  const rows = db.prepare("SELECT summary FROM session_log").all() as Array<{ summary: string | null }>;
  db.close();

  const total = rows.length;
  const breakdown = computeTopicBreakdown(rows.map((r) => r.summary));

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total, breakdown }, null, 2));
    return;
  }

  console.log(`usage par sujet — ${total} sessions (session_log)\n`);
  const maxLabel = Math.max(...breakdown.map((b) => b.label.length));
  for (const b of breakdown) {
    const bar = "█".repeat(Math.max(1, Math.round(b.pct / 2)));
    console.log(`${b.label.padEnd(maxLabel)}  ${String(b.count).padStart(3)}  ${b.pct.toFixed(1).padStart(5)}%  ${bar}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
