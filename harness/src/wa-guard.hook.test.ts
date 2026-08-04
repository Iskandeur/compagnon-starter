/**
 * Non-régression du HOOK `bin/wa-guard.ts` (exécuté tel qu'un `settings.json` l'appellerait :
 * `node <repo>/harness/bin/wa-guard.ts`, évènement JSON sur stdin, décision JSON sur stdout).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dirname, "..", "bin", "wa-guard.ts");
const GROUP_OK = "111111111111111111@g.us";
const GROUP_OTHER = "999999999999999999@g.us";
const OWNER = "10000000000@c.us";

function runHook(home: string, chatId: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "mcp__whatsapp_own__send-text", tool_input: { chatId, text: "hello" } }),
    encoding: "utf8",
    env: { ...process.env, COMPAGNON_HOME: home, WA_GUARD_OWNER: OWNER },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Le hook « refuse » en imprimant une décision deny sur stdout ; laisser passer = stdout vide. */
function denied(stdout: string): boolean {
  if (stdout.trim() === "") return false;
  return JSON.parse(stdout).hookSpecificOutput?.permissionDecision === "deny";
}

function homeWithAllowlist(): string {
  const home = mkdtempSync(join(tmpdir(), "compagnon-hook-"));
  mkdirSync(join(home, "harness", "config"), { recursive: true });
  writeFileSync(join(home, "harness", "config", "wa-guard-groups-ok"), `# groupe exemple\n${GROUP_OK}\n`);
  mkdirSync(join(home, "data"), { recursive: true });
  return home;
}

test("hook : allowlist présente → envoi vers un groupe listé AUTORISÉ", () => {
  const home = homeWithAllowlist();
  const r = runHook(home, GROUP_OK);
  assert.equal(r.code, 0);
  assert.equal(denied(r.stdout), false, `attendu autorisé, stdout=${r.stdout} stderr=${r.stderr}`);
  // …et l'envoi est journalisé dans l'état runtime.
  const state = join(home, "data", "wa-guard-state.json");
  assert.ok(existsSync(state), "journal d'envoi écrit sous data/");
  assert.ok(readFileSync(state, "utf8").includes(GROUP_OK));
});

test("hook : groupe ABSENT d'une allowlist PRÉSENTE → refus normal, sans cri", () => {
  const home = homeWithAllowlist();
  const r = runHook(home, GROUP_OTHER);
  assert.equal(denied(r.stdout), true, "un groupe non déverrouillé reste refusé");
  assert.ok(!/INTROUVABLE/.test(r.stderr), "refus légitime = pas d'alerte de déploiement");
});

test("hook : allowlist INTROUVABLE → refus ET cri explicite sur stderr (pas un refus légitime)", () => {
  const home = mkdtempSync(join(tmpdir(), "compagnon-hook-vide-"));
  const r = runHook(home, GROUP_OK);
  assert.equal(r.code, 0, "le hook ne crashe jamais");
  assert.equal(denied(r.stdout), true, "échoue fermé");
  assert.match(r.stderr, /INTROUVABLE/);
});

test("hook : un 1:1 ne consulte PAS l'allowlist (aucun bruit même sans fichier)", () => {
  const home = mkdtempSync(join(tmpdir(), "compagnon-hook-1a1-"));
  const r = runHook(home, OWNER);
  assert.equal(denied(r.stdout), false, "un message au principal passe");
  assert.ok(!/INTROUVABLE/.test(r.stderr), "l'allowlist groupe n'a rien à voir avec un 1:1");
});

test("hook : canal humain (impersonation) → toujours refusé, même en 1:1", () => {
  const home = mkdtempSync(join(tmpdir(), "compagnon-hook-human-"));
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "mcp__whatsapp_human__send-text", tool_input: { chatId: OWNER, text: "hello" } }),
    encoding: "utf8",
    env: { ...process.env, COMPAGNON_HOME: home, WA_GUARD_OWNER: OWNER },
  });
  assert.equal(denied(r.stdout ?? ""), true, "le canal humain n'envoie jamais directement");
});
