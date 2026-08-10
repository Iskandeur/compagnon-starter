import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateStaleWahaReplay, isStaleReplay, type WahaEvent } from "./waha-stale-replay.ts";

const WINDOW = 30 * 60_000;

test("isStaleReplay : message reçu peu après son envoi → pas suspect", () => {
  const ev: WahaEvent = { source: "whatsapp", ts: 1_000_000 + 5_000, msgTs: 1_000_000, body: "salut" };
  assert.equal(isStaleReplay(ev, WINDOW), false);
});

test("isStaleReplay : rejeu vieux de plusieurs jours → suspect", () => {
  const threeDays = 3 * 24 * 3600_000;
  const ev: WahaEvent = { source: "whatsapp", ts: 1_000_000 + threeDays, msgTs: 1_000_000, body: "salut" };
  assert.equal(isStaleReplay(ev, WINDOW), true);
});

test("isStaleReplay : sans msgTs connu → laisse passer (best-effort)", () => {
  const ev: WahaEvent = { source: "whatsapp", ts: 9_999_999, body: "salut" };
  assert.equal(isStaleReplay(ev, WINDOW), false);
});

test("annotateStaleWahaReplay : message frais → inchangé", () => {
  const ev: WahaEvent = { source: "whatsapp", ts: 1_000_000 + 5_000, msgTs: 1_000_000, body: "salut" };
  assert.equal(annotateStaleWahaReplay(ev, WINDOW), ev);
});

test("annotateStaleWahaReplay : rejeu → corps préfixé, évènement non muté", () => {
  const threeDays = 3 * 24 * 3600_000;
  const ev: WahaEvent = { source: "whatsapp", ts: 1_000_000 + threeDays, msgTs: 1_000_000, body: "quel serait le meilleur vœu" };
  const got = annotateStaleWahaReplay(ev, WINDOW);
  assert.match(got.body, /^\[⚠️ MESSAGE POTENTIELLEMENT PÉRIMÉ/);
  assert.match(got.body, /quel serait le meilleur vœu/);
  assert.equal(ev.body, "quel serait le meilleur vœu", "l'évènement durable n'est pas muté");
});

test("annotateStaleWahaReplay : source non-whatsapp → jamais annoté", () => {
  const ev: WahaEvent = { source: "wake", ts: 9_999_999, body: "[tâche]" };
  assert.equal(annotateStaleWahaReplay(ev, WINDOW), ev);
});
