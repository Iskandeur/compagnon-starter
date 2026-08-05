import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Fichiers STATIQUES du dépôt (monté en lecture seule) qui composent le contexte par défaut
 * injecté à chaque réveil du harnais :
 *  - `CLAUDE.md` et `.claude/settings.json` : auto-chargés par le CLI Claude Code lui-même (le
 *    process tourne avec le dépôt comme répertoire de travail) — pas lus par du code harnais.
 *
 * Étends `FILES` ci-dessous avec tes propres fichiers injectés explicitement par TON harnais (un
 * prompt de personnalité passé via `--append-system-prompt-file`, un prompt de rituel nocturne…).
 * Relis-en le contenu à la main avant de l'ajouter (pas de secret/token dedans) — comme pour
 * n'importe quel fichier exposé derrière ce dashboard.
 */
const MAX_BYTES = 100_000;

const FILES = [
  {
    path: "CLAUDE.md",
    label: "CLAUDE.md (racine)",
    note: "Auto-chargé par le CLI Claude Code au démarrage du process (cwd = dépôt).",
  },
  {
    path: ".claude/settings.json",
    label: ".claude/settings.json",
    note: "Permissions (allow/deny) et hooks — auto-chargé par le CLI Claude Code, même mécanisme que CLAUDE.md.",
  },
];

export function listContextFiles() {
  return FILES.map(({ path, label, note }) => {
    const filePath = join(config.repoPath, path);
    if (!existsSync(filePath)) {
      return { path, label, note, present: false, size: 0, content: null, truncated: false };
    }
    const size = statSync(filePath).size;
    const truncated = size > MAX_BYTES;
    const content = truncated ? null : readFileSync(filePath, "utf8");
    return { path, label, note, present: true, size, content, truncated };
  });
}
