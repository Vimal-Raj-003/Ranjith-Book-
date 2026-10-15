"use client";

import { useEffect, useState } from "react";
import PipelineRail from "./PipelineRail";
import RunClock from "./RunClock";
import PublishCenter from "./PublishCenter";
import { Dialog, Disclosure, StatusBadge } from "./ui";
import { strings } from "@/lib/strings";
import { EPISODE_STEPS } from "@/lib/pipeline-steps";
import type { EpisodeState } from "./types";

export const POLL_MS = 1500;
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * A click that began on one of these — the Show / Cancel buttons, a disclosure's
 * <summary>/<details> ("All steps", "N notes"), a link or a form field — belongs
 * to that control alone and must not also select the card. Gating once here, at
 * the card, is why no child needs a `stopPropagation`: that approach is fragile
 * and silently misses the next control someone adds.
 */
export const CARD_SELECT_IGNORE = 'button, a, summary, details, input, select, textarea, [role="button"]';

/**
 * Whether the Publish button is live for this episode.
 *
 * Publishing prepares a finished video and its metadata, so it is offered ONLY
 * for a DONE episode whose render is actually available (`hasVideo`) — never
 * while a run is queued, running, failed or cancelled, and never for a DONE row
 * whose video is missing. Exported and pure so the rule is pinned by a unit
 * test without a browser, the same way `selectOnCardClick` is; the readiness
 * check inside the panel is the deeper gate, this only decides the button.
 */
export function publishEnabled(episode: Pick<EpisodeState, "status" | "hasVideo">): boolean {
  return episode.status === "DONE" && episode.hasVideo === true;
}

/**
 * Whether the Regenerate button is shown for this episode.
 *
 * Only a FAILED run can be regenerated: a QUEUED or RUNNING one is already being
 * worked on, a DONE one has nothing to redo, and a CANCELLED one was stopped on
 * purpose. This is the same rule `prepareEpisodeRetry` enforces on the server
 * (409 `not_failed` for anything else), so the button never offers what the
 * server would refuse. Exported and pure for the same reason `publishEnabled`
 * is: the rule is pinned by a unit test without a browser.
 */
export function canRegenerate(episode: Pick<EpisodeState, "status">): boolean {
  return episode.status === "FAILED";
}

/**
 * Decide a pointer click on the card, and select its episode when it should.
 *
 * Exported so the gate is unit-tested without a browser
 * (`tests/client-ui.test.mts`). The click-anywhere affordance is a convenience
 * for pointer users only; keyboard users already select with the
 * "Show … in the preview" button, which stays the semantic, focusable control —
 * so the card deliberately takes no `role`/`tabIndex`, adding no second tab stop.
 *
 * `card` is the click's `currentTarget` — the `<article>` — and bounds the
 * `closest` search to this card. Without it, an interactive ANCESTOR of the card
 * (say, a future `<details>` wrapping the episode list, as `BooksView` already
 * wraps its book list) would match and silently swallow every card click.
 */
export function selectOnCardClick(
  target: Element | null,
  card: Element | null,
  { active, episodeId, onSelect }: { active: boolean; episodeId: string; onSelect: (id: string) => void },
): void {
  // Already the shown episode: do nothing. Re-selecting is a no-op upstream (the
  // parent passes a useState setter, so an identical id bails the render), so this
  // is defence-in-depth against re-firing on the active card; the real guarantee
  // that the preview <video> is not torn down is its stable `key={episode.id}`.
  if (active) return;
  // Ignore clicks on a nested control, bounded to this card: an interactive
  // element OUTSIDE the card (an ancestor) must not suppress selection.
  const hit = target?.closest(CARD_SELECT_IGNORE);
  if (hit && card?.contains(hit)) return;
  onSelect(episodeId);
}

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
  showPublish = false,
}: {
  episodeId: string;
  active: boolean;
  onSelect: (id: string) => void;
  /** Called with every snapshot. MUST be referentially stable. */
  onState: (state: EpisodeState) => void;
  /**
   * Whether this card shows the Publish button + panel dialog. Only the
   * Book-PDF view (`BookAnalysis`) passes `true`. The Studio view already mounts
   * a permanent `PublishCenter` in its stage, so a second one in a dialog here
   * would be a duplicate instance with colliding static DOM ids — this flag is
   * what keeps the panel to exactly one place per view.
   */
  showPublish?: boolean;
}) {
  const [episode, setEpisode] = useState<EpisodeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Regenerate's own optimistic "the click landed" flag, and its error — the same
  // shape as `cancelling` / `cancelError` above, and reset the same way.
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Bumped when a regeneration is accepted. The poll below STOPS at a terminal
  // status, and FAILED is terminal, so by the time the button is clicked there
  // is no poll left running; this is what starts one again.
  const [retryNonce, setRetryNonce] = useState(0);
  // Whether this card's Publish panel is open. Per-card, so opening episode A's
  // panel never shows episode B's — the dialog is always handed THIS card's
  // polled `episode`.
  const [publishOpen, setPublishOpen] = useState(false);

  // `cancelling` is this component's own optimistic "the click landed" flag,
  // not a status the server tracks — the poll above is what actually moves
  // `episode.status` to CANCELLED once the pipeline unwinds, at which point
  // TERMINAL stops polling and this flag no longer matters. Reset whenever a
  // fresh episode is shown, so a stale "Cancelling…" from a previous episode
  // never bleeds into this one.
  useEffect(() => {
    setCancelling(false);
    setCancelError(null);
    // Same reason for Regenerate: "Retrying…" or a retry error belongs to the
    // episode that was clicked, never to whichever one is shown next.
    setRetrying(false);
    setRetryError(null);
    // A fresh episode in this slot must never inherit the previous one's open
    // panel — belt-and-braces, since each card is keyed by its id.
    setPublishOpen(false);
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

  /**
   * Re-run THIS failed episode, on the same row. The server resets it to QUEUED
   * and puts it back in the queue (`POST /api/episodes/[id]/retry`); nothing
   * else is created or touched.
   */
  async function handleRetry() {
    if (!episode || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/episodes/${episodeId}/retry`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRetryError((body?.error as string) || strings.run.retryError);
        setRetrying(false);
        // 409: the server says this episode is no longer failed (another tab or
        // an earlier click already regenerated it). The card is showing a stale
        // FAILED and its poll has stopped, so look again rather than leave it.
        if (res.status === 409) setRetryNonce((n) => n + 1);
        return;
      }
      // Show what the server has just done, now, rather than a full poll interval
      // later: queued, with the failed attempt's error and timings gone. The poll
      // restarted below replaces this with the server's own snapshot straight away.
      const queued: EpisodeState = {
        ...episode,
        status: "QUEUED",
        step: "Queued",
        error: null,
        steps: [],
        finishedAt: null,
        totalMs: null,
      };
      setEpisode(queued);
      onState(queued);
      setRetrying(false);
      // The poll stopped at FAILED; this effect dependency starts it again.
      setRetryNonce((n) => n + 1);
    } catch {
      setRetryError(strings.run.retryError);
      setRetrying(false);
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
        // A regenerate error is about the FAILED card it was clicked on; once the
        // episode has moved on it must not resurface if it fails again later.
        if (body.status !== "FAILED") setRetryError(null);
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
    // `retryNonce` is a dependency only to re-run this effect: the cleanup above
    // clears any pending tick of the old loop and the body starts exactly one new
    // one, so a regeneration never leaves two polls in flight.
  }, [episodeId, onState, retryNonce]);

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
    <>
    <article
      className="panel"
      aria-label={title}
      onClick={(e) => selectOnCardClick(e.target as Element, e.currentTarget, { active, episodeId: episode.id, onSelect })}
      style={
        active
          ? // A solid accent border over a ~18% accent fill — the house signal
            // for "this one is chosen", matching the book list and the nav. The
            // old 55% border alone read as too subtle to find at a glance.
            { borderColor: "var(--amber)", background: "color-mix(in srgb, var(--amber) 18%, var(--slab))" }
          : // Clicking an inactive card anywhere selects it; the cursor says so.
            { cursor: "pointer" }
      }
    >
      {/* The badge and the clock wrap under the title when the card is narrow.
          These cards moved into a 320px aside, which left roughly 120px for a
          title that is a whole sentence — "Why Your Brain Won't Switch Off
          at…". `flex-wrap` plus a 180px basis is content-driven: one row where
          both fit, two where they do not, at any width. */}
      <header className="panel-head episode-head">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {strings.run.episodeLabel(episode.partNumber, episode.seriesTotal)}
          </span>
          {/* Clamped to two lines, not truncated to one. An episode title is a
              whole sentence ("Why Your Brain Won't Switch Off at Night") and in
              a 320px aside one line shows about 199px of the 296px it needs —
              measured. Two lines show all of it, and the clamp still stops a
              pathological title from owning the card. */}
          <span className="line-clamp-2 font-display text-[15px] font-semibold leading-snug" style={{ color: "var(--ink)" }}>
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
          {/* Regenerate — only on a FAILED card, in the row directly under the
              error it answers. A <button>, so CARD_SELECT_IGNORE keeps its click
              from also selecting the card. Disabled while the request is in
              flight; the server refuses a second one anyway (409 not_failed). */}
          {canRegenerate(episode) && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className="rounded-lg border px-3 py-1 text-[12px] font-semibold disabled:opacity-60"
              style={{ borderColor: "color-mix(in srgb, var(--cyan) 55%, transparent)", color: "var(--cyan)" }}
            >
              {retrying ? strings.run.retrying : strings.run.regenerate}
            </button>
          )}
          {episode.hasVideo && (
            <span className="text-[12px] font-semibold" style={{ color: "var(--cyan)" }}>
              {strings.run.videoReady}
            </span>
          )}
          {/* Publish — bottom-right. A <button>, so the card's CARD_SELECT_IGNORE
              gate already keeps clicking it from selecting the card (verified in
              client-ui.test.mts). Enabled only for a finished episode with a
              usable video; disabled while generating or when there is no video,
              with the reason given through `title` rather than left to guess. */}
          {showPublish &&
            (() => {
              const canPublish = publishEnabled(episode);
              return (
                <button
                  type="button"
                  onClick={() => canPublish && setPublishOpen(true)}
                  disabled={!canPublish}
                  aria-haspopup="dialog"
                  title={canPublish ? undefined : strings.run.publishDisabledHint}
                  className="ml-auto rounded-lg px-3 py-1 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={
                    canPublish
                      ? { background: "var(--cyan)", color: "var(--on-accent)" }
                      : { border: "1px solid var(--line)", color: "var(--mute)" }
                  }
                >
                  {strings.run.publish}
                </button>
              );
            })()}
        </div>
        {cancelError && (
          <p role="alert" className="text-[11px] leading-snug" style={{ color: "var(--rose)" }}>
            {cancelError}
          </p>
        )}
        {/* Only while the card is still FAILED: once the poll shows it moved on
            (the 409 case above), the message is about a state the card has left. */}
        {retryError && canRegenerate(episode) && (
          <p role="alert" className="text-[11px] leading-snug" style={{ color: "var(--rose)" }}>
            {retryError}
          </p>
        )}
      </div>
    </article>

      {/* A SIBLING of the card, not a child: the dialog is portaled to the body,
          and React propagates portal events through the component tree, so a
          child here would route every click inside the panel to the card's
          selection gate. As a sibling its clicks reach the fragment, never the
          <article>. */}
      {showPublish && publishOpen && (
        <Dialog
          title={strings.run.publishTitle(title)}
          closeLabel={strings.run.publishClose}
          onClose={() => setPublishOpen(false)}
        >
          <PublishCenter episode={episode} />
        </Dialog>
      )}
    </>
  );
}
