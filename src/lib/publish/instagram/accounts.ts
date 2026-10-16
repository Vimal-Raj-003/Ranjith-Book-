/**
 * SERVER-ONLY. Where the Instagram credential lives, and the only door to it.
 *
 * Nothing outside this module reads `PlatformAccount.refreshTokenEnc` or calls
 * `open()` on an Instagram value. A token's path from the database to a Graph
 * request passes through `credentialsFor`, which is the only function that can
 * produce one. `tests/publish-instagram.test.mts` checks that property by
 * grepping the folder, as the YouTube suite does for its own.
 *
 * WHAT IS STORED, AND WHERE (the existing `PlatformAccount` row, provider
 * `instagram`; no schema change):
 *
 *  - `refreshTokenEnc`: the long-lived PAGE access token, AES-256-GCM sealed.
 *    A Page token obtained from a long-lived user token does not expire, which is
 *    why Instagram has no refresh loop; the column is named for YouTube's
 *    credential and holds Instagram's durable one.
 *  - `accessTokenEnc` / `accessExpiresAt`: the long-lived USER token (about 60
 *    days), sealed, kept for ONE purpose: letting Disconnect ask Meta to revoke
 *    the whole grant, which Meta only honours from a user token. Nothing
 *    publishes with it.
 *  - `scope`: the permissions Meta says were GRANTED (not merely requested).
 *  - `externalAccountId`: the Instagram Business account id.
 *  - `externalAccountName`: its `@username`, as Instagram's API reported it
 *    during the connect (and as it re-reports it before every publish). It is
 *    written by this module from an API answer and by nothing else, which is
 *    what lets the identity verdict be computed from it.
 *
 * WHAT IS NEVER STORED: anything the operator typed into Facebook. This module
 * has no concept of a password and no field one could be put in.
 *
 * `connectionFor` is the shape the UI gets. There is no token field on it, not
 * even a redacted one: `ConnectionView` is the guard, and this module annotates
 * its return value with it.
 */
import crypto from "node:crypto";
import { assertModels, prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  displayHandle,
  identitySentence,
  judgeIdentity,
  normaliseHandle,
  type ConnectionView,
} from "../connect";
import { expectedHandle } from "../identity";
import { hashState, STATE_TTL_MS } from "../youtube/oauth";
import {
  instagramStateAad,
  instagramTokenAad,
  instagramUserAad,
  open,
  seal,
  type EnvLike,
} from "../youtube/secrets";
import { INSTAGRAM_PROVIDER, publicConfig, type ServerConfig } from "./config";
import {
  codeToShortToken,
  grantedPermissions,
  isInstagramApiError,
  listPages,
  pageInstagramAccount,
  revokeUserGrant,
  toLongLivedToken,
  type Fetcher,
  type InstagramAccountRef,
  type PageRef,
} from "./graph";

/** Raised when the stored grant cannot be used and the operator must reconnect. */
export class InstagramNotConnected extends AppError {
  constructor(message: string) {
    super("instagram_not_connected", message, 409);
  }
}

/** What the browser is told about a connection. No token, by construction. */
export type InstagramConnection = ConnectionView;

/**
 * The permissions without which the connection would look fine and every publish
 * would fail. Meta lets the operator untick any of them in the consent dialog, so
 * what was GRANTED is checked, not what was asked for.
 */
export const REQUIRED_PERMISSIONS = ["instagram_basic", "instagram_content_publish", "pages_show_list"] as const;

/** How many Pages are inspected for a linked Instagram account. A sane bound, not a limit anyone hits. */
const MAX_PAGES = 25;

function requireAccountModels(): void {
  try {
    assertModels("platformAccount", "oAuthState");
  } catch (err) {
    throw new AppError("publish_client_stale", err instanceof Error ? err.message : String(err), 503);
  }
}

type AccountRow = {
  id: string;
  userId: string;
  provider: string;
  refreshTokenEnc: string;
  accessTokenEnc: string | null;
  accessExpiresAt: Date | null;
  scope: string;
  externalAccountId: string | null;
  externalAccountName: string | null;
  revokedAt: Date | null;
  connectedAt: Date;
};

async function findAccount(userId: string): Promise<AccountRow | null> {
  const row = await prisma.platformAccount.findUnique({
    where: { userId_provider: { userId, provider: INSTAGRAM_PROVIDER } },
  });
  return (row as AccountRow | null) ?? null;
}

/**
 * Which account is this, according to Instagram.
 *
 * Computed from `externalAccountName`, which only this module writes and only
 * from a Graph answer (`storeGrant` at connect, `noteUsername` after the live
 * check). Instagram has no pre-verification legacy: every stored connection came
 * through this flow, so anything but a match blocks.
 */
function identityFor(
  row: AccountRow | null,
  env: EnvLike,
): Pick<
  InstagramConnection,
  "verifiedHandle" | "expectedHandle" | "identity" | "identityNote" | "identityBlocksPublish"
> {
  const expected = expectedHandle("instagram", env);
  if (!row) {
    return { verifiedHandle: null, expectedHandle: expected, identity: "unverified", identityNote: null, identityBlocksPublish: false };
  }
  const verified = displayHandle(row.externalAccountName) || null;
  const identity = judgeIdentity(verified, expected);
  return {
    verifiedHandle: verified,
    expectedHandle: expected,
    identity,
    identityNote: identitySentence("Instagram", identity, verified, expected),
    identityBlocksPublish: identity !== "match",
  };
}

/**
 * The connection, as a UI state.
 *
 * Never throws. Every failure (no environment, no row, a revoked row, a row
 * sealed with a key that has since changed, a grant missing the publish
 * permission) becomes `connected: false` with a `problem` sentence, because all
 * of them are answers the Publish Center has to render rather than errors it can
 * do anything about.
 */
export async function connectionFor(
  userId: string | null,
  env: EnvLike = process.env,
): Promise<InstagramConnection> {
  const config = publicConfig(env);
  const empty: InstagramConnection = {
    config,
    connected: false,
    channelId: null,
    channelTitle: null,
    connectedAt: null,
    scopes: [],
    problem: null,
    ...identityFor(null, env),
  };
  if (!userId) return empty;

  let row: AccountRow | null = null;
  try {
    row = await findAccount(userId);
  } catch {
    // A Prisma client that predates `PlatformAccount` must read as "not
    // connected", not as a 500 in the panel.
    return empty;
  }
  if (!row) return empty;

  const scopes = row.scope.split(/\s+/).filter((s) => s !== "");
  const base: InstagramConnection = {
    config,
    connected: false,
    channelId: row.externalAccountId,
    channelTitle: displayHandle(row.externalAccountName) || null,
    connectedAt: row.connectedAt.toISOString(),
    scopes,
    problem: null,
    ...identityFor(row, env),
  };

  if (row.revokedAt) {
    return { ...base, problem: "This connection was revoked. Connect Instagram again to publish." };
  }
  if (!scopes.includes("instagram_content_publish")) {
    return {
      ...base,
      problem: "This connection does not carry permission to publish. Disconnect and connect again to grant it.",
    };
  }
  if (!config.configured) {
    return {
      ...base,
      problem:
        "An Instagram connection is stored, but this server is missing what it needs to use it: " +
        `${config.missing.join(", ")}.`,
    };
  }
  // Can the sealed token actually be opened by THIS install's key? Asking now
  // means a changed key reads as "reconnect" in the panel rather than as a
  // failure in the middle of a publish.
  try {
    open(row.refreshTokenEnc, instagramTokenAad(userId), env);
  } catch (err) {
    return { ...base, problem: err instanceof Error ? err.message : String(err) };
  }

  return { ...base, connected: true };
}

// ------------------------------------------------------------------ the grant

/** What a completed consent produced. Credentials: only `storeGrant` may do anything with it. */
export interface InstagramGrant {
  pageId: string;
  pageName: string | null;
  /** The Page access token: the durable credential. */
  pageToken: string;
  /** The long-lived user token, kept only so Disconnect can revoke. */
  userToken: string;
  userTokenExpiresAt: Date | null;
  igUserId: string;
  username: string;
  /** The permissions Meta says were granted. */
  scope: string;
}

/** A Page with an Instagram professional account linked to it. */
interface Candidate {
  page: PageRef;
  ig: InstagramAccountRef;
}

/**
 * Choose which linked account to connect.
 *
 * When the operator manages several Pages with Instagram accounts, the one whose
 * username IS the expected handle wins, so a connection to a personal or client
 * account does not read as a false mismatch. When none matches the first is
 * taken, and the identity check then reports exactly that mismatch and blocks.
 * The choice only ever picks among accounts Instagram itself returned.
 */
export function pickAccount<T extends { ig: { username: string | null } }>(
  candidates: T[],
  expected: string,
): T | null {
  if (candidates.length === 0) return null;
  const want = normaliseHandle(expected);
  return candidates.find((c) => normaliseHandle(c.ig.username) === want) ?? candidates[0];
}

/**
 * Redeem the consent: code -> short-lived user token -> long-lived user token ->
 * the Pages -> the Instagram account linked to one of them -> its Page token.
 *
 * All of it server-side, with the app secret. Throws an error with a sentence an
 * operator can act on if the consent was incomplete (a permission unticked) or if
 * no Page has a linked Instagram professional account, which is the commonest
 * way for this to fail and has a fix in the message.
 */
export async function exchangeCode(
  config: ServerConfig,
  code: string,
  env: EnvLike = process.env,
  doFetch: Fetcher = fetch,
): Promise<InstagramGrant> {
  const shortToken = await codeToShortToken(config, code, doFetch, env);
  const long = await toLongLivedToken(config, shortToken, doFetch, env);

  // What was GRANTED, not what was asked for.
  const granted = await grantedPermissions(long.token, doFetch, env);
  const missingPermissions = REQUIRED_PERMISSIONS.filter((p) => !granted.includes(p));
  if (missingPermissions.length > 0) {
    throw new AppError(
      "missing_permission",
      `Meta did not grant ${missingPermissions.join(", ")}, so nothing was stored. ` +
        "Connect again and accept every permission on the consent screen.",
      409,
    );
  }

  const pages = (await listPages(long.token, doFetch, env)).slice(0, MAX_PAGES);
  const candidates: Candidate[] = [];
  let firstFailure: unknown = null;
  for (const page of pages) {
    try {
      const ig = await pageInstagramAccount(page.id, page.accessToken, doFetch, env);
      if (ig) candidates.push({ page, ig });
    } catch (err) {
      // One Page the token cannot read must not hide another that it can.
      firstFailure ??= err;
    }
  }

  const chosen = pickAccount(candidates, expectedHandle("instagram", env));
  if (!chosen) {
    if (pages.length > 0 && firstFailure && isInstagramApiError(firstFailure)) throw firstFailure;
    throw new AppError(
      "no_instagram_account",
      pages.length === 0
        ? "Meta returned no Facebook Pages for this login. Instagram publishing works through a Facebook Page " +
            "linked to an Instagram professional account: create or select the Page, accept it on the consent screen, then connect again."
        : `None of the ${pages.length} Facebook Page${pages.length === 1 ? "" : "s"} you granted has an Instagram Business or ` +
            "Creator account linked. Switch the Instagram account to professional (Settings, Account type), link it to " +
            "the Page (Page settings, Linked accounts), then connect again.",
      409,
    );
  }
  if (!chosen.ig.username) {
    throw new AppError(
      "no_instagram_account",
      "Instagram returned the linked account without a username, so it cannot be identified and nothing was stored.",
      409,
    );
  }

  return {
    pageId: chosen.page.id,
    pageName: chosen.page.name,
    pageToken: chosen.page.accessToken,
    userToken: long.token,
    userTokenExpiresAt: long.expiresIn ? new Date(Date.now() + long.expiresIn * 1000) : null,
    igUserId: chosen.ig.id,
    username: chosen.ig.username,
    scope: granted.join(" "),
  };
}

/** Store what a consent produced. Upsert, so reconnecting replaces rather than duplicates. */
export async function storeGrant(
  userId: string,
  grant: InstagramGrant,
  env: EnvLike = process.env,
): Promise<void> {
  requireAccountModels();
  if (!grant.pageToken || !grant.igUserId || !grant.username) {
    throw new InstagramNotConnected("Nothing was stored: that grant carried no Page token or Instagram account.");
  }
  const data = {
    refreshTokenEnc: seal(grant.pageToken, instagramTokenAad(userId), env),
    accessTokenEnc: seal(grant.userToken, instagramUserAad(userId), env),
    accessExpiresAt: grant.userTokenExpiresAt,
    scope: grant.scope,
    revokedAt: null,
    // The id and the handle Instagram reported for THIS grant, replacing whatever
    // an earlier grant said: a reconnect as a different account must not inherit
    // the previous one's verified handle.
    externalAccountId: grant.igUserId,
    externalAccountName: displayHandle(grant.username),
  };
  await prisma.platformAccount.upsert({
    where: { userId_provider: { userId, provider: INSTAGRAM_PROVIDER } },
    create: { userId, provider: INSTAGRAM_PROVIDER, ...data },
    update: data,
  });
}

/** The credential a Graph call needs, and the account it is for. Never leaves the server. */
export interface InstagramCredentials {
  igUserId: string;
  /** The username as last stored from an API answer; the caller re-checks it live. */
  username: string | null;
  /** THE PAGE TOKEN. A credential: an `access_token` parameter and nowhere else. */
  accessToken: string;
}

/**
 * The credential for this user, or `InstagramNotConnected` saying why not.
 *
 * THE RETURN VALUE IS A CREDENTIAL. Callers pass it to a Graph request and
 * nowhere else: not a log, not a thrown message, not a response.
 */
export async function credentialsFor(userId: string, env: EnvLike = process.env): Promise<InstagramCredentials> {
  requireAccountModels();
  const row = await findAccount(userId);
  if (!row) throw new InstagramNotConnected("No Instagram account is connected. Connect one to publish.");
  if (row.revokedAt) {
    throw new InstagramNotConnected("This Instagram connection was revoked. Connect Instagram again to publish.");
  }
  if (!row.externalAccountId) {
    throw new InstagramNotConnected("This Instagram connection has no account recorded. Connect Instagram again.");
  }
  let accessToken: string;
  try {
    accessToken = open(row.refreshTokenEnc, instagramTokenAad(userId), env);
  } catch (err) {
    throw new InstagramNotConnected(err instanceof Error ? err.message : "The stored credential cannot be read.");
  }
  return { igUserId: row.externalAccountId, username: row.externalAccountName, accessToken };
}

/**
 * Record the username Instagram just reported for this account.
 *
 * Called with the answer to the live `GET /{ig-user-id}?fields=username` check
 * made before a publish, so the stored handle tracks a rename instead of
 * silently going stale. Only an API answer is ever passed in.
 */
export async function noteUsername(userId: string, username: string): Promise<void> {
  await prisma.platformAccount
    .update({
      where: { userId_provider: { userId, provider: INSTAGRAM_PROVIDER } },
      data: { externalAccountName: displayHandle(username) },
    })
    .catch(() => {
      // The verdict was made from the API answer either way.
    });
}

/** Mark the grant unusable after Meta rejected the token (code 190). */
export async function markRevoked(userId: string): Promise<void> {
  await prisma.platformAccount
    .update({
      where: { userId_provider: { userId, provider: INSTAGRAM_PROVIDER } },
      data: { revokedAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Revoke at Meta, then forget locally.
 *
 * In that order, and the local delete happens even if the revoke failed: a
 * Disconnect that left a credential in the database because the network was down
 * would be the worse outcome. The report of a failed revoke is returned, not
 * swallowed, so the UI can say what is left to do. Meta only revokes from a USER
 * token, which is what `accessTokenEnc` is kept for; once that has expired (about
 * 60 days) the revoke cannot be asked for and the operator is told where to
 * remove the app themselves.
 */
export async function disconnect(
  userId: string,
  env: EnvLike = process.env,
  doFetch: Fetcher = fetch,
): Promise<{ revoked: boolean; detail: string | null; hadAccount: boolean }> {
  requireAccountModels();
  const row = await findAccount(userId);
  if (!row) return { revoked: true, detail: null, hadAccount: false };

  let result: { revoked: boolean; detail: string | null } = {
    revoked: false,
    detail: "The stored Meta permission has expired or could not be read, so Meta was not asked to revoke it.",
  };
  const live = row.accessTokenEnc && (!row.accessExpiresAt || row.accessExpiresAt.getTime() > Date.now());
  if (live) {
    try {
      const userToken = open(row.accessTokenEnc as string, instagramUserAad(userId), env);
      try {
        await revokeUserGrant(userToken, doFetch, env);
        result = { revoked: true, detail: null };
      } catch (err) {
        if (isInstagramApiError(err) && err.failure.code === "reauth_required") {
          // Already invalid at Meta: the grant is gone, which is what was asked for.
          result = { revoked: true, detail: null };
        } else {
          result = { revoked: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }
    } catch {
      // Keep the message above: an unreadable token cannot be revoked.
    }
  }

  await prisma.platformAccount
    .delete({ where: { userId_provider: { userId, provider: INSTAGRAM_PROVIDER } } })
    .catch(() => {});

  return { ...result, hadAccount: true };
}

// ------------------------------------------------------------------ OAuth state

/**
 * Start an authorisation: store the state hash and the sealed CSRF nonce.
 *
 * META'S WEB FLOW HAS NO PKCE, and none is invented here. What binds the
 * callback to the session that started it is `state`: 32 random bytes, stored
 * only as a SHA-256 hash, tied to the user, single-use and expiring. The nonce
 * sealed into `verifierEnc` is that same value, encrypted with a key and an AAD
 * (`instagram:state:<userId>`) of its own, so the row authenticates itself:
 * moving it to another user's record, or editing the hash column, makes the
 * redeem fail instead of redeeming.
 *
 * Expired rows are swept here rather than on a timer, as the YouTube flow does.
 */
export async function beginFlow(
  userId: string,
  stateHash: string,
  nonce: string,
  returnTo: string | null,
  env: EnvLike = process.env,
): Promise<void> {
  requireAccountModels();
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  await prisma.oAuthState.create({
    data: {
      stateHash,
      provider: INSTAGRAM_PROVIDER,
      userId,
      verifierEnc: seal(nonce, instagramStateAad(userId), env),
      returnTo,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
}

export interface RedeemedState {
  returnTo: string | null;
}

/** Constant-time string equality. */
function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Validate and consume a `state`.
 *
 * Five things must hold, and each is a different attack if it does not: the
 * state hashes to a row this server wrote (CSRF), the row has not expired (a
 * stale redirect), it belongs to the user whose session is making this request
 * (an authorisation grafted onto someone else's account), it is for THIS provider
 * (a YouTube state cannot be redeemed here), and the sealed nonce opens under
 * this user's AAD and equals the state presented.
 *
 * The row is deleted first, then checked, so it is single-use even under a
 * double callback.
 */
export async function redeemState(
  userId: string,
  state: string,
  env: EnvLike = process.env,
): Promise<RedeemedState> {
  requireAccountModels();
  const row = await prisma.oAuthState.findUnique({ where: { stateHash: hashState(state) } });
  if (!row) {
    throw new AppError(
      "bad_state",
      "This sign-in link is not one this server issued, or it has already been used. Start the connection again.",
      400,
    );
  }
  await prisma.oAuthState.delete({ where: { id: row.id } }).catch(() => {});

  if (row.expiresAt < new Date()) {
    throw new AppError("bad_state", "That connection attempt expired. Start it again.", 400);
  }
  if (row.userId !== userId || row.provider !== INSTAGRAM_PROVIDER) {
    throw new AppError(
      "bad_state",
      "That connection attempt was started by a different session. Start it again from this one.",
      400,
    );
  }

  let nonce: string;
  try {
    nonce = open(row.verifierEnc, instagramStateAad(userId), env);
  } catch (err) {
    throw new AppError("bad_state", err instanceof Error ? err.message : String(err), 400);
  }
  if (!sameString(nonce, state)) {
    throw new AppError("bad_state", "That connection attempt could not be verified. Start it again.", 400);
  }
  return { returnTo: row.returnTo };
}
