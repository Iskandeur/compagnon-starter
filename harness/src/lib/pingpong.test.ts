import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideGroupWake,
  readPingPong,
  setPingPongRemaining,
  DEFAULT_MAX_TURNS,
  type PingPongState,
  type PingPongStore,
  type PingPongWriter,
} from "./pingpong.ts";

const st = (o: Partial<PingPongState> = {}): PingPongState => ({ enabled: true, maxTurns: 6, remaining: 0, ...o });

/** Faux storage en mémoire (Map) — remplace la vraie DB du daemon pour ces tests, sans dépendance. */
function fakeStore(initial: Record<string, string> = {}): PingPongStore & PingPongWriter {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getSetting: (key) => m.get(key) ?? null,
    setSetting: (key, value) => void m.set(key, value),
  };
}

test("decideGroupWake : nommé → réveil et budget rechargé au max", () => {
  const d = decideGroupWake(true, st({ remaining: 0 }));
  assert.deepEqual(d, { wake: true, remaining: 6, reason: "nommé" });
});

test("decideGroupWake : non nommé mais budget > 0 → réveil, budget -1 (le ping-pong)", () => {
  assert.deepEqual(decideGroupWake(false, st({ remaining: 3 })), { wake: true, remaining: 2, reason: "continuité" });
});

test("decideGroupWake : non nommé, budget épuisé → PAS de réveil (fin de boucle)", () => {
  assert.deepEqual(decideGroupWake(false, st({ remaining: 0 })), { wake: false, remaining: 0, reason: "budget épuisé" });
});

test("decideGroupWake : continuité off → non nommé ne réveille jamais", () => {
  assert.deepEqual(decideGroupWake(false, st({ enabled: false, remaining: 5 })), {
    wake: false,
    remaining: 5,
    reason: "continuité off",
  });
});

test("decideGroupWake : off mais nommé → réveille quand même (le nom/la mention prime)", () => {
  assert.deepEqual(decideGroupWake(true, st({ enabled: false, remaining: 0 })), { wake: true, remaining: 6, reason: "nommé" });
});

test("anti-boucle : une salve non-nommée s'éteint en maxTurns tours (le garde-fou anti ping-pong infini)", () => {
  let s = st({ remaining: 0 });
  // L'agent est nommé une fois → budget = 6.
  let d = decideGroupWake(true, s);
  s = { ...s, remaining: d.remaining };
  let wakes = 0;
  // Puis 10 messages tiers sans le renommer : il n'en traite que 6, jamais plus (plafond strict).
  for (let i = 0; i < 10; i++) {
    d = decideGroupWake(false, s);
    s = { ...s, remaining: d.remaining };
    if (d.wake) wakes++;
  }
  assert.equal(wakes, 6);
  assert.equal(s.remaining, 0);
});

test("readPingPong : défauts (rien en storage) = ON, max défaut, budget 0", () => {
  const db = fakeStore();
  assert.deepEqual(readPingPong(db), { enabled: true, maxTurns: DEFAULT_MAX_TURNS, remaining: 0 });
});

test("readPingPong : lit off / max / rem du storage ; valeurs illisibles → défauts", () => {
  const db = fakeStore();
  db.setSetting("pingpong", "off");
  db.setSetting("pingpong_max", "3");
  setPingPongRemaining(db, 2);
  assert.deepEqual(readPingPong(db), { enabled: false, maxTurns: 3, remaining: 2 });
  db.setSetting("pingpong_max", "bogus");
  assert.equal(readPingPong(db).maxTurns, DEFAULT_MAX_TURNS);
});

test("setPingPongRemaining : borne à ≥ 0 (une commande de coupure ne peut jamais rendre le budget négatif)", () => {
  const db = fakeStore();
  setPingPongRemaining(db, -5);
  assert.equal(readPingPong(db).remaining, 0);
});

test("coupure humaine explicite : /pingpong off désactive la continuité même à budget plein", () => {
  const db = fakeStore({ pingpong_rem: "6" });
  db.setSetting("pingpong", "off");
  const dec = decideGroupWake(false, readPingPong(db));
  assert.equal(dec.wake, false);
  assert.equal(dec.reason, "continuité off");
});
