import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { githubUrlFromRemote, readKnowledgeRepos } from "./knowledge-repos.js";

/** Registre minimal, à la forme d'un vrai `knowledge/registry.json` (champs sensibles inclus, pour
 *  vérifier qu'ils ne sortent PAS). Domaines et notes fictifs, pas d'identité réelle. */
const REGISTRY = {
  _comment: "Registre des knowledge repos que ce compagnon connaît.",
  repos: [
    {
      name: "domaine-exemple-a",
      remote: "git@github.com:example-org/domaine-exemple-a.git",
      path: "knowledge/domaine-exemple-a",
      branch: "main",
      domains: ["exemple", "domaine sensible"],
      load_when: "sujets liés au domaine A",
      status: "intégré (cloné) le 2026-01-01",
      notes: "Contenu sensible (ex. données sur des tiers) → accès restreint.",
    },
    {
      name: "domaine-exemple-b",
      remote: "https://github.com/example-org/domaine-exemple-b.git",
      path: "knowledge/domaine-exemple-b",
      branch: "main",
      domains: ["deuxième cerveau notes"],
      load_when: "notes personnelles",
      status: "cloné le 2026-01-02",
      notes: "⚠️ contient l'emplacement d'un jeton d'accès → ne jamais afficher.",
    },
  ],
  extras: { access_decision_example: "détail d'accès qui ne doit jamais sortir de ce module" },
};

/** Monte un faux dépôt avec le registre donné et exécute `fn` avec `config.repoPath` pointé dessus. */
function withRegistry(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "companion-dash-knowledge-"));
  if (content !== null) {
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(join(dir, "knowledge", "registry.json"), content);
  }
  const prev = config.repoPath;
  config.repoPath = dir;
  try {
    return fn();
  } finally {
    config.repoPath = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("githubUrlFromRemote : dérive l'URL web depuis un remote SSH ou HTTPS", () => {
  assert.equal(githubUrlFromRemote("git@github.com:example-org/example-repo.git"), "https://github.com/example-org/example-repo");
  assert.equal(githubUrlFromRemote("https://github.com/example-org/example-repo.git"), "https://github.com/example-org/example-repo");
  assert.equal(githubUrlFromRemote("git@github.com:example-org/example-repo"), "https://github.com/example-org/example-repo");
  // Remote non-GitHub ou absurde → null : on préfère un repo sans lien qu'un lien inventé.
  assert.equal(githubUrlFromRemote("git@gitlab.com:x/y.git"), null);
  assert.equal(githubUrlFromRemote(undefined), null);
});

test("readKnowledgeRepos lit le registre et expose nom, lien, domaines, statut", () => {
  const { repos, error, source } = withRegistry(JSON.stringify(REGISTRY), readKnowledgeRepos);
  assert.equal(error, null);
  assert.equal(source, "knowledge/registry.json");
  assert.equal(repos.length, 2);
  assert.equal(repos[0].name, "domaine-exemple-a");
  assert.equal(repos[0].url, "https://github.com/example-org/domaine-exemple-a");
  assert.equal(repos[0].visibility, "privé");
  assert.deepEqual(repos[0].domains, ["exemple", "domaine sensible"]);
  assert.equal(repos[0].loadWhen, "sujets liés au domaine A");
  assert.equal(repos[0].status, "intégré (cloné) le 2026-01-01");
  assert.equal(repos[1].url, "https://github.com/example-org/domaine-exemple-b"); // remote HTTPS aussi
});

test("🔒 aucune donnée sensible ne sort : ni `notes`, ni bloc `extras`, ni chemin local", () => {
  const { repos } = withRegistry(JSON.stringify(REGISTRY), readKnowledgeRepos);
  for (const r of repos) {
    assert.equal(r.notes, undefined);
    assert.equal(r.path, undefined);
    assert.equal(r.remote, undefined);
  }
  const serialized = JSON.stringify(repos);
  for (const secret of ["jeton d'accès", "path", "remote", "détail d'accès"]) {
    assert.equal(serialized.includes(secret), false, `« ${secret} » ne doit pas être exposé`);
  }
});

test("registre absent → erreur explicite, pas d'exception (dashboard jamais bloquant)", () => {
  const { repos, error } = withRegistry(null, readKnowledgeRepos);
  assert.deepEqual(repos, []);
  assert.match(error, /introuvable/);
});

test("registre illisible (JSON cassé) → erreur explicite, pas d'exception", () => {
  const { repos, error } = withRegistry("{ pas du json", readKnowledgeRepos);
  assert.deepEqual(repos, []);
  assert.match(error, /illisible/);
});

test("registre sans tableau `repos` → liste vide, sans planter", () => {
  const { repos, error } = withRegistry(JSON.stringify({ _comment: "vide" }), readKnowledgeRepos);
  assert.deepEqual(repos, []);
  assert.equal(error, null);
});
