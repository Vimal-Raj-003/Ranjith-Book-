/**
 * SERVER-ONLY. Starting an Instagram publish, and recording what it actually does.
 *
 * Owns the `PublishJob` row while a publish is in flight. Everything it writes is
 * something that happened: `PREPARING` while the account is re-verified and the
 * container is created, `UPLOADING` while Instagram fetches and processes the
 * video, and then `PUBLISHED` with the media id INSTAGRAM returned, or `FAILED` /
 * `REQUIRES_CONNECTION` with the reason. There is no state in here that describes
 * an intention, and `uploadedBytes` / `totalBytes` are left null throughout: this
 * API reports no byte count, so the card shows a sentence and never a bar.
 *
 * NO SCHEMA CHANGE, so no restart-safe resume. Create, wait and publish happen in
 * ONE detached server-side operation, the way the YouTube upload is detached from
 * its request. If the server restarts in the middle, the container is simply
 * abandoned (Instagram expires it after 24 hours) and the row is left in an
 * in-flight state that `STALE_AFTER_MS` lets the next attempt replace. Nothing
 * was posted in that case, because the post is the last step.
 *
 * WHY A RETRY CANNOT POST TWICE, in two layers:
 *
 *  1. A job that already holds an `externalId` is NEVER published again. The
 *     media id is the platform's confirmation; `start` returns the existing
 *     state and sends nothing.
 *  2. A publish already running in this process is not started twice (`RUNNING`),
 *     so a double click gets one Reel.
 *
 * Layer 1 is in the database and survives a restart; layer 2 only removes a race.
 *
 * THE CONFIRMATION. The Content Publishing API has no draft and no private mode:
 * `media_publish` puts the Reel on the account, publicly, at once. So unlike the
 * YouTube path (private, review in Studio) this one refuses to start unless the
 * caller says, in so many words, that a public post is what is wanted
 * (`confirmPublic: true`). The check is HERE, in the function every caller goes
 * through, not in the button — a second client cannot skip it.
 */
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { isPublishRefused, type PreparedPublish } from "../contract";
import { loadPublishRequest, publishView } from "../state";
import type { PublishView } from "../view";
import type { EnvLike } from "../youtube/secrets";
import { browserHolds } from "../limits";
import { INSTAGRAM_PROVIDER, publicBaseProblem, publicConfig } from "./config";
import { instagramPublisher, type InstagramPublisher } from "./publisher";
import type { Fetcher } from "./graph";

/** Episodes with a publish running in THIS process. See layer 2 above. */
const RUNNING = new Set<string>();

const keyOf = (episodeId: string) => `${INSTAGRAM_PROVIDER}:${episodeId}`;

/**
 * An in-flight row nothing in this process is working on, and that has not moved
 * for this long, is the leftover of an interrupted run and may be replaced. The
 * wait itself is five minutes at most, so a row older than this is not live.
 */
export const STALE_AFTER_MS = 15 * 60_000;

export interface StartOptions {
  env?: EnvLike;
  fetchImpl?: Fetcher;
  /**
   * The caller's explicit acknowledgement that this posts PUBLICLY and at once.
   * Anything but `true` is refused.
   */
  confirmPublic?: boolean;
  /** Await the publish instead of letting it run detached. For tests only. */
  waitForCompletion?: boolean;
  /** Test seams for the container wait; production leaves them alone. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** Is a publish for this episode running in this process right now? */
export function isPublishing(episodeId: string): boolean {
  return RUNNING.has(keyOf(episodeId));
}

type JobRow = {
  status: string;
  externalId: string | null;
  attempts: number;
  updatedAt: Date;
  mode?: string | null;
};

async function currentJob(episodeId: string): Promise<JobRow | null> {
  const row = await prisma.publishJob.findUnique({
    where: { episodeId_platform: { episodeId, platform: INSTAGRAM_PROVIDER } },
  });
  return (row as JobRow | null) ?? null;
}

function publisherFor(userId: string, env: EnvLike, options: StartOptions): InstagramPublisher {
  return instagramPublisher({
    userId,
    env,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now,
    pollIntervalMs: options.pollIntervalMs,
    pollTimeoutMs: options.pollTimeoutMs,
  });
}

/**
 * Begin a publish, or explain why not.
 *
 * Returns the whole `PublishView`, the way every other write on this surface
 * does. Every refusal is a 4xx `AppError` with a sentence, thrown BEFORE the job
 * row is written or anything leaves this machine.
 */
export async function startInstagramPublish(
  userId: string,
  episodeId: string,
  options: StartOptions = {},
): Promise<PublishView> {
  const env = options.env ?? process.env;

  // OWNERSHIP FIRST, before anything is read about the episode or any credential
  // is touched: this is a public, irreversible action. `loadPublishRequest` is
  // the strict rule (`userId === user.id`), not the generous one reads use.
  const { request } = await loadPublishRequest(userId, episodeId, "instagram");

  const existing = await currentJob(episodeId);
  if (existing?.externalId) {
    // Layer 1. Instagram already has this Reel; a second publish would put a
    // duplicate on the account.
    return publishView(userId, episodeId, options);
  }
  if (RUNNING.has(keyOf(episodeId))) return publishView(userId, episodeId, options);
  if (browserHolds(existing)) {
    // Before the staleness check below, which would otherwise treat a long browser
    // job as an abandoned one and replace it. See the same guard in `youtube/run.ts`.
    throw new AppError(
      "browser_job_holds",
      "A browser-window publish holds this episode on Instagram: it is running, or it stopped for you to check. " +
        "Settle that first (the Reel may already be on the account). Nothing was sent.",
      409,
    );
  }
  const inFlight = existing?.status === "PREPARING" || existing?.status === "UPLOADING";
  if (inFlight && existing && Date.now() - existing.updatedAt.getTime() < STALE_AFTER_MS) {
    return publishView(userId, episodeId, options);
  }

  if (options.confirmPublic !== true) {
    throw new AppError(
      "needs_confirmation",
      "Instagram's API cannot save a draft or post privately: publishing puts the Reel on the account, publicly, at once. " +
        "Confirm that is what you want. Nothing was sent.",
      409,
    );
  }

  const config = publicConfig(env);
  if (!config.configured) {
    throw new AppError(
      "requires_connection",
      "This server is not configured to publish to Instagram, so it cannot post for you. " +
        `Missing: ${config.missing.join(", ")}. Use the hand-off below instead — nothing was sent.`,
      409,
    );
  }

  const publisher = publisherFor(userId, env, options);
  const gate = await publisher.gate();
  if (!gate.ready) {
    // A connected account that is the WRONG one (or cannot be confirmed) is its
    // own refusal, so the operator is not told to "connect" what is connected.
    const wrongAccount = gate.connection.connected && gate.connection.identityBlocksPublish;
    throw new AppError(
      wrongAccount ? "identity_blocked" : "requires_connection",
      `${gate.reason ?? "Instagram is not connected."} Nothing was sent.`,
      409,
    );
  }

  const unreachable = publicBaseProblem(env);
  if (unreachable) {
    throw new AppError("public_url", `${unreachable} Use the hand-off below instead — nothing was sent.`, 409);
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
  const base = {
    status: "PREPARING",
    metadata: JSON.stringify(prepared.metadata),
    preparedAt: prepared.preparedAt,
    lastError: null,
    // No measurement exists on this API. Null, not zero: zero would be a claim.
    totalBytes: null,
    uploadedBytes: null,
    thumbnailStatus: null,
    thumbnailError: null,
    privacyStatus: null,
  };
  await prisma.publishJob.upsert({
    where: { episodeId_platform: { episodeId, platform: INSTAGRAM_PROVIDER } },
    create: { episodeId, platform: INSTAGRAM_PROVIDER, attempts: 1, ...base },
    update: { attempts: { increment: 1 }, ...base },
  });

  RUNNING.add(keyOf(episodeId));
  const work = runPublish(userId, episodeId, prepared, options).finally(() => {
    RUNNING.delete(keyOf(episodeId));
  });

  if (options.waitForCompletion) {
    await work;
  } else {
    // Detached on purpose. The catch is not optional: an unhandled rejection in
    // a detached promise takes the dev server down.
    void work.catch(() => {});
  }

  return publishView(userId, episodeId, options);
}

/**
 * The publish itself, and the single place that turns an outcome into a row.
 *
 * There is no branch that writes `PUBLISHED` from anything but
 * `outcome.status === "PUBLISHED"`, and that variant cannot be constructed
 * without an `externalId` the platform returned.
 */
async function runPublish(
  userId: string,
  episodeId: string,
  prepared: PreparedPublish,
  options: StartOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const where = { episodeId_platform: { episodeId, platform: INSTAGRAM_PROVIDER } };
  const publisher = publisherFor(userId, env, options);

  try {
    const outcome = await publisher.publish(prepared, {
      onStage: async (stage) => {
        await prisma.publishJob.update({ where, data: { status: stage } }).catch(() => {
          // Losing one stage write must not abort a publish that is working.
        });
      },
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
        },
      });
      return;
    }

    await prisma.publishJob.update({
      where,
      data: { status: outcome.status, lastError: outcome.error },
    });
  } catch (err) {
    // Anything this module did not anticipate still has to leave an honest row
    // behind, or the panel sits on PREPARING forever.
    await prisma.publishJob
      .update({
        where,
        data: { status: "FAILED", lastError: err instanceof Error ? err.message : String(err) },
      })
      .catch(() => {});
  }
}
