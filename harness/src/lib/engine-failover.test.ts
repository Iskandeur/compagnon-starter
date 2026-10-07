import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isQuotaError, isNetworkError, isTransientError, isAuthError, isPrepaidExhaustedError, parseRetryAfter,
  resolveActiveEngine, shouldFailover, failoverWindowUntil, afterFailoverSucceeded, afterFailoverFailed,
  afterEngineSucceeded, engineSessionKey, readFailoverState, writeFailoverState,
  NO_FAILOVER, FAILOVER_WINDOW_MS, FAILOVER_WINDOW_CAP_MS, FAILOVER_BLOCK_MS, type KeyValueStore,
} from "./engine-failover.ts";

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);

const base = {
  failedEngine: "primary",
  fallback: "secondary",
  pinned: null as string | null,
  preferred: "primary",
  state: NO_FAILOVER,
  nowMs: NOW,
  enabled: true,
};

test("classement : quota, réseau, auth, prépayé", () => {
  assert.equal(isQuotaError("You've hit your session limit · resets 3am (UTC)"), true);
  assert.equal(isQuotaError("HTTP 429 Too Many Requests"), true);
  assert.equal(isQuotaError("fetch failed"), false);
  assert.equal(isNetworkError("socket hang up"), true);
  assert.equal(isNetworkError("503 Service Unavailable"), true);
  assert.equal(isTransientError("ECONNRESET"), true);
  assert.equal(isTransientError("SyntaxError: bad prompt"), false);
  assert.equal(isAuthError("OAuth token has expired, please run /login"), true);
  assert.equal(isAuthError("401 Unauthorized"), true);
  assert.equal(isAuthError("prompt exceeds context window: token limit"), false, "faux ami");
  assert.equal(isPrepaidExhaustedError("402 Insufficient Balance"), true);
  assert.equal(isPrepaidExhaustedError("rate limit"), false);
});

test("parseRetryAfter : horloge UTC passée → demain, durée relative, timestamp, rien", () => {
  assert.equal(parseRetryAfter("resets 3pm (UTC)", NOW), Date.UTC(2026, 0, 15, 15, 0));
  assert.equal(parseRetryAfter("resets 9am (UTC)", NOW), Date.UTC(2026, 0, 16, 9, 0));
  assert.equal(parseRetryAfter("try again in 20 min", NOW), NOW + 20 * 60_000);
  assert.equal(parseRetryAfter("resets 12:24 on 17 Jan", NOW), Date.UTC(2026, 0, 17, 12, 24));
  const ts = Math.floor(NOW / 1000) + 3600;
  assert.equal(parseRetryAfter(`usage limit reached|${ts}`, NOW), ts * 1000);
  assert.equal(parseRetryAfter("quota exceeded", NOW), null);
  assert.equal(parseRetryAfter("retry-after: 99999999", NOW), null, "au-delà de l'horizon de 7 jours");
});

test("shouldFailover : quota du moteur préféré → oui ; réseau → non", () => {
  assert.equal(shouldFailover({ ...base, errorMessage: "429 rate limit" }), true);
  assert.equal(shouldFailover({ ...base, errorMessage: "ECONNRESET" }), false);
  assert.equal(shouldFailover({ ...base, errorMessage: "TypeError: x is undefined" }), false);
});

test("shouldFailover : épinglé + quota → non (il se lèvera) ; épinglé + auth morte ou solde vide → oui", () => {
  const pinned = { ...base, pinned: "primary" };
  assert.equal(shouldFailover({ ...pinned, errorMessage: "429 rate limit" }), false);
  assert.equal(shouldFailover({ ...pinned, errorMessage: "OAuth token expired" }), true);
  assert.equal(shouldFailover({ ...pinned, errorMessage: "402 Insufficient Balance" }), true);
});

test("shouldFailover : épinglé sur le secondaire, c'est lui qu'on sauve", () => {
  const p = { ...base, pinned: "secondary", failedEngine: "secondary", fallback: "primary" };
  assert.equal(shouldFailover({ ...p, errorMessage: "401 Unauthorized" }), true);
});

test("shouldFailover : l'échec du moteur de secours ne rebascule pas ; anti ping-pong ; interrupteur", () => {
  assert.equal(shouldFailover({ ...base, failedEngine: "secondary", fallback: "primary", errorMessage: "429" }), false);
  const blocked = { ...NO_FAILOVER, blockedUntilMs: NOW + 1 };
  assert.equal(shouldFailover({ ...base, state: blocked, errorMessage: "429" }), false);
  assert.equal(shouldFailover({ ...base, enabled: false, errorMessage: "429" }), false);
  assert.equal(shouldFailover({ ...base, fallback: "primary", errorMessage: "429" }), false);
});

test("resolveActiveEngine : épinglage > fenêtre de secours > préféré", () => {
  const state = { untilMs: NOW + 60_000, blockedUntilMs: 0, engine: "secondary" };
  assert.deepEqual(resolveActiveEngine({ pinned: "primary", state, preferred: "primary", nowMs: NOW }), { engine: "primary", auto: false, reason: "pinned" });
  assert.deepEqual(resolveActiveEngine({ pinned: null, state, preferred: "primary", nowMs: NOW }), { engine: "secondary", auto: true, reason: "failover" });
  assert.equal(resolveActiveEngine({ pinned: null, state, preferred: "primary", nowMs: NOW + 120_000 }).reason, "default");
});

test("fenêtre : calée sur le retour annoncé, défaut 1 h, plafonnée", () => {
  assert.equal(failoverWindowUntil("try again in 10 min", NOW), NOW + 10 * 60_000 + 5000);
  assert.equal(failoverWindowUntil("401 Unauthorized", NOW), NOW + FAILOVER_WINDOW_MS);
  assert.equal(failoverWindowUntil("resets 12:24 on 20 Jan", NOW), NOW + FAILOVER_WINDOW_CAP_MS);
});

test("transitions d'état", () => {
  const s = afterFailoverSucceeded("try again in 10 min", NOW, "secondary");
  assert.equal(s.engine, "secondary");
  assert.equal(s.blockedUntilMs, 0);
  assert.deepEqual(afterFailoverFailed(NOW), { untilMs: 0, blockedUntilMs: NOW + FAILOVER_BLOCK_MS, engine: null });
  assert.equal(afterEngineSucceeded("secondary", s, "primary"), s, "un succès du secours ne prouve rien");
  assert.equal(afterEngineSucceeded("primary", s, "primary"), NO_FAILOVER);
});

test("engineSessionKey : le préféré garde la clé historique", () => {
  assert.equal(engineSessionKey("chat-1", "primary", "primary"), "chat-1");
  assert.equal(engineSessionKey("chat-1", "secondary", "primary"), "secondary:chat-1");
});

test("persistance : aller-retour, valeurs illisibles = rien en cours", () => {
  const m = new Map<string, string>();
  const store: KeyValueStore = { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
  assert.deepEqual(readFailoverState(store), NO_FAILOVER);
  const s = { untilMs: NOW + 1, blockedUntilMs: 0, engine: "secondary" };
  writeFailoverState(store, s);
  assert.deepEqual(readFailoverState(store), s);
  m.set("engine_failover_until", "n'importe quoi");
  assert.equal(readFailoverState(store).untilMs, 0);
});
