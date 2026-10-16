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
import {
  displayHandle,
  identityCopy,
  identitySentence,
  judgeIdentity,
  normaliseHandle,
  type ConnectionView,
} from "../src/lib/publish/connect";
import { DEFAULT_EXPECTED_HANDLE, EXPECTED_HANDLE_ENV, expectedHandle } from "../src/lib/publish/identity";
import { publishView } from "../src/lib/publish/state";
import type { PublishRequest } from "../src/lib/publish/contract";
import { YOUTUBE_SCOPES, SCOPE_PARAM as YT_SCOPE_PARAM } from "../src/lib/publish/youtube/config";
import { authorizeUrl, hasReadonlyScope, hasUploadScope, makePkce } from "../src/lib/publish/youtube/oauth";
import {
  connectionFor as youtubeConnection,
  noteChannel,
  storeGrant as storeYouTubeGrant,
  verifyChannelIdentity,
} from "../src/lib/publish/youtube/accounts";
import { youTubePublisher } from "../src/lib/publish/youtube/publisher";
import { startYouTubePublish } from "../src/lib/publish/youtube/run";
import { connectionFor as instagramConnection, storeGrant as storeInstagramGrant, type InstagramGrant } from "../src/lib/publish/instagram/accounts";
import { instagramPublisher } from "../src/lib/publish/instagram/publisher";
import { startInstagramPublish } from "../src/lib/publish/instagram/run";
import type { EnvLike } from "../src/lib/publish/youtube/secrets";
import * as identityModule from "../src/components/IdentityStatus";
import { requireIsolation } from "./setup/isolation";

/**
 * Identity verification: "do not trust a display label".
 *
 * Every verdict in this file is checked against the thing that is supposed to
 * produce it -- a handle the PLATFORM'S API returned -- and against the things
 * that are supposed NOT to: a stored title, a stored name, an upload response's
 * channel title, an operator-typed label. NOTHING HERE MAKES A NETWORK REQUEST;
 * every call is given a stub `fetch`.
 */

const KEY = crypto.randomBytes(32).toString("base64");

const YT_ENV: EnvLike = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3013/api/publish/youtube/callback",
  BOOKREEL_TOKEN_KEY: KEY,
};

const IG_ENV: EnvLike = {
  META_APP_ID: "test-app-id",
  META_APP_SECRET: "test-app-secret",
  PUBLIC_BASE_URL: "https://reels.example.test",
  BOOKREEL_TOKEN_KEY: KEY,
};

const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";

interface StubAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => StubAnswer) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const answer = handler(url, init);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer.headers ?? {})) if (v !== undefined) headers[k] = v;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers });
  }) as typeof fetch;
  return { impl, calls };
}

/** A stub that must never be reached. */
const noNetwork = () =>
  stubFetch((url) => {
    throw new Error(`the network must not be touched: ${url}`);
  });

/** `channels.list?mine=true`, answering with this channel. */
const channelsAnswering = (items: unknown[]) =>
  stubFetch((url) => {
    if (url.startsWith(CHANNELS_URL)) return { status: 200, body: { items } };
    throw new Error(`unexpected ${url}`);
  });

const CHANNEL = (customUrl: string | undefined, title = "Between Pages") => ({
  id: "UCbetween",
  snippet: { title, ...(customUrl === undefined ? {} : { customUrl }) },
});

const READONLY_SCOPE = YOUTUBE_SCOPES.join(" ");
const UPLOAD_ONLY_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

async function ytGrant(userId: string, scope: string): Promise<void> {
  await storeYouTubeGrant(
    userId,
    { accessToken: "ya29.go", refreshToken: "1//go", expiresAt: new Date(Date.now() + 3600_000), scope },
    YT_ENV,
  );
}

async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<T> {
  requireIsolation("this test creates a user and stored grants");
  const user = await prisma.user.create({ data: { email: `id-${randomUUID()}@example.test` } });
  try {
    return await fn(user.id);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
}

// ------------------------------------------------------------------- the pure rule

test("handles compare lowercase with the leading @ stripped, and only an API-returned handle can match", () => {
  assert.equal(normaliseHandle("@BetweenPages08-L4D"), "betweenpages08-l4d");
  assert.equal(normaliseHandle("  @@x "), "x");
  assert.equal(normaliseHandle(null), "");
  assert.equal(normaliseHandle(undefined), "");
  assert.equal(displayHandle("between_pages"), "@between_pages");
  assert.equal(displayHandle("@between_pages"), "@between_pages");
  assert.equal(displayHandle(""), "");
  assert.equal(displayHandle(null), "");

  assert.equal(judgeIdentity("@between_pages", "@between_pages"), "match");
  assert.equal(judgeIdentity("BETWEEN_PAGES", "@between_pages"), "match", "case-insensitive, @ optional");
  assert.equal(judgeIdentity("between_pages", "between_pages"), "match");
  assert.equal(judgeIdentity("@between_pages2", "@between_pages"), "mismatch", "a near miss is a mismatch");
  assert.equal(judgeIdentity("@between_pages ", "@between_pages"), "match", "surrounding space is not part of a handle");
  assert.equal(judgeIdentity(null, "@between_pages"), "unverified", "no API handle is never a match");
  assert.equal(judgeIdentity("", "@between_pages"), "unverified");
  assert.equal(judgeIdentity("@anyone", ""), "mismatch", "a blanked expectation fails closed instead of matching everything");
  assert.equal(judgeIdentity("@", "@between_pages"), "unverified", "a bare @ is no handle");
});

test("the expected handles default to the two accounts, are overridable, and a blank override falls back", () => {
  assert.deepEqual(DEFAULT_EXPECTED_HANDLE, { youtube: "@betweenpages08-l4d", instagram: "@between_pages" });
  assert.deepEqual(EXPECTED_HANDLE_ENV, { youtube: "BOOKREEL_YOUTUBE_HANDLE", instagram: "BOOKREEL_INSTAGRAM_HANDLE" });
  assert.equal(expectedHandle("youtube", {}), "@betweenpages08-l4d");
  assert.equal(expectedHandle("instagram", {}), "@between_pages");
  assert.equal(expectedHandle("instagram", { BOOKREEL_INSTAGRAM_HANDLE: "new_brand" }), "@new_brand");
  assert.equal(expectedHandle("youtube", { BOOKREEL_YOUTUBE_HANDLE: "  @Other-Channel " }), "@Other-Channel");
  assert.equal(expectedHandle("youtube", { BOOKREEL_YOUTUBE_HANDLE: "   " }), "@betweenpages08-l4d");
});

test("each verdict has its own sentence, and a match has none", () => {
  assert.equal(identitySentence("YouTube", "match", "@a", "@a"), null);
  const mismatch = identitySentence("Instagram", "mismatch", "@wrong", "@between_pages")!;
  assert.match(mismatch, /Wrong Instagram account/);
  assert.match(mismatch, /@wrong/);
  assert.match(mismatch, /@between_pages/);
  assert.match(mismatch, /blocked/);
  assert.match(identitySentence("YouTube", "unverified", null, "@x")!, /has not confirmed/);
  const legacy = identitySentence("YouTube", "unverified", null, "@x", { legacy: true })!;
  assert.match(legacy, /predates account verification/);
  assert.match(legacy, /Reconnect to verify/);
  assert.doesNotMatch(legacy, /blocked/, "the legacy warning does not claim a block it does not apply");
});

// ------------------------------------------------------------------- YouTube

test("YouTube MATCH: the verdict is the handle channels.list returned, and it is recorded", async () => {
  await withUser(async (userId) => {
    await ytGrant(userId, READONLY_SCOPE);
    const stub = channelsAnswering([CHANNEL("@BetweenPages08-L4D", "Anything At All")]);
    const result = await verifyChannelIdentity(userId, YT_ENV, stub.impl);

    assert.equal(result.verdict, "match");
    assert.equal(result.handle, "@BetweenPages08-L4D");
    assert.equal(result.channelId, "UCbetween");

    // The request is the documented one, authorised with a fresh access token.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${CHANNELS_URL}?part=snippet&mine=true`);
    assert.equal((stub.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer ya29.go");

    const row = await prisma.platformAccount.findUnique({ where: { userId_provider: { userId, provider: "youtube" } } });
    assert.equal(row!.externalAccountId, "UCbetween");
    assert.equal(row!.externalAccountName, "@BetweenPages08-L4D");

    const view: ConnectionView = await youtubeConnection(userId, YT_ENV);
    assert.equal(view.identity, "match");
    assert.equal(view.verifiedHandle, "@BetweenPages08-L4D");
    assert.equal(view.expectedHandle, "@betweenpages08-l4d");
    assert.equal(view.identityNote, null);
    assert.equal(view.identityBlocksPublish, false);
    assert.equal(view.connected, true);
    assert.equal(await youTubePublisher({ userId, env: YT_ENV }).isConfigured(), true);
  });
});

test("YouTube MISMATCH: publishing is blocked at the publisher and at the route, with the sentence, and the handoff survives", async () => {
  await withUser(async (userId) => {
    await ytGrant(userId, READONLY_SCOPE);
    const result = await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([CHANNEL("@someone-else")]).impl);
    assert.equal(result.verdict, "mismatch");

    const view = await youtubeConnection(userId, YT_ENV);
    assert.equal(view.connected, true, "it is still connected, so the card can offer Disconnect");
    assert.equal(view.identity, "mismatch");
    assert.equal(view.verifiedHandle, "@someone-else");
    assert.equal(view.identityBlocksPublish, true);
    assert.match(view.identityNote!, /Wrong YouTube account/);
    assert.match(view.identityNote!, /@someone-else/);
    assert.match(view.identityNote!, /@betweenpages08-l4d/);

    const publisher = youTubePublisher({ userId, env: YT_ENV });
    assert.equal(await publisher.isConfigured(), false, "isConfigured refuses on a mismatch");

    const request = REQUEST;
    const prepared = await publisher.prepare(request);
    assert.equal(prepared.status, "REQUIRES_CONNECTION", "not READY");
    assert.ok(prepared.handoff.length >= 5, "and the manual handoff is untouched");
    const net = noNetwork();
    const outcome = await youTubePublisher({ userId, env: YT_ENV, fetchImpl: net.impl }).publish(prepared);
    assert.equal(outcome.status, "REQUIRES_CONNECTION");
    assert.ok("error" in outcome && /Wrong YouTube account/.test(outcome.error));
    assert.equal(net.calls.length, 0, "nothing was uploaded or even asked");

    // The route-level entry point refuses before it records or sends anything.
    const s = await seedEpisode(userId);
    try {
      await assert.rejects(
        () => startYouTubePublish(userId, s.episodeId, { env: YT_ENV, fetchImpl: net.impl }),
        (e: unknown) => {
          const err = e as { status?: number; code?: string; message?: string };
          assert.equal(err.status, 409);
          assert.equal(err.code, "identity_blocked");
          assert.match(err.message!, /Wrong YouTube account/);
          assert.match(err.message!, /Nothing was sent/);
          return true;
        },
      );
      assert.equal(await prisma.publishJob.count({ where: { episodeId: s.episodeId } }), 0, "no attempt is recorded");
      assert.equal(net.calls.length, 0);

      const pv = await publishView(userId, s.episodeId, { env: YT_ENV });
      const yt = pv.platforms.find((p) => p.platform === "youtube")!;
      assert.equal(yt.status, "REQUIRES_CONNECTION");
      assert.ok(yt.handoff.length >= 5, "the handoff is still offered for a mismatched account");
    } finally {
      await s.cleanup();
    }
  });
});

test("YouTube UNVERIFIED: a connection that predates the identity scope says 'reconnect to verify' and KEEPS its upload ability", async () => {
  await withUser(async (userId) => {
    await ytGrant(userId, UPLOAD_ONLY_SCOPE);

    // Not asked: the answer would be a 403, and asking would be a useless call.
    const net = noNetwork();
    const result = await verifyChannelIdentity(userId, YT_ENV, net.impl);
    assert.equal(result.verdict, "unverified");
    assert.match(result.problem!, /predates account verification/);
    assert.equal(net.calls.length, 0);

    const view = await youtubeConnection(userId, YT_ENV);
    assert.equal(view.identity, "unverified");
    assert.equal(view.verifiedHandle, null);
    assert.match(view.identityNote!, /Reconnect to verify/);
    assert.equal(view.identityBlocksPublish, false, "it is warned, not blocked");
    assert.equal(view.connected, true);
    assert.equal(hasUploadScope(UPLOAD_ONLY_SCOPE), true);
    assert.equal(hasReadonlyScope(UPLOAD_ONLY_SCOPE), false);

    // Upload ability intact: the publisher is configured, and a publish gets as
    // far as asking YouTube for an upload session (here refused by quota -- the
    // point is that the identity gate did not stand in the way).
    assert.equal(await youTubePublisher({ userId, env: YT_ENV }).isConfigured(), true);
    const s = await seedEpisode(userId);
    try {
      const stub = stubFetch((url) => {
        if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
          return { status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } };
        }
        throw new Error(`unexpected ${url}`);
      });
      const v = await startYouTubePublish(userId, s.episodeId, { env: YT_ENV, fetchImpl: stub.impl, waitForCompletion: true });
      const yt = v.platforms.find((p) => p.platform === "youtube")!;
      assert.equal(yt.status, "FAILED");
      assert.match(yt.job!.lastError!, /quota/i, "it reached YouTube; the gate did not refuse it");
      assert.ok(stub.calls.length >= 1);
      assert.ok(!stub.calls.some((c) => c.url.startsWith(CHANNELS_URL)), "and a legacy grant is never sent to channels.list");
    } finally {
      await s.cleanup();
    }
  });
});

test("YouTube: a TITLE is not an identity. A label that spells the expected handle verifies nothing", async () => {
  await withUser(async (userId) => {
    // A legacy grant whose stored name (from an upload response's channelTitle)
    // reads exactly like the expected handle.
    await ytGrant(userId, UPLOAD_ONLY_SCOPE);
    await noteChannel(userId, "UCfake", "@betweenpages08-l4d");
    let row = await prisma.platformAccount.findUnique({ where: { userId_provider: { userId, provider: "youtube" } } });
    assert.equal(row!.externalAccountName, "@betweenpages08-l4d", "(the label really is in the database)");
    let view = await youtubeConnection(userId, YT_ENV);
    assert.equal(view.identity, "unverified", "and it is not read as a handle");
    assert.equal(view.verifiedHandle, null);

    // A verifiable grant: the label in the column is overwritten by the API's answer.
    await ytGrant(userId, READONLY_SCOPE);
    await prisma.platformAccount.update({
      where: { userId_provider: { userId, provider: "youtube" } },
      data: { externalAccountName: "@betweenpages08-l4d" }, // a stale / hand-edited label
    });
    const result = await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([CHANNEL("@intruder", "@betweenpages08-l4d")]).impl);
    assert.equal(result.verdict, "mismatch", "the API's customUrl wins over the title that spells the expected handle");
    row = await prisma.platformAccount.findUnique({ where: { userId_provider: { userId, provider: "youtube" } } });
    assert.equal(row!.externalAccountName, "@intruder", "and the stored label is corrected from the API");
    view = await youtubeConnection(userId, YT_ENV);
    assert.equal(view.identity, "mismatch");

    // And an upload response's channel title cannot overwrite the verified handle.
    await noteChannel(userId, "UCbetween", "@betweenpages08-l4d");
    row = await prisma.platformAccount.findUnique({ where: { userId_provider: { userId, provider: "youtube" } } });
    assert.equal(row!.externalAccountName, "@intruder", "noteChannel is held off the verified name");
    assert.equal((await youtubeConnection(userId, YT_ENV)).identity, "mismatch");
  });
});

test("YouTube: the check is repeated LIVE before an upload, so a stale 'match' cannot authorise a post", async () => {
  await withUser(async (userId) => {
    await ytGrant(userId, READONLY_SCOPE);
    await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([CHANNEL("@betweenpages08-l4d")]).impl);
    assert.equal((await youtubeConnection(userId, YT_ENV)).identity, "match", "the stored verdict says match");

    const s = await seedEpisode(userId);
    try {
      // ...but YouTube now says this credential is a different channel.
      const stub = channelsAnswering([CHANNEL("@different-channel")]);
      await assert.rejects(
        () => startYouTubePublish(userId, s.episodeId, { env: YT_ENV, fetchImpl: stub.impl }),
        (e: unknown) => {
          assert.equal((e as { code?: string }).code, "identity_blocked");
          assert.match((e as Error).message, /@different-channel/);
          return true;
        },
      );
      assert.deepEqual(stub.calls.map((c) => c.url), [`${CHANNELS_URL}?part=snippet&mine=true`], "only the identity read was made; no upload started");
      assert.equal(await prisma.publishJob.count({ where: { episodeId: s.episodeId } }), 0);

      // And a lookup that cannot be made at all falls back to the stored, API-sourced verdict.
      await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([CHANNEL("@betweenpages08-l4d")]).impl);
      const down = stubFetch((url) => {
        if (url.startsWith(CHANNELS_URL)) throw new Error("network down");
        return { status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } };
      });
      const v = await startYouTubePublish(userId, s.episodeId, { env: YT_ENV, fetchImpl: down.impl, waitForCompletion: true });
      assert.equal(v.platforms.find((p) => p.platform === "youtube")!.status, "FAILED", "it proceeded to the upload, which this stub refuses");
    } finally {
      await s.cleanup();
    }
  });
});

test("YouTube: a verifiable grant with no handle yet is UNVERIFIED and BLOCKED; a failed lookup says why and never throws", async () => {
  await withUser(async (userId) => {
    await ytGrant(userId, READONLY_SCOPE);
    const before = await youtubeConnection(userId, YT_ENV);
    assert.equal(before.identity, "unverified");
    assert.equal(before.identityBlocksPublish, true, "it COULD be verified, so it is not waved through");
    assert.doesNotMatch(before.identityNote!, /predates/);

    const refused = await verifyChannelIdentity(userId, YT_ENV, stubFetch(() => ({ status: 403, body: { error: { errors: [{ reason: "forbidden" }], message: "nope" } } })).impl);
    assert.equal(refused.verdict, "unverified");
    assert.match(refused.problem!, /not permitted/);

    const noChannels = await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([]).impl);
    assert.equal(noChannels.verdict, "unverified");
    assert.match(noChannels.problem!, /no channel/);

    const noHandle = await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([CHANNEL(undefined)]).impl);
    assert.equal(noHandle.verdict, "unverified");
    assert.equal(noHandle.channelId, "UCbetween");
    assert.match(noHandle.problem!, /without an @handle/);

    const lost = await verifyChannelIdentity(userId, YT_ENV, stubFetch(() => {
      throw new Error("socket hang up");
    }).impl);
    assert.equal(lost.verdict, "unverified");
    assert.doesNotMatch(lost.problem!, /socket|hang/, "no raw transport error text reaches the operator");

    const nobody = await verifyChannelIdentity(randomUUID(), YT_ENV, noNetwork().impl);
    assert.equal(nobody.verdict, "unverified");
  });
});

test("YouTube: reconnecting forgets the previous channel's handle instead of inheriting it", async () => {
  await withUser(async (userId) => {
    await ytGrant(userId, READONLY_SCOPE);
    await verifyChannelIdentity(userId, YT_ENV, channelsAnswering([CHANNEL("@betweenpages08-l4d")]).impl);
    assert.equal((await youtubeConnection(userId, YT_ENV)).identity, "match");

    await ytGrant(userId, READONLY_SCOPE); // a new consent, possibly as another channel
    const view = await youtubeConnection(userId, YT_ENV);
    assert.equal(view.identity, "unverified", "the old verification does not carry over");
    assert.equal(view.verifiedHandle, null);
    assert.equal(view.identityBlocksPublish, true);
  });
});

test("YouTube's consent asks for read-only as well as upload, and the callback refuses a consent that drops it", async () => {
  assert.equal(YT_SCOPE_PARAM, `${YOUTUBE_SCOPES[0]} ${YOUTUBE_SCOPES[1]}`);
  const url = new URL(
    authorizeUrl({ clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost/cb" }, "state", makePkce().challenge),
  );
  assert.equal(url.searchParams.get("scope"), YT_SCOPE_PARAM);
  assert.match(url.searchParams.get("scope")!, /youtube\.readonly/);
  assert.match(url.searchParams.get("scope")!, /youtube\.upload/);

  const source = await fs.readFile(fileURLToPath(new URL("../src/app/api/publish/youtube/callback/route.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  assert.match(code, /hasReadonlyScope\(tokens\.scope\)/, "a fresh consent must include the identity scope");
  assert.match(code, /hasUploadScope\(tokens\.scope\)/, "and upload gating is unchanged");
  assert.ok(code.indexOf("storeGrant(") < code.indexOf("verifyChannelIdentity("), "the channel is asked about right after it is stored");
});

// ------------------------------------------------------------------- Instagram

function igGrant(username: string): InstagramGrant {
  return {
    pageId: "P1",
    pageName: "Page",
    pageToken: "EAAPAGE-TOKEN",
    userToken: "EAAUSER-TOKEN",
    userTokenExpiresAt: new Date(Date.now() + 50 * 86_400_000),
    igUserId: "IG1",
    username,
    scope: "instagram_basic instagram_content_publish pages_show_list",
  };
}

const REQUEST: PublishRequest = {
  episodeId: "ep-1",
  metadata: { title: "T", description: "What the book says.", hashtags: ["#focus"], hook: "Most people are busy." },
  durationSec: 61,
  video: { path: "/work/renders/ep-1.mp4", bytes: 4_000_000, url: "/api/episodes/ep-1/video", contentType: "video/mp4" },
  poster: { path: "/work/thumbs/ep-1/9x16-quote.jpg", bytes: 120_000, url: "/api/episodes/ep-1/thumbnail/9x16-quote?v=1", contentType: "image/jpeg" },
};

test("Instagram MATCH: the handle Instagram reported at connect time is compared, case-insensitively", async () => {
  await withUser(async (userId) => {
    await storeInstagramGrant(userId, igGrant("Between_Pages"), IG_ENV);
    const view = await instagramConnection(userId, IG_ENV);
    assert.equal(view.identity, "match");
    assert.equal(view.verifiedHandle, "@Between_Pages");
    assert.equal(view.expectedHandle, "@between_pages");
    assert.equal(view.identityNote, null);
    assert.equal(view.identityBlocksPublish, false);

    // The expectation is configuration, not code.
    const rebranded = await instagramConnection(userId, { ...IG_ENV, BOOKREEL_INSTAGRAM_HANDLE: "@new_brand" });
    assert.equal(rebranded.identity, "mismatch");
    assert.equal(rebranded.expectedHandle, "@new_brand");
  });
});

test("Instagram MISMATCH blocks everything that would post, names both handles, and leaves the handoff alone", async () => {
  await withUser(async (userId) => {
    await storeInstagramGrant(userId, igGrant("someone_else"), IG_ENV);
    const view = await instagramConnection(userId, IG_ENV);
    assert.equal(view.connected, true, "connected -- so the card can show which account and offer Disconnect");
    assert.equal(view.identity, "mismatch");
    assert.equal(view.identityBlocksPublish, true);
    assert.match(view.identityNote!, /Wrong Instagram account/);
    assert.match(view.identityNote!, /@someone_else/);
    assert.match(view.identityNote!, /@between_pages/);

    const net = noNetwork();
    const publisher = instagramPublisher({ userId, env: IG_ENV, fetchImpl: net.impl });
    assert.equal(await publisher.isConfigured(), false, "isConfigured refuses");
    assert.equal(publisher.capabilities().canUpload, false, "and no upload capability is claimed");
    const gate = await publisher.gate();
    assert.equal(gate.ready, false);
    assert.match(gate.reason!, /Wrong Instagram account/);

    const prepared = await publisher.prepare(REQUEST);
    assert.equal(prepared.status, "REQUIRES_CONNECTION");
    assert.ok(prepared.handoff.length >= 3, "the manual handoff is untouched");
    assert.equal(publisher.validate(REQUEST).ok, true, "validate() is request-level, so the handoff is not withdrawn");

    const outcome = await publisher.publish(prepared);
    assert.equal(outcome.status, "REQUIRES_CONNECTION");
    assert.ok("error" in outcome && /Wrong Instagram account/.test(outcome.error));
    assert.equal(net.calls.length, 0, "nothing was sent to Meta");

    const s = await seedEpisode(userId);
    try {
      await assert.rejects(
        () => startInstagramPublish(userId, s.episodeId, { env: IG_ENV, fetchImpl: net.impl, confirmPublic: true }),
        (e: unknown) => {
          const err = e as { status?: number; code?: string; message?: string };
          assert.equal(err.status, 409);
          assert.equal(err.code, "identity_blocked");
          assert.match(err.message!, /Wrong Instagram account/);
          assert.match(err.message!, /Nothing was sent/);
          return true;
        },
      );
      assert.equal(await prisma.publishJob.count({ where: { episodeId: s.episodeId } }), 0);
      assert.equal(net.calls.length, 0);

      const pv = await publishView(userId, s.episodeId, { env: IG_ENV });
      const ig = pv.platforms.find((p) => p.platform === "instagram")!;
      assert.equal(ig.status, "REQUIRES_CONNECTION");
      assert.equal(ig.configured, false);
      assert.equal(ig.capabilities.canUpload, false);
      assert.deepEqual(ig.problems, [], "the request is fine, so the handoff is not hidden behind a problem");
      assert.ok(ig.handoff.length >= 3);
    } finally {
      await s.cleanup();
    }
  });
});

test("Instagram: the verdict at publish time comes from Instagram's answer NOW, not from the stored label", async () => {
  await withUser(async (userId) => {
    // The stored label says the right account.
    await storeInstagramGrant(userId, igGrant("between_pages"), IG_ENV);
    assert.equal((await instagramConnection(userId, IG_ENV)).identity, "match");

    // ...but Instagram now reports a different username for that account id.
    const stub = stubFetch((url) => {
      const p = new URL(url).pathname.replace(/^\/v\d+\.\d+/, "");
      if (p === "/IG1") return { status: 200, body: { id: "IG1", username: "renamed_or_swapped" } };
      throw new Error(`nothing past the identity read may be called: ${url}`);
    });
    const publisher = instagramPublisher({ userId, env: IG_ENV, fetchImpl: stub.impl });
    const prepared = await publisher.prepare(REQUEST);
    const outcome = await publisher.publish(prepared);
    assert.equal(outcome.status, "REQUIRES_CONNECTION");
    assert.ok("error" in outcome && /@renamed_or_swapped/.test(outcome.error) && /Nothing was sent/.test(outcome.error));
    assert.equal(stub.calls.length, 1, "only the identity read; no limit check, no container");

    // The stored label now tracks the API, so the card stops saying "match".
    const after = await instagramConnection(userId, IG_ENV);
    assert.equal(after.identity, "mismatch");
    assert.equal(after.verifiedHandle, "@renamed_or_swapped");

    // A different account id behind the same label is also refused.
    await storeInstagramGrant(userId, igGrant("between_pages"), IG_ENV);
    const swapped = stubFetch(() => ({ status: 200, body: { id: "IG-OTHER", username: "between_pages" } }));
    const o2 = await instagramPublisher({ userId, env: IG_ENV, fetchImpl: swapped.impl }).publish(prepared);
    assert.equal(o2.status, "REQUIRES_CONNECTION", "a matching name on a different account id is not the account that was connected");
    assert.equal(swapped.calls.length, 1);
  });
});

test("Instagram: a connection with no username on record cannot be verified, and is blocked", async () => {
  await withUser(async (userId) => {
    await storeInstagramGrant(userId, igGrant("between_pages"), IG_ENV);
    await prisma.platformAccount.update({
      where: { userId_provider: { userId, provider: "instagram" } },
      data: { externalAccountName: null },
    });
    const view = await instagramConnection(userId, IG_ENV);
    assert.equal(view.identity, "unverified");
    assert.equal(view.identityBlocksPublish, true);
    assert.match(view.identityNote!, /has not confirmed/);
    assert.equal(await instagramPublisher({ userId, env: IG_ENV }).isConfigured(), false);
  });
});

// ------------------------------------------------------------------- the card

function view(overrides: Partial<ConnectionView>): ConnectionView {
  return {
    config: { configured: true, missing: [], keyProblem: null },
    connected: true,
    channelId: "IG1",
    channelTitle: "@x",
    connectedAt: new Date().toISOString(),
    scopes: [],
    problem: null,
    verifiedHandle: "@between_pages",
    expectedHandle: "@between_pages",
    identity: "match",
    identityNote: null,
    identityBlocksPublish: false,
    ...overrides,
  };
}

// The suite is `.mts` and `src` is `.ts` under a package with no `"type"`, so the
// component's default export can arrive wrapped once (the same unwrapping
// `tests/publish-youtube.test.mts` does for the YouTube card).
const IdentityStatus = ((identityModule as { default: unknown }).default as { default?: unknown }).default ??
  (identityModule as { default: unknown }).default;

const render = (connection: ConnectionView, platform = "Instagram") =>
  renderToStaticMarkup(
    React.createElement(IdentityStatus as React.ComponentType<{ platform: string; connection: ConnectionView }>, {
      platform,
      connection,
    }),
  );

test("the identity block shows the API's handle beside the expected one: verified, blocked, or warned", () => {
  const ok = render(view({}));
  assert.match(ok, /Verified account/);
  assert.match(ok, /@between_pages/);
  assert.match(ok, /Expected account/);
  assert.match(ok, /Verified: Instagram reports this connection as @between_pages/);
  assert.match(ok, /Reported by Instagram&#x27;s API, not typed in\.|Reported by Instagram's API, not typed in\./);
  assert.ok(!ok.includes('role="alert"'), "a match raises no alert");

  const wrong = render(
    view({
      verifiedHandle: "@someone_else",
      identity: "mismatch",
      identityBlocksPublish: true,
      identityNote: identitySentence("Instagram", "mismatch", "@someone_else", "@between_pages"),
    }),
  );
  assert.match(wrong, /role="alert"/, "a wrong account is a prominent alert");
  assert.match(wrong, new RegExp(identityCopy.blockedHeading));
  assert.match(wrong, /@someone_else/);
  assert.match(wrong, /@between_pages/);
  assert.match(wrong, /Wrong Instagram account/);
  assert.ok(!wrong.includes("is the expected account"), "and never claims a verification it did not make");

  const unverified = render(
    view({
      verifiedHandle: null,
      identity: "unverified",
      identityBlocksPublish: true,
      identityNote: identitySentence("Instagram", "unverified", null, "@between_pages"),
    }),
  );
  assert.match(unverified, /Not verified/);
  assert.match(unverified, /role="alert"/);

  // The YouTube legacy case: a warning, not a block.
  const legacy = render(
    view({
      verifiedHandle: null,
      identity: "unverified",
      identityBlocksPublish: false,
      identityNote: identitySentence("YouTube", "unverified", null, "@betweenpages08-l4d", { legacy: true }),
    }),
    "YouTube",
  );
  assert.match(legacy, /Reconnect to verify/);
  assert.ok(!legacy.includes('role="alert"'), "an existing connection is warned, not blocked");
  assert.match(legacy, /role="status"/);
});

test("both cards surface the verdict and gate their publish control on it", async () => {
  for (const name of ["YouTubePublish.tsx", "InstagramPublish.tsx"]) {
    const source = await fs.readFile(fileURLToPath(new URL(`../src/components/${name}`, import.meta.url)), "utf8");
    assert.match(source, /<IdentityStatus platform=/, `${name} renders the identity block`);
    assert.match(source, /identityCopy\.publishBlocked/, `${name} says so where the publish control would be`);
  }
  const center = await fs.readFile(fileURLToPath(new URL("../src/components/PublishCenter.tsx", import.meta.url)), "utf8");
  assert.match(center, /<InstagramPublish /, "the Publish Center mounts the Instagram card");
  assert.match(center, /state\.platform === "instagram" && state\.hasPublisher/);
  assert.match(center, /c\.handoffHeading/, "and the hand-off section is still rendered for every platform");
});

// ------------------------------------------------------------------- a seeded episode

async function seedEpisode(userId: string): Promise<{ episodeId: string; cleanup: () => Promise<void> }> {
  requireIsolation("these tests create episodes and write renders and posters");
  const book = await prisma.book.create({
    data: { title: `ID ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });
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
  const dir = thumbsDir(episode.id);
  const specs: ThumbSpec[] = THUMB_KEYS.map((key) => ({
    key,
    aspect: key.startsWith("9x16") ? ("9:16" as const) : ("16:9" as const),
    variant: key.split("-")[1] as ThumbSpec["variant"],
    path: path.join(dir, `${key}.jpg`),
    width: 1080,
    height: 1920,
    rev: 1,
  }));
  await fs.mkdir(dir, { recursive: true });
  for (const s of specs) await fs.writeFile(s.path, "poster bytes");
  await fs.mkdir(RENDER_DIR, { recursive: true });
  const renderFile = path.join(RENDER_DIR, `${episode.id}.mp4`);
  await fs.writeFile(renderFile, Buffer.alloc(9000, 3));
  await prisma.episode.update({
    where: { id: episode.id },
    data: { thumbnails: serializeThumbnails(specs), videoPath: renderFile },
  });
  return {
    episodeId: episode.id,
    cleanup: async () => {
      await fs.rm(thumbsDir(episode.id), { recursive: true, force: true });
      await fs.rm(renderFile, { force: true });
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
    },
  };
}
