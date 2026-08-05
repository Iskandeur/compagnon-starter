import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Knowledge repos de ton compagnon, lus DYNAMIQUEMENT depuis le registre du dépôt principal
 * (`knowledge/registry.json`, monté en lecture seule via `config.repoPath`) — jamais recopiés en
 * dur ici. Même principe que le panneau Sensors, qui lit le vrai registre plutôt qu'une liste
 * dupliquée : si tu ajoutes un repo au registre, ce panneau suit tout seul.
 *
 * Piège vécu à éviter : ne fais jamais découvrir ces repos en explorant l'API GitHub à l'aveugle —
 * si tes clones vivent dans `knowledge/<nom>/` et sont git-ignorés du dépôt principal, ils sont
 * invisibles depuis GitHub seul. La source de vérité est TOUJOURS ton registre versionné
 * (`knowledge/registry.json`) : lis-le, ne devine pas.
 *
 * 🔒 EXPOSITION STRICTEMENT LIMITÉE AUX MÉTADONNÉES. Ce module renvoie le nom, le lien GitHub, les
 * domaines couverts, le `load_when` et le `status` — et RIEN d'autre :
 *  - `notes` (registre) : DÉLIBÉRÉMENT exclu — c'est typiquement là que vivent des détails
 *    d'accès/tokens sur un repo de connaissance personnelle. Aucune raison de faire transiter ça
 *    par une API HTTP, même derrière le PIN.
 *  - tout bloc de config annexe du registre (ex. `obsidian`, accès à un second cerveau) : exclu
 *    pour la même raison.
 *  - `path` : chemin local du clone, sans intérêt ici.
 *  - le CONTENU des repos n'est évidemment jamais lu (les clones ne sont même pas dans le dépôt
 *    monté) — certains knowledge repos peuvent contenir des données sensibles sur des tiers.
 *    Afficher un index n'est pas afficher le contenu — cette ligne ne bouge pas.
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
        // Le registre ne porte pas de champ visibilité par repo ici : "privé" est une propriété du
        // lot (des knowledge repos perso), pas devinée repo par repo. Adapte si le tien diffère.
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
