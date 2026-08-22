import { prisma } from "./db";

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

  const stale = await prisma.creation.findMany({
    where: {
      status: { in: ["RUNNING", "QUEUED"] },
      OR: [
        { steps: { some: { status: "RUNNING", startedAt: { lt: cutoff } } } },
        { steps: { none: {} }, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true, step: true },
  });

  for (const run of stale) {
    await prisma.stepRun.updateMany({
      where: { creationId: run.id, status: "RUNNING" },
      data: { status: "FAILED", endedAt: new Date() },
    });
    await prisma.creation.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        step: "Interrupted",
        error: `The run stopped responding during "${run.step}". This usually means the server restarted mid-run. Start it again.`,
        finishedAt: new Date(),
      },
    });
  }

  return stale.length;
}
