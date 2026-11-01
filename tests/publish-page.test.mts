import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "../src/lib/db";
import { isAppError } from "../src/lib/errors";
import { RENDER_DIR } from "../src/lib/paths";
import { serializeThumbnails, type ThumbSpec } from "../src/lib/thumbnails";
import { thumbsDir, THUMB_KEYS } from "../src/lib/thumbnails/types";
import { instagramCaption, variantFor, type PlatformId, type PublishMetadata } from "../src/lib/publish/limits";
import type { PlatformCapabilities, PreparedPublish, PublishOutcome } from "../src/lib/publish/contract";
import type { PlatformState, PublishView } from "../src/lib/publish/view";
import { browserPublisherFor, publisherFor } from "../src/lib/publish/registry";
import { MIN_SCHEDULE_LEAD_MS, type BrowserPublishOptions, type BrowserPublisher } from "../src/lib/publish/browser/engine";
import { startBrowserPublish, type StartBrowserOptions } from "../src/lib/publish/browser/run";
import { publishView } from "../src/lib/publish/state";
import {
  LEAD_MS,
  PUBLISH_TIMEZONE,
  TARGETS_OF,
  apiReady,
  canAsk,
  earliestInput,
  governingSlot,
  instantFromLocalInput,
  localInputFor,
  offersSignIn,
  planTarget,
  planTargets,
  reportFor,
  requestFor,
  resolveSchedule,
  safeHref,
  scheduleProblem,
  sectionStatus,
  triggerLabel,
  whenText,
  type PlanContext,
  type SlotLookup,
} from "../src/lib/publish/flow";
import { alreadyThere, youtubeJob } from "../src/lib/schedule/activate";
import { episodeSlotView } from "../src/lib/schedule/store";
import { zonedInstant } from "../src/lib/schedule/time";
import { SCHEDULE_LEAD_MINUTES, type EpisodeSlotView } from "../src/lib/schedule/view";
import * as centerModule from "../src/components/PublishCenter";
import * as flowModule from "../src/components/PublishFlow";
import { connectCopy, instagramCopy } from "../src/lib/publish/connect";
import { strings } from "../src/lib/strings";
import { requireIsolation } from "./setup/isolation";

// Legacy quick-publish behavior is tested only through mocked publishers.
process.env.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED = "1";

/**
 * The Publish page, laid out the way the wireframe draws it -- tested with SCRIPTED publishers and
 * never a real site.
 *
 * NOTHING IN THIS FILE OPENS A WINDOW, SIGNS IN, OR TOUCHES YOUTUBE OR INSTAGRAM. The page's decisions
 * are pure (`lib/publish/flow.ts`) and are tested as such; the layout is rendered to static markup; and
 * the publish path is driven through `startBrowserPublish`'s own test seam (`makePublisher`) with the
 * exact body the page would send, so what is proved is that the page asks for the right thing and that
 * a status appears only when the engine records one.
 *
 * What it does NOT prove, and the report says so: that a real Studio or Instagram accepts the upload,
 * and the click-by-click behaviour in a browser (there is no DOM in this suite).
 */

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string): Promise<string> => fs.readFile(here(p), "utf8");
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

// ------------------------------------------------------------------ fixtures

/** Sat 17 Oct 2026, 11:30 IST. Every "now" in this file is this unless a test says otherwise. */
const NOW = Date.UTC(2026, 9, 17, 6, 0, 0);

const META: PublishMetadata = {
  title: "Productivity Isn't Hustle",
  description: "What the book actually says about attention.",
  hashtags: ["#focus", "#deepwork"],
  hook: "Most people are busy.",
  tags: ["focus", "attention"],
  igHook: "Busy is not focused.",
  igCaption: "Most of us are busy all day and focused for none of it.",
  igHashtags: ["#deepwork", "#focus"],
};

function caps(platform: PlatformId, canUpload: boolean): PlatformCapabilities {
  return { ...publisherFor(platform, { mode: "browser" }).capabilities(), canUpload };
}

/** A platform as `publishView` reports it. The browser route is available unless a test says otherwise. */
function ps(platform: PlatformId, over: Partial<PlatformState> = {}): PlatformState {
  return {
    platform,
    label: platform === "youtube" ? "YouTube" : "Instagram",
    status: "REQUIRES_CONNECTION",
    capabilities: caps(platform, false),
    hasPublisher: true,
    configured: false,
    problems: [],
    variant: variantFor(platform, META),
    cover: null,
    handoff: [],
    requires: [],
    browser: { available: true, reason: null, canSchedule: platform === "youtube", headless: false },
    job: null,
    ...over,
  };
}

const jobOf = (over: Partial<NonNullable<PlatformState["job"]>> = {}): NonNullable<PlatformState["job"]> => ({
  status: "REQUIRES_CONNECTION",
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
  mode: "browser",
  scheduledFor: null,
  ...over,
});

function viewOf(over: Partial<PublishView> = {}): PublishView {
  return {
    episodeId: "e1",
    title: "Productivity Isn't Hustle",
    bookTitle: "The Eagle Way",
    status: "DONE",
    durationSec: 61.5,
    videoUrl: "/api/episodes/e1/video?v=1",
    videoBytes: 9000,
    poster: { key: "9x16-bold", url: "/api/episodes/e1/thumbnail/9x16-bold?rev=1", width: 1080, height: 1920 },
    thumbnails: [
      { key: "9x16-bold", aspect: "9:16", url: "/api/episodes/e1/thumbnail/9x16-bold?rev=1", width: 1080, height: 1920 },
      { key: "16x9-bold", aspect: "16:9", url: "/api/episodes/e1/thumbnail/16x9-bold?rev=1", width: 1920, height: 1080 },
    ],
    thumbChoices: { youtube: null, instagram: null, default: null },
    metadata: META,
    edits: { title: null, description: null, hashtags: null, tags: null, igHook: null, igCaption: null, igHashtags: null },
    readiness: { ready: true, issues: [] },
    platforms: [ps("youtube"), ps("instagram")],
    owned: true,
    ...over,
  };
}

const EPISODE = {
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

const Center = ((centerModule as { default: unknown }).default as { default?: unknown }).default ??
  (centerModule as { default: unknown }).default;

function renderPage(view: PublishView | null = viewOf()): string {
  return renderToStaticMarkup(
    React.createElement(Center as React.ComponentType<{ episode: unknown; initialView: unknown }>, { episode: EPISODE, initialView: view }),
  );
}

const parts = flowModule as unknown as {
  PlatformReport: React.ComponentType<Record<string, unknown>>;
  ConfirmPanel: React.ComponentType<Record<string, unknown>>;
  VisibilityBlock: React.ComponentType<Record<string, unknown>>;
  ScheduleBlock: React.ComponentType<Record<string, unknown>>;
};
const html = (type: React.ComponentType<Record<string, unknown>>, props: Record<string, unknown>): string =>
  renderToStaticMarkup(React.createElement(type, props));

const lookupNone: SlotLookup = { state: "ready", slot: null };

function slotAt(instant: Date, over: Partial<EpisodeSlotView> = {}): EpisodeSlotView {
  return {
    scheduleId: "sch1",
    slotId: "slot1",
    assignedAt: instant.toISOString(),
    timezone: "Asia/Kolkata",
    madeForKids: false,
    status: "pending",
    note: null,
    ...over,
  };
}

/** Tomorrow 09:00 IST: far past the 15-minute floor from NOW. */
const TOMORROW_9 = zonedInstant("2026-10-18", "09:00");

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    owned: true,
    visibility: "private",
    schedule: { kind: "none" },
    kids: false,
    looked: false,
    now: NOW,
    ...over,
  };
}

// ====================================================================== client safety

test("flow.ts is client-safe: it imports only limits, strings and the two import-free schedule modules", async () => {
  const source = withoutComments(await read("../src/lib/publish/flow.ts"));
  const specs = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(specs, ["./limits", "./view", "@/lib/schedule/time", "@/lib/schedule/view", "@/lib/strings"].sort());
  // `./view` is imported for TYPES only: a value import would drag its own imports along.
  assert.match(source, /import type \{[^}]*\} from "\.\/view"/);
  for (const name of ["time.ts", "view.ts", "plan.ts", "reference-time.ts"]) {
    const imports = [...(await read(`../src/lib/schedule/${name}`)).matchAll(/from\s+["\']([^"\']+)["\']/g)].map(match => match[1]);
    assert.ok(imports.every(spec => ["./plan", "./reference-time"].includes(spec)), `${name} imports only pure planner modules`);
  }
});

test("the page components import only client-safe modules and never the engine, Prisma or a platform card", async () => {
  for (const name of ["PublishFlow.tsx", "PublishCenter.tsx"]) {
    const code = withoutComments(await read(`../src/components/${name}`));
    assert.match(code, /^"use client"/);
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.doesNotMatch(spec, /@\/lib\/db|@prisma|publish\/browser|publish\/state|publish\/youtube|publish\/instagram|\/(YouTube|Instagram|Browser)Publish$/, `${name} imports ${spec}`);
    }
  }
});

// ====================================================================== the schedule: India time, exactly

test("a picked wall-clock time is read in Asia/Kolkata with zonedInstant, whatever zone this computer is in", () => {
  const expected = "2026-10-20T03:30:00.000Z";
  assert.equal(PUBLISH_TIMEZONE, "Asia/Kolkata");
  assert.equal(instantFromLocalInput("2026-10-20T09:00")?.toISOString(), expected);
  assert.equal(instantFromLocalInput("2026-10-20T09:00")?.getTime(), zonedInstant("2026-10-20", "09:00", "Asia/Kolkata").getTime(), "the Weekly Schedule's own function");
  // The browser's seconds are accepted; the instant is still to the minute.
  assert.equal(instantFromLocalInput("2026-10-20T09:00:30")?.toISOString(), expected);
  // Across the UTC date line, both ways.
  assert.equal(instantFromLocalInput("2026-10-20T00:15")?.toISOString(), "2026-10-19T18:45:00.000Z");
  assert.equal(instantFromLocalInput("2026-10-20T23:45")?.toISOString(), "2026-10-20T18:15:00.000Z");

  const zone = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(instantFromLocalInput("2026-10-20T09:00")?.toISOString(), expected, `computer zone ${tz}`);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("a value that is not a real date and time is no schedule at all, and says so", () => {
  for (const bad of ["", "tomorrow", "2026-02-30T09:00", "2026-10-20", "2026-10-20T25:00", "2026-13-01T09:00", "20/10/2026 09:00"]) {
    assert.equal(instantFromLocalInput(bad), null, JSON.stringify(bad));
  }
  const invalid = resolveSchedule({ picked: "2026-02-30T09:00", lookup: lookupNone });
  assert.equal(invalid.kind, "invalid");
  assert.equal(scheduleProblem(invalid, NOW), strings.publishCenter.flow.scheduleInvalid);
  assert.equal(resolveSchedule({ picked: "", lookup: lookupNone }).kind, "none");
  assert.equal(resolveSchedule({ picked: "   ", lookup: lookupNone }).kind, "none");
});

test("the 15-minute floor is the engine's, and is judged to the minute", () => {
  assert.equal(LEAD_MS, MIN_SCHEDULE_LEAD_MS, "the page mirrors the engine's floor");
  assert.equal(SCHEDULE_LEAD_MINUTES * 60_000, MIN_SCHEDULE_LEAD_MS);
  const at = (ms: number) => ({ kind: "picked" as const, instant: new Date(NOW + ms) });
  assert.equal(scheduleProblem(at(LEAD_MS), NOW), null, "exactly the floor is allowed, as in the engine");
  assert.match(scheduleProblem(at(LEAD_MS - 1), NOW) ?? "", /at least 15 minutes from now/);
  assert.match(scheduleProblem(at(-60_000), NOW) ?? "", /at least 15 minutes/);
  assert.equal(scheduleProblem({ kind: "none" }, NOW), null);
  // The earliest value the picker offers is the floor, written in India time.
  assert.equal(earliestInput(NOW), localInputFor(new Date(NOW + LEAD_MS)));
  assert.equal(earliestInput(NOW), "2026-10-17T11:45");
  assert.equal(whenText(TOMORROW_9), "Sun 18 Oct 2026, 09:00 IST");
});

test("a video in an ACTIVATED Weekly Schedule is posted at its slot's exact instant, and a picked time cannot override it", () => {
  const slot = slotAt(TOMORROW_9);
  const lookup: SlotLookup = { state: "ready", slot };
  assert.equal(governingSlot(lookup), slot);
  const choice = resolveSchedule({ picked: "2026-10-25T20:00", lookup });
  assert.equal(choice.kind, "slot", "the slot wins over whatever was typed");
  assert.equal(choice.kind === "slot" ? choice.instant.toISOString() : "", TOMORROW_9.toISOString());

  // The request carries the server's own string, untouched.
  const plan = planTarget(ps("youtube"), ctx({ schedule: choice }));
  assert.equal(plan.kind, "send");
  assert.equal(plan.body?.scheduledAt, slot.assignedAt, "the exact assignedAt, not a re-derivation");
  assert.equal(plan.body?.confirmPublic, true);
  assert.equal(plan.body?.visibility, "public");
  assert.ok(plan.lines[0].includes("Sun 18 Oct 2026, 09:00 IST"));

  // A skipped slot (already scheduled or posted when the schedule ran) no longer says when to post.
  assert.equal(governingSlot({ state: "ready", slot: slotAt(TOMORROW_9, { status: "skipped" }) }), null);
  assert.equal(resolveSchedule({ picked: "", lookup: { state: "ready", slot: slotAt(TOMORROW_9, { status: "skipped" }) } }).kind, "none");
  // Not known yet, or not knowable: no slot is assumed.
  assert.equal(governingSlot({ state: "loading" }), null);
  assert.equal(governingSlot({ state: "error" }), null);
});

test("a Weekly Schedule slot that has passed is NOT posted at some other time: the page refuses and says why", () => {
  const past = slotAt(new Date(NOW + 5 * 60_000)); // five minutes away: inside the floor
  const choice = resolveSchedule({ picked: "", lookup: { state: "ready", slot: past } });
  const plan = planTarget(ps("youtube"), ctx({ schedule: choice }));
  assert.equal(plan.kind, "blocked");
  assert.match(plan.note ?? "", /Weekly Schedule set this video for .* IST/);
  assert.match(plan.note ?? "", /will not post it at a different time/);
  assert.equal(requestFor("e1", plan), null, "nothing is sent");
  assert.equal(canAsk([plan]), false);
});

// ====================================================================== what a press does: routes, confirmation, dedupe

test("YouTube private through the browser: no confirmPublic, the kids answer carried, no schedule", () => {
  const plan = planTarget(ps("youtube"), ctx());
  assert.equal(plan.kind, "send");
  assert.equal(plan.route, "browser");
  assert.equal(plan.goesLive, false);
  assert.deepEqual(plan.body, {
    platform: "youtube",
    visibility: "private",
    scheduledAt: null,
    madeForKids: false,
    confirmPublic: false,
    acknowledgeRetry: false,
  });
  const req = requestFor("e1", plan);
  assert.equal(req?.url, "/api/episodes/e1/publish/browser");
  assert.equal(req?.init.method, "POST");
});

test("a PUBLIC or a SCHEDULED YouTube post goes with confirmPublic, and a private or unlisted one never does", () => {
  const body = (over: Partial<PlanContext>) => planTarget(ps("youtube"), ctx(over)).body;
  assert.equal(body({ visibility: "public" })?.confirmPublic, true);
  assert.equal(body({ visibility: "public" })?.visibility, "public");
  assert.equal(body({ visibility: "private" })?.confirmPublic, false);
  assert.equal(body({ visibility: "unlisted" })?.confirmPublic, false);
  assert.equal(body({ visibility: "unlisted" })?.visibility, "unlisted");

  const scheduled = body({ schedule: { kind: "picked", instant: TOMORROW_9 } });
  assert.equal(scheduled?.confirmPublic, true, "a schedule is public-at-a-time");
  assert.equal(scheduled?.scheduledAt, TOMORROW_9.toISOString());
  assert.equal(scheduled?.visibility, "public");
  // A schedule makes the post public whatever visibility was left selected.
  assert.equal(body({ visibility: "private", schedule: { kind: "picked", instant: TOMORROW_9 } })?.visibility, "public");

  for (const visibility of ["private", "unlisted"] as const) {
    const plan = planTarget(ps("youtube"), ctx({ visibility }));
    assert.equal(plan.goesLive, false, visibility);
    assert.ok(!plan.lines.join(" ").includes("PUBLICLY"), "a private post never warns about going public");
  }
  assert.equal(planTarget(ps("youtube"), ctx({ visibility: "public" })).goesLive, true);
  assert.match(planTarget(ps("youtube"), ctx({ visibility: "public" })).lines.join(" "), /PUBLICLY, right now/);
});

test("the made-for-kids answer is never defaulted: without it the YouTube browser route is blocked", () => {
  const plan = planTarget(ps("youtube"), ctx({ kids: null }));
  assert.equal(plan.kind, "blocked");
  assert.match(plan.note ?? "", /made for kids/);
  assert.equal(plan.body, null);
  assert.equal(planTarget(ps("youtube"), ctx({ kids: true })).body?.madeForKids, true);
  assert.equal(planTarget(ps("youtube"), ctx({ kids: false })).body?.madeForKids, false);
  // Instagram has no such declaration, so it needs none.
  assert.equal(planTarget(ps("instagram"), ctx({ kids: null })).kind, "send");
});

test("Instagram is public-only: always confirmPublic, public visibility, never a schedule or a private post", () => {
  for (const over of [{}, { visibility: "private" as const }, { visibility: "unlisted" as const }, { schedule: { kind: "picked" as const, instant: TOMORROW_9 } }]) {
    const plan = planTarget(ps("instagram"), ctx(over));
    assert.equal(plan.kind, "send");
    assert.equal(plan.route, "browser");
    assert.deepEqual(plan.body, { platform: "instagram", visibility: "public", confirmPublic: true, acknowledgeRetry: false });
    assert.ok(!("scheduledAt" in (plan.body ?? {})), "Instagram's web uploader cannot schedule, so nothing is asked of it");
    assert.equal(plan.goesLive, true);
  }
});

test("pressing Instagram while a schedule is set says that Instagram will post AT ONCE -- never a silent conversion", () => {
  const withSchedule = planTarget(ps("instagram"), ctx({ schedule: { kind: "picked", instant: TOMORROW_9 } }));
  assert.ok(withSchedule.lines.some((l) => /quick-publish action shares Instagram now/.test(l)), withSchedule.lines.join("|"));
  assert.ok(withSchedule.lines.some((l) => /PUBLICLY and at once/.test(l)));
  // And a slot-locked schedule says the same.
  const slotted = planTarget(ps("instagram"), ctx({ schedule: resolveSchedule({ picked: "", lookup: { state: "ready", slot: slotAt(TOMORROW_9) } }) }));
  assert.ok(slotted.lines.some((l) => /quick-publish action shares Instagram now/.test(l)));
  // With no schedule there is nothing to contradict.
  assert.ok(!planTarget(ps("instagram"), ctx()).lines.some((l) => /quick-publish action shares Instagram now/.test(l)));
});

test("the official API is used only when it can serve exactly what was asked for", () => {
  const apiYt = ps("youtube", { configured: true, capabilities: caps("youtube", true) });
  const apiIg = ps("instagram", { configured: true, capabilities: caps("instagram", true) });
  assert.equal(apiReady(apiYt), true);
  assert.equal(apiReady(ps("youtube", { configured: true, capabilities: caps("youtube", false) })), false);
  assert.equal(apiReady(ps("youtube", { configured: false, capabilities: caps("youtube", true) })), false, "capable is not connected");

  // Private and unscheduled: the API (it uploads private, and takes no options).
  const priv = planTarget(apiYt, ctx());
  assert.equal(priv.route, "api");
  const privReq = requestFor("e1", priv);
  assert.equal(privReq?.url, "/api/episodes/e1/publish/youtube");
  assert.equal(privReq?.init.body, undefined);
  assert.equal(priv.goesLive, false);

  // Anything the API cannot do goes through the browser route, which carries it and the confirmation.
  for (const over of [{ visibility: "public" as const }, { visibility: "unlisted" as const }, { schedule: { kind: "picked" as const, instant: TOMORROW_9 } }]) {
    const plan = planTarget(apiYt, ctx(over));
    assert.equal(plan.route, "browser", JSON.stringify(over));
    assert.equal(plan.body?.platform, "youtube");
  }

  // Instagram through the API: public, so it carries confirmPublic.
  const ig = planTarget(apiIg, ctx());
  assert.equal(ig.route, "api");
  const igReq = requestFor("e1", ig);
  assert.equal(igReq?.url, "/api/episodes/e1/publish/instagram");
  assert.deepEqual(JSON.parse(String(igReq?.init.body)), { confirmPublic: true });
});

test("an episode that is not yours, not ready, or that the platform would refuse sends nothing and says why", () => {
  const owned = planTarget(ps("youtube"), ctx({ owned: false }));
  assert.equal(owned.kind, "blocked");
  assert.match(owned.note ?? "", /does not belong to this account/);

  assert.equal(planTarget(ps("youtube", { status: "NOT_READY" }), ctx()).kind, "blocked");
  const refused = planTarget(ps("youtube", { problems: ["The title is over 100 characters."] }), ctx());
  assert.equal(refused.kind, "blocked");
  assert.equal(refused.note, "The title is over 100 characters.");

  const noChrome = planTarget(
    ps("youtube", { browser: { available: false, reason: "No Chromium was found on this server.", canSchedule: true, headless: false } }),
    ctx(),
  );
  assert.equal(noChrome.kind, "blocked");
  assert.equal(noChrome.note, "No Chromium was found on this server.");
  assert.equal(planTarget(ps("youtube", { browser: null }), ctx()).kind, "blocked");

  const cannotSchedule = planTarget(
    ps("youtube", { browser: { available: true, reason: null, canSchedule: false, headless: false } }),
    ctx({ schedule: { kind: "picked", instant: TOMORROW_9 } }),
  );
  assert.equal(cannotSchedule.kind, "blocked");
  assert.match(cannotSchedule.note ?? "", /cannot be scheduled from here/);

  const tooSoon = planTarget(ps("youtube"), ctx({ schedule: { kind: "picked", instant: new Date(NOW + 60_000) } }));
  assert.equal(tooSoon.kind, "blocked");
  assert.match(tooSoon.note ?? "", /at least 15 minutes from now/);
  for (const plan of [owned, refused, noChrome, cannotSchedule, tooSoon]) assert.equal(requestFor("e1", plan), null);
});

test("NO DUPLICATE: a platform already posted, scheduled or in flight has nothing to send, and says so", () => {
  const job = jobOf({ externalId: "VID1", publishedAt: new Date(NOW).toISOString(), scheduledFor: TOMORROW_9.toISOString() });
  const posted = planTarget(ps("youtube", { status: "PUBLISHED", job }), ctx({ visibility: "public" }));
  const scheduled = planTarget(ps("youtube", { status: "SCHEDULED", job }), ctx({ schedule: { kind: "picked", instant: TOMORROW_9 } }));
  const working = planTarget(ps("instagram", { status: "PREPARING", job: jobOf({ status: "PREPARING" }) }), ctx());
  const uploading = planTarget(ps("youtube", { status: "UPLOADING", job: jobOf({ status: "UPLOADING" }) }), ctx());
  for (const plan of [posted, scheduled, working, uploading]) {
    assert.equal(plan.kind, "done");
    assert.equal(plan.body, null);
    assert.equal(plan.route, null);
    assert.equal(requestFor("e1", plan), null, "no request at all, never a second job");
    assert.equal(canAsk([plan]), false);
  }
  assert.match(posted.note ?? "", /Already posted on YouTube\. Nothing was sent\./);
  assert.match(scheduled.note ?? "", /Already scheduled on YouTube for Sun 18 Oct 2026, 09:00 IST\. Nothing was sent\./);
  assert.match(working.note ?? "", /already in progress/);

  // "Both" with one already done sends only the other.
  const both = planTargets(
    [ps("youtube", { status: "SCHEDULED", job }), ps("instagram")],
    TARGETS_OF.both,
    () => ctx({ schedule: { kind: "picked", instant: TOMORROW_9 } }),
  );
  assert.deepEqual(both.map((p) => [p.platform, p.kind]), [["instagram", "send"], ["youtube", "done"]]);
  assert.equal(canAsk(both), true);
  assert.equal(canAsk(both.map((p) => (p.platform === "instagram" ? { ...p, kind: "blocked" as const } : p))), false, "one blocked platform blocks the press");
});

test("a stop for a person is retried only behind the operator's own tick, and never when the platform already showed a video", () => {
  const stopped = ps("youtube", { status: "AWAITING_HUMAN", job: jobOf({ status: "AWAITING_HUMAN", lastError: "Sign in to YouTube in the window." }) });
  const untouched = planTarget(stopped, ctx());
  assert.equal(untouched.kind, "blocked");
  assert.match(untouched.note ?? "", /Tick the box below to say you looked at YouTube/);

  const ticked = planTarget(stopped, ctx({ looked: true }));
  assert.equal(ticked.kind, "send");
  assert.equal(ticked.route, "browser", "a retry is a browser job's");
  assert.equal(ticked.body?.acknowledgeRetry, true);
  assert.equal(ticked.retry, true);
  assert.equal(triggerLabel([stopped, ps("instagram")], ["youtube"]), "retry");
  assert.equal(triggerLabel([stopped, ps("instagram")], ["instagram"]), "publish");

  // Even a connected API account does not take over a stopped browser job.
  const withApi = ps("youtube", { ...stopped, configured: true, capabilities: caps("youtube", true) });
  assert.equal(planTarget(withApi, ctx({ looked: true })).route, "browser");

  const seen = planTarget(
    ps("youtube", { status: "AWAITING_HUMAN", job: jobOf({ status: "AWAITING_HUMAN", externalId: "VID9" }) }),
    ctx({ looked: true }),
  );
  assert.equal(seen.kind, "done");
  assert.match(seen.note ?? "", /already showed a video .* VID9/);

  // The first attempt never carries the acknowledgement.
  assert.equal(planTarget(ps("youtube"), ctx({ looked: true })).body?.acknowledgeRetry, false);
});

// ====================================================================== what the page says: only what the job says

test("POSTED and SCHEDULED are claimed only for a job that carries the platform's own id and time", () => {
  const confirmedPost = reportFor(
    ps("instagram", { status: "PUBLISHED", job: jobOf({ status: "PUBLISHED", externalId: "REEL1", externalUrl: "https://www.instagram.com/reel/REEL1/", publishedAt: new Date(NOW).toISOString() }) }),
  );
  assert.equal(confirmedPost?.confirmed, true);
  assert.equal(confirmedPost?.headline, "Posted on Instagram");
  assert.match(confirmedPost?.detail ?? "", /confirmed by the platform · id REEL1/);
  assert.equal(confirmedPost?.link?.href, "https://www.instagram.com/reel/REEL1/");

  const confirmedSchedule = reportFor(
    ps("youtube", {
      status: "SCHEDULED",
      job: jobOf({ status: "SCHEDULED", externalId: "VID1", scheduledFor: TOMORROW_9.toISOString(), reviewUrl: "https://studio.youtube.com/video/VID1/edit" }),
    }),
  );
  assert.equal(confirmedSchedule?.confirmed, true);
  assert.equal(confirmedSchedule?.headline, "Scheduled on YouTube for Sun 18 Oct 2026, 09:00 IST");
  assert.equal(confirmedSchedule?.link?.label, "Open in YouTube Studio");

  // A row that says PUBLISHED / SCHEDULED without the platform's evidence is NOT shown as a success.
  for (const [status, job] of [
    ["PUBLISHED", jobOf({ status: "PUBLISHED" })],
    ["PUBLISHED", jobOf({ status: "PUBLISHED", externalId: "X" })],
    ["PUBLISHED", jobOf({ status: "PUBLISHED", publishedAt: new Date(NOW).toISOString() })],
    ["SCHEDULED", jobOf({ status: "SCHEDULED", externalId: "X" })],
    ["SCHEDULED", jobOf({ status: "SCHEDULED", scheduledFor: TOMORROW_9.toISOString() })],
  ] as const) {
    const report = reportFor(ps("youtube", { status, job }));
    assert.equal(report?.confirmed, false, `${status} ${JSON.stringify(job.externalId)}`);
    assert.doesNotMatch(report?.headline ?? "", /Posted|Scheduled/);
    assert.equal(report?.needsHuman, true);
    assert.equal(report?.tone, "soon");
  }
});

test("a stop for a person is shown as one, with the engine's own sentence; in flight and failed are not successes either", () => {
  const stopped = reportFor(
    ps("youtube", { status: "AWAITING_HUMAN", job: jobOf({ status: "AWAITING_HUMAN", lastError: "YouTube is asking you to sign in. Nothing was published." }) }),
  );
  assert.equal(stopped?.headline, "YouTube: needs you");
  assert.equal(stopped?.detail, "YouTube is asking you to sign in. Nothing was published.", "verbatim");
  assert.equal(stopped?.needsHuman, true);
  assert.equal(stopped?.confirmed, false);

  const working = reportFor(ps("instagram", { status: "UPLOADING", job: jobOf({ status: "UPLOADING" }) }));
  assert.equal(working?.tone, "live");
  assert.equal(working?.confirmed, false);
  assert.match(working?.detail ?? "", /only recorded as posted or scheduled once the platform's own page confirms it/);

  const failed = reportFor(ps("youtube", { status: "FAILED", job: jobOf({ status: "FAILED", lastError: "The title was refused." }) }));
  assert.equal(failed?.tone, "failed");
  assert.equal(failed?.detail, "The title was refused.");

  assert.equal(reportFor(ps("youtube")), null, "nothing attempted: nothing said");
  assert.equal(reportFor(ps("youtube", { status: "READY" })), null);
});

test("the section badge says 'Not posted yet', not 'Requires connection': the browser route needs no API connection", () => {
  assert.equal(sectionStatus("REQUIRES_CONNECTION").label, "Not posted yet");
  assert.equal(sectionStatus("READY").label, "Not posted yet");
  assert.deepEqual(
    (["PUBLISHED", "SCHEDULED", "PREPARING", "UPLOADING", "AWAITING_HUMAN", "FAILED", "NOT_READY"] as const).map((s) => sectionStatus(s).label),
    ["Posted", "Scheduled", "In progress", "In progress", "Needs you", "Failed", "Not ready"],
  );
});

test("Sign in to YouTube is offered only on a YouTube stop that never saw a video, and only where the server can open it", () => {
  const stop = (over: Partial<PlatformState> = {}) =>
    ps("youtube", {
      status: "AWAITING_HUMAN",
      job: jobOf({ status: "AWAITING_HUMAN", lastError: "Sign in." }),
      browser: { available: true, reason: null, canSchedule: true, headless: false, channel: "chrome" },
      ...over,
    });
  assert.equal(offersSignIn(stop()), true);
  assert.equal(offersSignIn(stop({ browser: { available: true, reason: null, canSchedule: true, headless: false } })), false, "not in channel mode: the route would refuse");
  assert.equal(
    offersSignIn(stop({ browser: { available: true, reason: null, canSchedule: true, headless: false, attach: { endpoint: "http://127.0.0.1:9222" }, channel: "chrome" } })),
    false,
    "attaching to the operator's own Chrome: they sign in there",
  );
  assert.equal(offersSignIn(stop({ job: jobOf({ status: "AWAITING_HUMAN", externalId: "V" }) })), false, "a video was seen");
  assert.equal(offersSignIn(stop({ status: "SCHEDULED" })), false);
  assert.equal(offersSignIn(stop({ status: "READY", job: null })), false, "not a standing section");
  assert.equal(offersSignIn({ ...stop(), platform: "instagram" }), false, "YouTube only");
});

test("safeHref lets only an app path or an https URL become a link", () => {
  assert.equal(safeHref("/api/x"), "/api/x");
  assert.equal(safeHref("https://studio.youtube.com/video/1"), "https://studio.youtube.com/video/1");
  for (const bad of ["javascript:alert(1)", "http://example.test", "data:text/html,x", "//evil.test", "/\\evil.test", "", null, undefined]) {
    assert.equal(safeHref(bad as string | null | undefined), null, String(bad));
  }
});

// ====================================================================== the layout, as the wireframe draws it

test("the page renders the wireframe, top to bottom", () => {
  const out = renderPage();
  const f = strings.publishCenter.flow;

  // 1. The header.
  assert.ok(out.includes("Publish – Productivity Isn&#x27;t Hustle"), "Publish – [Video Title]");

  // 2. The video and its thumbnail, side by side, each with its Download.
  const media = out.indexOf('class="pub-media"');
  assert.ok(media > 0, "the media row");
  const video = out.indexOf("<video", media);
  const poster = out.indexOf('class="pub-poster"', media);
  assert.ok(video > media && poster > video, "the video, then the thumbnail beside it");
  assert.match(out, /<a class="chip" href="\/api\/episodes\/e1\/video\?v=1" download=""><span class="truncate">Download video<\/span><\/a>/);
  assert.match(out, /<a class="chip" href="\/api\/episodes\/e1\/thumbnail\/9x16-bold\?rev=1" download=""><span class="truncate">Download poster<\/span><\/a>/);
  assert.ok(out.indexOf(">Download video<") < out.indexOf(">Download poster<"), "Download video under the video, Download poster under the thumbnail");

  // 3-7 in order.
  const order = [
    media,
    out.indexOf(`>${strings.publishCenter.tagsLabel}</label>`), // inside the YouTube block
    out.indexOf(`>${strings.publishCenter.igCaptionLabel}</label>`), // inside the Instagram block
    out.indexOf(`>${f.visibilityHeading}<`),
    out.indexOf(`>${f.scheduleHeading}<`),
    out.indexOf(`>${f.actionsHeading}<`),
  ];
  assert.ok(order.every((n) => n > 0), `every section is there: ${order.join(",")}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in the wireframe's order");
});

test("YouTube has four editable fields and Instagram three, each with Rewrite and Copy", () => {
  const out = renderPage();
  const c = strings.publishCenter;
  const yt = out.slice(out.indexOf('data-platform="youtube"'), out.indexOf('data-platform="instagram"'));
  const ig = out.slice(out.indexOf('data-platform="instagram"'), out.indexOf(`>${c.flow.visibilityHeading}<`));

  for (const [section, labels] of [
    [yt, [c.titleLabel, c.descriptionLabel, c.tagsLabel, c.hashtagsLabel]],
    [ig, [c.igHookLabel, c.igCaptionLabel, c.igHashtagsLabel]],
  ] as const) {
    for (const label of labels) assert.ok(section.includes(`>${label}</label>`), `${label}`);
    assert.equal((section.match(/<textarea|<input id=[^>]*type="text"/g) ?? []).length, labels.length, "one editable control per field");
    assert.equal((section.match(/aria-label="Rewrite /g) ?? []).length, labels.length, "a Rewrite beside each");
    assert.equal((section.match(/>Rewrite<\/span>/g) ?? []).length, labels.length);
    assert.equal((section.match(/>Copy<\/span>/g) ?? []).length, labels.length, "a Copy beside each");
    assert.equal((section.match(/aria-label="Save /g) ?? []).length, labels.length, "and Save is still there");
  }
  // The same words are on the buttons the screen reader hears.
  assert.ok(yt.includes('aria-label="Copy title"'));
  assert.ok(ig.includes('aria-label="Copy hook"'));
  assert.ok(ig.includes('aria-label="Copy caption"'));
  // Each block has its own Publish.
  assert.ok(yt.includes('aria-label="Publish to YouTube"'));
  assert.ok(ig.includes('aria-label="Publish to Instagram"'));
  // The fields hold the stored words.
  assert.ok(yt.includes("Productivity Isn&#x27;t Hustle"));
  assert.ok(ig.includes("Busy is not focused."));
  assert.ok(ig.includes("#deepwork #focus"));
});

test("Rewrite is the old Regenerate: relabelled, not rebuilt", async () => {
  const c = strings.publishCenter;
  assert.equal(c.regenerate, "Rewrite");
  assert.equal(c.regenerating, "Rewriting…");
  assert.doesNotMatch(c.regenerateHint + c.metadataHint + c.confirmBody("title"), /Regenerat/);
  const code = withoutComments(await read("../src/components/PublishCenter.tsx"));
  // The same route, the same overwrite confirmation, the same save route: nothing was rebuilt.
  assert.match(code, /\/publish\/regenerate`, \{ field, confirm \}/);
  assert.match(code, /needs_confirmation/);
  assert.match(code, /send\(`\/api\/episodes\/\$\{id\}\/publish`, payload, "PUT"\)/);
  assert.match(code, /onRegenerate=\{\(\) => void regenerate\(field, false\)\}/);
  assert.match(code, /onConfirm=\{\(\) => void regenerate\(field, true\)\}/);
});

test("Visibility offers YouTube's three and Instagram's one, and locks to 'public at the scheduled time' under a schedule", () => {
  const f = strings.publishCenter.flow;
  const b = strings.publishCenter.browser;
  const out = renderPage();
  const vis = out.slice(out.indexOf(`>${f.visibilityHeading}<`), out.indexOf(`>${f.scheduleHeading}<`));
  assert.ok(vis.includes(`<option value="private" selected="">${b.visibilityPrivate}</option>`), "private is the default");
  assert.ok(vis.includes(`<option value="unlisted">${b.visibilityUnlisted}</option>`));
  assert.ok(vis.includes(`<option value="public">${b.visibilityPublic}</option>`));
  assert.match(vis, /<select id="[^"]*" class="control" disabled=""[^>]*><option value="public"[^>]*>Public<\/option><\/select>/, "Instagram: public only, inert");
  assert.ok(!/Instagram[\s\S]*<option value="private"/.test(vis.slice(vis.indexOf(f.visibilityInstagram))), "no private option for Instagram");
  assert.ok(vis.includes(f.igVisibilityNote));
  assert.ok(vis.includes(b.kidsLegend), "the kids declaration is asked, with no answer chosen");
  assert.equal((vis.match(/type="radio"[^>]*checked/g) ?? []).length, 0, "no default answer");

  const locked = html(parts.VisibilityBlock, { visibility: "private", scheduled: true, kids: null, kidsFromSchedule: false, onVisibility: () => {}, onKids: () => {} });
  assert.match(locked, /<select[^>]*disabled=""[^>]*><option value="public"[^>]*>Public at the scheduled time<\/option><\/select>/);
  assert.ok(!locked.includes('value="private"'), "private is not offered under a schedule");
  assert.ok(locked.includes(f.visibilityLockedBySchedule));

  const fromSchedule = html(parts.VisibilityBlock, { visibility: "private", scheduled: true, kids: "no", kidsFromSchedule: true, onVisibility: () => {}, onKids: () => {} });
  assert.ok(fromSchedule.includes(f.kidsFromSchedule));
  assert.match(fromSchedule, /type="radio"[^>]*checked=""/);
});

test("Schedule is a date-time field with a calendar control, read as India time", () => {
  const f = strings.publishCenter.flow;
  const out = renderPage();
  const sched = out.slice(out.indexOf(`>${f.scheduleHeading}<`), out.indexOf(`>${f.actionsHeading}<`));
  assert.match(sched, /<input[^>]*type="datetime-local"/);
  assert.ok(sched.includes(`aria-label="${f.scheduleCalendar}"`), "the calendar button");
  assert.ok(sched.includes("Asia/Kolkata"), "the zone is named");
  assert.ok(sched.includes("whatever this computer&#x27;s clock says"));
  assert.ok(sched.includes(f.slotChecking), "until the Weekly Schedule has been checked, scheduling is off");
  assert.ok(html(parts.ScheduleBlock, { picked: "", lookup: lookupNone, now: NOW, onPick: () => {}, onRetryLookup: () => {} }).includes(f.scheduleOptional));

  // Locked to an activated Weekly Schedule slot: prefilled with the slot's own wall clock, disabled, and said so.
  const slot = slotAt(TOMORROW_9);
  const locked = html(parts.ScheduleBlock, { picked: "", lookup: { state: "ready", slot }, now: NOW, onPick: () => {}, onRetryLookup: () => {} });
  assert.match(locked, /type="datetime-local"[^>]*value="2026-10-18T09:00"/);
  assert.match(locked, /type="datetime-local"[^>]*disabled=""|disabled=""[^>]*type="datetime-local"/);
  assert.ok(locked.includes("From your Weekly Schedule: Sun 18 Oct 2026, 09:00 IST"), "from your Weekly Schedule");
  assert.ok(!locked.includes(">Clear<"), "nothing to clear: the time is not the operator's to change here");
  assert.ok(locked.includes(f.scheduleYouTubeOnly));

  // Free: a picked time shows the exact moment it means.
  const picked = html(parts.ScheduleBlock, { picked: "2026-10-18T09:00", lookup: lookupNone, now: NOW, onPick: () => {}, onRetryLookup: () => {} });
  assert.ok(picked.includes("Goes public Sun 18 Oct 2026, 09:00 IST."));
  assert.ok(picked.includes(">Clear<"));
  assert.ok(!/type="datetime-local"[^>]*disabled/.test(picked));

  // A time inside the floor is refused where it is typed.
  const soon = html(parts.ScheduleBlock, { picked: "2026-10-17T11:35", lookup: lookupNone, now: NOW, onPick: () => {}, onRetryLookup: () => {} });
  assert.match(soon, /role="alert"[^>]*>Pick a time at least 15 minutes from now/);
  const bad = html(parts.ScheduleBlock, { picked: "2026-02-30T09:00", lookup: lookupNone, now: NOW, onPick: () => {}, onRetryLookup: () => {} });
  assert.match(bad, /role="alert"[^>]*>That is not a valid date and time/);
});

test("while the Weekly Schedule is being checked, or the check failed, scheduling is OFF rather than guessed", () => {
  const f = strings.publishCenter.flow;
  const off = (lookup: SlotLookup) => html(parts.ScheduleBlock, { picked: "", lookup, now: NOW, onPick: () => {}, onRetryLookup: () => {} });
  const loading = off({ state: "loading" });
  assert.ok(loading.includes(f.slotChecking));
  assert.match(loading, /type="datetime-local"[^>]*disabled=""|disabled=""[^>]*type="datetime-local"/);
  const failed = off({ state: "error" });
  assert.ok(failed.includes(f.slotCheckFailed));
  assert.ok(failed.includes(f.slotRetry), "and a way to ask again");
  assert.match(failed, /type="datetime-local"[^>]*disabled=""|disabled=""[^>]*type="datetime-local"/);
  assert.ok(!off(lookupNone).includes(f.slotChecking));
});

test("the three publish buttons are Instagram, YouTube, and Instagram & YouTube", () => {
  const f = strings.publishCenter.flow;
  const out = renderPage();
  const bottom = out.slice(out.indexOf(`>${f.actionsHeading}<`));
  const labels = [...bottom.matchAll(/<button type="button" class="pub-primary"[^>]*aria-label="([^"]+)"[^>]*><span class="truncate">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(labels, [
    ["Publish to Instagram", "Instagram"],
    ["Publish to YouTube", "YouTube"],
    ["Publish to Instagram and YouTube", "Instagram &amp; YouTube"],
  ]);
  // Nothing pre-confirmed: no confirmation is open on first render.
  assert.ok(!out.includes('role="alertdialog"'));
  // Each platform's own standing is beside them, from the job rows.
  assert.ok(bottom.includes('class="pub-strip"'));
  assert.equal((bottom.match(/Not posted yet/g) ?? []).length, 2);
});

test("YouTube's Publish is inert until the kids question is answered, with the reason beside it; Instagram's needs no answer", () => {
  const out = renderPage();
  const yt = out.slice(out.indexOf('data-platform="youtube"'), out.indexOf('data-platform="instagram"'));
  const ig = out.slice(out.indexOf('data-platform="instagram"'), out.indexOf(`>${strings.publishCenter.flow.visibilityHeading}<`));
  assert.match(yt, /class="pub-primary" aria-disabled="true" aria-label="Publish to YouTube"/);
  assert.ok(yt.includes("Say whether this video is made for kids"), "the reason is a sentence beside the button");
  assert.match(yt, /aria-describedby="[^"]*-why"/, "and the button points at it");
  assert.doesNotMatch(ig, /class="pub-primary" aria-disabled/, "Instagram has no such question");
  assert.match(ig, /class="pub-primary" aria-label="Publish to Instagram"/);

  // A finished, connected-nowhere episode that is not the viewer's: nothing can be pressed.
  const notMine = renderPage(viewOf({ owned: false }));
  assert.equal((notMine.match(/class="pub-primary" aria-disabled="true"/g) ?? []).length, 5, "all five Publish buttons are inert");
  assert.ok(notMine.includes("does not belong to this account"));
});

test("the Connection and Browser Window SECTIONS are not in the page, but nothing was deleted from the app", async () => {
  const out = renderPage(
    viewOf({
      platforms: [
        ps("youtube", { configured: true, capabilities: caps("youtube", true), browser: { available: true, reason: null, canSchedule: true, headless: false, channel: "chrome" } }),
        ps("instagram", { configured: true, capabilities: caps("instagram", true) }),
      ],
    }),
  );
  for (const gone of [
    connectCopy.heading, // "Connection"
    connectCopy.connect,
    connectCopy.disconnect,
    connectCopy.grantedLabel,
    "Instagram API",
    instagramCopy.connect,
    strings.publishCenter.browser.eyebrow, // "Browser window"
    strings.publishCenter.browser.optional,
    strings.publishCenter.browser.publish, // "Publish via browser window"
    strings.publishCenter.browser.recommend,
    "/api/publish/youtube/connect",
    "/api/publish/instagram/connect",
  ]) {
    assert.ok(!out.includes(gone), `"${gone}" is still laid out on the page`);
  }
  // No sign-in as a standing section either: it appears on a result that needs it, and nowhere else.
  assert.ok(!out.includes("Sign in to YouTube"));

  // The modules and routes are all still there.
  const root = here("..");
  for (const kept of [
    "src/components/YouTubePublish.tsx",
    "src/components/InstagramPublish.tsx",
    "src/components/BrowserPublish.tsx",
    "src/app/api/publish/youtube/route.ts",
    "src/app/api/publish/youtube/connect/route.ts",
    "src/app/api/publish/youtube/callback/route.ts",
    "src/app/api/publish/instagram/route.ts",
    "src/app/api/publish/browser/signin/route.ts",
    "src/app/api/episodes/[id]/publish/browser/route.ts",
    "src/app/api/episodes/[id]/publish/youtube/route.ts",
    "src/app/api/episodes/[id]/publish/instagram/route.ts",
    "src/lib/publish/browser/engine.ts",
    "src/lib/publish/browser/run.ts",
    "src/lib/publish/browser/signin.ts",
  ]) {
    await fs.access(path.join(root, kept));
  }
});

test("everything else on the page is still there: the cover picker, the hand-off and the four copy blocks, folded", () => {
  const f = strings.publishCenter.flow;
  const c = strings.publishCenter;
  const out = renderPage(
    viewOf({
      platforms: [
        ps("youtube", { handoff: [{ kind: "download", label: "Download video", href: "/api/episodes/e1/video" }, { kind: "copy", label: "Copy title", text: "T" }] }),
        ps("instagram", { handoff: [{ kind: "copy", label: "Copy caption", text: "C" }] }),
      ],
    }),
  );
  assert.ok(out.includes(`<summary>${f.chooseThumbnail}</summary>`), "the per-platform cover picker, folded");
  assert.ok(out.includes(c.thumbUseYouTube) && out.includes(c.thumbUseInstagram));
  assert.ok(out.includes(`<summary>${f.handoffSummary}</summary>`), "the by-hand hand-off, folded");
  assert.ok(out.includes(c.handoffHeading) && out.includes(c.recordHandoff), "and it can still record a hand-over");
  assert.ok(out.includes(`<summary>${strings.publish.heading}</summary>`), "the old four copy blocks, folded");
  for (const label of [strings.publish.youtubeTitle, strings.publish.hashtags, strings.publish.youtubeDescription, strings.publish.instagram]) {
    assert.ok(out.includes(label), label);
  }
  assert.ok(out.includes(instagramCaption(META).split("\n")[0]), "the composed caption is unchanged");
  // Not ready: the list says what is missing.
  const notReady = renderPage(viewOf({ readiness: { ready: false, issues: [{ code: "no_video", message: "There is no rendered video." }] } }));
  assert.ok(notReady.includes("There is no rendered video."));
  assert.ok(notReady.includes(c.notReady));
  assert.ok(!out.includes('class="pub-missing"'), "a ready episode lists nothing missing");
});

test("the first render, before the state has loaded, still claims nothing and still shows the copy blocks", () => {
  const out = renderPage(null);
  assert.ok(out.includes("Publish – Productivity Isn&#x27;t Hustle"), "the header does not wait for the fetch");
  for (const lie of [/Published/, /Uploading/, /Posted/i, /\bLive\b/, /Scheduled/]) assert.doesNotMatch(out, lie, String(lie));
  assert.ok(out.includes(strings.publish.youtubeTitle));
  assert.ok(!out.includes("pub-media"), "no half-built layout");
});

// ====================================================================== results and confirmation, rendered

test("a result renders the job's own status: posted, scheduled in India time, in progress, or needing you", () => {
  const report = (state: PlatformState, extra: Record<string, unknown> = {}) =>
    html(parts.PlatformReport, { state, sent: null, looked: false, onLooked: () => {}, ...extra });

  const posted = report(ps("instagram", { status: "PUBLISHED", job: jobOf({ status: "PUBLISHED", externalId: "REEL1", externalUrl: "https://www.instagram.com/reel/REEL1/", publishedAt: new Date(NOW).toISOString() }) }));
  assert.ok(posted.includes("Posted on Instagram"));
  assert.ok(posted.includes('href="https://www.instagram.com/reel/REEL1/"'));
  assert.match(posted, /data-confirmed="true"/);

  const scheduled = report(ps("youtube", { status: "SCHEDULED", job: jobOf({ status: "SCHEDULED", externalId: "VID1", scheduledFor: TOMORROW_9.toISOString(), reviewUrl: "https://studio.youtube.com/video/VID1/edit" }) }));
  assert.ok(scheduled.includes("Scheduled on YouTube for Sun 18 Oct 2026, 09:00 IST"));
  assert.ok(scheduled.includes("Nothing is live yet."));
  assert.ok(scheduled.includes('href="https://studio.youtube.com/video/VID1/edit"'));

  const unproven = report(ps("youtube", { status: "PUBLISHED", job: jobOf({ status: "PUBLISHED" }) }));
  assert.doesNotMatch(unproven, /Posted on/);
  assert.match(unproven, /data-confirmed="false"/);
  assert.ok(unproven.includes("not shown as posted"));

  const working = report(ps("youtube", { status: "PREPARING", job: jobOf({ status: "PREPARING" }) }));
  assert.ok(working.includes("YouTube: working on it"));
  assert.doesNotMatch(working, /Posted|Scheduled on/);

  assert.equal(report(ps("youtube")).includes("pub-result"), false, "nothing attempted: nothing claimed");
});

test("a sign-in stop shows the engine's sentence, the 'I looked' tick, and Sign in to YouTube -- inline, on the result", () => {
  const state = ps("youtube", {
    status: "AWAITING_HUMAN",
    job: jobOf({ status: "AWAITING_HUMAN", lastError: "YouTube is asking you to sign in. Nothing was published." }),
    browser: { available: true, reason: null, canSchedule: true, headless: false, channel: "chrome" },
  });
  const out = html(parts.PlatformReport, { state, sent: null, looked: false, onLooked: () => {} });
  assert.ok(out.includes("YouTube: needs you"));
  assert.ok(out.includes("YouTube is asking you to sign in. Nothing was published."), "verbatim");
  assert.ok(out.includes(strings.publishCenter.browser.ackLabel));
  assert.match(out, /type="checkbox"(?![^>]*checked)/);
  assert.ok(out.includes("Sign in to YouTube"));
  assert.match(out, /role="alert"/);
  assert.doesNotMatch(out, /Posted|Scheduled on/);
  assert.ok(html(parts.PlatformReport, { state, sent: null, looked: true, onLooked: () => {} }).match(/type="checkbox"[^>]*checked=""/), "ticked");

  // No password field exists anywhere near it, and the sign-in button sends the platform name and nothing else.
  assert.doesNotMatch(out, /type="password"|autocomplete|name="(password|email|username)"/i);
});

test("a refusal the server sent is shown where the button is, in words", () => {
  const state = ps("youtube");
  const refused = html(parts.PlatformReport, {
    state,
    sent: { tone: "error", text: "A public or scheduled post goes live on the channel without a review step. Nothing was sent." },
    looked: false,
    onLooked: () => {},
  });
  assert.match(refused, /role="alert"/);
  assert.ok(refused.includes("Nothing was sent."));
});

test("the confirmation says exactly what OK does, and anything that goes live is drawn as a warning", () => {
  const confirm = (plans: ReturnType<typeof planTarget>[], busy = false) =>
    html(parts.ConfirmPanel, { plans, busy, onOk: () => {}, onCancel: () => {} });

  const priv = confirm([planTarget(ps("youtube"), ctx())]);
  assert.match(priv, /role="alertdialog" aria-label="Publish to YouTube\?"/);
  assert.ok(priv.includes("PRIVATE video"));
  assert.ok(priv.includes("Sent through a browser window"));
  assert.ok(priv.includes('class="pub-confirm-box"'), "private is a quiet confirmation");
  assert.ok(priv.includes(">OK<") && priv.includes(">Cancel<"));

  const live = confirm([planTarget(ps("youtube"), ctx({ visibility: "public" }))]);
  assert.ok(live.includes('class="pub-problems"'), "public is the warning style");
  assert.ok(live.includes("PUBLICLY, right now"));

  const both = confirm(
    planTargets([ps("youtube"), ps("instagram")], TARGETS_OF.both, () => ctx({ schedule: { kind: "picked", instant: TOMORROW_9 } })),
  );
  assert.ok(both.includes("Publish to Instagram and YouTube?"));
  assert.ok(both.includes("Schedules it on YouTube to go PUBLIC at Sun 18 Oct 2026, 09:00 IST"));
  assert.ok(both.includes("quick-publish action shares Instagram now"), "Instagram will not be scheduled, and the confirmation says so");
  assert.ok(both.indexOf("Instagram.") < both.indexOf("YouTube."), "Instagram, then YouTube, as the button reads");

  const api = confirm([planTarget(ps("youtube", { configured: true, capabilities: caps("youtube", true) }), ctx())]);
  assert.ok(api.includes("Sent through the official YouTube API."));

  const skipped = confirm([
    planTarget(ps("instagram"), ctx()),
    planTarget(ps("youtube", { status: "PUBLISHED", job: jobOf({ status: "PUBLISHED", externalId: "V", publishedAt: new Date(NOW).toISOString() }) }), ctx()),
  ]);
  assert.ok(skipped.includes("Not sent: Already posted on YouTube. Nothing was sent."));
  assert.ok(confirm([planTarget(ps("youtube"), ctx())], true).includes("Publishing…"));
});

test("PublishFlow is wired to confirm first, send only from OK, in order, and never to retry by itself", async () => {
  const code = withoutComments(await read("../src/components/PublishFlow.tsx"));
  // Every trigger only asks.
  assert.equal([...code.matchAll(/onPress=\{\(\) => ask\(/g)].length, 2, "the block's button (both platforms) and the bottom row all go through ask()");
  assert.match(code, /onPress=\{\(\) => ask\(platform, \[platform\]\)\}/);
  assert.match(code, /onPress=\{\(\) => ask\("bottom", targets\)\}/);
  assert.equal([...code.matchAll(/await fetch\(request\.url, request\.init\)/g)].length, 1, "one place sends");
  assert.equal([...code.matchAll(/void send\(\)/g)].length >= 2, true, "and only OK calls it");
  // The decision is re-made at the moment of OK.
  assert.match(code, /const plans = plansFor\(confirm\.targets, at\)/);
  assert.match(code, /if \(!canAsk\(plans\)\)/);
  // Sequential, in the order the plans list them.
  assert.match(code, /for \(const plan of toSend\)/);
  // Nothing retries on its own, and nothing is read from a returned view to invent a success.
  assert.doesNotMatch(code, /setTimeout|requestAnimationFrame/, "no auto-retry");
  assert.doesNotMatch(code, /status:\s*"(PUBLISHED|SCHEDULED)"/, "the page never writes a status");
  // Single flight: two presses of OK inside one frame cannot both send.
  assert.match(code, /if \(!confirm \|\| busy \|\| inFlight\.current\) return;/);
  assert.match(code, /inFlight\.current = true;/);
  assert.match(code, /\} finally \{[\s\S]*inFlight\.current = false;[\s\S]*setSending\(\[\]\);[\s\S]*setConfirm\(null\);/, "however it ends, the buttons come back");
  // The Weekly Schedule lookup is read-only, and the sign-in call sends the platform name and nothing else.
  assert.match(code, /\/api\/schedules\?episodeId=/);
  assert.match(code, /fetch\("\/api\/publish\/browser\/signin",\s*\{\s*method: "POST",[\s\S]*?body: JSON\.stringify\(\{ platform \}\),/);
  assert.doesNotMatch(code, /type=["']password/);
  // A choice that changes closes an open confirmation, so OK always answers what is on screen.
  assert.match(code, /setConfirm\(null\);\s*setVisibility\(next\)/);
  assert.match(code, /setConfirm\(null\);\s*setPicked\(next\)/);
  assert.match(code, /setConfirm\(null\);\s*setKids\(next\)/);
});

test("a poll refresh no longer throws away what is being typed, and one dropped refresh keeps the page", async () => {
  const code = withoutComments(await read("../src/components/PublishCenter.tsx"));
  // The drafts are cleared the first time an episode loads, not on every read while a publish is polled.
  assert.match(code, /if \(startedFor\.current !== id\) \{\s*startedFor\.current = id;\s*setDrafts\(\{\}\);\s*setConfirming\(null\);\s*\}/);
  assert.equal([...code.matchAll(/setDrafts\(\{\}\)/g)].length, 1);
  // A failed refresh while the page is up keeps the view (and with it the choices and the open confirmation).
  assert.match(code, /prev\.id === id && prev\.view \? \{ \.\.\.prev, error: message \}/);
  // And it polls while a platform is in flight -- the browser route's PREPARING/UPLOADING included.
  assert.match(code, /p\.status === "PREPARING" \|\| p\.status === "UPLOADING"/);
});

// ====================================================================== the Weekly Schedule lookup (database)

interface Seed {
  ownerId: string;
  strangerId: string;
  uploadId: string;
  episodes: string[];
  cleanup: () => Promise<void>;
}

const seeds: Seed[] = [];
after(async () => {
  for (const s of seeds) await s.cleanup();
});

async function seed(count = 3): Promise<Seed> {
  requireIsolation("these tests create episodes and write renders and posters");
  const owner = await prisma.user.create({ data: { email: `pp-own-${randomUUID()}@example.test` } });
  const stranger = await prisma.user.create({ data: { email: `pp-str-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({
    data: { title: `PP ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id, userId: owner.id, kind: "pdf", status: "DONE" } });

  const make = async (n: number): Promise<string> => {
    const episode = await prisma.episode.create({
      data: {
        bookId: book.id,
        uploadId: upload.id,
        userId: owner.id,
        status: "DONE",
        theme: "marginalia",
        title: `Video ${n}`,
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
    await fs.writeFile(renderFile, Buffer.alloc(9000, 7 + n));
    await prisma.episode.update({ where: { id: episode.id }, data: { thumbnails: serializeThumbnails(specs), videoPath: renderFile } });
    return episode.id;
  };

  const episodes: string[] = [];
  for (let i = 0; i < count; i++) episodes.push(await make(i + 1));

  return {
    ownerId: owner.id,
    strangerId: stranger.id,
    uploadId: upload.id,
    episodes,
    cleanup: async () => {
      for (const id of episodes) {
        await fs.rm(thumbsDir(id), { recursive: true, force: true });
        await fs.rm(path.join(RENDER_DIR, `${id}.mp4`), { force: true });
      }
      const schedules = await prisma.weeklySchedule.findMany({ where: { uploadId: upload.id }, select: { id: true } });
      await prisma.scheduleSlot.deleteMany({ where: { scheduleId: { in: schedules.map((x) => x.id) } } });
      await prisma.weeklySchedule.deleteMany({ where: { uploadId: upload.id } });
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
    },
  };
}

async function makeSchedule(
  s: Seed,
  over: { userId?: string | null; status?: string; createdAt?: Date; madeForKids?: boolean | null; timezone?: string },
  slots: Array<{ episodeId: string; assignedAt: Date; status?: string; note?: string | null }>,
) {
  const row = await prisma.weeklySchedule.create({
    data: {
      userId: over.userId === undefined ? s.ownerId : over.userId,
      uploadId: s.uploadId,
      weekStart: new Date("2026-10-19T00:00:00.000Z"),
      days: 3,
      timeSlots: JSON.stringify(["09:00"]),
      timezone: over.timezone ?? "Asia/Kolkata",
      madeForKids: over.madeForKids === undefined ? false : over.madeForKids,
      status: over.status ?? "active",
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
  let position = 0;
  for (const slot of slots) {
    await prisma.scheduleSlot.create({
      data: { scheduleId: row.id, episodeId: slot.episodeId, assignedAt: slot.assignedAt, position: position++, status: slot.status ?? "pending", note: slot.note ?? null },
    });
  }
  return row;
}

test("the slot lookup answers the exact assignedAt of the newest ACTIVATED schedule of this account, and nothing else", async () => {
  const s = await seed();
  seeds.push(s);
  const [a, b, c] = s.episodes;
  const at = zonedInstant("2026-10-19", "09:00");

  assert.deepEqual(await episodeSlotView(s.ownerId, a), { slot: null }, "in no schedule");

  // A DRAFT decides nothing: nothing has been confirmed for it.
  await makeSchedule(s, { status: "draft" }, [{ episodeId: a, assignedAt: at }]);
  assert.deepEqual(await episodeSlotView(s.ownerId, a), { slot: null });

  // An activated one does -- with the exact instant, the zone, the kids answer and the slot's status.
  const active = await makeSchedule(s, { madeForKids: true }, [
    { episodeId: a, assignedAt: at, status: "pending" },
    { episodeId: b, assignedAt: zonedInstant("2026-10-20", "09:00"), status: "scheduled", note: "YouTube confirmed it." },
  ]);
  const got = await episodeSlotView(s.ownerId, a);
  assert.ok(got.slot);
  assert.equal(got.slot.assignedAt, at.toISOString(), "the exact instant, as an ISO string the page sends untouched");
  assert.equal(got.slot.assignedAt, "2026-10-19T03:30:00.000Z");
  assert.equal(got.slot.scheduleId, active.id);
  assert.equal(got.slot.timezone, "Asia/Kolkata");
  assert.equal(got.slot.madeForKids, true);
  assert.equal(got.slot.status, "pending");
  assert.equal((await episodeSlotView(s.ownerId, b)).slot?.status, "scheduled");
  assert.deepEqual(await episodeSlotView(s.ownerId, c), { slot: null }, "a video not in the schedule");

  // Another account's schedule is not theirs to see.
  assert.deepEqual(await episodeSlotView(s.strangerId, a), { slot: null });

  // The newest activated schedule wins.
  const newer = await makeSchedule(s, { createdAt: new Date(Date.now() + 60_000) }, [{ episodeId: a, assignedAt: zonedInstant("2026-10-22", "18:00") }]);
  const winner = await episodeSlotView(s.ownerId, a);
  assert.equal(winner.slot?.scheduleId, newer.id);
  assert.equal(winner.slot?.assignedAt, zonedInstant("2026-10-22", "18:00").toISOString());
});

test("the lookup route is read-only, authenticated, and answers { slot } for ?episodeId=", async () => {
  const code = withoutComments(await read("../src/app/api/schedules/route.ts"));
  assert.match(code, /requireUser\(\)/);
  assert.match(code, /params\.get\("episodeId"\)/);
  assert.match(code, /episodeSlotView\(user\.id, episodeId\)/);
  assert.match(code, /params\.get\("uploadId"\)/, "the book lookup is unchanged");
  const get = code.slice(code.indexOf("export async function GET"), code.indexOf("export async function POST"));
  assert.doesNotMatch(get, /startBrowserPublish|prisma|saveDraft|activateSchedule/, "the GET only reads");
});

// ====================================================================== the page's request, through the real engine (mocked publishers)

/**
 * The browser route's own body parsing, copied from `app/api/episodes/[id]/publish/browser/route.ts`
 * (a handler cannot run here: its other job is `currentUser()`, which reads cookies). The test below
 * pins the route to these exact lines, so this cannot drift from the route without failing.
 */
function routeOptions(body: Record<string, unknown>): StartBrowserOptions {
  const asked = body.visibility;
  const visibility = asked === "private" || asked === "unlisted" || asked === "public" ? asked : undefined;
  const scheduledAt = typeof body.scheduledAt === "string" && body.scheduledAt.trim() !== "" ? new Date(body.scheduledAt) : null;
  return {
    confirmPublic: body.confirmPublic === true,
    acknowledgeRetry: body.acknowledgeRetry === true,
    madeForKids: typeof body.madeForKids === "boolean" ? body.madeForKids : undefined,
    visibility,
    scheduledAt,
  };
}

test("the route still parses the body exactly as the page's request assumes", async () => {
  const code = withoutComments(await read("../src/app/api/episodes/[id]/publish/browser/route.ts"));
  for (const line of [
    'asked === "private" || asked === "unlisted" || asked === "public" ? asked : undefined',
    'typeof body.scheduledAt === "string" && body.scheduledAt.trim() !== "" ? new Date(body.scheduledAt) : null',
    "confirmPublic: body.confirmPublic === true",
    "acknowledgeRetry: body.acknowledgeRetry === true",
    'madeForKids: typeof body.madeForKids === "boolean" ? body.madeForKids : undefined',
  ]) {
    assert.ok(code.includes(line), `the route no longer reads: ${line}`);
  }
});

/** A real browser publisher whose `publish` is replaced by a script. */
function scripted(platform: PlatformId, publish: (p: PreparedPublish) => Promise<PublishOutcome>): BrowserPublisher {
  const real = browserPublisherFor(platform, { browser: { deps: { locate: () => "C:/chrome.exe" } } }) as BrowserPublisher;
  return { ...real, publish: async (p) => publish(p) };
}

const confirmedPost = (id: string): PublishOutcome => ({
  status: "PUBLISHED",
  externalId: id,
  externalUrl: `https://example.test/${id}`,
  confirmedAt: new Date(),
  visibility: "public",
});
const confirmedSchedule = (id: string, when: Date | null | undefined): PublishOutcome =>
  ({ ...confirmedPost(id), visibility: "scheduled", scheduledFor: when }) as PublishOutcome;

interface Call {
  platform: PlatformId;
  episodeId: string;
  options: BrowserPublishOptions;
}

function recorder(answer: (call: Call) => PublishOutcome) {
  const calls: Call[] = [];
  const makePublisher = (platform: PlatformId, options: BrowserPublishOptions): BrowserPublisher =>
    scripted(platform, async (p) => {
      const call = { platform, episodeId: p.episodeId, options };
      calls.push(call);
      return answer(call);
    });
  return { calls, makePublisher: makePublisher as never };
}

/** The view the page loads: the real `publishView`, with the browser route available and no environment. */
const loadView = (userId: string, episodeId: string): Promise<PublishView> =>
  publishView(userId, episodeId, { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, browser: { deps: { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, locate: () => "C:/chrome.exe" } } });

async function until<T>(read: () => Promise<T | null | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const platformOf = (view: PublishView, platform: PlatformId): PlatformState => view.platforms.find((p) => p.platform === platform)!;

/** What the page does for one platform: plan it from the loaded view, then send the plan's body through the engine. */
async function press(
  view: PublishView,
  userId: string,
  episodeId: string,
  platform: PlatformId,
  choices: Partial<PlanContext>,
  makePublisher: never,
) {
  const plan = planTarget(platformOf(view, platform), { ...ctx({ owned: view.owned }), ...choices });
  assert.equal(plan.kind, "send", plan.note ?? "");
  assert.equal(plan.route, "browser", "this suite has no connected API account");
  const sent = await startBrowserPublish(userId, episodeId, platform, {
    ...routeOptions(plan.body ?? {}),
    makePublisher,
    waitForCompletion: true,
    env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" },
  });
  return { plan, after: sent };
}

test("a private YouTube press is recorded only by the engine, and the page reports the job: PUBLISHED needs the platform's id and time", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const { calls, makePublisher } = recorder(() => confirmedPost("VID_PRIVATE"));

  const view = await loadView(s.ownerId, ep);
  assert.equal(view.owned, true);
  assert.equal(platformOf(view, "youtube").browser?.available, true);
  assert.equal(sectionStatus(platformOf(view, "youtube").status).label, "Not posted yet");

  const { plan, after } = await press(view, s.ownerId, ep, "youtube", { visibility: "private", kids: false }, makePublisher);
  assert.equal(plan.body?.confirmPublic, false, "a private upload carries no go-live confirmation");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.visibility, "private");
  assert.equal(calls[0].options.confirmPublic, false);
  assert.equal(calls[0].options.madeForKids, false);
  assert.equal(calls[0].options.scheduledAt, null);

  const yt = platformOf(after, "youtube");
  assert.equal(yt.status, "PUBLISHED");
  const report = reportFor(yt);
  assert.equal(report?.confirmed, true, "the job carries the platform's id and time");
  assert.equal(report?.headline, "Posted on YouTube");
  assert.match(report?.detail ?? "", /id VID_PRIVATE/);
  // The other platform was never touched.
  assert.equal(platformOf(after, "instagram").job, null);
  assert.equal(await prisma.publishJob.count({ where: { episodeId: ep } }), 1);
});

test("a SCHEDULED YouTube press asks Studio for the exact instant, and is SCHEDULED only because the engine read it back", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const when = new Date(Date.now() + 26 * 3600_000);
  when.setUTCSeconds(0, 0);
  const picked = localInputFor(when);
  const choice = resolveSchedule({ picked, lookup: lookupNone });
  assert.equal(choice.kind, "picked");
  assert.equal(choice.kind === "picked" ? choice.instant.getTime() : 0, when.getTime(), "India wall clock round-trips to the exact instant");

  const { calls, makePublisher } = recorder((call) => confirmedSchedule("VID_SCHED", call.options.scheduledAt));
  const view = await loadView(s.ownerId, ep);
  const { plan, after } = await press(view, s.ownerId, ep, "youtube", { schedule: choice, kids: false, now: Date.now() }, makePublisher);

  assert.equal(plan.goesLive, true);
  assert.equal(plan.body?.confirmPublic, true);
  assert.equal(calls[0].options.confirmPublic, true);
  assert.equal(calls[0].options.scheduledAt?.getTime(), when.getTime(), "the instant Studio is asked for is the one that was picked");

  const yt = platformOf(after, "youtube");
  assert.equal(yt.status, "SCHEDULED");
  assert.equal(yt.job?.publishedAt, null, "nothing is live yet");
  assert.equal(new Date(yt.job?.scheduledFor ?? "").getTime(), when.getTime());
  const report = reportFor(yt);
  assert.equal(report?.confirmed, true);
  assert.equal(report?.headline, `Scheduled on YouTube for ${whenText(when)}`);
});

test("a public press WITHOUT the confirmation is refused by the engine; the page's own plan carries it, so no public post is silent", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const { calls, makePublisher } = recorder(() => confirmedPost("NEVER"));
  const view = await loadView(s.ownerId, ep);

  const plan = planTarget(platformOf(view, "youtube"), ctx({ visibility: "public" }));
  assert.equal(plan.body?.confirmPublic, true);

  // The same body with the confirmation taken out: the server refuses before any row or window.
  const stripped = { ...plan.body, confirmPublic: false };
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "youtube", { ...routeOptions(stripped), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } }),
    (err: unknown) => isAppError(err) && err.code === "needs_confirmation" && err.status === 409,
  );
  assert.equal(calls.length, 0, "nothing was published");
  assert.equal(await prisma.publishJob.count({ where: { episodeId: ep } }), 0, "no row left behind");

  // And Instagram, which is always public, refuses the same way without it.
  const ig = planTarget(platformOf(view, "instagram"), ctx());
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "instagram", { ...routeOptions({ ...ig.body, confirmPublic: false }), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } }),
    (err: unknown) => isAppError(err) && err.code === "needs_confirmation",
  );
  assert.equal(calls.length, 0);

  // With it, the plan goes through.
  const sent = await startBrowserPublish(s.ownerId, ep, "youtube", { ...routeOptions(plan.body ?? {}), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } });
  assert.equal(platformOf(sent, "youtube").status, "PUBLISHED");
  assert.equal(calls.length, 1);
});

test("an unconfirmed press is AWAITING_HUMAN, never a fake success; Sign in is on that result; a ticked retry then goes through", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  let attempts = 0;
  const { calls, makePublisher } = recorder(() =>
    ++attempts === 1
      ? { status: "AWAITING_HUMAN", error: "YouTube is asking you to sign in. Nothing was published." }
      : confirmedPost("VID_RETRY"),
  );

  const view = await loadView(s.ownerId, ep);
  const first = await press(view, s.ownerId, ep, "youtube", { visibility: "private", kids: false }, makePublisher);
  const stopped = platformOf(first.after, "youtube");
  assert.equal(stopped.status, "AWAITING_HUMAN");
  const report = reportFor(stopped);
  assert.equal(report?.confirmed, false);
  assert.equal(report?.needsHuman, true);
  assert.equal(report?.detail, "YouTube is asking you to sign in. Nothing was published.");
  assert.doesNotMatch(report?.headline ?? "", /Posted|Scheduled/);
  assert.equal(stopped.job?.publishedAt, null);
  assert.equal(stopped.job?.externalId, null);

  // The inline affordance appears in channel mode only.
  assert.equal(offersSignIn(stopped), false, "no installed-Chrome profile configured here: the route would refuse");
  assert.equal(offersSignIn({ ...stopped, browser: { ...stopped.browser!, channel: "chrome" } }), true);

  // Retry: blocked until the operator says they looked; the server refuses the same.
  const ctxNow = ctx({ owned: first.after.owned });
  assert.equal(planTarget(stopped, ctxNow).kind, "blocked");
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "youtube", { ...routeOptions({ platform: "youtube", visibility: "private", madeForKids: false, confirmPublic: false, acknowledgeRetry: false }), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } }),
    (err: unknown) => isAppError(err) && err.code === "needs_acknowledgement",
  );
  const retryPlan = planTarget(stopped, { ...ctxNow, looked: true });
  assert.equal(retryPlan.kind, "send");
  assert.equal(retryPlan.body?.acknowledgeRetry, true);
  const retried = await startBrowserPublish(s.ownerId, ep, "youtube", { ...routeOptions(retryPlan.body ?? {}), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } });
  assert.equal(platformOf(retried, "youtube").status, "PUBLISHED");
  assert.equal(calls.length, 2, "one stopped attempt and one acknowledged retry");
});

test("the engine records a 'success' with no platform id as AWAITING_HUMAN, and the page does not say posted", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const noId = { status: "PUBLISHED", externalId: "", externalUrl: null, confirmedAt: new Date() } as unknown as PublishOutcome;
  const { makePublisher } = recorder(() => noId);
  const view = await loadView(s.ownerId, ep);
  const { after } = await press(view, s.ownerId, ep, "instagram", {}, makePublisher);
  const ig = platformOf(after, "instagram");
  assert.equal(ig.status, "AWAITING_HUMAN");
  assert.doesNotMatch(reportFor(ig)?.headline ?? "", /Posted/);
  assert.equal(reportFor(ig)?.confirmed, false);
});

test("NO DUPLICATE: once posted or scheduled, the page plans nothing, and a forced second request starts no second job", async () => {
  const s = await seed(2);
  seeds.push(s);
  const [a, b] = s.episodes;
  const { calls, makePublisher } = recorder((call) => (call.platform === "instagram" ? confirmedPost("REEL") : confirmedSchedule("VID", call.options.scheduledAt)));

  // Episode a: posted on Instagram, scheduled on YouTube.
  const when = new Date(Date.now() + 30 * 3600_000);
  when.setUTCSeconds(0, 0);
  const schedule = resolveSchedule({ picked: localInputFor(when), lookup: lookupNone });
  const view = await loadView(s.ownerId, a);
  await press(view, s.ownerId, a, "instagram", {}, makePublisher);
  await press(await loadView(s.ownerId, a), s.ownerId, a, "youtube", { schedule, kids: false, now: Date.now() }, makePublisher);
  assert.equal(calls.length, 2);

  const settled = await loadView(s.ownerId, a);
  assert.equal(platformOf(settled, "instagram").status, "PUBLISHED");
  assert.equal(platformOf(settled, "youtube").status, "SCHEDULED");

  // The page now plans NOTHING to send, for either button.
  const plans = planTargets(settled.platforms, TARGETS_OF.both, () => ctx({ owned: settled.owned, schedule, now: Date.now() }));
  assert.deepEqual(plans.map((p) => p.kind), ["done", "done"]);
  assert.equal(canAsk(plans), false);
  for (const plan of plans) assert.equal(requestFor(a, plan), null);

  // Forced anyway (a second tab, a stale page): the engine returns the standing state and starts nothing.
  const forced = await startBrowserPublish(s.ownerId, a, "youtube", { ...routeOptions({ platform: "youtube", visibility: "public", scheduledAt: when.toISOString(), madeForKids: false, confirmPublic: true }), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } });
  assert.equal(platformOf(forced, "youtube").status, "SCHEDULED");
  const forcedIg = await startBrowserPublish(s.ownerId, a, "instagram", { confirmPublic: true, makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } });
  assert.equal(platformOf(forcedIg, "instagram").status, "PUBLISHED");
  assert.equal(calls.length, 2, "no third upload");
  assert.equal(await prisma.publishJob.count({ where: { episodeId: a } }), 2, "one job per platform, by the unique key");
  assert.equal(await prisma.publishJob.count({ where: { episodeId: b } }), 0, "the other episode is untouched");
});

test("two presses in the same instant claim one job: the second is told one is running", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, makePublisher } = recorder(() => confirmedPost("ONE"));
  // Hold the first job open at the platform so the second arrives while it is in flight.
  const slow = ((platform: PlatformId, options: BrowserPublishOptions) =>
    scripted(platform, async (p) => {
      calls.push({ platform, episodeId: p.episodeId, options });
      await gate;
      return confirmedPost("ONE");
    })) as never;
  void makePublisher;

  const view = await loadView(s.ownerId, ep);
  const plan = planTarget(platformOf(view, "instagram"), ctx());
  const opts = { ...routeOptions(plan.body ?? {}), makePublisher: slow, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } };
  const first = startBrowserPublish(s.ownerId, ep, "instagram", { ...opts, waitForCompletion: true });
  await until(() => prisma.publishJob.findFirst({ where: { episodeId: ep, platform: "instagram" } }));
  const second = await startBrowserPublish(s.ownerId, ep, "instagram", opts);
  assert.ok(["PREPARING", "UPLOADING"].includes(platformOf(second, "instagram").status), "the second sees the first, in flight");
  release();
  await first;
  assert.equal(calls.length, 1, "one publish");
  assert.equal(await prisma.publishJob.count({ where: { episodeId: ep } }), 1);
});

test("Instagram & YouTube sends both, in order, and each platform keeps its own result", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const order: PlatformId[] = [];
  const makePublisher = ((platform: PlatformId, options: BrowserPublishOptions) =>
    scripted(platform, async () => {
      order.push(platform);
      return platform === "instagram" ? confirmedPost("REEL_BOTH") : confirmedSchedule("VID_BOTH", options.scheduledAt);
    })) as never;

  const when = new Date(Date.now() + 40 * 3600_000);
  when.setUTCSeconds(0, 0);
  const schedule = resolveSchedule({ picked: localInputFor(when), lookup: lookupNone });
  let view = await loadView(s.ownerId, ep);
  const plans = planTargets(view.platforms, TARGETS_OF.both, () => ctx({ owned: view.owned, schedule, now: Date.now() }));
  assert.deepEqual(plans.map((p) => p.platform), ["instagram", "youtube"], "Instagram, then YouTube, as the button reads");
  assert.equal(canAsk(plans), true);

  // The page's loop: one request per platform, each answered by the real engine.
  for (const plan of plans) {
    await startBrowserPublish(s.ownerId, ep, plan.platform, { ...routeOptions(plan.body ?? {}), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } });
  }
  view = await loadView(s.ownerId, ep);
  assert.deepEqual(order, ["instagram", "youtube"]);
  const ig = reportFor(platformOf(view, "instagram"));
  const yt = reportFor(platformOf(view, "youtube"));
  assert.equal(ig?.headline, "Posted on Instagram");
  assert.equal(yt?.headline, `Scheduled on YouTube for ${whenText(when)}`);
  // Instagram was never handed the schedule.
  assert.equal(plans[0].body?.scheduledAt, undefined);
  assert.equal(plans[1].body?.scheduledAt, when.toISOString());
});

test("Instagram refuses a schedule and a private post at the engine, so the page never sends either", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const { calls, makePublisher } = recorder(() => confirmedPost("NEVER"));
  for (const bad of [{ scheduledAt: TOMORROW_9.toISOString() }, { visibility: "private" }, { visibility: "unlisted" }]) {
    await assert.rejects(
      () => startBrowserPublish(s.ownerId, ep, "instagram", { ...routeOptions({ platform: "instagram", confirmPublic: true, ...bad }), makePublisher, waitForCompletion: true, env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } }),
      (err: unknown) => isAppError(err) && err.code === "bad_options",
      JSON.stringify(bad),
    );
  }
  assert.equal(calls.length, 0);
  // And what the page does send for Instagram is accepted.
  const view = await loadView(s.ownerId, ep);
  const { after } = await press(view, s.ownerId, ep, "instagram", { visibility: "private", schedule: { kind: "picked", instant: TOMORROW_9 } }, makePublisher);
  assert.equal(platformOf(after, "instagram").status, "PUBLISHED");
});

test("a video in an activated Weekly Schedule is scheduled at its slot's exact instant, through the same engine call", async () => {
  const s = await seed(2);
  seeds.push(s);
  const [ep] = s.episodes;
  const at = new Date(Date.now() + 48 * 3600_000);
  at.setUTCSeconds(0, 0);
  await makeSchedule(s, { madeForKids: false }, [{ episodeId: ep, assignedAt: at, status: "pending" }]);

  // The page reads the slot (the lookup route's own function), resolves the schedule, and plans.
  const lookup: SlotLookup = { state: "ready", slot: (await episodeSlotView(s.ownerId, ep)).slot };
  assert.ok(governingSlot(lookup));
  const choice = resolveSchedule({ picked: "2031-01-01T00:00", lookup });
  assert.equal(choice.kind, "slot", "a typed time cannot override the slot");

  const { calls, makePublisher } = recorder((call) => confirmedSchedule("VID_SLOT", call.options.scheduledAt));
  const view = await loadView(s.ownerId, ep);
  const kids = governingSlot(lookup)?.madeForKids ?? null;
  const { plan, after } = await press(view, s.ownerId, ep, "youtube", { schedule: choice, kids, now: Date.now() }, makePublisher);

  assert.equal(plan.body?.scheduledAt, at.toISOString());
  assert.equal(calls[0].options.scheduledAt?.getTime(), at.getTime(), "exactly the slot's instant reaches the publisher");
  assert.equal(platformOf(after, "youtube").status, "SCHEDULED");
  assert.equal(new Date(platformOf(after, "youtube").job?.scheduledFor ?? "").getTime(), at.getTime());

  // The Weekly Schedule's own runner then finds the video already scheduled at that very time and leaves it be.
  const job = await youtubeJob(ep);
  assert.equal(alreadyThere(job, at)?.status, "scheduled");
  assert.equal(MIN_SCHEDULE_LEAD_MS, 15 * 60_000);
});
