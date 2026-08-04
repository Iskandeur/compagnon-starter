import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRouterPrompt,
  parseRouterDecision,
  routeEngineOpts,
  readPins,
  shortModel,
  pinSourceLabel,
  engineHeader,
  engineHeaderHint,
  raiseModel,
  raiseEffort,
  readRouterContext,
  readRatchet,
  ROUTER_RATCHET_WINDOW_MS_DEFAULT,
  type EngineOptions,
  type RouteDecision,
  type RouterStore,
  type RouterTurn,
} from "./router.ts";

/** Faux store minimal (settings en mémoire) — même esprit que dans restart-guard.test.ts : pas
 *  besoin d'une vraie base pour la logique pure de ce module. */
function fakeStore(init: Record<string, string> = {}): RouterStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getSetting: (k) => map.get(k) ?? null,
    setSetting: (k, v) => void map.set(k, v),
  };
}

const base: EngineOptions = { bin: "claude", model: "claude-opus-4-1" };
const fixed = (d: RouteDecision | null) => () => Promise.resolve(d);

test("buildRouterPrompt : inclut le contexte et exige du JSON", () => {
  const p = buildRouterPrompt("salut ça va ?");
  assert.match(p, /salut ça va \?/);
  assert.match(p, /JSON/);
});

test("parseRouterDecision : JSON propre → décision", () => {
  const d = parseRouterDecision('{"model":"claude-haiku-4-5","effort":"low","reason":"salutation"}');
  assert.deepEqual(d, { model: "claude-haiku-4-5", effort: "low", reason: "salutation" });
});

test("parseRouterDecision : JSON noyé dans du texte → extrait quand même", () => {
  const d = parseRouterDecision('Voici mon choix : {"model":"claude-opus-4-1","effort":"high"} voilà.');
  assert.equal(d?.model, "claude-opus-4-1");
  assert.equal(d?.effort, "high");
});

test("parseRouterDecision : modèle hors allowlist → null", () => {
  assert.equal(parseRouterDecision('{"model":"gpt-4","effort":"low"}'), null);
});

test("parseRouterDecision : effort inconnu → null", () => {
  assert.equal(parseRouterDecision('{"model":"claude-sonnet-5","effort":"turbo"}'), null);
});

test("parseRouterDecision : champ manquant / illisible → null", () => {
  assert.equal(parseRouterDecision('{"model":"claude-sonnet-5"}'), null);
  assert.equal(parseRouterDecision("pas de json ici"), null);
  assert.equal(parseRouterDecision('{cassé'), null);
});

test("routeEngineOpts : mode auto + décision → applique modèle+effort du routeur", async () => {
  const store = fakeStore();
  const { opts, decision } = await routeEngineOpts(store, base, "analyse ce code stp", {
    classify: fixed({ model: "claude-opus-4-1", effort: "high", reason: "code" }),
    nowMs: 1,
  });
  assert.equal(opts.model, "claude-opus-4-1");
  assert.equal(opts.effort, "high");
  assert.equal(decision?.reason, "code");
});

test("routeEngineOpts : routeur indispo (null) → repli sur le défaut (comportement sans routeur)", async () => {
  const store = fakeStore();
  const { opts, decision } = await routeEngineOpts(store, base, "coucou", { classify: fixed(null) });
  assert.equal(opts.model, "claude-opus-4-1"); // défaut base
  assert.equal(opts.effort, undefined); // auto → pas de valeur forcée
  assert.equal(decision, null);
});

test("routeEngineOpts : /model fixé à la main PRIME sur le routeur", async () => {
  const store = fakeStore();
  store.setSetting("model", "claude-sonnet-5");
  const { opts } = await routeEngineOpts(store, base, "salut", {
    classify: fixed({ model: "claude-haiku-4-5", effort: "low" }),
    nowMs: 1,
  });
  assert.equal(opts.model, "claude-sonnet-5"); // pin respecté
  assert.equal(opts.effort, "low"); // effort resté auto → routé
});

test("routeEngineOpts : /model ET /effort fixés → aucun appel au routeur", async () => {
  const store = fakeStore();
  store.setSetting("model", "claude-sonnet-5");
  store.setSetting("effort", "xhigh");
  let called = false;
  const { opts, decision } = await routeEngineOpts(store, base, "peu importe", {
    classify: () => {
      called = true;
      return Promise.resolve({ model: "claude-haiku-4-5", effort: "low" });
    },
  });
  assert.equal(called, false);
  assert.equal(opts.model, "claude-sonnet-5");
  assert.equal(opts.effort, "xhigh");
  assert.equal(decision, null);
});

test("routeEngineOpts : effort=auto explicite est traité comme non-fixé (routé)", async () => {
  const store = fakeStore();
  store.setSetting("effort", "auto");
  const { opts } = await routeEngineOpts(store, base, "hello", {
    classify: fixed({ model: "claude-haiku-4-5", effort: "low" }),
    nowMs: 1,
  });
  assert.equal(opts.effort, "low");
  assert.equal(opts.model, "claude-haiku-4-5");
});

test("raiseModel : relève au plancher si en dessous, ne redescend jamais", () => {
  assert.equal(raiseModel("claude-haiku-4-5", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(raiseModel("claude-opus-4-1", "claude-sonnet-5"), "claude-opus-4-1"); // déjà au-dessus
  assert.equal(raiseModel("claude-sonnet-5", "claude-sonnet-5"), "claude-sonnet-5"); // égal
});

test("raiseModel : id de modèle inconnu de la table → jamais touché (fail open, pas fail-downgrade)", () => {
  assert.equal(raiseModel("claude-futur-modele-inedit", "claude-sonnet-5"), "claude-futur-modele-inedit");
});

test("raiseEffort : relève au plancher, absent (auto) traité comme en dessous de tout", () => {
  assert.equal(raiseEffort("low", "medium"), "medium");
  assert.equal(raiseEffort("high", "medium"), "high"); // déjà au-dessus
  assert.equal(raiseEffort(undefined, "medium"), "medium");
});

test("routeEngineOpts : floor relève une décision routée sous le plancher explicite", async () => {
  const store = fakeStore();
  const { opts } = await routeEngineOpts(
    store,
    base,
    "ok",
    { classify: fixed({ model: "claude-haiku-4-5", effort: "low", reason: "trivial" }), nowMs: 1 },
    undefined,
    { model: "claude-sonnet-5", effort: "medium" },
  );
  assert.equal(opts.model, "claude-sonnet-5");
  assert.equal(opts.effort, "medium");
});

test("routeEngineOpts : floor ne redescend jamais une décision déjà au-dessus", async () => {
  const store = fakeStore();
  const { opts } = await routeEngineOpts(
    store,
    base,
    "audit ce code",
    { classify: fixed({ model: "claude-opus-4-1", effort: "high" }), nowMs: 1 },
    undefined,
    { model: "claude-sonnet-5", effort: "medium" },
  );
  assert.equal(opts.model, "claude-opus-4-1");
  assert.equal(opts.effort, "high");
});

test("routeEngineOpts : floor n'écrase jamais un champ épinglé à la main", async () => {
  const store = fakeStore();
  store.setSetting("model", "claude-haiku-4-5"); // l'humain a fixé le modèle léger exprès
  const { opts } = await routeEngineOpts(
    store,
    base,
    "ok",
    { classify: fixed({ model: "claude-haiku-4-5", effort: "low" }), nowMs: 1 },
    undefined,
    { model: "claude-sonnet-5", effort: "medium" },
  );
  assert.equal(opts.model, "claude-haiku-4-5"); // pin respecté malgré le plancher
  assert.equal(opts.effort, "medium"); // effort non épinglé → plancher s'applique
});

test("routeEngineOpts : floor s'applique aussi au repli (routeur indispo)", async () => {
  const store = fakeStore();
  const lowBase = { ...base, model: "claude-haiku-4-5" }; // défaut config = tier bas
  const { opts, decision } = await routeEngineOpts(
    store,
    lowBase,
    "coucou",
    { classify: fixed(null) },
    undefined,
    { model: "claude-sonnet-5", effort: "medium" },
  );
  assert.equal(decision, null);
  assert.equal(opts.model, "claude-sonnet-5"); // repli relevé par le plancher malgré routeur indispo
  assert.equal(opts.effort, "medium");
});

test("readPins : sentinelles vide/auto = non épinglé ; valeur ≠ auto = épinglé", () => {
  const store = fakeStore();
  assert.deepEqual(readPins(store), { modelPinned: false, effortPinned: false }); // défaut
  store.setSetting("effort", "auto");
  assert.deepEqual(readPins(store), { modelPinned: false, effortPinned: false }); // auto ≠ épinglé
  store.setSetting("model", "claude-opus-4-1");
  store.setSetting("effort", "xhigh");
  assert.deepEqual(readPins(store), { modelPinned: true, effortPinned: true });
  store.setSetting("model", ""); // /model auto
  assert.deepEqual(readPins(store), { modelPinned: false, effortPinned: true });
});

test("shortModel : ids connus → libellé court, inconnu → brut, vide → défaut", () => {
  assert.equal(shortModel("claude-opus-4-1"), "opus");
  assert.equal(shortModel("claude-haiku-4-5"), "haiku");
  assert.equal(shortModel("un-modele-exotique"), "un-modele-exotique");
  assert.equal(shortModel(""), "défaut");
  assert.equal(shortModel(null), "défaut");
});

test("pinSourceLabel : routeur / épinglé / mixte", () => {
  assert.equal(pinSourceLabel({ modelPinned: false, effortPinned: false }), "routeur");
  assert.equal(pinSourceLabel({ modelPinned: true, effortPinned: true }), "épinglé");
  assert.equal(pinSourceLabel({ modelPinned: true, effortPinned: false }), "mixte");
  assert.equal(pinSourceLabel({ modelPinned: false, effortPinned: true }), "mixte");
});

test("engineHeader : entête ⊙ modèle/effort · source (effort auto si absent)", () => {
  assert.equal(engineHeader("claude-opus-4-1", "xhigh", { modelPinned: false, effortPinned: false }), "⊙ opus/xhigh · routeur");
  assert.equal(engineHeader("claude-sonnet-5", undefined, { modelPinned: true, effortPinned: true }), "⊙ sonnet/auto · épinglé");
  assert.equal(engineHeader(null, "auto", { modelPinned: false, effortPinned: false }), "⊙ défaut/auto · routeur");
});

test("engineHeaderHint : contient l'entête + l'instruction de le mettre en tête", () => {
  const h = engineHeaderHint("claude-haiku-4-5", "low", { modelPinned: false, effortPinned: false });
  assert.match(h, /⊙ haiku\/low · routeur/);
  assert.match(h, /Commence ta réponse/);
});

test("routeEngineOpts : persiste la dernière décision (transparence /status)", async () => {
  const store = fakeStore();
  await routeEngineOpts(store, base, "ça marche ?", {
    classify: fixed({ model: "claude-sonnet-5", effort: "medium", reason: "question courte" }),
    nowMs: 42,
  });
  const last = JSON.parse(store.getSetting("router_last") || "{}");
  assert.equal(last.model, "claude-sonnet-5");
  assert.equal(last.effort, "medium");
  assert.equal(last.reason, "question courte");
  assert.equal(last.at, 42);
});

// ——— Routeur conscient du CONTEXTE (buffer roulant) ———

test("buildRouterPrompt : sans historique → inchangé (compat stricte)", () => {
  const p = buildRouterPrompt("salut ça va ?");
  assert.doesNotMatch(p, /Historique/);
});

test("buildRouterPrompt : avec historique → les tours précédents apparaissent avant le MESSAGE", () => {
  const history: RouterTurn[] = [
    { text: "corrige le bug dans router.ts", at: 1 },
    { text: "audit tout le fichier stp", at: 2 },
  ];
  const p = buildRouterPrompt("vas-y", history);
  assert.match(p, /corrige le bug dans router\.ts/);
  assert.match(p, /audit tout le fichier stp/);
  assert.match(p, /MESSAGE :\nvas-y/);
});

test("routeEngineOpts : accumule un buffer roulant par scope, transmis au classificateur au tour suivant", async () => {
  const store = fakeStore();
  await routeEngineOpts(store, base, "premier message, plutôt complexe", {
    classify: fixed({ model: "claude-opus-4-1", effort: "high" }),
    nowMs: 1,
  });
  let received: RouterTurn[] | undefined;
  await routeEngineOpts(store, base, "vas-y", {
    classify: (_ctx, o) => {
      received = o.history;
      return Promise.resolve({ model: "claude-haiku-4-5", effort: "low" });
    },
    nowMs: 2,
  });
  assert.ok(received?.some((t) => t.text.includes("premier message, plutôt complexe")));
  // Le buffer lui-même contient bien les deux tours désormais (pour le suivant).
  const stored = readRouterContext(store);
  assert.equal(stored.length, 2);
  assert.equal(stored[1].text, "vas-y");
});

test("routeEngineOpts : le buffer de contexte est borné (les plus vieux tours tombent)", async () => {
  const store = fakeStore();
  for (let i = 0; i < 5; i++) {
    await routeEngineOpts(store, base, `message ${i}`, { classify: fixed({ model: "claude-sonnet-5", effort: "medium" }), nowMs: i });
  }
  const stored = readRouterContext(store);
  assert.equal(stored.length, 3); // ROUTER_CTX_TURNS
  assert.deepEqual(
    stored.map((t) => t.text),
    ["message 2", "message 3", "message 4"],
  );
});

test("routeEngineOpts : le buffer de contexte est ISOLÉ par scope (un canal/interlocuteur ne voit pas l'autre)", async () => {
  const store = fakeStore();
  await routeEngineOpts(store, base, "message canal A", { classify: fixed({ model: "claude-sonnet-5", effort: "medium" }), nowMs: 1 }, "canal-a");
  await routeEngineOpts(store, base, "message par défaut", { classify: fixed({ model: "claude-sonnet-5", effort: "medium" }), nowMs: 1 });
  assert.deepEqual(
    readRouterContext(store, "canal-a").map((t) => t.text),
    ["message canal A"],
  );
  assert.deepEqual(
    readRouterContext(store).map((t) => t.text),
    ["message par défaut"],
  );
});

// ——— Cliquet de gamme (ratchet) ———

test("routeEngineOpts : un « vas-y » trivial en plein fil complexe reste sur le modèle monté (cliquet)", async () => {
  const store = fakeStore();
  // Tour 1 : message complexe → le routeur monte à opus/high, le cliquet se pose.
  const t1 = await routeEngineOpts(store, base, "audit tout ce fichier et corrige les failles", {
    classify: fixed({ model: "claude-opus-4-1", effort: "high", reason: "code complexe" }),
    nowMs: 0,
  });
  assert.equal(t1.opts.model, "claude-opus-4-1");
  assert.equal(t1.opts.effort, "high");
  // Tour 2, 5 min plus tard : « vas-y » — vu isolément le routeur classerait haiku/low (simulé ici),
  // mais le cliquet (fenêtre d'inactivité 45 min pas écoulée) relève au plancher posé au tour 1.
  const t2 = await routeEngineOpts(store, base, "vas-y", {
    classify: fixed({ model: "claude-haiku-4-5", effort: "low", reason: "trivial isolé" }),
    nowMs: 5 * 60_000,
  });
  assert.equal(t2.opts.model, "claude-opus-4-1"); // ne redescend PAS
  assert.equal(t2.opts.effort, "high");
});

test("routeEngineOpts : le cliquet expire après la fenêtre d'inactivité", async () => {
  const store = fakeStore();
  await routeEngineOpts(store, base, "audit tout ce fichier", {
    classify: fixed({ model: "claude-opus-4-1", effort: "high" }),
    nowMs: 0,
    ratchetWindowMs: 1000,
  });
  const t2 = await routeEngineOpts(store, base, "vas-y", {
    classify: fixed({ model: "claude-haiku-4-5", effort: "low" }),
    nowMs: 5000, // > 1000ms d'inactivité → cliquet retombé
    ratchetWindowMs: 1000,
  });
  assert.equal(t2.opts.model, "claude-haiku-4-5");
  assert.equal(t2.opts.effort, "low");
});

test("routeEngineOpts : un pin manuel qui monte pose AUSSI le cliquet (pas que le routeur)", async () => {
  const store = fakeStore();
  store.setSetting("model", "claude-opus-4-1");
  store.setSetting("effort", "high");
  let called = false;
  await routeEngineOpts(store, base, "peu importe", {
    classify: () => {
      called = true;
      return Promise.resolve(null);
    },
    nowMs: 0,
  });
  assert.equal(called, false); // pins complets → pas d'appel de classification, comportement inchangé
  const r = readRatchet(store, undefined, 1, ROUTER_RATCHET_WINDOW_MS_DEFAULT);
  assert.deepEqual(r, { model: "claude-opus-4-1", effort: "high" });
});

test("routeEngineOpts : un /model manuel prime sur le cliquet, qui reprend après /unpin", async () => {
  const store = fakeStore();
  await routeEngineOpts(store, base, "audit tout ce fichier", { classify: fixed({ model: "claude-opus-4-1", effort: "high" }), nowMs: 0 });
  store.setSetting("model", "claude-haiku-4-5"); // l'humain force le modèle léger pour un message
  const pinned = await routeEngineOpts(store, base, "juste un test", {
    classify: fixed({ model: "claude-sonnet-5", effort: "medium" }),
    nowMs: 1,
  });
  assert.equal(pinned.opts.model, "claude-haiku-4-5"); // pin respecté malgré le cliquet
  store.setSetting("model", ""); // /model auto (unpin)
  const t3 = await routeEngineOpts(store, base, "vas-y", {
    classify: fixed({ model: "claude-haiku-4-5", effort: "low" }),
    nowMs: 2,
  });
  assert.equal(t3.opts.model, "claude-opus-4-1"); // le cliquet posé au tour 1 est toujours là
  assert.equal(t3.opts.effort, "high");
});

test("routeEngineOpts : le cliquet monte mais ne redescend jamais tant que la fenêtre est active", async () => {
  const store = fakeStore();
  await routeEngineOpts(store, base, "petit message", { classify: fixed({ model: "claude-sonnet-5", effort: "medium" }), nowMs: 0 });
  await routeEngineOpts(store, base, "gros chantier", { classify: fixed({ model: "claude-opus-4-1", effort: "high" }), nowMs: 1 });
  const t3 = await routeEngineOpts(store, base, "et un petit ok", { classify: fixed({ model: "claude-haiku-4-5", effort: "low" }), nowMs: 2 });
  assert.equal(t3.opts.model, "claude-opus-4-1"); // relevé par le 2e tour, ne redescend pas au 3e
});
