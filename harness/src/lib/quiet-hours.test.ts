import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseQuietHours,
  inQuietHours,
  effectiveConcurrency,
  describeQuietHours,
  localMinutes,
  DEFAULT_QUIET_TZ,
  QUIET_CONCURRENCY,
} from "./quiet-hours.ts";

test("parseQuietHours : forme simple, zone par défaut, zone nommée", () => {
  assert.deepEqual(parseQuietHours("08:00-20:00"), { startMin: 480, endMin: 1200, tz: DEFAULT_QUIET_TZ });
  assert.deepEqual(parseQuietHours("  8:30 - 19:45  "), { startMin: 510, endMin: 1185, tz: DEFAULT_QUIET_TZ });
  assert.deepEqual(parseQuietHours("08:00-20:00", "America/New_York"), { startMin: 480, endMin: 1200, tz: "America/New_York" });
  assert.deepEqual(parseQuietHours("22:00-06:00 Asia/Tokyo"), { startMin: 1320, endMin: 360, tz: "Asia/Tokyo" });
});

test("parseQuietHours : réglage absent ou mal tapé → null (pas de bridage, pas de crash)", () => {
  for (const bad of [null, undefined, "", "   ", "08h-20h", "8-20", "25:00-26:00", "08:70-20:00", "08:00-08:00"]) {
    assert.equal(parseQuietHours(bad), null, `attendu null pour ${JSON.stringify(bad)}`);
  }
});

/**
 * Le test du fuseau. Les paires ci-dessous partagent la même heure UTC et tombent de part et
 * d'autre de la plage selon la saison (Europe/Paris : UTC+2 l'été, UTC+1 l'hiver) :
 *   06:30 UTC → 08:30 locale l'été (calme), 07:30 l'hiver (pas calme)
 *   18:30 UTC → 20:30 locale l'été (pas calme), 19:30 l'hiver (calme)
 * Une comparaison UTC nue, ou un offset figé, rend le même verdict aux deux saisons : il échoue.
 */
test("inQuietHours : plage en heure LOCALE, heure d'été comprise", () => {
  const spec = parseQuietHours("08:00-20:00 Europe/Paris");
  const eteMatin = Date.parse("2026-07-15T06:30:00Z");
  const hiverMatin = Date.parse("2026-01-15T06:30:00Z");
  const eteSoir = Date.parse("2026-07-15T18:30:00Z");
  const hiverSoir = Date.parse("2026-01-15T18:30:00Z");
  assert.equal(inQuietHours(spec, eteMatin), true);
  assert.equal(inQuietHours(spec, hiverMatin), false);
  assert.equal(inQuietHours(spec, eteSoir), false);
  assert.equal(inQuietHours(spec, hiverSoir), true);
});

test("localMinutes : Intl résout la zone, pas un offset", () => {
  assert.equal(localMinutes(Date.parse("2026-07-15T06:30:00Z"), "Europe/Paris"), 8 * 60 + 30);
  assert.equal(localMinutes(Date.parse("2026-01-15T06:30:00Z"), "Europe/Paris"), 7 * 60 + 30);
  assert.equal(localMinutes(Date.parse("2026-07-15T06:30:00Z"), "UTC"), 6 * 60 + 30);
});

test("inQuietHours : début inclus, fin exclue", () => {
  const spec = parseQuietHours("08:00-20:00 UTC");
  assert.equal(inQuietHours(spec, Date.parse("2026-07-15T08:00:00Z")), true);
  assert.equal(inQuietHours(spec, Date.parse("2026-07-15T19:59:00Z")), true);
  assert.equal(inQuietHours(spec, Date.parse("2026-07-15T20:00:00Z")), false);
});

test("inQuietHours : plage à cheval sur minuit", () => {
  const spec = parseQuietHours("22:00-06:00 UTC");
  assert.equal(inQuietHours(spec, Date.parse("2026-07-15T23:00:00Z")), true);
  assert.equal(inQuietHours(spec, Date.parse("2026-07-15T04:00:00Z")), true);
  assert.equal(inQuietHours(spec, Date.parse("2026-07-15T12:00:00Z")), false);
});

test("inQuietHours : sans réglage jamais calme ; zone inconnue → pas de bridage (fail-open)", () => {
  assert.equal(inQuietHours(null, Date.now()), false);
  assert.equal(inQuietHours(parseQuietHours("08:00-20:00 Mars/Olympus"), Date.parse("2026-07-15T10:00:00Z")), false);
});

test("effectiveConcurrency : 1 dans la plage, la base en dehors, jamais au-dessus de la base", () => {
  const jour = Date.parse("2026-07-15T12:00:00Z");
  const nuit = Date.parse("2026-07-15T03:00:00Z");
  assert.equal(effectiveConcurrency("08:00-20:00", 5, jour), QUIET_CONCURRENCY);
  assert.equal(effectiveConcurrency("08:00-20:00", 5, nuit), 5);
  assert.equal(effectiveConcurrency(null, 5, jour), 5);
  assert.equal(effectiveConcurrency("08:00-20:00", 1, jour), 1);
  // La zone par défaut de l'appelant décale la plage : 12:00 UTC = 21:00 à Tokyo, hors plage.
  assert.equal(effectiveConcurrency("08:00-20:00", 5, jour, "Asia/Tokyo"), 5);
});

test("describeQuietHours : lisible", () => {
  assert.equal(describeQuietHours("8:00-20:00 Europe/Paris"), "08:00–20:00 (Europe/Paris) → concurrence 1");
  assert.match(describeQuietHours(null), /aucune/);
  // Zone inconnue : inQuietHours ne bride pas, le rendu ne doit pas prétendre le contraire.
  assert.match(describeQuietHours("08:00-20:00 Mars/Olympus"), /^aucune \(zone inconnue/);
});
