"use client";

import { useEffect, useState } from "react";
import PipelineRail from "./PipelineRail";
import RunClock from "./RunClock";
import { StatusBadge } from "./ui";
import { strings } from "@/lib/strings";
import type { EpisodeState } from "./types";

export const POLL_MS = 1500;
const TERMINAL = new Set(["DONE", "FAILED"]);

/**
 * One episode's rail, polled every 1.5s until it reaches a terminal state.
 *
 * The card owns the poll and reports each snapshot upward, so exactly one
 * request per episode is in flight no matter how many panes are showing that
 * episode — the preview and the inspector read the reported state rather than
 * polling again for themselves.
 */
export default function EpisodeCard({
  episodeId,
  active,
  onSelect,
  onState,
}: {
  episodeId: string;
  active: boolean;
  onSelect: (id: string) => void;
  /** Called with every snapshot. MUST be referentially stable. */
  onState: (state: EpisodeState) => void;
}) {
  const [episode, setEpisode] = useState<EpisodeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(`/api/episodes/${episodeId}`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body) {
          // A 404 or a 403 will not fix itself on the next tick, and a card
          // that stays a skeleton for ever reads as a hung app. Say so once
          // and stop asking.
          setLoadError(strings.run.loadError);
          return;
        }
        setEpisode(body as EpisodeState);
        onState(body as EpisodeState);
        if (!TERMINAL.has(body.status)) {
          timer = setTimeout(poll, POLL_MS);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [episodeId, onState]);

  if (loadError && !episode) {
    return (
      <div className="panel panel-body">
        <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
          {loadError}
        </p>
      </div>
    );
  }

  if (!episode) {
    return (
      <div className="panel panel-body flex flex-col gap-3" aria-busy="true">
        <div className="skeleton" style={{ height: 14, width: "40%" }} />
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  const title = episode.title || strings.studio.untitled;

  return (
    <article
      className="panel"
      aria-label={title}
      style={active ? { borderColor: "color-mix(in srgb, var(--amber) 55%, transparent)" } : undefined}
    >
      <header className="panel-head">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {strings.run.episodeLabel(episode.partNumber, episode.seriesTotal)}
          </span>
          <span className="truncate font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
            {title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={episode.status} label={strings.run.statusLabel(episode.status)} />
          <RunClock startedAt={episode.startedAt} totalMs={episode.totalMs} running={episode.status === "RUNNING"} />
        </div>
      </header>

      <div className="panel-body flex flex-col gap-3">
        <div aria-live="polite" aria-atomic="false">
          <PipelineRail step={episode.step} status={episode.status} error={episode.error} />
        </div>

        {episode.notes.length > 0 && (
          <ul role="list" className="flex flex-col gap-1">
            {episode.notes.map((n, i) => (
              <li key={i} className="text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
                {n}
              </li>
            ))}
          </ul>
        )}

        {episode.status === "FAILED" && (
          <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
            {episode.error || strings.run.failed}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onSelect(episode.id)}
            disabled={active}
            className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {active ? strings.run.selected : strings.run.select(title)}
          </button>
          {episode.hasVideo && (
            <span className="text-[12px] font-semibold" style={{ color: "var(--cyan)" }}>
              {strings.run.videoReady}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
