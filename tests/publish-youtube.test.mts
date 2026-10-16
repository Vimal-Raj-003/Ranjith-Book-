import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";
import { RENDER_DIR } from "../src/lib/paths";
import { serializeThumbnails, type ThumbSpec } from "../src/lib/thumbnails";
import { thumbsDir, THUMB_KEYS } from "../src/lib/thumbnails/types";
import {
  CONNECT_PARAM,
  CONNECT_REASON_PARAM,
  connectCopy,
  isConnectResult,
  type ConnectionView,
} from "../src/lib/publish/connect";
import {
  ENV,
  UPLOAD_PRIVACY,
  YOUTUBE_SCOPES,
  publicConfig,
  safeReturnTo,
  serverConfig,
  studioUrlFor,
  watchUrlFor,
} from "../src/lib/publish/youtube/config";
import {
  TokenKeyMissing,
  type EnvLike,
  TokenUnreadable,
  keyStatus,
  open,
  redact,
  refreshAad,
  seal,
} from "../src/lib/publish/youtube/secrets";
import {
  authorizeUrl,
  exchangeCode,
  hasUploadScope,
  hashState,
  makePkce,
  makeState,
  refreshAccess,
  revokeToken,
  YouTubeAuthError,
} from "../src/lib/publish/youtube/oauth";
import {
  mapApiError,
  mapTokenError,
  mapTransportError,
  type YouTubeFailure,
} from "../src/lib/publish/youtube/errors";
import {
  CHUNK_BYTES,
  YouTubeApiError,
  createSession,
  offsetFromRange,
  querySession,
  setThumbnail,
  uploadVideo,
} from "../src/lib/publish/youtube/upload";
import { tagsFrom, tagsLength, uploadTags, youTubePublisher, categoryId } from "../src/lib/publish/youtube/publisher";
import {
  accessTokenFor,
  beginFlow,
  connectionFor,
  disconnect,
  isConnected,
  redeemState,
  storeGrant,
} from "../src/lib/publish/youtube/accounts";
import { startYouTubePublish } from "../src/lib/publish/youtube/run";
import { hasRealPublisher, publisherFor } from "../src/lib/publish/registry";
import { loadEpisodeForPublish, publishView } from "../src/lib/publish/state";
import type { PublishRequest } from "../src/lib/publish/contract";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastHost } from "../src/components/Toast";
import * as cardModule from "../src/components/YouTubePublish";
import type { PlatformState } from "../src/lib/publish/view";
import { requireIsolation } from "./setup/isolation";

/**
 * The YouTube integration, tested against a MOCKED API BOUNDARY and never
 * against Google.
 *
 * NOTHING IN THIS FILE MAKES A NETWORK REQUEST. Every function that would is
 * given its `fetch` as an argument (`Fetcher`), and every test passes a stub
 * that asserts on what was sent and answers with a recorded shape. That is not
 * only a speed decision: a real upload would put a video on the operator's
 * channel, which is an external, irreversible action that a test suite has no
 * business performing. `the integration never reaches the real network` below
 * is the standing proof that the injection point exists everywhere it needs to.
 *
 * WHAT IS DELIBERATELY NOT PROVEN HERE, and is listed in the report as such:
 * that Google accepts these exact request shapes. A stub cannot refuse
 * something the real API would. What the stubs DO prove is that every answer
 * the API can give is handled, mapped to a distinct actionable message, and
 * recorded honestly — which is the half that is usually got wrong.
 */

const YT_DIR = fileURLToPath(new URL("../src/lib/publish/youtube/", import.meta.url));
const PUBLISH_DIR = fileURLToPath(new URL("../src/lib/publish/", import.meta.url));

/** A 32-byte key, so the crypto under test is the real thing. */
const KEY = crypto.randomBytes(32).toString("base64");

/** An environment that looks fully configured, with no real credentials in it. */
const CONFIGURED: EnvLike = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3013/api/publish/youtube/callback",
  BOOKREEL_TOKEN_KEY: KEY,
};

// ------------------------------------------------------------- client safety

/**
 * `connect.ts` is loaded in the browser, so anything it imports is too. The
 * same trap `limits.ts` is held to, for the same 500.
 */
test("connect.ts has no imports at all: a client component loads it", async () => {
  const source = await fs.readFile(path.join(PUBLISH_DIR, "connect.ts"), "utf8");
  // Line-anchored, unlike `limits.ts`'s own version of this check: the copy in
  // this module contains the English word "from" ("deletes it from this
  // server"), and a pattern allowed to span newlines reads that as an
  // `export ... from` and fails on prose.
  assert.doesNotMatch(source, /^\s*import\b/m, "connect.ts must import nothing: the browser loads it");
  assert.doesNotMatch(
    source,
    /^\s*export\b[^\n;]*\bfrom\s*["']/m,
    "connect.ts must re-export nothing either: the browser loads it",
  );
});

/**
 * The type is the guard. A `ConnectionView` with no field a token could go in
 * cannot leak one however careless a route is — so this asserts the shape
 * rather than trusting the route.
 */
test("the connection the browser is given has no field a credential could sit in", async () => {
  requireIsolation("this test creates a user and a stored grant");
  const user = await prisma.user.create({ data: { email: `yt-${randomUUID()}@example.test` } });
  try {
    await storeGrant(
      user.id,
      {
        accessToken: "ya29.ACCESS-TOKEN-VALUE",
        refreshToken: "1//REFRESH-TOKEN-VALUE",
        expiresAt: new Date(Date.now() + 3600_000),
        scope: YOUTUBE_SCOPES[0],
      },
      CONFIGURED,
    );
    const view: ConnectionView = await connectionFor(user.id, CONFIGURED);
    assert.equal(view.connected, true);

    const wire = JSON.stringify(view);
    assert.ok(!wire.includes("REFRESH-TOKEN-VALUE"), "the refresh token must not cross the wire");
    assert.ok(!wire.includes("ACCESS-TOKEN-VALUE"), "the access token must not cross the wire");
    assert.ok(!wire.includes("test-client-secret"), "the client secret must not cross the wire");
    assert.ok(!wire.includes(KEY), "the encryption key must not cross the wire");
    assert.deepEqual(
      Object.keys(view).sort(),
      [
        "channelId",
        "channelTitle",
        "config",
        "connected",
        "connectedAt",
        "expectedHandle",
        "identity",
        "identityBlocksPublish",
        "identityNote",
        "problem",
        "scopes",
        "verifiedHandle",
      ],
      "a new field on the connection view is a deliberate decision, not an accident (identity fields added deliberately)",
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

/**
 * The stored token is read in exactly one module. If a second one starts
 * calling `open()` on it, the "one door to the credential" claim stops being
 * true and this fails.
 */
/** Comments say things about tokens; code reads them. Only the code is the claim. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

test("only accounts.ts ever reads the stored refresh token", async () => {
  const offenders: string[] = [];
  for (const dir of [YT_DIR, PUBLISH_DIR]) {
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".ts") || name === "accounts.ts") continue;
      const full = path.join(dir, name);
      if ((await fs.stat(full)).isDirectory()) continue;
      const source = withoutComments(await fs.readFile(full, "utf8"));
      if (/refreshTokenEnc/.test(source)) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], `the refresh token is read only in accounts.ts, not in: ${offenders.join(", ")}`);
});

/** No module may hold a credential in a module-level variable. */
test("no module caches a token outside the database", async () => {
  const offenders: string[] = [];
  for (const name of await fs.readdir(YT_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const source = await fs.readFile(path.join(YT_DIR, name), "utf8");
    // A module-scope `let` holding something token-shaped is the shape of the
    // bug: it survives requests and outlives a disconnect.
    for (const m of source.matchAll(/^(?:let|var)\s+(\w*[Tt]oken\w*)/gm)) offenders.push(`${name}:${m[1]}`);
  }
  assert.deepEqual(offenders, [], `a cached token outlives a disconnect: ${offenders.join(", ")}`);
});

// --------------------------------------------------------------- the envelope

test("a sealed credential round-trips, and only with the right key, purpose and user", () => {
  const secret = "1//0gREFRESH";
  const sealed = seal(secret, refreshAad("user-a"), CONFIGURED);

  assert.notEqual(sealed, secret, "nothing is stored in the clear");
  assert.ok(!sealed.includes(secret));
  assert.match(sealed, /^v1\./, "versioned, so a future rotation can read old rows");
  assert.equal(open(sealed, refreshAad("user-a"), CONFIGURED), secret);

  // A row copied into another user's record does not decrypt: that is the AAD
  // doing its job, and without it this would be privilege escalation inside one
  // database.
  assert.throws(() => open(sealed, refreshAad("user-b"), CONFIGURED), TokenUnreadable);
  // A different install's key cannot read it.
  const other = { ...CONFIGURED, BOOKREEL_TOKEN_KEY: crypto.randomBytes(32).toString("base64") };
  assert.throws(() => open(sealed, refreshAad("user-a"), other), TokenUnreadable);
});

test("a tampered or truncated envelope is refused, not silently mis-decrypted", () => {
  const sealed = seal("secret-value", refreshAad("u"), CONFIGURED);
  const parts = sealed.split(".");

  // One flipped byte of ciphertext. GCM's tag is what makes this a refusal.
  const body = Buffer.from(parts[3], "base64url");
  body[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], body.toString("base64url")].join(".");
  assert.throws(() => open(tampered, refreshAad("u"), CONFIGURED), TokenUnreadable);

  for (const bad of ["", "not-sealed", "v2.a.b.c", parts.slice(0, 3).join("."), `${sealed}.extra`]) {
    assert.throws(() => open(bad, refreshAad("u"), CONFIGURED), TokenUnreadable, `refused: ${bad.slice(0, 12)}`);
  }
});

test("an install with no key cannot hold a credential, and says which variable", () => {
  const bare: EnvLike = {};
  const status = keyStatus(bare);
  assert.equal(status.ok, false);
  assert.match(status.reason!, /BOOKREEL_TOKEN_KEY/);
  assert.ok(!status.reason!.includes(KEY), "the reason never quotes a value");
  assert.throws(() => seal("x", "aad", bare), TokenKeyMissing);

  // A short "key" is refused rather than silently accepted: protecting a
  // refresh token with six characters protects nothing.
  assert.equal(keyStatus({ BOOKREEL_TOKEN_KEY: "hunter2" }).ok, false);
});

test("the key is accepted as 32 raw bytes in hex or base64, or derived from a long passphrase", () => {
  const forms = [
    crypto.randomBytes(32).toString("hex"),
    crypto.randomBytes(32).toString("base64"),
    crypto.randomBytes(32).toString("base64url"),
    "a-passphrase-that-is-at-least-thirty-two-characters-long",
  ];
  for (const value of forms) {
    const env = { BOOKREEL_TOKEN_KEY: value };
    assert.equal(keyStatus(env).ok, true, `accepted: ${value.length} chars`);
    assert.equal(open(seal("round", "aad", env), "aad", env), "round");
  }
});

test("redact cannot be turned back into the secret", () => {
  const secret = "1//0gVERY-SECRET-REFRESH-TOKEN";
  const shown = redact(secret);
  assert.ok(!shown.includes(secret));
  assert.ok(!shown.includes("SECRET"));
  assert.match(shown, /redacted \d+ chars/);
  // Same input, same digest: enough to tell "the same token" from "a different
  // one" while debugging, and no more.
  assert.equal(redact(secret), shown);
  assert.notEqual(redact(`${secret}x`), shown);
  assert.equal(redact(null), "(none)");
});

// ------------------------------------------------------------ configuration

test("an unconfigured install names every variable it is missing, and no values", () => {
  const config = publicConfig({});
  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, [ENV.clientId, ENV.clientSecret, ENV.redirectUri, ENV.tokenKey]);
  assert.equal(serverConfig({}), null);

  // One at a time, so each absence is reported on its own.
  for (const key of [ENV.clientId, ENV.clientSecret, ENV.redirectUri, ENV.tokenKey] as const) {
    const env = { ...CONFIGURED };
    delete env[key];
    const partial = publicConfig(env);
    assert.equal(partial.configured, false, `${key} missing must not read as configured`);
    assert.deepEqual(partial.missing, [key]);
    assert.equal(serverConfig(env), null, `${key} missing must not yield a server config`);
  }
  assert.equal(publicConfig(CONFIGURED).configured, true);
});

test("the redirect target is app-relative or refused: the callback is not an open redirector", () => {
  for (const good of ["/", "/studio", "/studio?e=1#x"]) assert.equal(safeReturnTo(good), good);
  for (const bad of [
    "https://evil.test",
    "http://evil.test",
    "//evil.test",
    "\\\\evil.test",
    "/ok\nLocation: https://evil.test",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(safeReturnTo(bad), null, `refused: ${String(bad).slice(0, 20)}`);
  }
});

test("the app asks for the upload scope, plus read-only for identity verification, and upload gating is unchanged", () => {
  // ADDITIVE: youtube.readonly was appended; youtube.upload is still first.
  assert.deepEqual([...YOUTUBE_SCOPES], [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);
  assert.equal(hasUploadScope("https://www.googleapis.com/auth/youtube.upload"), true);
  // Upload still REQUIRES the upload scope: read-only alone must not gate in.
  assert.equal(hasUploadScope("https://www.googleapis.com/auth/youtube.readonly"), false);
  assert.equal(hasUploadScope(""), false);
});

test("review-first is a constant, and nothing in the integration writes any other privacy", async () => {
  assert.equal(UPLOAD_PRIVACY, "private");
  const offenders: string[] = [];
  for (const name of await fs.readdir(YT_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const source = await fs.readFile(path.join(YT_DIR, name), "utf8");
    // A literal `"public"` or `"unlisted"` beside a privacy field is the bug.
    for (const m of source.matchAll(/privacyStatus\s*[:=]\s*["'](\w+)["']/g)) {
      if (m[1] !== "private") offenders.push(`${name}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `nothing may upload as anything but private: ${offenders.join(", ")}`);
});

test("the studio and watch URLs are built from the platform's own id", () => {
  assert.equal(studioUrlFor("abc123"), "https://studio.youtube.com/video/abc123/edit");
  assert.equal(watchUrlFor("abc123"), "https://www.youtube.com/watch?v=abc123");
  // An id is encoded, not interpolated, so nothing can smuggle a path.
  assert.ok(!studioUrlFor("../../evil").includes("../"));
});

// ---------------------------------------------------------------- PKCE, state

test("PKCE is S256 of a server-generated verifier, and the verifier never reaches the URL", () => {
  const pkce = makePkce();
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128, "within RFC 7636's range");
  assert.equal(pkce.challenge, crypto.createHash("sha256").update(pkce.verifier).digest("base64url"));
  assert.notEqual(makePkce().verifier, pkce.verifier, "a fresh verifier per flow");

  const url = new URL(authorizeUrl({ clientId: "cid", clientSecret: "SECRET", redirectUri: "/cb" }, "st8", pkce.challenge));
  assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st8");
  assert.equal(url.searchParams.get("access_type"), "offline", "a refresh token, or the install breaks in an hour");
  assert.equal(url.searchParams.get("prompt"), "consent", "without it a second connect returns no refresh token");
  assert.equal(url.searchParams.get("response_type"), "code");
  // The two things that must never be in an address bar.
  assert.ok(!url.search.includes("SECRET"), "the client secret is not in the authorize URL");
  assert.ok(!url.search.includes(pkce.verifier), "the verifier is not in the authorize URL");
});

test("state is stored hashed, is single-use, expires, and is bound to the session that started it", async () => {
  requireIsolation("this test creates users and OAuth state rows");
  const a = await prisma.user.create({ data: { email: `yt-a-${randomUUID()}@example.test` } });
  const b = await prisma.user.create({ data: { email: `yt-b-${randomUUID()}@example.test` } });
  try {
    const { state, stateHash } = makeState();
    await beginFlow(a.id, stateHash, "verifier-value", "/studio", CONFIGURED);

    const stored = await prisma.oAuthState.findUnique({ where: { stateHash } });
    assert.ok(stored, "stored under the hash, not the value");
    assert.equal(stateHash, hashState(state));
    assert.ok(!stored!.verifierEnc.includes("verifier-value"), "the verifier is sealed, not stored in the clear");
    assert.equal(await prisma.oAuthState.count({ where: { stateHash: state } }), 0, "never the raw state");

    // Another session may not redeem it.
    await assert.rejects(() => redeemState(b.id, state, CONFIGURED), /different session/);
    // ...and redeeming consumed it, so even the right user cannot replay it.
    await assert.rejects(() => redeemState(a.id, state, CONFIGURED), /already been used|not one this server issued/);

    // The happy path, and the expiry.
    const second = makeState();
    await beginFlow(a.id, second.stateHash, "v2", null, CONFIGURED);
    const redeemed = await redeemState(a.id, second.state, CONFIGURED);
    assert.equal(redeemed.verifier, "v2");
    assert.equal(redeemed.returnTo, null);

    const third = makeState();
    await beginFlow(a.id, third.stateHash, "v3", null, CONFIGURED);
    await prisma.oAuthState.update({
      where: { stateHash: third.stateHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await assert.rejects(() => redeemState(a.id, third.state, CONFIGURED), /expired/);

    // An invented state matches nothing.
    await assert.rejects(() => redeemState(a.id, "made-up", CONFIGURED), /not one this server issued/);
  } finally {
    await prisma.user.delete({ where: { id: a.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: b.id } }).catch(() => {});
  }
});

// -------------------------------------------------------------- token exchange

interface StubAnswer {
  status: number;
  body?: unknown;
  /** `undefined` values are dropped, so a branch may omit a header by name. */
  headers?: Record<string, string | undefined>;
}

/** A `fetch` stub that records what it was asked and answers from a script. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => StubAnswer) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const answer = handler(url, init);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer.headers ?? {})) if (v !== undefined) headers[k] = v;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers,
    });
  }) as typeof fetch;
  return { impl, calls };
}

const CONFIG = { clientId: "cid", clientSecret: "csecret", redirectUri: "http://localhost:3013/cb" };

test("the code exchange happens server-side, with the secret and the verifier", async () => {
  const stub = stubFetch(() => ({
    status: 200,
    body: {
      access_token: "ya29.new",
      refresh_token: "1//new",
      expires_in: 3599,
      scope: YOUTUBE_SCOPES[0],
      token_type: "Bearer",
    },
  }));
  const set = await exchangeCode(CONFIG, "auth-code", "the-verifier", stub.impl);

  assert.equal(set.accessToken, "ya29.new");
  assert.equal(set.refreshToken, "1//new");
  assert.equal(set.scope, YOUTUBE_SCOPES[0]);
  assert.ok(set.expiresAt.getTime() > Date.now() + 3_000_000);

  assert.equal(stub.calls.length, 1);
  const sent = new URLSearchParams(String(stub.calls[0].init?.body));
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "auth-code");
  assert.equal(sent.get("code_verifier"), "the-verifier");
  assert.equal(sent.get("client_secret"), "csecret", "the secret goes to Google from the server, and nowhere else");
  assert.equal(stub.calls[0].url, "https://oauth2.googleapis.com/token");
});

test("a consent that returns no refresh token is REFUSED, not stored as a one-hour connection", async () => {
  const stub = stubFetch(() => ({ status: 200, body: { access_token: "ya29.only", expires_in: 3599 } }));
  await assert.rejects(
    () => exchangeCode(CONFIG, "code", "verifier", stub.impl),
    (err: unknown) => {
      assert.ok(err instanceof YouTubeAuthError);
      assert.equal(err.failure.code, "not_connected");
      assert.match(err.message, /myaccount\.google\.com\/permissions/, "and the fix is in the message");
      return true;
    },
  );
});

test("every way the token endpoint can refuse maps to its own action", async () => {
  const cases: Array<[number, Record<string, unknown>, YouTubeFailure, RegExp]> = [
    [400, { error: "invalid_grant" }, "reauth_required", /Disconnect and connect YouTube again/],
    [401, { error: "invalid_client" }, "not_configured", /GOOGLE_CLIENT_ID/],
    [400, { error: "redirect_uri_mismatch" }, "not_configured", /GOOGLE_OAUTH_REDIRECT_URI/],
    [400, { error: "access_denied" }, "not_connected", /declined/],
    [503, { error: "backend_error" }, "platform_error", /HTTP 503/],
  ];
  const seen = new Set<string>();
  for (const [status, body, code, matcher] of cases) {
    const mapped = mapTokenError(status, body);
    assert.equal(mapped.code, code, JSON.stringify(body));
    assert.match(mapped.message, matcher);
    assert.ok(!seen.has(mapped.message), "no two refusals share a sentence");
    seen.add(mapped.message);
  }
});

test("a refresh keeps the refresh token it was given, and a withdrawn grant is recorded as revoked", async () => {
  requireIsolation("this test stores and refreshes a grant");
  const user = await prisma.user.create({ data: { email: `yt-r-${randomUUID()}@example.test` } });
  try {
    const kept = await refreshAccess(
      CONFIG,
      "1//keepme",
      YOUTUBE_SCOPES[0],
      stubFetch(() => ({ status: 200, body: { access_token: "ya29.fresh", expires_in: 3599 } })).impl,
    );
    assert.equal(kept.refreshToken, "1//keepme", "a refresh response omits it; the stored one stands");
    assert.equal(kept.accessToken, "ya29.fresh");

    // Now the revocation path, end to end: a stored grant that Google refuses
    // with invalid_grant must become "not connected", with a reconnect prompt,
    // rather than being retried forever.
    await storeGrant(
      user.id,
      {
        accessToken: "ya29.stale",
        refreshToken: "1//revoked",
        // Already expired, so a refresh is forced.
        expiresAt: new Date(Date.now() - 1000),
        scope: YOUTUBE_SCOPES[0],
      },
      CONFIGURED,
    );
    assert.equal(await isConnected(user.id, CONFIGURED), true, "stored and usable before Google refuses");

    const refuse = stubFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
    await assert.rejects(() => accessTokenFor(user.id, CONFIGURED, refuse.impl), /connect YouTube again/);

    const after = await connectionFor(user.id, CONFIGURED);
    assert.equal(after.connected, false, "a withdrawn grant is not a connection");
    assert.match(after.problem!, /revoked/i);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test("a cached access token is reused, and refreshed once it is close to expiring", async () => {
  requireIsolation("this test stores a grant");
  const user = await prisma.user.create({ data: { email: `yt-c-${randomUUID()}@example.test` } });
  try {
    await storeGrant(
      user.id,
      { accessToken: "ya29.cached", refreshToken: "1//r", expiresAt: new Date(Date.now() + 3600_000), scope: YOUTUBE_SCOPES[0] },
      CONFIGURED,
    );
    const never = stubFetch(() => {
      throw new Error("a valid cached token must not cost a refresh");
    });
    assert.equal(await accessTokenFor(user.id, CONFIGURED, never.impl), "ya29.cached");
    assert.equal(never.calls.length, 0);

    // Thirty seconds left is not enough for a 38 MB upload, so it refreshes.
    await prisma.platformAccount.update({
      where: { userId_provider: { userId: user.id, provider: "youtube" } },
      data: { accessExpiresAt: new Date(Date.now() + 30_000) },
    });
    const refreshed = stubFetch(() => ({ status: 200, body: { access_token: "ya29.margin", expires_in: 3599 } }));
    assert.equal(await accessTokenFor(user.id, CONFIGURED, refreshed.impl), "ya29.margin");
    assert.equal(refreshed.calls.length, 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test("Disconnect revokes at Google and then forgets locally, and reports a revoke that did not land", async () => {
  requireIsolation("this test stores and removes a grant");
  const user = await prisma.user.create({ data: { email: `yt-d-${randomUUID()}@example.test` } });
  try {
    await storeGrant(
      user.id,
      { accessToken: "ya29.a", refreshToken: "1//revoke-me", expiresAt: new Date(Date.now() + 3600_000), scope: YOUTUBE_SCOPES[0] },
      CONFIGURED,
    );
    const revoking = stubFetch((url, init) => {
      assert.equal(url, "https://oauth2.googleapis.com/revoke");
      assert.equal(new URLSearchParams(String(init?.body)).get("token"), "1//revoke-me");
      return { status: 200, body: {} };
    });
    const result = await disconnect(user.id, CONFIGURED, revoking.impl);
    assert.equal(result.revoked, true);
    assert.equal(result.hadAccount, true);
    assert.equal(revoking.calls.length, 1, "Google was actually asked");
    assert.equal(
      await prisma.platformAccount.count({ where: { userId: user.id } }),
      0,
      "and the credential is gone from here",
    );
    assert.equal((await connectionFor(user.id, CONFIGURED)).connected, false);

    // A revoke that fails still clears the local row, and says so.
    await storeGrant(
      user.id,
      { accessToken: "ya29.b", refreshToken: "1//stuck", expiresAt: new Date(Date.now() + 3600_000), scope: YOUTUBE_SCOPES[0] },
      CONFIGURED,
    );
    const failing = stubFetch(() => ({ status: 500, body: { error: "backend_error" } }));
    const partial = await disconnect(user.id, CONFIGURED, failing.impl);
    assert.equal(partial.revoked, false);
    assert.ok(partial.detail && partial.detail.length > 0, "and the reason is reported, not swallowed");
    assert.equal(await prisma.platformAccount.count({ where: { userId: user.id } }), 0, "the local row goes anyway");

    // An already-invalid token is a successful revoke: the grant is gone.
    const already = stubFetch(() => ({ status: 400, body: { error: "invalid_token" } }));
    assert.equal((await revokeToken("gone", already.impl)).revoked, true);
    // Disconnecting with nothing stored is not an error.
    const none = await disconnect(user.id, CONFIGURED, stubFetch(() => ({ status: 200 })).impl);
    assert.equal(none.hadAccount, false);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

// ---------------------------------------------------------------- error mapping

test("every API refusal maps to its own code, its own sentence, and its own next step", () => {
  const cases: Array<[number, unknown, YouTubeFailure, RegExp]> = [
    [403, { error: { errors: [{ reason: "quotaExceeded" }] } }, "quota_exceeded", /quota/i],
    [403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } }, "quota_exceeded", /midnight Pacific/],
    [429, {}, "rate_limited", /Wait a minute/],
    [401, { error: { errors: [{ reason: "authError" }] } }, "reauth_required", /Disconnect and connect/],
    [403, { error: { errors: [{ reason: "youtubeSignupRequired" }] } }, "no_channel", /no YouTube channel/],
    [403, { error: { errors: [{ reason: "uploadLimitExceeded" }] } }, "forbidden", /upload limit/],
    [403, { error: { errors: [{ reason: "videoNeedsVerifiedAccount" }] } }, "channel_unverified", /youtube\.com\/verify/],
    [400, { error: { errors: [{ reason: "thumbnailSizeTooBig" }] } }, "invalid_metadata", /thumbnail image/],
    [403, { error: { errors: [{ reason: "forbidden" }] } }, "forbidden", /not permitted/],
    [404, {}, "upload_session_gone", /no longer exists/],
    [413, {}, "file_too_large", /256 GB/],
    [400, { error: { errors: [{ reason: "invalidVideoMetadata" }] } }, "invalid_metadata", /refused the metadata/],
    [500, {}, "platform_error", /server error/],
  ];
  // Per CODE, not per case: `quotaExceeded` and `dailyLimitExceeded` are the
  // same failure with the same next step, and giving them two sentences would
  // be noise. What must never happen is two DIFFERENT codes sharing a sentence,
  // because then the operator cannot tell the two situations apart.
  const sentences = new Map<string, YouTubeFailure>();
  for (const [status, body, code, matcher] of cases) {
    const mapped = mapApiError(status, body, "upload");
    assert.equal(mapped.code, code, `${status} ${JSON.stringify(body)}`);
    assert.match(mapped.message, matcher);
    assert.ok(/[.!]/.test(mapped.message), "a whole sentence");
    const owner = sentences.get(mapped.message);
    assert.ok(
      owner === undefined || owner === mapped.code,
      `${owner} and ${mapped.code} share a sentence: ${mapped.message}`,
    );
    sentences.set(mapped.message, mapped.code);
  }
  assert.equal(new Set(sentences.values()).size, new Set(cases.map(([, , c]) => c)).size, "every code is covered");
  // Only the ones a retry could fix say so.
  assert.equal(mapApiError(429, {}).retryable, true);
  assert.equal(mapApiError(500, {}).retryable, true);
  assert.equal(mapApiError(403, { error: { errors: [{ reason: "quotaExceeded" }] } }).retryable, false);
});

test("a lost connection is its own failure, and says a retry will resume", () => {
  const cold = mapTransportError(new Error("socket hang up"));
  assert.equal(cold.code, "network");
  assert.equal(cold.retryable, true);
  const warm = mapTransportError(new Error("ECONNRESET"), 16 * 1_048_576);
  assert.match(warm.message, /16 MB had been accepted/);
  assert.match(warm.message, /resumes from there/);
});

test("YouTube's own words are carried through, capped, and never a credential", () => {
  const long = "x".repeat(900);
  const mapped = mapApiError(400, { error: { message: long } });
  assert.ok(mapped.message.length < 500, "Google's sentence is capped, not pasted whole");
  assert.match(mapped.message, /YouTube said:/);
});

// ---------------------------------------------------------- the resumable upload

/** A mock resumable endpoint that behaves like the protocol: ranges and all. */
function uploadMock(opts: { chunkFails?: number; totalBytes: number; videoId?: string } = { totalBytes: 0 }) {
  const SESSION = "https://upload.example.test/session/abc";
  let held = 0;
  let failures = opts.chunkFails ?? 0;
  const ranges: string[] = [];
  const stub = stubFetch((url, init) => {
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
      assert.match(url, /uploadType=resumable/);
      assert.match(url, /part=snippet%2Cstatus/);
      const body = JSON.parse(String(init?.body)) as { status?: { privacyStatus?: string } };
      assert.equal(body.status?.privacyStatus, "private", "never anything but private");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["X-Upload-Content-Length"], String(opts.totalBytes));
      return { status: 200, headers: { location: SESSION } };
    }
    if (url === SESSION) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers["Content-Range"];
      ranges.push(range);
      if (/^bytes \*\//.test(range)) {
        // A status query.
        return held >= opts.totalBytes
          ? { status: 200, body: { id: opts.videoId ?? "vid-1", snippet: {}, status: { privacyStatus: "private" } } }
          : { status: 308, headers: held > 0 ? { range: `bytes=0-${held - 1}` } : {} };
      }
      if (failures > 0) {
        failures -= 1;
        return { status: 503, body: { error: { message: "transient" } } };
      }
      const m = /^bytes (\d+)-(\d+)\//.exec(range)!;
      assert.equal(Number(m[1]), held, "a resumed upload sends from where YouTube actually is");
      held = Number(m[2]) + 1;
      if (held >= opts.totalBytes) {
        return {
          status: 200,
          body: {
            id: opts.videoId ?? "vid-1",
            snippet: { channelId: "UCchan", channelTitle: "The Channel" },
            status: { privacyStatus: "private" },
          },
        };
      }
      return { status: 308, headers: { range: `bytes=0-${held - 1}` } };
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  return {
    ...stub,
    session: SESSION,
    ranges,
    get held() {
      return held;
    },
    prefill(bytes: number) {
      held = bytes;
    },
  };
}

test("a Range header is read as the platform's own accounting, and an absent one means zero", () => {
  assert.equal(offsetFromRange("bytes=0-8388607"), 8_388_608);
  assert.equal(offsetFromRange("bytes=0-0"), 1);
  assert.equal(offsetFromRange(null), 0, "no Range on a 308 means YouTube holds nothing");
  assert.equal(offsetFromRange("nonsense"), 0);
});

/** A real file, so the chunking reads real bytes rather than being told about them. */
async function tempVideo(bytes: number): Promise<string> {
  requireIsolation("this test writes a video fixture under the work root");
  await fs.mkdir(RENDER_DIR, { recursive: true });
  const file = path.join(RENDER_DIR, `yt-${randomUUID()}.mp4`);
  await fs.writeFile(file, Buffer.alloc(bytes, 7));
  return file;
}

const SNIPPET = { title: "T", description: "D", tags: ["focus"], categoryId: "27" };

test("the upload is chunked, and the progress reported is the bytes YouTube acknowledged", async () => {
  const total = CHUNK_BYTES * 2 + 1024;
  const file = await tempVideo(total);
  try {
    const mock = uploadMock({ totalBytes: total });
    const progress: Array<[number, number]> = [];
    let session: string | null = null;

    const result = await uploadVideo(
      "ya29.token",
      file,
      total,
      "video/mp4",
      SNIPPET,
      {
        onSession: (url) => {
          session = url;
        },
        onProgress: (sent, all) => {
          progress.push([sent, all]);
        },
      },
      mock.impl,
    );

    assert.equal(result.videoId, "vid-1");
    assert.equal(result.channelTitle, "The Channel");
    assert.equal(result.privacyStatus, "private");
    assert.equal(session, mock.session, "the session is handed back so a retry can resume");

    // Three chunks for 2 chunks + 1 KB, and every reported number is a real
    // boundary — never an interpolation and never a round percentage.
    assert.deepEqual(
      progress.map(([sent]) => sent),
      [CHUNK_BYTES, CHUNK_BYTES * 2, total],
    );
    for (const [sent, all] of progress) {
      assert.equal(all, total);
      assert.ok(sent <= all, "progress never exceeds the file");
    }
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("a retry RESUMES: only the bytes YouTube does not have are sent again", async () => {
  const total = CHUNK_BYTES * 3;
  const file = await tempVideo(total);
  try {
    const mock = uploadMock({ totalBytes: total });
    // YouTube already holds the first two chunks from a previous attempt.
    mock.prefill(CHUNK_BYTES * 2);

    const sent: number[] = [];
    const result = await uploadVideo(
      "ya29.token",
      file,
      total,
      "video/mp4",
      SNIPPET,
      {
        resumeFrom: mock.session,
        onProgress: (bytes) => {
          sent.push(bytes);
        },
      },
      mock.impl,
    );
    assert.equal(result.videoId, "vid-1");

    // One PUT of data, and no new session was opened.
    const dataPuts = mock.ranges.filter((r) => !/^bytes \*\//.test(r));
    assert.deepEqual(dataPuts, [`bytes ${CHUNK_BYTES * 2}-${total - 1}/${total}`]);
    assert.equal(
      mock.calls.filter((c) => c.url.includes("/upload/youtube/v3/videos")).length,
      0,
      "a resumable session that is still alive is not replaced",
    );
    assert.deepEqual(sent, [CHUNK_BYTES * 2, total]);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("resuming a session YouTube has already finished uploads NOTHING and returns the id", async () => {
  const total = CHUNK_BYTES;
  const file = await tempVideo(total);
  try {
    const mock = uploadMock({ totalBytes: total, videoId: "already-up" });
    mock.prefill(total);
    const result = await uploadVideo(
      "ya29.token",
      file,
      total,
      "video/mp4",
      SNIPPET,
      { resumeFrom: mock.session },
      mock.impl,
    );
    assert.equal(result.videoId, "already-up");
    assert.equal(result.alreadyComplete, true);
    assert.deepEqual(
      mock.ranges.filter((r) => !/^bytes \*\//.test(r)),
      [],
      "not one byte was re-sent",
    );
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("a session YouTube has forgotten is replaced rather than refused", async () => {
  const total = 1024;
  const file = await tempVideo(total);
  try {
    let created = 0;
    const stub = stubFetch((url, init) => {
      if (url === "https://dead.example.test/session") return { status: 404, body: { error: { message: "gone" } } };
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
        created += 1;
        return { status: 200, headers: { location: "https://fresh.example.test/session" } };
      }
      if (url === "https://fresh.example.test/session") {
        const range = (init?.headers as Record<string, string>)["Content-Range"];
        assert.equal(range, `bytes 0-${total - 1}/${total}`, "a fresh session starts at zero");
        return { status: 201, body: { id: "new-vid", snippet: {}, status: { privacyStatus: "private" } } };
      }
      throw new Error(url);
    });
    const result = await uploadVideo(
      "t",
      file,
      total,
      "video/mp4",
      SNIPPET,
      { resumeFrom: "https://dead.example.test/session" },
      stub.impl,
    );
    assert.equal(result.videoId, "new-vid");
    assert.equal(created, 1);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("a transient refusal is retried from YouTube's own offset, not from a local guess", async () => {
  const total = CHUNK_BYTES + 512;
  const file = await tempVideo(total);
  try {
    const mock = uploadMock({ totalBytes: total, chunkFails: 1 });
    const result = await uploadVideo("t", file, total, "video/mp4", SNIPPET, {}, mock.impl);
    assert.equal(result.videoId, "vid-1");
    assert.ok(mock.ranges.length >= 3, "the failed chunk was sent again");
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("an upload YouTube refuses carries the mapped reason and how far it got", async () => {
  const total = 2048;
  const file = await tempVideo(total);
  try {
    const stub = stubFetch((url) => {
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
        return { status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } };
      }
      throw new Error(url);
    });
    await assert.rejects(
      () => uploadVideo("t", file, total, "video/mp4", SNIPPET, {}, stub.impl),
      (err: unknown) => {
        assert.ok(err instanceof YouTubeApiError);
        assert.equal(err.failure.code, "quota_exceeded");
        return true;
      },
    );
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("an accepted upload with no video id is a FAILURE, not a success", async () => {
  const total = 512;
  const file = await tempVideo(total);
  try {
    const stub = stubFetch((url) => {
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
        return { status: 200, headers: { location: "https://s.example.test/s" } };
      }
      // 200, and no `id`: the one shape that could become a faked success.
      return { status: 200, body: { kind: "youtube#video" } };
    });
    await assert.rejects(
      () => uploadVideo("t", file, total, "video/mp4", SNIPPET, {}, stub.impl),
      /did not return a video id/,
    );
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("an empty render is refused before anything is sent", async () => {
  const file = await tempVideo(0);
  try {
    const never = stubFetch(() => {
      throw new Error("nothing should be sent for an empty file");
    });
    await assert.rejects(() => uploadVideo("t", file, 0, "video/mp4", SNIPPET, {}, never.impl), /nothing to upload/);
    assert.equal(never.calls.length, 0);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("createSession and querySession speak the protocol, and refuse without a session URL", async () => {
  const noLocation = stubFetch(() => ({ status: 200 }));
  await assert.rejects(() => createSession("t", SNIPPET, 10, "video/mp4", noLocation.impl), /no session/);

  const probe = stubFetch(() => ({ status: 308, headers: { range: "bytes=0-99" } }));
  const answer = await querySession("https://s.example.test/s", 1000, probe.impl);
  assert.deepEqual(answer, { offset: 100 });
  assert.equal((probe.calls[0].init?.headers as Record<string, string>)["Content-Range"], "bytes */1000");
});

// -------------------------------------------------------------- the thumbnail

test("a thumbnail that cannot be set NEVER fails the video, and says exactly why", async () => {
  const poster = await tempVideo(64);
  try {
    const unverified = stubFetch(() => ({
      status: 403,
      body: { error: { errors: [{ reason: "videoNeedsVerifiedAccount" }] } },
    }));
    const refused = await setThumbnail("t", "vid", poster, "image/jpeg", unverified.impl);
    assert.equal(refused.applied, false);
    assert.equal(refused.code, "channel_unverified");
    assert.match(refused.reason!, /verified channel/);
    assert.match(refused.reason!, /video itself was not affected/);

    const ok = stubFetch((url) => {
      assert.match(url, /thumbnails\/set\?videoId=vid/);
      return { status: 200, body: {} };
    });
    assert.deepEqual(await setThumbnail("t", "vid", poster, "image/jpeg", ok.impl), {
      applied: true,
      reason: null,
      code: null,
    });

    // A poster that is not on disk, and a network loss: both reported, neither thrown.
    const missing = await setThumbnail("t", "vid", path.join(RENDER_DIR, "no-such.jpg"), "image/jpeg", ok.impl);
    assert.equal(missing.applied, false);
    const dead = stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    const lost = await setThumbnail("t", "vid", poster, "image/jpeg", dead.impl);
    assert.equal(lost.applied, false);
    assert.equal(lost.code, "network");
  } finally {
    await fs.rm(poster, { force: true });
  }
});

// --------------------------------------------------------------- the publisher

const REQUEST: PublishRequest = {
  episodeId: "e1",
  metadata: { title: "A Title", description: "A description.", hashtags: ["#focus", "#deepwork"], hook: "Hook." },
  durationSec: 60,
  video: { path: "/renders/e1.mp4", bytes: 38_000_000, url: "/api/episodes/e1/video", contentType: "video/mp4" },
  poster: { path: "/thumbs/e1/9x16-quote.jpg", bytes: 120_000, url: "/api/episodes/e1/thumbnail/9x16-quote", contentType: "image/jpeg" },
};

test("hashtags become YouTube tags, and a tag list over YouTube's budget is refused", () => {
  assert.deepEqual(tagsFrom(["#focus", "deep work", "#Focus"]), ["focus", "deep work"]);
  assert.ok(tagsLength(["ab"]) > 2, "a quoted tag costs more than its characters");

  const publisher = youTubePublisher({ userId: null, env: {} });
  const many = Array.from({ length: 60 }, (_, i) => `#averyverylonghashtagnumber${i}`);
  const verdict = publisher.validate({ ...REQUEST, metadata: { ...REQUEST.metadata, hashtags: many } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /500/.test(p)), verdict.problems.join(" | "));
});

test("the uploader sends the operator's keyword tags, falling back to hashtag-derived only when empty", () => {
  // The dedicated keyword field is the real source of `snippet.tags`.
  assert.deepEqual(
    uploadTags({ title: "t", description: "d", hashtags: ["#focus"], hook: "h", tags: ["deep work", "attention"] }),
    ["deep work", "attention"],
    "the keyword tags are sent verbatim, not the hashtags",
  );
  // No keyword tags set: an episode made before the field existed still uploads
  // something, derived from its hashtags.
  assert.deepEqual(
    uploadTags({ title: "t", description: "d", hashtags: ["#focus", "#deep-work"], hook: "h" }),
    ["focus", "deep-work"],
    "with no keyword tags, it derives from hashtags",
  );
  assert.deepEqual(uploadTags({ title: "t", description: "d", hashtags: [], hook: "h", tags: [] }), []);

  // The tag-budget refusal measures the KEYWORD tags, and names them as tags.
  const publisher = youTubePublisher({ userId: null, env: {} });
  const bigTags = Array.from({ length: 60 }, (_, i) => `a-very-long-keyword-tag-number-${i}`);
  const verdict = publisher.validate({ ...REQUEST, metadata: { ...REQUEST.metadata, tags: bigTags } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /YouTube tags come to \d+ characters/.test(p)), verdict.problems.join(" | "));
});

test("the provider refuses what YouTube would, with the reason named", () => {
  const publisher = youTubePublisher({ userId: null, env: {} });
  assert.equal(publisher.validate(REQUEST).ok, true);

  const noPoster = publisher.validate({ ...REQUEST, poster: null });
  assert.ok(noPoster.problems.some((p) => /thumbnail/.test(p)));

  const empty = publisher.validate({ ...REQUEST, video: { ...REQUEST.video, bytes: 0 } });
  assert.ok(empty.problems.some((p) => /empty/.test(p)));

  const angled = publisher.validate({ ...REQUEST, metadata: { ...REQUEST.metadata, title: "A <b> title" } });
  assert.ok(angled.problems.some((p) => /< and >/.test(p)), angled.problems.join(" | "));

  const longTitle = publisher.validate({ ...REQUEST, metadata: { ...REQUEST.metadata, title: "x".repeat(101) } });
  assert.ok(longTitle.problems.some((p) => /101 characters/.test(p)));
});

test("the category is a documented default, overridable, and never anything else", () => {
  assert.equal(categoryId({}), "27");
  assert.equal(categoryId({ YOUTUBE_CATEGORY_ID: "22" }), "22");
  assert.equal(categoryId({ YOUTUBE_CATEGORY_ID: "not-a-number" }), "27", "a bad value falls back, never leaks through");
});

test("unconfigured, the provider says REQUIRES_CONNECTION and still offers the whole handoff", async () => {
  const publisher = youTubePublisher({ userId: "u1", env: {} });
  assert.equal(await publisher.isConfigured(), false);

  const prepared = await publisher.prepare(REQUEST);
  assert.equal(prepared.status, "REQUIRES_CONNECTION", "not READY: pressing a button would do nothing");
  // THE FALLBACK. Byte for byte the assisted handoff: download, download, copy
  // title, copy description, copy hashtags, open Studio.
  assert.ok(prepared.handoff.length >= 5, "the handoff an operator has always had is still there");
  assert.ok(prepared.handoff.some((s) => s.kind === "open" && /Studio/.test(s.label)));
  assert.ok(prepared.handoff.some((s) => s.kind === "download"));

  const outcome = await publisher.publish(prepared);
  assert.equal(outcome.status, "REQUIRES_CONNECTION");
  assert.notEqual(outcome.status, "PUBLISHED", "the app never pretends it posted");
  assert.ok("error" in outcome && /cannot post for you/.test(outcome.error));
  assert.ok("error" in outcome && /GOOGLE_CLIENT_ID/.test(outcome.error), "and names what is missing");
});

test("configured but not connected is also REQUIRES_CONNECTION, with a different sentence", async () => {
  requireIsolation("this test reads connection state");
  const user = await prisma.user.create({ data: { email: `yt-nc-${randomUUID()}@example.test` } });
  try {
    const publisher = youTubePublisher({ userId: user.id, env: CONFIGURED });
    assert.equal(await publisher.isConfigured(), false, "an environment is not a grant");
    const prepared = await publisher.prepare(REQUEST);
    assert.equal(prepared.status, "REQUIRES_CONNECTION");
    assert.ok(prepared.handoff.length >= 5, "and the handoff is still fully functional");

    const view = await connectionFor(user.id, CONFIGURED);
    assert.equal(view.config.configured, true);
    assert.equal(view.connected, false);
    assert.equal(view.problem, null, "nothing is wrong: nobody has consented yet");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test("a provider with no user cannot reach anyone's channel", async () => {
  const publisher = youTubePublisher({ userId: null, env: CONFIGURED });
  assert.equal(await publisher.isConfigured(), false);
  const outcome = await publisher.publish(await publisher.prepare(REQUEST));
  assert.equal(outcome.status, "REQUIRES_CONNECTION");
  assert.ok("error" in outcome && /No signed-in account/.test(outcome.error));
});

test("the registry hands YouTube its real provider, and Instagram its own whose capabilities are the handoff until verified", () => {
  assert.equal(hasRealPublisher("youtube"), true);
  assert.equal(hasRealPublisher("instagram"), true, "Instagram has a provider too, since the Graph API work");
  assert.equal(publisherFor("youtube", { userId: "u" }).capabilities().canUpload, true);
  assert.equal(publisherFor("instagram", { userId: "u" }).capabilities().canUpload, false);
  // Honest about what it does NOT do, which is as important.
  const caps = publisherFor("youtube", { userId: "u" }).capabilities();
  assert.equal(caps.canSchedule, false, "nothing here schedules; saying true would offer a dead control");
  assert.equal(caps.canSetThumbnail, true);
  assert.ok(caps.requires.some((r) => /BOOKREEL_TOKEN_KEY/.test(r)), "and what it needs is named");
});

// ------------------------------------------------------- ownership and the run

interface Seed {
  ownerId: string;
  strangerId: string;
  ownedEpisodeId: string;
  ownerlessEpisodeId: string;
  cleanup: () => Promise<void>;
}

/**
 * Two finished episodes with real files: one owned, one ownerless.
 *
 * The ownerless one is the case that matters on this install — most of the
 * operator's 160 episodes have no `userId`, so "publishing must not inherit the
 * visibility rule's generosity" is not a hypothetical here.
 */
async function seed(): Promise<Seed> {
  requireIsolation("these tests create episodes and write renders and posters");
  const owner = await prisma.user.create({ data: { email: `yt-own-${randomUUID()}@example.test` } });
  const stranger = await prisma.user.create({ data: { email: `yt-str-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({
    data: { title: `YT ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  const make = async (userId: string | null) => {
    const episode = await prisma.episode.create({
      data: {
        bookId: book.id,
        uploadId: upload.id,
        userId,
        status: "DONE",
        theme: "marginalia",
        title: "Productivity Isn't Hustle",
        hook: "Most people are busy.",
        cta: "Follow for one page a day",
        description: "What the book says about attention.",
        hashtags: JSON.stringify(["#focus", "#deepwork"]),
        voScript: "Most people are busy.",
        durationSec: 116.22,
      },
    });
    const thumbDir = thumbsDir(episode.id);
    const specs: ThumbSpec[] = THUMB_KEYS.map((key) => ({
      key,
      aspect: key.startsWith("9x16") ? ("9:16" as const) : ("16:9" as const),
      variant: key.split("-")[1] as ThumbSpec["variant"],
      path: path.join(thumbDir, `${key}.jpg`),
      width: 1080,
      height: 1920,
      rev: 1,
    }));
    await fs.mkdir(thumbDir, { recursive: true });
    for (const s of specs) await fs.writeFile(s.path, "poster bytes");
    await fs.mkdir(RENDER_DIR, { recursive: true });
    const renderFile = path.join(RENDER_DIR, `${episode.id}.mp4`);
    // Two chunks and a bit, so the chunking and the progress are both exercised.
    await fs.writeFile(renderFile, Buffer.alloc(CHUNK_BYTES + 4096, 3));
    await prisma.episode.update({
      where: { id: episode.id },
      data: { thumbnails: serializeThumbnails(specs), videoPath: renderFile },
    });
    return episode.id;
  };

  const ownedEpisodeId = await make(owner.id);
  const ownerlessEpisodeId = await make(null);

  return {
    ownerId: owner.id,
    strangerId: stranger.id,
    ownedEpisodeId,
    ownerlessEpisodeId,
    cleanup: async () => {
      for (const id of [ownedEpisodeId, ownerlessEpisodeId]) {
        await fs.rm(thumbsDir(id), { recursive: true, force: true });
        await fs.rm(path.join(RENDER_DIR, `${id}.mp4`), { force: true });
      }
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
    },
  };
}

/**
 * THE RULE THE PRIOR WORKSTREAM'S REPORT FLAGGED IN ITS §7.
 *
 * `visibility.ts` matches "mine OR nobody's", and that is right for reads and
 * for local writes. A publish is external and irreversible, so it does not get
 * to inherit it — and because most of this library is ownerless, the refusal
 * has to say so rather than answering a bare 404.
 */
test("publishing requires genuine ownership: an ownerless episode is refused, and says why", async () => {
  const s = await seed();
  try {
    // The visibility rule WOULD match it — that is the whole point.
    const visible = await publishView(s.ownerId, s.ownerlessEpisodeId);
    assert.equal(visible.readiness.ready, true, "it is readable and ready");
    assert.equal(visible.owned, false, "and the view says plainly that it is not owned");

    await assert.rejects(
      () => loadEpisodeForPublish(s.ownerId, s.ownerlessEpisodeId),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string };
        assert.equal(e.status, 403, "403, not 404: it exists and this is a policy refusal");
        assert.equal(e.code, "not_owned");
        assert.match(e.message!, /no owner/);
        assert.match(e.message!, /handoff still works/, "and the way forward is named");
        return true;
      },
    );
    await assert.rejects(() => startYouTubePublish(s.ownerId, s.ownerlessEpisodeId, { env: CONFIGURED }), /no owner/);

    // Another account's episode: a different sentence, same refusal.
    await assert.rejects(
      () => loadEpisodeForPublish(s.strangerId, s.ownedEpisodeId),
      (err: unknown) => {
        const e = err as { status?: number; message?: string };
        assert.equal(e.status, 403);
        assert.match(e.message!, /another account/);
        return true;
      },
    );

    // The owner's own episode passes.
    const row = await loadEpisodeForPublish(s.ownerId, s.ownedEpisodeId);
    assert.equal(row.userId, s.ownerId);
    assert.equal((await publishView(s.ownerId, s.ownedEpisodeId)).owned, true);

    // And a missing episode is a 404, which says nothing about what exists.
    await assert.rejects(
      () => loadEpisodeForPublish(s.ownerId, "no-such-episode"),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 404);
        return true;
      },
    );
  } finally {
    await s.cleanup();
  }
});

test("an unconfigured server refuses to start a publish and does not record one", async () => {
  const s = await seed();
  try {
    await assert.rejects(
      () => startYouTubePublish(s.ownerId, s.ownedEpisodeId, { env: {} }),
      (err: unknown) => {
        const e = err as { status?: number; code?: string; message?: string };
        assert.equal(e.status, 409);
        assert.equal(e.code, "requires_connection");
        assert.match(e.message!, /GOOGLE_CLIENT_ID/);
        assert.match(e.message!, /nothing was sent/i);
        return true;
      },
    );
    assert.equal(
      await prisma.publishJob.count({ where: { episodeId: s.ownedEpisodeId } }),
      0,
      "no row claims an attempt that never left this machine",
    );
  } finally {
    await s.cleanup();
  }
});

test("configured but not connected also refuses, and still does not record an attempt", async () => {
  const s = await seed();
  try {
    await assert.rejects(
      () => startYouTubePublish(s.ownerId, s.ownedEpisodeId, { env: CONFIGURED }),
      /No YouTube account is connected/,
    );
    assert.equal(await prisma.publishJob.count({ where: { episodeId: s.ownedEpisodeId } }), 0);
  } finally {
    await s.cleanup();
  }
});

test("a full publish records PRIVATE, the platform's id, real byte progress, and the thumbnail separately", async () => {
  const s = await seed();
  try {
    await storeGrant(
      s.ownerId,
      { accessToken: "ya29.go", refreshToken: "1//go", expiresAt: new Date(Date.now() + 3600_000), scope: YOUTUBE_SCOPES[0] },
      CONFIGURED,
    );
    const total = CHUNK_BYTES + 4096;
    const SESSION = "https://upload.example.test/session/abc";
    /**
     * One mock for the whole flow: the session, the chunks, and the thumbnail.
     * It asserts on what it is sent as well as answering — the privacy, the tag
     * shaping and the video id in the thumbnail URL are all checked here, at
     * the boundary, rather than being inferred afterwards.
     */
    const stub = stubFetch((url, init) => {
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/thumbnails/set")) {
        assert.match(url, /videoId=REALVIDEOID/);
        return { status: 200, body: {} };
      }
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
        const body = JSON.parse(String(init?.body)) as {
          status?: { privacyStatus?: string };
          snippet?: { tags?: string[]; title?: string; categoryId?: string };
        };
        assert.equal(body.status?.privacyStatus, "private");
        assert.deepEqual(body.snippet?.tags, ["focus", "deepwork"], "hashtags become plain YouTube tags");
        assert.equal(body.snippet?.title, "Productivity Isn't Hustle");
        assert.equal(body.snippet?.categoryId, "27");
        return { status: 200, headers: { location: SESSION } };
      }
      if (url === SESSION) {
        const range = (init?.headers as Record<string, string>)["Content-Range"];
        const m = /^bytes (\d+)-(\d+)\//.exec(range)!;
        const end = Number(m[2]) + 1;
        if (end >= total) {
          return {
            status: 200,
            body: {
              id: "REALVIDEOID",
              snippet: { channelId: "UCx", channelTitle: "Operator Channel" },
              status: { privacyStatus: "private" },
            },
          };
        }
        return { status: 308, headers: { range: `bytes=0-${end - 1}` } };
      }
      throw new Error(`unexpected ${url}`);
    });

    const view = await startYouTubePublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: stub.impl,
      waitForCompletion: true,
    });

    const youtube = view.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(youtube.status, "PUBLISHED");
    assert.equal(youtube.job!.externalId, "REALVIDEOID", "the id came from the platform");
    assert.equal(youtube.job!.externalUrl, "https://www.youtube.com/watch?v=REALVIDEOID");
    assert.equal(youtube.job!.reviewUrl, "https://studio.youtube.com/video/REALVIDEOID/edit");
    assert.ok(youtube.job!.publishedAt, "and so did the confirmation time");
    assert.equal(youtube.job!.privacyStatus, "private", "review-first, recorded rather than taken on trust");
    assert.equal(youtube.job!.thumbnailStatus, "APPLIED");
    assert.equal(youtube.job!.thumbnailError, null);
    assert.equal(youtube.job!.uploadedBytes, total);
    assert.equal(youtube.job!.totalBytes, total);
    assert.equal(youtube.job!.lastError, null);

    // The channel the platform named is remembered, so the panel can say it.
    const connection = await connectionFor(s.ownerId, CONFIGURED);
    assert.equal(connection.channelTitle, "Operator Channel");
    assert.equal(connection.channelId, "UCx");

    // THE RETRY RULE: a job that already holds an id is not re-uploaded.
    const before = stub.calls.length;
    const again = await startYouTubePublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: stub.impl,
      waitForCompletion: true,
    });
    assert.equal(stub.calls.length, before, "not one further request was made");
    const second = again.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(second.job!.externalId, "REALVIDEOID");
    assert.equal(second.job!.attempts, 1, "and no second attempt was even recorded");

    // Nothing credential-shaped is in the row the browser reads.
    const wire = JSON.stringify(view);
    assert.ok(!wire.includes("1//go"), "the refresh token is not in the publish view");
    assert.ok(!wire.includes("ya29.go"), "nor the access token");
    assert.ok(!wire.includes("upload.example.test"), "nor the resumable session URL");
  } finally {
    await s.cleanup();
  }
});

test("a refused upload is recorded as FAILED with the mapped reason, and keeps its session to resume", async () => {
  const s = await seed();
  try {
    await storeGrant(
      s.ownerId,
      { accessToken: "ya29.q", refreshToken: "1//q", expiresAt: new Date(Date.now() + 3600_000), scope: YOUTUBE_SCOPES[0] },
      CONFIGURED,
    );
    const SESSION = "https://upload.example.test/quota";
    const stub = stubFetch((url) => {
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
        return { status: 200, headers: { location: SESSION } };
      }
      if (url === SESSION) return { status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } };
      throw new Error(url);
    });

    const view = await startYouTubePublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: stub.impl,
      waitForCompletion: true,
    });
    const youtube = view.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(youtube.status, "FAILED");
    assert.equal(youtube.job!.externalId, null, "nothing claims an id the platform did not give");
    assert.equal(youtube.job!.publishedAt, null);
    assert.match(youtube.job!.lastError!, /quota/i);
    assert.match(youtube.job!.lastError!, /midnight Pacific/, "with the actual next step");

    // The session survives the failure, sealed, so a retry resumes.
    const row = await prisma.publishJob.findUnique({
      where: { episodeId_platform: { episodeId: s.ownedEpisodeId, platform: "youtube" } },
    });
    assert.ok(row!.sessionUrlEnc, "the resumable session is kept");
    assert.ok(!row!.sessionUrlEnc!.includes("upload.example.test"), "and it is encrypted, not stored in the clear");
    // The handoff is still there for an operator who would rather not wait for
    // tomorrow's quota.
    assert.ok(youtube.handoff.length >= 5);
  } finally {
    await s.cleanup();
  }
});

test("a credential that stopped working mid-attempt is REQUIRES_CONNECTION, not FAILED", async () => {
  const s = await seed();
  try {
    await storeGrant(
      s.ownerId,
      { accessToken: "ya29.x", refreshToken: "1//x", expiresAt: new Date(Date.now() - 1000), scope: YOUTUBE_SCOPES[0] },
      CONFIGURED,
    );
    const stub = stubFetch((url) => {
      if (url === "https://oauth2.googleapis.com/token") return { status: 400, body: { error: "invalid_grant" } };
      throw new Error(`nothing else should be called: ${url}`);
    });
    const view = await startYouTubePublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: stub.impl,
      waitForCompletion: true,
    });
    const youtube = view.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(youtube.status, "REQUIRES_CONNECTION", "the next action is reconnect, not retry");
    assert.match(youtube.job!.lastError!, /connect YouTube again/);
    assert.equal(youtube.job!.externalId, null);
  } finally {
    await s.cleanup();
  }
});

test("nothing in the database holds a token in the clear", async () => {
  requireIsolation("this test stores a grant");
  const user = await prisma.user.create({ data: { email: `yt-p-${randomUUID()}@example.test` } });
  try {
    await storeGrant(
      user.id,
      {
        accessToken: "ya29.PLAINTEXT-ACCESS",
        refreshToken: "1//PLAINTEXT-REFRESH",
        expiresAt: new Date(Date.now() + 3600_000),
        scope: YOUTUBE_SCOPES[0],
      },
      CONFIGURED,
    );
    const rows = await prisma.platformAccount.findMany({ where: { userId: user.id } });
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes("PLAINTEXT-ACCESS"), "the access token is sealed");
    assert.ok(!dump.includes("PLAINTEXT-REFRESH"), "and so is the refresh token");
    // And it genuinely round-trips, so the sealing is not merely mangling.
    assert.equal(open(rows[0].refreshTokenEnc, refreshAad(user.id), CONFIGURED), "1//PLAINTEXT-REFRESH");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

// -------------------------------------------------------------------- the copy

test("every connection state has words, and none of them claim a post", () => {
  for (const key of Object.keys(connectCopy) as Array<keyof typeof connectCopy>) {
    const value = connectCopy[key];
    assert.ok(typeof value === "string" || typeof value === "function", `${key} has copy`);
  }
  assert.match(connectCopy.publish, /private/i, "the button says what it does");
  assert.match(connectCopy.publishNote, /PRIVATE/);
  assert.match(connectCopy.consentNote, /accounts\.google\.com/, "and where the operator will actually sign in");
  assert.ok(!/password/i.test(connectCopy.consentNote.replace(/never sees your password/i, "")), "no password is collected");
  assert.equal(isConnectResult("connected"), true);
  assert.equal(isConnectResult("whatever"), false);
  assert.equal(CONNECT_PARAM, "youtube");
  assert.equal(CONNECT_REASON_PARAM, "youtube_reason");
});

// ---------------------------------------------------------- the rendered states

/**
 * Every state the connection card can be in, rendered.
 *
 * This is here because the one state the LIVE server can be driven into
 * without real Google credentials is "unconfigured" — and because the states
 * that matter most (an upload in flight, a confirmed upload, a thumbnail that
 * was refused) need a platform response to exist at all. Rendering the
 * component directly reaches all of them, and asserts the rule that matters in
 * each: that nothing on the surface claims something the platform did not say.
 *
 * `renderToStaticMarkup` means no effect has run, so no `fetch` has landed —
 * exactly the shape `tests/publish.test.mts` uses for the panel. The connection
 * is therefore unknown on first paint, which is itself a case worth proving:
 * unknown must render as "not configured", NEVER as "connected".
 */
const Card = ((cardModule as { default: unknown }).default as { default?: unknown }).default ??
  (cardModule as { default: unknown }).default;

function renderCard(state: Partial<PlatformState>, owned = true): string {
  const base: PlatformState = {
    platform: "youtube",
    label: "YouTube",
    status: "REQUIRES_CONNECTION",
    capabilities: youTubePublisher({ userId: null, env: {} }).capabilities(),
    hasPublisher: true,
    configured: false,
    problems: [],
    variant: [],
    cover: null,
    handoff: [],
    requires: [],
    job: null,
    ...state,
  };
  return renderToStaticMarkup(
    React.createElement(ToastHost, null, [
      React.createElement(
        Card as React.ComponentType<{
          episodeId: string | null;
          state: PlatformState;
          owned: boolean;
          onPublished: (v: Record<string, unknown>) => void;
        }>,
        { key: "card", episodeId: "e1", state: base, owned, onPublished: () => {} },
      ),
    ]),
  );
}

test("before anything is known, the card says NOT CONFIGURED and offers no upload", () => {
  const html = renderCard({});
  assert.match(html, /Not configured/);
  assert.ok(!html.includes(connectCopy.publish), "no upload button before a connection is known");
  assert.ok(!html.includes(connectCopy.connect), "and no Connect either: the server may have no credentials");
  assert.ok(!/Connected/.test(html.replace(/Not connected/g, "")), "nothing claims a connection");
});

test("an in-flight upload shows measured bytes, and no bar at all without a measurement", () => {
  const measured = renderCard({
    status: "UPLOADING",
    job: {
      status: "UPLOADING",
      externalId: null,
      externalUrl: null,
      attempts: 1,
      lastError: null,
      preparedAt: new Date().toISOString(),
      publishedAt: null,
      metadata: null,
      uploadedBytes: 8_388_608,
      totalBytes: 39_845_888,
      thumbnailStatus: null,
      thumbnailError: null,
      privacyStatus: "private",
      reviewUrl: null,
    },
  });
  assert.match(measured, /role="progressbar"/);
  assert.match(measured, /aria-valuenow="8388608"/, "the value is the byte count, not a percentage");
  assert.match(measured, /aria-valuemax="39845888"/);
  assert.match(measured, /8\.0 of 38\.0 MB/);
  // The width is the ratio of the two real numbers and nothing else.
  assert.match(measured, /width:21\.1%/);
  assert.ok(!measured.includes("Open in YouTube Studio"), "nothing is offered for a video that is not up");

  const unmeasured = renderCard({
    status: "PREPARING",
    job: {
      status: "PREPARING",
      externalId: null,
      externalUrl: null,
      attempts: 1,
      lastError: null,
      preparedAt: null,
      publishedAt: null,
      metadata: null,
      uploadedBytes: null,
      totalBytes: null,
      thumbnailStatus: null,
      thumbnailError: null,
      privacyStatus: null,
      reviewUrl: null,
    },
  });
  assert.ok(!unmeasured.includes("progressbar"), "no measurement, no bar: a bar at 0% is still a claim");
  assert.match(unmeasured, /has not reported a byte count yet/);
});

test("a confirmed upload shows the id, the privacy and the Studio link, and nothing else does", () => {
  const confirmed = renderCard({
    status: "PUBLISHED",
    job: {
      status: "PUBLISHED",
      externalId: "REALVIDEOID",
      externalUrl: "https://www.youtube.com/watch?v=REALVIDEOID",
      attempts: 1,
      lastError: null,
      preparedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      metadata: null,
      uploadedBytes: 100,
      totalBytes: 100,
      thumbnailStatus: "FAILED",
      thumbnailError: "YouTube allows a custom thumbnail only on a verified channel.",
      privacyStatus: "private",
      reviewUrl: "https://studio.youtube.com/video/REALVIDEOID/edit",
    },
  });
  assert.match(confirmed, /REALVIDEOID/);
  assert.match(confirmed, /private/);
  assert.match(confirmed, /studio\.youtube\.com\/video\/REALVIDEOID\/edit/);
  assert.match(confirmed, /Open in YouTube Studio/);
  // The thumbnail is its own line, with its own verdict and its own reason —
  // a video that went up is not reported as a failure because of it.
  assert.match(confirmed, /Not applied/);
  assert.match(confirmed, /verified channel/);
  assert.ok(!confirmed.includes(connectCopy.publish), "a published episode is not offered another upload");

  // Without a platform confirmation there is no review block, even with a status
  // of PUBLISHED on the row — the id and the timestamp are what count.
  const unconfirmed = renderCard({
    status: "PUBLISHED",
    job: {
      status: "PUBLISHED",
      externalId: null,
      externalUrl: null,
      attempts: 1,
      lastError: null,
      preparedAt: null,
      publishedAt: null,
      metadata: null,
      uploadedBytes: null,
      totalBytes: null,
      thumbnailStatus: null,
      thumbnailError: null,
      privacyStatus: null,
      reviewUrl: null,
    },
  });
  assert.ok(!unconfirmed.includes("Open in YouTube Studio"));
  assert.ok(!unconfirmed.includes("Video id"));
});

/**
 * A regression, found by probing the live routes rather than by reading them.
 *
 * The callback used `err.message` for any `Error`, and a dev server holding a
 * Prisma client that predated these tables put "Cannot read properties of
 * undefined (reading 'findUnique')" into the browser's address bar. Two fixes,
 * both asserted here: the stale client is now a NAMED 503 with the restart in
 * it, and the callback only shows a message this app deliberately wrote.
 */
test("the callback shows only sentences this app wrote, never a raw internal error", async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL("../src/app/api/publish/youtube/callback/route.ts", import.meta.url)),
    "utf8",
  );
  const code = withoutComments(source);
  // The reason must come from a mapped failure or a named AppError, and the
  // fallthrough must be a literal. A bare `err.message` is the bug.
  assert.match(code, /isNamedAppError\(err\)/, "the allow-list is in place");
  assert.doesNotMatch(
    code,
    /err instanceof Error\s*\n?\s*\?\s*err\.message/,
    "a raw Error message must not become the reason shown to the operator",
  );
});

test("the OAuth tables being absent is a named, actionable 503 rather than a Prisma TypeError", async () => {
  // `assertModels` is what produces it; this proves the message carries the fix
  // rather than the symptom. The real tables exist in the test database, so the
  // absence is simulated the only honest way: by asking for a model that is
  // genuinely not in the schema.
  const { assertModels } = await import("../src/lib/db");
  assert.throws(
    () => assertModels("platformAccount", "oAuthState", "noSuchModel"),
    (err: unknown) => {
      assert.match((err as Error).message, /noSuchModel/);
      assert.match((err as Error).message, /prisma generate/);
      assert.match((err as Error).message, /restart the server/);
      return true;
    },
  );
  // And the two that this integration needs ARE known to the client the tests
  // run with, so a failure here means `npm test` did not rebuild the template.
  assert.doesNotThrow(() => assertModels("platformAccount", "oAuthState", "publishJob"));
});

/**
 * The standing proof that nothing here can reach the real network by accident:
 * every module that makes a request takes its `fetch` as a parameter, and the
 * default is only used by the route handlers.
 */
test("the integration never reaches the real network without being handed a fetch", async () => {
  const offenders: string[] = [];
  for (const name of ["oauth.ts", "upload.ts", "accounts.ts", "publisher.ts", "run.ts"]) {
    const source = await fs.readFile(path.join(YT_DIR, name), "utf8");
    // Every `fetch(` call must be through an injected binding (`doFetch`,
    // `fetchImpl`, `options.fetchImpl`) — a bare `await fetch(` is the bug.
    for (const m of source.matchAll(/(?<![.\w])fetch\s*\(/g)) {
      const before = source.slice(Math.max(0, m.index! - 24), m.index!);
      if (!/=\s*$|doFetch|fetchImpl/.test(before)) offenders.push(`${name}: ...${before.trim()}fetch(`);
    }
  }
  assert.deepEqual(offenders, [], `these call the network directly and cannot be tested: ${offenders.join(", ")}`);
});
