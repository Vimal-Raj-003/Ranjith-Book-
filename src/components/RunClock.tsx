"use client";

import { useEffect, useState } from "react";

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const tenths = Math.floor((Math.max(0, ms) % 1000) / 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
}

/**
 * The run stopwatch. It ticks while the pipeline is running and freezes on the
 * recorded total once the run ends, so the number on screen is the number in
 * the database rather than a drifting client-side estimate.
 */
export default function RunClock({
  startedAt,
  totalMs,
  running,
}: {
  startedAt: string | null | undefined;
  totalMs: number | null | undefined;
  running: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  const elapsed =
    totalMs != null
      ? totalMs
      : startedAt
        ? now - new Date(startedAt).getTime()
        : 0;

  const idle = !running && totalMs == null;

  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border px-3.5 py-2"
      style={{
        borderColor: running ? "var(--amber)" : "var(--line)",
        background: running ? "color-mix(in srgb, var(--amber) 10%, transparent)" : "transparent",
      }}
      aria-live="off"
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${running ? "node-active" : ""}`}
        style={{
          background: running ? "var(--amber)" : totalMs != null ? "var(--cyan)" : "var(--mute-2)",
        }}
      />
      <div className="leading-none">
        <div className="eyebrow" style={{ fontSize: 9 }}>
          {running ? "Running" : totalMs != null ? "Total time" : "Idle"}
        </div>
        <div
          className="font-mono tabular-nums"
          style={{
            fontSize: 22,
            marginTop: 3,
            color: idle ? "var(--mute-2)" : running ? "var(--amber)" : "var(--cyan)",
          }}
        >
          {idle ? "00:00.0" : clock(elapsed)}
        </div>
      </div>
    </div>
  );
}
