import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** Gate PIN devant le dashboard : un cookie signé HMAC, sans état serveur (pas de session store à
 *  invalider — un logout jette juste le cookie côté client). Choix délibéré d'un mécanisme simple
 *  plutôt qu'un vrai système d'auth pour ce besoin (PIN devant un service exposé par tunnel). */

export const COOKIE_NAME = "compagnon_dash_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

export const gateEnabled = () => config.accessPin.length > 0;

/** Comparaison à temps constant — évite de fuiter la longueur/le préfixe du PIN via le timing. */
export function pinMatches(candidate) {
  const expected = Buffer.from(config.accessPin);
  const given = Buffer.from(candidate);
  if (expected.length === 0) return false;
  if (expected.length !== given.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, given);
}

function sign(payload) {
  return createHmac("sha256", config.accessSessionSecret).update(payload).digest("hex");
}

export function issueToken(now = Date.now()) {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry)}`;
}

export function isValidToken(token, now = Date.now()) {
  if (!token) return false;
  const [expiry, signature] = token.split(".");
  if (!expiry || !signature) return false;
  const expected = sign(expiry);
  if (expected.length !== signature.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  const expiryMs = Number(expiry);
  return Number.isFinite(expiryMs) && expiryMs > now;
}
