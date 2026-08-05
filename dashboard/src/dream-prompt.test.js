import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { dreamPromptTemplate } from "./dream-prompt.js";

test("dreamPromptTemplate reconstruit le template depuis harness/persona/dream.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-dream-"));
  mkdirSync(join(dir, "harness", "persona"), { recursive: true });
  writeFileSync(join(dir, "harness", "persona", "dream.md"), "# protocole dream\ntest\n");
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const d = dreamPromptTemplate();
    assert.equal(d.present, true);
    assert.equal(d.truncated, false);
    assert.match(d.newCycle, /CYCLE DREAM/);
    assert.match(d.newCycle, /# protocole dream/);
    assert.match(d.resume, /REPRISE DU CYCLE DREAM/);
    // L'avertissement porte désormais sur la seule limite qui subsiste (le prompt d'une session
    // PASSÉE n'est archivé nulle part) — plus sur l'absence de journalisation, corrigée côté harnais.
    assert.match(d.warning, /TEMPLATE ACTUEL/);
    assert.doesNotMatch(d.warning, /ne sont PAS journalisées/);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dreamPromptTemplate gère un dream.md absent sans planter", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-dream-empty-"));
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const d = dreamPromptTemplate();
    assert.equal(d.present, false);
    assert.equal(d.newCycle, null);
    // La variante reprise ne dépend pas de dream.md : toujours disponible.
    assert.match(d.resume, /REPRISE DU CYCLE DREAM/);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
