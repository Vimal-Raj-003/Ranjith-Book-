import test from "node:test";
import assert from "node:assert/strict";
import { reviewStudioVideo, createStudioReviewRunner, STUDIO_REVIEW_TIMEOUT_MS, type ReviewCall } from "../src/lib/publish/browser/youtube-review";
import { currentSignal, withAbortSignal } from "../src/lib/cancel";
import { callContext, METRICS_FILE } from "../src/lib/content/cli-metrics";
import { runCliJson } from "../src/lib/content/cli-provider";
import { browserYouTubePublisher } from "../src/lib/publish/browser/youtube";
import { setSetting } from "../src/lib/db";
import fs from "node:fs/promises";
import path from "node:path";
import { tagsLength } from "../src/lib/publish/youtube/publisher";
import type { PreparedPublish } from "../src/lib/publish/contract";
import { fixtureTags } from "./helpers/youtube-details-fixture.mjs";

const evidence = "At work, adults can build sustainable routines by starting with small, manageable goals.";
const sourceText = evidence + " Daily reflection and tracking progress help us learn from setbacks and keep improving our attention and habits.";
const prepared: PreparedPublish = { sourceText, episodeId: "synthetic", platform: "youtube", video: { path: "/synthetic.mp4", bytes: 1, contentType: "video/mp4", url: "/synthetic.mp4" }, poster: null, preparedAt: new Date(), status: "READY", handoff: [], metadata: { title: "Daily habits at work", description: sourceText, hashtags: [], hook: "Start small" } };
const response = { audience: "general", reason: "The script explicitly addresses adults building sustainable routines at work.", evidence, tags: fixtureTags };

test("review uses the stored script, preserves copy, and targets 480–500 characters including tag overhead", async () => {
  const before = structuredClone(prepared);
  const reviewed = await reviewStudioVideo(prepared, async (system, input) => {
    assert.match(system, /480–500 characters TOTAL, not words/);
    assert.match(system, /ambiguity must be uncertain/);
    assert.equal(JSON.parse(input).script, sourceText);
    return response;
  });
  assert.deepEqual(prepared, before);
  assert.deepEqual(reviewed.tags, fixtureTags);
  assert.ok(tagsLength(reviewed.tags) >= 480 && tagsLength(reviewed.tags) <= 500);
});

// Measured 2026-11-01 on gemini-3.5-flash-lite against six real scripts: with the old one-sentence instruction
// ("quote an exact supporting passage") a model sometimes wrapped the quote in its own words, which the verbatim check
// correctly refused and so HELD the video (17% of runs, one video 6 of 6). This wording cut that to 0 of 36 for the same
// check. The gate was NOT loosened: the wrapped form is still refused, below.
test("the evidence instruction forbids lead-ins and quotation marks, and a lead-in wrapped around a real quote is still refused", async () => {
  let seen = "";
  await reviewStudioVideo(prepared, async system => { seen = system; return response; });
  assert.match(seen, /copy ONE contiguous passage of at least 20 characters from the script exactly as written, character for character/);
  assert.match(seen, /Evidence must contain ONLY that copied passage: no lead-in words or label, no surrounding quotation marks/);
  assert.match(seen, /Put all explanation in reason only/);
  assert.doesNotMatch(seen, /Explain your reasoning and quote an exact supporting passage/);

  // The failure the instruction prevents is still a refusal if a model produces it anyway: a real quote inside the model's own words.
  await assert.rejects(
    reviewStudioVideo(prepared, async () => ({ ...response, evidence: `The script discusses routines at work: '${evidence}'` })),
    /Audience needs human review \(general\)/,
  );
  // And a verbatim passage that is too short to be evidence is still refused.
  await assert.rejects(reviewStudioVideo(prepared, async () => ({ ...response, evidence: "At work, adults" })), /Audience needs human review \(general\)/);
});

for (const audience of ["child_directed", "uncertain", "", undefined]) {
  test(`audience ${String(audience)} cannot produce an automatic No`, async () => {
    await assert.rejects(reviewStudioVideo(prepared, async () => ({ ...response, audience })), /Audience needs human review/);
  });
}
test("missing script and explicit child-directed signals stop before a model call", async () => {
  const forbidden: ReviewCall = async () => { assert.fail("No generation should run"); };
  await assert.rejects(reviewStudioVideo({ ...prepared, sourceText: undefined }, forbidden), /stored video script/);
  await assert.rejects(reviewStudioVideo({ ...prepared, sourceText: "Hello kids! " + sourceText }, forbidden), /child-directed audience signal/);
});
test("unsupported evidence, malformed responses, invalid and oversized tags fail closed", async () => {
  for (const bad of [null, { ...response, evidence: "An invented passage that is not in the video." }, { ...response, tags: ["x".repeat(501)] }, { ...response, tags: ["daily,habits"] }, { ...response, tags: [] }]) {
    await assert.rejects(reviewStudioVideo(prepared, async () => bad), /No new file was selected/);
  }
});
test("duplicate tags are removed, and sparse accurate tags are never padded", async () => {
  const result = await reviewStudioVideo(prepared, async () => ({ ...response, tags: ["daily habits", "Daily Habits", "habits daily", "workplace routines"] }));
  assert.deepEqual(result.tags, ["daily habits", "workplace routines"]);
});
test("a failed or stalled reviewer stops with an actionable error", async () => {
  await assert.rejects(reviewStudioVideo(prepared, async () => { throw new Error("Provider unavailable"); }), /Provider unavailable/);
  await assert.rejects(reviewStudioVideo(prepared, () => new Promise(() => {}), 15), /timed out/);
});

test("a 333-second provider response completes under the bounded seven-minute review deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let finished = false;
  const result = reviewStudioVideo(prepared, async (_system, _input, _schema, signal) => {
    assert.equal(currentSignal(), signal);
    assert.equal(callContext.getStore()?.episodeId, prepared.episodeId);
    assert.equal(callContext.getStore()?.step, "youtube-audience-tags-review");
    await new Promise(resolve => setTimeout(resolve, 333_000));
    assert.equal(signal.aborted, false);
    return response;
  }).then(value => { finished = true; return value; });
  t.mock.timers.tick(120_000);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(213_000);
  assert.deepEqual((await result).tags, fixtureTags);
  assert.equal(STUDIO_REVIEW_TIMEOUT_MS, 420_000);
  assert.equal(currentSignal(), undefined, "scoped cancellation must not leak into other work");
});

test("timeout aborts the provider signal and a late valid result cannot populate the cache", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, signal: AbortSignal | undefined, reply!: (value: unknown) => void;
  const runner = createStudioReviewRunner(async (_s, _i, _j, received) => {
    calls++; signal = received;
    if (calls === 1) return new Promise(resolve => { reply = resolve; }); // adapter ignores abort
    return response;
  }, "fixture-provider-v1", async () => "fixture-video-sha256");
  const first = runner(prepared, 100);
  const stopped = assert.rejects(first, /timed out.*provider cancellation requested/);
  await Promise.resolve(); // asset digest
  t.mock.timers.tick(100);
  await stopped;
  assert.equal(signal?.aborted, true);
  reply(response);
  await Promise.resolve();
  assert.deepEqual((await runner(prepared, 100)).tags, fixtureTags);
  assert.equal(calls, 2, "late replies are discarded, not reused");
});

test("validated results are shared and copied, but changed inputs, asset contents, or expiry require review", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  let calls = 0, digest = "video-a";
  const runner = createStudioReviewRunner(async () => { calls++; return response; }, "fixture-provider/model/policy", async () => digest);
  const [first, second] = await Promise.all([runner(prepared), runner(prepared)]);
  first.tags.length = 0;
  assert.deepEqual(second.tags, fixtureTags);
  assert.deepEqual((await runner(prepared)).tags, fixtureTags);
  assert.equal(calls, 1);
  await runner({ ...prepared, metadata: { ...prepared.metadata, title: "Changed title" } });
  await runner({ ...prepared, sourceText: sourceText + " Changed ending." });
  digest = "video-b";
  await runner(prepared);
  assert.equal(calls, 4);
  t.mock.timers.tick(60 * 60_000);
  await runner(prepared);
  assert.equal(calls, 5);
  const differentProvider = createStudioReviewRunner(async () => { calls++; return response; }, "different-provider", async () => digest);
  await differentProvider(prepared);
  assert.equal(calls, 6);
});

test("uncertain and malformed assessments are never cached as audience approval", async () => {
  for (const invalid of [{ ...response, audience: "uncertain" }, { ...response, evidence: "Unverified invented script evidence" }]) {
    let calls = 0;
    const runner = createStudioReviewRunner(async () => { calls++; return invalid; }, "fixture", async () => "video");
    await assert.rejects(runner(prepared), /human review/);
    await assert.rejects(runner(prepared), /human review/);
    assert.equal(calls, 2);
  }
});

test("external cancellation is preserved and does not cancel another review", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const stopped = withAbortSignal(controller.signal, () => reviewStudioVideo(prepared, async (_s, _i, _j, received) => {
    signal = received;
    return new Promise(() => {});
  }));
  const rejected = assert.rejects(stopped, /fixture operator cancellation/);
  const separate = reviewStudioVideo(prepared, async () => response);
  controller.abort(new Error("fixture operator cancellation"));
  await rejected;
  assert.equal(signal?.aborted, true);
  assert.deepEqual((await separate).tags, fixtureTags);
  assert.equal(currentSignal(), undefined);
});

test("the real Gemini fetch receives cancellation and does not retry or fall back to another model", async t => {
  assert.ok(process.env.BOOKREEL_TEST_DB_PID && process.env.DATABASE_URL?.replaceAll("\\", "/").includes("/.bookreel/test/run-"));
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "synthetic-api-key-never-sent";
  t.after(() => { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; });
  let requests = 0, aborted = false;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests++;
    const signal = init.signal!;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    });
  });
  let providerDone!: Promise<unknown>;
  await assert.rejects(reviewStudioVideo(prepared, (s, i, j) => providerDone = runCliJson("gemini", s, i, j, "gemini-3.6-flash"), 1000), /timed out/);
  await assert.rejects(providerDone, /Cancelled/); // Wait for the provider's cancellation metric to be flushed.
  assert.equal(requests, 1);
  assert.equal(aborted, true);
  const metric = JSON.parse((await fs.readFile(METRICS_FILE, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(metric.episodeId, prepared.episodeId);
  assert.equal(metric.step, "youtube-audience-tags-review");
});

test("production reviewer reuses only its own verified response and hashes actual video contents", async t => {
  assert.ok(process.env.BOOKREEL_TEST_DB_PID);
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "synthetic-api-key-never-sent";
  t.after(() => { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; });
  await setSetting("cliProvider", "gemini");
  const file = path.join(process.env.BOOKREEL_WORK_ROOT!, "review-fixture.mp4");
  await fs.writeFile(file, "synthetic-video-a");
  const input = { ...prepared, video: { ...prepared.video, path: file } };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] }, finishReason: "STOP" }] }), { status: 200 });
  });
  assert.deepEqual((await reviewStudioVideo(input)).tags, fixtureTags);
  assert.deepEqual((await reviewStudioVideo(input)).tags, fixtureTags);
  assert.equal(requests, 1);
  await fs.writeFile(file, "synthetic-video-b"); // same path and size
  await reviewStudioVideo(input);
  assert.equal(requests, 2);
});

test("successful review proceeds to browser launch while provider failure or timeout stops safely before launch", async t => {
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "synthetic-api-key-never-sent";
  t.after(() => { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; });
  await setSetting("cliProvider", "gemini");
  await setSetting("geminiModel", "gemini-3.8-flash");
  const file = path.join(process.env.BOOKREEL_WORK_ROOT!, "review-launch-fixture.mp4");
  await fs.writeFile(file, "synthetic-video-launch");
  const input = { ...prepared, episodeId: "synthetic-launch-check", video: { ...prepared.video, path: file } };

  const seenUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    seenUrls.push(String(url));
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] }, finishReason: "STOP" }] }),
      { status: 200 },
    );
  });

  let launches = 0, checkpoints = 0;
  const okPublisher = browserYouTubePublisher({
    options: { visibility: "private", audienceMode: "review" },
    deps: {
      launch: async () => {
        launches++;
        throw new Error("Sentinel after browser launch");
      },
    },
  });
  const launchedOutcome = await okPublisher.publish(input, { onCheckpoint: async () => { checkpoints++; } });
  assert.equal(launches, 1, "successful review must proceed to browser launch");
  assert.equal(seenUrls.length, 1);
  assert.match(seenUrls[0], /gemini-3\.5-flash-lite:generateContent/);
  assert.equal(launchedOutcome.status, "FAILED");
  assert.match(launchedOutcome.error ?? "", /Sentinel after browser launch/);

  let failedLaunches = 0, failedCheckpoints = 0;
  const failPublisher = browserYouTubePublisher({
    options: { visibility: "private", audienceMode: "review" },
    deps: {
      youtubeReview: item => reviewStudioVideo(item, async () => { throw new Error("Gemini provider unavailable"); }),
      launch: async () => { failedLaunches++; throw new Error("No browser should open"); },
    },
  });
  const failedOutcome = await failPublisher.publish(prepared, { onCheckpoint: async () => { failedCheckpoints++; } });
  assert.equal(failedOutcome.status, "AWAITING_HUMAN");
  assert.match(failedOutcome.error ?? "", /Gemini provider unavailable.*No new file was selected/);
  assert.equal(failedLaunches, 0);
  assert.equal(failedCheckpoints, 0);

  let timeoutLaunches = 0, timeoutCheckpoints = 0;
  const timeoutPublisher = browserYouTubePublisher({
    options: { visibility: "private", audienceMode: "review" },
    deps: {
      youtubeReview: item => reviewStudioVideo(item, () => new Promise(() => {}), 10),
      launch: async () => { timeoutLaunches++; throw new Error("No browser should open"); },
    },
  });
  const outcome = await timeoutPublisher.publish(prepared, { onCheckpoint: async () => { timeoutCheckpoints++; } });
  assert.equal(outcome.status, "AWAITING_HUMAN");
  assert.match(outcome.error ?? "", /timed out.*No new file was selected/);
  assert.equal(timeoutLaunches, 0);
  assert.equal(timeoutCheckpoints, 0);
});
