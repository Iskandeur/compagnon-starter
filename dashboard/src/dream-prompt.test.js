import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { dreamPromptTemplate } from "./dream-prompt.js";

test("dreamPromptTemplate reconstruit le template depuis harness/persona/nightly.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-dash-nightly-"));
  mkdirSync(join(dir, "harness", "persona"), { recursive: true });
  writeFileSync(join(dir, "harness", "persona", "nightly.md"), "# protocole nocturne\ntest\n");
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const d = dreamPromptTemplate();
    assert.equal(d.present, true);
    assert.equal(d.truncated, false);
    assert.match(d.newCycle, /NOUVEAU CYCLE/);
    assert.match(d.newCycle, /# protocole nocturne/);
    assert.match(d.resume, /REPRISE DE CYCLE/);
    assert.match(d.warning, /TEMPLATE ACTUEL/);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dreamPromptTemplate gère un fichier absent sans planter", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-dash-nightly-empty-"));
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const d = dreamPromptTemplate();
    assert.equal(d.present, false);
    assert.equal(d.newCycle, null);
    // La variante reprise ne dépend pas du fichier : toujours disponible.
    assert.match(d.resume, /REPRISE DE CYCLE/);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
