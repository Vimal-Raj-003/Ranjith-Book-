"use client";

import { useState } from "react";
import { strings } from "@/lib/strings";
import { Panel, StatusBadge } from "./ui";
import type { EpisodeState } from "./types";

/**
 * The 9:16 stage.
 *
 * The frame is always present and always the same size, whether or not there
 * is a video in it, so a poll that flips `hasVideo` from false to true swaps
 * the contents without moving anything else on the page.
 */
export default function VideoPreview({ episode }: { episode: EpisodeState | null }) {
  const ready = Boolean(episode?.hasVideo);
  const failed = episode?.status === "FAILED";
  const cancelled = episode?.status === "CANCELLED";

  // The native <video> element has its own well-defined `error` event — it
  // fires (in well under a second, measured) the moment the source turns out
  // to be unloadable for any reason: a 404, an expired session, a file
  // genuinely missing from disk. Without listening for it, an element with
  // `controls` and no working source just sits there — black box, a frozen
  // spinner-like play glyph, 0:00 — forever, which is indistinguishable from
  // "still loading." This is not a timeout and it hides nothing: it reports
  // exactly the failure the browser itself already detected, the moment it
  // detects it, and it resets whenever a different episode is shown.
  const [loadFailed, setLoadFailed] = useState(false);

  return (
    <Panel
      title={strings.preview.heading}
      actions={
        episode ? (
          <StatusBadge status={episode.status} label={strings.run.statusLabel(episode.status)} />
        ) : (
          <span className="badge">{strings.preview.aspectNote}</span>
        )
      }
    >
      {/* `sm:flex-row` is a WINDOW breakpoint, and this panel is not always as
          wide as the window: the Book-PDF pane puts one of these in an
          auto-fit grid cell about 400px across on a 1024px tablet, where the
          320px stage left the title column 45px and the download button hung
          12px off the right of the page (measured). Wrapping is the fix — the
          meta column asks for 180px and drops under the stage when it cannot
          have it, at any window width. */}
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap">
        <div className="preview-stage">
          {ready && episode && !loadFailed ? (
            /* The SRT is a separate deliverable, not attached as a <track> here.
               `key={episode.id}` already remounts this element for a different
               episode, which is what resets `loadFailed` back to false without
               it needing to be in this component's own dependency tracking. */
            <video
              key={episode.id}
              controls
              playsInline
              preload="metadata"
              src={`/api/episodes/${episode.id}/video`}
              onError={() => setLoadFailed(true)}
            >
              {strings.preview.unsupported}
            </video>
          ) : (
            <p className="preview-note" role={loadFailed ? "alert" : undefined} aria-live="polite">
              {!episode
                ? strings.preview.none
                : loadFailed
                  ? strings.preview.loadError
                  : failed
                    ? strings.preview.failed
                    : cancelled
                      ? strings.preview.cancelled
                      : strings.preview.building}
            </p>
          )}
        </div>

        <div className="flex min-w-[180px] flex-1 basis-[180px] flex-col gap-1.5">
          {episode && (
            <>
              <span className="font-display text-[14px] font-semibold leading-snug" style={{ color: "var(--ink)" }}>
                {episode.title || strings.studio.untitled}
              </span>
              <span className="text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
                {episode.bookTitle}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
                {strings.run.episodeLabel(episode.partNumber, episode.seriesTotal)}
              </span>
            </>
          )}
          {ready && episode && (
            <a
              href={`/api/episodes/${episode.id}/video`}
              download
              className="mt-1 inline-flex w-fit max-w-full rounded-[var(--r-control)] px-3 py-1.5 text-[12.5px] font-semibold"
              style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
            >
              {strings.preview.download}
            </a>
          )}
        </div>
      </div>
    </Panel>
  );
}
