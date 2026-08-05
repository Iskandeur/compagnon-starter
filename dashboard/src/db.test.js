import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { deepseekBalance, modelSettings, usageSummary } from "./db.js";

// `db.js` ouvre paresseusement `config.dbPath` et cache le handle — on le rouvre à chaque test en
// changeant `config.dbPath` (cf. `openedForPath` dans db.js) plutôt que de mocker `node:sqlite`.
function withTestDb(seedFn, runFn) {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-db-"));
  const dbPath = join(dir, "test.sqlite");
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE session_log (
      session_id TEXT PRIMARY KEY, scope TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER,
      last_cost_usd REAL, summary TEXT, source TEXT, model TEXT, effort TEXT);
    CREATE TABLE cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL,
      session_id TEXT, engine TEXT NOT NULL, model TEXT, cost_usd REAL NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
  `);
  seedFn(seed);
  seed.close();

  const prevDbPath = config.dbPath;
  config.dbPath = dbPath;
  try {
    runFn();
  } finally {
    config.dbPath = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("usageSummary agrège coût total, par jour, par modèle/provider et par catégorie", () => {
  const now = Date.now();
  const day = 86400000;
  withTestDb(
    (seed) => {
      const insert = seed.prepare(
        `INSERT INTO cost_log (ts, scope, session_id, engine, model, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // session interactive Claude, aujourd'hui
      insert.run(now, "global", "s1", "claude", "claude-sonnet-5", 1.5);
      // job de fond DeepSeek, hier
      insert.run(now - day, "job", "s2", "deepseek", "deepseek-v4-flash", 0.02);
      // cycle Dream Claude, il y a 10 jours (hors fenêtre 7j, dans la fenêtre 30j)
      insert.run(now - 10 * day, "dream", "s3", "claude", "opus", 0.75);
      // session hors fenêtre (40 jours) : ne doit compter nulle part
      insert.run(now - 40 * day, "global", "s4", "claude", "claude-sonnet-5", 99);
      // modèle inconnu (colonne jamais renseignée) : ne doit pas planter
      insert.run(now, "global", "s5", "claude", null, 0.1);
      // Codex n'a pas de coût dollar exposé : il apparaît à 0 $, mais bien comme fournisseur Codex.
      insert.run(now, "global", "s6", "codex", "codex", 0);
    },
    () => {
      const summary = usageSummary(30);
      assert.equal(summary.days, 30);
      assert.ok(Math.abs(summary.totalUsd - (1.5 + 0.02 + 0.75 + 0.1)) < 1e-9);
      assert.ok(Math.abs(summary.totalUsd7 - (1.5 + 0.02 + 0.1)) < 1e-9);
      assert.ok(!summary.byDay.some((r) => r.usd === 99));

      const byModel = Object.fromEntries(summary.byModel.map((r) => [r.model, r]));
      assert.equal(byModel["deepseek-v4-flash"].provider, "deepseek");
      assert.equal(byModel.codex.provider, "codex");
      assert.equal(byModel.codex.usd, 0);
      assert.equal(byModel["claude-sonnet-5"].provider, "claude");
      assert.equal(byModel["opus"].provider, "claude");
      assert.equal(byModel["inconnu"].provider, "inconnu");
      assert.ok(Math.abs(byModel["claude-sonnet-5"].usd - 1.5) < 1e-9);

      const byCategory = Object.fromEntries(summary.byCategory.map((r) => [r.category, r]));
      assert.ok(Math.abs(byCategory.sessions.usd - (1.5 + 0.1)) < 1e-9);
      assert.ok(Math.abs(byCategory.job.usd - 0.02) < 1e-9);
      assert.ok(Math.abs(byCategory.dream.usd - 0.75) < 1e-9);
    },
  );
});

test("usageSummary renvoie des totaux à zéro sans planter quand la base est vide/absente", () => {
  withTestDb(
    () => {},
    () => {
      const summary = usageSummary(30);
      assert.equal(summary.totalUsd, 0);
      assert.equal(summary.totalUsd7, 0);
      assert.deepEqual(summary.byDay, []);
      assert.deepEqual(summary.byModel, []);
      assert.deepEqual(summary.byCategory, []);
    },
  );
});

test("deepseekBalance renvoie null tant que le harnais n'a rien écrit, puis les valeurs stockées", () => {
  withTestDb(
    () => {},
    () => {
      assert.equal(deepseekBalance(), null);
    },
  );
  withTestDb(
    (seed) => {
      seed
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run("deepseek_balance_usd", "19.96", Date.now());
      seed
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run("deepseek_balance_checked_at", String(1700000000000), Date.now());
    },
    () => {
      const balance = deepseekBalance();
      assert.equal(balance.usd, 19.96);
      assert.equal(balance.checkedAt, 1700000000000);
    },
  );
});

test("modelSettings expose global/groupe/jobs/dream sans exposer le chat_id", () => {
  // Fixture, pas le vrai identifiant de groupe : modelSettings() lit config.groupChatId au lieu
  // d'une valeur codée en dur (cf. src/db.js), donc le test peut pointer vers n'importe quel id.
  const FIXTURE_GROUP_ID = "12345@g.us";
  const prevGroupChatId = config.groupChatId;
  config.groupChatId = FIXTURE_GROUP_ID;
  try {
    withTestDb(
      (seed) => {
        const insert = seed.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
        insert.run("engine", "codex", 1000);
        insert.run("codex_model", "gpt-5.6-terra", 1000);
        insert.run("effort", "high", 1000);
        insert.run(`engine:${FIXTURE_GROUP_ID}`, "codex", 1500);
        insert.run(`codex_model:${FIXTURE_GROUP_ID}`, "gpt-5.6-luna", 1500);
        insert.run("model:jobs", "opus", 2000);
        insert.run("provider:dream", "deepseek", 3000);
        insert.run("deepseek_model:dream", "deepseek-v4-flash", 3000);
        insert.run("model:336@g.us", "haiku", 4000);
      },
      () => {
        const scopes = Object.fromEntries(modelSettings().scopes.map((s) => [s.id, s]));
        assert.deepEqual(Object.keys(scopes), ["global", "group", "jobs", "dream"]);
        assert.equal(scopes.global.mode, "codex");
        assert.equal(scopes.global.settings.codexModel.value, "gpt-5.6-terra");
        assert.equal(scopes.global.settings.effort.value, "high");
        assert.equal(scopes.group.mode, "codex");
        assert.equal(scopes.group.scopeArg, "group");
        assert.equal(scopes.group.settings.codexModel.value, "gpt-5.6-luna");
        assert.equal(scopes.jobs.mode, "claude");
        assert.equal(scopes.jobs.settings.model.value, "opus");
        assert.equal(scopes.dream.mode, "deepseek");
        assert.equal(scopes.dream.settings.deepseekModel.value, "deepseek-v4-flash");
        assert.equal(JSON.stringify(modelSettings()).includes(FIXTURE_GROUP_ID), false);
      },
    );
  } finally {
    config.groupChatId = prevGroupChatId;
  }
});

test("modelSettings : une portée sans override affiche inherit, même si le global est Codex", () => {
  withTestDb(
    (seed) => {
      const insert = seed.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
      insert.run("engine", "codex", 1000);
      insert.run("codex_model", "gpt-5.6-luna", 1000);
      insert.run("effort", "max", 1000);
    },
    () => {
      const scopes = Object.fromEntries(modelSettings().scopes.map((s) => [s.id, s]));
      assert.equal(scopes.global.mode, "codex");
      assert.equal(scopes.group.mode, "inherit");
      assert.equal(scopes.jobs.mode, "inherit");
      assert.equal(scopes.dream.mode, "inherit");
    },
  );
});
