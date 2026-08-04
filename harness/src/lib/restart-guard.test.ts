import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ackInflight,
  clearInflight,
  clearRestartPending,
  holdActiveAt,
  inflightIds,
  markRestartPending,
  parseIds,
  restartHoldActive,
  setInflight,
  RESTART_FLAG_KEY,
  RESTART_HOLD_MS,
} from "./restart-guard.ts";

/** Faux store minimal (settings + inbox en mémoire) — pas besoin d'une vraie base pour la logique
 *  pure de ce module. Sert aussi de mini simulation d'inbox pour le test de bout en bout ci-dessous. */
function fakeStore(init: Record<string, string> = {}): {
  getSetting: (k: string) => string | null;
  setSetting: (k: string, v: string) => void;
  markInboxDone: (id: number) => void;
  acked: number[];
  map: Map<string, string>;
  inbox: Map<number, { body: string; done: boolean }>;
  nextId: number;
  addInbox: (body: string) => number;
  pendingInbox: () => number[];
} {
  const map = new Map(Object.entries(init));
  const acked: number[] = [];
  const inbox = new Map<number, { body: string; done: boolean }>();
  let nextId = 1;
  return {
    map,
    acked,
    inbox,
    get nextId() {
      return nextId;
    },
    getSetting: (k) => map.get(k) ?? null,
    setSetting: (k, v) => void map.set(k, v),
    markInboxDone: (id) => {
      acked.push(id);
      const row = inbox.get(id);
      if (row) row.done = true;
    },
    addInbox: (body) => {
      const id = nextId++;
      inbox.set(id, { body, done: false });
      return id;
    },
    pendingInbox: () => [...inbox.entries()].filter(([, r]) => !r.done).map(([id]) => id),
  };
}

test("holdActiveAt : drapeau frais = actif ; absent/vide/illisible = inactif", () => {
  const now = 1_800_000_000_000;
  assert.equal(holdActiveAt(String(now - 1_000), now), true, "posé il y a 1 s → restart en cours");
  assert.equal(holdActiveAt(null, now), false);
  assert.equal(holdActiveAt("", now), false);
  assert.equal(holdActiveAt("bidule", now), false);
  assert.equal(holdActiveAt("0", now), false);
});

test("holdActiveAt : drapeau PÉRIMÉ = inactif (le restart a échoué → on reprend la main)", () => {
  const now = 1_800_000_000_000;
  assert.equal(holdActiveAt(String(now - RESTART_HOLD_MS - 1), now), false, "au-delà du TTL → on ne reste pas sourd");
  assert.equal(holdActiveAt(String(now - RESTART_HOLD_MS), now), true, "pile au TTL → encore actif");
});

test("holdActiveAt : horodatage dans le futur (horloge qui recule) → actif par prudence", () => {
  const now = 1_800_000_000_000;
  assert.equal(holdActiveAt(String(now + 5_000), now), true);
});

test("mark/clear restart pending : pose puis lève le drapeau", () => {
  const db = fakeStore();
  const now = 1_800_000_000_000;
  assert.equal(restartHoldActive(db, now), false, "au repos : aucun restart en cours");
  markRestartPending(db, now);
  assert.equal(db.map.get(RESTART_FLAG_KEY), String(now));
  assert.equal(restartHoldActive(db, now + 500), true);
  clearRestartPending(db);
  assert.equal(restartHoldActive(db, now + 500), false, "levé au boot → le daemon neuf entend de nouveau");
});

test("parseIds : JSON valide, vide, corrompu, éléments non numériques", () => {
  assert.deepEqual(parseIds("[1,2,3]"), [1, 2, 3]);
  assert.deepEqual(parseIds(""), []);
  assert.deepEqual(parseIds(null), []);
  assert.deepEqual(parseIds("{pas du json"), []);
  assert.deepEqual(parseIds('[1,"x",null,4]'), [1, 4]);
});

test("in-flight : publication par voie, lecture fusionnée, effacement", () => {
  const db = fakeStore();
  setInflight(db, "conv", [7, 8]);
  setInflight(db, "wake", [8, 9]);
  assert.deepEqual(inflightIds(db).sort((a, b) => a - b), [7, 8, 9], "dédoublonné entre les deux voies");
  setInflight(db, "conv", []);
  assert.deepEqual(inflightIds(db).sort((a, b) => a - b), [8, 9], "voie conv vidée, la voie fond subsiste");
  clearInflight(db);
  assert.deepEqual(inflightIds(db), []);
});

test("ackInflight n'acquitte QUE ce qui est en vol (le message arrivé pendant le restart survit)", () => {
  const db = fakeStore();
  setInflight(db, "conv", [10]); // le message qu'on est en train de traiter (celui qui demande le restart)
  const n = ackInflight(db);
  assert.equal(n, 1);
  assert.deepEqual(db.acked, [10], "seul l'en-vol est acquitté — rien d'autre n'est touché");
  assert.deepEqual(inflightIds(db), [], "vol clos");
  assert.equal(ackInflight(db), 0, "idempotent : plus rien à acquitter");
});

test("ackInflight scopé à une voie n'acquitte QUE cette voie — l'autre voie survit (rejeu au boot)", () => {
  const db = fakeStore();
  // La voie « wake » (fond) demande le restart PENDANT que la voie « conv » traite un message de
  // l'humain. Si on acquittait « conv », ce message serait tué sans rejeu → perdu. En scopant à
  // « wake », la voie « conv » reste intacte.
  setInflight(db, "wake", [20]); // l'en-vol de la voie qui demande le restart
  setInflight(db, "conv", [21]); // le message en cours de traitement en parallèle
  const n = ackInflight(db, ["wake"]);
  assert.equal(n, 1, "une seule voie acquittée");
  assert.deepEqual(db.acked, [20], "seul l'en-vol de « wake » est acquitté");
  assert.deepEqual(inflightIds(db), [21], "l'en-vol « conv » SURVIT → rejoué au boot, jamais perdu");
});

// —— Preuve de bout en bout : l'acquittement chirurgical ne perd rien ——
test("inbox : après un restart, seul le message EN VOL est 'done' ; l'entrant reste 'pending' (rejoué au boot)", () => {
  const db = fakeStore();
  const enVol = db.addInbox(JSON.stringify({ body: "déploie et redémarre" }));
  setInflight(db, "conv", [enVol]);
  // Un message arrive PENDANT le restart : persisté par la passerelle d'entrée, jamais traité.
  const pendantLeRestart = db.addInbox(JSON.stringify({ body: "alors ???" }));

  ackInflight(db);

  const pending = db.pendingInbox();
  assert.deepEqual(pending, [pendantLeRestart], "le message entrant est intact → rejoué et traité juste après");
  assert.ok(!pending.includes(enVol), "le message déjà traité n'est PAS rejoué (pas de doublon)");
});
