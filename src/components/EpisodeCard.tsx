"use client";

import { useEffect, useState } from "react";
import PipelineRail from "./PipelineRail";
import RunClock from "./RunClock";
import { Disclosure, StatusBadge } from "./ui";
import { strings } from "@/lib/strings";
import { EPISODE_STEPS } from "@/lib/pipeline-steps";
import type { EpisodeState } from "./types";

export const POLL_MS = 1500;
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

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
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // `cancelling` is this component's own optimistic "the click landed" flag,
  // not a status the server tracks — the poll above is what actually moves
  // `episode.status` to CANCELLED once the pipeline unwinds, at which point
  // TERMINAL stops polling and this flag no longer matters. Reset whenever a
  // fresh episode is shown, so a stale "Cancelling…" from a previous episode
  // never bleeds into this one.
  useEffect(() => {
    setCancelling(false);
    setCancelError(null);
  }, [episodeId]);

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setCancelError((body?.error as string) || strings.run.cancelError);
        setCancelling(false);
      }
      // On success, `cancelling` stays true until the next poll reports a
      // terminal status — there is real work still winding down (a child
      // process to actually die, the idea reservation to release) between
      // "the signal was sent" and "the row says CANCELLED".
    } catch {
      setCancelError(strings.run.cancelError);
      setCancelling(false);
    }
  }

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
        <div className="skeleton" style={{ height: 56 }} />
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

      <div className="panel-body flex flex-col gap-2">
        <div aria-live="polite" aria-atomic="false">
          <PipelineRail
            step={episode.step}
            status={episode.status}
            error={episode.error}
            steps={episode.steps}
            totalMs={episode.totalMs}
            // An idea episode has no photo ingest in front of it, so its rail
            // is the nine episode stages alone, not "step 6 of 14".
            {...(episode.kind === "idea" ? { stepList: EPISODE_STEPS } : {})}
          />
        </div>

        {/* The notes are the pipeline's own asides — worth keeping, never
            worth a paragraph of the one screen this app gets. */}
        {episode.notes.length > 0 && (
          <Disclosure quiet summary={strings.run.notesSummary(episode.notes.length)}>
            <ul role="list" className="flex flex-col gap-1">
              {episode.notes.map((n, i) => (
                <li key={i} className="text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
                  {n}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}

        {episode.status === "FAILED" && (
          <p role="alert" className="text-[12.5px] leading-snug" style={{ color: "var(--rose)" }}>
            {episode.error || strings.run.failed}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onSelect(episode.id)}
            disabled={active}
            className="rounded-lg border px-3 py-1 text-[12px] font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {active ? strings.run.selected : strings.run.select(title)}
          </button>
          {episode.status === "RUNNING" && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="rounded-lg border px-3 py-1 text-[12px] font-semibold disabled:opacity-60"
              style={{ borderColor: "color-mix(in srgb, var(--rose) 45%, transparent)", color: "var(--rose)" }}
            >
              {cancelling ? strings.run.cancelling : strings.run.cancelGeneration}
            </button>
          )}
          {episode.hasVideo && (
            <span className="text-[12px] font-semibold" style={{ color: "var(--cyan)" }}>
              {strings.run.videoReady}
            </span>
          )}
        </div>
        {cancelError && (
          <p role="alert" className="text-[11px] leading-snug" style={{ color: "var(--rose)" }}>
            {cancelError}
          </p>
        )}
      </div>
    </article>
  );
}
