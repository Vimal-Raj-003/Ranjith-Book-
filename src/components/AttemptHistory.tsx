"use client";

import { useEffect, useState } from "react";
import type { AttemptHistoryItem } from "@/lib/episodes/attempt-groups";
import { StatusBadge } from "./ui";

export function AttemptHistoryList({ attempts }: { attempts: AttemptHistoryItem[] }) {
  return <ol className="flex flex-col gap-3" aria-label="Previous generation attempts">
    {attempts.map((attempt) => <li key={attempt.key} className="rounded border p-2 text-[12px]" style={{ borderColor: "var(--line)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={attempt.status} label={attempt.status} />
        <span>{attempt.step}</span>
        {attempt.startedAt && <time dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleString()}</time>}
      </div>
      <p className="break-all text-[11px]" style={{ color: "var(--mute)" }}>Episode {attempt.episodeId}{attempt.archived ? " · Previous retry" : ""}</p>
      {attempt.error && <p className="whitespace-pre-wrap break-words" style={{ color: "var(--rose)" }}>{attempt.error}</p>}
      {attempt.steps.length > 0 && <details><summary>Step details</summary><ul>
        {attempt.steps.map((step, index) => <li key={index}>{step.step} · {step.status}{step.durationMs !== null ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : ""}</li>)}
      </ul></details>}
      {attempt.hasVideo && <a href={`/api/episodes/${encodeURIComponent(attempt.episodeId)}/video`} target="_blank" rel="noreferrer">View this attempt’s video</a>}
    </li>)}
  </ol>;
}

export default function AttemptHistory({ episodeId, revision = "" }: { episodeId: string; revision?: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ key: string; attempts: AttemptHistoryItem[]; incomplete?: boolean; error?: boolean } | null>(null);
  const key = `${episodeId}:${revision}`;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/attempts`, { cache: "no-store" });
        if (!response.ok) throw new Error("History unavailable");
        const body = await response.json();
        if (!cancelled) setResult({ key, attempts: body.attempts, incomplete: body.incomplete });
      } catch { if (!cancelled) setResult({ key, attempts: [], error: true }); }
    })();
    return () => { cancelled = true; };
  }, [open, episodeId, key]);
  const current = result?.key === key ? result : null;
  return <details className="rounded border p-2 text-[12px]" style={{ borderColor: "var(--line)" }} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">Attempt History</summary>
    {open && <div className="mt-2">
      {!current ? <p>Loading attempts…</p> : current.error ? <p role="alert">Could not load attempt history. Close and reopen to retry.</p> : <>
        {current.incomplete && <p role="alert">Some archived details could not be read. Existing records are shown below.</p>}
        {current.attempts.length ? <AttemptHistoryList attempts={current.attempts} /> : <p>No previous attempts recorded.</p>}
      </>}
    </div>}
  </details>;
}
