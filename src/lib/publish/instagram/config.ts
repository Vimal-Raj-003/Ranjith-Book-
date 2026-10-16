/**
 * SERVER-ONLY. What this install needs before it may speak to Instagram, and the
 * endpoints it speaks to.
 *
 * THE OFFICIAL PATH ONLY. Instagram publishing here is Meta's Graph API
 * (Content Publishing) behind a Facebook Login: the operator signs in on
 * facebook.com in their own browser and grants a Facebook Page that is linked to
 * their Instagram professional account. There is no browser automation, no
 * stored session or cookie, no password, and no SDK — raw `fetch` against the
 * documented endpoints, the same way the YouTube integration is written.
 *
 * Every secret this integration has is read here and nowhere else, which is what
 * makes "no secret reaches the client" checkable rather than hoped for:
 * `appSecret` is returned only by `serverConfig()`, and `publicConfig()` is the
 * different, client-safe type (`ConfigView`) the browser may see.
 *
 * THE PUBLIC BASE URL IS REQUIRED, NOT GUESSED, for two reasons that are the same
 * reason. Meta refuses an OAuth redirect that is not character-for-character one
 * of the URIs registered on the app, and — the part that is easy to miss — the
 * Content Publishing API does not accept an upload: it is handed a `video_url`
 * and FETCHES the file itself, from Meta's servers. So the address in
 * `PUBLIC_BASE_URL` has to be one the public internet can reach, and a
 * `http://localhost:3013` there makes every publish fail at Meta's end, after a
 * container was created, with an error that does not mention localhost. That is
 * `publicBaseProblem`, and it is reported before anything is sent.
 */
import { keyStatus, TOKEN_KEY_ENV, type EnvLike } from "../youtube/secrets";
import type { ConfigView } from "../connect";

/** The provider key used in `PlatformAccount.provider` and `OAuthState.provider`. */
export const INSTAGRAM_PROVIDER = "instagram";

/** The Graph API version used unless `META_GRAPH_VERSION` overrides it. */
export const DEFAULT_GRAPH_VERSION = "v21.0";

/**
 * The scopes this app asks for, exactly.
 *
 *  - `instagram_basic` and `instagram_content_publish`: read the account and
 *    post a Reel to it;
 *  - `pages_show_list` and `pages_read_engagement`: list the operator's Pages
 *    and read the Instagram account linked to one (the Content Publishing API
 *    is addressed through the linked Page);
 *  - `business_management`: needed when the Page is owned through a Business
 *    portfolio rather than by the operator personally.
 *
 * Space-separated in the dialog URL, as Meta's `scope` parameter wants.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
] as const;

export const SCOPE_PARAM = INSTAGRAM_SCOPES.join(" ");

export const ENV = {
  appId: "META_APP_ID",
  appSecret: "META_APP_SECRET",
  publicBaseUrl: "PUBLIC_BASE_URL",
  graphVersion: "META_GRAPH_VERSION",
  tokenKey: TOKEN_KEY_ENV,
} as const;

const clean = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/** `v21.0`, or the override when it is shaped like a Graph version. */
export function graphVersion(env: EnvLike = process.env): string {
  const raw = clean(env[ENV.graphVersion]);
  return /^v\d{1,2}\.\d{1,2}$/.test(raw) ? raw : DEFAULT_GRAPH_VERSION;
}

/**
 * Meta's own endpoints. Functions of the environment (for the version) and
 * otherwise constants, so no caller can be pointed at a different host.
 */
export function endpoints(env: EnvLike = process.env): { graph: string; dialog: string } {
  const v = graphVersion(env);
  return {
    graph: `https://graph.facebook.com/${v}`,
    dialog: `https://www.facebook.com/${v}/dialog/oauth`,
  };
}

/**
 * `PUBLIC_BASE_URL` as an origin plus any path prefix, with no trailing slash, or
 * null when it is unset or is not an http(s) URL. Query and fragment are dropped.
 */
export function publicBaseUrl(env: EnvLike = process.env): string | null {
  const raw = clean(env[ENV.publicBaseUrl]);
  if (raw === "") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** The OAuth callback Meta must have on file. Derived, never separately configured. */
export function redirectUri(env: EnvLike = process.env): string | null {
  const base = publicBaseUrl(env);
  return base === null ? null : `${base}/api/publish/instagram/callback`;
}

/**
 * Why Meta's servers could not fetch a video from this install, or null.
 *
 * A hostname that is loopback, link-local, private-range or a bare name with no
 * dot is unreachable from Meta however correct it looks in a browser on this
 * machine. Plain `http:` is refused as well: Meta fetches over HTTPS. It is
 * checked on the PUBLISH path, not on connect — the OAuth dialog does accept an
 * `http://localhost` redirect for an app still in development, and refusing the
 * connection for that would block the one step that does work.
 */
export function publicBaseProblem(env: EnvLike = process.env): string | null {
  const base = publicBaseUrl(env);
  if (base === null) return `${ENV.publicBaseUrl} is not set to a web address, so Meta has nowhere to fetch the video from.`;
  const url = new URL(base);
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    !host.includes(".");
  if (privateHost) {
    return (
      `${ENV.publicBaseUrl} points at ${url.host}, which Meta's servers cannot reach. ` +
      "Instagram fetches the video from that address, so it must be a public https address (for example a tunnel or your domain)."
    );
  }
  if (url.protocol !== "https:") {
    return `${ENV.publicBaseUrl} must be an https address: Meta fetches the video over https.`;
  }
  return null;
}

/** Everything the server needs. `appSecret` must never leave this process. */
export interface ServerConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  publicBaseUrl: string;
}

/**
 * What the browser may be told: names and verdicts, never values.
 *
 * It is `ConfigView`, the client-safe type, and not a second declaration of the
 * same fields, so adding a field here that should not cross the wire is a type
 * error rather than a leak.
 */
export type PublicConfig = ConfigView;

/** The server-side configuration, or null. "Not configured" is an answer, not a failure. */
export function serverConfig(env: EnvLike = process.env): ServerConfig | null {
  const appId = clean(env[ENV.appId]);
  const appSecret = clean(env[ENV.appSecret]);
  const base = publicBaseUrl(env);
  const redirect = redirectUri(env);
  if (!appId || !appSecret || base === null || redirect === null) return null;
  if (!keyStatus(env).ok) return null;
  return { appId, appSecret, redirectUri: redirect, publicBaseUrl: base };
}

/**
 * The same question, answered for a UI, with the reasons: variable NAMES only.
 *
 * Pure over an environment object so a test can walk every combination.
 */
export function publicConfig(env: EnvLike = process.env): PublicConfig {
  const missing: string[] = [];
  if (!clean(env[ENV.appId])) missing.push(ENV.appId);
  if (!clean(env[ENV.appSecret])) missing.push(ENV.appSecret);
  if (publicBaseUrl(env) === null) missing.push(ENV.publicBaseUrl);
  const key = keyStatus(env);
  if (!key.ok) missing.push(ENV.tokenKey);
  return { configured: missing.length === 0, missing, keyProblem: key.reason };
}
