import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isManagedService,
  systemctlArgs,
  installCpArgs,
  runServiceAction,
  installService,
  type ExecLike,
} from "./service-ctl.ts";

const PREFIX = "companion-";
const HOME = "/opt/companion";

test("isManagedService : accepte <prefix><slug>, refuse tout le reste", () => {
  assert.equal(isManagedService("companion-minilupi", PREFIX), true);
  assert.equal(isManagedService("companion-telegram", PREFIX), true);
  assert.equal(isManagedService("companion", PREFIX), false, "le service principal n'est pas un sous-service");
  assert.equal(isManagedService("caddy", PREFIX), false, "jamais un service tiers/système");
  assert.equal(isManagedService("companion-../../etc", PREFIX), false, "pas de traversée de chemin");
  assert.equal(isManagedService("", PREFIX), false);
});

test("systemctlArgs : null si non géré, sinon les args exacts par verbe", () => {
  assert.equal(systemctlArgs("caddy", "restart", PREFIX), null);
  assert.deepEqual(systemctlArgs("companion-minilupi", "start", PREFIX), ["start", "companion-minilupi"]);
  assert.deepEqual(systemctlArgs("companion-minilupi", "status", PREFIX), ["status", "companion-minilupi"]);
  assert.deepEqual(systemctlArgs("companion-minilupi", "enable", PREFIX), ["enable", "--now", "companion-minilupi"]);
});

test("installCpArgs : chemins source/dest bornés au motif <prefix>*", () => {
  assert.equal(installCpArgs("caddy", PREFIX, HOME), null);
  assert.deepEqual(installCpArgs("companion-minilupi", PREFIX, HOME), [
    "/opt/companion/harness/config/companion-minilupi.service.example",
    "/etc/systemd/system/companion-minilupi.service",
  ]);
});

test("runServiceAction : service non géré → échoue SANS exécuter quoi que ce soit", async () => {
  let called = false;
  const exec: ExecLike = async () => { called = true; return { stdout: "", stderr: "" }; };
  const r = await runServiceAction("caddy", "restart", PREFIX, { exec });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /non géré/);
  assert.equal(called, false);
});

test("runServiceAction : succès → renvoie stdout", async () => {
  const exec: ExecLike = async (bin, args) => {
    assert.equal(bin, "sudo");
    assert.deepEqual(args, ["systemctl", "status", "companion-minilupi"]);
    return { stdout: "active (running)", stderr: "" };
  };
  const r = await runServiceAction("companion-minilupi", "status", PREFIX, { exec });
  assert.equal(r.ok, true);
  assert.equal(r.output, "active (running)");
});

test("runServiceAction : échec exec → ok:false, message capturé", async () => {
  const exec: ExecLike = async () => { throw new Error("sudo: a password is required"); };
  const r = await runServiceAction("companion-minilupi", "restart", PREFIX, { exec });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /password/);
});

test("installService : service non géré → aucune étape, aucun exec", async () => {
  let calls = 0;
  const exec: ExecLike = async () => { calls++; return { stdout: "", stderr: "" }; };
  const r = await installService("caddy", PREFIX, HOME, { exec });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(r.steps, []);
});

test("installService : les 3 étapes, dans l'ordre, avec les bons argv", async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const exec: ExecLike = async (bin, args) => { calls.push({ bin, args }); return { stdout: "", stderr: "" }; };
  const r = await installService("companion-minilupi", PREFIX, HOME, { exec });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps, ["cp", "daemon-reload", "enable --now"]);
  assert.deepEqual(calls, [
    { bin: "sudo", args: ["cp", "/opt/companion/harness/config/companion-minilupi.service.example", "/etc/systemd/system/companion-minilupi.service"] },
    { bin: "sudo", args: ["systemctl", "daemon-reload"] },
    { bin: "sudo", args: ["systemctl", "enable", "--now", "companion-minilupi"] },
  ]);
});

test("installService : échec au milieu → s'arrête, garde les étapes déjà faites", async () => {
  let n = 0;
  const exec: ExecLike = async () => {
    n++;
    if (n === 2) throw new Error("daemon-reload failed");
    return { stdout: "", stderr: "" };
  };
  const r = await installService("companion-minilupi", PREFIX, HOME, { exec });
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps, ["cp"]);
  assert.match(r.error ?? "", /daemon-reload failed/);
  assert.equal(n, 2, "la 3e étape (enable --now) ne doit jamais tourner après l'échec");
});
