import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Liste les sensors enregistrés côté harnais SANS exécuter de TypeScript : une lecture texte du
 * registre (`harness/src/sensors/index.ts`, monté en lecture seule via `config.repoPath`) et un
 * regex sur le bloc `REGISTRY`. Best-effort délibéré — si ce fichier change de forme, on renvoie
 * une erreur explicite plutôt que de faire planter le dashboard (lecture seule, jamais bloquant).
 */
const REGISTRY_PATH = "harness/src/sensors/index.ts";

export function readSensorNames() {
  const filePath = join(config.repoPath, REGISTRY_PATH);
  if (!existsSync(filePath)) {
    return { names: [], error: `fichier introuvable : ${REGISTRY_PATH}` };
  }
  try {
    const src = readFileSync(filePath, "utf8");
    const block = src.match(/REGISTRY[^{]*=\s*{([^}]*)}/);
    if (!block) return { names: [], error: "bloc REGISTRY introuvable dans le fichier" };
    const names = [...block[1].matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
    return { names, error: null };
  } catch (e) {
    return { names: [], error: e.message };
  }
}
