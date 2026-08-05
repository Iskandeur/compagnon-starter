import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Panneau "Rituel nocturne" (exemple) : si ton compagnon a un cycle qui tourne sans intervention
 * humaine (consolidation nocturne, veille, whatever tu appelles ça), ce panneau montre le
 * prompt/contexte avec lequel une nouvelle occurrence démarrerait, et — si ton harnais journalise
 * ces sessions avec `source: "nightly"` dans une table `session_log` (cf. `src/db.js`) — les vraies
 * occurrences passées, cliquables comme n'importe quelle autre session.
 *
 * Ce module reconstruit le TEMPLATE ACTUEL — exactement ce qu'une NOUVELLE occurrence recevrait
 * maintenant, depuis `harness/persona/nightly.md` (à adapter : mets ici le chemin réel du fichier
 * que TON harnais injecte pour ce rituel, monté en lecture seule, déjà vérifié sans secret). Le
 * prompt exact reçu par une occurrence PASSÉE n'est archivé nulle part par ce module : si ce
 * fichier a changé depuis, ce template en diffère — d'où l'avertissement exposé avec la donnée
 * plutôt qu'enfoui dans un commentaire.
 *
 * Optionnel : si tu n'as pas ce pattern, ce panneau affiche juste "fichier introuvable" — retire-le
 * de `public/index.html` / `public/app.js` si tu préfères ne pas l'exposer du tout.
 */
const MAX_BYTES = 100_000;
const NIGHTLY_MD_PATH = "harness/persona/nightly.md";
const NIGHTLY_SOURCE = "nightly";

// Corps d'un prompt de reprise après coupure (ex. quota) — exemple à adapter à ton propre
// mécanisme de reprise, si tu en as un. Ce module ne peut pas exécuter/parser du TypeScript pour
// le déduire dynamiquement de ton code : resynchronise ce texte à la main si ta logique change.
const RESUME_BODY = [
  "Ce cycle avait été interrompu. Tu as déjà tout ton contexte dans CETTE session : reprends",
  "exactement là où tu t'étais arrêté, ne recommence pas de zéro. Termine ton cycle habituel",
  "(consolidation, apprentissage, projets) puis envoie ton rapport si tu ne l'as pas déjà fait.",
].join("\n");

export function dreamPromptTemplate() {
  const filePath = join(config.repoPath, NIGHTLY_MD_PATH);
  const present = existsSync(filePath);
  const size = present ? statSync(filePath).size : 0;
  const truncated = present && size > MAX_BYTES;
  const nightlyMd = present && !truncated ? readFileSync(filePath, "utf8") : null;

  return {
    source: NIGHTLY_MD_PATH,
    present,
    truncated,
    size,
    newCycle: nightlyMd !== null ? `[🌙 NOUVEAU CYCLE — <horodatage au moment du réveil>]\n\n${nightlyMd}` : null,
    resume: `[🌙 REPRISE DE CYCLE — <horodatage au moment de la reprise>]\n\n${RESUME_BODY}`,
    warning:
      `Ceci est le TEMPLATE ACTUEL, reconstruit depuis ${NIGHTLY_MD_PATH} : ce qu'une NOUVELLE ` +
      "occurrence recevrait maintenant. Le prompt exact reçu par une occurrence PASSÉE n'est archivé " +
      "nulle part — si ce fichier ou la logique qui le sert ont changé depuis, ce template en diffère.",
  };
}

export const DREAM_SOURCE = NIGHTLY_SOURCE;
