/**
 * SERVER-ONLY. What this install needs before it may speak to YouTube, and the
 * endpoints it speaks to.
 *
 * Every secret this integration has is read here and nowhere else, which is
 * what makes "no secret reaches the client" checkable rather than hoped for:
 * `clientSecret` is returned only by `serverConfig()`, which is called by the
 * OAuth and upload modules, and by nothing that builds a response body.
 * `publicConfig()` is the shape the browser is allowed to see, and it is a
 * different type — so handing the wrong one to `NextResponse.json` does not
 * compile.
 *
 * THE REDIRECT URI IS REQUIRED, NOT GUESSED. Google refuses an authorisation
 * whose `redirect_uri` is not character-for-character one of the values
 * registered in the Cloud console, and this app cannot know which port or host
 * the operator registered (this very install runs on :3013, not the Next
 * default). A guessed default would produce `redirect_uri_mismatch` — an error
 * screen on Google's side, after the operator has already signed in, with
 * nothing in this app's logs. So it is an explicit variable, and its absence is
 * reported as "not configured" with the variable named.
 */
import { keyStatus, TOKEN_KEY_ENV, type EnvLike } from "./secrets";
// The wire shape, imported rather than restated, so the compiler keeps this
// module and the browser in step. See `../connect.ts` for why it is a leaf.
import type { ConfigView } from "../connect";

/** Google's own endpoints. Constants, so no caller can be pointed elsewhere. */
export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  /** Resumable upload initiation. `uploadType=resumable` is what makes it so. */
  videosUpload: "https://www.googleapis.com/upload/youtube/v3/videos",
  thumbnailsSet: "https://www.googleapis.com/upload/youtube/v3/thumbnails/set",
} as const;

/**
 * The one scope this app asks for.
 *
 * `youtube.upload` is enough to insert a video AND to call `thumbnails.set`, so
 * nothing more is requested. `youtube.readonly` would let the connect screen
 * name the channel before the first upload and let this app read whether the
 * channel is verified — and it is a read grant over the operator's entire
 * YouTube account, for a label. It is not asked for. The consequence is stated
 * where it bites: the channel name is recorded from the first upload's own
 * response (which carries `snippet.channelTitle`), and a thumbnail that needs a
 * verified channel is attempted and reported, never predicted.
 */
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"] as const;

export const SCOPE_PARAM = YOUTUBE_SCOPES.join(" ");

/** The provider key used in `PlatformAccount.provider` and `OAuthState.provider`. */
export const YOUTUBE_PROVIDER = "youtube";

/**
 * Review-first, stated as a constant rather than as a literal at the call site.
 *
 * Nothing in this integration sets anything else. There is no code path that
 * writes `public` or `unlisted`: the upload sends this value, the job records
 * what was sent, and making a video public is an action the operator takes in
 * YouTube Studio with their own hands. See the report for why that is a
 * deliberate ceiling and not an unfinished feature.
 */
export const UPLOAD_PRIVACY = "private" as const;

/** Where the operator finishes the job, for a video id the platform returned. */
export function studioUrlFor(videoId: string): string {
  return `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`;
}

/** The public watch URL for a video id. Private videos still live at it. */
export function watchUrlFor(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export const ENV = {
  clientId: "GOOGLE_CLIENT_ID",
  clientSecret: "GOOGLE_CLIENT_SECRET",
  redirectUri: "GOOGLE_OAUTH_REDIRECT_URI",
  tokenKey: TOKEN_KEY_ENV,
} as const;

/** Everything the server needs. `clientSecret` must never leave this process. */
export interface ServerConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * What the browser may be told: names and verdicts, never values.
 *
 * It is `ConfigView` — the client-safe type — and not a second declaration of
 * the same fields, so adding a field here that should not cross the wire is a
 * type error rather than a leak.
 */
export type PublicConfig = ConfigView;

const clean = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/**
 * The server-side configuration, or null.
 *
 * Null rather than a throw: "this install has no Google credentials" is the
 * normal state of a fresh checkout and of every install that only ever uses the
 * assisted handoff. It is an answer, not a failure.
 */
export function serverConfig(env: EnvLike = process.env): ServerConfig | null {
  const clientId = clean(env[ENV.clientId]);
  const clientSecret = clean(env[ENV.clientSecret]);
  const redirectUri = clean(env[ENV.redirectUri]);
  if (!clientId || !clientSecret || !redirectUri) return null;
  if (!keyStatus(env).ok) return null;
  return { clientId, clientSecret, redirectUri };
}

/**
 * The same question, answered for a UI, with the reasons.
 *
 * Pure over an environment object so a test can walk every combination, and so
 * the Publish Center's "A connection will need" list can be the real list of
 * what is missing rather than a hand-written guess.
 */
export function publicConfig(env: EnvLike = process.env): PublicConfig {
  const missing: string[] = [];
  if (!clean(env[ENV.clientId])) missing.push(ENV.clientId);
  if (!clean(env[ENV.clientSecret])) missing.push(ENV.clientSecret);
  if (!clean(env[ENV.redirectUri])) missing.push(ENV.redirectUri);
  const key = keyStatus(env);
  if (!key.ok) missing.push(ENV.tokenKey);
  return { configured: missing.length === 0, missing, keyProblem: key.reason };
}

/**
 * A redirect target this app is willing to send a browser to after the OAuth
 * round trip.
 *
 * App-relative only. An absolute URL — however friendly it looks — turns the
 * callback into an open redirector, which is a phishing primitive and a
 * standard OAuth finding. `//evil.test` is rejected too: the browser reads it
 * as protocol-relative and leaves the site.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // No control characters or backslashes: both are used to smuggle a host past
  // a naive prefix check.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  return value;
}
