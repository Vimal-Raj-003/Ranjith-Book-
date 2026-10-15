/**
 * Regenerating one failed episode.
 *
 * There used to be no way to do this. `POST /api/books/[id]/videos` always
 * creates a NEW episode, so "try that one again" meant a second row for the same
 * idea, with the failed one left lying in the list. The pipeline itself never
 * needed a new row: `runEpisode` is written to re-run a failed one (its success
 * path writes `error: null` "because this row may be a re-run of one that
 * failed", `StepTimer.begin` clears the previous attempt's timings, and
 * `generateContent` reserves the idea afresh). All that was missing was a way to
 * put a FAILED row back in the queue.
 *
 * This is that, split from the route for the reason `lib/cancel.ts` is: the
 * route cannot be called from a test (`requireUser()` reads `cookies()`), so the
 * decision and the database writes live here, where `tests/retry.test.mts` can
 * reach them. It deliberately does NOT enqueue and does NOT run the pipeline —
 * the route enqueues after this returns `ok`, so a test can call this against
 * the isolated database without starting a multi-minute render.
 */
import { prisma } from "../db";
import { releaseIdea } from "../content/idea";

/** What `POST /api/episodes/[id]/retry` answers. */
export type RetryOutcome =
  | { ok: true; status: "QUEUED" }
  | { ok: false; httpStatus: 404; code: "not_found"; error: string }
  | { ok: false; httpStatus: 409; code: "not_failed" | "superseded"; error: string };

/**
 * Put one FAILED episode back to QUEUED, ready for `enqueueEpisode`.
 *
 * Only `FAILED` may be retried. That single rule is also the duplicate-click
 * guard: the first call moves the row to QUEUED, so a second call sees QUEUED
 * and is refused instead of resetting (or enqueueing) it twice. A RUNNING or
 * QUEUED row is already being worked on, a DONE one has nothing to redo, and a
 * CANCELLED one was stopped on purpose.
 *
 * A FAILED row is also refused (409 `superseded`) when a newer QUEUED, RUNNING or
 * DONE episode of the same book already exists for its idea — see the check below.
 * Order matters: that check, then the release, then the step cleanup, then the
 * atomic reset last.
 *
 * What is reset is only the transient run state — the fields the previous
 * attempt wrote while it ran and failed. What is NOT touched is everything that
 * says what this episode IS: `ideaKey`, `contentIdeaId`, `theme`, the voice
 * fields, `title`, the upload and its pages. The re-run therefore reads the same
 * idea, the same source pages and the same saved settings from the same row,
 * which is why this needs no schema change.
 *
 * Not wrapped in a transaction, deliberately: every write is idempotent, and
 * the status flip is last, so a failure part-way leaves the row FAILED and
 * retryable rather than QUEUED with nothing behind it.
 */
export async function prepareEpisodeRetry(episodeId: string): Promise<RetryOutcome> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    select: { id: true, status: true, bookId: true, ideaKey: true },
  });
  if (!episode) {
    return { ok: false, httpStatus: 404, code: "not_found", error: "Not found" };
  }
  if (episode.status !== "FAILED") {
    return {
      ok: false,
      httpStatus: 409,
      code: "not_failed",
      error: `This episode is ${episode.status.toLowerCase()}, so there is nothing to regenerate.`,
    };
  }

  // A newer video for the same idea already exists. "Generate videos" creates a NEW
  // episode for an idea whose earlier one FAILED (a failed episode does not count
  // as one in `createIdeaEpisodes`), so the stale FAILED row can sit beside a
  // QUEUED/RUNNING/DONE sibling for the same (book, idea). The reservation is per
  // (book, idea), not per episode: releasing it here would delete the SIBLING's
  // claim, and the re-run would then reserve it again — two videos of one idea,
  // which the unique index cannot catch because release and re-reserve are
  // sequential. So refuse, before anything is released or reset.
  //
  // Only when there is a key to share. With `ideaKey` null the pipeline's
  // reservation key is this episode's own id, which no other row has, so the
  // release below can only ever free this episode's own claim.
  if (episode.ideaKey !== null) {
    const sibling = await prisma.episode.findFirst({
      where: {
        bookId: episode.bookId,
        ideaKey: episode.ideaKey,
        id: { not: episode.id },
        status: { in: ["QUEUED", "RUNNING", "DONE"] },
      },
      select: { id: true },
    });
    if (sibling) {
      return {
        ok: false,
        httpStatus: 409,
        code: "superseded",
        error: "A newer video for this idea already exists, so regenerate that one instead.",
      };
    }
  }

  // The reservation a failed run can still be holding (a run that died with its
  // process leaves one; the reaper and `runEpisode`'s own catch release it, but
  // this does not depend on either having got there). The key is the one the
  // pipeline reserves and releases with. Idempotent, and never throws.
  await releaseIdea(episode.bookId, episode.ideaKey ?? episode.id);

  // The attempt that failed is history: clear its rail now, so the card does not
  // show it under "Queued" while this waits behind other renders.
  // `StepTimer.begin` does the same when the run starts; this covers the wait.
  await prisma.stepRun.deleteMany({ where: { episodeId: episode.id } });

  // `updateMany` on `status: "FAILED"` rather than `update` on the id: if two
  // requests got past the check above together, only one of them matches here.
  // The other sees `count: 0` and is told the same thing a later click would be.
  const reset = await prisma.episode.updateMany({
    where: { id: episode.id, status: "FAILED" },
    data: { status: "QUEUED", step: "Queued", error: null, finishedAt: null, totalMs: null },
  });
  if (reset.count === 0) {
    return {
      ok: false,
      httpStatus: 409,
      code: "not_failed",
      error: "This episode is no longer failed, so there is nothing to regenerate.",
    };
  }

  return { ok: true, status: "QUEUED" };
}
