import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

// Séparateurs improbables dans un message de commit (unit/record separator ASCII) — évite
// d'écrire un parseur JSON côté git.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

// Le dépôt est monté en lecture seule depuis l'hôte (uid du process hôte) alors que ce conteneur
// tourne en root → git refuse par défaut ("dubious ownership"). `-c safe.directory` scope
// l'exception à CETTE invocation (pas de `git config --global` qui polluerait un état partagé).
const SAFE_DIR_ARGS = ["-c", `safe.directory=${config.repoPath}`];

/** Derniers commits touchant journal/, memoire/ ou competences/ — « ce que le compagnon a appris
 *  récemment ». Lecture seule (`git log`), sur le dépôt monté en `:ro`. */
export async function recentLearningCommits(limit = 20) {
  const fmt = `%H${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s${RECORD_SEP}`;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        ...SAFE_DIR_ARGS,
        "-C",
        config.repoPath,
        "log",
        `--max-count=${limit}`,
        `--pretty=format:${fmt}`,
        "--date=iso-strict",
        "--",
        "journal/",
        "memoire/",
        "competences/",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split(RECORD_SEP)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, author, date, subject] = r.split(FIELD_SEP);
        return { hash, author, date, subject };
      });
  } catch (e) {
    console.error("[git] échec git log :", e.message);
    return [];
  }
}

export async function headSha() {
  try {
    const { stdout } = await execFileAsync("git", [...SAFE_DIR_ARGS, "-C", config.repoPath, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}
