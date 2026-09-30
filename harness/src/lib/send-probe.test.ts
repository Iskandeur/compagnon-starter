import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRecentOwnMessage, sendWithProbe, shouldProbe } from "./send-probe.ts";

const NOW = 1_800_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);
const mine = (body: string, atMs: number, id = "msg-1") => ({ fromMe: true, body, timestamp: sec(atMs), id: { _serialized: id } });

test("shouldProbe : 5xx oui, 4xx non", () => {
  assert.equal(shouldProbe(500), true);
  assert.equal(shouldProbe(503), true);
  assert.equal(shouldProbe(422), false);
  assert.equal(shouldProbe(404), false);
});

test("pickRecentOwnMessage : message à moi, corps identique, dans la fenêtre → id", () => {
  assert.equal(pickRecentOwnMessage([mine("salut", NOW - 5_000)], "salut", NOW, 120_000), "msg-1");
});

test("pickRecentOwnMessage : corps différent d'un caractère → null (égalité stricte)", () => {
  assert.equal(pickRecentOwnMessage([mine("salut.", NOW - 5_000)], "salut", NOW, 120_000), null);
});

test("pickRecentOwnMessage : message de l'autre personne → null", () => {
  const theirs = { ...mine("salut", NOW - 5_000), fromMe: false };
  assert.equal(pickRecentOwnMessage([theirs], "salut", NOW, 120_000), null);
});

test("pickRecentOwnMessage : trop vieux → null ; horloge du gateway en avance → toléré", () => {
  assert.equal(pickRecentOwnMessage([mine("salut", NOW - 10 * 60_000)], "salut", NOW, 120_000), null);
  assert.equal(pickRecentOwnMessage([mine("salut", NOW + 30_000)], "salut", NOW, 120_000), "msg-1");
});

test("pickRecentOwnMessage : réponse illisible → null, sans lever", () => {
  assert.equal(pickRecentOwnMessage({ error: "x" }, "salut", NOW, 120_000), null);
  assert.equal(pickRecentOwnMessage([{ fromMe: true, body: "salut" }], "salut", NOW, 120_000), null);
});

test("sendWithProbe : succès → id, sans sonder", async () => {
  let probed = false;
  const id = await sendWithProbe({ send: async () => ({ ok: true, status: 201, id: "a" }), probe: async () => { probed = true; return null; } });
  assert.equal(id, "a");
  assert.equal(probed, false);
});

test("sendWithProbe : 500 mais le message est dans le fil → id, pas d'erreur", async () => {
  const lines: string[] = [];
  const id = await sendWithProbe({
    send: async () => ({ ok: false, status: 500, errorText: "receipt lost" }),
    probe: async () => "msg-1",
    warn: (l) => lines.push(l),
  });
  assert.equal(id, "msg-1");
  assert.match(lines[0], /doublon évité/);
});

test("sendWithProbe : 500 et rien dans le fil → lève l'erreur d'origine", async () => {
  await assert.rejects(
    sendWithProbe({ send: async () => ({ ok: false, status: 500, errorText: "boom" }), probe: async () => null, warn: () => {} }),
    /envoi échoué 500 : boom/,
  );
});

test("sendWithProbe : 4xx → lève sans sonder", async () => {
  let probed = false;
  await assert.rejects(
    sendWithProbe({ send: async () => ({ ok: false, status: 422, errorText: "no session" }), probe: async () => { probed = true; return "x"; } }),
    /422/,
  );
  assert.equal(probed, false);
});

test("sendWithProbe : la sonde plante → lève l'erreur d'origine, pas celle de la sonde", async () => {
  await assert.rejects(
    sendWithProbe({ send: async () => ({ ok: false, status: 502, errorText: "gateway" }), probe: async () => { throw new Error("probe down"); }, warn: () => {} }),
    /envoi échoué 502 : gateway/,
  );
});
