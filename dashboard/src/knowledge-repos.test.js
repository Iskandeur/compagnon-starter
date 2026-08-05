import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { githubUrlFromRemote, readKnowledgeRepos } from "./knowledge-repos.js";

/** Registre minimal, à la forme du vrai `knowledge/registry.json` (champs sensibles inclus, pour
 *  vérifier qu'ils ne sortent PAS). */
const REGISTRY = {
  _comment: "Registre des knowledge repos que le compagnon connaît.",
  repos: [
    {
      name: "famille",
      remote: "git@github.com:example-org/famille.git",
      path: "knowledge/famille",
      branch: "main",
      domains: ["vie perso", "Projet Exemple"],
      load_when: "sujets personnels",
      status: "intégré (cloné) le 2026-06-19",
      notes: "Contenu sensible (données perso) → strictement pour ton humain.",
    },
    {
      name: "second-cerveau",
      remote: "https://github.com/example-org/second-cerveau.git",
      path: "knowledge/second-cerveau",
      branch: "main",
      domains: ["notes personnelles"],
      load_when: "notes du deuxième cerveau",
      status: "cloné le 2026-06-23",
      notes: "⚠️ .env = SON MASTER TOKEN → ne jamais afficher.",
    },
  ],
  obsidian: { access_decision_2026_06_23: "token dans .env mode 600" },
};

/** Monte un faux dépôt avec le registre donné et exécute `fn` avec `config.repoPath` pointé dessus. */
function withRegistry(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-knowledge-"));
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
  assert.equal(repos[0].name, "famille");
  assert.equal(repos[0].url, "https://github.com/example-org/famille");
  assert.equal(repos[0].visibility, "privé");
  assert.deepEqual(repos[0].domains, ["vie perso", "Projet Exemple"]);
  assert.equal(repos[0].loadWhen, "sujets personnels");
  assert.equal(repos[0].status, "intégré (cloné) le 2026-06-19");
  assert.equal(repos[1].url, "https://github.com/example-org/second-cerveau"); // remote HTTPS aussi
});

test("🔒 aucune donnée sensible ne sort : ni `notes`, ni bloc `obsidian`, ni chemin local", () => {
  const { repos } = withRegistry(JSON.stringify(REGISTRY), readKnowledgeRepos);
  for (const r of repos) {
    assert.equal(r.notes, undefined);
    assert.equal(r.path, undefined);
    assert.equal(r.remote, undefined);
  }
  // Filet global : la sérialisation complète de la réponse ne doit contenir AUCUN des marqueurs
  // sensibles du registre (l'entrée second-cerveau décrit l'emplacement du master token).
  const serialized = JSON.stringify(repos);
  for (const secret of ["MASTER TOKEN", ".env", "knowledge/famille"]) {
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

test("le VRAI registre du dépôt principal est lisible et a la forme attendue, s'il est monté", () => {
  // Garde-fou anti-régression : lit le registre réel s'il est monté (ex. DASHBOARD_REPO_PATH
  // pointé sur ton propre dépôt). Ignoré ailleurs (CI/poste sans dépôt monté) plutôt que d'échouer.
  const prev = config.repoPath;
  config.repoPath = process.env.DASHBOARD_REPO_PATH ?? "/repo";
  try {
    const { repos, error } = readKnowledgeRepos();
    if (error) return; // dépôt non monté ici — rien à vérifier
    assert.ok(repos.length >= 1, `attendu au moins 1 knowledge repo, vu ${repos.length}`);
    assert.ok(repos.every((r) => typeof r.name === "string" && r.name.length > 0));
    assert.ok(repos.every((r) => r.url?.startsWith("https://github.com/")));
  } finally {
    config.repoPath = prev;
  }
});
