import { prisma } from "./db";

/**
 * Times every pipeline step and writes each one to the database.
 *
 * Starting a step closes the previous one, so the recorded durations tile the
 * whole run with no gaps and no double-counting.
 */
export class StepTimer {
  private creationId: string;
  private position = 0;
  private current: { id: string; startedAt: number } | null = null;
  private runStartedAt: number;

  constructor(creationId: string) {
    this.creationId = creationId;
    this.runStartedAt = Date.now();
  }

  async begin(): Promise<void> {
    await prisma.creation.update({
      where: { id: this.creationId },
      data: { startedAt: new Date(this.runStartedAt), finishedAt: null, totalMs: null },
    });
    // A retry of the same creation should not stack old timings on the new run.
    await prisma.stepRun.deleteMany({ where: { creationId: this.creationId } });
  }

  /** Close the open step, then open `name`. */
  async start(name: string): Promise<void> {
    await this.closeCurrent("DONE");

    const startedAt = Date.now();
    const row = await prisma.stepRun.create({
      data: {
        creationId: this.creationId,
        step: name,
        position: this.position++,
        status: "RUNNING",
        startedAt: new Date(startedAt),
      },
    });
    this.current = { id: row.id, startedAt };

    await prisma.creation.update({
      where: { id: this.creationId },
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
    await prisma.creation.update({
      where: { id: this.creationId },
      data: { finishedAt: new Date(), totalMs },
    });
    return totalMs;
  }

  async fail(): Promise<void> {
    await this.closeCurrent("FAILED");
    await prisma.creation.update({
      where: { id: this.creationId },
      data: { finishedAt: new Date(), totalMs: Date.now() - this.runStartedAt },
    });
  }
}

export { formatDuration } from "./format-duration";
