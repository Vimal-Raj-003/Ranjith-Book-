/**
 * SERVER-ONLY. Saving a weekly schedule, reading it back, and activating it.
 *
 * Outside the route handlers for the reason `publish/state.ts` is: the handlers'
 * other job is `currentUser()`, which reads `cookies()` and cannot run in a test,
 * so everything worth testing lives here and each handler is a few lines.
 *
 * THREE RULES, each enforced where the data is read rather than trusted from the
 * form:
 *
 *  1. A schedule holds only FINISHED videos of THIS book that THIS account owns.
 *     `startBrowserPublish` would refuse any other at upload time -- minutes into a
 *     run -- so they are refused here, at save, while the person is looking.
 *  2. ACTIVATING IS THE GO-LIVE CONFIRMATION. It needs the "made for kids" answer
 *     (a declaration this app never makes for anyone), and every slot that still
 *     has work to do must be at least `SCHEDULE_LEAD_MINUTES` away and still a
 *     finished video. Anything else is a 400 naming the slot, and nothing starts.
 *  3. THE VIEW NEVER INVENTS A STATUS. A slot reads `scheduled` only because the
 *     runner saw its `PublishJob` SCHEDULED; the job (with the time YouTube read
 *     back) travels beside it so the panel can show both.
 */
import type { PublishJob, WeeklySchedule } from "@prisma/client";
import { prisma, assertModels } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { loadPublishRequest } from "@/lib/publish/state";
import type { PublishRequest } from "@/lib/publish/contract";
import { publishingEnabled } from "@/lib/publish/execution";
import { connectionFor as youtubeConnection } from "@/lib/publish/youtube/accounts";
import { publicConfig as youtubeConfig } from "@/lib/publish/youtube/config";
import { validateWindows, checkSlots, checkAgainst, type SlotTime, type TimeWindow } from "./plan";
import { localParts } from "./reference-time";
import { MIN_SCHEDULE_LEAD_MS } from "@/lib/publish/browser/engine";
import { recoverInterruptedBrowserJobs } from "@/lib/publish/browser/recover";
import { alreadyThere, isScheduleRunning, runSchedule, slotOutcome, youtubeJob, type RunScheduleOptions } from "./activate";
import { alreadyPostedInstagram, instagramJob, instagramOutcome, isInstagramDuePassActive, startInstagramTicker } from "./due";
import { DEFAULT_TIMEZONE, configProblem, expandSchedule, formatInZone, isValidTimeZone, normaliseSlots, type ScheduleConfig } from "./time";
import {
  SCHEDULE_PLATFORMS,
  isSchedulePlatform,
  isSettledSlot,
  type EpisodeSlotResponse,
  type SchedulePlatform,
  type ScheduleResponse,
  type ScheduleStatus,
  type ScheduleView,
  type SlotStatus,
  type SlotView,
} from "./view";

/** A dev server that booted before the schedule tables existed has no `prisma.weeklySchedule`. */
function requireScheduleModels(): void {
  try {
    assertModels("weeklySchedule", "scheduleSlot");
  } catch (err) {
    throw new AppError("schedule_client_stale", err instanceof Error ? err.message : String(err), 503);
  }
}

const IN_FLIGHT = ["PREPARING", "UPLOADING"];

const badBody = (message: string): AppError => new AppError("bad_schedule", message, 400);

/** A finished video: rendered, and the file is recorded. The same test `publishEnabled` makes in the browser. */
const isFinished = (e: { status: string; videoPath: string | null }): boolean => e.status === "DONE" && Boolean(e.videoPath);

const label = (e: { title: string | null }): string => (e.title?.trim() ? `"${e.title.trim()}"` : "A video");

/** At most a handful of problems in one sentence: a long list is a wall nobody reads. */
function joinProblems(problems: string[]): string {
  const shown = problems.slice(0, 4).join(" ");
  return problems.length > 4 ? `${shown} (and ${problems.length - 4} more.)` : shown;
}

function parseSlots(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** The platforms a set of slots targets, youtube-first for stable display. */
function platformsOf(slots: readonly { platform: string }[]): SchedulePlatform[] {
  return SCHEDULE_PLATFORMS.filter((p) => slots.some((s) => s.platform === p));
}

/**
 * Resolve a slot whose `scheduling` spinner can no longer be running (a restart
 * killed the run that set it) into the status its `PublishJob` actually justifies.
 * Per platform: YouTube is `scheduled` only on a read-back; Instagram `published`
 * only on a confirmed share; a slot with no job yet goes back to `pending` so the
 * due-runner (Instagram) or Run again (YouTube) can pick it up.
 */
function healScheduling(
  platform: SchedulePlatform,
  job: PublishJob | null,
  assignedAt: Date,
  timeZone: string,
): { status: SlotStatus; note: string | null } {
  if (!job) return { status: "pending", note: null };
  if (job.status === "QUEUED") return { status: "pending", note: "Saved in the publishing queue." };
  if (platform === "instagram") return alreadyPostedInstagram(job) ?? instagramOutcome(job);
  return alreadyThere(job, assignedAt, timeZone) ?? slotOutcome(job, assignedAt, timeZone);
}

/** The wire shape, with each slot's title and the live job for ITS platform beside it. */
async function viewOf(schedule: WeeklySchedule): Promise<ScheduleView> {
  const slots = await prisma.scheduleSlot.findMany({ where: { scheduleId: schedule.id }, orderBy: [{ position: "asc" }, { platform: "asc" }] });
  const ids = slots.map((s) => s.episodeId);
  const [episodes, jobs] = await Promise.all([
    prisma.episode.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }),
    prisma.publishJob.findMany({ where: { platform: { in: SCHEDULE_PLATFORMS as unknown as string[] }, episodeId: { in: ids } } }),
  ]);
  const titleOf = new Map(episodes.map((e) => [e.id, e.title]));
  // Keyed by episode AND platform: a video published to both has two independent jobs.
  const jobOf = new Map(jobs.map((j) => [`${j.episodeId}:${j.platform}`, j]));
  const running = isScheduleRunning(schedule.id);

  const views: SlotView[] = [];
  for (const slot of slots) {
    const platform = slot.platform as SchedulePlatform;
    const job = jobOf.get(`${slot.episodeId}:${platform}`) ?? null;
    let status = slot.status as SlotStatus;
    let note = slot.note;
    // A slot says `scheduling` only while a run is working on it. If no run holds the schedule (a restart
    // killed it) and the job is not in flight either, read the job's real outcome rather than show a spinner
    // that will never finish. The guards cover work still in progress: a YouTube job PREPARING/UPLOADING, or
    // an Instagram post the due-runner is making right now (whose job row may not exist for its first instant).
    const liveNow = (job && IN_FLIGHT.includes(job.status)) || (platform === "instagram" && isInstagramDuePassActive());
    if (status === "scheduling" && !running && !liveNow) {
      const resolved = healScheduling(platform, job, slot.assignedAt, schedule.timezone);
      status = resolved.status;
      note = resolved.note;
      await prisma.scheduleSlot
        .update({ where: { id: slot.id }, data: { status, note, publishJobId: job?.id ?? null } })
        .catch(() => {});
    }
    views.push({
      id: slot.id,
      episodeId: slot.episodeId,
      title: titleOf.get(slot.episodeId) ?? null,
      platform,
      position: slot.position,
      assignedAt: slot.assignedAt.toISOString(),
      status,
      note,
      job: job
        ? {
            status: job.status,
            scheduledFor: job.scheduledFor ? job.scheduledFor.toISOString() : null,
            externalUrl: job.externalUrl,
            lastError: job.lastError,
            progress: job.progress,
          }
        : null,
    });
  }

  return {
    id: schedule.id,
    windows: schedule.windowsJson ? JSON.parse(schedule.windowsJson) as TimeWindow[] : undefined,
    seed: schedule.seed,
    endInclusive: schedule.endInclusive,
    instagramOffsetMinutes: schedule.instagramOffsetMinutes,
    instagramEnabled: publishingEnabled("instagram"),
    workerEnabled: process.env.BOOKREEL_SCHEDULE_WORKER_ENABLED === "1",
    workflowVersion: schedule.workflowVersion,
    uploadId: schedule.uploadId,
    weekStart: schedule.weekStart.toISOString().slice(0, 10),
    days: schedule.days,
    timeSlots: parseSlots(schedule.timeSlots),
    timezone: schedule.timezone,
    platforms: platformsOf(slots),
    madeForKids: schedule.madeForKids,
    status: schedule.status as ScheduleStatus,
    running,
    slots: views,
  };
}

/** The newest schedule for a book that belongs to this account, or `{ schedule: null }`. */
export async function scheduleView(userId: string, uploadId: string): Promise<ScheduleResponse> {
  requireScheduleModels();
  await recoverInterruptedBrowserJobs().catch(() => 0);
  const schedule = await prisma.weeklySchedule.findFirst({ where: { uploadId, userId }, orderBy: { createdAt: "desc" } });
  if (!schedule) return { schedule: null };
  const view = await viewOf(schedule);
  // A restart loses the due-runner's timer; reading an active Instagram schedule re-arms it, so the
  // panel being open (it polls this) keeps due Instagram slots posting. A no-op under tests and when idle.
  if (schedule.status === "active" && view.platforms.includes("instagram")) startInstagramTicker();
  return { schedule: view };
}

/**
 * Where one video sits in the newest ACTIVATED schedule of this account that holds it, or
 * `{ slot: null }`. A draft does not count: nothing has been confirmed for a draft, so it
 * must not decide when a video goes live. Read by the Publish page, which then posts at the
 * slot's exact instant rather than a time typed beside it; the slot is only READ here.
 *
 * Scoped to the viewer's own schedules: another account's schedule is not theirs to see, and
 * an ownerless schedule (none is ever written without an owner) is not matched.
 */
export async function episodeSlotView(userId: string, episodeId: string): Promise<EpisodeSlotResponse> {
  requireScheduleModels();
  const slots = await prisma.scheduleSlot.findMany({ where: { episodeId, controlState: "active" } });
  if (slots.length === 0) return { slot: null };
  const schedule = await prisma.weeklySchedule.findFirst({
    where: { id: { in: slots.map((s) => s.scheduleId) }, userId, status: "active" },
    orderBy: { createdAt: "desc" },
  });
  // Both platforms share the same instant for a video, so which slot is returned only decides the
  // status/note shown; prefer the YouTube one (the Publish page's time-lock is about scheduling).
  const mine = schedule ? slots.filter((s) => s.scheduleId === schedule.id) : [];
  const slot = mine.find((s) => s.platform === "youtube") ?? mine[0];
  if (!schedule || !slot) return { slot: null };
  return {
    slot: {
      scheduleId: schedule.id,
      slotId: slot.id,
      assignedAt: slot.assignedAt.toISOString(),
      timezone: schedule.timezone,
      madeForKids: schedule.madeForKids,
      status: slot.status as SlotStatus,
      note: slot.note,
    },
  };
}

/**
 * Create or update the book's DRAFT, replacing its slots. One draft per book: a
 * second save rewrites it, so the panel never accumulates abandoned drafts. A
 * schedule that is already ACTIVE is history and is not touched; saving after one
 * starts a new draft.
 */
export async function saveDraft(userId: string, body: unknown): Promise<ScheduleResponse> {
  requireScheduleModels();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("bad_body", "Expected a JSON object.", 400);
  const input = body as Record<string, unknown>;

  if (typeof input.uploadId !== "string" || input.uploadId === "") throw badBody("Say which book this schedule is for.");
  const upload = await prisma.upload.findUnique({ where: { id: input.uploadId }, select: { id: true, userId: true } });
  // Another account's book is "not found", not "forbidden": whether it exists is not theirs to learn.
  if (!upload || (upload.userId && upload.userId !== userId)) throw new AppError("not_found", "Not found", 404);

  const timezone = input.timezone === undefined || input.timezone === null ? DEFAULT_TIMEZONE : input.timezone;
  if (!isValidTimeZone(timezone)) throw badBody("That time zone is not recognised.");
  const config: ScheduleConfig = {
    weekStart: input.weekStart as string,
    days: input.days as number,
    timeSlots: input.timeSlots as string[],
    timezone,
  };
  if (input.windows !== undefined) {
    if (!Array.isArray(input.windows) || input.windows.length === 0 || input.windows.length > 8) throw badBody("Choose one to eight time windows.");
    const windows = input.windows as TimeWindow[];
    if (windows.some(w => !w || typeof w.start !== "string" || typeof w.end !== "string")) throw badBody("Every window needs start and end times.");
    const issues = validateWindows(windows, input.endInclusive === true);
    if (issues.length) throw badBody(issues.join(" "));
    if (input.seed !== undefined && !Number.isSafeInteger(input.seed)) throw badBody("The random seed must be a whole number.");
    config.windows = windows;
    config.timeSlots = windows.map(w => w.start);
    config.seed = input.seed as number ?? 1;
    config.endInclusive = input.endInclusive === true;
  }
  const instagramOffsetMinutes = input.instagramOffsetMinutes ?? 0;
  if (!Number.isInteger(instagramOffsetMinutes) || Number(instagramOffsetMinutes) < 0 || Number(instagramOffsetMinutes) > 120) throw badBody("Instagram offset must be 0 to 120 minutes.");
  const problem = configProblem(config);
  if (problem) throw badBody(problem);

  if (input.madeForKids !== undefined && input.madeForKids !== null && typeof input.madeForKids !== "boolean") {
    throw badBody("Made for kids must be yes or no.");
  }

  // Which platforms. Omitted means YouTube, the way it was before Instagram was an option.
  let platforms: SchedulePlatform[];
  if (input.platforms === undefined || input.platforms === null) {
    platforms = ["youtube"];
  } else if (!Array.isArray(input.platforms) || input.platforms.length === 0 || !input.platforms.every(isSchedulePlatform)) {
    throw badBody("Choose at least one platform: youtube or instagram.");
  } else {
    platforms = platformsOf((input.platforms as string[]).map((p) => ({ platform: p })));
  }

  if (!Array.isArray(input.videoIds) || input.videoIds.length === 0 || !input.videoIds.every((v) => typeof v === "string")) {
    throw badBody("Pick at least one video.");
  }
  const videoIds = [...new Set(input.videoIds as string[])];

  const episodes = await prisma.episode.findMany({
    where: { id: { in: videoIds } },
    select: { id: true, uploadId: true, userId: true, status: true, videoPath: true, title: true },
  });
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const problems: string[] = [];
  for (const id of videoIds) {
    const e = byId.get(id);
    if (!e || e.uploadId !== upload.id) problems.push("A selected video is not part of this book.");
    else if (e.userId !== userId) problems.push(`${label(e)} does not belong to this account, so it cannot be posted from here.`);
    else if (!isFinished(e)) problems.push(`${label(e)} is not a finished video yet.`);
  }
  if (problems.length > 0) throw badBody(joinProblems([...new Set(problems)]));

  let assignments;
  try {
    assignments = expandSchedule(config, videoIds);
  } catch (err) {
    throw badBody(err instanceof Error ? err.message : "Those settings do not make a schedule.");
  }

  const data = {
    userId,
    uploadId: upload.id,
    // A calendar date, kept as UTC midnight of that date. See the schema note on `weekStart`.
    weekStart: new Date(`${config.weekStart}T00:00:00.000Z`),
    days: config.days,
    timeSlots: JSON.stringify(normaliseSlots(config.timeSlots)),
    timezone,
    madeForKids: typeof input.madeForKids === "boolean" ? input.madeForKids : null,
    windowsJson: config.windows ? JSON.stringify(config.windows) : null,
    seed: config.seed ?? 1,
    endInclusive: config.endInclusive ?? false,
    instagramOffsetMinutes: Number(instagramOffsetMinutes),
  };

  const saved = await prisma.$transaction(async (tx) => {
    const draft = await tx.weeklySchedule.findFirst({
      where: { uploadId: upload.id, userId, status: "draft" },
      orderBy: { createdAt: "desc" },
    });
    const row = draft
      ? await tx.weeklySchedule.update({ where: { id: draft.id }, data })
      : await tx.weeklySchedule.create({ data: { ...data, status: "draft" } });
    await tx.scheduleSlot.deleteMany({ where: { scheduleId: row.id } });
    // One slot per (video, platform): a video on both platforms gets two slots at the same instant,
    // each tracked on its own so one platform's outcome never overwrites the other's.
    await tx.scheduleSlot.createMany({
      data: platforms.flatMap((platform) =>
        assignments.map((a) => ({ scheduleId: row.id, episodeId: a.episodeId, platform, assignedAt: new Date(a.assignedAt.getTime() + (platform === "instagram" ? Number(instagramOffsetMinutes) * 60_000 : 0)), position: a.position })),
      ),
    });
    return row;
  });
  return { schedule: await viewOf(saved) };
}

export interface ActivateOptions extends RunScheduleOptions {
  /** Await the whole run instead of letting it go on detached. For tests only. */
  waitForCompletion?: boolean;
  /** Test seam for "now", so the 15-minute rule can be checked without waiting. */
  now?: number;
}

export async function controlSchedule(userId: string, scheduleId: string, action: unknown, options: ActivateOptions = {}): Promise<ScheduleResponse> {
  const schedule = await prisma.weeklySchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule || schedule.userId !== userId) throw new AppError("not_found", "Not found", 404);
  if (action === "retry" && !options.acknowledgeRetry) throw new AppError("check_platform", "Check the platform for existing drafts or schedules before retrying.", 409);
  if (action === "resume" || action === "retry") {
    if (schedule.status === "cancelled") throw badBody("A cancelled schedule cannot resume. Create a new draft.");
    return activateSchedule(userId, scheduleId, options);
  }
  if (action !== "pause" && action !== "cancel") throw badBody("Choose pause, resume, retry or cancel.");
  const row = await prisma.weeklySchedule.update({ where: { id: scheduleId }, data: { status: action === "pause" ? "paused" : "cancelled" } });
  // Local pause/cancel stops further queue work; it never claims to undo an
  // already confirmed platform schedule.
  return { schedule: await viewOf(row) };
}

/**
 * Validate, mark the schedule ACTIVE, and kick the runner. Returns the view at
 * once; the run goes on detached while the panel polls.
 *
 * Re-activating an active schedule is how a stopped run is picked up again: the
 * slots that are done (`scheduled`, `skipped`) are not validated or touched.
 */
export async function activateSchedule(userId: string, scheduleId: string, options: ActivateOptions = {}): Promise<ScheduleResponse> {
  requireScheduleModels();
  const schedule = await prisma.weeklySchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule || schedule.userId !== userId) throw new AppError("not_found", "Not found", 404);
  if (schedule.status === "cancelled") throw badBody("A cancelled schedule cannot resume. Create a new draft.");

  // Already being worked on in this process: say so rather than queueing a second pass.
  if (isScheduleRunning(schedule.id)) return { schedule: await viewOf(schedule) };

  const slots = await prisma.scheduleSlot.findMany({ where: { scheduleId, episodeId: {not:""}, controlState: "active", ...(options.onlyPositions?{position:{in:options.onlyPositions}}:{}) }, orderBy: [{ position: "asc" }, { platform: "asc" }] });
  if (slots.length === 0) throw badBody("This schedule has no videos in it. Save it with at least one video first.");
  const platforms = platformsOf(slots);

  // "Made for kids" is YouTube's legal declaration; an Instagram-only schedule has no such field to answer.
  if (platforms.includes("youtube") && !schedule.boardGrid && typeof schedule.madeForKids !== "boolean") {
    throw new AppError(
      "made_for_kids_required",
      "Say whether these videos are made for kids. YouTube requires an answer and it is a declaration only you can make, so BookReel never assumes one. Nothing was sent.",
      400,
    );
  }

  const episodes = await prisma.episode.findMany({
    where: { id: { in: slots.map((s) => s.episodeId) } },
    select: { id: true, uploadId: true, userId: true, status: true, videoPath: true, title: true },
  });
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const now = options.now ?? Date.now();

  const problems: string[] = [];
  const snapshots = new Map<string, PublishRequest>();
  for (const slot of slots) {
    if (!publishingEnabled(slot.platform as SchedulePlatform, options.env ?? process.env)) {
      // Prepare disabled-platform jobs without blocking YouTube on their readiness.
      try { snapshots.set(slot.id, (await loadPublishRequest(userId, slot.episodeId, slot.platform as SchedulePlatform)).request); }
      catch { /* The disabled lane validates again when explicitly enabled. */ }
      continue;
    }
    // Recheck unfinished enabled slots, including retries whose lead time has elapsed.
    if (isSettledSlot(slot.status)) continue;
    const e = byId.get(slot.episodeId);
    const name = label(e ?? { title: null });
    // A video that already has a settled job FOR THIS PLATFORM is skipped by the runner, whatever its time.
    const there =
      slot.platform === "instagram"
        ? alreadyPostedInstagram(await instagramJob(slot.episodeId))
        : alreadyThere(await youtubeJob(slot.episodeId), slot.assignedAt, schedule.timezone);
    if (there && !(options.acknowledgeRetry && slot.status === "failed")) continue;
    if (!e || (!schedule.boardGrid && e.uploadId !== schedule.uploadId) || e.userId !== userId || !isFinished(e)) {
      problems.push(`${name} is no longer a finished video of this book.`);
    }
    const lead = slot.platform === "instagram" ? 20 * 60_000 : MIN_SCHEDULE_LEAD_MS;
    if (slot.assignedAt.getTime() < now + lead) {
      problems.push(
        `${name} is set for ${formatInZone(slot.assignedAt, schedule.timezone)}, which is in the past or less than ${lead / 60_000} minutes away. ${slot.platform === "instagram" ? "Instagram needs at least 20 minutes" : "YouTube needs at least 15 minutes"}.`,
      );
    }
    try {
      const { request } = await loadPublishRequest(userId, slot.episodeId, slot.platform as SchedulePlatform);
      snapshots.set(slot.id, request);
    } catch (error) { problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (problems.length > 0) throw badBody(`${joinProblems(problems)} Nothing was sent.`);

  // RepoReel's default preparation lead (20 minutes) plus its 10-minute gap.
  // Native jobs upload ahead; these checks still preserve the intended cadence.
  const minGapMinutes = 30;
  const countPerDay = Math.max(1, JSON.parse(schedule.timeSlots).length);
  const asTime = (slot: { id: string; assignedAt: Date; position: number }): SlotTime => {
    const local = localParts(slot.assignedAt, schedule.timezone);
    return { key: slot.id, day: Math.floor(slot.position / countPerDay), position: slot.position % countPerDay + 1, localDate: local.date, localTime: local.time, scheduledAt: slot.assignedAt };
  };
  const enabledTimes = (platform: string) => slots.filter(slot => slot.platform === platform && snapshots.has(slot.id) && !isSettledSlot(slot.status)).map(asTime);
  for (const platform of platforms) {
    if (!publishingEnabled(platform, options.env ?? process.env)) continue;
    const issues = checkSlots(enabledTimes(platform), { now: new Date(now), timezone: schedule.timezone, windows: [], endInclusive: false, minGapMinutes, minAheadMinutes: platform === "instagram" ? 20 : 15 });
    const errors = issues.filter(issue => issue.severity === "error");
    if (errors.length) throw badBody(`${errors.map(issue => issue.message).join(" ")} Nothing was sent.`);
  }

  // Board schedules require the browser's content-review gate before choosing
  // an audience. Keep prior answers; a saved true answer requires human review.
  const apiReady = !schedule.boardGrid && typeof schedule.madeForKids === "boolean" && !options.makePublisher && youtubeConfig(options.env ?? process.env).configured && (await youtubeConnection(userId, options.env ?? process.env)).connected;
  const active = await prisma.$transaction(async tx => {
    const latest=await tx.weeklySchedule.findUnique({where:{id:scheduleId}});
    const current=await tx.scheduleSlot.findMany({where:{id:{in:slots.map(s=>s.id)}}});
    if(!latest || latest.updatedAt.getTime()!==schedule.updatedAt.getTime() || slots.some(s=>{const row=current.find(r=>r.id===s.id);return !row||row.episodeId!==s.episodeId||row.assignedAt.getTime()!==s.assignedAt.getTime()||row.controlState!==s.controlState;})) {
      throw new AppError("schedule_changed","The draft changed while it was being validated. Review the saved plan and activate again; nothing was queued.",409);
    }
    // Reserve videos across active plans in the same transaction as queue creation.
    const otherPlans = await tx.weeklySchedule.findMany({ where: { id: { not: scheduleId }, userId, status: { in: ["active", "paused"] } }, select: { id: true } });
    for (const slot of slots) {
      if (!snapshots.has(slot.id)) continue;
      const duplicate = await tx.scheduleSlot.findFirst({ where: { scheduleId: { in: otherPlans.map(p => p.id) }, episodeId: slot.episodeId, platform: slot.platform, controlState:{not:"cancelled"}, status: { notIn: ["skipped"] } } });
      if (duplicate) {
        if (!publishingEnabled(slot.platform as SchedulePlatform, options.env ?? process.env)) continue;
        throw new AppError("schedule_duplicate", "This video is already reserved by another active or paused schedule on this platform.", 409);
      }
      const frozen = slot.payloadJson ?? JSON.stringify(snapshots.get(slot.id));
      const jobMode = slot.platform === "youtube" && apiReady && schedule.youtubePrivacy === "public" ? "api" : "browser";
      const jobOptions = JSON.stringify({ scheduledAt: schedule.youtubePrivacy === "public" || slot.platform === "instagram" ? slot.assignedAt : null, visibility: schedule.youtubePrivacy, madeForKids: schedule.madeForKids, audienceMode: schedule.boardGrid ? "review" : undefined, timezone: schedule.timezone });
      const jobMetadata = JSON.stringify(snapshots.get(slot.id)!.metadata);
      let job = await tx.publishJob.upsert({ where: { episodeId_platform: { episodeId: slot.episodeId, platform: slot.platform } },
        create: { episodeId: slot.episodeId, platform: slot.platform, mode: jobMode, status: "QUEUED", metadata: jobMetadata, optionsJson: jobOptions }, update: {} });
      if (!job.externalId && !job.remoteDraftId && !job.sessionUrlEnc && (["CANCELLED", "FAILED", "REQUIRES_CONNECTION", "HELD"].includes(job.status) || (job.status === "AWAITING_HUMAN" && (options.acknowledgeRetry || options.onlyPositions?.length)))) {
        const recovered = await tx.publishJob.updateMany({
          where: { id: job.id, updatedAt: job.updatedAt, status: job.status, externalId: null, remoteDraftId: null, sessionUrlEnc: null },
          data: { mode: jobMode, status: "QUEUED", lastError: null, progress: null, retryAt: null, metadata: jobMetadata, optionsJson: jobOptions },
        });
        if (recovered.count === 1) job = (await tx.publishJob.findUnique({ where: { id: job.id } })) ?? job;
      }
      await tx.scheduleSlot.update({ where: { id: slot.id }, data: { payloadJson: frozen, publishJobId: job.id,
        ...(!publishingEnabled(slot.platform as SchedulePlatform, options.env ?? process.env) ? { note: "Instagram execution is disabled; YouTube proceeds independently." } : {}) } });
    }
    for (const platform of platforms) {
      if (!publishingEnabled(platform, options.env ?? process.env)) continue;
      const foreign = await tx.scheduleSlot.findMany({ where: { scheduleId: { in: otherPlans.map(plan => plan.id) }, platform, controlState:{not:"cancelled"}, status: { notIn: ["skipped"] } }, select: { id: true, assignedAt: true, position: true } });
      const conflicts = checkAgainst(enabledTimes(platform), foreign.map(asTime), minGapMinutes);
      if (conflicts.length) throw new AppError("schedule_conflict", conflicts.map(issue => issue.message).join(" "), 409);
    }
    return tx.weeklySchedule.update({ where: { id: schedule.id }, data: { status: "active", workflowVersion: 2, activatedAt: schedule.activatedAt ?? new Date(now) } });
  }, { timeout: 30_000 });

  // Both native platform schedules upload ahead through the same persisted worker.
  if (platforms.includes("instagram")) startInstagramTicker();

  // One dispatcher settles Instagram then YouTube for each video. Results and
  // safety stops remain platform-specific; confirmed uploads are never repeated.
  const work = runSchedule(schedule.id, options);
  // `runSchedule` never rejects; the catch is belt and braces for a detached promise.
  if (options.waitForCompletion) await work;
  else void work.catch(() => {});
  return { schedule: await viewOf(active) };
}
