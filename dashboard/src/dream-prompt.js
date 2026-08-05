import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Panneau "Cycle Dream" : montrer le prompt/contexte avec lequel une session Dream démarre — si
 * ton harnais a un cycle nocturne de ce genre (voir `harness/README.md`).
 *
 * Piège vécu, à éviter dans ton propre harnais : si ton cycle Dream appelle le moteur directement
 * sans jamais passer par ta fonction de journalisation de session, aucune session Dream n'apparaît
 * jamais ici — rien à cliquer. Journalise chaque cycle Dream abouti comme un réveil normal
 * (`source: "dream"`) pour que `GET /api/dream-prompt` puisse servir les VRAIES sessions
 * (`src/db.js::listDreamSessions`) à côté de ce template.
 *
 * Ce module reste utile comme REPLI : il reconstruit le TEMPLATE ACTUEL — exactement ce qu'une
 * NOUVELLE session Dream recevrait maintenant, depuis les mêmes sources que ton cycle Dream réel
 * (`harness/persona/dream.md`, monté en lecture seule, déjà vérifié sans secret pour le panneau
 * Contexte). Le prompt exact reçu par une session PASSÉE n'est toujours archivé nulle part : si
 * `dream.md` ou le code du cycle Dream ont changé depuis, ce template en diffère. D'où
 * l'avertissement exposé avec la donnée plutôt qu'enfoui dans un commentaire.
 */
const MAX_BYTES = 100_000;
const DREAM_MD_PATH = "harness/persona/dream.md";

// Corps du prompt de reprise après coupure quota — miroir manuel de `runDream()` dans
// harness/src/dream.ts (variante `opts.resumeSession`). À resynchroniser à la main si ce fichier
// change ; ce module ne peut pas exécuter/parser du TypeScript pour le lire dynamiquement.
const RESUME_BODY = [
  "Le quota Claude t'avait interrompu pendant ce rêve. Tu as déjà tout ton contexte dans CETTE",
  "session : reprends exactement là où tu t'étais arrêté, ne recommence pas de zéro. Termine ton",
  "cycle (consolidation, apprentissage, projets, Ouroboros) puis envoie le rapport du matin si tu",
  "ne l'as pas déjà fait.",
].join("\n");

export function dreamPromptTemplate() {
  const filePath = join(config.repoPath, DREAM_MD_PATH);
  const present = existsSync(filePath);
  const size = present ? statSync(filePath).size : 0;
  const truncated = present && size > MAX_BYTES;
  const dreamMd = present && !truncated ? readFileSync(filePath, "utf8") : null;

  return {
    source: DREAM_MD_PATH,
    present,
    truncated,
    size,
    newCycle: dreamMd !== null ? `[🌙 CYCLE DREAM — <horodatage local au moment du réveil>]\n\n${dreamMd}` : null,
    resume: `[🌙 REPRISE DU CYCLE DREAM — <horodatage local au moment de la reprise>]\n\n${RESUME_BODY}`,
    warning:
      "Ceci est le TEMPLATE ACTUEL, reconstruit depuis harness/persona/dream.md : ce qu'une NOUVELLE " +
      "session Dream recevrait maintenant. Le prompt exact reçu par une session PASSÉE n'est archivé " +
      "nulle part — si dream.md ou harness/src/dream.ts ont changé depuis, ce template en diffère. " +
      "Les sessions Dream elles-mêmes sont désormais journalisées (source « dream », depuis le " +
      "30/07/2026) et listées dans ce panneau : cliquables comme n'importe quelle autre session.",
  };
}
