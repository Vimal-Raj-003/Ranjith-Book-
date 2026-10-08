/**
 * SERVER-ONLY. Where the credential lives, and the only door to it.
 *
 * Nothing outside this module reads `PlatformAccount.refreshTokenEnc` or calls
 * `open()` on it. That is the whole design: a token's path from the database to
 * an `Authorization` header passes through `accessTokenFor`, which is the only
 * function that can produce one, and which returns a bare string that no caller
 * of it ever serialises. Grepping for `refreshTokenEnc` outside this file
 * finding nothing is a checkable property, and
 * `tests/publish-youtube.test.mts` checks it.
 *
 * WHAT IS STORED, AND IN WHAT STATE:
 *  - the refresh token, AES-256-GCM sealed, bound to the user id;
 *  - the access token, sealed the same way, as a cache with an expiry;
 *  - the granted scope, in the clear, because it is not a secret and because
 *    "this connection predates the scope we now need" has to be legible;
 *  - what the platform told us about the account, after it told us.
 *
 * WHAT IS NEVER STORED: anything the operator typed into Google. This module
 * has no concept of a password and no field one could be put in.
 *
 * `connectionFor` is the shape the UI gets. Note what it does not contain:
 * there is no token field on it, not even a redacted one, so a careless
 * `NextResponse.json(connection)` cannot leak a credential. That is deliberate
 * — the type is the guard.
 */
import { assertModels, prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { ConnectionView } from "../connect";
import { YOUTUBE_PROVIDER, serverConfig, publicConfig, SCOPE_PARAM } from "./config";
import {
  accessAad,
  open,
  redact,
  refreshAad,
  seal,
  verifierAad,
  TokenUnreadable,
  type EnvLike,
} from "./secrets";
import {
  ACCESS_SKEW_MS,
  STATE_TTL_MS,
  YouTubeAuthError,
  hasUploadScope,
  hashState,
  refreshAccess,
  revokeToken,
  type Fetcher,
  type TokenSet,
} from "./oauth";

/** Raised when the stored grant cannot be used and the operator must reconnect. */
export class YouTubeNotConnected extends AppError {
  constructor(message: string) {
    super("youtube_not_connected", message, 409);
  }
}

/**
 * A dev server that booted before these tables existed holds a Prisma client
 * that has never heard of them, so `prisma.oAuthState` is `undefined` and the
 * next line is "Cannot read properties of undefined (reading 'findUnique')".
 *
 * `state.ts` already wraps this for the publish view; the OAuth routes do not
 * go through it, and without this the operator would see that raw sentence
 * after signing in at Google. Named, with the fix in the message, and a 503
 * because it is temporary.
 */
function requireAccountModels(): void {
  try {
    assertModels("platformAccount", "oAuthState");
  } catch (err) {
    throw new AppError("publish_client_stale", err instanceof Error ? err.message : String(err), 503);
  }
}

/**
 * What the browser is told about a connection. No token, by construction —
 * `ConnectionView` has no field one could go in, and this is that type rather
 * than a second declaration of it.
 */
export type YouTubeConnection = ConnectionView;

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
    where: { userId_provider: { userId, provider: YOUTUBE_PROVIDER } },
  });
  return (row as AccountRow | null) ?? null;
}

/**
 * The connection, as a UI state.
 *
 * Never throws. Every failure — no environment, no row, a revoked row, a row
 * sealed with a key that has since changed, a grant that is missing the upload
 * scope — becomes `connected: false` with a `problem` sentence, because all of
 * them are answers the Publish Center has to render rather than errors it can
 * do anything about.
 */
export async function connectionFor(
  userId: string | null,
  env: EnvLike = process.env,
): Promise<YouTubeConnection> {
  const config = publicConfig(env);
  const empty: YouTubeConnection = {
    config,
    connected: false,
    channelId: null,
    channelTitle: null,
    connectedAt: null,
    scopes: [],
    problem: null,
  };
  if (!userId) return empty;

  let row: AccountRow | null = null;
  try {
    row = await findAccount(userId);
  } catch {
    // A Prisma client that predates `PlatformAccount` (a long-running dev
    // server) must read as "not connected", not as a 500 in the panel.
    return { ...empty, problem: null };
  }
  if (!row) return empty;

  const scopes = row.scope.split(/\s+/).filter((s) => s !== "");
  const base: YouTubeConnection = {
    config,
    connected: false,
    channelId: row.externalAccountId,
    channelTitle: row.externalAccountName,
    connectedAt: row.connectedAt.toISOString(),
    scopes,
    problem: null,
  };

  if (row.revokedAt) {
    return { ...base, problem: "This connection was revoked. Connect YouTube again to publish." };
  }
  if (!hasUploadScope(row.scope)) {
    return {
      ...base,
      problem:
        "This connection does not carry permission to upload. Disconnect and connect again to grant it.",
    };
  }
  if (!config.configured) {
    return {
      ...base,
      problem:
        "A YouTube connection is stored, but this server is missing what it needs to use it: " +
        `${config.missing.join(", ")}.`,
    };
  }
  // Can the sealed token actually be opened by THIS install's key? Asking now
  // means a changed key reads as "reconnect" in the panel rather than as a
  // failure in the middle of an upload.
  try {
    open(row.refreshTokenEnc, refreshAad(userId), env);
  } catch (err) {
    return { ...base, problem: err instanceof Error ? err.message : String(err) };
  }

  return { ...base, connected: true };
}

/** Is there a usable grant? The question `Publisher.isConfigured()` asks. */
export async function isConnected(userId: string | null, env: EnvLike = process.env): Promise<boolean> {
  return (await connectionFor(userId, env)).connected;
}

/** Store what a consent produced. Upsert, so reconnecting replaces rather than duplicates. */
export async function storeGrant(
  userId: string,
  tokens: TokenSet,
  env: EnvLike = process.env,
): Promise<void> {
  requireAccountModels();
  if (!tokens.refreshToken) {
    throw new YouTubeNotConnected("Nothing was stored: that grant carried no refresh token.");
  }
  const data = {
    refreshTokenEnc: seal(tokens.refreshToken, refreshAad(userId), env),
    accessTokenEnc: seal(tokens.accessToken, accessAad(userId), env),
    accessExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
    revokedAt: null,
  };
  await prisma.platformAccount.upsert({
    where: { userId_provider: { userId, provider: YOUTUBE_PROVIDER } },
    create: { userId, provider: YOUTUBE_PROVIDER, ...data },
    update: data,
  });
}

/** Record what the platform said about the account, once it has said it. */
export async function noteChannel(userId: string, channelId: string | null, channelTitle: string | null): Promise<void> {
  if (!channelId && !channelTitle) return;
  await prisma.platformAccount
    .update({
      where: { userId_provider: { userId, provider: YOUTUBE_PROVIDER } },
      data: {
        ...(channelId ? { externalAccountId: channelId } : {}),
        ...(channelTitle ? { externalAccountName: channelTitle } : {}),
      },
    })
    .catch(() => {
      // Losing a channel label is not worth failing a successful upload over.
    });
}

/**
 * A usable access token for this user, refreshing if needed.
 *
 * THE RETURN VALUE IS A CREDENTIAL. Callers put it in an `Authorization`
 * header and nowhere else: not in a log, not in a thrown message, not in a
 * response. `redact()` exists for the cases where something about it has to be
 * said out loud.
 *
 * A refresh that Google refuses with `invalid_grant` MARKS THE ROW REVOKED
 * rather than leaving it to be retried forever. That is the revocation path: the
 * operator withdrew access in their Google account, and the honest local state
 * is "not connected", with a reconnect prompt.
 */
export async function accessTokenFor(
  userId: string,
  env: EnvLike = process.env,
  doFetch: Fetcher = fetch,
): Promise<string> {
  requireAccountModels();
  const config = serverConfig(env);
  if (!config) {
    const missing = publicConfig(env).missing.join(", ");
    throw new YouTubeNotConnected(`This server cannot talk to YouTube: ${missing} is not set.`);
  }
  const row = await findAccount(userId);
  if (!row) throw new YouTubeNotConnected("No YouTube account is connected. Connect one to publish.");
  if (row.revokedAt) {
    throw new YouTubeNotConnected("This YouTube connection was revoked. Connect YouTube again to publish.");
  }

  // The cached access token, if it is still good for long enough to be worth
  // using. `ACCESS_SKEW_MS` is why an upload does not start on a token with
  // twenty seconds left.
  if (row.accessTokenEnc && row.accessExpiresAt && row.accessExpiresAt.getTime() - Date.now() > ACCESS_SKEW_MS) {
    try {
      return open(row.accessTokenEnc, accessAad(userId), env);
    } catch {
      // A cache that cannot be opened is a cache miss, not a failure: the
      // refresh token below is the authority.
    }
  }

  let refreshToken: string;
  try {
    refreshToken = open(row.refreshTokenEnc, refreshAad(userId), env);
  } catch (err) {
    const why = err instanceof TokenUnreadable ? err.message : "The stored credential cannot be read.";
    throw new YouTubeNotConnected(why);
  }

  let fresh: TokenSet;
  try {
    fresh = await refreshAccess(config, refreshToken, row.scope, doFetch);
  } catch (err) {
    if (err instanceof YouTubeAuthError && err.failure.code === "reauth_required") {
      await prisma.platformAccount
        .update({
          where: { userId_provider: { userId, provider: YOUTUBE_PROVIDER } },
          data: { revokedAt: new Date(), accessTokenEnc: null, accessExpiresAt: null },
        })
        .catch(() => {});
      throw new YouTubeNotConnected(err.failure.message);
    }
    throw err;
  }

  await prisma.platformAccount
    .update({
      where: { userId_provider: { userId, provider: YOUTUBE_PROVIDER } },
      data: {
        accessTokenEnc: seal(fresh.accessToken, accessAad(userId), env),
        accessExpiresAt: fresh.expiresAt,
        // Google may rotate it; keep whatever the refresh told us.
        ...(fresh.refreshToken && fresh.refreshToken !== refreshToken
          ? { refreshTokenEnc: seal(fresh.refreshToken, refreshAad(userId), env) }
          : {}),
        scope: fresh.scope,
      },
    })
    .catch(() => {
      // Failing to cache is not failing to authorise.
    });

  return fresh.accessToken;
}

/**
 * Revoke at Google, then forget locally.
 *
 * In that order, and the local delete happens even if the revoke failed: a
 * Disconnect that left the credential in the database because the network was
 * down would be the worse of the two failures. The report of a failed revoke is
 * returned, not swallowed, so the UI can tell the operator to finish the job at
 * myaccount.google.com/permissions.
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
    detail: "The stored credential could not be read, so Google was not asked to revoke it.",
  };
  try {
    const refreshToken = open(row.refreshTokenEnc, refreshAad(userId), env);
    result = await revokeToken(refreshToken, doFetch);
  } catch {
    // Keep the message above: an unreadable token cannot be revoked, and the
    // operator needs to know to do it themselves.
  }

  await prisma.platformAccount
    .delete({ where: { userId_provider: { userId, provider: YOUTUBE_PROVIDER } } })
    .catch(() => {});

  return { ...result, hadAccount: true };
}

// ------------------------------------------------------------------ OAuth state

/**
 * Start an authorisation: store the state hash and the sealed verifier.
 *
 * Expired rows are swept here rather than on a timer — this is the only place
 * that creates them, so it is the natural place to clear the ones that were
 * never redeemed, and it costs one indexed delete.
 */
export async function beginFlow(
  userId: string,
  stateHash: string,
  verifier: string,
  returnTo: string | null,
  env: EnvLike = process.env,
): Promise<void> {
  requireAccountModels();
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  await prisma.oAuthState.create({
    data: {
      stateHash,
      provider: YOUTUBE_PROVIDER,
      userId,
      verifierEnc: seal(verifier, verifierAad(userId), env),
      returnTo,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
}

export interface RedeemedState {
  verifier: string;
  returnTo: string | null;
}

/**
 * Validate and consume a `state`.
 *
 * Four things must hold, and each one is a different attack if it does not:
 * the state must hash to a row this server wrote (CSRF), the row must not have
 * expired (a stale redirect), the row must belong to the user whose session is
 * making this request (an authorisation grafted onto someone else's account),
 * and the row must be for this provider.
 *
 * Deleting first, then checking, makes it single-use even under a double
 * callback: the second request finds nothing.
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
  if (row.userId !== userId || row.provider !== YOUTUBE_PROVIDER) {
    throw new AppError(
      "bad_state",
      "That connection attempt was started by a different session. Start it again from this one.",
      400,
    );
  }

  let verifier: string;
  try {
    verifier = open(row.verifierEnc, verifierAad(userId), env);
  } catch (err) {
    throw new AppError("bad_state", err instanceof Error ? err.message : String(err), 400);
  }
  return { verifier, returnTo: row.returnTo };
}

/** Re-exported so a caller never has to import `secrets.ts` to log safely. */
export { redact };
/** The scope this app asks for, for a UI that wants to show it. */
export const REQUESTED_SCOPE = SCOPE_PARAM;
