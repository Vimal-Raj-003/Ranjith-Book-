/**
 * SERVER-ONLY. Starting a browser publish, and recording what it actually does.
 *
 * This owns the `PublishJob` row while a browser window is working. It is the
 * browser-mode sibling of `youtube/run.ts` and `instagram/run.ts` and keeps their
 * promise: every status it writes is something that happened, and there is no
 * state in here that describes an intention.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: A BROWSER JOB IS NEVER RUN TWICE FOR ONE
 * EPISODE AND PLATFORM BY ACCIDENT. A blind second run can put a second copy of
 * the video on the channel, so every route to one is closed except a person
 * deliberately pressing Retry:
 *
 *  1. A row that holds a platform id -- PUBLISHED, SCHEDULED, or an AWAITING_HUMAN
 *     row that recorded a video the platform showed -- is never run again. The
 *     id is the platform's confirmation (or sighting) that the video is there.
 *  2. A row already in flight, in ANY mode, is not started a second time. The
 *     claim below is a compare-and-set on the row's status and `updatedAt`, so two
 *     clicks in the same millisecond, or a click and a route, claim it once.
 *  3. A job running (or queued) in this process is not started again: `live.ts`.
 *  4. An AWAITING_HUMAN row is only re-run when the caller says, in so many
 *     words, that they have looked at the platform (`acknowledgeRetry: true`).
 *     That is the human action; there is no timer and no loop that does it.
 *  5. A job a restart interrupted is not resumed: `recover.ts` marks it
 *     AWAITING_HUMAN, which is rule 4.
 *
 * ONE WINDOW PER PLATFORM. Two different episodes published to the same platform
 * queue behind each other on `live.ts`'s platform lock; the second waits (its row
 * says PREPARING) until the first has released the window, because Chromium will
 * not open one profile twice and a person cannot sign in to two windows at once.
 *
 * CONFIRMATION INTEGRITY, again at the point a result becomes a row: a PUBLISHED
 * outcome without an id the platform showed is written as AWAITING_HUMAN, whatever
 * the publisher said. The type already forbids it; this refuses it at runtime
 * too, so a stub, a future provider or a bad cast cannot talk the row into
 * "posted".
 */
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { isPublishRefused, type PreparedPublish, type PublishOutcome } from "../contract";
import { PLATFORM_LABELS, type PlatformId } from "../limits";
import { browserPublisherFor } from "../registry";
import { loadPublishRequest, publishView } from "../state";
import type { PublishView } from "../view";
import type { EnvLike } from "../youtube/secrets";
import {
  browserOptionProblems,
  chromiumProblem,
  type BrowserDeps,
  type BrowserPublishOptions,
  type BrowserPublisher,
} from "./engine";
import { markLive, unmarkLive, isBrowserJobLive } from "./live";
import { recoverInterruptedBrowserJobs } from "./recover";

export interface StartBrowserOptions extends BrowserPublishOptions {
  /**
   * The caller's statement that they have looked at the platform after an
   * AWAITING_HUMAN stop and want to go again. Anything but `true` is refused.
   */
  acknowledgeRetry?: boolean;
  env?: EnvLike;
  /** Test seams for the browser itself. Production leaves them alone. */
  deps?: BrowserDeps;
  /** Test seam: replace the publisher outright with a scripted one. */
  makePublisher?: (platform: PlatformId, options: BrowserPublishOptions) => BrowserPublisher;
  /** Await the job instead of letting it run detached. For tests only. */
  waitForCompletion?: boolean;
}

/** The statuses that are work in progress. A row in one is never claimed again. */
const IN_FLIGHT = ["PREPARING", "UPLOADING"];
/** The statuses that are settled facts about the platform. Never claimed. */
const SETTLED = ["PUBLISHED", "SCHEDULED"];

type JobRow = {
  id: string;
  status: string;
  externalId: string | null;
  mode: string | null;
  attempts: number;
  updatedAt: Date;
};

async function currentJob(episodeId: string, platform: PlatformId): Promise<JobRow | null> {
  const row = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform } } });
  return (row as JobRow | null) ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Claim the (episode, platform) row for this job, or report that someone else
 * holds it. A compare-and-set, not a read followed by a write: the update only
 * matches a row that is STILL in the state it was read in and holds no platform
 * id, and the create only wins the unique key once.
 */
async function claim(
  episodeId: string,
  platform: PlatformId,
  existing: JobRow | null,
  prepared: PreparedPublish,
): Promise<boolean> {
  const fresh = {
    status: "PREPARING",
    mode: "browser",
    metadata: JSON.stringify(prepared.metadata),
    preparedAt: prepared.preparedAt,
    // A new attempt starts from nothing: no old error, no old id, no old schedule.
    lastError: null,
    externalId: null,
    externalUrl: null,
    publishedAt: null,
    scheduledFor: null,
    // No byte count exists for a browser upload. Null, not zero: zero would be a claim.
    totalBytes: null,
    uploadedBytes: null,
    thumbnailStatus: null,
    thumbnailError: null,
    privacyStatus: null,
  };

  if (!existing) {
    try {
      await prisma.publishJob.create({ data: { episodeId, platform, attempts: 1, ...fresh } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  const swap = await prisma.publishJob.updateMany({
    where: {
      id: existing.id,
      updatedAt: existing.updatedAt,
      externalId: null,
      status: { notIn: [...IN_FLIGHT, ...SETTLED] },
    },
    data: { attempts: { increment: 1 }, ...fresh },
  });
  return swap.count === 1;
}

/**
 * Begin a browser publish, or explain why not.
 *
 * Returns the whole `PublishView`, like every other write on this surface. Every
 * refusal is a 4xx `AppError` with a sentence, thrown BEFORE the row is claimed
 * or any window is opened. The work then continues detached while the Publish
 * Center polls the row.
 */
export async function startBrowserPublish(
  userId: string,
  episodeId: string,
  platform: PlatformId,
  options: StartBrowserOptions = {},
): Promise<PublishView> {
  const env = options.env ?? process.env;

  // OWNERSHIP FIRST: this posts under an account and cannot be taken back from
  // here, so it is the strict rule (`userId === user.id`), not the generous one
  // the read paths use.
  const { request } = await loadPublishRequest(userId, episodeId, platform);

  // A restart's leftovers become AWAITING_HUMAN before anything is decided, so
  // the rules below see the truth rather than a row stuck on PREPARING.
  await recoverInterruptedBrowserJobs(episodeId).catch(() => 0);

  const label = PLATFORM_LABELS[platform];
  const existing = await currentJob(episodeId, platform);

  // Rule 1. The platform has it (or showed it): never run again.
  if (existing && SETTLED.includes(existing.status)) return publishView(userId, episodeId, { env });
  if (existing?.externalId) {
    throw new AppError(
      "already_on_platform",
      `${label} already showed a video for this episode (id ${existing.externalId}), so this app will not start another upload. ` +
        `Check ${label}; if you deleted that video and want to start over, record it as done by hand first. Nothing was sent.`,
      409,
    );
  }
  // Rules 2 and 3. In flight already, here or in another mode.
  if (isBrowserJobLive(platform, episodeId)) return publishView(userId, episodeId, { env });
  if (existing && IN_FLIGHT.includes(existing.status)) return publishView(userId, episodeId, { env });
  // Rule 4. Only a person who says they looked may go again.
  if (existing?.status === "AWAITING_HUMAN" && options.acknowledgeRetry !== true) {
    throw new AppError(
      "needs_acknowledgement",
      `The last browser attempt stopped for you to take over, and what it did on ${label} may not be known. ` +
        `Look at ${label} first. If a sign-in or security check was the only problem, or the post is not there, confirm and go again. ` +
        "It is never retried automatically. Nothing was sent.",
      409,
    );
  }

  const problems = browserOptionProblems(platform, options);
  if (problems.length > 0) {
    const first = problems[0];
    throw new AppError(first.code, problems.map((p) => p.message).join(" "), first.code === "needs_confirmation" ? 409 : 400);
  }

  const publisher =
    options.makePublisher?.(platform, options) ??
    browserPublisherFor(platform, { env, browser: { options, deps: options.deps } });
  if (!publisher) {
    throw new AppError("no_browser_publisher", `There is no browser route for ${label}. Use the API route or the hand-off.`, 409);
  }
  if (!(await publisher.isConfigured())) {
    throw new AppError(
      "requires_connection",
      chromiumProblem(options.deps) ?? `The ${label} browser route is not available on this server. Nothing was sent.`,
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

  // Marked live BEFORE the row is written, so a recovery pass can never see a
  // PREPARING row with nobody behind it. Unmarked only after the last write. The
  // mark is also the in-process half of the dedupe: of two racing callers, one
  // gets `true` and the other is told a job is already running.
  if (!markLive(platform, episodeId)) return publishView(userId, episodeId, { env });
  let claimed: boolean;
  try {
    claimed = await claim(episodeId, platform, existing, prepared);
  } catch (err) {
    unmarkLive(platform, episodeId);
    throw err;
  }
  if (!claimed) {
    // Someone else got the row between the read and the claim. Their job stands.
    unmarkLive(platform, episodeId);
    return publishView(userId, episodeId, { env });
  }

  const work = runBrowserJob(episodeId, platform, prepared, publisher).finally(() => unmarkLive(platform, episodeId));
  if (options.waitForCompletion) {
    await work;
  } else {
    // Detached on purpose. The catch is not optional: an unhandled rejection in a
    // detached promise takes the dev server down.
    void work.catch(() => {});
  }
  return publishView(userId, episodeId, { env });
}

/** Turn an outcome into the columns it justifies, and nothing else. */
export function rowFor(outcome: PublishOutcome): Record<string, unknown> {
  if (outcome.status === "PUBLISHED") {
    // The type needs an id; this is the same rule enforced at runtime. A "success"
    // with no id the platform showed is an unknown outcome, not a post.
    if (!outcome.externalId || typeof outcome.externalId !== "string") {
      return {
        status: "AWAITING_HUMAN",
        lastError:
          "The browser job reported success without an id the platform showed, so it is not recorded as posted. " +
          "Check the platform before trying again.",
      };
    }
    if (outcome.scheduledFor) {
      if (Number.isNaN(outcome.scheduledFor.getTime())) {
        return {
          status: "AWAITING_HUMAN",
          externalId: outcome.externalId,
          externalUrl: outcome.externalUrl,
          lastError: "The platform's scheduled time could not be read back, so it is not recorded as scheduled. Check the platform.",
        };
      }
      return {
        status: "SCHEDULED",
        externalId: outcome.externalId,
        externalUrl: outcome.externalUrl,
        // Nothing is published yet: `publishedAt` stays null.
        publishedAt: null,
        scheduledFor: outcome.scheduledFor,
        privacyStatus: outcome.visibility ?? "scheduled",
        lastError: null,
        thumbnailStatus: outcome.thumbnail ? (outcome.thumbnail.applied ? "APPLIED" : "FAILED") : "SKIPPED",
        thumbnailError: outcome.thumbnail?.applied ? null : (outcome.thumbnail?.reason ?? null),
      };
    }
    return {
      status: "PUBLISHED",
      externalId: outcome.externalId,
      externalUrl: outcome.externalUrl,
      publishedAt: outcome.confirmedAt,
      scheduledFor: null,
      privacyStatus: outcome.visibility ?? null,
      lastError: null,
      thumbnailStatus: outcome.thumbnail ? (outcome.thumbnail.applied ? "APPLIED" : "FAILED") : "SKIPPED",
      thumbnailError: outcome.thumbnail?.applied ? null : (outcome.thumbnail?.reason ?? null),
    };
  }
  if (outcome.status === "AWAITING_HUMAN") {
    return {
      status: "AWAITING_HUMAN",
      lastError: outcome.error,
      // An id the platform SHOWED, kept so a re-run is refused; never an id we made up.
      externalId: outcome.externalId ?? null,
      externalUrl: outcome.externalUrl ?? null,
      publishedAt: null,
    };
  }
  return { status: outcome.status, lastError: outcome.error };
}

/**
 * The job itself, and the single place a browser outcome becomes a row.
 *
 * Anything that escapes the publisher becomes AWAITING_HUMAN, never FAILED: an
 * exception from code that may already have pressed the final button is the case
 * where the truth is unknown, and "failed" invites a retry that could post twice.
 */
async function runBrowserJob(
  episodeId: string,
  platform: PlatformId,
  prepared: PreparedPublish,
  publisher: BrowserPublisher,
): Promise<void> {
  const where = { episodeId_platform: { episodeId, platform } };
  try {
    const outcome = await publisher.publish(prepared, {
      onStage: async (stage) => {
        await prisma.publishJob.update({ where, data: { status: stage } }).catch(() => {
          // Losing one stage write must not abort a job that is working.
        });
      },
    });
    await prisma.publishJob.update({ where, data: rowFor(outcome) });
  } catch (err) {
    await prisma.publishJob
      .update({
        where,
        data: {
          status: "AWAITING_HUMAN",
          lastError:
            `The browser job stopped unexpectedly (${err instanceof Error ? err.message : String(err)}). ` +
            `It is not known how far it got: check ${PLATFORM_LABELS[platform]} before trying again.`,
        },
      })
      .catch(() => {});
  }
}
