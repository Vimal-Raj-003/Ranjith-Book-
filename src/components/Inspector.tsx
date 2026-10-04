"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { strings, VOICES, VIDEO_THEMES, recordedVoiceName } from "@/lib/strings";
import { EMPTY_TRACK, displayed, stepTrack, type Track, type WriteEvent } from "@/lib/setting-writes";
import { Badge, Disclosure, EmptyState, Hint, Panel, StatRow } from "./ui";
import Thumbnails from "./Thumbnails";
import { useToast } from "./Toast";
import type { EpisodeState } from "./types";

/**
 * Theme, voice, music, thumbnails, download — in a column that has to end
 * above the fold on a 1440×780 laptop.
 *
 * What that cost, and what it did not: the theme picker is the only thing here
 * the operator touches on a normal run, so it is the only thing left open. It
 * is now a grid of chips rather than five stacked paragraphs; the paragraphs
 * are one `<details>` below it, so what each theme looks like is one keypress
 * away rather than gone. Voice and music are panels for things the operator
 * sets once and leaves, so they are collapsed by default and say their answer
 * in the summary — "Voice · Charles" tells you what a render will use without
 * being opened at all. For a finished episode the voice summary says what
 * narrated THAT video instead, which stops being the same question the moment
 * the setting is changed.
 *
 * The theme and voice pickers WRITE, both through `save()`: the pipeline reads
 * the stored theme per episode and `synthesizeVoiceover` reads the stored voice
 * per run. A control that remembers a choice nothing reads is worse than no
 * control at all, which is why the music panel below still only reports.
 *
 * `VOICES` comes from `strings.ts`, never from `media/pocket-tts` or
 * `settings/keys`: both reach `node:child_process`, and a `"use client"`
 * component that imports either cannot be bundled.
 *
 * The choice applies to the NEXT run. It is stamped onto an episode when the
 * episode is created, so changing it here never re-skins something already
 * rendered — an episode's stated look and the file on disk must always agree.
 */
export default function Inspector({ episode }: { episode: EpisodeState | null }) {
  const toast = useToast();
  const voiceFieldId = useId();
  const voiceHintId = `${voiceFieldId}-hint`;
  // What each control shows, by key: what `GET /api/settings` said, with any
  // edit still in flight laid over it. A key that is absent has not been read
  // (or could not be), which the controls show as nothing selected rather than
  // as a default they are not sure of.
  const [settings, setSettings] = useState<Record<string, string>>({});
  // Per key, what the server is KNOWN to hold, what the operator wants, and which
  // write is on its way -- `setting-writes.ts` is the state machine. A ref, not
  // state: answers arrive between renders and each must see the last one's effect.
  const tracks = useRef<Record<string, Track>>({});
  // How many posters the grid is really showing, as the grid reports it. Held
  // against the episode it was reported for, so switching episodes can never
  // show one episode's count on another.
  const [shown, setShown] = useState<{ id: string; count: number } | null>(null);
  const reportThumbs = useCallback(
    (id: string, count: number) =>
      setShown((current) => (current && current.id === id && current.count === count ? current : { id, count })),
    [],
  );

  /**
   * Advance one key's write state by `first`, and keep going while the machine
   * says there is another write to send. One loop runs per key at a time: a
   * choice made while a write is outstanding only updates the state and returns,
   * and the loop already waiting on that write picks it up.
   */
  const drive = useCallback(
    async (key: string, first: WriteEvent) => {
      let event = first;
      for (;;) {
        const step = stepTrack(tracks.current[key] ?? EMPTY_TRACK, event);
        tracks.current[key] = step.track;
        const value = displayed(step.track);
        setSettings((all) => {
          if (all[key] === value) return all;
          const next = { ...all };
          if (value === undefined) delete next[key];
          else next[key] = value;
          return next;
        });
        if (step.rolledBack) toast.show(strings.inspector.saveFailed, "error"); // rolled back rather than lie about it
        if (step.send === undefined) return;

        let ok = false;
        try {
          const res = await fetch("/api/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [key]: step.send }),
          });
          ok = res.ok;
        } catch {
          // Unreachable counts as refused: the server was not told.
        }
        event = { type: ok ? "saved" : "failed" };
      }
    },
    [toast],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        // Each value is what the server holds. A choice made while this was in
        // flight is newer, and `setting-writes` keeps it on top.
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === "string") void drive(key, { type: "read", value });
        }
      } catch {
        // A settings read that fails leaves the picker showing nothing
        // selected, which is honest — better than asserting a default that
        // may not be what the renderer will actually use.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drive]);

  /**
   * Write one setting: the control moves at once, and goes back if the server
   * refuses. Theme and voice share it, and so will anything else that is a key
   * in `PUT /api/settings`.
   *
   * Nothing is disabled while a write is in flight. A `<select>` that disables
   * itself loses keyboard focus, so stepping through voices with the arrow keys
   * would stop after the first. The ordering is kept in `setting-writes.ts`
   * instead: one write per key is outstanding at a time, so they reach the
   * server in the order they were chosen, and a refusal goes back to the last
   * value the server is known to hold -- never to one the operator only passed
   * through on the way.
   */
  function save(key: string, value: string) {
    void drive(key, { type: "want", value });
  }

  const theme = settings.theme ?? null;
  const voice = VOICES.find((v) => v.id === settings.voiceId);

  // For a finished episode the summary names what narrated IT, not what the
  // next run will use -- the two differ as soon as the setting is changed. Any
  // episode with a recorded voice gets it (a run that failed after the voice
  // step still knows), and a DONE one without says so. An episode that has not
  // got that far has nothing to report, so the line is the setting, as before.
  const narrator = episode ? recordedVoiceName(episode.voiceProvider, episode.voiceId) : null;
  const voiceSummary = narrator
    ? strings.voicePanel.summaryNarrated(narrator)
    : episode?.status === "DONE"
      ? strings.voicePanel.summaryNotRecorded
      : voice
        ? strings.voicePanel.summary(voice.label)
        : strings.voicePanel.summaryUnknown;

  // The grid's own count when it has reported one for this episode: after a
  // partial retitle the snapshot in `episode` still lists all six.
  const reported = shown && episode && shown.id === episode.id ? shown.count : null;
  const thumbCount = reported ?? episode?.thumbnails?.length ?? 0;

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
                  disabled={!t.available}
                  title={t.note}
                  onClick={() => save("theme", t.id)}
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

      {/* Closed by default: the operator sets this once and leaves it, and the
          summary carries the answer, so you do not have to open the panel to
          learn what a render will use. Pocket voices only -- no provider choice
          is offered, because the list below is Pocket's and sending one of its
          ids to another provider would ask it for a voice it does not have. */}
      <Disclosure className="disclosure-panel" summary={voiceSummary}>
        <label className="field-label" htmlFor={voiceFieldId}>
          {strings.voicePanel.selectLabel}
        </label>
        <select
          id={voiceFieldId}
          className="control"
          value={voice?.id ?? ""}
          aria-describedby={voiceHintId}
          onChange={(e) => save("voiceId", e.target.value)}
        >
          {!voice && (
            <option value="" disabled>
              {strings.voicePanel.placeholder}
            </option>
          )}
          {(["female", "male"] as const).map((gender) => (
            <optgroup key={gender} label={strings.voicePanel.genderLabel[gender]}>
              {VOICES.filter((v) => v.gender === gender).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} — {v.note}
                </option>
              ))}
            </optgroup>
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
        {episode ? (
          <Thumbnails episode={episode} onCount={reportThumbs} />
        ) : (
          <EmptyState>{strings.inspector.noEpisode}</EmptyState>
        )}
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
