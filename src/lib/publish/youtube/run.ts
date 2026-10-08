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
import { AppError } from "@/lib/errors";
import { isPublishRefused, type PreparedPublish, type PublishProgress } from "../contract";
import { loadPublishRequest, publishView } from "../state";
import type { PublishView } from "../view";
import { YOUTUBE_PROVIDER, UPLOAD_PRIVACY, publicConfig } from "./config";
import { youTubePublisher } from "./publisher";
import { open, seal, sessionAad, type EnvLike } from "./secrets";
import type { Fetcher } from "./oauth";

/** Episodes with an upload running in THIS process. See layer 3 above. */
const RUNNING = new Set<string>();

const keyOf = (episodeId: string) => `${YOUTUBE_PROVIDER}:${episodeId}`;

export interface StartOptions {
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

type JobRow = {
  status: string;
  externalId: string | null;
  sessionUrlEnc: string | null;
  attempts: number;
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
  const { request } = await loadPublishRequest(userId, episodeId);

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

  const config = publicConfig(env);
  if (!config.configured) {
    throw new AppError(
      "requires_connection",
      "This server is not configured to publish to YouTube, so it cannot post for you. " +
        `Missing: ${config.missing.join(", ")}. Use the handoff below instead — nothing was sent.`,
      409,
    );
  }

  const publisher = youTubePublisher({ userId, env, fetchImpl: options.fetchImpl });
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
          // Starting fresh is correct and costs one re-upload, which is better
          // than refusing to publish at all.
          return null;
        }
      })()
    : null;

  const base = {
    status: "PREPARING",
    metadata: JSON.stringify(prepared.metadata),
    preparedAt: prepared.preparedAt,
    lastError: null,
    totalBytes: prepared.video.bytes,
    uploadedBytes: 0,
    thumbnailStatus: null,
    thumbnailError: null,
    privacyStatus: UPLOAD_PRIVACY,
  };
  await prisma.publishJob.upsert({
    where: { episodeId_platform: { episodeId, platform: YOUTUBE_PROVIDER } },
    create: { episodeId, platform: YOUTUBE_PROVIDER, attempts: 1, ...base },
    update: { attempts: { increment: 1 }, ...base },
  });

  RUNNING.add(keyOf(episodeId));
  const work = runUpload(userId, episodeId, prepared, resumeFrom, options).finally(() => {
    RUNNING.delete(keyOf(episodeId));
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
  const publisher = youTubePublisher({ userId, env, fetchImpl: options.fetchImpl });

  const writeProgress = async (progress: PublishProgress) => {
    await prisma.publishJob
      .update({
        where,
        data: {
          status: progress.status,
          uploadedBytes: progress.bytesSent,
          totalBytes: progress.totalBytes,
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
          .update({ where, data: { sessionUrlEnc: seal(sessionUrl, sessionAad(episodeId), env) } })
          .catch(() => {});
      },
      resumeFrom,
    });

    if (outcome.status === "PUBLISHED") {
      await prisma.publishJob.update({
        where,
        data: {
          status: "PUBLISHED",
          externalId: outcome.externalId,
          externalUrl: outcome.externalUrl,
          publishedAt: outcome.confirmedAt,
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

    await prisma.publishJob.update({
      where,
      data: {
        status: outcome.status,
        lastError: outcome.error,
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
