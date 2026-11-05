import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WORK_ROOT } from "../paths";

export async function archiveGenerationEvidence(episodeId: string, evidence: unknown): Promise<string> {
  if (!/^[\w-]+$/.test(episodeId)) throw new Error("Invalid episode evidence path");
  const dir = path.join(WORK_ROOT, "generation-evidence", episodeId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(evidence, null, 2), { flag: "wx" });
  return file;
}

/** Owns only this attempt's drafts. Older attempts and legacy paths are never removed. */
export class GenerationAttempt<T extends { scenes: Promise<unknown> }> {
  readonly workDir: string;
  private drafts: { dir: string; settled: Promise<unknown>; candidate: unknown }[] = [];

  constructor(private readonly episodeId: string) {
    if (!/^[\w-]+$/.test(episodeId)) throw new Error("Invalid episode output path");
    this.workDir = path.join(WORK_ROOT, "audio", episodeId, `attempt-${randomUUID()}`);
  }

  start(candidate: unknown, prepare: (dir: string) => Promise<T>): { dir: string; job: Promise<T> } {
    const dir = path.join(this.workDir, `draft-${this.drafts.length + 1}`);
    const job = Promise.resolve().then(() => prepare(dir));
    // Prepared audio can resolve BEFORE its nested scene-planning promise.
    const settled = job.then(async (prepared) => { await prepared.scenes; }).catch(() => {});
    this.drafts.push({ dir, settled, candidate: structuredClone(candidate) });
    return { dir, job };
  }

  async settle(): Promise<void> {
    await Promise.all(this.drafts.map((d) => d.settled));
  }

  async discardExcept(keepDir: string | null = null): Promise<void> {
    await this.settle();
    for (const draft of this.drafts) {
      if (draft.dir === keepDir) continue;
      // Validate actual absolute paths before recursive removal, including junctions.
      const actual = await fs.realpath(draft.dir).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (actual === null) continue;
      if ((await fs.lstat(this.workDir)).isSymbolicLink()) {
        throw new Error(`Refusing cleanup through an attempt junction: ${this.workDir}`);
      }
      if ((await fs.lstat(this.workDir)).isSymbolicLink()) {
        throw new Error(`Refusing cleanup through an attempt junction: ${this.workDir}`);
      }
      const root = await fs.realpath(this.workDir);
      const relative = path.relative(root, actual);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
          (await fs.lstat(draft.dir)).isSymbolicLink()) {
        throw new Error(`Refusing cleanup outside this attempt: ${draft.dir}`);
      }
      await fs.rm(draft.dir, { recursive: true, force: true });
    }
  }

  async reject(error: unknown, candidate: unknown): Promise<void> {
    await this.settle();
    // Preserve the full validation report and scripts before removing rejected audio.
    // If archiving fails, keep the files for inspection instead of losing evidence.
    await archiveGenerationEvidence(this.episodeId, {
      episodeId: this.episodeId, workDir: this.workDir, at: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
        report: "report" in error ? error.report : undefined } : String(error),
      candidate, drafts: this.drafts.map(({ dir, candidate }) => ({ dir, candidate })),
    });
    await this.discardExcept();
  }
}
