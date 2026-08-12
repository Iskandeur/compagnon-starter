import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthUrl,
  parseTokenResponse,
  googleOAuthCredentials,
  exchangeCodeForTokens,
  refreshAccessToken,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_OAUTH_LOOPBACK_REDIRECT_URI,
} from "./google-oauth.ts";

const EXAMPLE_SCOPE = "https://www.googleapis.com/auth/tasks";

// ————— buildAuthUrl —————

test("buildAuthUrl : compose l'URL Google avec client_id, scope(s), et le redirect loopback par défaut", () => {
  const url = buildAuthUrl({ clientId: "abc.apps.googleusercontent.com", scopes: [EXAMPLE_SCOPE] });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, GOOGLE_AUTH_URL);
  assert.equal(parsed.searchParams.get("client_id"), "abc.apps.googleusercontent.com");
  assert.equal(parsed.searchParams.get("redirect_uri"), GOOGLE_OAUTH_LOOPBACK_REDIRECT_URI);
  assert.equal(parsed.searchParams.get("scope"), EXAMPLE_SCOPE);
  assert.equal(parsed.searchParams.get("response_type"), "code");
});

test("buildAuthUrl : access_type=offline + prompt=consent (sinon pas de refresh_token renvoyé)", () => {
  const url = buildAuthUrl({ clientId: "x", scopes: [EXAMPLE_SCOPE] });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("access_type"), "offline");
  assert.equal(parsed.searchParams.get("prompt"), "consent");
});

test("buildAuthUrl : plusieurs scopes joints par un espace", () => {
  const url = buildAuthUrl({ clientId: "x", scopes: ["scope-a", "scope-b"] });
  assert.equal(new URL(url).searchParams.get("scope"), "scope-a scope-b");
});

test("buildAuthUrl : redirectUri explicite écrase le loopback par défaut", () => {
  const url = buildAuthUrl({ clientId: "x", scopes: [EXAMPLE_SCOPE], redirectUri: "http://127.0.0.1:9999" });
  assert.equal(new URL(url).searchParams.get("redirect_uri"), "http://127.0.0.1:9999");
});

// ————— parseTokenResponse —————

test("parseTokenResponse : réponse valide → rendue telle quelle", () => {
  const json = { access_token: "at", expires_in: 3600, refresh_token: "rt", scope: EXAMPLE_SCOPE, token_type: "Bearer" };
  assert.deepEqual(parseTokenResponse(json), json);
});

test("parseTokenResponse : réponse d'erreur Google → lève avec error + error_description", () => {
  assert.throws(
    () => parseTokenResponse({ error: "invalid_grant", error_description: "Bad Request" }),
    /invalid_grant.*Bad Request/,
  );
});

test("parseTokenResponse : réponse d'erreur sans description → message par défaut, pas de crash sur undefined", () => {
  assert.throws(() => parseTokenResponse({ error: "invalid_client" }), /invalid_client.*pas de détail/);
});

test("parseTokenResponse : réponse sans access_token ni error → lève quand même (jamais de silence)", () => {
  assert.throws(() => parseTokenResponse({ foo: "bar" }), /sans access_token/);
});

// ————— googleOAuthCredentials —————

test("googleOAuthCredentials : lit les 3 variables d'env, trim les espaces", () => {
  const env = { GOOGLE_OAUTH_CLIENT_ID: "  cid  ", GOOGLE_OAUTH_CLIENT_SECRET: "csec", GOOGLE_OAUTH_REFRESH_TOKEN: "rtok" } as NodeJS.ProcessEnv;
  assert.deepEqual(googleOAuthCredentials(env), { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" });
});

test("googleOAuthCredentials : variables absentes → undefined, pas de chaîne vide ni d'exception", () => {
  assert.deepEqual(googleOAuthCredentials({} as NodeJS.ProcessEnv), {
    clientId: undefined,
    clientSecret: undefined,
    refreshToken: undefined,
  });
});

// ————— exchangeCodeForTokens / refreshAccessToken (fetchFn injecté, zéro réseau) —————

function fakeFetch(respond: (body: URLSearchParams) => unknown): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = new URLSearchParams(String((init as { body: string }).body));
    return { json: async () => respond(body) } as Response;
  }) as typeof fetch;
}

test("exchangeCodeForTokens : POST grant_type=authorization_code avec le code fourni, vers GOOGLE_TOKEN_URL", async () => {
  let capturedUrl: unknown;
  let capturedBody: URLSearchParams | undefined;
  const fetchFn = (async (url: unknown, init: unknown) => {
    capturedUrl = url;
    capturedBody = new URLSearchParams(String((init as { body: string }).body));
    return { json: async () => ({ access_token: "at", expires_in: 3600, refresh_token: "rt", scope: EXAMPLE_SCOPE, token_type: "Bearer" }) } as Response;
  }) as typeof fetch;

  const tokens = await exchangeCodeForTokens({ clientId: "cid", clientSecret: "csec", code: "4/abc" }, fetchFn);

  assert.equal(capturedUrl, GOOGLE_TOKEN_URL);
  assert.equal(capturedBody?.get("grant_type"), "authorization_code");
  assert.equal(capturedBody?.get("code"), "4/abc");
  assert.equal(capturedBody?.get("redirect_uri"), GOOGLE_OAUTH_LOOPBACK_REDIRECT_URI);
  assert.equal(tokens.refresh_token, "rt");
});

test("refreshAccessToken : POST grant_type=refresh_token avec le refresh_token fourni", async () => {
  let capturedBody: URLSearchParams | undefined;
  const fetchFn = (async (_url: unknown, init: unknown) => {
    capturedBody = new URLSearchParams(String((init as { body: string }).body));
    return { json: async () => ({ access_token: "at2", expires_in: 3600, scope: EXAMPLE_SCOPE, token_type: "Bearer" }) } as Response;
  }) as typeof fetch;

  const tokens = await refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "rt" }, fetchFn);

  assert.equal(capturedBody?.get("grant_type"), "refresh_token");
  assert.equal(capturedBody?.get("refresh_token"), "rt");
  assert.equal(tokens.access_token, "at2");
});

test("refreshAccessToken : propage une erreur Google (ex. refresh_token révoqué) au lieu de rendre un access_token vide", async () => {
  const fetchFn = fakeFetch(() => ({ error: "invalid_grant", error_description: "Token has been expired or revoked." }));
  await assert.rejects(
    refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "revoked" }, fetchFn),
    /invalid_grant/,
  );
});
