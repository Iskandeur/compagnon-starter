import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { readSensorNames } from "./sensors-registry.js";

test("readSensorNames extrait les noms du bloc REGISTRY", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-"));
  const sensorsDir = join(dir, "harness/src/sensors");
  mkdirSync(sensorsDir, { recursive: true });
  writeFileSync(
    join(sensorsDir, "index.ts"),
    'const REGISTRY: Record<string, Sensor> = {\n  "gtasks-example": gtasksExampleSensor,\n  "role-mail": roleMailSensor,\n};\n',
  );
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const { names, error } = readSensorNames();
    assert.deepEqual(names, ["gtasks-example", "role-mail"]);
    assert.equal(error, null);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSensorNames renvoie une erreur explicite si le fichier est absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-empty-"));
  const prevRepoPath = config.repoPath;
  config.repoPath = dir;
  try {
    const { names, error } = readSensorNames();
    assert.deepEqual(names, []);
    assert.ok(error);
  } finally {
    config.repoPath = prevRepoPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
