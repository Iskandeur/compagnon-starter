import { test } from "node:test";
import assert from "node:assert/strict";
import { GraceCoalescer, isCoalesceable, isWaitSignal, mergeMessages, planEnqueue, type CoalesceEvent } from "./coalesce.ts";

const msg = (body: string, over: Partial<CoalesceEvent> = {}): CoalesceEvent => ({ chatId: "x@chat", body, ...over });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("isCoalesceable : texte simple = oui ; commande / vocal / réaction / image / sans chat = non", () => {
  assert.equal(isCoalesceable(msg("salut")), true);
  assert.equal(isCoalesceable(msg("/session list")), false); // commande
  assert.equal(isCoalesceable(msg("", { voice: { url: "x" } })), false);
  assert.equal(isCoalesceable(msg("ok", { reaction: { emoji: "👍" } })), false);
  assert.equal(isCoalesceable(msg("", { image: { url: "x" } })), false);
  assert.equal(isCoalesceable(msg("salut", { chatId: undefined })), false);
});

test("isWaitSignal : token seul = signal ; mêlé à du texte ou autre mot = non", () => {
  assert.equal(isWaitSignal(msg("att"), "att"), true);
  assert.equal(isWaitSignal(msg("  ATT "), "att"), true); // trim + casse
  assert.equal(isWaitSignal(msg("att je réfléchis"), "att"), false); // pas seul
  assert.equal(isWaitSignal(msg("attends"), "att"), false);
  assert.equal(isWaitSignal(msg("/att"), "att"), false); // commande → non coalescçable
});

test("mergeMessages : concatène les corps, garde les métadonnées du dernier évènement", () => {
  const merged = mergeMessages([msg("premier", { chatId: "a" }), msg("deuxieme", { chatId: "b" })]);
  assert.equal(merged.body, "premier\ndeuxieme");
  assert.equal(merged.chatId, "b", "métadonnées = dernier évènement");
});

test("planEnqueue : grâce si libre, buffer si occupé, dispatch sinon", () => {
  assert.equal(planEnqueue(msg("a"), { processing: false, graceMs: 2000 }), "grace");
  assert.equal(planEnqueue(msg("a"), { processing: true, graceMs: 2000 }), "buffer");
  assert.equal(planEnqueue(msg("a"), { processing: false, graceMs: 0 }), "dispatch");
  assert.equal(planEnqueue(msg("/x"), { processing: false, graceMs: 2000 }), "dispatch");
});

// —— Intégration GraceCoalescer : timers réels, valeurs faibles (comportement, pas juste les prédicats) ——

test("GraceCoalescer : deux messages rapprochés → UN seul traitement fusionné", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({ graceMs: 40, waitSignalToken: "att", waitSignalMs: 300, handle: async (ev) => void handled.push(ev) });
  c.enqueue(msg("premier"));
  c.enqueue(msg("deuxieme")); // dans la fenêtre
  await wait(160);
  assert.equal(handled.length, 1, "un seul traitement");
  assert.equal(handled[0].body, "premier\ndeuxieme");
});

test("GraceCoalescer : message seul → traité après la fenêtre (≈ graceMs)", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({ graceMs: 40, waitSignalToken: "att", waitSignalMs: 300, handle: async (ev) => void handled.push(ev) });
  c.enqueue(msg("solo"));
  await wait(160);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].body, "solo");
});

test("GraceCoalescer : grâce désactivée (0) → traitement immédiat, pas d'attente", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({ graceMs: 0, waitSignalToken: "att", waitSignalMs: 300, handle: async (ev) => void handled.push(ev) });
  c.enqueue(msg("direct"));
  await wait(20);
  assert.equal(handled.length, 1);
});

test("GraceCoalescer : le signal d'attente rallonge la fenêtre, sans être transmis comme contenu", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({ graceMs: 20, waitSignalToken: "att", waitSignalMs: 90, handle: async (ev) => void handled.push(ev) });
  c.enqueue(msg("att")); // signal : rallonge la fenêtre à 90ms
  c.enqueue(msg("vrai message")); // arrive dans la fenêtre étendue
  await wait(45);
  assert.equal(handled.length, 0, "toujours en attente après 45ms (le signal a rallongé au-delà des 20ms normaux)");
  await wait(90);
  assert.equal(handled.length, 1, "traité après la fenêtre étendue");
  assert.equal(handled[0].body, "vrai message", "le signal n'apparaît pas dans le contenu traité");
});

test("GraceCoalescer : signal seul, sans rien d'autre → aucun traitement déclenché", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({ graceMs: 20, waitSignalToken: "att", waitSignalMs: 50, handle: async (ev) => void handled.push(ev) });
  c.enqueue(msg("att"));
  await wait(120);
  assert.equal(handled.length, 0);
});

test("GraceCoalescer : messages arrivant PENDANT un traitement sont fusionnés au tour suivant", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({
    graceMs: 0,
    waitSignalToken: "att",
    waitSignalMs: 300,
    handle: async (ev) => {
      handled.push(ev);
      if (handled.length === 1) {
        // Pendant que le 1er traitement tourne, deux autres messages arrivent du même chat.
        c.enqueue(msg("deuxieme"));
        c.enqueue(msg("troisieme"));
        await wait(20);
      }
    },
  });
  c.enqueue(msg("premier"));
  await wait(80);
  assert.equal(handled.length, 2, "1er traitement seul, puis 2e+3e fusionnés en un seul tour suivant");
  assert.equal(handled[1].body, "deuxieme\ntroisieme");
});

test("GraceCoalescer : chats distincts ne se fusionnent jamais entre eux", async () => {
  const handled: CoalesceEvent[] = [];
  const c = new GraceCoalescer({ graceMs: 30, waitSignalToken: "att", waitSignalMs: 300, handle: async (ev) => void handled.push(ev) });
  c.enqueue(msg("bonjour", { chatId: "chat-a" }));
  c.enqueue(msg("salut", { chatId: "chat-b" }));
  await wait(100);
  assert.equal(handled.length, 2, "deux chats → deux traitements distincts");
  assert.deepEqual(handled.map((h) => h.body).sort(), ["bonjour", "salut"]);
});
