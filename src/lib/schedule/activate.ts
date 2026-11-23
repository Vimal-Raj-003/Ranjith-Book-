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
import { shuffledRingDurationAt } from "@/lib/publish/browser/pacing";

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
  /** Optional cooldown between consecutive upload attempts on the same platform (defaults to 2m 45s – 3m 45s shuffled loop in production, 0 in tests). */
  slotCooldownMs?: number | (() => number);
  /** Injectable sleep seam for testing queue cooldowns without wall-clock delay. */
  sleep?: (ms: number) => Promise<void>;
}

/** Bounds for the shuffled queue cooldown between consecutive uploads on the same platform (2m 45s to 3m 45s). */
export const MIN_QUEUE_COOLDOWN_MS = 165_000;
export const MAX_QUEUE_COOLDOWN_MS = 225_000;

interface QueueCooldownLoopState {
  step: number;
  lastMs: number | null;
}

export function computeQueueCooldownMs(options: RunScheduleOptions = {}, env: EnvLike = process.env): number {
  if (typeof options.slotCooldownMs === "number" && Number.isFinite(options.slotCooldownMs)) {
    return Math.max(0, options.slotCooldownMs);
  }
  if (typeof options.slotCooldownMs === "function") {
    const val = options.slotCooldownMs();
    return Number.isFinite(val) ? Math.max(0, val) : 0;
  }
  const rawEnv = env.BOOKREEL_QUEUE_COOLDOWN_MS?.trim().toLowerCase();
  if (rawEnv !== undefined && rawEnv !== "") {
    if (rawEnv === "loop" || rawEnv === "shuffle") {
      const stateHolder = globalThis as unknown as { bookreelQueueCooldownState?: QueueCooldownLoopState };
      // Start at step 3 so the cooldown ring is offset from the upload ring.
      const st = (stateHolder.bookreelQueueCooldownState ??= { step: 3, lastMs: null });
      const chosen = shuffledRingDurationAt(st.step, st.lastMs);
      st.step += 1;
      st.lastMs = chosen;
      return chosen;
    }
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  // Keep unit/integration test runs instant unless `slotCooldownMs` or `BOOKREEL_QUEUE_COOLDOWN_MS` is explicitly passed.
  if (
    options.makePublisher ||
    options.deps?.launch ||
    options.deps?.clock ||
    process.env.BOOKREEL_TEST_DB_PID ||
    process.env.NODE_TEST_CONTEXT
  ) {
    return 0;
  }
  const stateHolder = globalThis as unknown as { bookreelQueueCooldownState?: QueueCooldownLoopState };
  const st = (stateHolder.bookreelQueueCooldownState ??= { step: 3, lastMs: null });
  const chosen = shuffledRingDurationAt(st.step, st.lastMs);
  st.step += 1;
  st.lastMs = chosen;
  return chosen;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  remoteDraftId?: string | null;
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

const SYSTEMIC_HOLD_ERROR =
  /sign in|signed out|wants you to sign in|asked you to sign in|did not finish loading|security|challenge|captcha|2-step|two-step|verify your|upload limit|daily upload limit|does not match BookReel's configured channel|wrong (youtube|instagram)|did not say which (channel|account)|schedule content.*unavailable|does not offer schedule content|page crashed|browser has been closed/i;

const PER_VIDEO_ISOLATED_ERROR =
  /Audience and tag review|Audience\/tag review|Audience needs human review|stored video script|thumbnail is unavailable|Original could not be selected|cover was not applied|Studio Details settings could not be verified|schedule's time shows|schedule's date|less than (15|20) minutes away|no valid future publication time/i;

/**
 * True when an `AWAITING_HUMAN` job failed for an isolated per-video reason (either after
 * recording a post-upload checkpoint/draft ID, or on a single-episode pre-upload check such
 * as script/tag review timeout, missing thumbnail, or per-slot schedule/details verification)
 * rather than a systemic account/auth/quota/browser block. That individual video remains safely
 * held without duplicate upload while independent queued videos behind it continue.
 */
export function isPerVideoPostUploadHold(
  job: { status: string; externalId?: string | null; remoteDraftId?: string | null; lastError?: string | null } | null | undefined,
): boolean {
  if (!job || job.status !== "AWAITING_HUMAN") return false;
  const err = job.lastError ?? "";
  if (SYSTEMIC_HOLD_ERROR.test(err)) return false;
  const checkpoint = (job.externalId ?? job.remoteDraftId)?.trim();
  if (checkpoint) return true;
  return PER_VIDEO_ISOLATED_ERROR.test(err);
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
      return {
        status: "failed",
        note: lastError || "The browser window stopped for you. Check YouTube.",
        stop: !isPerVideoPostUploadHold(job),
      };
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

/** One slot. Returns whether the run should stop after it and whether an upload attempt actually ran. Never throws. */
async function runSlot(
  slot: { id: string; episodeId: string; assignedAt: Date; payloadJson: string | null; status: string },
  plan: Plan,
  options: RunScheduleOptions,
): Promise<{ stop: boolean; attempted: boolean }> {
  try {
    const claimed = await prisma.scheduleSlot.updateMany({ where: { id: slot.id, status: slot.status, controlState: "active" }, data: { status: "scheduling", note: "Starting platform verification" } });
    if (!claimed.count) return { stop: false, attempted: false };
    await settle(slot.episodeId, options);

    const platform = options.platform ?? "youtube";
    const native = platform === "instagram" || plan.youtubePrivacy === "public";
    const before = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
    const there = alreadyThere(before, slot.assignedAt, plan.timezone);
    if (there && before && !(options.acknowledgeRetry && before.status === "AWAITING_HUMAN")) {
      await setSlot(slot.id, { status: there.status, note: there.note, publishJobId: before.id });
      return { stop: false, attempted: false };
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
    return { stop: outcome.stop, attempted: true };
  } catch (err) {
    if ((options.platform ?? "youtube") === "youtube") await stopYouTubeRetry(slot.episodeId, err).catch(() => {});
    const message = err instanceof Error && err.message ? err.message : "The upload could not be started.";
    // The engine already refuses a second upload; if it says so, that is "already there", not a failure.
    const already = isAppError(err) && err.code === "already_on_platform";
    await setSlot(slot.id, { status: already ? "skipped" : "failed", note: message }).catch(() => {});
    return { stop: isAppError(err) && STOP_CODES.has(err.code), attempted: !already };
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
  const completedAttempts = new Map<PlatformId, number>();
  const sleep = options.sleep ?? defaultSleep;

  for (const slot of slots) {
    const platform = slot.platform as PlatformId;
    if (platform === "youtube" && !schedule.boardGrid && typeof schedule.madeForKids !== "boolean") continue;
    if (isSettledSlot(slot.status)) continue;
    if (slot.status === "scheduling") continue;
    const native = platform === "instagram" || schedule.youtubePrivacy === "public";
    if (!native && slot.assignedAt.getTime() > Date.now()) continue;

    if (options.automatic && slot.status === "failed") {
      const job = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
      if (job?.status === "SCHEDULED" || job?.status === "PUBLISHED") {
        const outcome = alreadyThere(job,slot.assignedAt,plan.timezone)!;
        await setSlot(slot.id,{status:outcome.status,note:outcome.note,publishJobId:job.id});
        continue;
      }
      if (isPerVideoPostUploadHold(job)) continue;
      const retryReady = job?.mode === "api" && (job.status === "QUEUED" || (job.retryAt && job.retryAt <= new Date()));
      if (!retryReady) { stopped.add(platform); continue; }
    }
    const state = await prisma.weeklySchedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
    if (state?.status !== "active") break;
    if (stopped.has(platform)) {
      await setSlot(slot.id, { status: "pending", note: "Not started: the run stopped at an earlier video that needs you." }).catch(() => {});
      continue;
    }

    // Queue Cooldown: wait 3 minutes between consecutive real upload attempts on
    // the same platform so videos are spaced naturally instead of firing back-to-back.
    if ((completedAttempts.get(platform) ?? 0) > 0) {
      const existingBeforeWait = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
      const alreadySettled = alreadyThere(existingBeforeWait, slot.assignedAt, schedule.timezone);
      if (!alreadySettled) {
        const cooldownMs = computeQueueCooldownMs(options, options.env ?? process.env);
        if (cooldownMs > 0) {
          let remaining = cooldownMs;
          let aborted = false;
          while (remaining > 0) {
            const liveState = await prisma.weeklySchedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
            const liveSlot = await prisma.scheduleSlot.findUnique({ where: { id: slot.id }, select: { controlState: true, status: true } });
            if (liveState?.status !== "active") { aborted = true; break; }
            if (!liveSlot || liveSlot.controlState !== "active" || isSettledSlot(liveSlot.status)) break;
            const secs = Math.ceil(remaining / 1000);
            const minsPart = Math.floor(secs / 60);
            const secsPart = secs % 60;
            const waitLabel = minsPart > 0 ? `${minsPart}m ${secsPart}s` : `${secsPart}s`;
            await prisma.scheduleSlot.updateMany({
              where: { id: slot.id, status: "pending" },
              data: { note: `Queue cooldown: waiting ${waitLabel} before starting the next ${platform} upload…` },
            }).catch(() => {});
            const step = options.sleep ? remaining : Math.min(remaining, 5_000);
            await sleep(step);
            remaining -= step;
          }
          if (aborted) break;
        }
      }
    }

    const now = Date.now();
    const minLeadMs = (platform === "instagram" ? 20 : 15) * 60_000;
    if (native && slot.assignedAt.getTime() > now && slot.assignedAt.getTime() < now + minLeadMs) {
      const existingNear = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform } } });
      const settledNear = alreadyThere(existingNear, slot.assignedAt, schedule.timezone);
      if (!settledNear) {
        const bumpedAt = new Date(Math.ceil((now + minLeadMs + 5 * 60_000) / 60_000) * 60_000);
        slot.assignedAt = bumpedAt;
        await prisma.scheduleSlot.update({ where: { id: slot.id }, data: { assignedAt: bumpedAt } }).catch(() => {});
      }
    }
    const missed = native ? slot.assignedAt.getTime() < now + minLeadMs : slot.assignedAt.getTime() < now - 45 * 60_000;
    if (missed) {
      const existing=await prisma.publishJob.findUnique({where:{episodeId_platform:{episodeId:slot.episodeId,platform}}});
      const settled=alreadyThere(existing,slot.assignedAt,schedule.timezone);
      if(settled&&existing){await setSlot(slot.id,{status:settled.status,note:settled.note,publishJobId:existing.id});continue;}
      const note = native ? "Not scheduled: the target time is past or too near for a native schedule. Move it to a future time." : "Missed: the server did not start this post within 45 minutes. It was held, not published late.";
      await setSlot(slot.id,{status:"failed",note});
      await holdMissedQueueItem(slot.publishJobId,note);
      continue;
    }

    const res = await runSlot(slot, plan, {...options,platform});
    if (res.attempted) {
      completedAttempts.set(platform, (completedAttempts.get(platform) ?? 0) + 1);
    }
    if (res.stop) stopped.add(platform);
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
