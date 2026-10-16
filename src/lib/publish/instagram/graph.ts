/**
 * SERVER-ONLY. The Graph API calls Instagram publishing is made of, as thin raw
 * `fetch` wrappers.
 *
 * NO SDK, and no `fetch` of its own: every function takes the `fetch` it should
 * use, so the integration can be driven end to end against a recorded API and
 * never reaches Meta from a test. The default is only supplied by the route
 * handlers.
 *
 * THE TOKEN IS A PARAMETER, NEVER A THING THIS MODULE KEEPS. It is put in the
 * query string of a GET or the form body of a POST (the documented places), it
 * is never logged, and no URL or request body is ever copied into an error
 * message: `InstagramApiError` carries a mapped, operator-facing sentence and
 * nothing the request contained.
 *
 * WHAT IS DELIBERATELY NOT HERE: no call that edits, deletes or lists anything
 * on the Instagram account beyond creating and publishing one Reel container.
 * Nothing changes account settings.
 */
import { endpoints, type ServerConfig } from "./config";
import { mapGraphError, mapTransportError, type MappedFailure } from "./errors";
import type { EnvLike } from "../youtube/secrets";

/** The `fetch` the network-touching functions use, injectable so tests need no network. */
export type Fetcher = typeof fetch;

export class InstagramApiError extends Error {
  readonly failure: MappedFailure;
  constructor(failure: MappedFailure) {
    super(failure.message);
    this.name = "InstagramApiError";
    this.failure = failure;
  }
}

/** By name, not `instanceof`: see `isAppError` in lib/errors.ts for why. */
export function isInstagramApiError(err: unknown): err is InstagramApiError {
  return err instanceof Error && err.name === "InstagramApiError" && "failure" in err;
}

type Method = "GET" | "POST" | "DELETE";

interface CallOptions {
  env?: EnvLike;
  /** Names the call in the error message ("the publish", "the media container"). */
  where?: string;
  /** True for the call whose success cannot be taken back: a lost reply is then ambiguous. */
  afterSend?: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

async function call(
  doFetch: Fetcher,
  method: Method,
  path: string,
  params: Record<string, string>,
  options: CallOptions = {},
): Promise<Record<string, unknown>> {
  const base = endpoints(options.env).graph;
  const url = `${base}${path}`;
  const query = new URLSearchParams(params).toString();

  let res: Response;
  try {
    res =
      method === "GET"
        ? await doFetch(`${url}?${query}`, { method: "GET", headers: { Accept: "application/json" } })
        : await doFetch(url, {
            method,
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: query,
          });
  } catch (err) {
    throw new InstagramApiError(mapTransportError(err, options.afterSend === true));
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON answer from Meta (an HTML error page from a proxy, say).
    body = { error: { message: text.slice(0, 200) } };
  }
  const record = asRecord(body);
  if (!res.ok || record.error !== undefined) {
    throw new InstagramApiError(mapGraphError(res.status, body, options.where));
  }
  return record;
}

// ------------------------------------------------------------------ the dialog

/**
 * Where to send the operator's browser.
 *
 * Built with `URLSearchParams`, so nothing a caller passes can inject a
 * parameter. The app SECRET is deliberately absent: this URL is visible in the
 * address bar and in history. There is no PKCE on Meta's web flow; the `state`
 * (a server-issued, single-use, session-bound value) is what binds the callback
 * to the session that started it.
 */
export function authorizeUrl(config: ServerConfig, state: string, scope: string, env?: EnvLike): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    scope,
    response_type: "code",
  });
  return `${endpoints(env).dialog}?${params.toString()}`;
}

// ------------------------------------------------------------- the token steps

/** Code -> short-lived USER token (about an hour). Runs with the app secret, on the server. */
export async function codeToShortToken(
  config: ServerConfig,
  code: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<string> {
  const body = await call(
    doFetch,
    "GET",
    "/oauth/access_token",
    {
      client_id: config.appId,
      redirect_uri: config.redirectUri,
      client_secret: config.appSecret,
      code,
    },
    { env, where: "the sign-in exchange" },
  );
  const token = str(body.access_token);
  if (!token) {
    throw new InstagramApiError({
      code: "platform_error",
      message: "Meta answered the sign-in exchange without an access token, so nothing was connected.",
      retryable: true,
    });
  }
  return token;
}

export interface LongLivedUserToken {
  token: string;
  /** Seconds, as Meta reported; null when it did not say. */
  expiresIn: number | null;
}

/** Short-lived USER token -> long-lived (about 60 days) USER token. */
export async function toLongLivedToken(
  config: ServerConfig,
  shortToken: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<LongLivedUserToken> {
  const body = await call(
    doFetch,
    "GET",
    "/oauth/access_token",
    {
      grant_type: "fb_exchange_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortToken,
    },
    { env, where: "the long-lived token exchange" },
  );
  const token = str(body.access_token);
  if (!token) {
    throw new InstagramApiError({
      code: "platform_error",
      message: "Meta did not return a long-lived token, so nothing was connected.",
      retryable: true,
    });
  }
  return { token, expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null };
}

/** The permissions Meta says the user actually granted, which can be fewer than asked for. */
export async function grantedPermissions(
  userToken: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<string[]> {
  const body = await call(doFetch, "GET", "/me/permissions", { access_token: userToken }, { env, where: "the permission check" });
  const data = Array.isArray(body.data) ? body.data : [];
  const granted: string[] = [];
  for (const item of data) {
    const entry = asRecord(item);
    if (entry.status === "granted" && typeof entry.permission === "string") granted.push(entry.permission);
  }
  return granted;
}

export interface PageRef {
  id: string;
  name: string | null;
  /** The Page access token. A credential. */
  accessToken: string;
}

/** The Facebook Pages the user manages, each with its own Page access token. */
export async function listPages(userToken: string, doFetch: Fetcher = fetch, env?: EnvLike): Promise<PageRef[]> {
  const body = await call(
    doFetch,
    "GET",
    "/me/accounts",
    { fields: "id,name,access_token", limit: "100", access_token: userToken },
    { env, where: "the Page list" },
  );
  const out: PageRef[] = [];
  for (const item of Array.isArray(body.data) ? body.data : []) {
    const page = asRecord(item);
    const id = str(page.id);
    const accessToken = str(page.access_token);
    if (id && accessToken) out.push({ id, name: str(page.name), accessToken });
  }
  return out;
}

export interface InstagramAccountRef {
  /** The Instagram Business/Creator account id: what `/media` is addressed to. */
  id: string;
  username: string | null;
}

/** The Instagram professional account linked to one Page, or null when there is none. */
export async function pageInstagramAccount(
  pageId: string,
  pageToken: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<InstagramAccountRef | null> {
  const body = await call(
    doFetch,
    "GET",
    `/${encodeURIComponent(pageId)}`,
    { fields: "instagram_business_account{id,username}", access_token: pageToken },
    { env, where: "the linked Instagram account lookup" },
  );
  const linked = asRecord(body.instagram_business_account);
  const id = str(linked.id);
  return id ? { id, username: str(linked.username) } : null;
}

/** Ask Meta to revoke every permission this app holds for the user. Needs the USER token. */
export async function revokeUserGrant(
  userToken: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<void> {
  await call(doFetch, "DELETE", "/me/permissions", { access_token: userToken }, { env, where: "the revoke" });
}

// ---------------------------------------------------------------- the account

/** The `@username` Instagram reports for an account id RIGHT NOW. The identity check at publish time. */
export async function accountUsername(
  igUserId: string,
  token: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<{ id: string | null; username: string | null }> {
  const body = await call(
    doFetch,
    "GET",
    `/${encodeURIComponent(igUserId)}`,
    { fields: "id,username", access_token: token },
    { env, where: "the account check" },
  );
  return { id: str(body.id), username: str(body.username) };
}

export interface PublishingLimit {
  used: number;
  total: number;
}

/** Instagram's own count of API-published posts in the last 24 hours, and the ceiling. */
export async function publishingLimit(
  igUserId: string,
  token: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<PublishingLimit> {
  const body = await call(
    doFetch,
    "GET",
    `/${encodeURIComponent(igUserId)}/content_publishing_limit`,
    { fields: "quota_usage,config", access_token: token },
    { env, where: "the publishing-limit check" },
  );
  const entry = asRecord(Array.isArray(body.data) ? body.data[0] : null);
  const used = typeof entry.quota_usage === "number" ? entry.quota_usage : 0;
  const total = typeof asRecord(entry.config).quota_total === "number" ? (asRecord(entry.config).quota_total as number) : DAILY_CAP;
  return { used, total };
}

/** Instagram's documented ceiling on API-published posts per 24 hours, used when Meta does not state one. */
export const DAILY_CAP = 25;

// ------------------------------------------------------------ the container

export interface ReelParams {
  /** A URL Meta's servers can fetch. Signed and short-lived; see `media-link.ts`. */
  videoUrl: string;
  caption: string;
  shareToFeed: boolean;
}

/** Create the media container for a Reel. Nothing is posted yet. Returns the container id. */
export async function createReelContainer(
  igUserId: string,
  token: string,
  reel: ReelParams,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<string> {
  const body = await call(
    doFetch,
    "POST",
    `/${encodeURIComponent(igUserId)}/media`,
    {
      media_type: "REELS",
      video_url: reel.videoUrl,
      caption: reel.caption,
      share_to_feed: reel.shareToFeed ? "true" : "false",
      access_token: token,
    },
    { env, where: "the media container" },
  );
  const id = str(body.id);
  if (!id) {
    throw new InstagramApiError({
      code: "container_error",
      message: "Instagram accepted the request but returned no container id, so nothing can be published.",
      retryable: true,
    });
  }
  return id;
}

export type ContainerState = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED" | "UNKNOWN";

/** The container's processing state. `FINISHED` is the only one that may be published. */
export async function containerStatus(
  containerId: string,
  token: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<{ state: ContainerState; detail: string | null }> {
  const body = await call(
    doFetch,
    "GET",
    `/${encodeURIComponent(containerId)}`,
    { fields: "status_code,status", access_token: token },
    { env, where: "the processing check" },
  );
  const code = str(body.status_code);
  const known: ContainerState[] = ["FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED", "PUBLISHED"];
  const state = (known as string[]).includes(code ?? "") ? (code as ContainerState) : "UNKNOWN";
  return { state, detail: str(body.status) };
}

/**
 * Publish a finished container. THIS POSTS THE REEL, publicly, at once.
 *
 * Returns the media id Instagram assigned. `afterSend` is set because a lost
 * reply to this one request is ambiguous — see `mapTransportError`.
 */
export async function publishContainer(
  igUserId: string,
  token: string,
  containerId: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<string> {
  const body = await call(
    doFetch,
    "POST",
    `/${encodeURIComponent(igUserId)}/media_publish`,
    { creation_id: containerId, access_token: token },
    { env, where: "the publish", afterSend: true },
  );
  const id = str(body.id);
  if (!id) {
    // The platform did not name what it created. There is nothing to record as
    // an external id, and inventing one is the thing this app never does.
    throw new InstagramApiError({
      code: "platform_error",
      message:
        "Instagram answered the publish without a media id, so this app cannot confirm the Reel was posted. " +
        "Check the Instagram account before trying again.",
      retryable: false,
    });
  }
  return id;
}

/** The public permalink of a published media, or null if Instagram will not say. */
export async function mediaPermalink(
  mediaId: string,
  token: string,
  doFetch: Fetcher = fetch,
  env?: EnvLike,
): Promise<string | null> {
  const body = await call(
    doFetch,
    "GET",
    `/${encodeURIComponent(mediaId)}`,
    { fields: "permalink", access_token: token },
    { env, where: "the permalink lookup" },
  );
  return str(body.permalink);
}
