"use client";

import { useEffect, useId, useState } from "react";
import { strings, VOICES, VIDEO_THEMES, DEFAULT_VOICE_ID } from "@/lib/strings";
import { Badge, Disclosure, EmptyState, Hint, Panel, StatRow } from "./ui";
import Thumbnails from "./Thumbnails";
import type { EpisodeState } from "./types";

/**
 * Theme, voice, music, thumbnails, download — in a column that has to end
 * above the fold on a 1440×780 laptop.
 *
 * What that cost, and what it did not: the theme picker is the only thing here
 * the operator touches on a normal run, so it is the only thing left open. It
 * is now a grid of chips rather than five stacked paragraphs; the paragraphs
 * are one `<details>` below it, so what each theme looks like is one keypress
 * away rather than gone. Voice and music are panels for things that cannot be
 * changed today, so they are collapsed by default and say their answer in the
 * summary — "Voice · Charles" tells you what a render will use without being
 * opened at all.
 *
 * The theme picker still WRITES: all five themes are built, and the pipeline
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

  const voice = VOICES.find((v) => v.id === DEFAULT_VOICE_ID);
  const thumbCount = episode?.thumbnails?.length ?? 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
          {strings.inspector.heading}
        </h2>
        <p className="truncate text-[12px]" style={{ color: "var(--mute-2)" }}>
          {episode ? episode.title || strings.studio.untitled : strings.inspector.noEpisode}
        </p>
      </div>

      <Panel title={strings.themePanel.heading}>
        {/* Still five real buttons carrying aria-pressed — a shorter row, not
            a weaker control. The name is the label; the description moved to
            the disclosure below rather than being dropped. */}
        <ul role="list" className="chip-grid">
          {VIDEO_THEMES.map((t) => {
            const selected = theme === t.id;
            return (
              <li key={t.id} className="flex">
                <button
                  type="button"
                  className="chip"
                  data-state={selected ? "on" : "off"}
                  aria-pressed={selected}
                  disabled={!t.available || saving !== null}
                  title={t.note}
                  onClick={() => choose(t.id)}
                >
                  <span className="truncate">{t.label}</span>
                  {selected && <span className="sr-only">{strings.themePanel.current}</span>}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-2 flex flex-col gap-1">
          <Hint>{strings.themePanel.hint}</Hint>
          <Disclosure quiet summary={strings.themePanel.detailsSummary}>
            <ul role="list" className="flex flex-col gap-1.5">
              {VIDEO_THEMES.map((t) => (
                <li key={t.id} className="text-[12px] leading-snug">
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    {t.label}
                  </span>{" "}
                  <span style={{ color: "var(--mute)" }}>{t.note}</span>
                  {theme === t.id && (
                    <>
                      {" "}
                      <Badge tone="live">{strings.themePanel.current}</Badge>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 hint">{strings.themePanel.detailsBody}</p>
          </Disclosure>
        </div>
      </Panel>

      {/* Nothing here can be changed yet, so nothing here is open by default.
          The summary carries the answer, which is the whole point of the
          panel — you do not have to open it to learn what a render will use. */}
      <Disclosure className="disclosure-panel" summary={strings.voicePanel.summary(voice?.label ?? DEFAULT_VOICE_ID)}>
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
        <div className="mt-2">
          <Hint id={voiceHintId}>{strings.voicePanel.hint}</Hint>
        </div>
      </Disclosure>

      <Disclosure className="disclosure-panel" summary={strings.musicPanel.summary}>
        <StatRow
          label={strings.musicPanel.moodLabel}
          value={VIDEO_THEMES.find((t) => t.id === theme)?.music ?? strings.musicPanel.moodUnknown}
        />
        <StatRow label={strings.musicPanel.levelLabel} value={strings.musicPanel.levelValue} />
        <StatRow label={strings.musicPanel.duckLabel} value={strings.musicPanel.duckValue} />
        <div className="mt-2">
          <Hint>{strings.musicPanel.hint}</Hint>
        </div>
      </Disclosure>

      {/* Opened for you the moment there is something in it, closed while
          there is not — a run that has produced thumbnails should not need a
          click to prove it. */}
      <Disclosure
        className="disclosure-panel"
        summary={strings.thumbnails.summary(thumbCount)}
        defaultOpen={thumbCount > 0}
      >
        {episode ? <Thumbnails episode={episode} /> : <EmptyState>{strings.inspector.noEpisode}</EmptyState>}
      </Disclosure>

      {episode?.hasVideo ? (
        <a
          href={`/api/episodes/${episode.id}/video`}
          download
          className="inline-flex w-full items-center justify-center rounded-lg px-3.5 py-2 text-[13px] font-semibold"
          style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
        >
          {strings.download.video}
        </a>
      ) : (
        <p className="hint">{strings.download.unavailable}</p>
      )}
    </div>
  );
}
