import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getPriority } from "node:os";
import { withNiceness, JOB_NICENESS } from "./nice.ts";

test("un job part derrière `nice -n 10`, binaire et arguments intacts", () => {
  assert.deepEqual(withNiceness("claude", ["-p", "fais X"], JOB_NICENESS), {
    cmd: "nice",
    args: ["-n", "10", "claude", "-p", "fais X"],
  });
});

test("sans priorité (conversation, réveil), le spawn est inchangé", () => {
  assert.deepEqual(withNiceness("claude", ["-p", "salut"], undefined), { cmd: "claude", args: ["-p", "salut"] });
  assert.deepEqual(withNiceness("claude", ["-p"], 0), { cmd: "claude", args: ["-p"] });
});

test("un négatif (exigerait root, ferait échouer le lancement) ou une valeur bizarre est ignoré", () => {
  assert.deepEqual(withNiceness("codex", ["exec"], -5), { cmd: "codex", args: ["exec"] });
  assert.deepEqual(withNiceness("codex", ["exec"], 2.5), { cmd: "codex", args: ["exec"] });
  assert.deepEqual(withNiceness("codex", ["exec"], Number.NaN), { cmd: "codex", args: ["exec"] });
  assert.equal(withNiceness("codex", ["exec"], 40).args[1], "19", "plafonné à 19, le maximum du noyau");
});

test("TIR RÉEL (Linux) : le process lancé porte bien la priorité, et ses enfants en héritent", { skip: process.platform !== "linux" }, () => {
  // `nice -n` est RELATIF au parent : si ce test tourne lui-même dans un process déjà poli, le rang
  // attendu part du sien. `sh -c` lance un enfant (`cut`) qui lit sa priorité, champ 19 de /proc/self/stat.
  const parent = getPriority();
  const { cmd, args } = withNiceness("sh", ["-c", "cut -d' ' -f19 /proc/self/stat"], JOB_NICENESS);
  assert.equal(Number(execFileSync(cmd, args, { encoding: "utf8" }).trim()), Math.min(parent + JOB_NICENESS, 19));
  // Contrôle négatif : sans priorité, l'enfant tourne au rang de son parent.
  const base = withNiceness("sh", ["-c", "cut -d' ' -f19 /proc/self/stat"], undefined);
  assert.equal(Number(execFileSync(base.cmd, base.args, { encoding: "utf8" }).trim()), parent);
});
