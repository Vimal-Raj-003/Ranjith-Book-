"use client";

import { INGEST_STEPS, EPISODE_STEPS } from "@/lib/pipeline";

/**
 * The full, ordered list of stages a run passes through: every ingest stage,
 * then every episode stage. Derived from the pipeline itself, not restated —
 * a hand-copied array drifts the moment a pipeline step is renamed, and an
 * unknown name makes `findIndex` below return -1, which renders as though the
 * run had not started at all. `tests/pipeline-steps.test.mts` both checks
 * this against the pipeline and greps this file for a reintroduced literal
 * array, so that trap cannot come back even from a future edit here.
 */
export const STEPS = [...INGEST_STEPS, ...EPISODE_STEPS];

export type RunStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | string;

export interface PipelineRailProps {
  /** The current step name — `Upload.step` during ingest, `Episode.step`
   *  during an episode run. A name outside `STEPS` (e.g. "Queued") is treated
   *  as "nothing has started yet", not an error. */
  step: string;
  status: RunStatus;
  /** Shown under a failed step, if there is one. */
  error?: string | null;
}

/**
 * A vertical progress rail: every stage the pipeline can be in, with the ones
 * already passed marked done, the current one highlighted, and a failure (if
 * any) shown in place rather than silently stopping the rail mid-way.
 */
export default function PipelineRail({ step, status, error }: PipelineRailProps) {
  const currentIndex = STEPS.findIndex((s) => s === step);
  const isDone = status === "DONE";
  const isFailed = status === "FAILED";

  return (
    <ol role="list" className="flex flex-col gap-0.5" aria-label="Pipeline progress">
      {STEPS.map((s, i) => {
        const passed = isDone || (currentIndex >= 0 && i < currentIndex);
        const isCurrent = !isDone && i === currentIndex;
        const failedHere = isFailed && isCurrent;

        const color = failedHere
          ? "var(--rose)"
          : passed
            ? "var(--cyan)"
            : isCurrent
              ? "var(--amber)"
              : "var(--mute-2)";

        return (
          <li key={s} role="listitem" className="flex items-start gap-2.5 py-1">
            <span
              aria-hidden
              className={`mt-1 h-2 w-2 shrink-0 rounded-full ${isCurrent && !isFailed ? "node-active" : ""}`}
              style={{ background: color }}
            />
            <div className="flex flex-col">
              <span
                className="font-mono text-[12.5px] leading-snug"
                style={{
                  color: passed || isCurrent ? "var(--ink)" : "var(--mute-2)",
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                {s}
              </span>
              {failedHere && error && (
                <span role="alert" className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--rose)" }}>
                  {error}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
