import { prisma } from "./db";

/**
 * Times every pipeline step and writes each one to the database.
 *
 * Starting a step closes the previous one, so the recorded durations tile the
 * whole run with no gaps and no double-counting.
 */
export class StepTimer {
  private episodeId: string;
  private position = 0;
  private current: { id: string; startedAt: number } | null = null;
  private runStartedAt: number;

  constructor(episodeId: string) {
    this.episodeId = episodeId;
    this.runStartedAt = Date.now();
  }

  async begin(): Promise<void> {
    await prisma.episode.update({
      where: { id: this.episodeId },
      data: { startedAt: new Date(this.runStartedAt), finishedAt: null, totalMs: null },
    });
    // A retry of the same episode should not stack old timings on the new run.
    await prisma.stepRun.deleteMany({ where: { episodeId: this.episodeId } });
  }

  /** Close the open step, then open `name`. */
  async start(name: string): Promise<void> {
    await this.closeCurrent("DONE");

    const startedAt = Date.now();
    const row = await prisma.stepRun.create({
      data: {
        episodeId: this.episodeId,
        step: name,
        position: this.position++,
        status: "RUNNING",
        startedAt: new Date(startedAt),
      },
    });
    this.current = { id: row.id, startedAt };

    await prisma.episode.update({
      where: { id: this.episodeId },
      data: { step: name, status: "RUNNING" },
    });
  }

  private async closeCurrent(status: "DONE" | "FAILED"): Promise<void> {
    if (!this.current) return;
    const { id, startedAt } = this.current;
    this.current = null;
    await prisma.stepRun.update({
      where: { id },
      data: { status, endedAt: new Date(), durationMs: Date.now() - startedAt },
    });
  }

  async finish(): Promise<number> {
    await this.closeCurrent("DONE");
    const totalMs = Date.now() - this.runStartedAt;
    await prisma.episode.update({
      where: { id: this.episodeId },
      data: { finishedAt: new Date(), totalMs },
    });
    return totalMs;
  }

  async fail(): Promise<void> {
    await this.closeCurrent("FAILED");
    await prisma.episode.update({
      where: { id: this.episodeId },
      data: { finishedAt: new Date(), totalMs: Date.now() - this.runStartedAt },
    });
  }
}

export { formatDuration } from "./format-duration";
