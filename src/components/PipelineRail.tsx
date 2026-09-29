"use client";

import { useEffect, useState } from "react";
import { STEPS } from "@/lib/pipeline-steps";
import { Disclosure } from "./ui";
import { strings } from "@/lib/strings";
import { formatDuration } from "@/lib/format-duration";

/**
 * The full, ordered list of stages a run passes through: every ingest stage,
 * then every episode stage. Derived from the pipeline itself, not restated —
 * a hand-copied array drifts the moment a pipeline step is renamed, and an
 * unknown name makes `findIndex` below return -1, which renders as though the
 * run had not started at all. `tests/pipeline-steps.test.mts` both checks
 * this against the pipeline and greps this file for a reintroduced literal
 * array, so that trap cannot come back even from a future edit here.
 *
 * Imported from `@/lib/pipeline-steps` — NOT `@/lib/pipeline` — because this
 * is a `"use client"` component: `@/lib/pipeline` pulls in sharp, Prisma, the
 * CLI spawner and ffmpeg, none of which can resolve in the browser bundle.
 * `@/lib/pipeline-steps` has no imports at all, so it is safe here.
 */
export { STEPS };

export type RunStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED" | string;

/** One timed step, as `GET /api/episodes/[id]` returns it. */
export interface StepTiming {
  step: string;
  position: number;
  status: string;
  startedAt: string;
  /** Null while the step is still running. */
  durationMs: number | null;
}

export interface PipelineRailProps {
  /** The current step name — `Upload.step` during ingest, `Episode.step`
   *  during an episode run. A name outside `STEPS` (e.g. "Queued") is treated
   *  as "nothing has started yet", not an error. */
  step: string;
  status: RunStatus;
  /** Shown under a failed step, if there is one. */
  error?: string | null;
  /** Per-step timings. Absent during ingest, which has no StepRun rows. */
  steps?: StepTiming[];
  /** Total run time, for the share-of-run column. */
  totalMs?: number | null;
  /** The stages to draw. Defaults to the photo pipeline's `STEPS`; a book PDF
   *  analysis passes its own `ANALYSIS_STEPS`. */
  stepList?: readonly string[];
}

/**
 * A progress meter, then the name of the stage the run is actually in, then
 * the whole named rail behind a `<summary>`.
 *
 * Fourteen named stages stacked vertically is close to four hundred pixels of
 * a screen that has to hold the upload form, the preview and the settings as
 * well, and thirteen of those fourteen lines say nothing the operator did not
 * already know. So the meter carries the shape of the run — how far along,
 * and whether a segment went red — and one line carries the only stage that
 * is news. The full list is a keypress away and unchanged when it is opened.
 */
export default function PipelineRail({ step, status, error, steps, totalMs, stepList = STEPS }: PipelineRailProps) {
  // Timings are keyed by step NAME rather than by index: the rail renders
  // ingest and episode stages as one list, while StepRun rows exist only for
  // the episode half, so the two are not positionally aligned.
  const timing = new Map((steps ?? []).map((t) => [t.step, t]));

  // A step mid-flight and a step about to time out look identical without
  // this: both just say the step's name, unmoving, for as long as either
  // takes. Ticking the running step's own elapsed time — from its StepRun's
  // `startedAt`, the same field a finished step's duration already comes
  // from — is the cheapest signal that distinguishes "still going" from
  // "stopped responding", with no change to what actually runs the step.
  const isRunning = status === "RUNNING";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);
  const runningTiming = timing.get(step);
  const runningElapsedMs =
    isRunning && runningTiming && runningTiming.durationMs == null
      ? now - new Date(runningTiming.startedAt).getTime()
      : null;
  // The denominator for the share column is the sum of what was actually
  // measured, not `totalMs`: total includes time outside any step, and a
  // column of percentages that does not add to 100 reads as a bug.
  const measured = (steps ?? []).reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const slowest = (steps ?? []).reduce((max, t) => Math.max(max, t.durationMs ?? 0), 0);

  const currentIndex = stepList.findIndex((s) => s === step);
  const isDone = status === "DONE";
  const isFailed = status === "FAILED";
  // A stopped-by-the-operator run is a terminal state like FAILED — it must
  // not keep showing "current"/amber, which reads as still in progress — but
  // it is not an error, so it gets its own neutral colour rather than rose.
  const isCancelled = status === "CANCELLED";

  const stateOf = (i: number) => {
    const passed = isDone || (currentIndex >= 0 && i < currentIndex);
    const isCurrent = !isDone && !isCancelled && i === currentIndex;
    if (isFailed && i === currentIndex) return "failed" as const;
    if (isCancelled && i === currentIndex) return "cancelled" as const;
    if (passed) return "passed" as const;
    if (isCurrent) return "current" as const;
    return "todo" as const;
  };

  const headline = isDone
    ? stepList[stepList.length - 1]
    : currentIndex >= 0
      ? stepList[currentIndex]
      : strings.run.notStarted;
  const position = isDone ? stepList.length : currentIndex >= 0 ? currentIndex + 1 : 0;

  return (
    <div className="flex flex-col gap-1.5">
      {/* aria-hidden: the meter is the same fact as the line under it, said in
          colour. Announcing it twice is noise in a region that already
          re-announces on every poll. */}
      <div className="rail-meter" aria-hidden>
        {stepList.map((s, i) => (
          <span key={s} className={`rail-seg${stateOf(i) === "current" && !isFailed ? " node-active" : ""}`} data-state={stateOf(i)} />
        ))}
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <span
          className="min-w-0 truncate font-mono text-[12.5px]"
          style={{ color: isFailed ? "var(--rose)" : isCancelled ? "var(--mute)" : "var(--ink)", fontWeight: 600 }}
        >
          {headline}
          {runningElapsedMs != null && (
            <span className="ml-1.5 tabular-nums" style={{ color: "var(--amber)", fontWeight: 400 }}>
              · {formatDuration(runningElapsedMs)}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--mute-2)" }}>
          {strings.run.stepCount(position, stepList.length)}
        </span>
      </div>

      {isFailed && error && (
        <span role="alert" className="text-[11px] leading-snug" style={{ color: "var(--rose)" }}>
          {error}
        </span>
      )}

      {/* Not `role="alert"`: the operator caused this themselves, it is not
          something that went wrong and needs their attention. */}
      {isCancelled && (
        <span className="text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
          {strings.run.cancelled}
        </span>
      )}

      <Disclosure quiet summary={strings.run.allSteps}>
        <ol role="list" className="flex flex-col gap-0.5">
          {stepList.map((s, i) => {
            const state = stateOf(i);
            const color =
              state === "failed"
                ? "var(--rose)"
                : state === "cancelled"
                  ? "var(--mute)"
                  : state === "passed"
                    ? "var(--cyan)"
                    : state === "current"
                      ? "var(--amber)"
                      : "var(--mute-2)";

            return (
              <li key={s} role="listitem" className="flex items-start gap-2.5 py-0.5">
                <span
                  aria-hidden
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${state === "current" ? "node-active" : ""}`}
                  style={{ background: color }}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[12px] leading-snug"
                  style={{
                    color: state === "todo" ? "var(--mute-2)" : "var(--ink)",
                    fontWeight: state === "current" || state === "failed" || state === "cancelled" ? 600 : 400,
                  }}
                >
                  {s}
                </span>
                {(() => {
                  const t = timing.get(s);
                  if (!t) return null;
                  const ms = t.durationMs;
                  const share = ms != null && measured > 0 ? Math.round((ms / measured) * 100) : null;
                  return (
                    <span className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] tabular-nums">
                      {share != null && share >= 10 && (
                        <span style={{ color: "var(--mute-2)" }}>{share}%</span>
                      )}
                      <span
                        className="w-[52px] text-right"
                        style={{
                          // The single slowest step is the only one worth
                          // drawing the eye to — that is the thing an operator
                          // would act on. The running row gets the same
                          // colour for the same reason: a number that is
                          // visibly climbing is the thing to watch right now.
                          color:
                            (ms != null && ms === slowest && slowest > 0) || (ms == null && s === step && runningElapsedMs != null)
                              ? "var(--amber)"
                              : "var(--mute)",
                          fontWeight:
                            (ms != null && ms === slowest && slowest > 0) || (ms == null && s === step && runningElapsedMs != null)
                              ? 600
                              : 400,
                        }}
                      >
                        {ms != null
                          ? formatDuration(ms)
                          : s === step && runningElapsedMs != null
                            ? formatDuration(runningElapsedMs)
                            : strings.run.stepRunning}
                      </span>
                    </span>
                  );
                })()}
              </li>
            );
          })}
        </ol>
      </Disclosure>
    </div>
  );
}
