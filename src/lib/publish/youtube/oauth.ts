/**
 * SERVER-ONLY. The authorisation-code flow, with PKCE, against Google.
 *
 * WHAT THIS IS NOT, and the hard rule it is the implementation of: this app
 * never sees the operator's Google password. It does not collect one, store
 * one, type one into anything, or transmit one. There is no browser automation
 * here and no selector for a Google page — the operator signs in on
 * accounts.google.com, in their own browser, and Google hands this app a
 * single-use code. If a future change to this file needs a page selector, the
 * change is wrong.
 *
 * WHAT EACH PIECE IS FOR:
 *
 *  - PKCE (S256). Google's web-server flow authenticates with a client secret,
 *    so PKCE is belt-and-braces here rather than load-bearing — but the code is
 *    worthless without the verifier, so an authorisation code captured from a
 *    redirect (a shared machine, a logged URL, a referrer) cannot be redeemed.
 *    The verifier is generated server-side, stored server-side, and never put
 *    in a URL.
 *  - `state`. 32 random bytes, stored as a SHA-256 hash in `OAuthState`
 *    (`Session` stores its token the same way, for the same reason) and bound
 *    to the user who started the flow. The callback is accepted only if the
 *    returned state hashes to a row this server wrote, that has not expired,
 *    and that belongs to the user whose session is making the callback request.
 *    Single use: redeeming deletes the row, so a replayed callback finds
 *    nothing.
 *  - `access_type=offline` with `prompt=consent`. The refresh token is what
 *    makes "connect once" true, and Google returns one only on a consent that
 *    explicitly asks. Without `prompt=consent`, a second connect for an
 *    already-granted scope returns NO refresh token, and the install silently
 *    degrades to one hour of access — a bug that only appears a day later.
 *  - `include_granted_scopes=false` is the default and is left alone: this app
 *    asks for one scope and wants exactly one.
 *
 * The token exchange and the refresh happen HERE, server-side, with the client
 * secret. Nothing in this module returns a secret, a token or a verifier to a
 * caller that could serialise it into a response: the exchange returns a
 * `TokenSet` which only `accounts.ts` consumes, and `accounts.ts` seals it.
 */
import crypto from "node:crypto";
import { GOOGLE, SCOPE_PARAM, type ServerConfig } from "./config";
import { mapTokenError, type MappedFailure } from "./errors";

/** How long an unredeemed authorisation stays redeemable. */
export const STATE_TTL_MS = 10 * 60_000;

/**
 * How early an access token is treated as expired.
 *
 * A token that expires in twenty seconds is useless for a 38 MB upload, and
 * discovering that mid-transfer costs the whole transfer. Sixty seconds of
 * margin is cheap: a refresh is one request.
 */
export const ACCESS_SKEW_MS = 60_000;

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. 64 base64url characters of verifier, well inside the 43–128 range. */
export function makePkce(): Pkce {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The opaque `state` value, and the hash that is what gets stored. */
export function makeState(): { state: string; stateHash: string } {
  const state = crypto.randomBytes(32).toString("base64url");
  return { state, stateHash: hashState(state) };
}

export function hashState(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

/**
 * Where to send the operator's browser.
 *
 * Built with `URLSearchParams`, so nothing a caller passes can inject a
 * parameter. The client SECRET is deliberately absent: this URL is visible in
 * the operator's address bar and their history.
 */
export function authorizeUrl(config: ServerConfig, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPE_PARAM,
    // A refresh token, and a consent screen that will actually issue one.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE.authorize}?${params.toString()}`;
}

/** What Google's token endpoint hands back, as this app uses it. */
export interface TokenSet {
  accessToken: string;
  /** Absent on a refresh: Google issues one at consent and expects it to be kept. */
  refreshToken: string | null;
  expiresAt: Date;
  /** The scopes GRANTED, which can be narrower than the ones asked for. */
  scope: string;
}

export class YouTubeAuthError extends Error {
  readonly failure: MappedFailure;
  constructor(failure: MappedFailure) {
    super(failure.message);
    this.name = "YouTubeAuthError";
    this.failure = failure;
  }
}

/** The `fetch` the network-touching functions use, injectable so tests need no network. */
export type Fetcher = typeof fetch;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function postForm(
  doFetch: Fetcher,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error_description: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

function tokenSetFrom(body: unknown, fallbackScope: string): TokenSet {
  const parsed = (body ?? {}) as TokenResponse;
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (accessToken === "") {
    throw new YouTubeAuthError({
      code: "platform_error",
      message: "Google answered the token request without an access token, so nothing was connected.",
      retryable: true,
    });
  }
  const lifetime = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token !== "" ? parsed.refresh_token : null,
    expiresAt: new Date(Date.now() + lifetime * 1000),
    scope: typeof parsed.scope === "string" && parsed.scope !== "" ? parsed.scope : fallbackScope,
  };
}

/**
 * Redeem an authorisation code. Runs on the server, with the client secret, and
 * with the PKCE verifier the server stored — never with anything the caller
 * supplied beyond the code itself.
 */
export async function exchangeCode(
  config: ServerConfig,
  code: string,
  verifier: string,
  doFetch: Fetcher = fetch,
): Promise<TokenSet> {
  const { status, body } = await postForm(doFetch, GOOGLE.token, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  if (status < 200 || status >= 300) throw new YouTubeAuthError(mapTokenError(status, body));

  const set = tokenSetFrom(body, SCOPE_PARAM);
  if (!set.refreshToken) {
    // Without one, "connected" would mean "for the next hour", and the operator
    // would find it broken tomorrow with no explanation. Refusing here is the
    // honest outcome, and the fix (re-consent) is in the message.
    throw new YouTubeAuthError({
      code: "not_connected",
      message:
        "Google did not return a refresh token, so this connection would stop working within the hour. " +
        "That happens when the account has already granted this app access: remove this app at " +
        "myaccount.google.com/permissions, then connect again.",
      retryable: false,
    });
  }
  return set;
}

/** Trade a refresh token for a fresh access token. The refresh token is reused, not replaced. */
export async function refreshAccess(
  config: ServerConfig,
  refreshToken: string,
  knownScope: string,
  doFetch: Fetcher = fetch,
): Promise<TokenSet> {
  const { status, body } = await postForm(doFetch, GOOGLE.token, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (status < 200 || status >= 300) throw new YouTubeAuthError(mapTokenError(status, body));
  const set = tokenSetFrom(body, knownScope);
  // A refresh response normally omits it; keep the one we already hold.
  return { ...set, refreshToken: set.refreshToken ?? refreshToken };
}

/**
 * Tell Google to invalidate the grant.
 *
 * Returns whether Google confirmed. A failure here must NOT stop the local row
 * from being removed — a disconnect that leaves a credential in the database
 * because a network call failed is the worse outcome — but it must be reported,
 * because "revoked at Google" and "forgotten locally" are different facts and
 * the operator may need to finish the job at
 * myaccount.google.com/permissions.
 *
 * Google answers 200 for a successful revoke and 400 `invalid_token` for a
 * token that was already invalid. The second is treated as success: the grant is
 * gone either way, which is what was asked for.
 */
export async function revokeToken(
  token: string,
  doFetch: Fetcher = fetch,
): Promise<{ revoked: boolean; detail: string | null }> {
  try {
    const { status, body } = await postForm(doFetch, GOOGLE.revoke, { token });
    if (status >= 200 && status < 300) return { revoked: true, detail: null };
    const error = (body ?? {}) as { error?: string };
    if (status === 400 && error.error === "invalid_token") {
      return { revoked: true, detail: null };
    }
    return { revoked: false, detail: mapTokenError(status, body).message };
  } catch (err) {
    return { revoked: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Did the grant that came back actually include what this app needs? */
export function grantedScopes(scope: string): string[] {
  return scope.split(/\s+/).filter((s) => s !== "");
}

export function hasUploadScope(scope: string): boolean {
  const granted = grantedScopes(scope);
  return granted.includes("https://www.googleapis.com/auth/youtube.upload") ||
    granted.includes("https://www.googleapis.com/auth/youtube") ||
    granted.includes("https://www.googleapis.com/auth/youtubepartner");
}

/**
 * Did the grant include permission to ask YouTube which channel this is?
 *
 * `channels.list?mine=true` is permitted by any of these. A credential without
 * one cannot be identity-verified, which is NOT the same as it being unable to
 * upload: `hasUploadScope` is the separate, unchanged gate for that.
 */
export function hasReadonlyScope(scope: string): boolean {
  const granted = grantedScopes(scope);
  return (
    granted.includes("https://www.googleapis.com/auth/youtube.readonly") ||
    granted.includes("https://www.googleapis.com/auth/youtube") ||
    granted.includes("https://www.googleapis.com/auth/youtube.force-ssl") ||
    granted.includes("https://www.googleapis.com/auth/youtubepartner")
  );
}
