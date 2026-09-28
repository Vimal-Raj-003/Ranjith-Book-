import { prisma } from "./db";
import { isEpisodeLive } from "./episodes/live";

/**
 * A run only makes progress while the server process that started it is alive.
 * A restart, a crash, or a child process that dies without settling its promise
 * would otherwise leave a row stuck on RUNNING forever.
 *
 * Any run whose current step has been open longer than the cap is closed out as
 * interrupted, so the UI never shows a spinner that will never finish.
 */
const STEP_STALE_MS = 12 * 60_000;

export async function reapStaleRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STEP_STALE_MS);

  const stale = await prisma.episode.findMany({
    where: {
      status: { in: ["RUNNING", "QUEUED"] },
      OR: [
        { steps: { some: { status: "RUNNING", startedAt: { lt: cutoff } } } },
        { steps: { none: {} }, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true, step: true },
  });

  // Episodes this process is still running or holding in its queue are alive
  // by definition, however long they have waited: an idea episode queued
  // behind three renders can sit untouched for longer than the cutoff, and a
  // 2-minute video's render step can run past it. Only a run with no live
  // process behind it — what a restart leaves — is reaped.
  const reapable = stale.filter((r) => !isEpisodeLive(r.id));
  for (const run of reapable) {
    await prisma.stepRun.updateMany({
      where: { episodeId: run.id, status: "RUNNING" },
      data: { status: "FAILED", endedAt: new Date() },
    });
    await prisma.episode.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        step: "Interrupted",
        error: `The run stopped responding during "${run.step}". This usually means the server restarted mid-run. Start it again.`,
        finishedAt: new Date(),
      },
    });
  }

  // `Upload` has no `StepRun` history the way `Episode` does — every ingest
  // step is just a string on the row itself — so `updatedAt` (bumped by every
  // `prisma.upload.update` call in `runIngest`, once per step transition) is
  // the only signal available for "stuck on the current step" versus "still
  // making progress". A run stuck 10+ minutes on ingest with zero CPU (the
  // incident this was added for: `measurePage` hanging inside the Next.js
  // dev server) is exactly what this is for — and it went uncaught because,
  // until now, this function only ever looked at `Episode` rows.
  const staleUploads = await prisma.upload.findMany({
    where: {
      status: { in: ["RUNNING", "QUEUED"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, step: true },
  });

  for (const upload of staleUploads) {
    await prisma.upload.update({
      where: { id: upload.id },
      data: {
        status: "FAILED",
        step: "Interrupted",
        error: `The run stopped responding during "${upload.step}". This usually means the server restarted mid-run, or a step hung. Start it again.`,
      },
    });
  }

  return reapable.length + staleUploads.length;
}
