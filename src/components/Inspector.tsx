"use client";

import { useEffect, useId, useState } from "react";
import { strings, VOICES, VIDEO_THEMES, DEFAULT_VOICE_ID } from "@/lib/strings";
import { Badge, EmptyState, Hint, Panel, StatRow } from "./ui";
import Thumbnails from "./Thumbnails";
import type { EpisodeState } from "./types";

/**
 * Theme, voice, music, thumbnails, download.
 *
 * The theme picker WRITES now: all five themes are built, and the pipeline
 * resolves the stored id per episode. The voice picker still does not, and is
 * still genuinely disabled and says why rather than pretending — a control
 * that remembers a choice nothing reads is worse than no control at all.
 *
 * The choice applies to the NEXT run. It is stamped onto an episode when the
 * episode is created, so changing it here never re-skins something already
 * rendered — an episode's stated look and the file on disk must always agree.
 */
export default function Inspector({ episode }: { episode: EpisodeState | null }) {
  const voiceId = useId();
  const voiceHintId = `${voiceId}-hint`;
  const [theme, setTheme] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setTheme(body.theme ?? null);
      } catch {
        // A settings read that fails leaves the picker showing nothing
        // selected, which is honest — better than asserting a default that
        // may not be what the renderer will actually use.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(id: string) {
    if (id === theme || saving) return;
    setSaving(id);
    const previous = theme;
    setTheme(id); // optimistic: the row highlights immediately
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: id }),
      });
      if (!res.ok) setTheme(previous); // roll back rather than lie about it
    } catch {
      setTheme(previous);
    } finally {
      setSaving(null);
    }
  }

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
          {VIDEO_THEMES.map((t) => {
            const selected = theme === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className="option-row w-full text-left"
                  data-state={selected ? "on" : "off"}
                  aria-pressed={selected}
                  disabled={!t.available || saving !== null}
                  onClick={() => choose(t.id)}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
                      {t.label}
                    </span>
                    <span className="block text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
                      {t.note}
                    </span>
                  </span>
                  {selected && <Badge tone="live">{strings.themePanel.current}</Badge>}
                </button>
              </li>
            );
          })}
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
        <StatRow
          label={strings.musicPanel.moodLabel}
          value={VIDEO_THEMES.find((t) => t.id === theme)?.music ?? strings.musicPanel.moodUnknown}
        />
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
