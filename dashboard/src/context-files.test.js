import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { listContextFiles } from "./context-files.js";

test("listContextFiles lit le contenu des fichiers présents et signale les absents", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-dash-ctx-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# test\n");
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const files = listContextFiles();
    const claude = files.find((f) => f.path === "CLAUDE.md");
    assert.equal(claude.present, true);
    assert.equal(claude.content, "# test\n");
    assert.equal(claude.truncated, false);

    const settings = files.find((f) => f.path === ".claude/settings.json");
    assert.equal(settings.present, false);
    assert.equal(settings.content, null);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
