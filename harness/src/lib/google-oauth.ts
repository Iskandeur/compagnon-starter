/**
 * google-oauth — client OAuth2 "installed app" (Desktop) maison pour parler DIRECTEMENT aux API
 * Google, sans passer par un routeur tiers à quota partagé (Composio et équivalents) : chaque
 * agent a son propre projet Google Cloud, donc son propre quota, gratuit en usage standard.
 *
 * Flux "installed app" standard, variante loopback (RFC 8252) — le flux OOB "code à coller
 * manuellement" est MORT depuis 2022 côté Google (phishing), mais le flux loopback marche pareil
 * en pratique pour un usage headless :
 *   1. buildAuthUrl() → URL à ouvrir DANS LE NAVIGATEUR de ton humain (pas le tien, pas le
 *      serveur — c'est LUI qui approuve le consentement, avec SON compte Google).
 *   2. Il approuve. Google redirige vers redirectUri (`http://127.0.0.1/...?code=...`) — la page
 *      échoue à charger côté SON navigateur (rien n'écoute sur son 127.0.0.1), mais le `code`
 *      reste lisible dans la barre d'adresse : il te le colle tel quel (jamais en clair dans un
 *      canal qui traînerait ailleurs — l'échange se fait dans la foulée, pas stocké).
 *   3. exchangeCodeForTokens() une SEULE fois → renvoie un `refresh_token` PERMANENT (jusqu'à
 *      révocation manuelle) à stocker comme secret classique (`.env`, jamais commité).
 *   4. refreshAccessToken() à chaque usage réel : le `refresh_token` ne périme pas tout seul.
 *
 * Zéro dépendance : `fetch` natif Node ≥22. `fetchFn` injectable → testable sans réseau.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Redirect loopback SANS port fixe : Google autorise n'importe quel port sur 127.0.0.1 pour un
// client OAuth de type "Desktop app" (flux loopback, doc Google) — inutile d'ouvrir un vrai
// serveur ici, le `code` apparaît dans l'URL même si la page échoue à charger.
export const GOOGLE_OAUTH_LOOPBACK_REDIRECT_URI = "http://127.0.0.1";

export const GOOGLE_OAUTH_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_OAUTH_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";
export const GOOGLE_OAUTH_REFRESH_TOKEN_ENV = "GOOGLE_OAUTH_REFRESH_TOKEN";

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
}

/**
 * Lit les 3 secrets dans l'env du service (jamais en base, jamais en git). `refreshToken` reste
 * absent tant que l'échange initial (étape interactive, 2 ci-dessus) n'a pas eu lieu ; les champs
 * absents rendent `undefined`, pas d'exception ici — à l'appelant de décider si l'absence bloque.
 */
export function googleOAuthCredentials(env: NodeJS.ProcessEnv = process.env): Partial<GoogleOAuthCredentials> {
  const clientId = (env[GOOGLE_OAUTH_CLIENT_ID_ENV] ?? "").trim() || undefined;
  const clientSecret = (env[GOOGLE_OAUTH_CLIENT_SECRET_ENV] ?? "").trim() || undefined;
  const refreshToken = (env[GOOGLE_OAUTH_REFRESH_TOKEN_ENV] ?? "").trim() || undefined;
  return { clientId, clientSecret, refreshToken };
}

/** URL à donner à ton humain pour le login initial (étape 1 du flux, une seule fois par scope). PUR. */
export function buildAuthUrl(opts: { clientId: string; scopes: readonly string[]; redirectUri?: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri ?? GOOGLE_OAUTH_LOOPBACK_REDIRECT_URI,
    response_type: "code",
    scope: opts.scopes.join(" "),
    access_type: "offline", // indispensable : sans ça, Google ne renvoie jamais de refresh_token
    prompt: "consent", // force le renvoi d'un refresh_token même si un consentement précédent traîne
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string; // présent seulement à l'échange initial (ou re-consentement)
  scope: string;
  token_type: string;
}

/**
 * Transforme la réponse JSON brute de Google en `GoogleTokenResponse`, ou lève avec le détail
 * d'erreur Google (`error`/`error_description`) si l'échange a échoué. PUR → testable sans réseau.
 */
export function parseTokenResponse(json: any): GoogleTokenResponse {
  if (json?.error) {
    throw new Error(`Google OAuth error: ${json.error} — ${json.error_description ?? "(pas de détail)"}`);
  }
  if (!json?.access_token) {
    throw new Error(`Google OAuth: réponse sans access_token (${JSON.stringify(json).slice(0, 300)})`);
  }
  return json as GoogleTokenResponse;
}

type FetchFn = typeof fetch;

async function postForm(body: Record<string, string>, fetchFn: FetchFn): Promise<GoogleTokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return parseTokenResponse(await res.json());
}

/**
 * Échange initial : le `code` collé par ton humain (étape 2 du flux) contre un `refresh_token`
 * PERMANENT + un `access_token` de courte durée. À faire UNE SEULE FOIS — le `refresh_token`
 * obtenu ici devient ensuite le seul secret à stocker/réutiliser (`refreshAccessToken` ci-dessous).
 */
export async function exchangeCodeForTokens(
  opts: { clientId: string; clientSecret: string; code: string; redirectUri?: string },
  fetchFn: FetchFn = fetch,
): Promise<GoogleTokenResponse> {
  return postForm(
    {
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri ?? GOOGLE_OAUTH_LOOPBACK_REDIRECT_URI,
      grant_type: "authorization_code",
    },
    fetchFn,
  );
}

/**
 * Rafraîchit l'`access_token` (courte durée, ~1h côté Google) à partir du `refresh_token` stocké.
 * À appeler avant chaque usage réel — pas de cache ici, laissé à l'appelant si le volume d'appels
 * le justifie.
 */
export async function refreshAccessToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchFn: FetchFn = fetch,
): Promise<GoogleTokenResponse> {
  return postForm(
    {
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: "refresh_token",
    },
    fetchFn,
  );
}
