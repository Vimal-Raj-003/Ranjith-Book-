/**
 * Persisted native scheduling queue shared by YouTube and Instagram.
 * Videos run in order, Instagram then YouTube, with independent platform results. Publishers own upload jobs,
 * channel verification, durable checkpoints and platform confirmation; this
 * module claims slots, records their outcomes and stops uncertain lanes.
 */
import { prisma } from "@/lib/db";
import { isAppError } from "@/lib/errors";
import type { BrowserDeps, BrowserPublishOptions, BrowserPublisher } from "@/lib/publish/browser/engine";
import { recoverInterruptedBrowserJobs } from "@/lib/publish/browser/recover";
import { startBrowserPublish } from "@/lib/publish/browser/run";
import type { PlatformId } from "@/lib/publish/limits";
import type { EnvLike } from "@/lib/publish/youtube/secrets";
import { publishingEnabled } from "@/lib/publish/execution";
import type { PublishRequest } from "@/lib/publish/contract";
import { startYouTubePublish, stopYouTubeRetry } from "@/lib/publish/youtube/run";
import type { Fetcher } from "@/lib/publish/youtube/oauth";
import { DEFAULT_TIMEZONE, formatInZone } from "./time";
import { isSettledSlot, type SlotStatus } from "./view";
import { holdMissedQueueItem } from "./reconcile";
import { isPreUploadSpacingConflict } from "@/lib/publish/browser/instagram-calendar";

export interface RunScheduleOptions {
  /** Limit an explicit action to selected cells of an already active plan. */
  onlyPositions?: number[];
  verifyKnownSchedule?: import("./confirm").ScheduleVerifier;
  fetchImpl?: Fetcher;
  platform?: PlatformId;
  automatic?: boolean;
  acknowledgeRetry?: boolean;
  env?: EnvLike;
  /** Test seams, passed straight to `startBrowserPublish`. Production leaves them alone. */
  deps?: BrowserDeps;
  makePublisher?: (platform: PlatformId, options: BrowserPublishOptions) => BrowserPublisher;
  /** How often to look at a job someone else is running, and how long to wait for it. */
  pollMs?: number;
  maxWaitMs?: number;
}

const PLATFORM: PlatformId = "youtube";
const IN_FLIGHT = ["PREPARING", "UPLOADING"];
/** YouTube reads the time back to the minute; the same slack the engine's `sameSchedule` allows. */
const SAME_TIME_MS = 60_000;
/** Refusals that mean the browser route itself is unavailable: the next video would hit the same wall. */
const STOP_CODES = new Set(["requires_connection", "no_browser_publisher", "publish_client_stale", "needs_acknowledgement"]);

// On globalThis for the reason `live.ts` is: route handlers and hot reloads can each get their own
// copy of this module, and "is this schedule running?" must have one answer.
const g = globalThis as unknown as { bookreelScheduleRuns?: Set<string> };
const running: Set<string> = (g.bookreelScheduleRuns ??= new Set());

/** Is the runner working through this schedule in THIS process right now? */
export function isScheduleRunning(scheduleId: string): boolean {
  return running.has(`${scheduleId}:both`) || running.has(`${scheduleId}:youtube`) || running.has(`${scheduleId}:instagram`);
}

interface JobFacts {
  id: string;
  status: string;
  externalId: string | null;
  externalUrl: string | null;
  scheduledFor: Date | null;
  lastError: string | null;
}

export interface SlotOutcome {
  status: SlotStatus;
  note: string | null;
  /** True when the run should end here and leave the rest `pending`. */
  stop: boolean;
}

const sameTime = (a: Date | null, b: Date): boolean => a !== null && Math.abs(a.getTime() - b.getTime()) < SAME_TIME_MS;

export async function youtubeJob(episodeId: string): Promise<JobFacts | null> {
  const row = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform: PLATFORM } } });
  return row as JobFacts | null;
}

/**
 * Is the video already on YouTube, or shown there? Then the slot is done without
 * a request: nothing may be sent, and the existing job is left exactly as it is.
 * `null` means the video has no settled job and the runner may ask for one.
 */
export function alreadyThere(job: JobFacts | null, assignedAt: Date, timeZone: string = DEFAULT_TIMEZONE): SlotOutcome | null {
  if (!job) return null;
  if (job.status === "SCHEDULED") {
    if (sameTime(job.scheduledFor, assignedAt)) {
      return { status: "scheduled", note: `Already scheduled on YouTube for this time (${formatInZone(assignedAt, timeZone)}).`, stop: false };
    }
    const when = job.scheduledFor ? formatInZone(job.scheduledFor, timeZone) : "another time";
    return { status: "skipped", note: `Already scheduled on YouTube for ${when}; left as it is.`, stop: false };
  }
  if (job.status === "PUBLISHED") {
    return { status: "skipped", note: "Already posted on YouTube; nothing was sent.", stop: false };
  }
  if (job.externalId) {
    return {
      status: "skipped",
      note: `YouTube already showed a video for this episode (id ${job.externalId}), so no second upload was started. Check YouTube.`,
      stop: false,
    };
  }
  return null;
}

/**
 * What a job that the runner asked for (or is waiting on) says about its slot.
 * Only SCHEDULED at the slot's own time is `scheduled`: that status is written by
 * the engine after YouTube's page read the time back, and nothing else here may
 * stand in for it.
 */
export function slotOutcome(job: JobFacts | null, assignedAt: Date, timeZone: string = DEFAULT_TIMEZONE): SlotOutcome {
  if (!job) return { status: "failed", note: "No upload was recorded for this video.", stop: false };
  const lastError = job.lastError ?? "";
  switch (job.status) {
    case "SCHEDULED":
      return sameTime(job.scheduledFor, assignedAt)
        ? { status: "scheduled", note: `YouTube confirmed ${formatInZone(assignedAt, timeZone)}.`, stop: false }
        : {
            status: "failed",
            note: `YouTube scheduled it for ${job.scheduledFor ? formatInZone(job.scheduledFor, timeZone) : "a different time"}, not ${formatInZone(assignedAt, timeZone)}. Check YouTube Studio.`,
            stop: false,
          };
    case "PUBLISHED":
      return { status: "failed", note: "YouTube shows this as published now, not scheduled. Check the channel.", stop: false };
    case "PREPARING":
    case "UPLOADING":
      return { status: "scheduling", note: null, stop: false };
    case "AWAITING_HUMAN":
      return { status: "failed", note: lastError || "The browser window stopped for you. Check YouTube.", stop: true };
    case "REQUIRES_CONNECTION":
      return { status: "failed", note: lastError || "The YouTube browser route is not available.", stop: true };
    default:
      return { status: "failed", note: lastError || "The upload did not finish.", stop: false };
  }
}

async function setSlot(id: string, data: { status: SlotStatus; note?: string | null; publishJobId?: string | null }): Promise<void> {
  await prisma.scheduleSlot.update({ where: { id }, data });
}

/** Wait for a job someone else (or an earlier call) is running to leave PREPARING/UPLOADING. Bounded. */
async function settle(episodeId: string, options: RunScheduleOptions): Promise<void> {
  // A row left in flight by a restart is not in flight: hand it to a person, as everything else does.
  await recoverInterruptedBrowserJobs(episodeId).catch(() => 0);
  const end = Date.now() + (options.maxWaitMs ?? 30 * 60_000);
  for (;;) {
    const job = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform: options.platform ?? "youtube" } } });
    if (!job || !IN_FLIGHT.includes(job.status) || Date.now() >= end) return;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2000));
  }
}

interface Plan {
  userId: string;
  madeForKids: boolean | null;
  manualAudience: boolean;
  timezone: string;
  youtubePrivacy: string;
}

/** One slot. Returns whether the run should stop after it. Never throws. */
async function runSlot(
  slot: { id: string; episodeId: string; assignedAt: Date; payloadJson: string | null; status: string },
  plan: Plan,
  options: RunScheduleOptions,
): Promise<boolean> {
  try {
    const claimed = await prisma.scheduleSlot.updateMany({ where: { id: slot.id, status: slot.status, controlState: "active" }, data: { status: "scheduling", note: "Starting platform verification" } });
    if (!claimed.count) return false;
    await settle(slot.episodeId, options);

    const platform = options.platform ?? "youtube";
    const native = platform === "instagram" || plan.youtubePrivacy === "public";
    const before = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
    const there = alreadyThere(before, slot.assignedAt, plan.timezone);
    if (there && before && !(options.acknowledgeRetry && before.status === "AWAITING_HUMAN")) {
      await setSlot(slot.id, { status: there.status, note: there.note, publishJobId: before.id });
      return false;
    }

    console.log(`[schedule ${slot.id}] Upload start; platform=${platform}; target=${slot.assignedAt.toISOString()}; native=${native}`);
    if (platform === "youtube" && native && before?.mode === "api" && !options.makePublisher) {
      if (plan.manualAudience || plan.madeForKids === null) throw new Error("This existing API job cannot use browser audience review. Review its existing upload state before continuing; it was not switched to a new browser upload.");
      await startYouTubePublish(plan.userId, slot.episodeId, { scheduledAt: slot.assignedAt, madeForKids: plan.madeForKids,
        frozenRequest: slot.payloadJson ? JSON.parse(slot.payloadJson) as PublishRequest : undefined,
        waitForCompletion: true, env: options.env, fetchImpl: options.fetchImpl });
    } else await startBrowserPublish(plan.userId, slot.episodeId, platform, {
      scheduledAt: native ? slot.assignedAt : undefined,
      visibility: native ? undefined : plan.youtubePrivacy as "private" | "unlisted",
      madeForKids: plan.madeForKids ?? undefined,
      audienceMode: plan.manualAudience ? "review" : undefined,
      timezone: plan.timezone,
      acknowledgeRetry: options.acknowledgeRetry,
      frozenRequest: slot.payloadJson ? JSON.parse(slot.payloadJson) as PublishRequest : undefined,
      // The operator's Activate click is the go-live confirmation; the engine refuses a schedule without it.
      confirmPublic: true,
      // Await the job: the runner IS the detached work, and the next slot must not start until this one has settled.
      waitForCompletion: true,
      env: options.env,
      deps: options.deps,
      makePublisher: options.makePublisher,
    });
    await settle(slot.episodeId, options);

    const job = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
    const outcome: SlotOutcome = !native && job?.status === "PUBLISHED"
      ? {status:"published", note:`YouTube confirmed the ${plan.youtubePrivacy} video.`,stop:false}
      : slotOutcome(job, slot.assignedAt, plan.timezone);
    if (platform === "instagram" && outcome.note) outcome.note = outcome.note.replace(/YouTube/g, "Instagram");
    await setSlot(slot.id, { status: outcome.status, note: outcome.note, publishJobId: job?.id ?? null });
    return outcome.stop;
  } catch (err) {
    if ((options.platform ?? "youtube") === "youtube") await stopYouTubeRetry(slot.episodeId, err).catch(() => {});
    const message = err instanceof Error && err.message ? err.message : "The upload could not be started.";
    // The engine already refuses a second upload; if it says so, that is "already there", not a failure.
    const already = isAppError(err) && err.code === "already_on_platform";
    await setSlot(slot.id, { status: already ? "skipped" : "failed", note: message }).catch(() => {});
    return isAppError(err) && STOP_CODES.has(err.code);
  }
}

async function runSlots(scheduleId: string, options: RunScheduleOptions): Promise<void> {
  const schedule = await prisma.weeklySchedule.findUnique({ where: { id: scheduleId } });
  const enabled = (["instagram","youtube"] as const).filter(p=>(!options.platform || p===options.platform) && publishingEnabled(p, options.env ?? process.env));
  if (!enabled.length) return;
  // Board schedules require browser content review before an audience is selected.
  if (!schedule || schedule.status !== "active" || !schedule.userId) return;
  const plan: Plan = { userId: schedule.userId, madeForKids: schedule.madeForKids, manualAudience: schedule.boardGrid, timezone: schedule.timezone, youtubePrivacy: schedule.youtubePrivacy };

  // A platform lane uses the same queue, claim and confirmation rules.
  const slots = await prisma.scheduleSlot.findMany({
    where: { scheduleId, platform:{in:enabled}, episodeId: {not:""}, controlState: "active", ...(options.onlyPositions ? {position:{in:options.onlyPositions}} : {}) },
    orderBy: [{ position: "asc" },{platform:"asc"}],
  });
  const stopped = new Set<PlatformId>();
  for (const slot of slots) {
    const platform = slot.platform as PlatformId;
    if (platform === "youtube" && !schedule.boardGrid && typeof schedule.madeForKids !== "boolean") continue;
    if (isSettledSlot(slot.status)) continue;
    if (slot.status === "scheduling") continue;
    const native = platform === "instagram" || schedule.youtubePrivacy === "public";
    const now = Date.now();
    if (!native && slot.assignedAt.getTime() > now) continue;
    const missed = native ? slot.assignedAt.getTime() < now + (platform === "instagram" ? 20 : 15) * 60_000 : slot.assignedAt.getTime() < now - 45 * 60_000;
    if (missed) {
      const existing=await prisma.publishJob.findUnique({where:{episodeId_platform:{episodeId:slot.episodeId,platform}}});
      const settled=alreadyThere(existing,slot.assignedAt,schedule.timezone);
      if(settled&&existing){await setSlot(slot.id,{status:settled.status,note:settled.note,publishJobId:existing.id});continue;}
      const note = native ? "Not scheduled: the target time is past or too near for a native schedule. Move it to a future time." : "Missed: the server did not start this post within 45 minutes. It was held, not published late.";
      await setSlot(slot.id,{status:"failed",note});
      await holdMissedQueueItem(slot.publishJobId,note);
      continue;
    }
    if (options.automatic && slot.status === "failed") {
      const job = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
      if (job?.status === "SCHEDULED" || job?.status === "PUBLISHED") {
        const outcome = alreadyThere(job,slot.assignedAt,plan.timezone)!;
        await setSlot(slot.id,{status:outcome.status,note:outcome.note,publishJobId:job.id});
        continue;
      }
      // Do not retry this conflicted slot or change its time. The platform
      // explicitly refused it before upload, so later videos are safe to try.
      if (isPreUploadSpacingConflict(job)) continue;
      const retryReady = job?.mode === "api" && (job.status === "QUEUED" || (job.retryAt && job.retryAt <= new Date()));
      if (!retryReady) { stopped.add(platform); continue; }
    }
    const state = await prisma.weeklySchedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
    if (state?.status !== "active") break;
    if (stopped.has(platform)) {
      await setSlot(slot.id, { status: "pending", note: "Not started: the run stopped at an earlier video that needs you." }).catch(() => {});
      continue;
    }
    if (await runSlot(slot, plan, {...options,platform})) stopped.add(platform);
  }
}

/**
 * Run the schedule's slots in `position` order. Resolves when the run is over.
 * Does nothing if this process is already running it. NEVER REJECTS.
 */
export async function runSchedule(scheduleId: string, options: RunScheduleOptions = {}): Promise<void> {
  const key = `${scheduleId}:${options.platform ?? "both"}`;
  if (running.has(key) || running.has(`${scheduleId}:both`) || (!options.platform && isScheduleRunning(scheduleId))) return;
  running.add(key);
  try {
    await runSlots(scheduleId, options);
  } catch (error) {
    console.error(`[schedule ${key}] queue pass failed`, error instanceof Error ? error.message : String(error));
    // Per-slot failures are recorded on their slots; what reaches here is the database itself failing,
    // and a detached run has nowhere to report that. The slots keep whatever was last written.
  } finally {
    running.delete(key);
  }
}
