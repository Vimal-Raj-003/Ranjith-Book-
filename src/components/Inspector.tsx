"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { strings, VOICES, VIDEO_THEMES, AUTO_THEME_OPTION, recordedVoiceName } from "@/lib/strings";
import { EMPTY_TRACK, displayed, stepTrack, type Track, type WriteEvent } from "@/lib/setting-writes";
import { Badge, Disclosure, EmptyState, Hint, RailToggle } from "./ui";
import Thumbnails from "./Thumbnails";
import ReleaseSlider from "./ReleaseSlider";
import { TOAST_MAX_MS, useToast } from "./Toast";
import type { EpisodeState } from "./types";
// The music panel's choices, from `strings.ts` for the same reason `VOICES` is:
// `media/moods.ts` is client-safe but holds the harmony, not the names, and
// `media/ffmpeg.ts` and `settings/keys.ts` reach `node:child_process`.
import { AUTO_MUSIC_MOOD, MUSIC_DUCKS, MUSIC_INTENSITIES, MUSIC_LEVEL_RANGE, MUSIC_MOOD_OPTIONS } from "@/lib/strings";

/** Comfortably past the ~25 s a cold model takes to load, so a slow start is not called a failure. */
const PREVIEW_TIMEOUT_MS = 120_000;

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
 * The theme, voice and music controls all WRITE, through `save()`: the pipeline
 * reads the stored theme per episode, `synthesizeVoiceover` reads the stored
 * voice per run, and the music bed reads its four settings when it is made. A
 * control that remembers a choice nothing reads is worse than no control at all,
 * which is why the music panel stayed read-only until the bed read them.
 *
 * `VOICES` comes from `strings.ts`, never from `media/pocket-tts` or
 * `settings/keys`: both reach `node:child_process`, and a `"use client"`
 * component that imports either cannot be bundled.
 *
 * The first chip is Auto, and it is the default. It is not a sixth theme: it
 * means the theme is derived per video from what that video is about, which is
 * the fix for a measured defect — one global setting meant 40 real episodes came
 * out marginalia 16, editorial 20, spotlight 3, terminal 1, tracking when this
 * picker was last touched rather than anything about the books. Naming a theme
 * here still pins every video to that one, which is what an operator who wants a
 * consistent series needs; Auto is what everyone else should leave it on.
 *
 * The choice applies to the NEXT run. It is stamped onto an episode when the
 * episode is created, so changing it here never re-skins something already
 * rendered — an episode's stated look and the file on disk must always agree.
 */
/** Auto first, then the five themes — what the picker offers, in that order. */
const THEME_CHOICES = [AUTO_THEME_OPTION, ...VIDEO_THEMES];

/**
 * Where a theme's preview still lives. Written by `scripts/theme-previews.mjs`,
 * which renders one real frame per theme through `buildComposition` — not a
 * drawing of a theme, a screenshot of one.
 *
 * A plain `<img>` and a path, deliberately, rather than an import or
 * `next/image`: these are static files under `public/`, the id is one of a
 * closed set, and a theme whose still has not been generated yet must show the
 * card with its words and no picture rather than break the panel. `onError`
 * below is what makes that true.
 */
const previewSrc = (id: string) => `/theme-previews/${id}.png`;

/** How many of the chooser's ranked themes the panel points at. */
const SUGGESTION_COUNT = 3;

/**
 * One glyph per group, for the folded rail. Drawn here rather than imported:
 * `@tabler/icons` ships `.svg` files this project reads with `node:fs`, which
 * a `"use client"` component cannot do, and the brief for this work forbids a
 * new runtime dependency. Four 24px paths cost less than either.
 */
const GLYPH = {
  theme: "M12 4a8 8 0 1 0 0 16h1.5a1.5 1.5 0 0 0 1.1-2.5 1.5 1.5 0 0 1 1.1-2.5H18a2 2 0 0 0 2-2 8 8 0 0 0-8-9zM7.5 12.5h.01M10 8.5h.01M14 8h.01",
  voice: "M12 4a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v3",
  music: "M9 18V6l10-2v12M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm10-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  thumbs: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M9 9h.01",
  download: "M12 4v10m0 0 4-4m-4 4-4-4M5 18h14",
} as const;

/**
 * A stored setting value with no entry in the catalogue, made presentable.
 *
 * It exists for exactly one case: a theme id the registry does not list. That
 * happens while another workstream is widening what the picker offers, and the
 * alternative — showing the raw `auto` in a summary that otherwise reads
 * "Theme · Dark Academia" — looks like a bug rather than like a value that has
 * not been catalogued yet.
 */
function titleCase(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function RailGlyph({ d }: { d: string }) {
  return (
    <span className="rail-glyph" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  );
}

export default function Inspector({
  episode,
  collapsed = false,
  onToggleCollapsed,
}: {
  episode: EpisodeState | null;
  /** Folded to a strip of chips by the operator. Defaults to open. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const toast = useToast();
  const voiceFieldId = useId();
  const voiceHintId = `${voiceFieldId}-hint`;
  const previewHintId = `${voiceFieldId}-preview-hint`;
  const musicFieldId = useId();
  const musicHintId = `${musicFieldId}-hint`;
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
  // The themes `themes/choose.ts` ranks highest for this episode's own stored
  // words, best first — its ranking surfaced, never a second matcher written
  // here. It is a suggestion and not a reconstruction of what Auto already
  // stamped: the same matcher, run over different text (see the endpoint).
  // Empty is the normal silent state: no episode, no endpoint, no badges.
  //
  // Held WITH the episode it was answered for, and read back below only when the
  // two still agree — the same shape `shown` uses above, and for the same
  // reason: one episode's answer must never be shown against another. That also
  // keeps the effect free of a synchronous `setState` on the "no episode"
  // path, which React's own lint calls out as a cascading render.
  const [suggested, setSuggested] = useState<{ id: string; themes: string[] } | null>(null);
  /** Themes whose preview still did not load — the card keeps its words. */
  const [noPreview, setNoPreview] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const id = episode?.id;
    if (!id) return;
    // Aborted on episode change: an answer in flight for the previous episode
    // must not land on this one.
    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/episodes/${id}/themes`, { signal: abort.signal });
        if (!res.ok) return;
        const body: unknown = await res.json();
        const list = (body as { themes?: unknown })?.themes;
        if (!Array.isArray(list)) return;
        setSuggested({ id, themes: list.filter((t): t is string => typeof t === "string").slice(0, SUGGESTION_COUNT) });
      } catch {
        // Including AbortError. Nothing to report and nothing to retry.
      }
    })();
    return () => abort.abort();
  }, [episode?.id]);

  // Voice preview. One <audio> element for the life of the inspector, made on the
  // first click: a new clip replaces the last one on it, so two previews can never
  // talk over each other, and the object URL being played is the only one alive.
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const previewUrl = useRef<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    return () => {
      previewAudio.current?.pause();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);

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
   * refuses. Theme, voice and music share it, and so will anything else that is a
   * key in `PUT /api/settings`.
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

  /**
   * Hear the selected voice before a 13-minute render is committed to it.
   *
   * It sends the voice id and plays what comes back; no episode is involved and
   * none is made. The first preview after the server starts loads the speech
   * model (about 25 s), so the button says it is working and the hint beside it
   * says why.
   *
   * Not `disabled` while it waits, for the same reason the select is not: a
   * button that disables itself drops keyboard focus, and the slow first preview
   * is exactly when someone is sitting on it. `aria-disabled` and this early
   * return give the same one-request-at-a-time without that.
   */
  async function preview() {
    if (!voice || previewing) return;
    setPreviewing(true);
    try {
      const res = await fetch("/api/voice/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voiceId: voice.id }),
        // Past a cold start, short of waiting forever. The server keeps going and
        // keeps the clip, so trying again a moment later is quick.
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      });
      if (!res.ok) {
        // The server says what is wrong and what to do (not installed, would not
        // start), so that is what is shown; a body that is not ours is not.
        const body = await res.json().catch(() => null);
        const message = typeof body?.error === "string" ? body.error : strings.voicePanel.previewFailed;
        toast.show(message, "error", TOAST_MAX_MS);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const audio = (previewAudio.current ??= new Audio());
      audio.pause();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = url;
      audio.src = url;
      await audio.play();
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      toast.show(timedOut ? strings.voicePanel.previewTimedOut : strings.voicePanel.previewFailed, "error", TOAST_MAX_MS);
    } finally {
      setPreviewing(false);
    }
  }

  const theme = settings.theme ?? null;
  const voice = VOICES.find((v) => v.id === settings.voiceId);
  const suggestions = suggested && episode && suggested.id === episode.id ? suggested.themes : [];
  const suggestedSet = new Set(suggestions);

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

  // The music summary says what a render will use, as the voice one does. It is
  // the setting, not a recorded fact: the bed is made at render time from whatever
  // these are then, so there is no "what narrated it" counterpart to report.
  const musicMood = [AUTO_MUSIC_MOOD, ...MUSIC_MOOD_OPTIONS].find((m) => m.id === settings.musicMood);
  const musicIntensity = MUSIC_INTENSITIES.find((o) => o.id === settings.musicIntensity);
  const musicSummary = musicMood ? strings.musicPanel.summary(musicMood.label) : strings.musicPanel.summaryUnknown;

  // The grid's own count when it has reported one for this episode: after a
  // partial retitle the snapshot in `episode` still lists all six.
  const reported = shown && episode && shown.id === episode.id ? shown.count : null;
  const thumbCount = reported ?? episode?.thumbnails?.length ?? 0;

  // The theme group's summary, in the same shape as the voice and music ones:
  // the rail can be read top to bottom with nothing open.
  //
  // The lookup is `VIDEO_THEMES`, which is the registry's own list — not the
  // picker's array, which another workstream is in the middle of widening. A
  // stored id that is not in the registry falls back to the id itself rather
  // than to silence, so the summary is still true during that change.
  const themeSummary = theme
    ? strings.themePanel.summary(VIDEO_THEMES.find((t) => t.id === theme)?.label ?? titleCase(theme))
    : strings.themePanel.summaryUnknown;

  const thumbSummary = strings.thumbnails.summary(thumbCount);

  /**
   * One tree, two shapes — never an early return.
   *
   * The toggle is the first child of `.rail-top` in both states, so React
   * reconciles the same button instead of unmounting one and mounting another:
   * keyboard focus stays on it across a click, and a screen reader hears
   * `aria-expanded` change on an element it is already following.
   *
   * The folded strip and the full column are both in the DOM and the inactive
   * one carries `hidden`, which removes it from layout, the tab order and the
   * accessibility tree without destroying it. That is also why Voice and Music
   * stay open across a fold now: a `<details>` that is unmounted comes back at
   * its `defaultOpen`, and these are never unmounted.
   *
   * The strip is not a stub of the panel: every chip carries the live summary
   * of its group as its accessible name and its tooltip, so the whole
   * configuration is readable at 50px wide, and clicking one opens the rail.
   * The download is the exception — a real `<a download>`, because a finished
   * video is the one thing worth taking without unfolding anything.
   */
  return (
    <div className={collapsed ? "rail-strip" : "flex flex-col gap-2.5"}>
      <div className="rail-top">
        {onToggleCollapsed && (
          <RailToggle
            rail="insp"
            expanded={!collapsed}
            label={strings.layout.toggleSettings}
            onToggle={onToggleCollapsed}
          />
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-2" hidden={collapsed}>
          <h2 className="font-display text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
            {strings.inspector.heading}
          </h2>
          <p className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--mute-2)" }}>
            {episode ? episode.title || strings.studio.untitled : strings.inspector.noEpisode}
          </p>
        </div>
      </div>

      <div className="rail-strip-chips" hidden={!collapsed}>
        {[
          { key: "theme", glyph: GLYPH.theme, text: themeSummary },
          { key: "voice", glyph: GLYPH.voice, text: voiceSummary },
          { key: "music", glyph: GLYPH.music, text: musicSummary },
          { key: "thumbs", glyph: GLYPH.thumbs, text: thumbSummary },
        ].map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="rail-chip"
            aria-label={strings.layout.openSettingsFor(chip.text)}
            title={chip.text}
            onClick={onToggleCollapsed}
          >
            <RailGlyph d={chip.glyph} />
            <span className="rail-text">{chip.text}</span>
          </button>
        ))}
        {episode?.hasVideo && (
          <a
            href={`/api/episodes/${episode.id}/video`}
            download
            className="rail-chip"
            data-state="on"
            aria-label={strings.download.video}
            title={strings.download.video}
          >
            <RailGlyph d={GLYPH.download} />
            <span className="rail-text">{strings.download.video}</span>
          </a>
        )}
      </div>

      <div className="insp-groups" hidden={collapsed}>

      {/* A group, like voice and music below it, rather than the one panel
          that was always open. Eleven themes is six rows of chips; naming the
          chosen one in the summary means the rail answers "what will this
          render look like" without any of that being on screen. */}
      <Disclosure className="disclosure-panel theme-group" summary={themeSummary} defaultOpen>
        {/* Still five real buttons carrying aria-pressed — a shorter row, not
            a weaker control. The name is the label; the description moved to
            the disclosure below rather than being dropped. */}
        <ul role="list" className="chip-grid">
          {THEME_CHOICES.map((t) => {
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

          {/* The preview cards. Eleven themes is well past the point where a
              grid of names tells anyone anything — "Atelier" and "Dossier" are
              words, not looks — and guessing wrong costs a full render. Each
              card carries a real frame out of this app's own compositor, so the
              picker shows the thing instead of describing it. Closed by
              default: the operator who already knows which theme they want
              should not have to scroll past eleven pictures to click a chip. */}
          <Disclosure quiet summary={strings.themePanel.previewsSummary}>
            <ul role="list" className="grid grid-cols-2 gap-2">
              {VIDEO_THEMES.map((t) => {
                const selected = theme === t.id;
                return (
                  <li key={t.id} className="flex">
                    {/* The whole card is the button, not a picture with a
                        button under it: the picture is the thing being chosen,
                        and a click on it should choose. aria-pressed, like the
                        chips above — this is the same control, shown larger. */}
                    <button
                      type="button"
                      className="flex w-full flex-col gap-1 rounded-lg border p-1.5 text-left"
                      style={{
                        borderColor: selected ? "color-mix(in srgb, var(--amber) 55%, transparent)" : "var(--line)",
                        background: selected ? "color-mix(in srgb, var(--amber) 12%, transparent)" : "transparent",
                      }}
                      aria-pressed={selected}
                      onClick={() => save("theme", t.id)}
                    >
                      {/* A still that 404s drops out and leaves the words: a
                          theme added before `scripts/theme-previews.mjs` has
                          been re-run shows an honest line, never a broken-image
                          icon. Tracked in state rather than by poking the DOM,
                          so React owns what is on screen. */}
                      {noPreview.has(t.id) ? (
                        <p className="hint">{strings.themePanel.previewMissing}</p>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- already rendered at exactly this slot's size by scripts/theme-previews.mjs; re-encoding a 270x480 PNG per request is pure overhead
                        <img
                          src={previewSrc(t.id)}
                          alt={strings.themePanel.previewAlt(t.label)}
                          width={270}
                          height={480}
                          loading="lazy"
                          decoding="async"
                          className="w-full rounded"
                          style={{ aspectRatio: "9 / 16", objectFit: "cover", background: "var(--slab-2)" }}
                          onError={() => setNoPreview((all) => (all.has(t.id) ? all : new Set(all).add(t.id)))}
                        />
                      )}
                      <span className="text-[12px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
                        {t.label}
                      </span>
                      {suggestedSet.has(t.id) && (
                        <span>
                          <Badge tone="live">{strings.themePanel.suggested}</Badge>
                        </span>
                      )}
                      <span className="text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
                        {t.description}
                      </span>
                      <span className="text-[11px] leading-snug" style={{ color: "var(--mute-2)" }}>
                        {t.bestFor}
                      </span>
                      {selected && <span className="sr-only">{strings.themePanel.current}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 hint">{strings.themePanel.previewsBody}</p>
            {suggestions.length > 0 && <p className="mt-1 hint">{strings.themePanel.suggestedBody}</p>}
          </Disclosure>

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
      </Disclosure>

      {/* Closed by default: the operator sets this once and leaves it, and the
          summary carries the answer, so you do not have to open the panel to
          learn what a render will use. Pocket voices only -- no provider choice
          is offered, because the list below is Pocket's and sending one of its
          ids to another provider would ask it for a voice it does not have. */}
      <Disclosure className="disclosure-panel" summary={voiceSummary}>
        <label className="field-label" htmlFor={voiceFieldId}>
          {strings.voicePanel.selectLabel}
        </label>
        <div className="flex items-stretch gap-2">
          <select
            id={voiceFieldId}
            className="control min-w-0 flex-1"
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
          <button
            type="button"
            className="shrink-0 rounded-lg border px-3 text-[13px] font-semibold"
            style={{
              borderColor: "var(--line)",
              color: "var(--ink)",
              background: "var(--slab-2)",
              opacity: voice ? 1 : 0.5,
              cursor: previewing ? "progress" : undefined,
            }}
            aria-disabled={!voice || previewing}
            aria-busy={previewing}
            aria-describedby={previewHintId}
            onClick={preview}
          >
            {previewing ? strings.voicePanel.previewing : strings.voicePanel.preview}
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <Hint id={voiceHintId}>{strings.voicePanel.hint}</Hint>
          <Hint id={previewHintId}>{strings.voicePanel.previewHint}</Hint>
        </div>
      </Disclosure>

      {/* Every control here writes through `save()`, and the pipeline reads all four
          settings when it makes the bed (`settings/music.ts`), so none of them is
          decoration. Closed by default for the same reason the voice panel is. */}
      <Disclosure className="disclosure-panel" summary={musicSummary}>
        <label className="field-label" htmlFor={`${musicFieldId}-mood`}>
          {strings.musicPanel.moodLabel}
        </label>
        <select
          id={`${musicFieldId}-mood`}
          className="control"
          aria-describedby={musicHintId}
          value={musicMood?.id ?? ""}
          onChange={(e) => save("musicMood", e.target.value)}
        >
          {!musicMood && (
            <option value="" disabled>
              {strings.musicPanel.moodPlaceholder}
            </option>
          )}
          {[AUTO_MUSIC_MOOD, ...MUSIC_MOOD_OPTIONS].map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.note}
            </option>
          ))}
        </select>

        {/* Three real buttons carrying aria-pressed, like the theme chips: a
            segmented control is a group of toggles, and a radio group would ask
            the arrow keys to move the choice AND the write. */}
        <span className="field-label mt-3" id={`${musicFieldId}-layers`}>
          {strings.musicPanel.intensityLabel}
        </span>
        <div
          role="group"
          aria-labelledby={`${musicFieldId}-layers`}
          aria-describedby={`${musicFieldId}-layers-note`}
          className="chip-grid"
          style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        >
          {MUSIC_INTENSITIES.map((o) => {
            const selected = settings.musicIntensity === o.id;
            return (
              <button
                key={o.id}
                type="button"
                className="chip"
                data-state={selected ? "on" : "off"}
                aria-pressed={selected}
                title={o.note}
                onClick={() => save("musicIntensity", o.id)}
              >
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-1">
          <Hint id={`${musicFieldId}-layers-note`}>{musicIntensity?.note ?? " "}</Hint>
        </div>

        <label className="field-label mt-3" htmlFor={`${musicFieldId}-level`}>
          {strings.musicPanel.levelLabel}
        </label>
        <ReleaseSlider
          id={`${musicFieldId}-level`}
          min={MUSIC_LEVEL_RANGE.min}
          max={MUSIC_LEVEL_RANGE.max}
          step={MUSIC_LEVEL_RANGE.step}
          value={settings.musicLevel}
          format={strings.musicPanel.levelValue}
          onCommit={(v) => save("musicLevel", v)}
        />

        <label className="field-label mt-3" htmlFor={`${musicFieldId}-duck`}>
          {strings.musicPanel.duckLabel}
        </label>
        <select
          id={`${musicFieldId}-duck`}
          className="control"
          aria-describedby={musicHintId}
          value={settings.musicDuck ?? ""}
          onChange={(e) => save("musicDuck", e.target.value)}
        >
          {!MUSIC_DUCKS.some((d) => d.id === settings.musicDuck) && (
            <option value="" disabled>
              {strings.musicPanel.duckPlaceholder}
            </option>
          )}
          {MUSIC_DUCKS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} — {d.note}
            </option>
          ))}
        </select>

        <div className="mt-2">
          <Hint id={musicHintId}>{strings.musicPanel.hint}</Hint>
        </div>
      </Disclosure>

      {/* Opened for you the moment there is something in it, closed while
          there is not — a run that has produced thumbnails should not need a
          click to prove it. */}
      <Disclosure className="disclosure-panel" summary={thumbSummary} defaultOpen={thumbCount > 0}>
        {episode ? (
          <Thumbnails episode={episode} onCount={reportThumbs} />
        ) : (
          <EmptyState>{strings.inspector.noEpisode}</EmptyState>
        )}
      </Disclosure>

      {/* The same control it always was, in a quieter skin. The filled cyan
          button beside the video in the preview is the primary call to action
          on this screen; a second identical one two inches to the right is the
          "multiple competing CTAs" the operator named. Outlined, it is still
          obviously a download and no longer argues with the other one. */}
      {episode?.hasVideo ? (
        <a
          href={`/api/episodes/${episode.id}/video`}
          download
          className="inline-flex w-full items-center justify-center gap-2 rounded-[var(--r-control)] border px-3.5 py-2 text-[13px] font-semibold"
          style={{ borderColor: "color-mix(in srgb, var(--cyan) 55%, transparent)", color: "var(--cyan)" }}
        >
          <RailGlyph d={GLYPH.download} />
          {strings.download.video}
        </a>
      ) : (
        <p className="hint">{strings.download.unavailable}</p>
      )}
      </div>
    </div>
  );
}
