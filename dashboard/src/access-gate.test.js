import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { gateEnabled, isValidToken, issueToken, pinMatches } from "./access-gate.js";

test("gateEnabled is false when ACCESS_PIN is unset (default)", () => {
  assert.equal(config.accessPin, "");
  assert.equal(gateEnabled(), false);
});

test("pinMatches rejects when no PIN is configured", () => {
  assert.equal(pinMatches("anything"), false);
  assert.equal(pinMatches(""), false);
});

test("pinMatches / issueToken / isValidToken round-trip once a PIN is configured", () => {
  config.accessPin = "1234";
  try {
    assert.equal(gateEnabled(), true);
    assert.equal(pinMatches("1234"), true);
    assert.equal(pinMatches("0000"), false);
    assert.equal(pinMatches("12345"), false); // mauvaise longueur

    const token = issueToken(1_000_000);
    assert.equal(isValidToken(token, 1_000_000), true);
    assert.equal(isValidToken(token, 1_000_000 + 1000), true); // encore dans le TTL
  } finally {
    config.accessPin = "";
  }
});

test("isValidToken rejette un token manquant, malformé, trafiqué ou expiré", () => {
  config.accessPin = "1234";
  try {
    const token = issueToken(1_000_000);
    const [expiry] = token.split(".");

    assert.equal(isValidToken(undefined), false);
    assert.equal(isValidToken(""), false);
    assert.equal(isValidToken("not-a-token"), false);
    assert.equal(isValidToken(`${expiry}.deadbeef`), false); // mauvaise signature
    assert.equal(isValidToken(token, Number(expiry) + 1), false); // après expiration
  } finally {
    config.accessPin = "";
  }
});
