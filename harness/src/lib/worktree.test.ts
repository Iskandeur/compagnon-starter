import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jobWorktreePath,
  addArgs,
  removeArgs,
  createWorktree,
  removeWorktree,
  type GitExec,
  type ExecResult,
} from "./worktree.ts";

// Exécuteur git factice : enregistre les appels, renvoie une réponse programmée (pas de vrai git).
function fakeExec(result: ExecResult): { exec: GitExec; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    return result;
  };
  return { exec, calls };
}

test("jobWorktreePath : sous le repo, préfixe .tmp-job- (gitignoré)", () => {
  assert.equal(jobWorktreePath("/repo", 16), "/repo/.tmp-job-16");
});

test("addArgs : worktree add détaché sur la base", () => {
  assert.deepEqual(addArgs("/repo/.tmp-job-7", "HEAD"), ["worktree", "add", "--detach", "/repo/.tmp-job-7", "HEAD"]);
});

test("removeArgs : worktree remove --force (pas rm -rf)", () => {
  assert.deepEqual(removeArgs("/repo/.tmp-job-7"), ["worktree", "remove", "--force", "/repo/.tmp-job-7"]);
});

test("createWorktree : chemin calculé + nettoyage préalable puis commande add, dans le repo", async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: "", stderr: "" });
  const path = await createWorktree(exec, "/repo", 42);
  assert.equal(path, "/repo/.tmp-job-42");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/repo/.tmp-job-42"]);
  assert.deepEqual(calls[1].args, ["worktree", "add", "--detach", "/repo/.tmp-job-42", "HEAD"]);
  assert.equal(calls[1].cwd, "/repo");
});

test("createWorktree : base personnalisée transmise à git", async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: "", stderr: "" });
  await createWorktree(exec, "/repo", 1, "main");
  assert.equal(calls[1].args.at(-1), "main");
});

test("createWorktree : lève si git worktree add échoue (pas de fallback sur la copie partagée)", async () => {
  const { exec } = fakeExec({ code: 128, stdout: "", stderr: "fatal: already exists" });
  await assert.rejects(() => createWorktree(exec, "/repo", 9), /worktree add a échoué.*already exists/s);
});

test("createWorktree : résidu d'un run précédent (même jobId) nettoyé avant l'add — reprise après un crash", async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    // Le remove préalable "réussit" (résidu réellement présent) ; l'add qui suit réussit aussi.
    return { code: 0, stdout: "", stderr: "" };
  };
  const path = await createWorktree(exec, "/repo", 28);
  assert.equal(path, "/repo/.tmp-job-28");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/repo/.tmp-job-28"]);
});

test("createWorktree : remove préalable échoue (rien à nettoyer) — n'empêche PAS l'add de suivre", async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[1] === "remove") return { code: 1, stdout: "", stderr: "fatal: not a working tree" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const path = await createWorktree(exec, "/repo", 5);
  assert.equal(path, "/repo/.tmp-job-5");
  assert.equal(calls.length, 2);
});

test("removeWorktree : commande de cleanup émise, renvoie true au succès", async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: "", stderr: "" });
  const ok = await removeWorktree(exec, "/repo", "/repo/.tmp-job-3");
  assert.equal(ok, true);
  assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/repo/.tmp-job-3"]);
});

test("removeWorktree : best-effort — renvoie false sans lever si le cleanup échoue", async () => {
  const { exec } = fakeExec({ code: 1, stdout: "", stderr: "fatal: not a working tree" });
  const ok = await removeWorktree(exec, "/repo", "/repo/.tmp-job-3");
  assert.equal(ok, false); // n'a PAS levé → un échec de nettoyage ne casse pas le job
});
