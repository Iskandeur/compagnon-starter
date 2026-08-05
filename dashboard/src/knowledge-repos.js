import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Knowledge repos de ton compagnon, lus DYNAMIQUEMENT depuis un registre du dépôt principal
 * (`knowledge/registry.json`, monté en lecture seule via `config.repoPath`) — jamais recopiés en
 * dur ici. Si tu ajoutes un repo au registre, ce panneau suit tout seul, sans redéploiement.
 *
 * Optionnel : si tu n'as pas ce pattern (clones de dépôts privés chargés à la demande dans
 * `knowledge/<nom>/`), ce panneau affiche simplement "registre introuvable" — pas une erreur.
 *
 * 🔒 EXPOSITION STRICTEMENT LIMITÉE AUX MÉTADONNÉES. Ce module renvoie le nom, le lien GitHub, les
 * domaines couverts, le `load_when` et le `status` — et RIEN d'autre. Si ton propre registre porte
 * des champs additionnels (notes libres, détails d'accès/token, chemin local du clone…), garde-les
 * EXCLUS de ce module : un registre de ce genre peut légitimement contenir l'emplacement d'un
 * secret ou une remarque sur la sensibilité d'un domaine (ex. données concernant des tiers) —
 * aucune raison de faire transiter ça par une API HTTP, même derrière le PIN. Le contenu des repos
 * eux-mêmes n'est de toute façon jamais lu ici : afficher un index n'est pas afficher le contenu.
 */
const REGISTRY_PATH = "knowledge/registry.json";

/**
 * URL web GitHub à partir du `remote` git du registre. Gère les deux formes usuelles
 * (`git@github.com:Owner/repo.git` et `https://github.com/Owner/repo.git`). Renvoie null si le
 * remote n'est pas un GitHub reconnaissable — on préfère afficher le repo sans lien qu'un lien
 * inventé.
 */
export function githubUrlFromRemote(remote) {
  if (typeof remote !== "string") return null;
  const m = remote.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/**
 * Le registre, réduit aux métadonnées affichables. Best-effort comme le reste du dashboard :
 * registre absent/illisible → `{ repos: [], error }`, jamais une exception qui casse la page.
 */
export function readKnowledgeRepos() {
  const filePath = join(config.repoPath, REGISTRY_PATH);
  if (!existsSync(filePath)) {
    return { repos: [], error: `registre introuvable : ${REGISTRY_PATH}`, source: REGISTRY_PATH };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const list = Array.isArray(parsed?.repos) ? parsed.repos : [];
    return {
      repos: list.map((r) => ({
        name: r.name ?? "(sans nom)",
        url: githubUrlFromRemote(r.remote),
        // Le registre ne porte typiquement pas de champ visibilité par repo (souvent tous privés,
        // un usage perso) : si le tien varie, adapte cette ligne pour lire un champ dédié au lieu
        // de la constante ci-dessous.
        visibility: "privé",
        domains: Array.isArray(r.domains) ? r.domains : [],
        loadWhen: typeof r.load_when === "string" ? r.load_when : null,
        status: typeof r.status === "string" ? r.status : null,
      })),
      error: null,
      source: REGISTRY_PATH,
    };
  } catch (e) {
    return { repos: [], error: `registre illisible : ${e.message}`, source: REGISTRY_PATH };
  }
}
