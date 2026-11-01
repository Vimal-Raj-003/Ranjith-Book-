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
import type { PreparedPublish, PublishOutcome } from "../src/lib/publish/contract";
import { browserPublisherFor } from "../src/lib/publish/registry";
import { MIN_SCHEDULE_LEAD_MS, type BrowserPublishOptions, type BrowserPublisher } from "../src/lib/publish/browser/engine";
import { isScheduleRunning, runSchedule } from "../src/lib/schedule/activate";
import { publishDueInstagram } from "../src/lib/schedule/due";
import { activateSchedule, saveDraft, scheduleView } from "../src/lib/schedule/store";
import {
  addDays,
  configProblem,
  expandSchedule,
  formatInZone,
  isDateYYYYMMDD,
  isTimeHHmm,
  isValidTimeZone,
  normaliseSlots,
  scheduleCapacity,
  wallClock,
  zonedInstant,
} from "../src/lib/schedule/time";
import { SCHEDULE_LEAD_MINUTES, type ScheduleView } from "../src/lib/schedule/view";
import * as panelModule from "../src/components/WeeklySchedule";
import { strings } from "../src/lib/strings";
import { requireIsolation } from "./setup/isolation";

/**
 * The Weekly Schedule, tested with a SCRIPTED publisher and never a real site.
 *
 * NOTHING IN THIS FILE OPENS A WINDOW, SIGNS IN, OR TOUCHES YOUTUBE. Activation is
 * driven through `startBrowserPublish`'s own test seam (`makePublisher`), whose
 * scripted publisher answers the way the engine does once Studio has read a time
 * back. What that proves is OUR decisions: the slot times, the validation, the
 * order, the dedupe, the stop. That a real Studio accepts the upload is not tested
 * here, and the report says so.
 */

// ------------------------------------------------------------------ time

test("zonedInstant: a wall-clock time in Asia/Kolkata is the right UTC instant, whatever zone the server is in", () => {
  assert.equal(zonedInstant("2026-10-05", "09:00").toISOString(), "2026-10-05T03:30:00.000Z");
  assert.equal(zonedInstant("2026-10-05", "09:00", "Asia/Kolkata").toISOString(), "2026-10-05T03:30:00.000Z");
  // Across the UTC date line in both directions: IST is UTC+5:30.
  assert.equal(zonedInstant("2026-10-05", "00:00").toISOString(), "2026-10-04T18:30:00.000Z");
  assert.equal(zonedInstant("2026-10-05", "23:59").toISOString(), "2026-10-05T18:29:00.000Z");
  assert.equal(zonedInstant("2026-12-31", "23:30").toISOString(), "2026-12-31T18:00:00.000Z");
});

test("zonedInstant: a zone with daylight saving is measured, not assumed", () => {
  const ny = (d: string, t: string) => zonedInstant(d, t, "America/New_York").toISOString();
  assert.equal(ny("2026-01-15", "09:00"), "2026-01-15T14:00:00.000Z", "winter, UTC-5");
  assert.equal(ny("2026-07-15", "09:00"), "2026-07-15T13:00:00.000Z", "summer, UTC-4");
  assert.equal(ny("2026-03-08", "09:00"), "2026-03-08T13:00:00.000Z", "the day clocks went forward, after the change");
  assert.equal(ny("2026-11-01", "09:00"), "2026-11-01T14:00:00.000Z", "the day clocks went back, after the change");
  assert.equal(ny("2026-11-01", "00:30"), "2026-11-01T04:30:00.000Z", "the day clocks went back, before the change");
  assert.equal(zonedInstant("2026-07-01", "12:00", "UTC").toISOString(), "2026-07-01T12:00:00.000Z");
});

test("zonedInstant refuses what is not a date, a time or a zone", () => {
  assert.throws(() => zonedInstant("2026-02-30", "09:00"), RangeError);
  assert.throws(() => zonedInstant("2026-13-01", "09:00"), RangeError);
  assert.throws(() => zonedInstant("5 Oct 2026", "09:00"), RangeError);
  assert.throws(() => zonedInstant("2026-10-05", "24:00"), RangeError);
  assert.throws(() => zonedInstant("2026-10-05", "9:00"), RangeError);
  assert.throws(() => zonedInstant("2026-10-05", "09:60"), RangeError);
  assert.throws(() => zonedInstant("2026-10-05", "09:00", "Mars/Phobos"), RangeError);
  assert.equal(isDateYYYYMMDD("2026-02-29"), false);
  assert.equal(isDateYYYYMMDD("2028-02-29"), true);
  assert.equal(isTimeHHmm("23:59"), true);
  assert.equal(isValidTimeZone("Asia/Kolkata"), true);
  assert.equal(isValidTimeZone(""), false);
});

test("wallClock reads the zone's clock back, and round-trips zonedInstant", () => {
  assert.deepEqual(wallClock(new Date("2026-10-04T18:30:00.000Z")), { date: "2026-10-05", time: "00:00" });
  for (const [d, t, z] of [
    ["2026-10-05", "09:00", "Asia/Kolkata"],
    ["2026-03-08", "09:00", "America/New_York"],
    ["2026-12-31", "23:59", "Asia/Kolkata"],
  ] as const) {
    assert.deepEqual(wallClock(zonedInstant(d, t, z), z), { date: d, time: t });
  }
  assert.equal(formatInZone(new Date("2026-10-05T03:30:00.000Z")), "Mon 5 Oct 2026, 09:00");
});

test("addDays is calendar arithmetic: month and year ends roll over", () => {
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-10-05", 0), "2026-10-05");
});

// ------------------------------------------------------------------ the grid

const ids = (n: number) => Array.from({ length: n }, (_, i) => `ep${i}`);

test("expandSchedule fills the day x time grid in order, day by day", () => {
  const out = expandSchedule({ weekStart: "2026-10-05", days: 3, timeSlots: ["18:00", "09:00"] }, ids(5));
  assert.deepEqual(
    out.map((a) => [a.episodeId, a.position, a.assignedAt.toISOString()]),
    [
      ["ep0", 0, "2026-10-05T03:30:00.000Z"], // Mon 09:00 IST
      ["ep1", 1, "2026-10-05T12:30:00.000Z"], // Mon 18:00 IST
      ["ep2", 2, "2026-10-06T03:30:00.000Z"], // Tue 09:00
      ["ep3", 3, "2026-10-06T12:30:00.000Z"], // Tue 18:00
      ["ep4", 4, "2026-10-07T03:30:00.000Z"], // Wed 09:00
    ],
  );
  // The videos go live in the order they were given: never a later video before an earlier one.
  const times = out.map((a) => a.assignedAt.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("expandSchedule: times are sorted and de-duplicated, one time a day is one video a day, and the month rolls over", () => {
  assert.deepEqual(normaliseSlots(["18:00", "09:00", "09:00"]), ["09:00", "18:00"]);
  assert.equal(scheduleCapacity(7, ["09:00", "18:00", "09:00"]), 14);
  const week = expandSchedule({ weekStart: "2026-10-28", days: 7, timeSlots: ["09:00"] }, ids(7));
  assert.deepEqual(
    week.map((a) => wallClock(a.assignedAt).date),
    ["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"],
  );
  assert.deepEqual(expandSchedule({ weekStart: "2026-10-05", days: 2, timeSlots: ["09:00"] }, []), []);
});

test("expandSchedule refuses a grid the videos do not fit, and a config that is not one", () => {
  assert.throws(() => expandSchedule({ weekStart: "2026-10-05", days: 2, timeSlots: ["09:00"] }, ids(3)), /room for 2/);
  assert.throws(() => expandSchedule({ weekStart: "2026-10-05", days: 0, timeSlots: ["09:00"] }, ids(1)), RangeError);
  assert.throws(() => expandSchedule({ weekStart: "2026-10-05", days: 8, timeSlots: ["09:00"] }, ids(1)), RangeError);
  assert.throws(() => expandSchedule({ weekStart: "2026-10-05", days: 1, timeSlots: [] }, ids(1)), RangeError);
  assert.throws(() => expandSchedule({ weekStart: "2026-10-05", days: 1, timeSlots: ["9am"] }, ids(1)), RangeError);
  assert.throws(() => expandSchedule({ weekStart: "soon", days: 1, timeSlots: ["09:00"] }, ids(1)), RangeError);
  assert.equal(configProblem({ weekStart: "2026-10-05", days: 1, timeSlots: ["09:00"], timezone: "Nowhere/Land" }) !== null, true);
  assert.equal(configProblem({ weekStart: "2026-10-05", days: 7, timeSlots: ["09:00", "18:00"] }), null);
});

test("the panel's lead-time warning matches the engine's rule", () => {
  assert.equal(SCHEDULE_LEAD_MINUTES * 60_000, MIN_SCHEDULE_LEAD_MS);
});

// ------------------------------------------------------------------ fixtures

interface Seed {
  ownerId: string;
  strangerId: string;
  uploadId: string;
  /** Finished, owned by `ownerId`, with a render and posters on disk. */
  episodes: string[];
  /** A different book's finished video, owned by the same account. */
  otherBookEpisode: string;
  cleanup: () => Promise<void>;
}

const seeds: Seed[] = [];
after(async () => {
  for (const s of seeds) await s.cleanup();
});

async function seed(count = 3): Promise<Seed> {
  requireIsolation("these tests create episodes and write renders and posters");
  const owner = await prisma.user.create({ data: { email: `sch-own-${randomUUID()}@example.test` } });
  const stranger = await prisma.user.create({ data: { email: `sch-str-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({
    data: { title: `SCH ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id, userId: owner.id, kind: "pdf", status: "DONE" } });
  const otherUpload = await prisma.upload.create({ data: { bookId: book.id, userId: owner.id, kind: "pdf", status: "DONE" } });

  const make = async (uploadId: string, n: number): Promise<string> => {
    const episode = await prisma.episode.create({
      data: {
        bookId: book.id,
        uploadId,
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
  for (let i = 0; i < count; i++) episodes.push(await make(upload.id, i + 1));
  const otherBookEpisode = await make(otherUpload.id, 99);

  return {
    ownerId: owner.id,
    strangerId: stranger.id,
    uploadId: upload.id,
    episodes,
    otherBookEpisode,
    cleanup: async () => {
      for (const id of [...episodes, otherBookEpisode]) {
        await fs.rm(thumbsDir(id), { recursive: true, force: true });
        await fs.rm(path.join(RENDER_DIR, `${id}.mp4`), { force: true });
      }
      const uploadIds = [upload.id, otherUpload.id];
      const schedules = await prisma.weeklySchedule.findMany({ where: { uploadId: { in: uploadIds } }, select: { id: true } });
      await prisma.scheduleSlot.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.id) } } });
      await prisma.weeklySchedule.deleteMany({ where: { uploadId: { in: uploadIds } } });
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
    },
  };
}

/** A real browser publisher whose `publish` is replaced by a script. `prepare`, `validate` and `isConfigured` are the real ones. */
function scripted(publish: (p: PreparedPublish) => Promise<PublishOutcome>): BrowserPublisher {
  const real = browserPublisherFor("youtube", { browser: { deps: { locate: () => "C:/chrome.exe" } } }) as BrowserPublisher;
  return { ...real, publish: async (p) => publish(p) };
}

const posted = (id: string): PublishOutcome => ({
  status: "PUBLISHED",
  externalId: id,
  externalUrl: `https://youtu.be/${id}`,
  confirmedAt: new Date(),
  visibility: "public",
});

/** The outcome the engine returns once Studio has read the schedule back: PUBLISHED with `scheduledFor`. */
const confirmed = (id: string, when: Date | null | undefined): PublishOutcome =>
  ({ ...posted(id), visibility: "scheduled", scheduledFor: when }) as PublishOutcome;

interface Call {
  episodeId: string;
  options: BrowserPublishOptions;
}

/** A `makePublisher` that records every call and answers per episode (default: YouTube confirmed the asked-for time). */
function recorder(answer?: (episodeId: string, options: BrowserPublishOptions) => Promise<PublishOutcome> | PublishOutcome) {
  const calls: Call[] = [];
  const makePublisher = (_platform: unknown, options: BrowserPublishOptions): BrowserPublisher =>
    scripted(async (p) => {
      calls.push({ episodeId: p.episodeId, options });
      return answer ? answer(p.episodeId, options) : confirmed(`VID_${p.episodeId}`, options.scheduledAt);
    });
  return { calls, makePublisher: makePublisher as never };
}

/** A date in the near future in Asia/Kolkata, far enough that every slot clears the 15-minute floor. */
const futureDay = (daysAhead = 3) => addDays(wallClock(new Date()).date, daysAhead);
const pastDay = () => addDays(wallClock(new Date()).date, -2);

const draftBody = (s: Seed, over: Record<string, unknown> = {}) => ({
  uploadId: s.uploadId,
  weekStart: futureDay(),
  days: 3,
  timeSlots: ["09:00", "18:00"],
  madeForKids: false,
  videoIds: s.episodes,
  ...over,
});

const must = (view: { schedule: ScheduleView | null }): ScheduleView => {
  assert.ok(view.schedule, "expected a schedule");
  return view.schedule;
};

const isApp = (err: unknown): err is { code: string; status: number; message: string } => isAppError(err);

async function rejects(p: Promise<unknown>, code: string, status?: number): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.ok(isApp(err), `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (status !== undefined) assert.equal(err.status, status);
    return err.message;
  }
  assert.fail(`expected ${code}`);
}

const youtubeRow = (episodeId: string) => prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform: "youtube" } } });
const instagramRow = (episodeId: string) => prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform: "instagram" } } });

/** The outcome the Instagram engine returns once the Reel's link is found: PUBLISHED, no `scheduledFor` (it is not scheduled). */
const igPosted = (id: string): PublishOutcome => ({
  status: "PUBLISHED",
  externalId: id,
  externalUrl: `https://www.instagram.com/reel/${id}/`,
  confirmedAt: new Date(),
  visibility: "public",
});

// ------------------------------------------------------------------ save draft

test("save draft: creates the schedule and one slot per video, with the exact Asia/Kolkata instants", async () => {
  const s = await seed(3);
  seeds.push(s);
  const view = must(await saveDraft(s.ownerId, draftBody(s, { weekStart: "2026-10-05", days: 2, timeSlots: ["18:00", "09:00"], videoIds: s.episodes })));

  assert.equal(view.status, "draft");
  assert.equal(view.weekStart, "2026-10-05");
  assert.equal(view.days, 2);
  assert.deepEqual(view.timeSlots, ["09:00", "18:00"]);
  assert.equal(view.timezone, "Asia/Kolkata");
  assert.equal(view.madeForKids, false);
  assert.equal(view.running, false);
  assert.deepEqual(
    view.slots.map((x) => [x.episodeId, x.position, x.assignedAt, x.status]),
    [
      [s.episodes[0], 0, "2026-10-05T03:30:00.000Z", "pending"],
      [s.episodes[1], 1, "2026-10-05T12:30:00.000Z", "pending"],
      [s.episodes[2], 2, "2026-10-06T03:30:00.000Z", "pending"],
    ],
  );
  assert.equal(view.slots[0].title, "Video 1");
  assert.equal(view.slots[0].job, null);

  // The row is what the view says, and nothing was sent anywhere.
  const row = await prisma.weeklySchedule.findUnique({ where: { id: view.id } });
  assert.equal(row?.status, "draft");
  assert.equal(row?.userId, s.ownerId);
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes } } }), 0);
});

test("save draft: the zone is honoured, and the kids answer stays unanswered unless given", async () => {
  const s = await seed(1);
  seeds.push(s);
  const ny = must(
    await saveDraft(s.ownerId, draftBody(s, { weekStart: "2026-01-15", days: 1, timeSlots: ["09:00"], timezone: "America/New_York", madeForKids: undefined, videoIds: s.episodes })),
  );
  assert.equal(ny.timezone, "America/New_York");
  assert.equal(ny.slots[0].assignedAt, "2026-01-15T14:00:00.000Z");
  assert.equal(ny.madeForKids, null, "a declaration the operator never made is not made for them");
});

test("save draft: one draft per book. A second save rewrites it and replaces its slots", async () => {
  const s = await seed(3);
  seeds.push(s);
  const first = must(await saveDraft(s.ownerId, draftBody(s)));
  const second = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["10:00"], videoIds: [s.episodes[2]], madeForKids: true })));

  assert.equal(second.id, first.id, "the same draft");
  assert.equal(await prisma.weeklySchedule.count({ where: { uploadId: s.uploadId } }), 1);
  assert.equal(await prisma.scheduleSlot.count({ where: { scheduleId: first.id } }), 1);
  assert.deepEqual(second.slots.map((x) => x.episodeId), [s.episodes[2]]);
  assert.equal(second.madeForKids, true);
  assert.deepEqual(must(await scheduleView(s.ownerId, s.uploadId)).slots.map((x) => x.episodeId), [s.episodes[2]]);
});

test("save draft: only this account's finished videos of this book are accepted", async () => {
  const s = await seed(3);
  seeds.push(s);
  const [a, b, c] = s.episodes;

  // Another account's book looks like no book at all.
  await rejects(saveDraft(s.strangerId, draftBody(s)), "not_found", 404);
  await rejects(saveDraft(s.ownerId, draftBody(s, { uploadId: "nope" })), "not_found", 404);
  await rejects(saveDraft(s.ownerId, null), "bad_body", 400);

  // A video of a different book.
  assert.match(await rejects(saveDraft(s.ownerId, draftBody(s, { videoIds: [a, s.otherBookEpisode] })), "bad_schedule", 400), /not part of this book/);
  // Not finished: still rendering.
  await prisma.episode.update({ where: { id: b }, data: { status: "RUNNING" } });
  assert.match(await rejects(saveDraft(s.ownerId, draftBody(s, { videoIds: [a, b] })), "bad_schedule", 400), /not a finished video/);
  await prisma.episode.update({ where: { id: b }, data: { status: "DONE" } });
  // DONE but the render is not recorded.
  await prisma.episode.update({ where: { id: c }, data: { videoPath: null } });
  assert.match(await rejects(saveDraft(s.ownerId, draftBody(s, { videoIds: [c] })), "bad_schedule", 400), /not a finished video/);
  // Somebody else's episode.
  await prisma.episode.update({ where: { id: a }, data: { userId: s.strangerId } });
  assert.match(await rejects(saveDraft(s.ownerId, draftBody(s, { videoIds: [a] })), "bad_schedule", 400), /does not belong to this account/);

  assert.equal(await prisma.weeklySchedule.count({ where: { uploadId: s.uploadId } }), 0, "nothing was saved by any refusal");
});

test("save draft: a grid the videos do not fit, and settings that are not a schedule, are refused", async () => {
  const s = await seed(3);
  seeds.push(s);
  assert.match(await rejects(saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00"] })), "bad_schedule", 400), /room for 1/);
  await rejects(saveDraft(s.ownerId, draftBody(s, { days: 9 })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { days: 1.5 })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { weekStart: "2026-02-30" })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { timeSlots: ["9am"] })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { timeSlots: [] })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { timezone: "Mars/Phobos" })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { madeForKids: "no" })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { videoIds: [] })), "bad_schedule", 400);
  await rejects(saveDraft(s.ownerId, draftBody(s, { videoIds: "all" })), "bad_schedule", 400);
});

// ------------------------------------------------------------------ activate: validation

test("activate: the kids answer is required, and nothing is sent without it", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { madeForKids: undefined, videoIds: s.episodes })));
  const { calls, makePublisher } = recorder();

  assert.match(await rejects(activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }), "made_for_kids_required", 400), /made for kids/);
  assert.equal(calls.length, 0);
  assert.equal((await prisma.weeklySchedule.findUnique({ where: { id: draft.id } }))?.status, "draft", "not activated");
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes } } }), 0);
});

test("activate: a slot in the past, or under 15 minutes away, is refused and nothing starts", async () => {
  const s = await seed(2);
  seeds.push(s);
  const { calls, makePublisher } = recorder();

  const past = must(await saveDraft(s.ownerId, draftBody(s, { weekStart: pastDay(), days: 1, timeSlots: ["09:00", "18:00"] })));
  assert.match(await rejects(activateSchedule(s.ownerId, past.id, { makePublisher, waitForCompletion: true }), "bad_schedule", 400), /in the past or less than 15 minutes/);

  // 10 minutes ahead of "now", and one millisecond short of the floor: both refused.
  const future = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00", "18:00"] })));
  const first = new Date(future.slots[0].assignedAt).getTime();
  await rejects(activateSchedule(s.ownerId, future.id, { makePublisher, waitForCompletion: true, now: first - 10 * 60_000 }), "bad_schedule", 400);
  await rejects(activateSchedule(s.ownerId, future.id, { makePublisher, waitForCompletion: true, now: first - MIN_SCHEDULE_LEAD_MS + 1 }), "bad_schedule", 400);

  assert.equal(calls.length, 0);
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes } } }), 0);
  assert.equal((await prisma.weeklySchedule.findUnique({ where: { id: future.id } }))?.status, "draft");

  // Exactly at the floor is allowed: the engine's own check is "earlier than now + 15 minutes".
  const ok = await activateSchedule(s.ownerId, future.id, { makePublisher, waitForCompletion: true, now: first - MIN_SCHEDULE_LEAD_MS });
  assert.equal(must(ok).status, "active");
});

test("activate: a video that stopped being finished since the draft was saved is refused", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  const { calls, makePublisher } = recorder();

  await prisma.episode.update({ where: { id: s.episodes[1] }, data: { status: "FAILED" } });
  assert.match(await rejects(activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }), "bad_schedule", 400), /no longer a finished video/);
  await prisma.episode.update({ where: { id: s.episodes[1] }, data: { status: "DONE", videoPath: null } });
  await rejects(activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }), "bad_schedule", 400);

  assert.equal(calls.length, 0);
  assert.equal((await prisma.weeklySchedule.findUnique({ where: { id: draft.id } }))?.status, "draft");
});

test("activate and read: another account's schedule is not found", async () => {
  const s = await seed(1);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  const { calls, makePublisher } = recorder();

  await rejects(activateSchedule(s.strangerId, draft.id, { makePublisher, waitForCompletion: true }), "not_found", 404);
  await rejects(activateSchedule(s.ownerId, "nope", { makePublisher, waitForCompletion: true }), "not_found", 404);
  assert.equal((await scheduleView(s.strangerId, s.uploadId)).schedule, null);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ activate: the run

test("activate: every slot becomes a confirmed SCHEDULED job at its own time, in order, with no real upload", async () => {
  const s = await seed(3);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { madeForKids: false })));
  const { calls, makePublisher } = recorder();

  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }));

  // Uploaded one at a time, in slot order, through startBrowserPublish's own checks.
  assert.deepEqual(calls.map((c) => c.episodeId), s.episodes);
  for (const [i, call] of calls.entries()) {
    assert.equal(call.options.scheduledAt?.toISOString(), draft.slots[i].assignedAt);
    assert.equal(call.options.madeForKids, false, "the operator's saved answer, not a default");
    assert.equal(call.options.confirmPublic, true, "Activate is the go-live confirmation");
  }

  assert.equal(view.status, "active");
  assert.equal(view.running, false);
  for (const [i, slot] of view.slots.entries()) {
    const job = await youtubeRow(slot.episodeId);
    assert.equal(job?.status, "SCHEDULED");
    assert.equal(job?.mode, "browser");
    assert.equal(job?.scheduledFor?.toISOString(), draft.slots[i].assignedAt, "the time YouTube read back");
    assert.equal(job?.publishedAt, null, "nothing is published yet");
    assert.equal(job?.externalId, `VID_${slot.episodeId}`);
    assert.equal(slot.status, "scheduled");
    assert.equal(slot.job?.status, "SCHEDULED");
    assert.equal(slot.job?.scheduledFor, draft.slots[i].assignedAt);
    const row = await prisma.scheduleSlot.findUnique({ where: { id: slot.id } });
    assert.equal(row?.status, "scheduled");
    assert.equal(row?.publishJobId, job?.id);
  }

  // The schedule stays active, and the same answer comes back from a fresh read.
  const fresh = must(await scheduleView(s.ownerId, s.uploadId));
  assert.deepEqual(fresh.slots.map((x) => x.status), ["scheduled", "scheduled", "scheduled"]);
});

test("activate again: scheduled videos are skipped over, never uploaded twice", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  const first = recorder();
  await activateSchedule(s.ownerId, draft.id, { makePublisher: first.makePublisher, waitForCompletion: true });
  assert.equal(first.calls.length, 2);

  const again = recorder();
  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: again.makePublisher, waitForCompletion: true }));
  assert.equal(again.calls.length, 0, "no publisher was even built");
  assert.deepEqual(view.slots.map((x) => x.status), ["scheduled", "scheduled"]);
  assert.equal((await youtubeRow(s.episodes[0]))?.attempts, 1);
});

test("DEDUPE: a video already scheduled or posted on YouTube is skipped, and no second job or upload is made", async () => {
  const s = await seed(5);
  seeds.push(s);
  const [fresh, scheduledElsewhere, posted1, seen, sameTime] = s.episodes;
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 3, videoIds: s.episodes })));
  const at = (i: number) => new Date(draft.slots[i].assignedAt);

  // Existing settled facts, as the Publish Center or an earlier run would have left them.
  await prisma.publishJob.create({
    data: { episodeId: scheduledElsewhere, platform: "youtube", mode: "browser", status: "SCHEDULED", externalId: "OLD1", scheduledFor: new Date(at(1).getTime() + 86_400_000), attempts: 1 },
  });
  await prisma.publishJob.create({
    data: { episodeId: posted1, platform: "youtube", mode: "api", status: "PUBLISHED", externalId: "OLD2", publishedAt: new Date(), attempts: 1 },
  });
  await prisma.publishJob.create({
    data: { episodeId: seen, platform: "youtube", mode: "browser", status: "AWAITING_HUMAN", externalId: "SEEN1", lastError: "Studio never confirmed it.", attempts: 1 },
  });
  await prisma.publishJob.create({
    data: { episodeId: sameTime, platform: "youtube", mode: "browser", status: "SCHEDULED", externalId: "OLD3", scheduledFor: at(4), attempts: 1 },
  });

  const { calls, makePublisher } = recorder();
  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }));

  assert.deepEqual(calls.map((c) => c.episodeId), [fresh], "only the video with nothing on YouTube was uploaded");
  assert.deepEqual(view.slots.map((x) => x.status), ["scheduled", "skipped", "skipped", "skipped", "scheduled"]);
  assert.match(view.slots[1].note ?? "", /Already scheduled on YouTube for .* left as it is/);
  assert.match(view.slots[2].note ?? "", /Already posted on YouTube/);
  assert.match(view.slots[3].note ?? "", /already showed a video .*SEEN1/);
  assert.match(view.slots[4].note ?? "", /Already scheduled on YouTube for this time/);

  // The existing jobs are exactly as they were: same row, same id, same attempt count, same time.
  for (const [ep, id] of [[scheduledElsewhere, "OLD1"], [posted1, "OLD2"], [seen, "SEEN1"], [sameTime, "OLD3"]] as const) {
    const job = await youtubeRow(ep);
    assert.equal(job?.externalId, id);
    assert.equal(job?.attempts, 1, "no second attempt");
  }
  assert.equal((await youtubeRow(scheduledElsewhere))?.scheduledFor?.getTime(), at(1).getTime() + 86_400_000);
  assert.equal((await youtubeRow(seen))?.status, "AWAITING_HUMAN");
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes } } }), 5, "one job per video, never two");
});

test("DEDUPE: a video that already has a settled job does not block activation with a slot in the past", async () => {
  const s = await seed(1);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { weekStart: pastDay(), days: 1, timeSlots: ["09:00"] })));
  await prisma.publishJob.create({
    data: { episodeId: s.episodes[0], platform: "youtube", mode: "browser", status: "SCHEDULED", externalId: "OLD", scheduledFor: new Date(Date.now() + 86_400_000), attempts: 1 },
  });
  const { calls, makePublisher } = recorder();
  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }));
  assert.equal(calls.length, 0);
  assert.equal(view.slots[0].status, "skipped");
});

test("a job that needs a person ends the run: the rest stay pending, and Run again picks up after it", async () => {
  const s = await seed(4);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 4, timeSlots: ["09:00"], videoIds: s.episodes })));

  // Video 2 needs a sign-in. Pressing on would close the window the person is using.
  const stop = recorder((episodeId, options) =>
    episodeId === s.episodes[1]
      ? { status: "AWAITING_HUMAN", error: "YouTube asked you to sign in. Sign in in the window, then retry.", externalId: null, externalUrl: null }
      : confirmed(`VID_${episodeId}`, options.scheduledAt),
  );
  const first = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: stop.makePublisher, waitForCompletion: true }));

  assert.deepEqual(stop.calls.map((c) => c.episodeId), [s.episodes[0], s.episodes[1]], "videos 3 and 4 were not even tried");
  assert.deepEqual(first.slots.map((x) => x.status), ["scheduled", "failed", "pending", "pending"]);
  assert.match(first.slots[1].note ?? "", /asked you to sign in/);
  assert.match(first.slots[2].note ?? "", /Not started/);
  assert.equal((await youtubeRow(s.episodes[1]))?.status, "AWAITING_HUMAN");
  assert.equal((await youtubeRow(s.episodes[2]))?.status, "QUEUED", "later jobs are persisted before execution");

  // Run again without anyone looking: the stopped video is NOT retried (the engine wants a person's say-so),
  // it is reported again, and the videos behind it go ahead.
  const resume = recorder();
  const second = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: resume.makePublisher, waitForCompletion: true }));
  assert.deepEqual(resume.calls.map((c) => c.episodeId), []);
  assert.deepEqual(second.slots.map((x) => x.status), ["scheduled", "failed", "pending", "pending"]);
  assert.match(second.slots[1].note ?? "", /stopped for you to take over/);
  assert.equal((await youtubeRow(s.episodes[0]))?.attempts, 1, "the scheduled video was not uploaded again");
});

test("activation validates all approved metadata before creating any upload", async () => {
  const s = await seed(3); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  await prisma.episode.update({ where: { id: s.episodes[1] }, data: { title: "", description: "", hashtags: "[]" } });
  const mock = recorder();
  await assert.rejects(activateSchedule(s.ownerId, draft.id, { makePublisher: mock.makePublisher, waitForCompletion: true }), /not ready to publish/);
  assert.equal(mock.calls.length, 0);
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes } } }), 0);
});

test("a publisher that throws never escapes the runner: the job is handed to a person and the run stops", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 2, timeSlots: ["09:00"], videoIds: s.episodes })));
  const boom = recorder(() => {
    throw new Error("page crashed");
  });

  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: boom.makePublisher, waitForCompletion: true }));
  assert.equal((await youtubeRow(s.episodes[0]))?.status, "AWAITING_HUMAN");
  assert.deepEqual(view.slots.map((x) => x.status), ["failed", "pending"]);
  assert.match(view.slots[0].note ?? "", /page crashed/);
  assert.equal(boom.calls.length, 1);
  assert.equal(isScheduleRunning(draft.id), false);
});

test("the browser route being unavailable ends the run on the first video", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 2, timeSlots: ["09:00"], videoIds: s.episodes })));
  const unavailable = (): BrowserPublisher => ({ ...scripted(async () => posted("x")), isConfigured: async () => false });

  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: unavailable as never, waitForCompletion: true }));
  assert.deepEqual(view.slots.map((x) => x.status), ["failed", "pending"]);
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes }, status: "QUEUED", attempts: 0 } }), 2, "approved jobs survive the unavailable browser");
});

test("one run per schedule: a second activation while it is running starts nothing", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 2, timeSlots: ["09:00"], videoIds: s.episodes })));

  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const slow = recorder(async (episodeId, options) => {
    await gate;
    return confirmed(`VID_${episodeId}`, options.scheduledAt);
  });

  // Detached, as the route does it: the view comes back at once, saying it is running.
  const started = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: slow.makePublisher }));
  assert.equal(started.status, "active");
  assert.equal(started.running, true);
  assert.equal(isScheduleRunning(draft.id), true);

  const second = recorder();
  const again = must(await activateSchedule(s.ownerId, draft.id, { makePublisher: second.makePublisher }));
  assert.equal(again.running, true);
  await runSchedule(draft.id, { makePublisher: second.makePublisher });
  assert.equal(second.calls.length, 0, "a second pass did not start");

  open();
  const end = Date.now() + 30_000;
  while (isScheduleRunning(draft.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  assert.equal(isScheduleRunning(draft.id), false);
  assert.deepEqual(slow.calls.map((c) => c.episodeId), s.episodes, "each video was uploaded once, in order");
  assert.deepEqual(must(await scheduleView(s.ownerId, s.uploadId)).slots.map((x) => x.status), ["scheduled", "scheduled"]);
});

test("a run a restart killed does not show a spinner forever: the view reads the job's real outcome", async () => {
  const s = await seed(3);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 3, timeSlots: ["09:00"], videoIds: s.episodes })));
  await prisma.weeklySchedule.update({ where: { id: draft.id }, data: { status: "active" } });
  const [a, b, c] = draft.slots;

  // Slot 1: YouTube confirmed it, but the slot write was lost. Slot 2: the job was cut short.
  // Slot 3: the run died before it asked for anything.
  await prisma.publishJob.create({
    data: { episodeId: a.episodeId, platform: "youtube", mode: "browser", status: "SCHEDULED", externalId: "V1", scheduledFor: new Date(a.assignedAt), attempts: 1 },
  });
  await prisma.publishJob.create({
    data: { episodeId: b.episodeId, platform: "youtube", mode: "browser", status: "PREPARING", attempts: 1 },
  });
  await prisma.scheduleSlot.updateMany({ where: { scheduleId: draft.id }, data: { status: "scheduling" } });

  const view = must(await scheduleView(s.ownerId, s.uploadId));
  assert.equal(view.running, false);
  assert.equal(view.slots.find((x) => x.id === a.id)?.status, "scheduled");
  assert.equal(view.slots.find((x) => x.id === b.id)?.status, "failed", "a job a restart interrupted is handed to a person");
  assert.match(view.slots.find((x) => x.id === b.id)?.note ?? "", /server stopped or restarted/);
  assert.equal(view.slots.find((x) => x.id === c.id)?.status, "pending");
  assert.equal((await prisma.scheduleSlot.findUnique({ where: { id: a.id } }))?.status, "scheduled", "the correction is saved");
});

// ------------------------------------------------------------------ platforms: save + both

test("save draft: platforms default to YouTube only, and 'both' makes one slot per (video, platform) at the same instant", async () => {
  const s = await seed(2);
  seeds.push(s);

  // Omitted => YouTube, as it was before Instagram was an option.
  const yt = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00", "18:00"], videoIds: s.episodes })));
  assert.deepEqual(yt.platforms, ["youtube"]);
  assert.deepEqual(yt.slots.map((x) => x.platform), ["youtube", "youtube"]);

  // Both platforms: two slots per video, same time, each its own row.
  const both = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00", "18:00"], videoIds: s.episodes, platforms: ["instagram", "youtube"] })));
  assert.deepEqual(both.platforms, ["youtube", "instagram"], "youtube-first, however they were ordered in the request");
  assert.equal(both.slots.length, 4);
  // For each video, a youtube slot and an instagram slot at the identical instant.
  for (const ep of s.episodes) {
    const mine = both.slots.filter((x) => x.episodeId === ep);
    assert.deepEqual(mine.map((x) => x.platform).sort(), ["instagram", "youtube"]);
    assert.equal(new Set(mine.map((x) => x.assignedAt)).size, 1, "same instant on both platforms");
    assert.ok(mine.every((x) => x.status === "pending" && x.job === null));
  }
  assert.equal(await prisma.publishJob.count({ where: { episodeId: { in: s.episodes } } }), 0, "nothing sent on save");
});

test("save draft: an empty or unknown platform list is refused", async () => {
  const s = await seed(1);
  seeds.push(s);
  await rejects(saveDraft(s.ownerId, draftBody(s, { platforms: [] })), "bad_schedule", 400);
  assert.match(await rejects(saveDraft(s.ownerId, draftBody(s, { platforms: ["tiktok"] })), "bad_schedule", 400), /at least one platform/);
  await rejects(saveDraft(s.ownerId, draftBody(s, { platforms: "youtube" })), "bad_schedule", 400);
  assert.equal(await prisma.weeklySchedule.count({ where: { uploadId: s.uploadId } }), 0);
});

test("activate 'both': YouTube is scheduled now; Instagram is left pending for its slot time, not posted at activation", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00", "18:00"], videoIds: s.episodes, platforms: ["youtube", "instagram"] })));
  const { calls, makePublisher } = recorder();

  const view = must(await activateSchedule(s.ownerId, draft.id, { makePublisher, waitForCompletion: true }));

  // Only the YouTube slots were uploaded at activation; every call carried a scheduledAt (native scheduling).
  assert.equal(calls.length, 2, "two videos, YouTube only -- Instagram is not uploaded ahead");
  assert.ok(calls.every((c) => c.options.scheduledAt instanceof Date));

  const yt = view.slots.filter((x) => x.platform === "youtube");
  const ig = view.slots.filter((x) => x.platform === "instagram");
  assert.deepEqual(yt.map((x) => x.status), ["scheduled", "scheduled"]);
  assert.deepEqual(ig.map((x) => x.status), ["pending", "pending"], "Instagram waits for its time");
  for (const ep of s.episodes) {
    assert.equal((await youtubeRow(ep))?.status, "SCHEDULED");
    assert.equal((await instagramRow(ep))?.status, "QUEUED", "disabled Instagram is queued but does not execute");
  }
});

// ------------------------------------------------------------------ platforms: Instagram due-runner

const IG_ENABLED = { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1", BOOKREEL_IG_NATIVE_SCHEDULE: "1" };

test("disabled Instagram cannot post even an overdue slot", async () => {
  const s = await seed(1); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { platforms: ["instagram"], weekStart: pastDay() })));
  await activateSchedule(s.ownerId, draft.id, { env: {}, waitForCompletion: true });
  const mock = recorder();
  assert.equal(await publishDueInstagram({ scheduleId: draft.id, env: {}, makePublisher: mock.makePublisher }), 0);
  assert.equal(mock.calls.length, 0);
  assert.equal((await instagramRow(s.episodes[0]))?.status, "QUEUED");
});

test("enabled Instagram schedules ahead with the exact time and does not upload twice", async () => {
  const s = await seed(2); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { platforms: ["instagram"] })));
  await activateSchedule(s.ownerId, draft.id, { env: {}, waitForCompletion: true });
  const mock = recorder();
  await publishDueInstagram({ scheduleId: draft.id, env: IG_ENABLED, makePublisher: mock.makePublisher });
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(c => c.options.scheduledAt instanceof Date && c.options.confirmPublic));
  assert.deepEqual(must(await scheduleView(s.ownerId, s.uploadId)).slots.map(s => s.status), ["scheduled", "scheduled"]);
  assert.equal((await instagramRow(s.episodes[0]))?.scheduledFor?.toISOString(), draft.slots[0].assignedAt);
  await publishDueInstagram({ scheduleId: draft.id, env: IG_ENABLED, makePublisher: mock.makePublisher });
  assert.equal(mock.calls.length, 2);
});

test("Instagram eligibility failure never blocks YouTube or retries automatically", async () => {
  const s = await seed(2); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { platforms: ["youtube", "instagram"] })));
  const yt = recorder();
  await activateSchedule(s.ownerId, draft.id, { env: {}, makePublisher: yt.makePublisher, waitForCompletion: true });
  const ig = recorder(() => ({ status: "AWAITING_HUMAN", error: "Schedule content is unavailable." }));
  await publishDueInstagram({ scheduleId: draft.id, env: IG_ENABLED, makePublisher: ig.makePublisher });
  await publishDueInstagram({ scheduleId: draft.id, env: IG_ENABLED, makePublisher: ig.makePublisher });
  const view = must(await scheduleView(s.ownerId, s.uploadId));
  assert.deepEqual(view.slots.filter(s => s.platform === "youtube").map(s => s.status), ["scheduled", "scheduled"]);
  assert.deepEqual(view.slots.filter(s => s.platform === "instagram").map(s => s.status), ["failed", "pending"]);
  assert.equal(ig.calls.length, 1);
});

test("native Instagram needs a 20-minute margin and never shares late", async () => {
  const s = await seed(1); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { platforms: ["instagram"], madeForKids: null })));
  const mock = recorder();
  await assert.rejects(activateSchedule(s.ownerId, draft.id, { env: IG_ENABLED, now: new Date(draft.slots[0].assignedAt).getTime() - 120_000, makePublisher: mock.makePublisher, waitForCompletion: true }), /past or less/);
  assert.equal(mock.calls.length, 0);
  await activateSchedule(s.ownerId, draft.id, { env: {}, waitForCompletion: true });
  await prisma.scheduleSlot.updateMany({ where: { scheduleId: draft.id }, data: { assignedAt: new Date(0) } });
  await publishDueInstagram({ scheduleId: draft.id, env: IG_ENABLED, makePublisher: mock.makePublisher });
  assert.equal(mock.calls.length, 0);
  assert.equal((await scheduleView(s.ownerId, s.uploadId)).schedule?.slots[0].status, "failed");
});

test("ordered windows, generated episode files and Instagram offsets persist the exact preview", async () => {
  const s = await seed(3); seeds.push(s);
  const ordered = [...s.episodes].reverse();
  const windows = [{ start: "05:00", end: "06:00" }, { start: "13:00", end: "14:00" }];
  const body = draftBody(s, { videoIds: ordered, windows, seed: 42, days: 2, platforms: ["youtube", "instagram"], instagramOffsetMinutes: 10 });
  const view = must(await saveDraft(s.ownerId, body));
  const preview = expandSchedule({ weekStart: body.weekStart, days: 2, timeSlots: windows.map(w => w.start), windows, seed: 42 }, ordered);
  assert.deepEqual(view.slots.filter(s => s.platform === "youtube").map(s => [s.episodeId, s.assignedAt]), preview.map(p => [p.episodeId, p.assignedAt.toISOString()]));
  for (const slot of view.slots.filter(s => s.platform === "instagram")) {
    const yt = view.slots.find(s => s.episodeId === slot.episodeId && s.platform === "youtube")!;
    assert.equal(new Date(slot.assignedAt).getTime() - new Date(yt.assignedAt).getTime(), 600_000);
  }
  assert.throws(() => zonedInstant("2027-03-14", "02:30", "America/New_York"), /exist|clock|gap/i);
});

test("restart resumes frozen queued metadata and holds interrupted browser uploads", async () => {
  const { processScheduleQueue } = await import("../src/lib/schedule/worker");
  const s = await seed(3); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  const stop = recorder(() => ({ status: "AWAITING_HUMAN", error: "Sign in." }));
  await activateSchedule(s.ownerId, draft.id, { makePublisher: stop.makePublisher, waitForCompletion: true, env: {} });
  await prisma.publishJob.update({ where: { episodeId_platform: { episodeId: s.episodes[0], platform: "youtube" } }, data: { status: "SCHEDULED", externalId: "abcdefghijk", scheduledFor: new Date(draft.slots[0].assignedAt) } });
  await prisma.scheduleSlot.update({ where: { id: draft.slots[0].id }, data: { status: "scheduled" } });
  await prisma.episode.update({ where: { id: s.episodes[1] }, data: { title: "Changed after approval" } });
  const seen: string[] = [];
  const makePublisher = (_platform: unknown, options: BrowserPublishOptions) => scripted(async p => {
    seen.push(p.metadata.title); return confirmed("abcdefghijl", options.scheduledAt);
  });
  await processScheduleQueue({ env: {}, makePublisher: makePublisher as never });
  assert.deepEqual(seen, ["Video 2", "Video 3"]);
  const first = await youtubeRow(s.episodes[0]);
  await prisma.publishJob.update({ where: { id: first!.id }, data: { status: "UPLOADING", remoteDraftId: "abcdefghijk", workerPid: 99999999 } });
  await prisma.scheduleSlot.update({ where: { id: draft.slots[0].id }, data: { status: "scheduling" } });
  seen.length = 0;
  await processScheduleQueue({ env: {}, makePublisher: makePublisher as never });
  assert.equal((await youtubeRow(s.episodes[0]))?.status, "AWAITING_HUMAN");
  assert.equal(seen.length, 0);
});

test("pause, duplicate reservations and explicit retry acknowledgement survive queue passes", async () => {
  const { controlSchedule } = await import("../src/lib/schedule/store");
  const { processScheduleQueue } = await import("../src/lib/schedule/worker");
  const s = await seed(1); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  const stop = recorder(() => ({ status: "AWAITING_HUMAN", error: "Inspect the window." }));
  await activateSchedule(s.ownerId, draft.id, { makePublisher: stop.makePublisher, waitForCompletion: true });
  await controlSchedule(s.ownerId, draft.id, "pause");
  const mock = recorder();
  await processScheduleQueue({ env: {}, makePublisher: mock.makePublisher });
  assert.equal(mock.calls.length, 0);
  const another = must(await saveDraft(s.ownerId, draftBody(s)));
  await assert.rejects(activateSchedule(s.ownerId, another.id, { makePublisher: mock.makePublisher, waitForCompletion: true }), /reserved/);
  await assert.rejects(controlSchedule(s.ownerId, draft.id, "retry"), /Check the platform/);
  await controlSchedule(s.ownerId, draft.id, "retry", { acknowledgeRetry: true, makePublisher: mock.makePublisher, waitForCompletion: true });
  assert.equal(mock.calls.length, 1);
  await controlSchedule(s.ownerId, draft.id, "cancel");
  await assert.rejects(controlSchedule(s.ownerId, draft.id, "resume"), /cancelled/);
});

test("restart self-heal of an Instagram slot: no job → pending; a confirmed Reel → published", async () => {
  const s = await seed(2);
  seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s, { days: 2, timeSlots: ["09:00"], videoIds: s.episodes, platforms: ["instagram"] })));
  await prisma.weeklySchedule.update({ where: { id: draft.id }, data: { status: "active" } });
  const [a, b] = draft.slots;

  // Slot A: the Reel is up, but the slot write was lost. Slot B: the post died before it made any job.
  await prisma.publishJob.create({
    data: { episodeId: a.episodeId, platform: "instagram", mode: "browser", status: "PUBLISHED", externalId: "IG_A", externalUrl: "https://www.instagram.com/reel/IG_A/", publishedAt: new Date(), attempts: 1 },
  });
  await prisma.scheduleSlot.updateMany({ where: { scheduleId: draft.id }, data: { status: "scheduling" } });

  const view = must(await scheduleView(s.ownerId, s.uploadId));
  assert.equal(view.slots.find((x) => x.id === a.id)?.status, "published", "a confirmed Reel reads back as posted");
  assert.equal(view.slots.find((x) => x.id === b.id)?.status, "pending", "a post with no job goes back to pending for the ticker");
  assert.equal((await prisma.scheduleSlot.findUnique({ where: { id: a.id } }))?.status, "published", "the correction is saved");
});

// ------------------------------------------------------------------ routes and panel

test("the two modules the panel imports have no imports of their own", async () => {
  // `tests/client-ui.test.mts` lets the client component import these two because they are pure. This holds them to it:
  // a Prisma or Playwright import here would put the server's code in the browser bundle.
  for (const name of ["time.ts", "view.ts"]) {
    const source = await fs.readFile(fileURLToPath(new URL(`../src/lib/schedule/${name}`, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /node:|@prisma|playwright|publish\/|lib\/db/, `${name} must not pull server libraries into the browser`);
  }
});

test("the routes are thin: they only authenticate, parse and call the store", async () => {
  const dir = fileURLToPath(new URL("../src/app/api/schedules/", import.meta.url));
  const list = await fs.readFile(path.join(dir, "route.ts"), "utf8");
  const activate = await fs.readFile(path.join(dir, "[id]", "activate", "route.ts"), "utf8");
  for (const source of [list, activate]) {
    assert.match(source, /requireUser\(\)/);
    assert.match(source, /export const runtime = "nodejs"/);
    assert.doesNotMatch(source, /startBrowserPublish|prisma/, "publishing and storage belong to lib/schedule");
  }
  assert.match(activate, /export const maxDuration = 900/);
});

test("the runner calls the engine's own publish path and nothing else", async () => {
  const dir = fileURLToPath(new URL("../src/lib/schedule/", import.meta.url));
  const source = await fs.readFile(path.join(dir, "activate.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  assert.match(code, /startBrowserPublish\(/);
  assert.doesNotMatch(code, /playwright|publishJob\.(create|update|upsert|delete)/, "the engine writes the job; this file only reads it");
  assert.match(code, /startYouTubePublish\(/, "API and browser jobs share the queue");
});

const PanelModule = panelModule as unknown as { default: React.ComponentType<Record<string, unknown>>; SchedulePanel?: React.ComponentType<Record<string, unknown>> };
const Panel = (PanelModule.SchedulePanel ?? (PanelModule as unknown as { default: { SchedulePanel: React.ComponentType<Record<string, unknown>> } }).default.SchedulePanel) as React.ComponentType<Record<string, unknown>>;
const Button = (PanelModule.default as unknown as { default?: React.ComponentType<Record<string, unknown>> }).default ?? PanelModule.default;

const VIDEOS = [
  { id: "a", title: "Productivity Isn't Hustle", ready: true },
  { id: "b", title: "The Attention Trap", ready: true },
  { id: "c", title: "Still Rendering", ready: false },
];

test("the Weekly Schedule button is the cyan outline control, and the dialog is not mounted until it is pressed", () => {
  const html = renderToStaticMarkup(React.createElement(Button, { uploadId: "u1", videos: VIDEOS }));
  assert.match(html, />Weekly Schedule</);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /border-color:var\(--cyan\)/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("the plan panel: week, days, daily times, a fixed zone, an unanswered kids question, the videos and an exact preview", () => {
  const html = renderToStaticMarkup(React.createElement(Panel, { uploadId: "u1", videos: VIDEOS, initial: null }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  assert.match(html, /type="date"/, "week start");
  assert.match(html, /<select[^>]*>[\s\S]*<option value="7"[^>]*>7 days<\/option>/, "number of days up to seven");
  assert.match(html, /type="time"/, "add a daily time");
  assert.match(text, /09:00/);
  assert.match(text, /Asia\/Kolkata/);
  assert.doesNotMatch(html, /<select[^>]*id="[^"]*tz/, "the zone is not a choice");

  // A legal declaration: both radios present, neither chosen, and Activate is inert until one is.
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /type="radio"[^>]*checked/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Activate schedule<\/button>/);
  assert.match(text, /Answer the made-for-kids question to activate/);

  // Videos: the finished ones are ticked, the unfinished one is listed but cannot be chosen.
  assert.match(text, /2 of 2 finished videos chosen/);
  assert.match(html, /type="checkbox"[^>]*checked=""[^>]*\/>\s*<span[^>]*>Productivity Isn&#x27;t Hustle/);
  assert.match(html, /type="checkbox"[^>]*disabled=""[^>]*\/>\s*<span[^>]*>Still Rendering/);
  assert.match(text, /Not finished yet/);

  // The preview: each chosen video with the exact Asia/Kolkata time, 09:00, on consecutive days from tomorrow.
  const tomorrow = addDays(wallClock(new Date()).date, 1);
  assert.match(text, new RegExp(`${formatInZone(zonedInstant(tomorrow, "09:00")).replace(/[()]/g, "\\$&")}`));
  assert.match(text, new RegExp(formatInZone(zonedInstant(addDays(tomorrow, 1), "09:00"))));
  assert.match(text, /Day 1 at 09:00/);
  assert.match(text, /Day 2 at 09:00/);
  assert.doesNotMatch(text, /Still Rendering\s+Day/, "an unfinished video is not scheduled");

  // The platform choice, YouTube ticked by default.
  assert.match(text, /Where to publish/);
  assert.match(text, /YouTube/);
  assert.match(text, /Instagram/);

  // Honest about what it does.
  assert.match(text, /uploaded now/);
  assert.match(text, /signed-in Chrome/);
  assert.match(text, /confirms the exact time/);
  assert.match(text, /Save draft/);
});

test("the panel opens on a saved draft's choices, and on the status of an active schedule", () => {
  const base = {
    id: "s1",
    uploadId: "u1",
    weekStart: "2026-10-05",
    days: 2,
    timeSlots: ["10:00", "20:00"],
    timezone: "Asia/Kolkata",
    platforms: ["youtube"],
    madeForKids: false,
    running: false,
    slots: [
      { id: "x1", episodeId: "a", title: "Productivity Isn't Hustle", platform: "youtube", position: 0, assignedAt: "2026-10-05T04:30:00.000Z", status: "pending", note: null, job: null },
      { id: "x2", episodeId: "b", title: "The Attention Trap", platform: "youtube", position: 1, assignedAt: "2026-10-05T14:30:00.000Z", status: "pending", note: null, job: null },
    ],
  };

  const draft = renderToStaticMarkup(React.createElement(Panel, { uploadId: "u1", videos: VIDEOS, initial: { ...base, status: "draft" } }));
  assert.match(draft, /value="2026-10-05"/);
  assert.match(draft, /type="radio"[^>]*checked=""[^>]*\/>\s*<span>No, they are not made for kids/);
  assert.match(draft.replace(/<[^>]+>/g, " "), /Mon 5 Oct 2026, 10:00/);

  const active = {
    ...base,
    status: "active",
    running: false,
    slots: [
      { ...base.slots[0], status: "scheduled", note: "YouTube confirmed Mon 5 Oct 2026, 10:00.", job: { status: "SCHEDULED", scheduledFor: "2026-10-05T04:30:00.000Z", externalUrl: "https://youtu.be/VID1", lastError: null } },
      { ...base.slots[1], status: "failed", note: "YouTube asked you to sign in." },
    ],
  };
  const status = renderToStaticMarkup(React.createElement(Panel, { uploadId: "u1", videos: VIDEOS, initial: active }));
  const text = status.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /Schedule status/);
  assert.match(text, /1 of 2 are scheduled or posted/);
  assert.match(text, /Scheduled/);
  assert.match(text, /Needs attention/);
  assert.match(text, /YouTube asked you to sign in/);
  assert.match(status, /href="https:\/\/youtu\.be\/VID1"/);
  assert.match(text, /Run again/, "a stopped schedule can be picked up");
  assert.match(text, /Plan another week/);

  // A javascript: URL is never an href.
  const evil = { ...active, slots: [{ ...active.slots[0], job: { ...active.slots[0].job, externalUrl: "javascript:alert(1)" } }, active.slots[1]] };
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Panel, { uploadId: "u1", videos: VIDEOS, initial: evil })), /javascript:/);
});

test("the schedule strings are whole sentences and say what Activate does", () => {
  const c = strings.schedule;
  assert.equal(c.button, "Weekly Schedule");
  assert.match(c.intro, /Spread this book's finished videos/);
  // YouTube is genuinely scheduled; the note says so and says what "scheduled" means here.
  assert.match(c.youtubeNote, /uploaded now/);
  assert.match(c.youtubeNote, /confirms the exact time/);
  // Instagram is NOT faked as scheduled: the note says it cannot be, and that this app posts it at the slot time.
  assert.match(c.instagramNote, /Schedule content/);
  assert.match(c.instagramNote, /disabled until explicitly enabled/);
  assert.match(c.activateNote, /no review step/);
  assert.equal(c.timezoneValue, "Asia/Kolkata");
});

test("activation rejects posts too close within one plan and across active plans", async () => {
  const s = await seed(2); seeds.push(s);
  const mock = recorder();
  const close = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00", "09:10"] })));
  await assert.rejects(activateSchedule(s.ownerId, close.id, { makePublisher: mock.makePublisher, waitForCompletion: true }), /at least 30/);
  assert.equal(mock.calls.length, 0);
  const first = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:00"], videoIds: [s.episodes[0]] })));
  await activateSchedule(s.ownerId, first.id, { makePublisher: mock.makePublisher, waitForCompletion: true });
  const second = must(await saveDraft(s.ownerId, draftBody(s, { days: 1, timeSlots: ["09:15"], videoIds: [s.episodes[1]] })));
  await rejects(activateSchedule(s.ownerId, second.id, { makePublisher: mock.makePublisher, waitForCompletion: true }), "schedule_conflict", 409);
  assert.equal(await prisma.publishJob.count({ where: { episodeId: s.episodes[1] } }), 0, "conflicting activation rolls back job creation");
});

test("a duplicate disabled Instagram reservation never blocks the YouTube lane", async () => {
  const s = await seed(1); seeds.push(s);
  const ig = must(await saveDraft(s.ownerId, draftBody(s, { platforms: ["instagram"], madeForKids: null })));
  await activateSchedule(s.ownerId, ig.id, { env: {}, waitForCompletion: true });
  const both = must(await saveDraft(s.ownerId, draftBody(s, { platforms: ["youtube", "instagram"] })));
  const mock = recorder();
  await activateSchedule(s.ownerId, both.id, { env: {}, makePublisher: mock.makePublisher, waitForCompletion: true });
  assert.equal(mock.calls.length, 1);
  assert.equal((await instagramRow(s.episodes[0]))?.attempts, 0);
  assert.equal((await scheduleView(s.ownerId, s.uploadId)).schedule?.slots.find(slot => slot.platform === "youtube")?.status, "scheduled");
});

test("read-only recovery confirms an exact known receipt without executing an upload", async () => {
  const { confirmKnownSchedules } = await import("../src/lib/schedule/confirm");
  const s = await seed(1); seeds.push(s);
  const draft = must(await saveDraft(s.ownerId, draftBody(s)));
  await prisma.weeklySchedule.update({ where: { id: draft.id }, data: { status: "active", workflowVersion: 2 } });
  const job = await prisma.publishJob.create({ data: { episodeId: s.episodes[0], platform: "youtube", mode: "browser", status: "AWAITING_HUMAN", remoteDraftId: "bookVideo01", metadata: JSON.stringify({ title: "Approved title" }), attempts: 1 } });
  await prisma.scheduleSlot.updateMany({ where: { scheduleId: draft.id }, data: { status: "failed", publishJobId: job.id } });
  assert.equal(await confirmKnownSchedules({ verify: async () => false }), 0);
  assert.equal((await prisma.publishJob.findUnique({ where: { id: job.id } }))?.status, "AWAITING_HUMAN");
  assert.equal(await confirmKnownSchedules({ verify: async candidate => {
    assert.equal(candidate.remoteId, "bookVideo01");
    assert.equal(candidate.title, "Approved title");
    assert.equal(candidate.at.toISOString(), draft.slots[0].assignedAt);
    return true;
  } }), 1);
  const confirmed = await prisma.publishJob.findUnique({ where: { id: job.id } });
  assert.equal(confirmed?.status, "SCHEDULED");
  assert.equal(confirmed?.attempts, 1);
  assert.equal(confirmed?.publishedAt, null);
  assert.equal((await scheduleView(s.ownerId, s.uploadId)).schedule?.slots[0].status, "scheduled");
});
