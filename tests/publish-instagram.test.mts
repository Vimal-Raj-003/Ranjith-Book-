import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "../src/lib/db";
import { RENDER_DIR } from "../src/lib/paths";
import { serializeThumbnails, type ThumbSpec } from "../src/lib/thumbnails";
import { thumbsDir, THUMB_KEYS } from "../src/lib/thumbnails/types";
import { instagramCaption } from "../src/lib/publish/limits";
import { handoffSteps, manualHandoff } from "../src/lib/publish/manual";
import { hasRealPublisher, publisherFor } from "../src/lib/publish/registry";
import { publishView } from "../src/lib/publish/state";
import type { PublishRequest } from "../src/lib/publish/contract";
import type { PlatformState } from "../src/lib/publish/view";
import { instagramCopy, INSTAGRAM_CONNECT_PARAM, INSTAGRAM_CONNECT_REASON_PARAM, type ConnectionView } from "../src/lib/publish/connect";
import {
  ENV,
  INSTAGRAM_SCOPES,
  SCOPE_PARAM,
  endpoints,
  graphVersion,
  publicBaseProblem,
  publicConfig,
  redirectUri,
  serverConfig,
} from "../src/lib/publish/instagram/config";
import { mapGraphError, mapTransportError } from "../src/lib/publish/instagram/errors";
import {
  authorizeUrl,
  codeToShortToken,
  createReelContainer,
  isInstagramApiError,
  publishContainer,
} from "../src/lib/publish/instagram/graph";
import {
  beginFlow,
  connectionFor,
  credentialsFor,
  disconnect,
  exchangeCode,
  pickAccount,
  redeemState,
  storeGrant,
  type InstagramGrant,
} from "../src/lib/publish/instagram/accounts";
import { instagramPublisher } from "../src/lib/publish/instagram/publisher";
import { startInstagramPublish } from "../src/lib/publish/instagram/run";
import { verifyMediaToken } from "../src/lib/publish/media-link";
import { serveSignedMedia } from "../src/lib/publish/media-serve";
import { hashState, makeState } from "../src/lib/publish/youtube/oauth";
import { beginFlow as beginYouTubeFlow } from "../src/lib/publish/youtube/accounts";
import { instagramTokenAad, instagramUserAad, open, refreshAad, type EnvLike } from "../src/lib/publish/youtube/secrets";
import * as cardModule from "../src/components/InstagramPublish";
import { ToastHost } from "../src/components/Toast";
import { requireIsolation } from "./setup/isolation";

/**
 * The Instagram integration, tested against a MOCKED GRAPH API and never against
 * Meta.
 *
 * NOTHING IN THIS FILE MAKES A NETWORK REQUEST. Every function that would is
 * given its `fetch`, and every test passes a stub that asserts on what was sent
 * and answers with a recorded shape. A real publish would put a public Reel on an
 * Instagram account, which is an external, irreversible action a test suite has
 * no business performing.
 *
 * WHAT IS DELIBERATELY NOT PROVEN HERE, and is in the report as such: that Meta
 * accepts these exact request shapes, that the App Review permissions are
 * granted, or that the signed URL is reachable from Meta's servers. A stub cannot
 * refuse something the real API would. What the stubs DO prove is that every
 * answer the API can give is handled, mapped to a distinct actionable message,
 * and recorded honestly -- and that nothing can mark a post PUBLISHED that the
 * platform did not confirm.
 */

const IG_DIR = fileURLToPath(new URL("../src/lib/publish/instagram/", import.meta.url));

/** Comments say things about tokens and confirmation; code does them. Only the code is the claim. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

const KEY = crypto.randomBytes(32).toString("base64");

/** A fully configured environment, with no real credential in it. */
const CONFIGURED: EnvLike = {
  META_APP_ID: "test-app-id",
  META_APP_SECRET: "test-app-secret",
  PUBLIC_BASE_URL: "https://reels.example.test",
  BOOKREEL_TOKEN_KEY: KEY,
};

const PAGE_TOKEN = "EAAPAGE-TOKEN-SECRET-VALUE";
const USER_TOKEN = "EAAUSER-TOKEN-SECRET-VALUE";
const ALL_PERMISSIONS = [...INSTAGRAM_SCOPES];

function grant(overrides: Partial<InstagramGrant> = {}): InstagramGrant {
  return {
    pageId: "P1",
    pageName: "Between Pages",
    pageToken: PAGE_TOKEN,
    userToken: USER_TOKEN,
    userTokenExpiresAt: new Date(Date.now() + 50 * 86_400_000),
    igUserId: "IG1",
    username: "between_pages",
    scope: ALL_PERMISSIONS.join(" "),
    ...overrides,
  };
}

// ------------------------------------------------------------------ a Graph stub

interface StubAnswer {
  status: number;
  body?: unknown;
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

/** What a recorded call carried, whichever way it was sent. */
function params(call: { url: string; init: RequestInit | undefined }): URLSearchParams {
  if ((call.init?.method ?? "GET") === "GET") return new URL(call.url).searchParams;
  return new URLSearchParams(String(call.init?.body ?? ""));
}
const pathOf = (url: string): string => new URL(url).pathname.replace(/^\/v\d+\.\d+/, "");
const methodOf = (call: { init: RequestInit | undefined }): string => call.init?.method ?? "GET";

/** The whole OAuth conversation, scripted. */
function oauthGraph(opts: {
  pages?: Array<{ id: string; name: string; access_token: string }>;
  ig?: Record<string, { id: string; username: string } | null>;
  permissions?: string[];
} = {}) {
  const pages = opts.pages ?? [{ id: "P1", name: "Between Pages", access_token: PAGE_TOKEN }];
  const ig = opts.ig ?? { P1: { id: "IG1", username: "between_pages" } };
  const permissions = opts.permissions ?? ALL_PERMISSIONS;
  return stubFetch((url, init) => {
    const p = pathOf(url);
    const q = params({ url, init });
    if (p === "/oauth/access_token" && q.get("code")) {
      return { status: 200, body: { access_token: "SHORT-USER-TOKEN", token_type: "bearer", expires_in: 3600 } };
    }
    if (p === "/oauth/access_token" && q.get("grant_type") === "fb_exchange_token") {
      return { status: 200, body: { access_token: USER_TOKEN, token_type: "bearer", expires_in: 5_184_000 } };
    }
    if (p === "/me/permissions" && (init?.method ?? "GET") === "GET") {
      return { status: 200, body: { data: permissions.map((permission) => ({ permission, status: "granted" })) } };
    }
    if (p === "/me/accounts") return { status: 200, body: { data: pages } };
    const page = pages.find((x) => p === `/${x.id}`);
    if (page) {
      const linked = ig[page.id];
      return { status: 200, body: linked ? { id: page.id, instagram_business_account: linked } : { id: page.id } };
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
}

const APP = { appId: "test-app-id", appSecret: "test-app-secret", redirectUri: "https://reels.example.test/api/publish/instagram/callback", publicBaseUrl: "https://reels.example.test" };

// ------------------------------------------------------------------- configuration

test("an unconfigured install names every variable it is missing, and no values", () => {
  const none = publicConfig({});
  assert.equal(none.configured, false);
  assert.deepEqual(none.missing, [ENV.appId, ENV.appSecret, ENV.publicBaseUrl, ENV.tokenKey]);
  assert.ok(none.keyProblem, "and says why the token store is unusable");

  const complete = publicConfig(CONFIGURED);
  assert.equal(complete.configured, true);
  assert.deepEqual(complete.missing, []);

  // Names only: a value, or a prefix of one, anywhere in the view is a leak.
  const wire = JSON.stringify(publicConfig({ ...CONFIGURED, META_APP_SECRET: "" }));
  assert.ok(!wire.includes("test-app-id") && !wire.includes(KEY) && !wire.includes("reels.example.test"));

  assert.equal(serverConfig({}), null);
  assert.equal(serverConfig({ ...CONFIGURED, BOOKREEL_TOKEN_KEY: "short" }), null, "an install that cannot protect a token is not configured");
  assert.deepEqual(serverConfig(CONFIGURED), APP);
});

test("the redirect URI is derived from PUBLIC_BASE_URL, tolerating a trailing slash and a path prefix", () => {
  assert.equal(redirectUri(CONFIGURED), "https://reels.example.test/api/publish/instagram/callback");
  assert.equal(redirectUri({ PUBLIC_BASE_URL: "https://reels.example.test/" }), "https://reels.example.test/api/publish/instagram/callback");
  assert.equal(redirectUri({ PUBLIC_BASE_URL: "https://h.example.test/app/" }), "https://h.example.test/app/api/publish/instagram/callback");
  assert.equal(redirectUri({}), null);
  assert.equal(redirectUri({ PUBLIC_BASE_URL: "ftp://x" }), null, "only http(s) is an address");
  assert.equal(redirectUri({ PUBLIC_BASE_URL: "not a url" }), null);
});

test("the scopes, the dialog and the Graph base are exactly the documented ones", () => {
  assert.deepEqual([...INSTAGRAM_SCOPES], [
    "instagram_basic",
    "instagram_content_publish",
    "pages_show_list",
    "pages_read_engagement",
    "business_management",
  ]);
  assert.equal(SCOPE_PARAM, "instagram_basic instagram_content_publish pages_show_list pages_read_engagement business_management");
  assert.deepEqual(endpoints({}), {
    graph: "https://graph.facebook.com/v21.0",
    dialog: "https://www.facebook.com/v21.0/dialog/oauth",
  });
  assert.equal(graphVersion({ META_GRAPH_VERSION: "v23.0" }), "v23.0");
  assert.equal(graphVersion({ META_GRAPH_VERSION: "latest; evil" }), "v21.0", "only a version-shaped value is accepted");
});

test("an address Meta cannot fetch a video from is named before anything is sent", () => {
  assert.equal(publicBaseProblem(CONFIGURED), null);
  for (const bad of [
    "http://localhost:3013",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://192.168.1.20",
    "https://172.16.0.9",
    "https://box.local",
    "https://intranet",
  ]) {
    const problem = publicBaseProblem({ PUBLIC_BASE_URL: bad });
    assert.ok(problem, `${bad} is unreachable from Meta`);
    assert.match(problem!, /PUBLIC_BASE_URL/);
  }
  assert.match(publicBaseProblem({ PUBLIC_BASE_URL: "http://reels.example.test" })!, /https/);
  assert.match(publicBaseProblem({})!, /not set/);
});

test("the dialog URL carries the app id, scope and state, and never the secret", () => {
  const url = new URL(authorizeUrl(APP, "STATE-VALUE", SCOPE_PARAM));
  assert.equal(url.origin + url.pathname, "https://www.facebook.com/v21.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "test-app-id");
  assert.equal(url.searchParams.get("redirect_uri"), APP.redirectUri);
  assert.equal(url.searchParams.get("state"), "STATE-VALUE");
  assert.equal(url.searchParams.get("scope"), SCOPE_PARAM);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.ok(!url.toString().includes("test-app-secret"), "the secret never goes in a URL the browser holds");
  assert.equal(url.searchParams.get("code_challenge"), null, "Meta's web flow has no PKCE and none is invented");
});

// ------------------------------------------------------------------- OAuth state

test("state is single-use, session-bound, provider-bound, expiring, and its sealed nonce must agree", async () => {
  requireIsolation("this test creates users and OAuth state rows");
  const a = await prisma.user.create({ data: { email: `ig-a-${randomUUID()}@example.test` } });
  const b = await prisma.user.create({ data: { email: `ig-b-${randomUUID()}@example.test` } });
  try {
    // A good one redeems, once.
    const good = makeState();
    await beginFlow(a.id, good.stateHash, good.state, "/library?x=1", CONFIGURED);
    const stored = await prisma.oAuthState.findUnique({ where: { stateHash: good.stateHash } });
    assert.equal(stored!.provider, "instagram");
    assert.ok(!stored!.verifierEnc.includes(good.state), "the nonce is sealed, not stored in the clear");
    assert.notEqual(stored!.stateHash, good.state, "and only the HASH of the state is stored");
    assert.equal((await redeemState(a.id, good.state, CONFIGURED)).returnTo, "/library?x=1");
    await assert.rejects(() => redeemState(a.id, good.state, CONFIGURED), /not one this server issued|already been used/, "single-use");

    // Forged: a state this server never wrote.
    await assert.rejects(() => redeemState(a.id, "forged-state-value", CONFIGURED), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "bad_state");
      return true;
    });

    // Foreign: issued to A, presented by B.
    const foreign = makeState();
    await beginFlow(a.id, foreign.stateHash, foreign.state, null, CONFIGURED);
    await assert.rejects(() => redeemState(b.id, foreign.state, CONFIGURED), /different session/);
    await assert.rejects(() => redeemState(a.id, foreign.state, CONFIGURED), /not one this server issued|already been used/, "and the attempt burned it");

    // Expired.
    const stale = makeState();
    await beginFlow(a.id, stale.stateHash, stale.state, null, CONFIGURED);
    await prisma.oAuthState.update({ where: { stateHash: stale.stateHash }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await assert.rejects(() => redeemState(a.id, stale.state, CONFIGURED), /expired/);

    // A state that belongs to the OTHER provider cannot be redeemed here.
    const yt = makeState();
    await beginYouTubeFlow(a.id, yt.stateHash, "pkce-verifier", null, {
      GOOGLE_CLIENT_ID: "x",
      GOOGLE_CLIENT_SECRET: "y",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost/cb",
      BOOKREEL_TOKEN_KEY: KEY,
    });
    await assert.rejects(() => redeemState(a.id, yt.state, CONFIGURED), /different session/, "a YouTube state is not an Instagram state");

    // A tampered row: the sealed nonce is moved from another user's flow, so the
    // AAD (which names the user) fails the tag check.
    const mine = makeState();
    const theirs = makeState();
    await beginFlow(a.id, mine.stateHash, mine.state, null, CONFIGURED);
    await beginFlow(b.id, theirs.stateHash, theirs.state, null, CONFIGURED);
    const theirsRow = await prisma.oAuthState.findUnique({ where: { stateHash: theirs.stateHash } });
    await prisma.oAuthState.update({ where: { stateHash: mine.stateHash }, data: { verifierEnc: theirsRow!.verifierEnc } });
    await assert.rejects(() => redeemState(a.id, mine.state, CONFIGURED), (e: unknown) => {
      assert.equal((e as { code?: string }).code, "bad_state");
      return true;
    });

    // A well-sealed nonce for the right user that does not equal the state.
    const swapped = makeState();
    await beginFlow(a.id, swapped.stateHash, "some-other-nonce", null, CONFIGURED);
    await assert.rejects(() => redeemState(a.id, swapped.state, CONFIGURED), /could not be verified/);

    // Hash agreement with the YouTube helper both flows share.
    assert.equal(hashState("x"), crypto.createHash("sha256").update("x").digest("hex"));
  } finally {
    await prisma.user.delete({ where: { id: a.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: b.id } }).catch(() => {});
  }
});

// ------------------------------------------------------------------- the exchange

test("the code exchange: code -> short token -> long-lived token -> Pages -> linked Instagram -> Page token, all server-side", async () => {
  const stub = oauthGraph();
  const result = await exchangeCode(APP, "AUTH-CODE", CONFIGURED, stub.impl);

  assert.equal(result.igUserId, "IG1");
  assert.equal(result.username, "between_pages", "the handle comes from Instagram's own answer");
  assert.equal(result.pageToken, PAGE_TOKEN, "the durable credential is the PAGE token");
  assert.equal(result.userToken, USER_TOKEN);
  assert.ok(result.userTokenExpiresAt && result.userTokenExpiresAt.getTime() > Date.now() + 50 * 86_400_000);
  assert.equal(result.scope, ALL_PERMISSIONS.join(" "), "the scope stored is what was GRANTED");

  const paths = stub.calls.map((c) => `${methodOf(c)} ${pathOf(c.url)}`);
  assert.deepEqual(paths, [
    "GET /oauth/access_token",
    "GET /oauth/access_token",
    "GET /me/permissions",
    "GET /me/accounts",
    "GET /P1",
  ]);

  const first = params(stub.calls[0]);
  assert.equal(first.get("code"), "AUTH-CODE");
  assert.equal(first.get("client_secret"), "test-app-secret", "the secret goes to Meta from the server, and nowhere else");
  assert.equal(first.get("redirect_uri"), APP.redirectUri);
  const second = params(stub.calls[1]);
  assert.equal(second.get("grant_type"), "fb_exchange_token");
  assert.equal(second.get("fb_exchange_token"), "SHORT-USER-TOKEN", "the long-lived exchange uses the short token");
  assert.equal(params(stub.calls[3]).get("access_token"), USER_TOKEN, "Pages are listed with the long-lived user token");
  assert.equal(params(stub.calls[4]).get("access_token"), PAGE_TOKEN, "the linked account is read with that Page's own token");
  assert.match(params(stub.calls[4]).get("fields")!, /instagram_business_account\{id,username\}/);
});

test("no Page with a linked Instagram professional account is a clear, actionable error", async () => {
  const noLink = oauthGraph({ ig: { P1: null } });
  await assert.rejects(
    () => exchangeCode(APP, "c", CONFIGURED, noLink.impl),
    (e: unknown) => {
      const err = e as { code?: string; status?: number; message?: string };
      assert.equal(err.code, "no_instagram_account");
      assert.equal(err.status, 409);
      assert.match(err.message!, /Business or\s+Creator/);
      assert.match(err.message!, /linked/);
      assert.match(err.message!, /connect again/);
      return true;
    },
  );

  const noPages = oauthGraph({ pages: [], ig: {} });
  await assert.rejects(() => exchangeCode(APP, "c", CONFIGURED, noPages.impl), /no Facebook Pages/);
});

test("a consent with a required permission unticked stores nothing", async () => {
  const stub = oauthGraph({ permissions: ["instagram_basic", "pages_show_list"] });
  await assert.rejects(
    () => exchangeCode(APP, "c", CONFIGURED, stub.impl),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, "missing_permission");
      assert.match((e as Error).message, /instagram_content_publish/);
      return true;
    },
  );
  assert.ok(!stub.calls.some((c) => pathOf(c.url) === "/me/accounts"), "it stopped before listing Pages");
});

test("when several Pages have Instagram accounts, the one whose username IS the expected handle is chosen", async () => {
  const stub = oauthGraph({
    pages: [
      { id: "P1", name: "Client", access_token: "TOKEN-P1" },
      { id: "P2", name: "Between Pages", access_token: "TOKEN-P2" },
    ],
    ig: { P1: { id: "IG-OTHER", username: "someone_else" }, P2: { id: "IG2", username: "Between_Pages" } },
  });
  const result = await exchangeCode(APP, "c", CONFIGURED, stub.impl);
  assert.equal(result.igUserId, "IG2");
  assert.equal(result.pageToken, "TOKEN-P2", "and the token that goes with THAT Page");

  // With no match, the first is taken -- and the identity check then blocks it.
  assert.equal(pickAccount([{ ig: { username: "a" } }, { ig: { username: "b" } }], "@between_pages")!.ig.username, "a");
  assert.equal(pickAccount([], "@between_pages"), null);
});

test("a Graph refusal during the exchange is a mapped sentence, never the raw payload", async () => {
  const stub = stubFetch(() => ({
    status: 400,
    body: { error: { message: "Error validating verification code.", type: "OAuthException", code: 100, fbtrace_id: "ABC" } },
  }));
  await assert.rejects(
    () => codeToShortToken(APP, "bad", stub.impl),
    (e: unknown) => {
      assert.ok(isInstagramApiError(e));
      assert.match((e as Error).message, /invalid/);
      assert.ok(!(e as Error).message.includes("fbtrace"), "no trace id or raw envelope");
      assert.ok(!(e as Error).message.includes("test-app-secret"));
      return true;
    },
  );
});

// ------------------------------------------------------------------- storage

test("the grant is stored sealed, bound to this user and namespace, and no view of it carries a token", async () => {
  requireIsolation("this test stores a grant");
  const user = await prisma.user.create({ data: { email: `ig-s-${randomUUID()}@example.test` } });
  const other = await prisma.user.create({ data: { email: `ig-o-${randomUUID()}@example.test` } });
  try {
    await storeGrant(user.id, grant(), CONFIGURED);
    const row = await prisma.platformAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider: "instagram" } },
    });
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes("PAGE-TOKEN-SECRET"), "the Page token is not in the database in the clear");
    assert.ok(!dump.includes("USER-TOKEN-SECRET"), "nor is the user token");
    assert.equal(row!.externalAccountId, "IG1");
    assert.equal(row!.externalAccountName, "@between_pages");
    assert.equal(row!.scope, ALL_PERMISSIONS.join(" "));

    // It round-trips under ITS OWN namespace, and under no other.
    assert.equal(open(row!.refreshTokenEnc, instagramTokenAad(user.id), CONFIGURED), PAGE_TOKEN);
    assert.equal(open(row!.accessTokenEnc!, instagramUserAad(user.id), CONFIGURED), USER_TOKEN);
    assert.throws(() => open(row!.refreshTokenEnc, refreshAad(user.id), CONFIGURED), "a youtube: AAD cannot open an instagram: value");
    assert.throws(() => open(row!.refreshTokenEnc, instagramTokenAad(other.id), CONFIGURED), "and it is bound to the user");
    assert.throws(() => open(row!.refreshTokenEnc, instagramUserAad(user.id), CONFIGURED), "the Page token and user token purposes differ");

    // Reconnecting replaces rather than duplicates, and forgets the old account.
    await storeGrant(user.id, grant({ igUserId: "IG9", username: "second_account" }), CONFIGURED);
    assert.equal(await prisma.platformAccount.count({ where: { userId: user.id, provider: "instagram" } }), 1);
    const again = await prisma.platformAccount.findUnique({ where: { userId_provider: { userId: user.id, provider: "instagram" } } });
    assert.equal(again!.externalAccountName, "@second_account");

    // The view: no field a credential could sit in, and no value of one.
    const view: ConnectionView = await connectionFor(user.id, CONFIGURED);
    assert.equal(view.connected, true);
    const wire = JSON.stringify(view);
    for (const secret of [PAGE_TOKEN, USER_TOKEN, "test-app-secret", KEY]) assert.ok(!wire.includes(secret), "no secret crosses the wire");
    assert.deepEqual(Object.keys(view).sort(), [
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
    ]);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
  }
});

test("connectionFor never throws: every failure is a sentence, and an unusable key reads as reconnect", async () => {
  requireIsolation("this test stores a grant");
  const user = await prisma.user.create({ data: { email: `ig-c-${randomUUID()}@example.test` } });
  try {
    const none = await connectionFor(user.id, CONFIGURED);
    assert.equal(none.connected, false);
    assert.equal(none.problem, null, "nothing is wrong: nobody has consented yet");
    assert.equal((await connectionFor(null, CONFIGURED)).connected, false);

    await storeGrant(user.id, grant(), CONFIGURED);
    // A key that has changed since.
    const rotated = { ...CONFIGURED, BOOKREEL_TOKEN_KEY: crypto.randomBytes(32).toString("base64") };
    const afterRotation = await connectionFor(user.id, rotated);
    assert.equal(afterRotation.connected, false);
    assert.match(afterRotation.problem!, /could not be decrypted|Reconnect|reconnect/i);

    // No environment at all.
    const unconfigured = await connectionFor(user.id, {});
    assert.equal(unconfigured.connected, false);
    assert.match(unconfigured.problem!, /META_APP_ID/);

    // A grant without the publish permission.
    await storeGrant(user.id, grant({ scope: "instagram_basic pages_show_list" }), CONFIGURED);
    assert.match((await connectionFor(user.id, CONFIGURED)).problem!, /permission to publish/);

    // Revoked.
    await storeGrant(user.id, grant(), CONFIGURED);
    await prisma.platformAccount.update({
      where: { userId_provider: { userId: user.id, provider: "instagram" } },
      data: { revokedAt: new Date() },
    });
    const revoked = await connectionFor(user.id, CONFIGURED);
    assert.equal(revoked.connected, false);
    assert.match(revoked.problem!, /revoked/);
    await assert.rejects(() => credentialsFor(user.id, CONFIGURED), /revoked/);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test("only accounts.ts ever reads an Instagram credential out of the database", async () => {
  const offenders: string[] = [];
  for (const name of await fs.readdir(IG_DIR)) {
    if (!name.endsWith(".ts") || name === "accounts.ts") continue;
    const source = withoutComments(await fs.readFile(path.join(IG_DIR, name), "utf8"));
    if (/refreshTokenEnc|accessTokenEnc/.test(source)) offenders.push(name);
    if (/\bopen\(/.test(source)) offenders.push(`${name} (decrypts)`);
    for (const m of source.matchAll(/^(?:let|var)\s+(\w*[Tt]oken\w*)/gm)) offenders.push(`${name}:${m[1]}`);
  }
  assert.deepEqual(offenders, [], `an Instagram credential is touched outside accounts.ts: ${offenders.join(", ")}`);
});

test("Disconnect revokes at Meta with the user grant, then forgets locally, and reports a revoke that did not land", async () => {
  requireIsolation("this test stores a grant");
  const user = await prisma.user.create({ data: { email: `ig-d-${randomUUID()}@example.test` } });
  try {
    await storeGrant(user.id, grant(), CONFIGURED);
    const ok = stubFetch(() => ({ status: 200, body: { success: true } }));
    const result = await disconnect(user.id, CONFIGURED, ok.impl);
    assert.deepEqual(result, { revoked: true, detail: null, hadAccount: true });
    assert.equal(methodOf(ok.calls[0]), "DELETE");
    assert.equal(pathOf(ok.calls[0].url), "/me/permissions");
    assert.equal(params(ok.calls[0]).get("access_token"), USER_TOKEN, "Meta only revokes from the USER token");
    assert.equal(await prisma.platformAccount.count({ where: { userId: user.id } }), 0, "and the row is gone");
    assert.deepEqual(await disconnect(user.id, CONFIGURED, ok.impl), { revoked: true, detail: null, hadAccount: false });

    // Meta unreachable: the local row is deleted anyway, and the failure is reported.
    await storeGrant(user.id, grant(), CONFIGURED);
    const down = stubFetch(() => ({ status: 500, body: { error: { message: "boom", code: 2 } } }));
    const failed = await disconnect(user.id, CONFIGURED, down.impl);
    assert.equal(failed.revoked, false);
    assert.match(failed.detail!, /server error/);
    assert.equal(await prisma.platformAccount.count({ where: { userId: user.id } }), 0, "a failed revoke never leaves a credential behind");

    // A user token that has already expired: Meta is not asked, and the operator is told.
    await storeGrant(user.id, grant({ userTokenExpiresAt: new Date(Date.now() - 1000) }), CONFIGURED);
    const never = stubFetch(() => {
      throw new Error("must not be called");
    });
    const expired = await disconnect(user.id, CONFIGURED, never.impl);
    assert.equal(expired.revoked, false);
    assert.match(expired.detail!, /expired/);
    assert.equal(never.calls.length, 0);

    // Already invalid at Meta (code 190) counts as revoked: the grant is gone either way.
    await storeGrant(user.id, grant(), CONFIGURED);
    const gone = stubFetch(() => ({ status: 400, body: { error: { message: "Invalid OAuth access token.", code: 190 } } }));
    assert.equal((await disconnect(user.id, CONFIGURED, gone.impl)).revoked, true);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

// ------------------------------------------------------------------- error mapping

test("every Graph refusal maps to its own code, sentence and retry advice", () => {
  const body = (code: number, message = "m", sub?: number) => ({ error: { message, code, error_subcode: sub } });
  const cases: Array<[string, number, unknown, string, boolean]> = [
    // [label, http status, payload, expected code, retryable]
    ["expired or revoked token", 400, body(190, "Error validating access token"), "reauth_required", false],
    ["token subcode 463", 400, body(190, "expired", 463), "reauth_required", false],
    ["http 401", 401, {}, "reauth_required", false],
    ["permission denied (10)", 400, body(10, "Application does not have permission"), "forbidden", false],
    ["permission block (200)", 403, body(200, "Requires instagram_content_publish"), "forbidden", false],
    ["generic invalid request (400)", 400, body(100, "Invalid parameter"), "invalid_request", false],
    ["bare http 400", 400, {}, "invalid_request", false],
    ["app rate limit (4)", 400, body(4), "rate_limited", true],
    ["user rate limit (17)", 400, body(17), "rate_limited", true],
    ["custom rate limit (613)", 400, body(613), "rate_limited", true],
    ["Instagram business rate limit (80002)", 400, body(80002), "rate_limited", true],
    ["http 429", 429, {}, "rate_limited", true],
    ["temporary Meta error (2)", 500, body(2), "platform_error", true],
    ["unknown Meta error (1)", 400, body(1), "platform_error", true],
    ["http 503", 503, {}, "platform_error", true],
    ["Meta could not fetch the video", 400, body(100, "Media download failed", 2207003), "media_unreachable", true],
    ["unsupported video format", 400, body(100, "Unsupported", 2207026), "media_unsupported", false],
    ["media not ready", 400, body(9007, "Media ID is not available", 2207027), "media_not_ready", true],
    ["daily publish cap", 400, body(100, "limit", 2207042), "daily_cap", false],
    ["action blocked (368)", 400, body(368, "temporarily blocked"), "forbidden", false],
  ];
  for (const [label, status, payload, code, retryable] of cases) {
    const mapped = mapGraphError(status, payload, "the test call");
    assert.equal(mapped.code, code, label);
    assert.equal(mapped.retryable, retryable, `${label}: retryable`);
    assert.ok(mapped.message.length > 30, `${label}: a whole sentence`);
    assert.doesNotMatch(mapped.message, /undefined|\[object/, label);
  }
  // Distinct actions: reconnect vs wait vs fix the request.
  assert.match(mapGraphError(400, body(190)).message, /connect Instagram again/);
  assert.match(mapGraphError(400, body(4)).message, /Wait/);
  assert.match(mapGraphError(400, body(100, "x", 2207003)).message, /PUBLIC_BASE_URL/);
  assert.match(mapGraphError(400, body(10)).message, /App Review/);

  // Meta's own words are carried through, capped, and never a credential.
  const long = mapGraphError(400, body(100, "x".repeat(2000)));
  assert.ok(long.message.length < 700, "Meta's text is capped");
  assert.match(mapGraphError(400, { error: { code: 100, message: "Invalid parameter", error_user_msg: "The caption is too long." } }).message, /caption is too long/);
});

test("a lost reply to the publish call is ambiguous, and says the Reel may be live", () => {
  const before = mapTransportError(new Error("fetch failed"));
  assert.equal(before.retryable, true);
  assert.match(before.message, /Nothing was posted/);

  const after = mapTransportError(new Error("socket hang up"), true);
  assert.equal(after.retryable, false, "retrying could post it twice");
  assert.match(after.message, /may or may not have been\s+posted/);
  assert.match(after.message, /check the Instagram account/);
});

// ------------------------------------------------------------------- the seed

interface Seed {
  ownerId: string;
  strangerId: string;
  ownedEpisodeId: string;
  otherOwnedEpisodeId: string;
  ownerlessEpisodeId: string;
  cleanup: () => Promise<void>;
}

/** Three finished episodes with real files, each rendering distinct bytes. */
async function seed(): Promise<Seed> {
  requireIsolation("these tests create episodes and write renders and posters");
  const owner = await prisma.user.create({ data: { email: `ig-own-${randomUUID()}@example.test` } });
  const stranger = await prisma.user.create({ data: { email: `ig-str-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({
    data: { title: `IG ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  const make = async (userId: string | null, fill: number) => {
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
        durationSec: 61.5,
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
    await fs.writeFile(renderFile, Buffer.alloc(9000, fill));
    await prisma.episode.update({
      where: { id: episode.id },
      data: { thumbnails: serializeThumbnails(specs), videoPath: renderFile },
    });
    return episode.id;
  };

  const ownedEpisodeId = await make(owner.id, 7);
  const otherOwnedEpisodeId = await make(owner.id, 9);
  const ownerlessEpisodeId = await make(null, 5);

  return {
    ownerId: owner.id,
    strangerId: stranger.id,
    ownedEpisodeId,
    otherOwnedEpisodeId,
    ownerlessEpisodeId,
    cleanup: async () => {
      for (const id of [ownedEpisodeId, otherOwnedEpisodeId, ownerlessEpisodeId]) {
        await fs.rm(thumbsDir(id), { recursive: true, force: true });
        await fs.rm(path.join(RENDER_DIR, `${id}.mp4`), { force: true });
      }
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
    },
  };
}

// ------------------------------------------------------- a scripted publishing API

interface Script {
  /** The username Instagram reports RIGHT NOW. */
  username?: string;
  accountId?: string;
  limit?: { used: number; total: number };
  limitError?: StubAnswer;
  /** `status_code` per poll; the last one repeats forever. */
  statuses?: string[];
  statusDetail?: string;
  createAnswer?: StubAnswer;
  publishAnswer?: StubAnswer | "throw";
  permalink?: string | "error";
}

/** The publishing conversation, scripted, recording every call. */
function publishGraph(script: Script = {}) {
  let polls = 0;
  return stubFetch((url, init) => {
    const p = pathOf(url);
    const method = init?.method ?? "GET";
    if (p === "/IG1" && method === "GET") {
      return { status: 200, body: { id: script.accountId ?? "IG1", username: script.username ?? "between_pages" } };
    }
    if (p === "/IG1/content_publishing_limit") {
      if (script.limitError) return script.limitError;
      const l = script.limit ?? { used: 3, total: 25 };
      return { status: 200, body: { data: [{ quota_usage: l.used, config: { quota_total: l.total, quota_duration: 86400 } }] } };
    }
    if (p === "/IG1/media" && method === "POST") return script.createAnswer ?? { status: 200, body: { id: "CONT1" } };
    if (p === "/CONT1") {
      const sequence = script.statuses ?? ["FINISHED"];
      const code = sequence[Math.min(polls++, sequence.length - 1)];
      return { status: 200, body: { id: "CONT1", status_code: code, ...(script.statusDetail ? { status: script.statusDetail } : {}) } };
    }
    if (p === "/IG1/media_publish" && method === "POST") {
      if (script.publishAnswer === "throw") throw new Error("socket hang up");
      return script.publishAnswer ?? { status: 200, body: { id: "MEDIA1" } };
    }
    if (p === "/MEDIA1") {
      if (script.permalink === "error") return { status: 500, body: { error: { message: "x", code: 2 } } };
      return { status: 200, body: { id: "MEDIA1", permalink: script.permalink ?? "https://www.instagram.com/reel/ABC123/" } };
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
}

/** A clock the publisher's wait loop can run on without waiting. */
function fakeClock() {
  let t = Date.now();
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const REQUEST: PublishRequest = {
  episodeId: "ep-1",
  metadata: { title: "T", description: "What the book says.", hashtags: ["#focus"], hook: "Most people are busy." },
  durationSec: 61,
  video: { path: "/work/renders/ep-1.mp4", bytes: 4_000_000, url: "/api/episodes/ep-1/video", contentType: "video/mp4" },
  poster: { path: "/work/thumbs/ep-1/9x16-quote.jpg", bytes: 120_000, url: "/api/episodes/ep-1/thumbnail/9x16-quote?v=1", contentType: "image/jpeg" },
};

async function connectOwner(userId: string, overrides: Partial<InstagramGrant> = {}): Promise<void> {
  await storeGrant(userId, grant(overrides), CONFIGURED);
}

// ------------------------------------------------------------------- publishing

test("a full publish: identity re-check, quota, container, polling to FINISHED, publish, permalink -- and it records the platform's own id", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph({ statuses: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"] });
    const clock = fakeClock();

    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...clock,
    });

    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "PUBLISHED");
    assert.equal(ig.job!.externalId, "MEDIA1", "the id came from the platform");
    assert.equal(ig.job!.externalUrl, "https://www.instagram.com/reel/ABC123/", "and so did the permalink");
    assert.ok(ig.job!.publishedAt, "and the confirmation time");
    assert.equal(ig.job!.lastError, null);
    assert.equal(ig.job!.uploadedBytes, null, "no byte count exists on this API, so none is invented");
    assert.equal(ig.job!.totalBytes, null);
    assert.equal(ig.job!.attempts, 1);

    // The exact conversation, in order.
    const sequence = graph.calls.map((c) => `${methodOf(c)} ${pathOf(c.url)}`);
    assert.deepEqual(sequence, [
      "GET /IG1",
      "GET /IG1/content_publishing_limit",
      "POST /IG1/media",
      "GET /CONT1",
      "GET /CONT1",
      "GET /CONT1",
      "POST /IG1/media_publish",
      "GET /MEDIA1",
    ]);

    const create = params(graph.calls[2]);
    assert.equal(create.get("media_type"), "REELS");
    assert.equal(create.get("share_to_feed"), "true");
    assert.equal(create.get("access_token"), PAGE_TOKEN, "the PAGE token publishes");
    const row = await prisma.episode.findUnique({ where: { id: s.ownedEpisodeId } });
    assert.equal(
      create.get("caption"),
      instagramCaption({
        title: row!.title ?? "",
        description: row!.description ?? "",
        hashtags: ["#focus", "#deepwork"],
        hook: row!.hook ?? "",
      }),
      "the caption is instagramCaption(meta), not a second composition",
    );
    assert.equal(params(graph.calls[6]).get("creation_id"), "CONT1");
    assert.equal(params(graph.calls[6]).get("access_token"), PAGE_TOKEN);

    // The URL Meta was given is a signed link for THIS episode, on the public base,
    // and following it yields this episode's bytes.
    const videoUrl = create.get("video_url")!;
    assert.match(videoUrl, /^https:\/\/reels\.example\.test\/api\/publish\/media\/[\w-]+\.[\w-]+$/);
    const token = videoUrl.split("/").pop()!;
    assert.equal(verifyMediaToken(token, CONFIGURED).episodeId, s.ownedEpisodeId);
    const served = await serveSignedMedia(new Request(videoUrl), token, CONFIGURED);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.alloc(9000, 7));

    // No secret in anything the browser reads.
    const wire = JSON.stringify(view);
    for (const secret of [PAGE_TOKEN, USER_TOKEN, "test-app-secret", KEY, "CONT1"]) assert.ok(!wire.includes(secret), "nothing secret in the view");

    // THE RETRY RULE: a job that already holds an id is not published again.
    const before = graph.calls.length;
    const again = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...clock,
    });
    assert.equal(graph.calls.length, before, "not one further request was made");
    assert.equal(again.platforms.find((p) => p.platform === "instagram")!.job!.attempts, 1);
  } finally {
    await s.cleanup();
  }
});

test("a container that never finishes is an honest FAILED -- never a faked PUBLISHED -- and publish is never called", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph({ statuses: ["IN_PROGRESS"] });
    const clock = fakeClock();

    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      pollIntervalMs: 5_000,
      pollTimeoutMs: 60_000,
      ...clock,
    });
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "FAILED");
    assert.notEqual(ig.status, "PUBLISHED");
    assert.equal(ig.job!.externalId, null, "no id the platform never gave");
    assert.equal(ig.job!.externalUrl, null);
    assert.equal(ig.job!.publishedAt, null);
    assert.match(ig.job!.lastError!, /still processing/);
    assert.match(ig.job!.lastError!, /NOT posted/);
    assert.ok(!graph.calls.some((c) => pathOf(c.url).endsWith("/media_publish")), "the post step was never reached");
    assert.ok(graph.calls.filter((c) => pathOf(c.url) === "/CONT1").length >= 2, "it did poll, repeatedly, before giving up");
    assert.ok(ig.handoff.length >= 3, "and the hand-off is still there");
  } finally {
    await s.cleanup();
  }
});

test("a container Instagram marks ERROR is FAILED with the reason, and the specific advice when the code is known", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const generic = publishGraph({ statuses: ["IN_PROGRESS", "ERROR"], statusDetail: "ERROR: Something went wrong" });
    const clock = fakeClock();
    const v1 = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: generic.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...clock,
    });
    const ig1 = v1.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig1.status, "FAILED");
    assert.match(ig1.job!.lastError!, /could not process the video/);
    assert.match(ig1.job!.lastError!, /Something went wrong/);
    assert.match(ig1.job!.lastError!, /Nothing was posted/);

    const known = publishGraph({ statuses: ["ERROR"], statusDetail: "Media upload has failed with error code 2207026" });
    const v2 = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: known.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...clock,
    });
    assert.match(v2.platforms.find((p) => p.platform === "instagram")!.job!.lastError!, /format/);
    assert.ok(!known.calls.some((c) => pathOf(c.url).endsWith("/media_publish")));
  } finally {
    await s.cleanup();
  }
});

test("the daily cap is checked first: at 25 of 25 nothing is created", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph({ limit: { used: 25, total: 25 } });
    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...fakeClock(),
    });
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "FAILED");
    assert.match(ig.job!.lastError!, /25/);
    assert.match(ig.job!.lastError!, /Nothing was posted/);
    assert.deepEqual(
      graph.calls.map((c) => `${methodOf(c)} ${pathOf(c.url)}`),
      ["GET /IG1", "GET /IG1/content_publishing_limit"],
      "no container was created",
    );

    // Under the cap proceeds; a limit the endpoint cannot answer fails closed.
    const unknown = publishGraph({ limitError: { status: 500, body: { error: { message: "down", code: 2 } } } });
    const v = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: unknown.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...fakeClock(),
    });
    assert.equal(v.platforms.find((p) => p.platform === "instagram")!.status, "FAILED");
    assert.ok(!unknown.calls.some((c) => pathOf(c.url) === "/IG1/media"), "an unanswered limit check does not proceed");
  } finally {
    await s.cleanup();
  }
});

test("Graph errors during a publish land in the right state: 190 reconnect, 400 fatal, rate limit retryable", async () => {
  const s = await seed();
  try {
    const run = async (createAnswer: StubAnswer) => {
      await connectOwner(s.ownerId);
      const graph = publishGraph({ createAnswer });
      const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
        env: CONFIGURED,
        fetchImpl: graph.impl,
        confirmPublic: true,
        waitForCompletion: true,
        ...fakeClock(),
      });
      return { ig: view.platforms.find((p) => p.platform === "instagram")!, graph };
    };

    const fatal = await run({ status: 400, body: { error: { message: "Invalid parameter", code: 100 } } });
    assert.equal(fatal.ig.status, "FAILED");
    assert.match(fatal.ig.job!.lastError!, /will not help/);

    const rate = await run({ status: 400, body: { error: { message: "Application request limit reached", code: 4 } } });
    assert.equal(rate.ig.status, "FAILED");
    assert.match(rate.ig.job!.lastError!, /rate-limiting/);
    assert.match(rate.ig.job!.lastError!, /Wait/);

    const denied = await run({ status: 403, body: { error: { message: "needs instagram_content_publish", code: 10 } } });
    assert.equal(denied.ig.status, "FAILED");
    assert.match(denied.ig.job!.lastError!, /App Review/);

    // 190: the credential stopped working. The state is REQUIRES_CONNECTION, the
    // grant is marked revoked, and the card will offer Reconnect.
    const dead = await run({ status: 400, body: { error: { message: "Error validating access token", code: 190 } } });
    assert.equal(dead.ig.status, "REQUIRES_CONNECTION", "the next action is reconnect, not retry");
    assert.match(dead.ig.job!.lastError!, /connect Instagram again/);
    const after = await connectionFor(s.ownerId, CONFIGURED);
    assert.equal(after.connected, false);
    assert.match(after.problem!, /revoked/);
  } finally {
    await s.cleanup();
  }
});

test("PUBLISHED requires a real platform media id: an answer without one is a FAILED that says check the account", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph({ publishAnswer: { status: 200, body: {} } });
    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...fakeClock(),
    });
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "FAILED");
    assert.equal(ig.job!.externalId, null, "an id nobody gave is never recorded");
    assert.equal(ig.job!.publishedAt, null);
    assert.match(ig.job!.lastError!, /without a media id/);
    assert.match(ig.job!.lastError!, /Check the Instagram account/);

    // Structural: the only literal PUBLISHED outcome sits beside `mediaId`.
    const source = await fs.readFile(path.join(IG_DIR, "publisher.ts"), "utf8");
    const published = [...source.matchAll(/status:\s*"PUBLISHED"/g)];
    assert.equal(published.length, 1, "one place can produce a published outcome");
    assert.match(source.slice(published[0].index!, published[0].index! + 120), /externalId:\s*mediaId/);
  } finally {
    await s.cleanup();
  }
});

test("a connection lost during the publish call itself is reported as ambiguous, not retryable", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph({ publishAnswer: "throw" });
    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...fakeClock(),
    });
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "FAILED");
    assert.equal(ig.job!.externalId, null);
    assert.match(ig.job!.lastError!, /may or may not have been\s+posted/);
  } finally {
    await s.cleanup();
  }
});

test("a post that went up is PUBLISHED even when its permalink cannot be read", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph({ permalink: "error" });
    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: graph.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...fakeClock(),
    });
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "PUBLISHED");
    assert.equal(ig.job!.externalId, "MEDIA1");
    assert.equal(ig.job!.externalUrl, null, "no link is better than an invented one");
  } finally {
    await s.cleanup();
  }
});

test("transient errors while WAITING do not end the wait; a run of them does", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    // One blip then FINISHED.
    let polls = 0;
    const flaky = stubFetch((url, init) => {
      const p = pathOf(url);
      const method = init?.method ?? "GET";
      if (p === "/IG1" && method === "GET") return { status: 200, body: { id: "IG1", username: "between_pages" } };
      if (p === "/IG1/content_publishing_limit") return { status: 200, body: { data: [{ quota_usage: 0, config: { quota_total: 25 } }] } };
      if (p === "/IG1/media") return { status: 200, body: { id: "CONT1" } };
      if (p === "/CONT1") {
        polls++;
        return polls === 1
          ? { status: 500, body: { error: { message: "blip", code: 2 } } }
          : { status: 200, body: { status_code: "FINISHED" } };
      }
      if (p === "/IG1/media_publish") return { status: 200, body: { id: "MEDIA1" } };
      return { status: 200, body: { permalink: "https://www.instagram.com/reel/Z/" } };
    });
    const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
      env: CONFIGURED,
      fetchImpl: flaky.impl,
      confirmPublic: true,
      waitForCompletion: true,
      ...fakeClock(),
    });
    assert.equal(view.platforms.find((p) => p.platform === "instagram")!.status, "PUBLISHED");
  } finally {
    await s.cleanup();
  }
});

test("a run of transient errors, an EXPIRED container and a container already PUBLISHED each end the wait without a post", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const run = async (graph: { impl: typeof fetch }) => {
      const view = await startInstagramPublish(s.ownerId, s.ownedEpisodeId, {
        env: CONFIGURED,
        fetchImpl: graph.impl,
        confirmPublic: true,
        waitForCompletion: true,
        ...fakeClock(),
      });
      return view.platforms.find((p) => p.platform === "instagram")!;
    };

    // Three 5xx answers in a row to the status check: the wait is abandoned with
    // Meta's mapped reason, not retried forever.
    const down = stubFetch((url, init) => {
      const p = pathOf(url);
      const method = init?.method ?? "GET";
      if (p === "/IG1" && method === "GET") return { status: 200, body: { id: "IG1", username: "between_pages" } };
      if (p === "/IG1/content_publishing_limit") return { status: 200, body: { data: [{ quota_usage: 0, config: { quota_total: 25 } }] } };
      if (p === "/IG1/media") return { status: 200, body: { id: "CONT1" } };
      if (p === "/CONT1") return { status: 503, body: { error: { message: "unavailable", code: 2 } } };
      throw new Error(`must not be reached: ${method} ${p}`);
    });
    const abandoned = await run(down);
    assert.equal(abandoned.status, "FAILED");
    assert.match(abandoned.job!.lastError!, /server error/);
    assert.equal(down.calls.filter((c) => pathOf(c.url) === "/CONT1").length, 3, "three tries, then it stops");

    const expired = publishGraph({ statuses: ["EXPIRED"] });
    const e = await run(expired);
    assert.equal(e.status, "FAILED");
    assert.match(e.job!.lastError!, /discarded/);
    assert.ok(!expired.calls.some((c) => pathOf(c.url).endsWith("/media_publish")));

    // "Already published" is not success: this app was never given that media id.
    const already = publishGraph({ statuses: ["PUBLISHED"] });
    const a = await run(already);
    assert.equal(a.status, "FAILED");
    assert.equal(a.job!.externalId, null);
    assert.match(a.job!.lastError!, /already published/);
    assert.match(a.job!.lastError!, /Check the Instagram account/);
    assert.ok(!already.calls.some((c) => pathOf(c.url).endsWith("/media_publish")));
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------------------- refusals, before anything is sent

test("publishing needs an explicit public confirmation, and nothing is sent or recorded without it", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph();
    for (const confirmPublic of [undefined, false] as const) {
      await assert.rejects(
        () => startInstagramPublish(s.ownerId, s.ownedEpisodeId, { env: CONFIGURED, fetchImpl: graph.impl, confirmPublic, ...fakeClock() }),
        (e: unknown) => {
          const err = e as { status?: number; code?: string; message?: string };
          assert.equal(err.status, 409);
          assert.equal(err.code, "needs_confirmation");
          assert.match(err.message!, /publicly/);
          assert.match(err.message!, /draft/);
          return true;
        },
      );
    }
    assert.equal(graph.calls.length, 0, "not one request left this machine");
    assert.equal(await prisma.publishJob.count({ where: { episodeId: s.ownedEpisodeId } }), 0, "and no attempt was recorded");

    // The route requires the same word, and only `true` counts.
    const route = await fs.readFile(
      fileURLToPath(new URL("../src/app/api/episodes/[id]/publish/instagram/route.ts", import.meta.url)),
      "utf8",
    );
    assert.match(route, /confirmPublic:\s*body\?\.confirmPublic === true/);
    assert.match(route, /export const maxDuration = 900/, "the long operation is allowed to be long");
  } finally {
    await s.cleanup();
  }
});

test("publishing requires genuine ownership: an ownerless or foreign episode is refused", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const graph = publishGraph();
    await assert.rejects(
      () => startInstagramPublish(s.ownerId, s.ownerlessEpisodeId, { env: CONFIGURED, fetchImpl: graph.impl, confirmPublic: true, ...fakeClock() }),
      /no owner/,
    );
    await assert.rejects(
      () => startInstagramPublish(s.strangerId, s.ownedEpisodeId, { env: CONFIGURED, fetchImpl: graph.impl, confirmPublic: true, ...fakeClock() }),
      /another account/,
    );
    assert.equal(graph.calls.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("an unconfigured server, an unconnected user and an unreachable public address each refuse in their own words, sending nothing", async () => {
  const s = await seed();
  try {
    const graph = publishGraph();
    const opts = { fetchImpl: graph.impl, confirmPublic: true, ...fakeClock() };

    await assert.rejects(
      () => startInstagramPublish(s.ownerId, s.ownedEpisodeId, { env: {}, ...opts }),
      (e: unknown) => {
        const err = e as { status?: number; code?: string; message?: string };
        assert.equal(err.status, 409);
        assert.equal(err.code, "requires_connection");
        assert.match(err.message!, /META_APP_ID/);
        assert.match(err.message!, /nothing was sent/i);
        return true;
      },
    );
    await assert.rejects(() => startInstagramPublish(s.ownerId, s.ownedEpisodeId, { env: CONFIGURED, ...opts }), /No Instagram account is connected/);

    await connectOwner(s.ownerId);
    await assert.rejects(
      () => startInstagramPublish(s.ownerId, s.ownedEpisodeId, { env: { ...CONFIGURED, PUBLIC_BASE_URL: "http://localhost:3013" }, ...opts }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, "public_url");
        assert.match((e as Error).message, /localhost:3013/);
        assert.match((e as Error).message, /cannot reach/);
        return true;
      },
    );
    assert.equal(graph.calls.length, 0, "none of them reached Meta");
    assert.equal(await prisma.publishJob.count({ where: { episodeId: s.ownedEpisodeId } }), 0);
  } finally {
    await s.cleanup();
  }
});

// ------------------------------------------------------- registry and the fallback

test("the registry hands Instagram its own provider, whose capabilities and steps are the handoff's until a verified account exists", async () => {
  assert.equal(hasRealPublisher("instagram"), true);

  const unconfigured = publisherFor("instagram", { userId: "u1", env: {} });
  const handoff = manualHandoff("instagram");
  const caps = unconfigured.capabilities();
  const manualCaps = handoff.capabilities();
  for (const key of ["id", "label", "canUpload", "canSetThumbnail", "canSchedule", "canReportBack", "limits"] as const) {
    assert.deepEqual(caps[key], manualCaps[key], `${key} is the handoff's`);
  }
  assert.equal(caps.canUpload, false);
  assert.ok(caps.requires.some((r) => /META_APP_ID/.test(r)) && caps.requires.some((r) => /PUBLIC_BASE_URL/.test(r)), "what it needs is named");

  assert.equal(await unconfigured.isConfigured(), false);
  const prepared = await unconfigured.prepare(REQUEST);
  assert.equal(prepared.status, "REQUIRES_CONNECTION", "not READY: pressing a button would do nothing");
  // THE FALLBACK. Byte for byte the assisted handoff.
  assert.deepEqual(prepared.handoff, handoffSteps("instagram", REQUEST));
  assert.deepEqual(prepared.handoff, (await handoff.prepare(REQUEST)).handoff);
  assert.ok(prepared.handoff.some((s) => s.label === "Copy caption" && s.text === instagramCaption(REQUEST.metadata)));
  assert.ok(prepared.handoff.some((s) => s.kind === "open" && /Instagram/.test(s.label)));

  // And its validation is the handoff's: same limits, same sentences.
  assert.deepEqual(unconfigured.validate(REQUEST), handoff.validate(REQUEST));
  const over = { ...REQUEST, metadata: { ...REQUEST.metadata, igCaption: "x".repeat(2300), igHook: "h" } };
  assert.deepEqual(unconfigured.validate(over), handoff.validate(over));
  assert.equal(unconfigured.validate(over).ok, false, "caption over 2200 is refused");
  assert.match(unconfigured.validate(over).problems.join(" "), /allows 2200/);
  const manyTags = { ...REQUEST, metadata: { ...REQUEST.metadata, igHook: "h", igCaption: "c", igHashtags: Array.from({ length: 31 }, (_, i) => `#t${i}`) } };
  assert.match(unconfigured.validate(manyTags).problems.join(" "), /30 is the most Instagram counts|31 tags/);

  // With no user, publish is exactly the handoff's outcome; with a user but no
  // Meta app it is a REQUIRES_CONNECTION that names what is missing.
  const anonymous = publisherFor("instagram");
  assert.deepEqual(await anonymous.publish(prepared), await handoff.publish(await handoff.prepare(REQUEST)));
  const named = await unconfigured.publish(prepared);
  assert.equal(named.status, "REQUIRES_CONNECTION");
  assert.ok("error" in named && /META_APP_ID/.test(named.error), "and it names what is missing");
});

test("configured, connected and verified: the provider offers the API, still with the handoff beside it", async () => {
  const s = await seed();
  try {
    await connectOwner(s.ownerId);
    const publisher = publisherFor("instagram", { userId: s.ownerId, env: CONFIGURED });
    assert.equal(publisher.capabilities().canUpload, false, "nothing is claimed before the connection has been checked");
    assert.equal(await publisher.isConfigured(), true);
    const caps = publisher.capabilities();
    assert.equal(caps.canUpload, true);
    assert.equal(caps.canSchedule, false, "nothing here schedules; saying true would offer a dead control");
    assert.equal(caps.canSetThumbnail, false, "no cover is sent, so no thumbnail control is offered");

    const prepared = await publisher.prepare(REQUEST);
    assert.equal(prepared.status, "READY");
    assert.deepEqual(prepared.handoff, handoffSteps("instagram", REQUEST), "the hand-off is offered even when the API is");

    // And through the real view: READY, canUpload, configured, handoff.
    const view = await publishView(s.ownerId, s.ownedEpisodeId, { env: CONFIGURED });
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ig.status, "READY");
    assert.equal(ig.configured, true);
    assert.equal(ig.hasPublisher, true);
    assert.equal(ig.capabilities.canUpload, true);
    assert.ok(ig.handoff.length >= 3);
    const yt = view.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(yt.status, "REQUIRES_CONNECTION", "YouTube is untouched by an Instagram connection");

    // With no Meta app in the environment the same user falls back to the handoff.
    const fallback = await publishView(s.ownerId, s.ownedEpisodeId, { env: {} });
    const igFallback = fallback.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(igFallback.status, "REQUIRES_CONNECTION");
    assert.equal(igFallback.capabilities.canUpload, false);
    assert.deepEqual(igFallback.handoff, ig.handoff, "identical steps in either state");
  } finally {
    await s.cleanup();
  }
});

test("the Graph modules never reach the real network without being handed a fetch", async () => {
  const offenders: string[] = [];
  for (const name of await fs.readdir(IG_DIR)) {
    if (!name.endsWith(".ts")) continue;
    const source = await fs.readFile(path.join(IG_DIR, name), "utf8");
    // Every `fetch(` call must be through an injected binding (`doFetch`) -- a
    // bare `await fetch(` is the bug. A parameter DEFAULT (`= fetch`) is how the
    // route handlers get the real one, and is not a call.
    for (const m of source.matchAll(/(?<![.\w])fetch\s*\(/g)) {
      const before = source.slice(Math.max(0, m.index! - 24), m.index!);
      if (!/doFetch|fetchImpl/.test(before)) offenders.push(`${name}: ...${before.trim()}fetch(`);
    }
    assert.doesNotMatch(source, /from\s+["'](facebook|fb|instagram-|@facebook)/, `${name}: no SDK, raw fetch only`);
    assert.doesNotMatch(withoutComments(source), /puppeteer|playwright|selenium|chromium|page\.goto|document\./i, `${name}: no browser automation`);
  }
  assert.deepEqual(offenders, [], `these call the network directly and cannot be tested: ${offenders.join(", ")}`);
});

// ------------------------------------------------------------------- the callback route

test("the callback shows only sentences this app wrote, and compares the state before it trusts a code", async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL("../src/app/api/publish/instagram/callback/route.ts", import.meta.url)),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  assert.match(code, /isNamedAppError\(err\)/, "the allow-list is in place");
  assert.doesNotMatch(code, /err instanceof Error\s*\n?\s*\?\s*err\.message/, "a raw Error message must not become the reason shown");
  assert.ok(code.indexOf("redeemState(") < code.indexOf("exchangeCode("), "the state is redeemed before the code is exchanged");
  assert.ok(code.indexOf("exchangeCode(") < code.indexOf("storeGrant("), "and the grant is stored only after a successful exchange");
  assert.match(code, /currentUser\(\)/, "and there must be a session");
  assert.doesNotMatch(code, /NextResponse\.json/, "no JSON body exists that a token could be put into");

  const connect = await fs.readFile(
    fileURLToPath(new URL("../src/app/api/publish/instagram/connect/route.ts", import.meta.url)),
    "utf8",
  );
  assert.match(connect, /NextResponse\.redirect\(authorizeUrl\(config, state, SCOPE_PARAM\), 303\)/);
  assert.match(connect, /missing\.join/, "an unconfigured install is a 409 naming the missing variables");
  assert.ok(connect.indexOf("beginFlow(") < connect.indexOf("NextResponse.redirect("), "state is stored before the redirect");
});

// ------------------------------------------------------------------- the card

const Card = ((cardModule as { default: unknown }).default as { default?: unknown }).default ??
  (cardModule as { default: unknown }).default;

function renderCard(state: Partial<PlatformState>, owned = true): string {
  const base: PlatformState = {
    platform: "instagram",
    label: "Instagram",
    status: "REQUIRES_CONNECTION",
    capabilities: instagramPublisher({ userId: null, env: {} }).capabilities(),
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

test("before anything is known, the Instagram card says NOT CONFIGURED and offers neither Connect nor Publish", () => {
  const html = renderCard({});
  assert.match(html, /Not configured/);
  assert.ok(!html.includes(instagramCopy.publish), "no publish button before a connection is known");
  assert.ok(!html.includes(instagramCopy.connect), "and no Connect either: the server may have no credentials");
  assert.ok(!/Connected/.test(html.replace(/Not connected/g, "")), "nothing claims a connection");
});

test("the card's wiring: the second press alone sends the confirmation, and the copy says public and immediate", async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL("../src/components/InstagramPublish.tsx", import.meta.url)),
    "utf8",
  );
  assert.equal([...withoutComments(source).matchAll(/confirmPublic:\s*true/g)].length, 1, "confirmPublic is sent in exactly one place");
  assert.match(source, /setConfirming\(true\)/, "the first press only opens the question");
  assert.match(source, /identityOk/, "the control is gated on a verified identity");
  assert.match(source, /\/api\/publish\/instagram\/connect/);
  assert.match(instagramCopy.confirmPrompt, /in public/);
  assert.match(instagramCopy.confirmPrompt, /draft/);
  assert.match(instagramCopy.publishNote, /immediately and publicly/);
  assert.match(instagramCopy.consentNote, /facebook\.com/);
  assert.equal(INSTAGRAM_CONNECT_PARAM, "instagram");
  assert.equal(INSTAGRAM_CONNECT_REASON_PARAM, "instagram_reason");
});

// ------------------------------------------------------------------- graph wrappers

test("createReelContainer and publishContainer speak the documented shapes and refuse an answer without an id", async () => {
  const ok = stubFetch((url) => (pathOf(url).endsWith("/media") ? { status: 200, body: { id: "C9" } } : { status: 200, body: { id: "M9" } }));
  assert.equal(
    await createReelContainer("IG1", "TOK", { videoUrl: "https://h.example.test/v", caption: "cap", shareToFeed: true }, ok.impl),
    "C9",
  );
  const sent = params(ok.calls[0]);
  assert.equal(methodOf(ok.calls[0]), "POST");
  assert.equal(sent.get("media_type"), "REELS");
  assert.equal(sent.get("video_url"), "https://h.example.test/v");
  assert.equal(sent.get("caption"), "cap");
  assert.equal(sent.get("share_to_feed"), "true");
  assert.equal(await publishContainer("IG1", "TOK", "C9", ok.impl), "M9");
  assert.equal(params(ok.calls[1]).get("creation_id"), "C9");

  const empty = stubFetch(() => ({ status: 200, body: {} }));
  await assert.rejects(() => createReelContainer("IG1", "TOK", { videoUrl: "u", caption: "c", shareToFeed: true }, empty.impl), /no container id/);
  await assert.rejects(() => publishContainer("IG1", "TOK", "C9", empty.impl), /without a media id/);

  // An id with path characters in it cannot change the endpoint.
  const traversal = stubFetch(() => ({ status: 200, body: { id: "x" } }));
  await createReelContainer("../../me", "TOK", { videoUrl: "u", caption: "c", shareToFeed: true }, traversal.impl);
  assert.ok(!pathOf(traversal.calls[0].url).includes("../"), "the account id is encoded into the path");
});
