#!/usr/bin/env node
/**
 * `schedule-wake` — le CLI que l'agent lance LUI-MÊME pour se programmer un réveil futur avec une
 * intention. Le scheduler du daemon (src/scheduler.ts) vérifie périodiquement les réveils dus et
 * relance une session avec cette intention comme contexte. Voir docs/self-scheduling.md.
 *
 *   schedule-wake --in "2h" --intent "Relancer la vérification X."       # une fois, dans 2h
 *   schedule-wake --at "2026-11-02T09:00:00+01:00" --intent "Jour J."    # une fois, échéance absolue
 *   schedule-wake --every "1d" --in "3h" --intent "Check-in quotidien"   # récurrent (1er dans 3h)
 *   schedule-wake --every "30m" --intent "Surveiller X"                  # récurrent (1er dans 30m)
 *   schedule-wake --list                                                 # réveils actifs
 *   schedule-wake --cancel 7                                             # annuler le réveil #7
 *   schedule-wake --every "24h" --intent "@/tmp/intent.txt"              # intent long/multi-lignes
 *
 * Sobriété : le scheduler applique un budget quotidien (MAX_WAKES_PER_DAY, voir src/scheduler.ts) —
 * chaque réveil relance une session, donc coûte des ressources. Ne programme pas de réveil pour rien.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openWakeStore } from "../src/scheduler.ts";
import { computeDueAt, parseDuration } from "../src/lib/wake-time.ts";
import { resolveDbPath } from "../src/lib/db-path.ts";

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    at: { type: "string" },
    every: { type: "string" },
    intent: { type: "string" },
    list: { type: "boolean", default: false },
    cancel: { type: "string" },
  },
});

// Chemin ABSOLU, résolu contre la racine du harness et non le cwd (voir src/lib/db-path.ts) : ce
// CLI peut être lancé depuis n'importe où, il doit toujours toucher la même base que le daemon.
const store = openWakeStore(resolveDbPath());

try {
  if (values.list) {
    const wakes = store.listPending();
    if (wakes.length === 0) {
      console.log("Aucun réveil programmé.");
    } else {
      for (const w of wakes) {
        const rec = w.recurrence_ms ? ` (tous les ${Math.round(w.recurrence_ms / 60000)} min)` : "";
        console.log(`#${w.id} → ${new Date(w.due_at).toISOString()}${rec} : ${w.intent.slice(0, 70)}`);
      }
    }
    store.close();
    process.exit(0);
  }

  if (values.cancel) {
    const id = Number.parseInt(values.cancel, 10);
    console.log(store.cancelWake(id) ? `✓ Réveil #${id} annulé.` : `Aucun réveil #${id} actif à annuler.`);
    store.close();
    process.exit(0);
  }

  if (!values.intent) {
    console.error("Erreur : --intent <texte> est requis (sauf avec --list / --cancel).");
    store.close();
    process.exit(1);
  }

  // Convention @fichier : un intent long ou multi-lignes part dans un fichier plutôt que dans le
  // quoting shell — plus robuste que de compter sur l'échappement de caractères spéciaux.
  if (values.intent.startsWith("@")) {
    values.intent = readFileSync(values.intent.slice(1), "utf8").trim();
  }

  const recurrenceMs = values.every ? parseDuration(values.every) : null;
  // Première échéance : --in/--at si fournis, sinon (récurrent) maintenant + la période.
  const dueAt =
    values.in || values.at
      ? computeDueAt({ in: values.in, at: values.at })
      : recurrenceMs
        ? Date.now() + recurrenceMs
        : computeDueAt({}); // lèvera l'erreur d'usage habituelle

  const id = store.addWake(dueAt, values.intent, recurrenceMs);
  const rec = recurrenceMs ? ` puis tous les ${values.every}` : "";
  console.log(`✓ Réveil #${id} programmé pour ${new Date(dueAt).toISOString()}${rec} : ${values.intent}`);
  store.close();
} catch (e) {
  console.error("Erreur :", (e as Error).message);
  store.close();
  process.exit(1);
}
