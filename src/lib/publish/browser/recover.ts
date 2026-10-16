/**
 * SERVER-ONLY. What a restart does to a browser job: it hands it to a person.
 *
 * `reap.ts` closes out an episode run that died with the server, and an
 * interrupted API upload can simply be continued (YouTube's resumable session) or
 * replaced (Instagram's expiring container). A BROWSER job can do neither. It was
 * driving a window that is now gone, it may or may not have pressed the final
 * button, and a blind re-run could put a second copy of the video on the channel.
 * So the only honest thing to do with one that was interrupted is to say its real
 * outcome is unknown and stop, until a person has looked.
 *
 * HOW A DEAD JOB IS TOLD FROM A LIVE ONE. A row says `PREPARING` or `UPLOADING`
 * whether its process is working or died minutes ago. `live.ts` is the process's
 * own memory of what it is running, and a restart empties it, so "in flight in the
 * database but absent from that memory" means exactly one thing: whoever was
 * working on it is gone. No timeout is involved -- there is no age at which a live
 * job becomes dead, and no age at which a dead one is still alive.
 *
 * The write is a compare-and-set on the row's status and `updatedAt`, so a job
 * that settles between the read and the write is left alone, and two callers
 * recovering at once cannot both do it.
 *
 * NEVER AUTO-RETRIED. Nothing here, or anywhere in the browser folder, starts a
 * job. AWAITING_HUMAN is a resting state: leaving it takes a person pressing
 * Retry and saying they checked the platform (`run.ts`).
 */
import { prisma } from "@/lib/db";
import { PLATFORM_LABELS, isPlatformId } from "../limits";
import { isBrowserJobLive } from "./live";

const IN_FLIGHT = ["PREPARING", "UPLOADING"];

/** The sentence recorded on a job a restart interrupted. Whole, and says what to do. */
export function interruptedMessage(platformLabel: string): string {
  return (
    `The server stopped or restarted while the ${platformLabel} browser job was running, so what it did is unknown: ` +
    `the video may already be on ${platformLabel}, or none of it may have been sent. Check ${platformLabel} yourself ` +
    "before trying again. It is not retried automatically, because a second attempt could post it twice."
  );
}

/**
 * Mark every browser job that is in flight in the database but not running in
 * this process as AWAITING_HUMAN. Returns how many it changed.
 *
 * `episodeId` limits it to one episode (the Publish Center asks for its own).
 * Safe to call as often as is wanted: a settled job is not touched.
 */
export async function recoverInterruptedBrowserJobs(episodeId?: string): Promise<number> {
  const rows = await prisma.publishJob.findMany({
    where: { mode: "browser", status: { in: IN_FLIGHT }, ...(episodeId ? { episodeId } : {}) },
    select: { id: true, episodeId: true, platform: true, status: true, updatedAt: true },
  });

  let changed = 0;
  for (const row of rows) {
    if (!isPlatformId(row.platform)) continue;
    if (isBrowserJobLive(row.platform, row.episodeId)) continue;
    const swap = await prisma.publishJob.updateMany({
      where: { id: row.id, mode: "browser", status: row.status, updatedAt: row.updatedAt },
      data: { status: "AWAITING_HUMAN", lastError: interruptedMessage(PLATFORM_LABELS[row.platform]) },
    });
    changed += swap.count;
  }
  return changed;
}
