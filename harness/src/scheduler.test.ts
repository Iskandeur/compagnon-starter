import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openWakeStore,
  processDueWakes,
  maxWakesPerDay,
  DEFAULT_MAX_WAKES_PER_DAY,
  type WakeEvent,
} from "./scheduler.ts";

function collector(): { events: WakeEvent[]; onEvent: (ev: WakeEvent) => void } {
  const events: WakeEvent[] = [];
  return { events, onEvent: (ev) => events.push(ev) };
}

test("store : addWake/listPending/cancelWake — cycle de base", () => {
  const store = openWakeStore(":memory:");
  const id = store.addWake(1000, "vérifier X");
  assert.equal(store.listPending().length, 1);
  assert.equal(store.listPending()[0].intent, "vérifier X");
  assert.equal(store.cancelWake(id), true);
  assert.equal(store.listPending().length, 0);
  assert.equal(store.cancelWake(id), false, "un réveil déjà annulé ne se réannule pas");
  store.close();
});

test("wake unique dû, sous le budget → déclenché puis clos", () => {
  const store = openWakeStore(":memory:");
  const id = store.addWake(1000, "rappel unique");
  const { events, onEvent } = collector();

  processDueWakes(store, onEvent, 1500, 10);

  assert.equal(events.length, 1);
  assert.equal(events[0].id, id);
  assert.equal(events[0].intent, "rappel unique");
  assert.equal(store.listPending().length, 0, "le réveil unique est clos après déclenchement");
  store.close();
});

test("wake récurrent dû → déclenché ET réarmé à la prochaine échéance", () => {
  const store = openWakeStore(":memory:");
  const id = store.addWake(1000, "check-in", 2000);
  const { events, onEvent } = collector();

  processDueWakes(store, onEvent, 1500, 10);

  assert.equal(events.length, 1);
  const pending = store.listPending().find((w) => w.id === id);
  assert.ok(pending, "le réveil récurrent reste pending");
  assert.equal(pending?.due_at, 1000 + 2000);
  store.close();
});

test("wake non dû → ignoré, aucun évènement", () => {
  const store = openWakeStore(":memory:");
  store.addWake(5000, "plus tard");
  const { events, onEvent } = collector();

  processDueWakes(store, onEvent, 1500, 10);

  assert.equal(events.length, 0);
  store.close();
});

test("budget de sobriété atteint → réveil unique sauté, reste pending (retenté plus tard)", () => {
  const store = openWakeStore(":memory:");
  // Sature le budget à coup de fires déjà enregistrés (récents, donc dans la fenêtre de 24h).
  const decoy = store.addWake(0, "décoy");
  store.recordFire(decoy, 100);
  store.recordFire(decoy, 200);

  const id = store.addWake(1000, "rappel unique");
  const { events, onEvent } = collector();

  processDueWakes(store, onEvent, 1500, 2); // budget = 2, déjà 2 fires récents

  assert.equal(events.length, 0, "budget plein → aucun réveil ne se déclenche");
  const pending = store.listPending().find((w) => w.id === id);
  assert.ok(pending, "réveil unique sauté pour budget : reste pending, PAS perdu");
  store.close();
});

test("budget de sobriété atteint → réveil récurrent sauté mais réarmé quand même (pas de rafale)", () => {
  const store = openWakeStore(":memory:");
  const decoy = store.addWake(0, "décoy");
  store.recordFire(decoy, 100);
  store.recordFire(decoy, 200);

  const id = store.addWake(1000, "veille récurrente", 2000);
  const { events, onEvent } = collector();

  processDueWakes(store, onEvent, 1500, 2);

  assert.equal(events.length, 0);
  const pending = store.listPending().find((w) => w.id === id);
  assert.ok(pending);
  assert.equal(pending?.due_at, 1000 + 2000, "réarmé même sans avoir tiré, pour ne pas re-tester à chaque tick");
  store.close();
});

test("fenêtre glissante de 24h : un fire trop ancien ne compte plus dans le budget", () => {
  const store = openWakeStore(":memory:");
  // due_at loin dans le futur : ce décoy ne doit JAMAIS être lui-même "dû" pendant ce test — seul
  // son fire enregistré manuellement sert à peupler la fenêtre de budget.
  const decoy = store.addWake(Number.MAX_SAFE_INTEGER, "décoy");
  store.recordFire(decoy, 0); // sera hors fenêtre au moment du test ci-dessous

  const id = store.addWake(1000, "rappel");
  const { events, onEvent } = collector();
  const DAY_MS = 24 * 60 * 60 * 1000;

  processDueWakes(store, onEvent, DAY_MS + 2000, 1);

  assert.equal(events.length, 1, "le fire ancien est hors fenêtre → budget de nouveau disponible");
  assert.equal(store.listPending().find((w) => w.id === id), undefined, "le réveil unique déclenché est clos");
  store.close();
});

test("maxWakesPerDay : lit MAX_WAKES_PER_DAY, retombe sur le défaut si absent/invalide", () => {
  const original = process.env.MAX_WAKES_PER_DAY;
  try {
    delete process.env.MAX_WAKES_PER_DAY;
    assert.equal(maxWakesPerDay(), DEFAULT_MAX_WAKES_PER_DAY);
    process.env.MAX_WAKES_PER_DAY = "5";
    assert.equal(maxWakesPerDay(), 5);
    process.env.MAX_WAKES_PER_DAY = "abc";
    assert.equal(maxWakesPerDay(), DEFAULT_MAX_WAKES_PER_DAY);
  } finally {
    if (original === undefined) delete process.env.MAX_WAKES_PER_DAY;
    else process.env.MAX_WAKES_PER_DAY = original;
  }
});
