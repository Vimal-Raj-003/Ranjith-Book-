/**
 * SERVER-ONLY. Starting a YouTube publish, and recording what it actually does.
 *
 * This is the module that owns the `PublishJob` row while an upload is in
 * flight. Everything it writes is something that happened: `PREPARING` when the
 * request has been validated and a session is being opened, `UPLOADING` with
 * the byte count YOUTUBE acknowledged, and then `PUBLISHED` with the id YouTube
 * returned or `FAILED` with the mapped reason. There is no state in here that
 * describes an intention.
 *
 * WHY IT RUNS DETACHED FROM THE REQUEST. A 38 MB upload is tens of seconds. A
 * route that awaited it would hold a connection open for that long, show
 * nothing until it finished, and lose the whole thing if the operator navigated
 * away. So `start()` validates everything synchronously (so a refusal is an
 * immediate 409 with a reason, not a failure discovered later), writes the row,
 * and then lets the upload continue in the background while the Publish Center
 * polls `GET .../publish`. The progress the panel shows is read from the row
 * this module writes, which is read from what YouTube said.
 *
 * WHY A RETRY IS SAFE — the hard rule "retry must not re-upload an
 * already-uploaded video", in three layers:
 *
 *  1. A job that already holds an `externalId` is NOT re-uploaded. `start()`
 *     returns the existing state. The only way past that is the operator
 *     deliberately clearing it, which this app does not offer.
 *  2. A job with a recorded resumable session is RESUMED. `uploadVideo` asks
 *     YouTube how many bytes it holds and sends only the rest — and if that
 *     session turns out to have completed, it returns the video id and uploads
 *     nothing at all.
 *  3. An upload already running in this process is not started twice.
 *     `RUNNING` is an in-process guard, so two clicks (or a double-submit) get
 *     one upload.
 *
 * Layer 3 is in-process and so does not survive a restart; layers 1 and 2 are
 * in the database and do. That ordering is deliberate — the durable protections
 * are the ones that matter, and the in-memory one only removes a race.
 */
import { prisma } from "@/lib/db";
import { recordAttempt } from "@/lib/publish/history";
import { AppError } from "@/lib/errors";
import { isPublishRefused, type PreparedPublish, type PublishProgress, type PublishRequest } from "../contract";
import { loadPublishRequest, publishView } from "../state";
import type { PublishView } from "../view";
import { YOUTUBE_PROVIDER, UPLOAD_PRIVACY, publicConfig } from "./config";
import { connectionFor, verifyChannelIdentity } from "./accounts";
import { youTubePublisher } from "./publisher";
import { open, seal, sessionAad, type EnvLike } from "./secrets";
import { hasReadonlyScope, type Fetcher } from "./oauth";
import { identitySentence } from "../connect";
import { expectedHandle } from "../identity";
import { browserHolds } from "../limits";

/** Episodes with an upload running in THIS process. See layer 3 above. */
const apiState = globalThis as unknown as { bookreelYouTubeUploads?: Set<string> };
const RUNNING = (apiState.bookreelYouTubeUploads ??= new Set<string>());

const keyOf = (episodeId: string) => `${YOUTUBE_PROVIDER}:${episodeId}`;

export interface StartOptions {
  queueOrigin?: "operator-immediate";
  scheduledAt?: Date;
  madeForKids?: boolean;
  frozenRequest?: PublishRequest;
  env?: EnvLike;
  fetchImpl?: Fetcher;
  /**
   * Await the upload instead of letting it run detached.
   *
   * For tests only. A test that returned before the upload finished would have
   * to poll the database to find out what happened, and a flaky sleep is not a
   * test. Production callers leave it alone: a route that awaited a 38 MB
   * upload is the problem this module's shape exists to avoid.
   */
  waitForCompletion?: boolean;
}

/** Is an upload for this episode running in this process right now? */
export function isUploading(episodeId: string): boolean {
  return RUNNING.has(keyOf(episodeId));
}

/** Recover only resumable API work. Uncertain work without a durable session
 * stays with a person; a browser job is never converted to an API upload. */
export async function recoverYouTubeUploads(): Promise<void> {
  const jobs = await prisma.publishJob.findMany({ where: { platform: "youtube", mode: "api", status: { in: ["PREPARING", "UPLOADING"] } } });
  for (const job of jobs) {
    if (isUploading(job.episodeId)) continue;
    if (job.workerPid && job.workerPid !== process.pid) {
      try { process.kill(job.workerPid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    await prisma.publishJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: job.updatedAt }, data: {
      status: job.sessionUrlEnc ? "QUEUED" : "AWAITING_HUMAN",
      lastError: job.sessionUrlEnc ? "The server restarted; the saved resumable session will be checked before sending bytes." : "The server restarted before a resumable session was durably recorded. Inspect Studio before retrying.",
    } });
  }
}

/** A validation failure must clear durable retry eligibility instead of spinning each tick. */
export async function stopYouTubeRetry(episodeId: string, error: unknown): Promise<void> {
  await prisma.publishJob.updateMany({
    where: { episodeId, platform: "youtube", mode: "api", status: { in: ["QUEUED", "FAILED"] }, externalId: null },
    data: { status: "FAILED", retryAt: null, lastError: error instanceof Error ? error.message : String(error) },
  });
}

type JobRow = {
  id: string;
  updatedAt: Date;
  status: string;
  externalId: string | null;
  sessionUrlEnc: string | null;
  optionsJson?: string | null;
  attempts: number;
  mode?: string | null;
};

async function currentJob(episodeId: string): Promise<JobRow | null> {
  const row = await prisma.publishJob.findUnique({
    where: { episodeId_platform: { episodeId, platform: YOUTUBE_PROVIDER } },
  });
  return (row as JobRow | null) ?? null;
}

/**
 * Begin a publish, or explain why not.
 *
 * Returns the whole `PublishView`, the way every other write on this surface
 * does, so the client never has to re-fetch to see what its own action
 * produced.
 */
export async function startYouTubePublish(
  userId: string,
  episodeId: string,
  options: StartOptions = {},
): Promise<PublishView> {
  const env = options.env ?? process.env;

  // OWNERSHIP FIRST, before anything is read about the episode or any
  // credential is touched: this is an external, irreversible action, and
  // `loadPublishRequest` is the strict rule (`userId === user.id`), not the
  // generous one the rest of this surface reads with.
  const { request: currentRequest } = await loadPublishRequest(userId, episodeId);
  const request = options.frozenRequest ?? currentRequest;
  if (request.episodeId !== episodeId) throw new AppError("bad_snapshot", "The saved upload belongs to another video.", 409);
  if (options.scheduledAt && typeof options.madeForKids !== "boolean") throw new AppError("made_for_kids_required", "YouTube scheduling requires the saved made-for-kids answer.", 400);

  const existing = await currentJob(episodeId);
  if (existing?.externalId) {
    // Layer 1. The platform already has this video; a second upload would put
    // a duplicate on the channel and there would be no way to tell from here
    // which one the operator meant to keep.
    return publishView(userId, episodeId, options);
  }
  if (RUNNING.has(keyOf(episodeId))) {
    // Layer 3. Already in flight in this process.
    return publishView(userId, episodeId, options);
  }
  if (existing?.mode === "api" && ["PREPARING", "UPLOADING"].includes(existing.status)) {
    // A second server/request must not steal an in-flight resumable upload.
    // Startup recovery alone changes a dead owner's job back to QUEUED.
    return publishView(userId, episodeId, options);
  }
  if (existing?.mode === "api" && existing.status === "AWAITING_HUMAN" && !existing.sessionUrlEnc) {
    throw new AppError("check_platform", "The previous upload has no durable resumable session. Inspect Studio before creating another upload. Nothing was sent.", 409);
  }
  if (existing?.sessionUrlEnc) {
    let previous: { scheduledAt?: string };
    try { previous = JSON.parse(existing.optionsJson ?? "{}"); }
    catch { throw new AppError("unreadable_session", "The saved upload options cannot be read. Inspect Studio before retrying.", 409); }
    if ((previous.scheduledAt ?? null) !== (options.scheduledAt?.toISOString() ?? null)) {
      throw new AppError("schedule_changed", "The saved resumable upload belongs to a different publication time. Inspect and reschedule that video in Studio; no second upload was started.", 409);
    }
  }
  if (browserHolds(existing)) {
    // The optional browser-window route holds this row: it is running, or it stopped
    // for a person and what it did on YouTube is not known. Two routes must not both
    // post one episode, so this one waits until that is settled.
    throw new AppError(
      "browser_job_holds",
      "A browser-window publish holds this episode on YouTube: it is running, or it stopped for you to check. " +
        "Settle that first (the video may already be on the channel). Nothing was sent.",
      409,
    );
  }

  const config = publicConfig(env);
  if (!config.configured) {
    throw new AppError(
      "requires_connection",
      "This server is not configured to publish to YouTube, so it cannot post for you. " +
        `Missing: ${config.missing.join(", ")}. Use the handoff below instead — nothing was sent.`,
      409,
    );
  }

  // THE IDENTITY GATE. A channel YouTube itself reported as a different one than
  // this install publishes to is refused before anything is prepared or sent.
  // A connection that merely predates the identity scope is not blocked: it
  // keeps the upload ability it was granted (and the card tells the operator to
  // reconnect to verify).
  const view = await connectionFor(userId, env);
  if (view.connected && view.identityBlocksPublish) {
    throw new AppError("identity_blocked", `${view.identityNote ?? "This channel is not verified."} Nothing was sent.`, 409);
  }
  if (view.connected && hasReadonlyScope(view.scopes.join(" "))) {
    // And once more LIVE, from the API, at the moment of the upload: the stored
    // handle was read when the operator connected, and a publish is the one
    // action that cannot be taken back. A lookup that cannot be made at all
    // (network) falls back to the stored, API-sourced verdict above; a lookup
    // that answers with a different channel, or with none, stops the upload.
    const identityFetch: Fetcher = (url, init) => (options.fetchImpl ?? fetch)(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
    const live = await verifyChannelIdentity(userId, env, identityFetch);
    if (live.verdict === "mismatch" || (live.verdict === "unverified" && live.channelId !== null)) {
      throw new AppError(
        "identity_blocked",
        `${identitySentence("YouTube", live.verdict, live.handle, expectedHandle("youtube", env)) ?? "This channel is not verified."} Nothing was sent.`,
        409,
      );
    }
  }

  const publisher = youTubePublisher({ userId, env, fetchImpl: options.fetchImpl, madeForKids: options.madeForKids, schedule: options.scheduledAt ? { at: options.scheduledAt, madeForKids: options.madeForKids! } : undefined });
  if (!(await publisher.isConfigured())) {
    throw new AppError(
      "requires_connection",
      "No YouTube account is connected for this user, so nothing was sent. Connect YouTube and try again.",
      409,
    );
  }

  let prepared: PreparedPublish;
  try {
    prepared = await publisher.prepare(request);
  } catch (err) {
    if (isPublishRefused(err)) throw new AppError("refused", err.problems.join(" "), 409);
    throw err;
  }

  // The row goes to PREPARING before anything leaves this machine, so a reader
  // that arrives a millisecond later sees work starting rather than nothing.
  // `uploadedBytes` is zeroed rather than left stale: a previous attempt's
  // count beside a new attempt's total would be a lie about this attempt.
  const resumeFrom = existing?.sessionUrlEnc
    ? (() => {
        try {
          return open(existing.sessionUrlEnc!, sessionAad(episodeId), env);
        } catch {
          // A session we can no longer decrypt is a session we cannot resume.
          // An unreadable receipt cannot authorize another upload.
          throw new AppError("unreadable_session", "The earlier YouTube upload session cannot be decrypted. Inspect Studio before retrying; another upload was not started.", 409);
        }
      })()
    : null;

  const base = {
    mode: "api",
    workerPid: process.pid,
    heartbeatAt: new Date(),
    retryAt: null,
    status: "PREPARING",
    metadata: JSON.stringify(prepared.metadata),
    optionsJson: JSON.stringify({ scheduledAt: options.scheduledAt?.toISOString() ?? null, madeForKids: options.madeForKids, queueOrigin:options.queueOrigin, confirmPublic:options.queueOrigin === "operator-immediate", frozenRequest:options.frozenRequest }),
    preparedAt: prepared.preparedAt,
    lastError: null,
    totalBytes: prepared.video.bytes,
    uploadedBytes: 0,
    thumbnailStatus: null,
    thumbnailError: null,
    privacyStatus: UPLOAD_PRIVACY,
  };
  if (existing) {
    const claimed = await prisma.publishJob.updateMany({ where: { id: existing.id, updatedAt: existing.updatedAt, externalId: null }, data: { attempts: { increment: 1 }, ...base } });
    if (!claimed.count) return publishView(userId, episodeId, options);
  } else {
    try { await prisma.publishJob.create({ data: { episodeId, platform: YOUTUBE_PROVIDER, attempts: 1, ...base } }); }
    catch (error) { if ((error as { code?: string }).code === "P2002") return publishView(userId, episodeId, options); throw error; }
  }

  RUNNING.add(keyOf(episodeId));
  await recordAttempt(episodeId, "youtube").catch(error=>console.error("[publish history]",error instanceof Error?error.message:String(error)));
  const work = runUpload(userId, episodeId, prepared, resumeFrom, options).finally(async () => {
    RUNNING.delete(keyOf(episodeId));
    await recordAttempt(episodeId, "youtube").catch(error=>console.error("[publish history]",error instanceof Error?error.message:String(error)));
  });

  if (options.waitForCompletion) {
    await work;
  } else {
    // Detached on purpose — see the header. The catch is not optional: an
    // unhandled rejection in a detached promise takes the dev server down.
    void work.catch(() => {});
  }

  return publishView(userId, episodeId, options);
}

/**
 * The upload itself, and the single place that turns an outcome into a row.
 *
 * Note what is NOT here: there is no branch that writes `PUBLISHED` from
 * anything but `outcome.status === "PUBLISHED"`, and that variant cannot be
 * constructed without an `externalId` the platform returned. The honesty is in
 * the type, not in this function's discipline.
 */
async function runUpload(
  userId: string,
  episodeId: string,
  prepared: PreparedPublish,
  resumeFrom: string | null,
  options: StartOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const where = { episodeId_platform: { episodeId, platform: YOUTUBE_PROVIDER } };
  const publisher = youTubePublisher({ userId, env, fetchImpl: options.fetchImpl, madeForKids: options.madeForKids, schedule: options.scheduledAt ? { at: options.scheduledAt, madeForKids: options.madeForKids! } : undefined });

  const writeProgress = async (progress: PublishProgress) => {
    await prisma.publishJob
      .update({
        where,
        data: {
          status: progress.status,
          uploadedBytes: progress.bytesSent,
          totalBytes: progress.totalBytes,
          heartbeatAt: new Date(),
        },
      })
      .catch(() => {
        // Losing one progress write must not abort an upload that is working.
        // The next chunk writes the newer number anyway.
      });
  };

  try {
    const outcome = await publisher.publish(prepared, {
      onProgress: writeProgress,
      // Recorded the moment it exists, encrypted: it is a capability URL. This
      // is what makes layer 2 (resume, never re-upload) possible.
      onSession: async (sessionUrl) => {
        await prisma.publishJob
          .update({ where, data: { sessionUrlEnc: seal(sessionUrl, sessionAad(episodeId), env) } });
      },
      resumeFrom,
    });

    if (outcome.status === "PUBLISHED") {
      await prisma.publishJob.update({
        where,
        data: {
          status: outcome.scheduledFor ? "SCHEDULED" : "PUBLISHED",
          externalId: outcome.externalId,
          externalUrl: outcome.externalUrl,
          publishedAt: outcome.scheduledFor ? null : outcome.confirmedAt,
          scheduledFor: outcome.scheduledFor ?? null,
          lastError: null,
          uploadedBytes: prepared.video.bytes,
          totalBytes: prepared.video.bytes,
          // The session is spent; keeping a dead capability URL serves nothing.
          sessionUrlEnc: null,
          thumbnailStatus: outcome.thumbnail
            ? outcome.thumbnail.applied
              ? "APPLIED"
              : "FAILED"
            : "SKIPPED",
          thumbnailError: outcome.thumbnail?.applied ? null : (outcome.thumbnail?.reason ?? null),
        },
      });
      return;
    }

    const job = await prisma.publishJob.findUnique({ where });
    // Bounded API retry ladder (1m, 5m, 15m). Only a durable session can
    // automatically resume; failures with unknown remote state require review.
    const delays = [60_000, 300_000, 900_000];
    const retryAt = outcome.status === "FAILED" && outcome.retryable && job?.sessionUrlEnc && job.attempts <= delays.length
      ? new Date(Date.now() + delays[Math.max(0, job.attempts - 1)]) : null;
    await prisma.publishJob.update({
      where,
      data: {
        status: outcome.status,
        retryAt,
        lastError: outcome.error,
        ...(outcome.status === "AWAITING_HUMAN" ? { externalId: outcome.externalId, externalUrl: outcome.externalUrl } : {}),
        // A failed or unconnected attempt keeps its session: the next try
        // resumes rather than re-sending what YouTube already holds.
      },
    });
  } catch (err) {
    // Anything this module did not anticipate still has to leave an honest row
    // behind, or the panel sits on PREPARING forever.
    await prisma.publishJob
      .update({
        where,
        data: {
          status: "FAILED",
          lastError: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {});
  }
}
