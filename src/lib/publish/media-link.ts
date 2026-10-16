/**
 * SERVER-ONLY. The signed, short-lived, public URL Meta fetches a video from.
 *
 * WHY THIS EXISTS. Instagram's Content Publishing API does not take an upload.
 * It is given a `video_url` and downloads the file itself, from Meta's servers,
 * with no session and no cookie — so the video route that serves this app's own
 * users (`/api/episodes/[id]/video`, behind a login) cannot be the URL. And the
 * answer is not to make the render public: a rendered video lives outside
 * `public/` precisely so that it can be served only by a handler that has made a
 * decision about the requester.
 *
 * So the decision is made at SIGNING time. When an owner publishes an episode
 * (ownership already checked by `loadPublishRequest`), this module mints a URL
 * that is good for ONE episode and for a few minutes. The token is
 *
 *     base64url(JSON { episodeId, exp }) "." base64url(HMAC-SHA256(payload))
 *
 * and the HMAC key is DERIVED from `BOOKREEL_TOKEN_KEY` for this purpose alone
 * (`deriveKey`), never the bytes that seal stored credentials. What that buys:
 *
 *  - a token for episode A cannot fetch episode B: the episode id is inside the
 *    signed payload, so changing it breaks the signature;
 *  - a leaked URL stops working at `exp` (default 20 minutes), and its worst case
 *    is one video, read-only, that was about to be posted publicly anyway;
 *  - it names no path. The route resolves `RENDER_DIR/<episodeId>.mp4` itself,
 *    after the id has been proven to be one this server signed;
 *  - rotating `BOOKREEL_TOKEN_KEY` invalidates every outstanding link.
 *
 * THE COMPARISON IS CONSTANT-TIME, and a token that is malformed in any way
 * answers the same as one that is merely wrong: `verifyMediaToken` throws one
 * error class with a code, and the route turns every code into the same 403.
 */
import crypto from "node:crypto";
import { ENV as META_ENV, publicBaseUrl } from "./instagram/config";
import { deriveKey, TokenKeyMissing, type EnvLike } from "./youtube/secrets";

/** The domain-separation label for the HMAC key. Changing it invalidates every link. */
const KEY_PURPOSE = "bookreel/publish/media-link/v1";

/** 20 minutes: long enough for Meta to fetch a short vertical video, short enough that a leak expires. */
export const DEFAULT_MEDIA_TTL_MS = 20 * 60_000;
/** The longest a link may be asked to live. A caller asking for more gets this. */
export const MAX_MEDIA_TTL_MS = 60 * 60_000;

/** The route's path prefix, named once so signing and routing cannot drift. */
export const MEDIA_PATH = "/api/publish/media";

/**
 * Episode ids are cuids: letters, digits, `_` and `-`. Anything else — a dot, a
 * slash, a backslash, a NUL — is refused at sign AND verify time, so even a
 * token somehow signed over a traversal string never reaches a path join.
 */
const EPISODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type MediaLinkProblem = "malformed" | "bad_signature" | "expired" | "not_configured" | "bad_episode";

export class MediaLinkError extends Error {
  readonly code: MediaLinkProblem;
  constructor(code: MediaLinkProblem, message: string) {
    super(message);
    this.name = "MediaLinkError";
    this.code = code;
  }
}

/** By name, not `instanceof`: see `isAppError` in lib/errors.ts for why. */
export function isMediaLinkError(err: unknown): err is MediaLinkError {
  return err instanceof Error && err.name === "MediaLinkError";
}

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

function sign(payloadB64: string, env: EnvLike): Buffer {
  let key: Buffer;
  try {
    key = deriveKey(KEY_PURPOSE, env);
  } catch (err) {
    if (err instanceof TokenKeyMissing || (err instanceof Error && err.name === "TokenKeyMissing")) {
      throw new MediaLinkError("not_configured", err instanceof Error ? err.message : "The token key is not set.");
    }
    throw err;
  }
  return crypto.createHmac("sha256", key).update(payloadB64, "utf8").digest();
}

/** The path (no host) of a signed link, for tests and for the route. */
export function mediaPathFor(token: string): string {
  return `${MEDIA_PATH}/${token}`;
}

/** Mint the token alone. `signMediaUrl` is the usual door. */
export function signMediaToken(
  episodeId: string,
  ttlMs: number = DEFAULT_MEDIA_TTL_MS,
  env: EnvLike = process.env,
  now: number = Date.now(),
): string {
  if (!EPISODE_ID.test(episodeId)) {
    throw new MediaLinkError("bad_episode", "That is not an episode id this app would sign a link for.");
  }
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, MAX_MEDIA_TTL_MS) : DEFAULT_MEDIA_TTL_MS;
  const payload = b64u(JSON.stringify({ episodeId, exp: now + ttl }));
  return `${payload}.${b64u(sign(payload, env))}`;
}

/**
 * The public URL Meta will be given: `${PUBLIC_BASE_URL}/api/publish/media/<token>`.
 *
 * Throws `MediaLinkError("not_configured")` when there is no `PUBLIC_BASE_URL`
 * or no token key. It does NOT judge whether that address is reachable from the
 * internet (`publicBaseProblem` does, on the publish path), so it can be used by
 * a test or a local round trip against `http://localhost`.
 */
export function signMediaUrl(
  episodeId: string,
  ttlMs: number = DEFAULT_MEDIA_TTL_MS,
  env: EnvLike = process.env,
  now: number = Date.now(),
): string {
  const base = publicBaseUrl(env);
  if (base === null) {
    throw new MediaLinkError("not_configured", `${META_ENV.publicBaseUrl} is not set, so there is no address to give Meta.`);
  }
  return `${base}${mediaPathFor(signMediaToken(episodeId, ttlMs, env, now))}`;
}

/**
 * Check a token and return the one episode it is good for, or throw.
 *
 * Order matters and is deliberate: shape, then signature (constant-time), then
 * the payload is parsed, THEN expiry. A forged payload is never parsed as
 * anything but untrusted bytes until the signature over it has checked out.
 */
export function verifyMediaToken(
  token: string,
  env: EnvLike = process.env,
  now: number = Date.now(),
): { episodeId: string; expiresAt: number } {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) {
    throw new MediaLinkError("malformed", "This link is not valid.");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new MediaLinkError("malformed", "This link is not valid.");
  }
  const [payloadB64, sigB64] = parts;
  // A base64url alphabet and nothing else, so a crafted string cannot be
  // normalised by the decoder into something other than what was signed.
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) {
    throw new MediaLinkError("malformed", "This link is not valid.");
  }

  // Compared as the CANONICAL ENCODED STRINGS, not as decoded bytes. Base64
  // decoders ignore the unused trailing bits of the last character, so decoding
  // first would accept four different strings for one signature. Harmless to
  // authorisation, but a link with a malleable signature is the kind of thing
  // that is better not to have.
  const expected = Buffer.from(b64u(sign(payloadB64, env)), "utf8");
  const given = Buffer.from(sigB64, "utf8");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new MediaLinkError("bad_signature", "This link is not valid.");
  }

  let parsed: { episodeId?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    throw new MediaLinkError("malformed", "This link is not valid.");
  }
  if (typeof parsed.episodeId !== "string" || !EPISODE_ID.test(parsed.episodeId) || typeof parsed.exp !== "number") {
    throw new MediaLinkError("malformed", "This link is not valid.");
  }
  if (!(parsed.exp > now)) {
    throw new MediaLinkError("expired", "This link has expired.");
  }
  return { episodeId: parsed.episodeId, expiresAt: parsed.exp };
}
