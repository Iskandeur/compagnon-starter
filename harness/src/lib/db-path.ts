/**
 * Résolution du chemin de la base SQLite — TOUJOURS absolue, JAMAIS relative au cwd.
 *
 * Piège classique à éviter : si le chemin par défaut ("data/wakes.sqlite") est résolu contre le
 * répertoire courant du process, un CLI lancé depuis un sous-dossier (ex. `harness/`) ouvre une
 * base DIFFÉRENTE de celle que le daemon ouvre depuis la racine du repo — deux bases, un état qui
 * diverge en silence (un réveil programmé par le CLI n'est jamais vu par le scheduler). Le fix :
 * ne jamais résoudre contre `process.cwd()`, toujours contre la racine du harness (calculée depuis
 * l'emplacement de CE fichier, indépendant de qui l'importe et d'où on le lance).
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Racine du harness (dossier contenant package.json), calculée depuis ce fichier — pas le cwd. */
export function harnessRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../harness/src/lib
  return join(here, "..", "..");
}

/**
 * Chemin ABSOLU de la base SQLite. Lit la variable d'env `envVar` (relative ou déjà absolue) ;
 * à défaut, retombe sur `fallback` résolu contre la racine du harness.
 */
export function resolveDbPath(envVar = "SQLITE_PATH", fallback = "data/wakes.sqlite"): string {
  const raw = process.env[envVar]?.trim() || fallback;
  return resolve(harnessRoot(), raw);
}
