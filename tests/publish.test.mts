import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "../src/lib/db";
import { RENDER_DIR } from "../src/lib/paths";
import { VIDEO_MAX_SECONDS } from "../src/lib/content/duration";
import { serializeThumbnails, type ThumbSpec } from "../src/lib/thumbnails";
import { thumbsDir, THUMB_KEYS } from "../src/lib/thumbnails/types";
import { strings } from "../src/lib/strings";
import {
  FIELD_MAX,
  PLATFORM_IDS,
  PLATFORM_LIMITS,
  PUBLISH_STATUSES,
  SANE_DURATION,
  YOUTUBE_TAGS_LIMIT,
  hashtagLine,
  hasIndependentInstagram,
  instagramCaption,
  instagramHashtags,
  isInFlight,
  isPlatformId,
  isPublishStatus,
  isPublished,
  normaliseHashtags,
  normaliseTags,
  tagsLine,
  variantFor,
  variantProblems,
  type PublishMetadata,
} from "../src/lib/publish/limits";
import { checkReadiness, type ReadinessInput } from "../src/lib/publish/readiness";
import { manualHandoff } from "../src/lib/publish/manual";
import { hasRealPublisher, publisherFor } from "../src/lib/publish/registry";
import { PLATFORM_FIELDS, missingPlatformFields, platformStatus } from "../src/lib/publish/view";
import { isPublishRefused, type PublishRequest } from "../src/lib/publish/contract";
import { loadForRegenerate, publishView, recordHandoff, saveMetadata, wasHandEdited } from "../src/lib/publish/state";
import { generateMissingPlatformMetadata, runPlatformMetadataStep } from "../src/lib/publish/generate";
import { regenerateField, type RegenerateSource } from "../src/lib/publish/regenerate";
import * as centerModule from "../src/components/PublishCenter";
import { requireIsolation } from "./setup/isolation";

/**
 * The library is tested, not the route handlers — the same reason
 * `episodes-api.test.mts` and `poster-edit.test.mts` give: a handler's other
 * job is `currentUser()`, which reads `cookies()` and cannot run outside a
 * request. Everything a handler does beyond that lives in `lib/publish/`.
 */

const PUBLISH_DIR = fileURLToPath(new URL("../src/lib/publish/", import.meta.url));

// ---------------------------------------------------------------- client safety

/**
 * The 500 this codebase has already paid for once: a `"use client"` component
 * that transitively reaches a server module breaks every route, and a clean
 * typecheck does not catch it.
 *
 * `tests/client-ui.test.mts` guards the component side (its `CLIENT_SAFE_LIBS`
 * now lists three modules from this folder). This is the other half: those
 * three, plus `contract.ts` which `view.ts` re-exports from, must stay free of
 * anything that cannot resolve in a browser. Without this, adding
 * `import { prisma } from "@/lib/db"` to `limits.ts` would pass both the
 * typecheck AND the allow-list check, because the allow-list only looks at what
 * a COMPONENT imports, not at what those imports import.
 */
test("the publish modules a client component imports reach nothing server-only", async () => {
  const offenders: string[] = [];
  for (const name of ["limits.ts", "readiness.ts", "view.ts", "contract.ts"]) {
    const source = await fs.readFile(path.join(PUBLISH_DIR, name), "utf8");
    for (const m of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      // Only siblings in this folder, which this same test covers.
      if (/^\.\/(limits|readiness|view|contract)$/.test(spec)) continue;
      offenders.push(`${name} -> ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these modules are in the browser bundle and must import nothing but each other: ${offenders.join(", ")}`,
  );
});

test("limits.ts has no imports at all", async () => {
  const source = await fs.readFile(path.join(PUBLISH_DIR, "limits.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /^\s*(import|export\s[^;]*\sfrom)\s/m,
    "limits.ts is the leaf of the client-safe set: PublishCenter loads it in the browser",
  );
});

// ---------------------------------------------------------------- vocabulary

test("every publish status has a label and an explanation in strings.ts", () => {
  for (const status of PUBLISH_STATUSES) {
    assert.equal(typeof strings.publishCenter.statusLabel[status], "string", `${status} has no label`);
    assert.notEqual(strings.publishCenter.statusLabel[status], "", `${status}'s label is blank`);
    assert.equal(typeof strings.publishCenter.statusNote[status], "string", `${status} has no explanation`);
  }
  // And nothing in strings that is not a status: a label for a value nothing can
  // ever hold is dead copy that reads as a feature.
  assert.deepEqual(
    Object.keys(strings.publishCenter.statusLabel).sort(),
    [...PUBLISH_STATUSES].sort(),
    "the label table and the status vocabulary have drifted",
  );
});

test("the status vocabulary is exactly the seven the brief names, and the guards agree", () => {
  assert.deepEqual([...PUBLISH_STATUSES], [
    "NOT_READY",
    "READY",
    "REQUIRES_CONNECTION",
    "PREPARING",
    "UPLOADING",
    "PUBLISHED",
    "FAILED",
  ]);
  assert.ok(isPublishStatus("PUBLISHED"));
  assert.ok(!isPublishStatus("published"), "the vocabulary is case-exact");
  assert.ok(!isPublishStatus("POSTED"));
  // Only the two in-flight states are in-flight, and only one claims success.
  assert.deepEqual(PUBLISH_STATUSES.filter(isInFlight), ["PREPARING", "UPLOADING"]);
  assert.deepEqual(PUBLISH_STATUSES.filter(isPublished), ["PUBLISHED"]);
});

test("the platform ids are the two the Publish Center shows", () => {
  assert.deepEqual([...PLATFORM_IDS], ["youtube", "instagram"]);
  assert.ok(isPlatformId("youtube"));
  assert.ok(!isPlatformId("manual"), "the handoff is not a platform of its own");
  assert.ok(!isPlatformId("tiktok"));
});

test("the limits are the documented ones, and Instagram has no title field", () => {
  assert.equal(PLATFORM_LIMITS.youtube.title, 100);
  assert.equal(PLATFORM_LIMITS.youtube.body, 5000);
  assert.equal(PLATFORM_LIMITS.instagram.title, null, "Instagram's caption is its only text field");
  assert.equal(PLATFORM_LIMITS.instagram.body, 2200);
  assert.equal(PLATFORM_LIMITS.instagram.hashtags, 30);
  // The editor's own caps must be above every platform's, or an operator could
  // not type a too-long title and then cut it down while watching the counter.
  assert.ok(FIELD_MAX.title > PLATFORM_LIMITS.youtube.title!);
  assert.ok(FIELD_MAX.description > PLATFORM_LIMITS.youtube.body);
  assert.ok(FIELD_MAX.hashtags > PLATFORM_LIMITS.instagram.hashtags);
});

/**
 * The band is deliberately wider than the writer's own ceiling. An earlier
 * draft used `VIDEO_MAX_SECONDS` and the first finished episode in the
 * operator's library is 116.22 s — a good video a 90 s gate called NOT_READY.
 */
test("the sane-duration band is wider than the writer's target, on purpose", () => {
  assert.ok(
    SANE_DURATION.max > VIDEO_MAX_SECONDS,
    "readiness must not refuse a real episode that ran past the writing target",
  );
  assert.ok(SANE_DURATION.min > 0);
  assert.ok(SANE_DURATION.min < VIDEO_MAX_SECONDS);
});

// ---------------------------------------------------------------- hashtags and variants

test("hashtags are trimmed, prefixed, de-duplicated case-insensitively, and order is kept", () => {
  assert.deepEqual(normaliseHashtags(["focus", "#Deep work", " #focus ", "", "   "]), [
    "#focus",
    "#Deep work",
  ]);
  assert.deepEqual(normaliseHashtags("#a #b,#a"), ["#a", "#b"], "a line splits on spaces and commas");
  assert.deepEqual(normaliseHashtags(["##double"]), ["#double"], "a doubled hash is one hash");
  assert.deepEqual(normaliseHashtags(null), []);
  assert.deepEqual(normaliseHashtags([1, 2]), [], "a non-string entry is dropped, not stringified");
  assert.equal(hashtagLine(["focus", "#focus", "deep"]), "#focus #deep");
});

const META: PublishMetadata = {
  title: "Productivity Isn't Hustle",
  description: "What the book actually says about attention.",
  hashtags: ["#focus", "#deepwork"],
  hook: "Most people are busy. Almost nobody is focused.",
};

/**
 * The composition `PublishPanel` has always used, moved into `limits.ts`
 * without a byte changed. An operator who has been pasting this for months must
 * get the same text out of the new surface.
 */
test("the Instagram caption is the old panel's own composition, unchanged", () => {
  const expected = [META.hook, META.description, "#focus #deepwork"].filter(Boolean).join("\n\n");
  assert.equal(instagramCaption(META), expected);
  // And it degrades the same way: a missing piece is left out, never left as a
  // stray blank line.
  assert.equal(instagramCaption({ ...META, hook: "", description: "" }), "#focus #deepwork");
  assert.equal(instagramCaption({ title: "t", description: "", hashtags: [], hook: "" }), "");
});

test("a YouTube variant is title, description, keyword tags and hashtags, each measured against YouTube's limit", () => {
  const fields = variantFor("youtube", META);
  assert.deepEqual(fields.map((f) => f.key), ["title", "description", "tags", "hashtags"]);
  assert.equal(fields[0].limit, 100);
  assert.equal(fields[0].length, META.title.length);
  assert.ok(!fields[0].over);
  // The keyword-tags field is a character measure against the 500-char line.
  assert.equal(fields[2].key, "tags");
  assert.equal(fields[2].limit, YOUTUBE_TAGS_LIMIT);
  assert.equal(fields[2].value, tagsLine(META.tags));
  // Hashtags stay a count measure, now in the fourth slot.
  assert.equal(fields[3].count, 2);
  assert.equal(fields[3].countLimit, PLATFORM_LIMITS.youtube.hashtags);
});

test("YouTube keyword tags: comma-split, no '#', de-duplicated, measured whole against 500 chars", () => {
  assert.deepEqual(normaliseTags("deep work, #Focus, focus , attention"), ["deep work", "Focus", "attention"]);
  assert.deepEqual(normaliseTags(["Focus", "focus", "  ", 7 as unknown as string]), ["Focus"]);
  assert.equal(tagsLine(["deep work", "focus"]), "deep work, focus");
  assert.equal(tagsLine(undefined), "");
  const long = Array.from({ length: 40 }, (_, i) => `keyword-number-${i}`);
  const field = variantFor("youtube", { ...META, tags: long }).find((f) => f.key === "tags")!;
  assert.equal(field.limit, 500);
  assert.equal(field.over, [...tagsLine(long)].length > 500);
});

test("an Instagram variant is a caption and tags, with no title field at all", () => {
  const fields = variantFor("instagram", META);
  assert.deepEqual(fields.map((f) => f.key), ["caption", "hashtags"]);
  assert.equal(fields[0].limit, 2200);
  assert.equal(fields[0].value, instagramCaption(META));
  assert.equal(fields[1].countLimit, 30);
});

test("Instagram is composed from its OWN copy when it has any, and falls back otherwise", () => {
  // No independent copy: the caption is the historical YouTube-derived block.
  assert.equal(hasIndependentInstagram(META), false);
  assert.equal(
    instagramCaption(META),
    [META.hook, META.description, "#focus #deepwork"].join("\n\n"),
    "with nothing of its own, Instagram still reads the derived caption",
  );
  assert.deepEqual(instagramHashtags(META), META.hashtags);

  // Independent copy present: the caption is composed from THAT, not the YouTube
  // description — the operator's explicit requirement.
  const indie: PublishMetadata = {
    ...META,
    igHook: "Stop scrolling — this one is different.",
    igCaption: "A punchy Instagram-first caption.",
    igHashtags: ["#reels", "#books"],
  };
  assert.equal(hasIndependentInstagram(indie), true);
  assert.equal(
    instagramCaption(indie),
    "Stop scrolling — this one is different.\n\nA punchy Instagram-first caption.\n\n#reels #books",
  );
  assert.doesNotMatch(instagramCaption(indie), /What the book actually says/, "it does not reuse the YouTube description");
  assert.deepEqual(instagramHashtags(indie), ["#reels", "#books"], "and its own hashtags, not the shared ones");

  // A single independent field is enough to flip it: a hook alone makes it independent.
  assert.equal(hasIndependentInstagram({ ...META, igHook: "Just a hook." }), true);
});

test("an over-limit value is reported whole, never truncated", () => {
  const long = "x".repeat(140);
  const fields = variantFor("youtube", { ...META, title: long });
  assert.equal(fields[0].value, long, "the operator's words come back whole so they can choose what to cut");
  assert.equal(fields[0].length, 140);
  assert.ok(fields[0].over);
  assert.deepEqual(variantProblems("youtube", { ...META, title: long }), [
    "YouTube title: 140 characters, YouTube allows 100",
  ]);
});

test("Instagram's thirty-tag ceiling is counted, and a fitting set reports nothing", () => {
  const many = Array.from({ length: 31 }, (_, i) => `#tag${i}`);
  assert.deepEqual(variantProblems("instagram", { ...META, hashtags: many }), [
    "Hashtags: 31 tags, 30 is the most Instagram counts",
  ]);
  assert.deepEqual(variantProblems("instagram", META), []);
  assert.deepEqual(variantProblems("youtube", META), []);
});

test("a character count is code points, so one emoji is one character", () => {
  // "🙂" is a surrogate pair: `.length` says 2 and a platform counting
  // characters says 1. Measuring with `.length` would show a title as over its
  // limit while the platform happily accepted it.
  const fields = variantFor("youtube", { ...META, title: "🙂🙂" });
  assert.equal(fields[0].length, 2);
});

// ---------------------------------------------------------------- readiness

const READY: ReadinessInput = {
  status: "DONE",
  error: null,
  durationSec: 116.22,
  videoPath: "/work/renders/e1.mp4",
  videoOnDisk: true,
  videoBytes: 4_000_000,
  posterCount: 6,
  posterKey: "9x16-quote",
  posterOnDisk: true,
  title: "Productivity Isn't Hustle",
  description: "What the book actually says.",
  hashtags: ["#focus"],
};

const codes = (input: Partial<ReadinessInput>): string[] =>
  checkReadiness({ ...READY, ...input }).issues.map((i) => i.code);

test("a finished episode with everything present is READY", () => {
  const r = checkReadiness(READY);
  assert.equal(r.ready, true);
  assert.deepEqual(r.issues, []);
});

test("readiness refuses an unfinished, failed or cancelled run", () => {
  assert.deepEqual(codes({ status: "RUNNING" }), ["episode_not_done"]);
  assert.deepEqual(codes({ status: "QUEUED" }), ["episode_not_done"]);
  assert.deepEqual(codes({ status: "FAILED" }), ["episode_not_done"]);
  assert.deepEqual(codes({ status: "CANCELLED" }), ["episode_not_done"]);
  // A FAILED episode also carries an error; it must not be reported twice, or
  // the list looks longer than the number of things to fix.
  assert.deepEqual(codes({ status: "FAILED", error: "renderer died" }), ["episode_not_done"]);
});

test("readiness refuses a DONE episode that still carries a render failure", () => {
  const r = checkReadiness({ ...READY, error: "ffmpeg exited 1" });
  assert.deepEqual(r.issues.map((i) => i.code), ["render_error"]);
  assert.match(r.issues[0].message, /ffmpeg exited 1/, "the actual failure is quoted, not summarised away");
  // Whitespace is not a failure: a column holding "" or " " means none.
  assert.equal(checkReadiness({ ...READY, error: "  " }).ready, true);
});

test("readiness tells a missing render apart from one that is recorded and gone", () => {
  assert.deepEqual(codes({ videoPath: null, videoOnDisk: false, videoBytes: 0 }), ["no_video"]);
  assert.deepEqual(codes({ videoOnDisk: false, videoBytes: 0 }), ["video_missing"]);
  assert.deepEqual(codes({ videoBytes: 0 }), ["video_empty"]);
});

test("readiness checks the duration is recorded and plausible", () => {
  assert.deepEqual(codes({ durationSec: null }), ["no_duration"]);
  assert.deepEqual(codes({ durationSec: Number.NaN }), ["no_duration"]);
  assert.deepEqual(codes({ durationSec: 1 }), ["duration_implausible"]);
  assert.deepEqual(codes({ durationSec: 4000 }), ["duration_implausible"]);
  // The real episode a 90s gate would have refused.
  assert.equal(checkReadiness({ ...READY, durationSec: 116.22 }).ready, true);
});

test("readiness checks a poster exists and resolves", () => {
  assert.deepEqual(codes({ posterCount: 0, posterKey: null }), ["no_poster"]);
  assert.deepEqual(codes({ posterKey: null }), ["no_poster"]);
  assert.deepEqual(codes({ posterOnDisk: false }), ["poster_missing"]);
});

test("readiness checks the title, description and hashtags are all present", () => {
  assert.deepEqual(codes({ title: null }), ["no_title"]);
  assert.deepEqual(codes({ title: "   " }), ["no_title"], "whitespace is not a title");
  assert.deepEqual(codes({ description: "" }), ["no_description"]);
  assert.deepEqual(codes({ hashtags: [] }), ["no_hashtags"]);
  assert.deepEqual(codes({ hashtags: ["", "  "] }), ["no_hashtags"], "blank tags are not tags");
});

test("readiness reports EVERY problem, not the first one", () => {
  const r = checkReadiness({
    ...READY,
    status: "RUNNING",
    videoPath: null,
    durationSec: null,
    posterCount: 0,
    posterKey: null,
    title: null,
    description: null,
    hashtags: [],
  });
  assert.equal(r.ready, false);
  assert.deepEqual(r.issues.map((i) => i.code), [
    "episode_not_done",
    "no_video",
    "no_duration",
    "no_poster",
    "no_title",
    "no_description",
    "no_hashtags",
  ]);
  for (const issue of r.issues) {
    assert.match(issue.message, /\.$/, `"${issue.message}" is not a whole sentence`);
  }
});

test("ready is computed from the list, so it can never disagree with it", () => {
  // Every single-problem input above produced exactly one issue; here the
  // invariant itself: no input can yield ready:true with issues, or the reverse.
  const inputs: Partial<ReadinessInput>[] = [
    {},
    { status: "RUNNING" },
    { title: "" },
    { videoBytes: 0 },
    { durationSec: null },
    { posterOnDisk: false },
  ];
  for (const patch of inputs) {
    const r = checkReadiness({ ...READY, ...patch });
    assert.equal(r.ready, r.issues.length === 0);
  }
});

// ---------------------------------------------------------------- the publisher contract

const REQUEST: PublishRequest = {
  episodeId: "e1",
  metadata: META,
  durationSec: 116.22,
  video: { path: "/work/renders/e1.mp4", bytes: 4_000_000, url: "/api/episodes/e1/video", contentType: "video/mp4" },
  poster: { path: "/work/thumbs/e1/9x16-quote.jpg", bytes: 120_000, url: "/api/episodes/e1/thumbnail/9x16-quote?v=1", contentType: "image/jpeg" },
};

/**
 * Updated when the YouTube provider landed. The shape of the claim is the same
 * -- the registry always returns something, and a platform with no provider
 * gets the handoff -- but YouTube now HAS one, so the per-platform expectation
 * is read from `hasRealPublisher` rather than asserted to be false everywhere.
 *
 * `hasRealPublisher` is "does code exist", NOT "can this install use it". With
 * no `GOOGLE_CLIENT_ID` in the test environment, YouTube's `isConfigured()` is
 * false and every test below still sees REQUIRES_CONNECTION — which is the
 * property that actually matters and is asserted directly further down.
 */
test("the registry never returns nothing, and only YouTube has a real provider", () => {
  assert.equal(hasRealPublisher("youtube"), true, "the YouTube provider is registered");
  assert.equal(hasRealPublisher("instagram"), false, "Instagram still has no provider");
  for (const platform of PLATFORM_IDS) {
    const publisher = publisherFor(platform);
    assert.equal(typeof publisher.publish, "function", "a platform with no provider still gets the handoff");
    assert.equal(publisher.capabilities().id, platform);
    assert.equal(
      publisher.capabilities().canUpload,
      hasRealPublisher(platform),
      "canUpload and having a provider are the same fact",
    );
  }
});

test("the handoff is honest about every capability it does not have", () => {
  for (const platform of PLATFORM_IDS) {
    const caps = manualHandoff(platform).capabilities();
    assert.equal(caps.canUpload, false, "it hands work to a person; it cannot upload");
    assert.equal(caps.canSetThumbnail, false);
    assert.equal(caps.canSchedule, false);
    assert.equal(caps.canReportBack, false);
    assert.ok(caps.requires.length > 0, "what a real connection needs is named, not left blank");
    // `deepEqual`, not `equal`: the test suite is `.mts` while `src` is `.ts`
    // under a package with no `"type": "module"`, so tsx evaluates `limits.ts`
    // once per module graph and the two objects are never reference-equal. The
    // same hazard `isAppError` in lib/errors.ts documents.
    assert.deepEqual(caps.limits, PLATFORM_LIMITS[platform]);
  }
});

test("the handoff needs no credentials, which is NOT the platform being connected", async () => {
  // `isConfigured` true on the handoff must never be mistaken for the platform
  // being connected. `state.ts` ands it with `hasRealPublisher`, and for a
  // platform that HAS a provider it is that provider's `isConfigured()` that
  // decides -- which is false with no credentials in the environment.
  assert.equal(await manualHandoff("youtube").isConfigured(), true);
  assert.equal(hasRealPublisher("instagram"), false);
  assert.equal(platformStatus({ ready: true, issues: [] }, false, null), "REQUIRES_CONNECTION");
});

test("publish() can NEVER report success: there is no id to report it with", async () => {
  for (const platform of PLATFORM_IDS) {
    const publisher = manualHandoff(platform);
    const prepared = await publisher.prepare(REQUEST);
    const outcome = await publisher.publish(prepared);
    assert.equal(outcome.status, "REQUIRES_CONNECTION");
    assert.notEqual(outcome.status, "PUBLISHED");
    assert.ok("error" in outcome && outcome.error.length > 0, "and it says why");
    assert.doesNotMatch(
      (outcome as { error: string }).error,
      /\b(posted|published|uploaded|live)\b/i,
      "the message must not imply anything went out",
    );
  }
});

test("prepare() leaves the job in REQUIRES_CONNECTION, never READY and never PUBLISHED", async () => {
  const prepared = await manualHandoff("youtube").prepare(REQUEST);
  assert.equal(prepared.status, "REQUIRES_CONNECTION");
  assert.equal(prepared.metadata.title, META.title, "the metadata handed over is frozen on the receipt");
  assert.ok(prepared.preparedAt instanceof Date);
});

test("the YouTube handoff offers exactly the six affordances the brief names", async () => {
  const steps = (await manualHandoff("youtube").prepare(REQUEST)).handoff;
  assert.deepEqual(steps.map((s) => s.label), [
    "Download video",
    "Download selected poster",
    "Copy title",
    "Copy description",
    "Copy hashtags",
    "Open YouTube Studio",
  ]);
  assert.deepEqual(steps.map((s) => s.kind), ["download", "download", "copy", "copy", "copy", "open"]);
  // Every download and open points somewhere usable; every copy carries text.
  for (const step of steps) {
    if (step.kind === "copy") assert.ok(step.text && step.text.length > 0, `${step.label} has nothing to copy`);
    else assert.ok(step.href && (step.href.startsWith("/") || step.href.startsWith("https://")), `${step.label} has no usable link`);
  }
  assert.equal(steps.at(-1)!.external, true, "the platform opens in a new tab");
});

test("the Instagram handoff copies one caption, not a title it has no field for", async () => {
  const steps = (await manualHandoff("instagram").prepare(REQUEST)).handoff;
  assert.deepEqual(steps.map((s) => s.label), [
    "Download video",
    "Download selected poster",
    "Copy caption",
    "Copy hashtags",
    "Open Instagram",
  ]);
  assert.equal(steps.find((s) => s.label === "Copy caption")!.text, instagramCaption(META));
});

test("validate refuses an empty render, a missing poster and an over-limit field, all at once", () => {
  const publisher = manualHandoff("youtube");
  assert.deepEqual(publisher.validate(REQUEST), { ok: true, problems: [] });

  const bad = publisher.validate({
    ...REQUEST,
    video: { ...REQUEST.video, bytes: 0 },
    poster: null,
    metadata: { ...META, title: "x".repeat(101) },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3, "all three, not the first");
});

test("prepare refuses rather than preparing a handoff that cannot work", async () => {
  await assert.rejects(
    () => manualHandoff("youtube").prepare({ ...REQUEST, poster: null }),
    (err: unknown) => {
      assert.ok(isPublishRefused(err), "a refusal, identified by name rather than instanceof");
      assert.ok((err as { problems: string[] }).problems.length > 0);
      return true;
    },
  );
});

test("a recorded outcome outranks a recomputed one, but only for the four that happened", () => {
  const ready = { ready: true, issues: [] };
  const notReady = { ready: false, issues: [{ code: "no_video" as const, message: "x" }] };

  // What a platform said happened cannot be recomputed away.
  assert.equal(platformStatus(notReady, false, "PUBLISHED"), "PUBLISHED");
  assert.equal(platformStatus(notReady, false, "FAILED"), "FAILED");
  assert.equal(platformStatus(notReady, false, "PREPARING"), "PREPARING");
  assert.equal(platformStatus(notReady, false, "UPLOADING"), "UPLOADING");

  // A recorded REQUIRES_CONNECTION is NOT sticky: it describes the present, and
  // an episode whose render has since gone is NOT_READY now.
  assert.equal(platformStatus(notReady, false, "REQUIRES_CONNECTION"), "NOT_READY");
  assert.equal(platformStatus(notReady, true, "READY"), "NOT_READY");
  assert.equal(platformStatus(ready, true, "REQUIRES_CONNECTION"), "READY");
  assert.equal(platformStatus(ready, false, null), "REQUIRES_CONNECTION");
  assert.equal(platformStatus(notReady, true, null), "NOT_READY");
});

// ---------------------------------------------------------------- regenerate

const SOURCE: RegenerateSource = {
  bookTitle: "The Eagle Way",
  author: null,
  archetype: "motivation",
  bookLink: "https://example.com/buy?id=1",
  title: "Productivity Isn't Hustle",
  hook: "Most people are busy.",
  cta: "Follow for one page a day",
  script: JSON.stringify([
    { id: "hook", voiceover: "Most people are busy.", onScreen: "Busy", sourcePage: 0, startWord: 0, endWord: 3 },
    { id: "b1", voiceover: "Almost nobody is focused.", onScreen: "Focused", sourcePage: 1, startWord: 0, endWord: 3 },
  ]),
  voScript: "Most people are busy. Almost nobody is focused.",
};

/** A stand-in for `runCliJson` that records what it was asked and answers with `reply`. */
function fakeCall(reply: unknown) {
  const seen: { system: string; user: string; schema: object }[] = [];
  const call = async <T,>(_p: unknown, system: string, user: string, schema: object): Promise<T> => {
    seen.push({ system, user, schema });
    if (reply instanceof Error) throw reply;
    return reply as T;
  };
  return { call: call as never, seen };
}

test("a regenerated title comes back trimmed, and the writer is given the real script", async () => {
  const fake = fakeCall({ title: "  Busy Is Not Focused  " });
  const out = await regenerateField("title", SOURCE, { call: fake.call, provider: "claude-cli" });
  assert.deepEqual(out, { field: "title", value: "Busy Is Not Focused" });
  assert.match(fake.seen[0].user, /Almost nobody is focused\./, "the script's own words are the ground truth");
  assert.match(fake.seen[0].user, /The Eagle Way/);
});

test("the regenerate prompt is not classified as the script writer", async () => {
  // `callKind` in content/cli-metrics.ts keys off the opening words: "You write"
  // is the writer, which would give this small call the writer's 25-minute
  // ceiling, pin it to Opus at high effort, and log it as a writer call.
  const fake = fakeCall({ title: "t" });
  await regenerateField("title", SOURCE, { call: fake.call, provider: "claude-cli" });
  const { callKind } = await import("../src/lib/content/cli-metrics");
  assert.equal(callKind(fake.seen[0].system), "other");
});

test("an unverified author is never handed to the writer, and the absence is stated", async () => {
  const fake = fakeCall({ description: "d" });
  await regenerateField("description", SOURCE, { call: fake.call, provider: "claude-cli" });
  assert.match(fake.seen[0].user, /Author: not established/, "the writer is told there is none");
  assert.match(fake.seen[0].system, /Never name or imply an author/);

  const withAuthor = fakeCall({ description: "d" });
  await regenerateField("description", { ...SOURCE, author: "Cal Newport" }, { call: withAuthor.call, provider: "claude-cli" });
  assert.match(withAuthor.seen[0].user, /Author: Cal Newport/);
});

test("the purchase link is appended in code, and the writer is forbidden from writing one", async () => {
  const fake = fakeCall({ description: "What the book says." });
  const out = await regenerateField("description", SOURCE, { call: fake.call, provider: "claude-cli" });
  assert.equal(out.value, "What the book says.\n\nGet the book: https://example.com/buy?id=1");
  assert.match(fake.seen[0].system, /Never write a URL/);

  // No link on the book means no line and no placeholder.
  const noLink = fakeCall({ description: "What the book says." });
  const bare = await regenerateField("description", { ...SOURCE, bookLink: null }, { call: noLink.call, provider: "claude-cli" });
  assert.equal(bare.value, "What the book says.");
});

test("regenerated hashtags are normalised and capped", async () => {
  const fake = fakeCall({ hashtags: ["focus", "#Focus", "deepwork", "attention"] });
  const out = await regenerateField("hashtags", SOURCE, { call: fake.call, provider: "claude-cli" });
  assert.deepEqual(out.value, ["#focus", "#deepwork", "#attention"], "de-duplicated and prefixed");
});

test("YouTube tags regenerate as keywords — no '#', comma-world, de-duplicated", async () => {
  const fake = fakeCall({ tags: ["Deep Work", "deep work", "focus", "attention span", "productivity", "habits"] });
  const out = await regenerateField("tags", SOURCE, { call: fake.call, provider: "claude-cli" });
  assert.deepEqual(out.value, ["Deep Work", "focus", "attention span", "productivity", "habits"], "case-insensitive de-dup, no '#'");
  assert.match(fake.seen[0].user, /keyword tags/i, "the writer is asked for keyword tags, not hashtags");
});

test("Instagram fields regenerate from the script and are told NOT to reuse the YouTube description", async () => {
  const hook = fakeCall({ igHook: "  Stop scrolling.  " });
  const outHook = await regenerateField("igHook", SOURCE, { call: hook.call, provider: "claude-cli" });
  assert.equal(outHook.value, "Stop scrolling.", "trimmed, and no purchase link appended");
  assert.equal(await (async () => (await import("../src/lib/content/cli-metrics")).callKind(hook.seen[0].system))(), "other");

  const cap = fakeCall({ igCaption: "A punchy, Instagram-first caption." });
  const outCap = await regenerateField("igCaption", SOURCE, { call: cap.call, provider: "claude-cli" });
  assert.equal(outCap.value, "A punchy, Instagram-first caption.", "an Instagram caption gets no appended book link");
  assert.match(cap.seen[0].user, /NOT the YouTube description/, "the brief forbids reusing the YouTube description");

  const tags = fakeCall({ igHashtags: ["focus", "deepwork", "reels", "books", "mindset", "#Focus"] });
  const outTags = await regenerateField("igHashtags", SOURCE, { call: tags.call, provider: "claude-cli" });
  assert.deepEqual(outTags.value, ["#focus", "#deepwork", "#reels", "#books", "#mindset"], "normalised and de-duped like hashtags");
});

test("an episode with no script cannot be regenerated from, and says so", async () => {
  const fake = fakeCall({ title: "t" });
  await assert.rejects(
    () => regenerateField("title", { ...SOURCE, script: null, voScript: null }, { call: fake.call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, "no_script");
      assert.equal((err as { status: number }).status, 409);
      return true;
    },
  );
  assert.equal(fake.seen.length, 0, "and no model call is spent finding out");
});

test("a malformed script falls back to the flattened voiceover rather than refusing", async () => {
  const fake = fakeCall({ title: "t" });
  await regenerateField("title", { ...SOURCE, script: "{not json" }, { call: fake.call, provider: "claude-cli" });
  assert.match(fake.seen[0].user, /Most people are busy\./);
});

test("an empty, missing or over-long reply changes nothing and reports why", async () => {
  for (const reply of [{}, { title: "" }, { title: "   " }, { title: 7 }]) {
    await assert.rejects(
      () => regenerateField("title", SOURCE, { call: fakeCall(reply).call, provider: "claude-cli" }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, "regenerate_failed");
        return true;
      },
      `reply ${JSON.stringify(reply)} must be refused`,
    );
  }
  // Over the limit is refused, NOT truncated: a title cut mid-word is not one
  // the operator asked for.
  await assert.rejects(
    () => regenerateField("title", SOURCE, { call: fakeCall({ title: "x".repeat(101) }).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.match((err as Error).message, /over the 100 asked for/);
      assert.match((err as Error).message, /Nothing was changed/);
      return true;
    },
  );
  // Too few hashtags is the same: the stored list is left alone.
  await assert.rejects(
    () => regenerateField("hashtags", SOURCE, { call: fakeCall({ hashtags: ["#a"] }).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.match((err as Error).message, /too few hashtags/);
      return true;
    },
  );
});

test("a writer that cannot be reached is a 502 naming the problem, not a blank 500", async () => {
  await assert.rejects(
    () => regenerateField("title", SOURCE, { call: fakeCall(new Error("claude: not signed in")).call, provider: "claude-cli" }),
    (err: unknown) => {
      assert.equal((err as { status: number }).status, 502);
      assert.match((err as Error).message, /not signed in/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- the database-backed surface

const BEATS = [
  { id: "hook", voiceover: "Most people are busy.", onScreen: "Busy", sourcePage: 0, startWord: 0, endWord: 3 },
  { id: "b1", voiceover: "Almost nobody is focused.", onScreen: "Focused", sourcePage: 1, startWord: 0, endWord: 3 },
];

interface Seed {
  userId: string;
  otherUserId: string;
  episodeId: string;
  renderFile: string;
  cleanup: () => Promise<void>;
}

/**
 * A finished episode, with a render and six posters actually on disk, so the
 * readiness check is measuring files rather than being told about them.
 *
 * `row` overrides the episode's own columns; `onDisk: false` is the episode
 * whose work directory was cleaned up.
 */
async function seed(opts: { row?: Record<string, unknown>; onDisk?: boolean } = {}): Promise<Seed> {
  // Fails closed before the first row. A bare `tsx --test` of this file would
  // create User, Book, Upload and Episode rows in the operator's real `dev.db`
  // and write renders into their real `.bookreel/` — and nothing about the run
  // would look wrong. Two real incidents in this project came from exactly that.
  requireIsolation("these tests create episodes and write renders and posters");
  const { row = {}, onDisk = true } = opts;

  const user = await prisma.user.create({ data: { email: `pub-${randomUUID()}@example.test` } });
  const other = await prisma.user.create({ data: { email: `pub-other-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({
    data: { title: `Publish ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  const dir = thumbsDir("pending");
  const episode = await prisma.episode.create({
    data: {
      bookId: book.id,
      uploadId: upload.id,
      userId: user.id,
      status: "DONE",
      theme: "marginalia",
      title: "Productivity Isn't Hustle",
      hook: "Most people are busy.",
      cta: "Follow for one page a day",
      description: "What the book says about attention.",
      hashtags: JSON.stringify(["#focus", "#deepwork"]),
      script: JSON.stringify(BEATS),
      voScript: "Most people are busy. Almost nobody is focused.",
      durationSec: 116.22,
      ...row,
    },
  });

  const thumbDir = thumbsDir(episode.id);
  const specs: ThumbSpec[] = THUMB_KEYS.map((key) => ({
    key,
    aspect: key.startsWith("9x16") ? ("9:16" as const) : ("16:9" as const),
    variant: key.split("-")[1] as ThumbSpec["variant"],
    path: path.join(thumbDir, `${key}.jpg`),
    width: key.startsWith("9x16") ? 1080 : 1920,
    height: key.startsWith("9x16") ? 1920 : 1080,
    rev: 7,
  }));

  const renderFile = path.join(RENDER_DIR, `${episode.id}.mp4`);
  if (onDisk) {
    await fs.mkdir(thumbDir, { recursive: true });
    for (const s of specs) await fs.writeFile(s.path, "poster bytes");
    await fs.mkdir(RENDER_DIR, { recursive: true });
    await fs.writeFile(renderFile, "video bytes");
  }
  await prisma.episode.update({
    where: { id: episode.id },
    data: {
      thumbnails: serializeThumbnails(specs),
      // Only set when a render was recorded; `row` may override it to null.
      ...(row.videoPath === undefined ? { videoPath: renderFile } : {}),
    },
  });
  void dir;

  return {
    userId: user.id,
    otherUserId: other.id,
    episodeId: episode.id,
    renderFile,
    cleanup: async () => {
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
      await fs.rm(thumbDir, { recursive: true, force: true });
      await fs.rm(renderFile, { force: true });
    },
  };
}

test("a finished episode reads as READY, with both platforms requiring a connection", async () => {
  const s = await seed();
  try {
    const view = await publishView(s.userId, s.episodeId);
    assert.equal(view.readiness.ready, true, JSON.stringify(view.readiness.issues));
    assert.equal(view.videoUrl, `/api/episodes/${s.episodeId}/video`);
    assert.ok(view.videoBytes && view.videoBytes > 0, "the render was measured on disk, not assumed");
    assert.equal(view.poster?.key, "9x16-quote", "the default poster is the first 9:16");
    assert.match(view.poster!.url, /\/thumbnail\/9x16-quote\?v=7$/, "versioned, so a redone poster is a new URL");

    assert.deepEqual(view.platforms.map((p) => p.platform), ["youtube", "instagram"]);
    for (const p of view.platforms) {
      // THE PROPERTY THAT MATTERS, and the one requirement 7 of the YouTube
      // workstream names: with no Google credentials in the environment, a
      // platform that HAS a provider still reads as REQUIRES_CONNECTION and
      // still offers the full assisted handoff. `hasPublisher` is now true for
      // YouTube (the code exists) and `configured` is still false (this install
      // cannot use it), which is exactly the pair the vocabulary is for.
      assert.equal(p.status, "REQUIRES_CONNECTION", `${p.platform} must not claim to be connected`);
      assert.equal(p.configured, false, `${p.platform}: no credentials, so not configured`);
      assert.equal(p.hasPublisher, p.platform === "youtube");
      assert.equal(p.capabilities.canUpload, p.platform === "youtube");
      assert.deepEqual(p.problems, []);
      assert.ok(p.handoff.length >= 5, "the handoff is offered, because this episode would pass");
      assert.equal(p.job, null, "nothing has been handed over yet");
    }
    // No absolute filesystem path crosses the wire.
    const wire = JSON.stringify(view);
    assert.ok(!wire.includes(RENDER_DIR.replace(/\\/g, "\\\\")), "the render's path must not be published");
    assert.doesNotMatch(wire, /"path":/, "no asset path is serialised");
  } finally {
    await s.cleanup();
  }
});

test("an episode whose render and posters are gone is NOT ready, and offers no handoff", async () => {
  const s = await seed({ onDisk: false });
  try {
    const view = await publishView(s.userId, s.episodeId);
    assert.equal(view.readiness.ready, false);
    assert.deepEqual(view.readiness.issues.map((i) => i.code).sort(), ["poster_missing", "video_missing"]);
    assert.equal(view.videoUrl, null, "a Download that would 404 is not offered");
    assert.equal(view.poster, null);
    for (const p of view.platforms) {
      assert.equal(p.status, "NOT_READY");
      assert.deepEqual(p.handoff, [], "no control is shown for work that cannot be done");
    }
  } finally {
    await s.cleanup();
  }
});

test("an unfinished episode is NOT_READY on every platform", async () => {
  const s = await seed({ row: { status: "RUNNING", durationSec: null, videoPath: null } });
  try {
    const view = await publishView(s.userId, s.episodeId);
    assert.equal(view.readiness.ready, false);
    assert.ok(view.readiness.issues.some((i) => i.code === "episode_not_done"));
    for (const p of view.platforms) assert.equal(p.status, "NOT_READY");
  } finally {
    await s.cleanup();
  }
});

test("another operator's episode is not found, not merely empty", async () => {
  const s = await seed();
  try {
    await assert.rejects(
      () => publishView(s.otherUserId, s.episodeId),
      (err: unknown) => {
        assert.equal((err as { status: number }).status, 404);
        return true;
      },
    );
    await assert.rejects(() => saveMetadata(s.otherUserId, s.episodeId, { title: "mine now" }));
    await assert.rejects(() => recordHandoff(s.otherUserId, s.episodeId, "youtube"));
  } finally {
    await s.cleanup();
  }
});

test("an ownerless episode is visible, the same rule the library lists by", async () => {
  const s = await seed({ row: { userId: null } });
  try {
    const view = await publishView(s.otherUserId, s.episodeId);
    assert.equal(view.episodeId, s.episodeId);
  } finally {
    await s.cleanup();
  }
});

test("an edit is stored and marked as the operator's words", async () => {
  const s = await seed();
  try {
    const before = await publishView(s.userId, s.episodeId);
    assert.deepEqual(before.edits, { title: null, description: null, hashtags: null, tags: null, igHook: null, igCaption: null, igHashtags: null }, "nothing is hand-edited yet");

    const after = await saveMetadata(s.userId, s.episodeId, { title: "  Busy Is Not Focused  " });
    assert.equal(after.metadata.title, "Busy Is Not Focused", "trimmed");
    assert.ok(after.edits.title, "and marked");
    assert.equal(after.edits.description, null, "a title edit marks only the title");

    const row = await prisma.episode.findUniqueOrThrow({ where: { id: s.episodeId } });
    assert.equal(wasHandEdited(row, "title"), true);
    assert.equal(wasHandEdited(row, "description"), false);
  } finally {
    await s.cleanup();
  }
});

test("re-saving identical text is not an edit and does not start demanding confirmations", async () => {
  const s = await seed();
  try {
    const view = await publishView(s.userId, s.episodeId);
    const same = await saveMetadata(s.userId, s.episodeId, {
      title: view.metadata.title,
      description: view.metadata.description,
      hashtags: view.metadata.hashtags,
    });
    assert.deepEqual(same.edits, { title: null, description: null, hashtags: null, tags: null, igHook: null, igCaption: null, igHashtags: null });
  } finally {
    await s.cleanup();
  }
});

test("hashtags are accepted as a list or as one line, and stored normalised", async () => {
  const s = await seed();
  try {
    const line = await saveMetadata(s.userId, s.episodeId, { hashtags: "focus  #Focus, deepwork" });
    assert.deepEqual(line.metadata.hashtags, ["#focus", "#deepwork"]);
    const list = await saveMetadata(s.userId, s.episodeId, { hashtags: ["#a", "#b"] });
    assert.deepEqual(list.metadata.hashtags, ["#a", "#b"]);
    const stored = await prisma.episode.findUniqueOrThrow({ where: { id: s.episodeId } });
    assert.equal(stored.hashtags, '["#a","#b"]', "the column stays a JSON string[], as every other reader expects");
  } finally {
    await s.cleanup();
  }
});

test("the editor refuses an unknown field, a wrong type and an absurd length", async () => {
  const s = await seed();
  try {
    for (const body of [
      null,
      "title",
      ["title"],
      { theme: "neon" },
      { title: 7 },
      { description: { a: 1 } },
      { hashtags: 7 },
      { title: "x".repeat(FIELD_MAX.title + 1) },
      { description: "x".repeat(FIELD_MAX.description + 1) },
      { hashtags: Array.from({ length: FIELD_MAX.hashtags + 1 }, (_, i) => `#t${i}`) },
    ]) {
      await assert.rejects(
        () => saveMetadata(s.userId, s.episodeId, body),
        (err: unknown) => {
          assert.equal((err as { status: number }).status, 400, `${JSON.stringify(body)} must be a 400`);
          return true;
        },
        `${JSON.stringify(body)} must be refused`,
      );
    }
    // And nothing was written by any of them.
    const view = await publishView(s.userId, s.episodeId);
    assert.equal(view.metadata.title, "Productivity Isn't Hustle");
    assert.deepEqual(view.edits, { title: null, description: null, hashtags: null, tags: null, igHook: null, igCaption: null, igHashtags: null });
  } finally {
    await s.cleanup();
  }
});

test("an over-limit edit is stored and reported, never silently cut", async () => {
  const s = await seed();
  try {
    const long = "x".repeat(140);
    const view = await saveMetadata(s.userId, s.episodeId, { title: long });
    assert.equal(view.metadata.title, long, "the operator's words are kept whole");
    const youtube = view.platforms.find((p) => p.platform === "youtube")!;
    assert.deepEqual(youtube.problems, ["YouTube title: 140 characters, YouTube allows 100"]);
    assert.deepEqual(youtube.handoff, [], "a handoff the platform would refuse is not offered");
    // Instagram has no title field, so its own caption is unaffected.
    const instagram = view.platforms.find((p) => p.platform === "instagram")!;
    assert.deepEqual(instagram.problems, []);
    assert.ok(instagram.handoff.length > 0);
    // The episode is still READY: the overrun is a platform's refusal, not a
    // defect in the episode.
    assert.equal(view.readiness.ready, true);
  } finally {
    await s.cleanup();
  }
});

test("a handoff is recorded as REQUIRES_CONNECTION, with no id and no published time", async () => {
  const s = await seed();
  try {
    const view = await recordHandoff(s.userId, s.episodeId, "youtube");
    const youtube = view.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(youtube.status, "REQUIRES_CONNECTION");
    assert.equal(youtube.job!.attempts, 1);
    assert.equal(youtube.job!.externalId, null, "no platform gave us an id");
    assert.equal(youtube.job!.externalUrl, null);
    assert.equal(youtube.job!.publishedAt, null, "nothing was confirmed, so nothing claims to be");
    assert.ok(youtube.job!.preparedAt, "but WHEN it was handed over is recorded");
    assert.equal(youtube.job!.metadata!.title, "Productivity Isn't Hustle", "with the exact words handed over");
    assert.ok(youtube.job!.lastError, "and the reason it is not published");

    // The other platform is untouched: this is per-episode, per-platform state.
    assert.equal(view.platforms.find((p) => p.platform === "instagram")!.job, null);

    const rows = await prisma.publishJob.findMany({ where: { episodeId: s.episodeId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "REQUIRES_CONNECTION");
    assert.equal(rows[0].publishedAt, null);
  } finally {
    await s.cleanup();
  }
});

test("a second handoff is a second attempt on the same row, not a second row", async () => {
  const s = await seed();
  try {
    await recordHandoff(s.userId, s.episodeId, "youtube");
    await recordHandoff(s.userId, s.episodeId, "youtube");
    await recordHandoff(s.userId, s.episodeId, "instagram");
    const rows = await prisma.publishJob.findMany({ where: { episodeId: s.episodeId }, orderBy: { platform: "asc" } });
    assert.deepEqual(rows.map((r) => [r.platform, r.attempts]), [["instagram", 1], ["youtube", 2]]);
  } finally {
    await s.cleanup();
  }
});

test("the recorded snapshot is the metadata of that moment, not whatever is current", async () => {
  const s = await seed();
  try {
    await recordHandoff(s.userId, s.episodeId, "youtube");
    const after = await saveMetadata(s.userId, s.episodeId, { title: "A Completely Different Title" });
    const youtube = after.platforms.find((p) => p.platform === "youtube")!;
    assert.equal(after.metadata.title, "A Completely Different Title", "the episode moved on");
    assert.equal(youtube.job!.metadata!.title, "Productivity Isn't Hustle", "the snapshot did not");
  } finally {
    await s.cleanup();
  }
});

test("a handoff of an episode that is not ready is refused, and records nothing", async () => {
  const s = await seed({ onDisk: false });
  try {
    await assert.rejects(
      () => recordHandoff(s.userId, s.episodeId, "youtube"),
      (err: unknown) => {
        assert.equal((err as { status: number }).status, 409);
        assert.equal((err as { code: string }).code, "not_ready");
        return true;
      },
    );
    assert.equal(await prisma.publishJob.count({ where: { episodeId: s.episodeId } }), 0);
  } finally {
    await s.cleanup();
  }
});

test("YouTube tags save, survive a reload, and carry a hand-edited mark", async () => {
  const s = await seed();
  try {
    const before = await publishView(s.userId, s.episodeId);
    assert.deepEqual(before.metadata.tags, [], "no tags until the operator sets them");
    assert.equal(before.edits.tags, null);

    const saved = await saveMetadata(s.userId, s.episodeId, { tags: "deep work, #Focus, focus, attention" });
    assert.deepEqual(saved.metadata.tags, ["deep work", "Focus", "attention"], "comma-split, #-stripped, de-duped");
    assert.ok(saved.edits.tags, "and marked as the operator's words");

    // A fresh read is exactly what a page reload does — the value survives
    // because it is in the database, not in client state.
    const reread = await publishView(s.userId, s.episodeId);
    assert.deepEqual(reread.metadata.tags, ["deep work", "Focus", "attention"]);
    assert.ok(reread.edits.tags);
    const row = await prisma.episode.findUniqueOrThrow({ where: { id: s.episodeId } });
    assert.equal(row.youtubeTags, '["deep work","Focus","attention"]', "stored as JSON string[]");
  } finally {
    await s.cleanup();
  }
});

test("Instagram's own copy saves independently, and makes the caption independent of YouTube", async () => {
  const s = await seed();
  try {
    const before = await publishView(s.userId, s.episodeId);
    const derived = before.platforms
      .find((p) => p.platform === "instagram")!
      .variant.find((f) => f.key === "caption")!.value;
    assert.match(derived, /What the book says about attention/, "the caption starts out derived from YouTube");

    const saved = await saveMetadata(s.userId, s.episodeId, {
      igHook: "Stop scrolling.",
      igCaption: "Written for Instagram.",
      igHashtags: ["#reels", "#books"],
    });
    assert.equal(saved.metadata.igHook, "Stop scrolling.");
    assert.equal(saved.metadata.igCaption, "Written for Instagram.");
    assert.deepEqual(saved.metadata.igHashtags, ["#reels", "#books"]);
    assert.ok(saved.edits.igHook && saved.edits.igCaption && saved.edits.igHashtags, "each independent field is marked");
    assert.equal(saved.edits.title, null, "editing Instagram does not mark YouTube's title");
    assert.equal(saved.edits.description, null);

    const caption = saved.platforms
      .find((p) => p.platform === "instagram")!
      .variant.find((f) => f.key === "caption")!.value;
    assert.equal(caption, "Stop scrolling.\n\nWritten for Instagram.\n\n#reels #books");
    assert.doesNotMatch(caption, /What the book says about attention/, "no longer the YouTube description");

    // And it survives a reload.
    const reread = await publishView(s.userId, s.episodeId);
    assert.equal(reread.metadata.igCaption, "Written for Instagram.");
  } finally {
    await s.cleanup();
  }
});

test("a per-platform cover choice is stored, validated, and kept apart from the other platform", async () => {
  const s = await seed();
  try {
    const before = await publishView(s.userId, s.episodeId);
    assert.equal(before.thumbnails.length, 6, "all six posters are offered to the picker");
    assert.deepEqual(before.thumbChoices, { youtube: null, instagram: null, default: null });

    const saved = await saveMetadata(s.userId, s.episodeId, { thumbChoiceYouTube: "16x9-quote" });
    assert.equal(saved.thumbChoices.youtube, "16x9-quote");
    assert.equal(saved.thumbChoices.instagram, null, "Instagram's cover is untouched");

    const both = await saveMetadata(s.userId, s.episodeId, { thumbChoiceInstagram: "9x16-bold" });
    assert.equal(both.thumbChoices.youtube, "16x9-quote", "the YouTube choice persists");
    assert.equal(both.thumbChoices.instagram, "9x16-bold");

    await assert.rejects(
      () => saveMetadata(s.userId, s.episodeId, { thumbChoiceYouTube: "not-a-real-key" }),
      (err: unknown) => {
        assert.equal((err as { status: number }).status, 400, "a key the episode does not have is refused");
        return true;
      },
    );

    const cleared = await saveMetadata(s.userId, s.episodeId, { thumbChoiceYouTube: null });
    assert.equal(cleared.thumbChoices.youtube, null, "clearing falls back to the episode-wide choice");

    // The reload reads it back from the database.
    const reread = await publishView(s.userId, s.episodeId);
    assert.equal(reread.thumbChoices.instagram, "9x16-bold");
  } finally {
    await s.cleanup();
  }
});

test("the per-platform cover is consumed: it is the card's cover AND the handoff's download", async () => {
  const s = await seed();
  try {
    // With no override, each platform resolves to the aspect it favours.
    const before = await publishView(s.userId, s.episodeId);
    const ytBefore = before.platforms.find((p) => p.platform === "youtube")!;
    const igBefore = before.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(ytBefore.cover?.aspect, "16:9", "YouTube defaults to a 16:9 cover");
    assert.equal(igBefore.cover?.aspect, "9:16", "Instagram defaults to a 9:16 cover");

    // Choose explicit, different covers per platform.
    await saveMetadata(s.userId, s.episodeId, { thumbChoiceYouTube: "16x9-bold", thumbChoiceInstagram: "9x16-split" });
    const v = await publishView(s.userId, s.episodeId);
    const yt = v.platforms.find((p) => p.platform === "youtube")!;
    const ig = v.platforms.find((p) => p.platform === "instagram")!;

    // The card surfaces the chosen per-platform cover…
    assert.equal(yt.cover?.key, "16x9-bold");
    assert.equal(ig.cover?.key, "9x16-split");

    // …and the "Download selected poster" handoff downloads that SAME cover —
    // the pointer is no longer cosmetic.
    const ytDl = yt.handoff.find((h) => h.label === "Download selected poster")!;
    const igDl = ig.handoff.find((h) => h.label === "Download selected poster")!;
    assert.match(ytDl.href ?? "", /\/thumbnail\/16x9-bold\?/, "YouTube hands off the YouTube cover");
    assert.match(igDl.href ?? "", /\/thumbnail\/9x16-split\?/, "Instagram hands off the Instagram cover");
  } finally {
    await s.cleanup();
  }
});

test("two episodes keep separate metadata — no cross-episode bleed", async () => {
  const a = await seed({ row: { title: "Episode A" } });
  const b = await seed({ row: { title: "Episode B" } });
  try {
    await saveMetadata(a.userId, a.episodeId, { tags: "a-tag", igHook: "A hook" });
    await saveMetadata(b.userId, b.episodeId, { tags: "b-tag", igHook: "B hook" });
    const va = await publishView(a.userId, a.episodeId);
    const vb = await publishView(b.userId, b.episodeId);
    assert.deepEqual(va.metadata.tags, ["a-tag"]);
    assert.deepEqual(vb.metadata.tags, ["b-tag"]);
    assert.equal(va.metadata.igHook, "A hook");
    assert.equal(vb.metadata.igHook, "B hook");
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("adding publish state changed nothing about an existing episode row", async () => {
  const s = await seed();
  try {
    // The three new columns default to NULL on every row, which is exactly what
    // "never hand-edited" means — so all 160 existing episodes read correctly
    // with no backfill, and no existing query sees a difference.
    const row = await prisma.episode.findUniqueOrThrow({ where: { id: s.episodeId } });
    assert.equal(row.titleEditedAt, null);
    assert.equal(row.descriptionEditedAt, null);
    assert.equal(row.hashtagsEditedAt, null);
    assert.equal(await prisma.publishJob.count({ where: { episodeId: s.episodeId } }), 0);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- the surface itself

const Center = ((centerModule as { default: unknown }).default as { default?: unknown }).default ??
  (centerModule as { default: unknown }).default;

/** The Publish Center as the server first renders it: no effect has run, so no fetch has landed. */
function render(episode: Record<string, unknown> | null): string {
  return renderToStaticMarkup(
    React.createElement(Center as React.ComponentType<{ episode: unknown }>, { episode }),
  );
}

const FINISHED = {
  id: "e1",
  bookTitle: "The Eagle Way",
  title: "Productivity Isn't Hustle",
  status: "DONE",
  step: "DONE",
  error: null,
  notes: [],
  partNumber: 1,
  seriesTotal: 1,
  hasVideo: true,
  startedAt: null,
  finishedAt: null,
  totalMs: null,
  hook: "Most people are busy.",
  description: "What the book says about attention.",
  hashtags: ["#focus", "#deepwork"],
};

test("with no episode the Publish Center says so, and claims nothing", () => {
  const html = render(null);
  assert.match(html, new RegExp(strings.publishCenter.none));
  assert.doesNotMatch(html, /READY TO PUBLISH/);
});

/**
 * THE NO-REGRESSION TEST. `PublishPanel` was a `<details>` with four copy
 * blocks, fed from the polled episode snapshot alone. The Publish Center reads
 * its own endpoint — which has NOT answered in a server render — and the four
 * blocks must still be there, with the same labels, from the same snapshot.
 * Without the fallback in `copyMetadata` this renders empty, and an operator
 * who has been pasting from these for months loses them to a slow fetch.
 */
test("the four copy blocks still work from the polled snapshot alone", () => {
  const html = render(FINISHED);
  for (const label of [
    strings.publish.youtubeTitle,
    strings.publish.hashtags,
    strings.publish.youtubeDescription,
    strings.publish.instagram,
  ]) {
    assert.ok(html.includes(label), `the "${label}" copy block is gone`);
  }
  assert.ok(html.includes("Productivity Isn&#x27;t Hustle"), "the title is in a copy block, escaped");
  assert.ok(html.includes("#focus #deepwork"), "the hashtag line is there");
  // The Instagram caption is still hook + description + hashtags.
  assert.ok(
    html.includes("Most people are busy.\n\nWhat the book says about attention.\n\n#focus #deepwork"),
    "the Instagram caption composition changed",
  );
  // Still under the same summary the operator knows.
  assert.ok(html.includes(strings.publish.heading));
});

test("a run that has not written its copy yet says so rather than showing empty boxes", () => {
  const html = render({ ...FINISHED, status: "RUNNING", title: null, description: null, hashtags: [] });
  assert.ok(html.includes(strings.publish.waiting));
  assert.ok(!html.includes(strings.publish.youtubeTitle), "an empty copy box is indistinguishable from a broken one");
});

test("nothing on the surface claims a post happened before the state has even loaded", () => {
  const html = render(FINISHED);
  // The words that would be a lie. "Published" only ever appears inside a block
  // gated on a platform-supplied `externalId`, which cannot exist here.
  for (const lie of [/Published/, /Uploading/, /Posted/i, /\bLive\b/]) {
    assert.doesNotMatch(html, lie, `the first render must not say ${lie}`);
  }
  assert.doesNotMatch(html, /<progress/, "no progress bar for work that is not happening");
});

// ---------------------------------------------------------------- tags and Instagram copy, written for you

/**
 * The four fields nothing used to write: YouTube tags and the three Instagram
 * fields. Written in one call by the render, and by the Publish panel for an
 * episode that predates that; only ever into a field that is empty AND not the
 * operator's. Every model call is a stub -- the real writer is exercised by the
 * browser verification.
 */

const GENERATED = {
  tags: ["deep work", "focus", "attention", "productivity", "time blocking"],
  igHook: "Busy is not the same as focused. 🎯",
  igCaption: "Most of us are busy all day and focused for none of it. 🧠\n\nBlock the time. Protect it.",
  igHashtags: ["#deepwork", "#focus", "#productivity", "#booktok", "#attention"],
};

function stubGenerate(reply: typeof GENERATED | Error = GENERATED) {
  const calls: RegenerateSource[] = [];
  const generate = async (source: RegenerateSource) => {
    calls.push(source);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { generate: generate as never, calls };
}

const rowOf = (id: string) => prisma.episode.findUniqueOrThrow({ where: { id } });

test("missingPlatformFields: an empty field is missing, unless it is the operator's -- even when they emptied it", () => {
  const meta: PublishMetadata = { title: "t", description: "d", hashtags: ["#a"], hook: "h" };
  const none = { title: null, description: null, hashtags: null, tags: null, igHook: null, igCaption: null, igHashtags: null };

  assert.deepEqual(missingPlatformFields(meta, none), ["tags", "igHook", "igCaption", "igHashtags"]);
  assert.deepEqual(
    missingPlatformFields({ ...meta, tags: ["focus"], igHook: "hook", igCaption: "cap", igHashtags: ["#a"] }, none),
    [],
    "everything present, nothing missing",
  );
  assert.deepEqual(missingPlatformFields({ ...meta, igHook: "   ", tags: [" "], igHashtags: ["#"] }, none), [
    "tags",
    "igHook",
    "igCaption",
    "igHashtags",
  ], "whitespace is empty");

  // The operator emptied the hook on purpose: that is an edit, and it is theirs.
  assert.deepEqual(missingPlatformFields(meta, { ...none, igHook: "2026-10-13T00:00:00.000Z" }), ["tags", "igCaption", "igHashtags"]);
  assert.deepEqual(PLATFORM_FIELDS, ["tags", "igHook", "igCaption", "igHashtags"]);
});

test("a generated answer fills all four empty fields, leaves them machine-written, and each platform keeps its own", async () => {
  const s = await seed();
  try {
    const before = await publishView(s.userId, s.episodeId);
    assert.deepEqual(missingPlatformFields(before.metadata, before.edits), ["tags", "igHook", "igCaption", "igHashtags"]);

    const stub = stubGenerate();
    const out = await generateMissingPlatformMetadata(s.episodeId, { generate: stub.generate });
    assert.deepEqual(out.missing, ["tags", "igHook", "igCaption", "igHashtags"]);
    assert.deepEqual(out.filled, ["tags", "igHook", "igCaption", "igHashtags"]);
    assert.equal(stub.calls.length, 1, "ONE model call for all four");

    // The model is shown the stored script and the book -- and never the YouTube description.
    const src = stub.calls[0];
    assert.match(src.script ?? "", /Almost nobody is focused/);
    assert.equal(src.author, null, "an unverified author is absent, not a placeholder");
    assert.equal(src.bookLink, null);
    assert.equal(src.description, "What the book says about attention.", "carried only so a copied caption can be refused");

    const view = await publishView(s.userId, s.episodeId);
    assert.deepEqual(view.metadata.tags, GENERATED.tags);
    assert.equal(view.metadata.igHook, GENERATED.igHook);
    assert.equal(view.metadata.igCaption, GENERATED.igCaption);
    assert.deepEqual(view.metadata.igHashtags, ["#deepwork", "#focus", "#productivity", "#booktok", "#attention"]);
    assert.deepEqual(missingPlatformFields(view.metadata, view.edits), [], "nothing left to ask for");

    // Machine-written, so the next Regenerate will not demand a confirmation.
    assert.deepEqual(view.edits, { title: null, description: null, hashtags: null, tags: null, igHook: null, igCaption: null, igHashtags: null });
    const row = await rowOf(s.episodeId);
    assert.equal(row.youtubeTagsEditedAt, null);
    assert.equal(row.igHookEditedAt, null);

    // YouTube's own fields are untouched, and the two platforms stay separate.
    assert.equal(view.metadata.title, "Productivity Isn't Hustle");
    assert.equal(view.metadata.description, "What the book says about attention.");
    assert.deepEqual(view.metadata.hashtags, ["#focus", "#deepwork"]);
    const yt = view.platforms.find((p) => p.platform === "youtube")!;
    const ig = view.platforms.find((p) => p.platform === "instagram")!;
    assert.equal(yt.variant.find((f) => f.key === "tags")?.value, "deep work, focus, attention, productivity, time blocking");
    assert.equal(yt.variant.find((f) => f.key === "description")?.value, "What the book says about attention.");
    assert.ok(!yt.variant.some((f) => f.value.includes("Busy is not the same")), "no Instagram copy on the YouTube card");
    const caption = ig.variant.find((f) => f.key === "caption")!;
    assert.equal(caption.value, `${GENERATED.igHook}\n\n${GENERATED.igCaption}\n\n#deepwork #focus #productivity #booktok #attention`);
    assert.ok(!caption.value.includes("What the book says about attention."), "the Instagram caption is NOT the YouTube description");
    assert.ok(!caption.value.includes("#focus #deepwork"), "and carries Instagram's hashtags, not YouTube's");
  } finally {
    await s.cleanup();
  }
});

test("generation fills ONLY empty fields: a value, a hand edit, and a deliberately emptied field are all left alone", async () => {
  const mark = new Date("2026-10-01T00:00:00Z");
  const s = await seed({
    row: {
      youtubeTags: JSON.stringify(["already", "there"]), // has a value (machine-written)
      igHook: "My own hook", // hand-edited
      igHookEditedAt: mark,
      igCaption: "", // emptied on purpose: an edit, with a mark
      igCaptionEditedAt: mark,
      // igHashtags: genuinely empty -> the only one to fill
    },
  });
  try {
    const stub = stubGenerate();
    const out = await generateMissingPlatformMetadata(s.episodeId, { generate: stub.generate });
    assert.deepEqual(out.missing, ["igHashtags"], "the server measures what is missing itself");
    assert.deepEqual(out.filled, ["igHashtags"]);

    const row = await rowOf(s.episodeId);
    assert.deepEqual(JSON.parse(row.youtubeTags!), ["already", "there"], "an existing value is never overwritten");
    assert.equal(row.igHook, "My own hook");
    assert.equal(row.igHookEditedAt?.toISOString(), mark.toISOString(), "and its mark survives");
    assert.equal(row.igCaption, "", "an emptied field stays empty");
    assert.equal(row.igCaptionEditedAt?.toISOString(), mark.toISOString());
    assert.deepEqual(JSON.parse(row.igHashtags!), ["#deepwork", "#focus", "#productivity", "#booktok", "#attention"]);
    assert.equal(row.igHashtagsEditedAt, null);
  } finally {
    await s.cleanup();
  }
});

test("nothing missing means NO model call at all", async () => {
  const s = await seed({
    row: {
      youtubeTags: JSON.stringify(["a"]),
      igHook: "h",
      igCaption: "c",
      igHashtags: JSON.stringify(["#a"]),
    },
  });
  try {
    const stub = stubGenerate();
    const out = await generateMissingPlatformMetadata(s.episodeId, { generate: stub.generate });
    assert.deepEqual(out, { missing: [], filled: [] });
    assert.equal(stub.calls.length, 0, "a complete episode costs nothing to open");

    // Nor does one whose every empty field the operator emptied on purpose.
    await prisma.episode.update({
      where: { id: s.episodeId },
      data: { youtubeTags: null, igHook: "", igCaption: "", igHashtags: "[]", youtubeTagsEditedAt: new Date(), igHookEditedAt: new Date(), igCaptionEditedAt: new Date(), igHashtagsEditedAt: new Date() },
    });
    await generateMissingPlatformMetadata(s.episodeId, { generate: stub.generate });
    assert.equal(stub.calls.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("an operator edit made WHILE the writer is thinking wins: the write is a compare-and-swap, not a stale check", async () => {
  const s = await seed();
  try {
    const generate = (async () => {
      // The model takes minutes in production. Here the operator types a hook meanwhile.
      await saveMetadata(s.userId, s.episodeId, { igHook: "Typed while it thought" });
      return GENERATED;
    }) as never;

    const out = await generateMissingPlatformMetadata(s.episodeId, { generate });
    assert.deepEqual(out.missing, ["tags", "igHook", "igCaption", "igHashtags"], "all four were empty when the call started");
    assert.deepEqual(out.filled, ["tags", "igCaption", "igHashtags"], "but the hook was no longer empty when the answer landed");

    const row = await rowOf(s.episodeId);
    assert.equal(row.igHook, "Typed while it thought");
    assert.ok(row.igHookEditedAt, "and it keeps its hand-edited mark");
    assert.equal(row.igCaption, GENERATED.igCaption);
  } finally {
    await s.cleanup();
  }
});

test("two openings of one episode share ONE model call, and a later one runs afresh", async () => {
  const s = await seed();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const generate = (async () => {
      calls++;
      await gate;
      return GENERATED;
    }) as never;

    const first = generateMissingPlatformMetadata(s.episodeId, { generate });
    const second = generateMissingPlatformMetadata(s.episodeId, { generate });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1, "the second caller joined the first");
    assert.deepEqual(a, b);

    // Finished, so the slot is free: a later call is a new one (which now finds nothing missing).
    const third = await generateMissingPlatformMetadata(s.episodeId, { generate });
    assert.deepEqual(third.missing, []);
    assert.equal(calls, 1);
  } finally {
    await s.cleanup();
  }
});

test("a generation that fails stores NOTHING and says why; the panel can try again", async () => {
  const s = await seed();
  try {
    await assert.rejects(
      () => generateMissingPlatformMetadata(s.episodeId, { generate: stubGenerate(new Error("claude: not signed in")).generate }),
      /not signed in/,
    );
    const row = await rowOf(s.episodeId);
    assert.equal(row.youtubeTags, null);
    assert.equal(row.igHook, null);
    assert.equal(row.igCaption, null);
    assert.equal(row.igHashtags, null);

    // The in-flight slot was released by the failure, so the retry button works.
    const retry = await generateMissingPlatformMetadata(s.episodeId, { generate: stubGenerate().generate });
    assert.equal(retry.filled.length, 4);
  } finally {
    await s.cleanup();
  }
});

test("the whole chain with a stub model call: the real generator, source mapping and store, with a verified author", async () => {
  const s = await seed();
  try {
    const ep = await prisma.episode.findUniqueOrThrow({ where: { id: s.episodeId } });
    await prisma.book.update({ where: { id: ep.bookId }, data: { author: "Cal Newport", authorVerified: true, title: "The Focus Habit" } });

    const seen: { system: string; user: string }[] = [];
    const call = (async (_p: unknown, system: string, user: string) => {
      seen.push({ system, user });
      return {
        tags: ["deep work", "focus", "attention", "productivity", "time blocking"],
        igHook: "Busy is not focused.",
        igCaption: "A different caption, written for Instagram.",
        igHashtags: ["#a1", "#b2", "#c3", "#d4", "#e5"],
      };
    }) as never;

    const out = await generateMissingPlatformMetadata(s.episodeId, { call, provider: "claude-cli" });
    assert.equal(out.filled.length, 4);
    assert.match(seen[0].user, /Book: The Focus Habit/);
    assert.match(seen[0].user, /Author: Cal Newport/, "a VERIFIED author is passed");
    assert.doesNotMatch(seen[0].user, /What the book says about attention/, "the YouTube description is never shown to the writer");

    const row = await rowOf(s.episodeId);
    const tags = JSON.parse(row.youtubeTags!) as string[];
    assert.deepEqual(tags.slice(0, 2), ["The Focus Habit", "Cal Newport"], "the book and its verified author lead the tag list");
  } finally {
    await s.cleanup();
  }
});

test("the render step NEVER throws: a failing writer becomes a note, a working one writes the fields and returns null", async () => {
  const s = await seed();
  try {
    const note = await runPlatformMetadataStep(s.episodeId, { generate: stubGenerate(new Error("writer exploded")).generate });
    assert.equal(typeof note, "string");
    assert.match(note!, /YouTube tags and Instagram copy were not written \(writer exploded\)/);
    assert.match(note!, /the video is unaffected/);
    assert.match(note!, /press Generate/);
    assert.equal((await rowOf(s.episodeId)).igHook, null, "a failure leaves the fields empty, not half-filled");
    assert.equal((await rowOf(s.episodeId)).status, "DONE", "and costs the episode nothing");

    // Even an episode that does not exist is a note, not an exception out of the render.
    const gone = await runPlatformMetadataStep("no-such-episode", { generate: stubGenerate().generate });
    assert.match(gone!, /were not written/);

    assert.equal(await runPlatformMetadataStep(s.episodeId, { generate: stubGenerate().generate }), null);
    const row = await rowOf(s.episodeId);
    assert.equal(row.igHook, GENERATED.igHook);
    assert.equal(row.igHookEditedAt, null, "written by the render, so machine-written");
  } finally {
    await s.cleanup();
  }
});

test("a script-less episode cannot be generated for, and says so rather than inventing", async () => {
  const s = await seed({ row: { script: null, voScript: null } });
  try {
    await assert.rejects(
      () => generateMissingPlatformMetadata(s.episodeId, { call: (async () => GENERATED) as never, provider: "claude-cli" }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, "no_script");
        assert.equal((err as { status: number }).status, 409);
        return true;
      },
    );
    assert.equal((await rowOf(s.episodeId)).igHook, null);
  } finally {
    await s.cleanup();
  }
});

test("the generate route's episode lookup is the shared visibility rule and reports the status", async () => {
  const s = await seed();
  try {
    assert.equal((await loadForRegenerate(s.userId, s.episodeId)).status, "DONE");
    await assert.rejects(
      () => loadForRegenerate(s.otherUserId, s.episodeId),
      (err: unknown) => (err as { code: string }).code === "not_found",
      "another operator's episode is not found, not merely empty",
    );
    await prisma.episode.update({ where: { id: s.episodeId }, data: { userId: null, status: "RUNNING" } });
    const ownerless = await loadForRegenerate(s.otherUserId, s.episodeId);
    assert.equal(ownerless.status, "RUNNING", "an ownerless episode is visible, and the route will refuse it for not being DONE");
  } finally {
    await s.cleanup();
  }
});

test("after generation an edit still saves, marks, and keeps the platforms apart", async () => {
  const s = await seed();
  try {
    await generateMissingPlatformMetadata(s.episodeId, { generate: stubGenerate().generate });

    const edited = await saveMetadata(s.userId, s.episodeId, { igCaption: "My caption", tags: "focus, deep work" });
    assert.equal(edited.metadata.igCaption, "My caption");
    assert.deepEqual(edited.metadata.tags, ["focus", "deep work"]);
    assert.ok(edited.edits.igCaption && edited.edits.tags, "both are now the operator's");
    assert.equal(edited.edits.igHook, null, "the others are still as written");
    assert.equal(edited.metadata.description, "What the book says about attention.", "YouTube's description is untouched by Instagram edits");

    // Regenerate still demands confirmation for the edited field, and not for the generated one.
    const row = await rowOf(s.episodeId);
    assert.equal(wasHandEdited(row, "igCaption"), true);
    assert.equal(wasHandEdited(row, "igHook"), false);

    // Nothing is missing any more, so opening the panel again costs no model call.
    const stub = stubGenerate();
    assert.deepEqual((await generateMissingPlatformMetadata(s.episodeId, { generate: stub.generate })).missing, []);
    assert.equal(stub.calls.length, 0);
  } finally {
    await s.cleanup();
  }
});

// ---- the panel's two states, rendered

const NoticeComponent = (centerModule as unknown as { GenerateNotice: React.ComponentType<Record<string, unknown>> }).GenerateNotice;

test("GENERATING is announced, with what is being written; FAILED has a Generate button and the reason -- never a blank", () => {
  const c = strings.publishCenter;
  const running = renderToStaticMarkup(
    React.createElement(NoticeComponent, { state: "running", what: c.generatingYouTube, onGenerate: () => {} }),
  );
  assert.match(running, /role="status"/);
  assert.match(running, /aria-busy="true"/);
  assert.ok(running.includes("Writing the YouTube tags"));
  assert.ok(running.includes(c.generatingHint));
  assert.doesNotMatch(running, /<button/, "nothing to press while it is working");

  const failed = renderToStaticMarkup(
    React.createElement(NoticeComponent, { state: "error", what: c.generatingInstagram, detail: "The writer could not be reached: not signed in", onGenerate: () => {} }),
  );
  assert.match(failed, /role="alert"/);
  assert.ok(failed.includes(c.generateFailed));
  assert.ok(failed.includes("not signed in"), "the reason is shown");
  assert.match(failed, /<button[^>]*>[\s\S]*Generate[\s\S]*<\/button>/, "a manual retry");

  const retrying = renderToStaticMarkup(
    React.createElement(NoticeComponent, { state: "error", what: "x", busy: true, onGenerate: () => {} }),
  );
  assert.match(retrying, /aria-disabled="true"/);
  assert.ok(retrying.includes(c.generating));
});

test("the panel is wired to ask once on open, show both states on the right package, and take the answer without a re-fetch", async () => {
  const src = await fs.readFile(fileURLToPath(new URL("../src/components/PublishCenter.tsx", import.meta.url)), "utf8");
  assert.match(src, /missingPlatformFields\(view\.metadata, view\.edits\)/, "the same rule the server applies");
  assert.match(src, /view\.status === "DONE"/, "only a finished episode is asked about");
  assert.match(src, /asked\.current\.has\(id\)/, "once per episode per mount");
  assert.match(src, /\/api\/episodes\/\$\{episodeId\}\/publish\/generate/);
  assert.match(src, /method: "POST"/);
  // Both packages, each on its own fields.
  assert.match(src, /showYouTubeNotice = .*missing\.includes\("tags"\)/);
  assert.match(src, /showInstagramNotice = .*missing\.some\(\(f\) => f !== "tags"\)/);
  assert.equal(src.match(/<GenerateNotice/g)?.length, 2);
  // The answer is the view (no second request), applied only to the episode it was for.
  assert.match(src, /prev\.id === target \? \{ id: target, view: result\.body/);
  // A manual retry exists and is the same request.
  assert.match(src, /onGenerate=\{generateNow\}/);
  // The derived "generating" state sets nothing in the effect body (the lint rule this file already honours).
  assert.match(src, /gen\[id\] \?\? \{ phase: "running" \}/);
});

test("the Instagram title field reads as the Instagram title / hook, and not as the YouTube title", () => {
  const c = strings.publishCenter;
  assert.equal(c.igHookLabel, "Title / hook");
  assert.match(c.igHookHint, /Instagram has no title field/);
  assert.match(c.igHookHint, /Not the YouTube title/);
});
