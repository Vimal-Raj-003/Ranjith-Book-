/**
 * When each stage of a PDF analysis began and ended -- the per-stage history an
 * `Episode` keeps as `StepRun` rows and an `Upload` otherwise has no place for.
 *
 * Two halves, kept apart on purpose:
 *
 *   - the WRITE half (`beginStep`, `endRun`) is what `Reporter` in `run.ts` uses.
 *     It keeps a small ordered array in memory and persists it as JSON on the
 *     Upload row, in the same update that already moves `step` -- once per stage
 *     transition, so about five writes a run and none per second.
 *   - the READ half (`analysisStepTimings`) turns that JSON into the
 *     `StepTiming[]` that `PipelineRail` already knows how to draw: a finished
 *     stage's frozen duration, the running stage's start (so the browser can tick
 *     it between polls), and nothing at all for a stage that has not begun.
 *
 * A duration is only ever `endedAt - startedAt` of two instants the run really
 * recorded. Where the run could not record one (a process that died mid-stage, a
 * row from before the column, a stage a resumed run skipped) the stage simply has
 * no timing, and the rail shows it as it always has -- without a number.
 */
import type { StepTiming } from "@/components/PipelineRail";
import { ANALYSIS_STEPS } from "../pipeline-steps";

/** One stage as persisted. `endedAt` is null while it runs, and stays null if the process dies in it. */
export interface StoredStepTiming {
  step: string;
  startedAt: string;
  endedAt: string | null;
}

function isStored(value: unknown): value is StoredStepTiming {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.step === "string" &&
    typeof v.startedAt === "string" &&
    Number.isFinite(Date.parse(v.startedAt)) &&
    (v.endedAt === null || v.endedAt === undefined || typeof v.endedAt === "string")
  );
}

/**
 * Read the column. Never throws: null, undefined (a client generated before the
 * column existed), malformed JSON and entries of the wrong shape all read as
 * "no history" rather than as an error on the page.
 */
export function parseStepTimings(raw: string | null | undefined): StoredStepTiming[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStored).map((t) => ({ step: t.step, startedAt: t.startedAt, endedAt: t.endedAt ?? null }));
  } catch {
    return [];
  }
}

/**
 * `step` begins at `now`: whatever stage was still open ends at the same instant
 * (stages run one after another, so there is no gap and no overlap to guess at),
 * and a new open entry is appended. Beginning the stage that is already open is a
 * no-op rather than a second entry. Pure: returns a new array.
 */
export function beginStep(timings: readonly StoredStepTiming[], step: string, now: Date): StoredStepTiming[] {
  const at = now.toISOString();
  const last = timings[timings.length - 1];
  if (last && last.endedAt === null && last.step === step) return timings.map((t) => ({ ...t }));
  return [...timings.map((t) => (t.endedAt === null ? { ...t, endedAt: at } : { ...t })), { step, startedAt: at, endedAt: null }];
}

/** The run is over (finished, or failed in the stage that is open): close that stage at `now`. */
export function endRun(timings: readonly StoredStepTiming[], now: Date): StoredStepTiming[] {
  const at = now.toISOString();
  return timings.map((t) => (t.endedAt === null ? { ...t, endedAt: at } : { ...t }));
}

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * The `StepTiming[]` for `PipelineRail`, from what the run recorded.
 *
 * Per stage, in `ANALYSIS_STEPS` order:
 *   - ended            -> `DONE` (or `FAILED` for the stage a failed run stopped in),
 *                         `durationMs` = the measured `endedAt - startedAt`;
 *   - open, run live   -> `RUNNING`, `durationMs: null`: the rail ticks it from `startedAt`;
 *   - open, run over   -> left out. The process died inside it, so nobody saw it end, and
 *                         a number here would be a guess. The rail draws it without one.
 *   - no entry at all  -> left out: not started, or skipped by a run that resumed from the
 *                         pages an earlier run stored. Either way the rail draws it blank.
 *
 * Entries naming a stage that is not in the list (a renamed step, a hand-edited row) are
 * ignored; so is every entry when the column is null, which is every row from before it.
 */
export function analysisStepTimings(
  raw: string | null | undefined,
  run: { status: string; step: string },
  stepList: readonly string[] = ANALYSIS_STEPS,
): StepTiming[] {
  const live = !TERMINAL.has(run.status);
  const out: StepTiming[] = [];
  const seen = new Set<string>();
  for (const t of parseStepTimings(raw)) {
    const position = stepList.indexOf(t.step);
    if (position < 0 || seen.has(t.step)) continue;
    seen.add(t.step);

    const start = Date.parse(t.startedAt);
    if (t.endedAt === null) {
      if (!live) continue;
      out.push({ step: t.step, position, status: "RUNNING", startedAt: t.startedAt, durationMs: null });
      continue;
    }
    const end = Date.parse(t.endedAt);
    if (!Number.isFinite(end)) continue;
    out.push({
      step: t.step,
      position,
      status: run.status === "FAILED" && t.step === run.step ? "FAILED" : "DONE",
      startedAt: t.startedAt,
      // A clock that stepped backwards must not read as a negative duration.
      durationMs: Math.max(0, end - start),
    });
  }
  return out.sort((a, b) => a.position - b.position);
}
