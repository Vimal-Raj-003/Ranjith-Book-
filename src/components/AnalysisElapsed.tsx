"use client";

import { useEffect, useState } from "react";
import { strings } from "@/lib/strings";

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

/** Whether a run has stopped for good: its clock freezes rather than ticks. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL.has(status);
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * `HH:MM:SS`, always -- "00:01:24", not "01:24" -- so the total keeps one width
 * and one reading from the first second to the last. Whole seconds, rounded
 * down, so a clock never reads ahead of the time that has really passed; a
 * negative or non-finite input reads as zero rather than `NaN`.
 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(seconds)}`;
}

/**
 * When the run began: the recorded `startedAt` (set by every start and every
 * retry), else the upload's `createdAt` -- which is what rows from before that
 * column, and a server that does not send it yet, have to go on.
 */
function runStart(startedAt: string | null | undefined, createdAt: string | null | undefined): number | null {
  return parseTime(startedAt) ?? parseTime(createdAt);
}

/**
 * How long the analysis has taken, in ms, from the server's timestamps.
 *
 * Running: `now - start`. Terminal: `updatedAt - start`, which is fixed, so it
 * does not depend on `now` at all. `start` is `startedAt ?? createdAt`. Either
 * is clamped at zero (a clock that disagrees with the server must not read
 * negative). `null` means "nothing trustworthy to show": no usable start, or a
 * terminal run with no usable `updatedAt`.
 */
export function analysisElapsedMs(input: {
  status: string | null | undefined;
  createdAt: string | null | undefined;
  /** Optional: absent or null falls back to `createdAt`. */
  startedAt?: string | null | undefined;
  updatedAt: string | null | undefined;
  now: number;
}): number | null {
  const start = runStart(input.startedAt, input.createdAt);
  if (start == null) return null;
  const end = isTerminalStatus(input.status) ? parseTime(input.updatedAt) : input.now;
  if (end == null || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** Whether the clock needs its once-a-second tick: running, with a start to count from. */
export function shouldTick(
  status: string | null | undefined,
  createdAt: string | null | undefined,
  startedAt?: string | null | undefined,
): boolean {
  return !isTerminalStatus(status) && runStart(startedAt, createdAt) != null;
}

/**
 * The analysis stopwatch. Like `RunClock` it is derived from the server's own
 * timestamps rather than counted independently, so a refresh (or a remount, or
 * switching books and back) lands on the right number instead of zero. It
 * differs in what it is given: an `Upload` has no finish column, so the row's
 * `updatedAt` -- last written by the terminal status -- is the finish, and the
 * start is `startedAt`, which `POST /api/books/[id]/analyze` records on every
 * start and every retry. `createdAt` (the upload) is only the fallback for a row
 * without it: counting from it would charge a retry for the time since upload.
 *
 * Between polls the only thing that moves is the local `now`; nothing is
 * fetched or written per second. Once the status is terminal there is no
 * interval at all and the number is `updatedAt - createdAt`, whatever the
 * browser's clock says.
 */
export default function AnalysisElapsed({
  status,
  createdAt,
  startedAt,
  updatedAt,
  className = "",
}: {
  status: string | null | undefined;
  createdAt: string | null | undefined;
  startedAt?: string | null | undefined;
  updatedAt: string | null | undefined;
  className?: string;
}) {
  const ticking = shouldTick(status, createdAt, startedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    // After a Retry the state still holds the last tick from before the run
    // stopped, which would otherwise show for a whole second: catch up at once.
    const catchUp = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(catchUp);
      clearInterval(id);
    };
  }, [ticking]);

  const ms = analysisElapsedMs({ status, createdAt, startedAt, updatedAt, now });
  if (ms == null) return null;

  return (
    <div role="timer" className={`flex shrink-0 items-baseline gap-1.5 ${className}`}>
      <span className="text-[11.5px]" style={{ color: "var(--mute)" }}>
        {strings.books.elapsed}
      </span>
      {/* Flex ignores this for layout; it is what keeps the text "Total elapsed 00:01:24"
          for anything that reads it as text rather than as boxes. */}
      {" "}
      <span
        className="font-mono text-[12.5px] tabular-nums"
        style={{ color: ticking ? "var(--ink)" : "var(--mute)" }}
      >
        {formatElapsed(ms)}
      </span>
    </div>
  );
}
