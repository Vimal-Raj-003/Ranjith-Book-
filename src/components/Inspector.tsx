"use client";

import { useId } from "react";
import { strings, VOICES, VIDEO_THEMES, DEFAULT_VOICE_ID } from "@/lib/strings";
import { Badge, EmptyState, Hint, Panel, StatRow } from "./ui";
import Thumbnails from "./Thumbnails";
import type { EpisodeState } from "./types";

/**
 * Theme, voice, music, thumbnails, download.
 *
 * Nothing in here writes yet: there is no settings endpoint, and a picker that
 * remembers a choice the renderer never reads is worse than no picker at all.
 * So every control is genuinely disabled and says why, in a sentence tied to
 * it with `aria-describedby` rather than floating nearby. When the endpoints
 * land, the `disabled` and the hint come off together.
 */
export default function Inspector({ episode }: { episode: EpisodeState | null }) {
  const voiceId = useId();
  const voiceHintId = `${voiceId}-hint`;

  return (
    <div className="flex flex-col gap-4">
      <div className="pt-1">
        <h2 className="font-display text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
          {strings.inspector.heading}
        </h2>
        <p className="mt-1 text-[12px] leading-snug" style={{ color: "var(--mute-2)" }}>
          {episode ? episode.title || strings.studio.untitled : strings.inspector.noEpisode}
        </p>
      </div>

      <Panel title={strings.themePanel.heading}>
        <ul role="list" className="flex flex-col gap-1.5">
          {VIDEO_THEMES.map((t) => (
            <li key={t.id}>
              <div className="option-row" data-state={t.available ? "on" : "off"}>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
                    {t.label}
                  </span>
                  <span className="block text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
                    {t.note}
                  </span>
                </span>
                <Badge tone={t.available ? "live" : "soon"}>
                  {t.available ? strings.themePanel.current : strings.themePanel.unavailable}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-2.5">
          <Hint>{strings.themePanel.hint}</Hint>
        </div>
      </Panel>

      <Panel title={strings.voicePanel.heading}>
        <label className="field-label" htmlFor={voiceId}>
          {strings.voicePanel.selectLabel}
        </label>
        <select id={voiceId} className="control" value={DEFAULT_VOICE_ID} disabled aria-describedby={voiceHintId}>
          {VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} — {strings.voicePanel.genderLabel[v.gender]}, {v.note}
            </option>
          ))}
        </select>
        <div className="mt-2.5">
          <Hint id={voiceHintId}>{strings.voicePanel.hint}</Hint>
        </div>
      </Panel>

      <Panel title={strings.musicPanel.heading}>
        <StatRow label={strings.musicPanel.moodLabel} value={strings.musicPanel.moodValue} />
        <StatRow label={strings.musicPanel.levelLabel} value={strings.musicPanel.levelValue} />
        <StatRow label={strings.musicPanel.duckLabel} value={strings.musicPanel.duckValue} />
        <div className="mt-2.5">
          <Hint>{strings.musicPanel.hint}</Hint>
        </div>
      </Panel>

      <Panel title={strings.thumbnails.heading}>
        {episode ? <Thumbnails episode={episode} /> : <EmptyState>{strings.inspector.noEpisode}</EmptyState>}
      </Panel>

      <Panel title={strings.download.heading}>
        {episode?.hasVideo ? (
          <a
            href={`/api/episodes/${episode.id}/video`}
            download
            className="inline-flex w-full items-center justify-center rounded-lg px-3.5 py-2.5 text-[13px] font-semibold"
            style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
          >
            {strings.download.video}
          </a>
        ) : (
          <EmptyState>{strings.download.unavailable}</EmptyState>
        )}
      </Panel>
    </div>
  );
}
