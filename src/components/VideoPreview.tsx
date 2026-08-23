"use client";

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
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <div className="preview-stage">
          {ready && episode ? (
            /* The SRT is a separate deliverable, not attached as a <track> here. */
            <video
              key={episode.id}
              controls
              playsInline
              preload="metadata"
              src={`/api/episodes/${episode.id}/video`}
            >
              {strings.preview.unsupported}
            </video>
          ) : (
            <p className="preview-note" aria-live="polite">
              {!episode ? strings.preview.none : failed ? strings.preview.failed : strings.preview.building}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {episode && (
            <>
              <span className="font-display text-[16px] font-semibold" style={{ color: "var(--ink)" }}>
                {episode.title || strings.studio.untitled}
              </span>
              <span className="text-[13px]" style={{ color: "var(--mute)" }}>
                {episode.bookTitle}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
                {strings.run.episodeLabel(episode.partNumber, episode.seriesTotal)}
              </span>
            </>
          )}
          {ready && episode && (
            <a
              href={`/api/episodes/${episode.id}/video`}
              download
              className="mt-2 inline-flex w-fit rounded-lg px-3.5 py-2 text-[13px] font-semibold"
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
