import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Fichiers STATIQUES du dépôt (monté en lecture seule) qui composent le contexte par défaut
 * injecté à chaque réveil normal du harnais — cf. `harness/src/engine.ts` (buildArgs) et
 * `harness/src/main.ts` :
 *  - `CLAUDE.md` et `.claude/settings.json` : auto-chargés par le CLI Claude Code lui-même
 *    (le process tourne avec le dépôt comme répertoire de travail) — pas lus par du code harnais.
 *  - `harness/persona/corps-vps.md` : injecté explicitement par le harnais via
 *    `--append-system-prompt-file`, sur CHAQUE réveil (wake/whatsapp/agent/cron).
 *  - `harness/persona/dream.md` : cas particulier — seulement pour le cycle nocturne Dream,
 *    PAS injecté sur un réveil normal. Listé ici pour la transparence, avec sa note distincte.
 *
 * Contenu vérifié à la main avant d'ajouter ce module (grep secrets/tokens/clés) : ce sont des
 * fichiers d'identité/protocole statiques, pas de conversation ni de secret. Taille plafonnée par
 * prudence si l'un de ces fichiers grossissait un jour sans qu'on y pense.
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
  {
    path: "harness/persona/corps-vps.md",
    label: "harness/persona/corps-vps.md",
    note: "Injecté explicitement par le harnais via --append-system-prompt-file, sur chaque réveil normal.",
  },
  {
    path: "harness/persona/dream.md",
    label: "harness/persona/dream.md",
    note: "Cas particulier : seulement pour le cycle nocturne Dream, pas injecté sur un réveil normal (wake/whatsapp/agent/cron).",
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
