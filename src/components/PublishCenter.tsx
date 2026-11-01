"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import CopyBlock from "./CopyBlock";
import PublishFlow from "./PublishFlow";
import InstagramConnection from "./InstagramConnection";
import { Badge, Disclosure, EmptyState, Hint, Panel, Skeleton } from "./ui";
import { useToast } from "./Toast";
import { strings } from "@/lib/strings";
import { safeHref } from "@/lib/publish/flow";
import {
  PLATFORM_LIMITS,
  hashtagLine,
  hasIndependentInstagram,
  instagramCaption,
  normaliseHashtags,
  normaliseTags,
  tagsLine,
  type PublishMetadata,
  type VariantFieldKey,
} from "@/lib/publish/limits";
import { pickPosterFor } from "@/lib/thumbnails/choose";
import {
  isListField,
  missingPlatformFields,
  type HandoffStep,
  type MetadataField,
  type PlatformState,
  type PublicThumb,
  type PublishView,
  type VariantField,
} from "@/lib/publish/view";
import type { EpisodeState } from "./types";

/**
 * The Publish page: what goes out, what it says, where it goes, and what happened.
 *
 * It is laid out the way the operator drew it, top to bottom:
 *
 *   1. the header, `Publish – <video title>`;
 *   2. the video and its thumbnail, side by side, each with its Download;
 *   3. a YouTube block -- Title, Description, Tags, Hashtags, each with Rewrite and Copy --
 *      and its own Publish;
 *   4. an Instagram block -- Title, Caption, Hashtags -- the same way;
 *   5. Visibility, 6. Schedule, and 7. the three publish buttons.
 *
 * Blocks 3 to 7 live in `PublishFlow`; the editors inside blocks 3 and 4 are rendered HERE and
 * handed down, because their drafts, Save, Rewrite (the old Regenerate) and hand-edit protection
 * are this component's, exactly as they were. The cover picker, the by-hand hand-off and the four
 * copy blocks the operator has pasted from for months are all still here, folded below.
 *
 * THE CONNECTION AND THE BROWSER WINDOW ARE NOT SECTIONS ANY MORE. The OAuth grant card and the
 * browser-window card used to sit inside every platform card; the operator asked for them gone
 * from the page. They are gone from the layout, not from the app: `YouTubePublish`,
 * `InstagramPublish` and `BrowserPublish` still exist, the connect and sign-in routes still
 * answer, and the publish engine still runs -- the Publish buttons go through it. What a
 * connection used to show is now said where it matters: a stop for a sign-in is on the result,
 * with the Sign in button beside it.
 *
 * TWO RULES SHAPE EVERY LINE OF THIS FILE.
 *
 * 1. NOTHING IS FAKED. Every status is the job row's, which the engine writes only from the
 *    platform's own page (or API answer). A press that has not been confirmed is shown as in
 *    progress or as needing the operator, never as posted. Every control either does its job or
 *    is not rendered: a Download that would 404 is not shown.
 *
 * 2. THE COPY BLOCKS CANNOT REGRESS. They are fed from the publish view when it has loaded and
 *    from the polled episode snapshot when it has not, so a failed or stale `GET .../publish`
 *    leaves them working exactly as they did before this surface existed. That is why
 *    `copyMetadata` falls back the way it does rather than rendering nothing until the fetch lands.
 *
 * All provider knowledge stops at the API. This component never names an API, never holds a token,
 * and never sees a credential: it renders capabilities, statuses and handoff steps that arrived as
 * JSON.
 */

/** The character or tag count beside a field, red when it is over. */
function Measure({ field }: { field: VariantField }) {
  const over = field.over;
  const reading =
    field.countLimit !== undefined
      ? strings.publishCenter.tagCounter(field.count ?? 0, field.countLimit)
      : strings.publishCenter.counter(field.length, field.limit ?? 0);
  return (
    <span className="pub-count" data-over={over ? "true" : "false"}>
      {reading}
    </span>
  );
}

function CopyButton({ label, text, ariaLabel }: { label: string; text: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      className="chip"
      // Said in full for a screen reader ("Copy title"), because seven buttons that all read "Copy" are not seven answers.
      aria-label={ariaLabel ? (copied ? strings.publishCenter.flow.copied : ariaLabel) : undefined}
      // Not `disabled`: a control that disables itself drops keyboard focus,
      // and there is nothing to wait for here anyway.
      aria-disabled={text === "" ? "true" : undefined}
      onClick={async () => {
        if (text === "") return;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // A browser that refuses the clipboard (no permission, no secure
          // context) must not leave the button claiming it copied.
          return;
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
    >
      <span className="truncate">{copied ? "Copied" : label}</span>
    </button>
  );
}

/** One handoff step, as the control it actually is. */
function HandoffControl({ step }: { step: HandoffStep }) {
  if (step.kind === "copy") return <CopyButton label={step.label} text={step.text ?? ""} />;

  const href = safeHref(step.href);
  // No usable link means no link. An anchor with no href is not a control.
  if (!href) return <span className="hint">{step.label}</span>;

  if (step.kind === "download") {
    return (
      <a className="chip" href={href} download>
        <span className="truncate">{step.label}</span>
      </a>
    );
  }
  return (
    <a className="chip" href={href} target="_blank" rel="noopener noreferrer">
      <span className="truncate">{step.label}</span>
      <span className="sr-only"> — {strings.publishCenter.openInNewTab}</span>
    </a>
  );
}

/**
 * The by-hand hand-off for one platform: the files to download, the text to copy, a link to the
 * platform's own uploader, and the record that says "I handed this over".
 *
 * It is the old platform card with its two connection cards taken out. It posts nothing and never
 * says it did -- the record button only writes down that these words and files were handed over,
 * and when. It lives in a fold at the bottom of the page, for the day the operator would rather
 * post it themselves than press Publish.
 */
function HandoffCard({
  state,
  recording,
  onRecord,
}: {
  state: PlatformState;
  recording: boolean;
  onRecord: () => void;
}) {
  const c = strings.publishCenter;
  const job = state.job;

  return (
    <section className="pub-platform" aria-labelledby={`pub-hand-${state.platform}`}>
      <header className="pub-platform-head">
        <h4 id={`pub-hand-${state.platform}`} className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
          {state.label}
        </h4>
      </header>

      {/* The cover THIS platform will use -- the one its handoff downloads and
          (for YouTube) its upload sets as the thumbnail. Chosen in the picker;
          shown here so the card and what goes out cannot disagree. */}
      {state.cover && (
        <div className="pub-platform-cover" data-aspect={state.cover.aspect}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.cover.url} alt={c.thumbAlt(state.cover.aspect)} />
          <span className="hint">{c.thumbAspect(state.cover.aspect)}</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="eyebrow">{c.handoffHeading}</p>
        <div className="pub-actions">
          {state.handoff.map((step) => (
            <HandoffControl key={`${step.kind}-${step.label}`} step={step} />
          ))}
        </div>
        <div className="pub-actions">
          <button type="button" className="chip" onClick={onRecord} aria-disabled={recording ? "true" : undefined}>
            <span className="truncate">{recording ? c.recording : c.recordHandoff}</span>
          </button>
          {job?.preparedAt && (
            <span className="hint">
              {c.recordedAt(new Date(job.preparedAt).toLocaleString())} · {c.attemptsLabel(job.attempts)}
            </span>
          )}
        </div>
        <Hint>{c.recordHint}</Hint>
      </div>
    </section>
  );
}

/**
 * One editable field, with its counter, its Save, its Regenerate, and the
 * confirmation a hand-edited field demands before Regenerate replaces it.
 *
 * The confirmation is INLINE, not a `window.confirm` and not a modal: the
 * question is about this field and belongs beside it, and the server refuses
 * without `confirm: true` regardless, so this is the prompt for a decision the
 * API is already enforcing rather than the enforcement itself.
 */
function FieldEditor({
  label,
  name,
  value,
  measure,
  edited,
  rows,
  hint,
  busy,
  dirty,
  confirming,
  copyText,
  copyLabel,
  onChange,
  onSave,
  onRegenerate,
  onConfirm,
  onCancelConfirm,
}: {
  label: string;
  /** A friendly name for prose sentences (the overwrite confirmation), when the
   *  visible label reads awkwardly inside one ("Tags (keywords)" → "tags"). */
  name?: string;
  value: string;
  measure: VariantField | null;
  edited: boolean;
  rows?: number;
  hint?: string;
  busy: "save" | "regen" | null;
  dirty: boolean;
  confirming: boolean;
  /** When set, a Copy button for this field's text sits beside Save/Regenerate. */
  copyText?: string;
  copyLabel?: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onRegenerate: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}) {
  const c = strings.publishCenter;
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="pub-field">
      <div className="pub-field-head">
        <label className="field-label" htmlFor={id} style={{ marginBottom: 0 }}>
          {label}
        </label>
        <div className="flex items-center gap-2">
          <Badge tone={edited ? "live" : "plain"}>{edited ? c.handEdited : c.asWritten}</Badge>
          {measure && <Measure field={measure} />}
        </div>
      </div>

      {/* The field on the left, its buttons on the right (they wrap under it on a narrow stage). */}
      <div className="pub-field-row">
        <div className="pub-field-input">
          {rows ? (
            <textarea
              id={id}
              className="control"
              rows={rows}
              value={value}
              aria-describedby={hintId}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              id={id}
              type="text"
              className="control"
              value={value}
              aria-describedby={hintId}
              onChange={(e) => onChange(e.target.value)}
            />
          )}

          {hint && <Hint id={hintId}>{hint}</Hint>}
        </div>

        <div className="pub-field-actions">
          {/* Rewrite is the old Regenerate: the same action, the same route, the same overwrite
              confirmation below. Only the word changed, to the one the wireframe uses. */}
          <button
            type="button"
            className="chip"
            aria-label={`${c.regenerate} ${name ?? label}`}
            aria-disabled={busy !== null ? "true" : undefined}
            onClick={() => busy === null && onRegenerate()}
          >
            <span className="truncate">{busy === "regen" ? c.regenerating : c.regenerate}</span>
          </button>
          {copyText !== undefined && <CopyButton label={c.flow.copy} ariaLabel={copyLabel ?? c.copyField} text={copyText} />}
          <button
            type="button"
            className="chip"
            data-state={dirty ? "on" : undefined}
            aria-label={`${c.save} ${name ?? label}`}
            aria-disabled={!dirty || busy !== null ? "true" : undefined}
            onClick={() => dirty && busy === null && onSave()}
          >
            <span className="truncate">{busy === "save" ? c.saving : c.save}</span>
          </button>
        </div>
      </div>

      {confirming && (
        <div className="pub-confirm" role="alert">
          <p>{c.confirmBody(name ?? label)}</p>
          <div className="pub-actions">
            <button type="button" className="chip" data-state="on" onClick={onConfirm}>
              <span className="truncate">{c.confirmYes}</span>
            </button>
            <button type="button" className="chip" onClick={onCancelConfirm}>
              <span className="truncate">{c.confirmNo}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The four copy blocks, unchanged in content and in order.
 *
 * `PublishPanel` rendered exactly these, from exactly these values, and the
 * Instagram caption is composed by `instagramCaption` — which is that panel's
 * own `[hook, description, hashtags].filter(Boolean).join("\n\n")` moved into
 * `limits.ts` without a byte changed. The "only what exists is shown" rule is
 * kept too: an empty box is indistinguishable from a broken one, so a missing
 * field is left out and named in one line instead.
 */
function CopyBlocks({ meta, status }: { meta: PublishMetadata; status: string }) {
  const hashtags = hashtagLine(meta.hashtags);
  const caption = instagramCaption(meta);
  const hasCopy = Boolean(meta.title || meta.description || hashtags);

  if (!hasCopy) {
    return <Hint>{status === "DONE" ? strings.publish.empty : strings.publish.waiting}</Hint>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2">
        {meta.title && <CopyBlock label={strings.publish.youtubeTitle} value={meta.title} rows={2} />}
        {hashtags && <CopyBlock label={strings.publish.hashtags} value={hashtags} mono rows={2} />}
        {meta.description && <CopyBlock label={strings.publish.youtubeDescription} value={meta.description} rows={4} />}
        {caption && <CopyBlock label={strings.publish.instagram} value={caption} rows={4} />}
      </div>
      {(!meta.description || !hashtags) && <Hint>{strings.publish.partial}</Hint>}
    </div>
  );
}

/**
 * The per-platform cover picker: the six posters the episode already has, with
 * the one chosen for each platform marked and a Download beside each.
 *
 * It GENERATES NOTHING — every image here is an existing poster served by the
 * thumbnail route, and choosing one only writes a pointer. The effective choice
 * is resolved by `pickPosterFor`: the platform's own override, else the
 * episode-wide choice, else the first poster of the aspect that platform
 * favours (YouTube wide, Instagram tall). When the episode has no posters yet it
 * says so rather than showing an empty grid.
 */
function ThumbnailPicker({
  thumbnails,
  choices,
  busy,
  onChoose,
}: {
  thumbnails: PublicThumb[];
  choices: { youtube: string | null; instagram: string | null; default: string | null };
  busy: "youtube" | "instagram" | null;
  onChoose: (platform: "youtube" | "instagram", key: string) => void;
}) {
  const c = strings.publishCenter;
  const ytKey = pickPosterFor(thumbnails, choices.youtube, choices.default, "16:9")?.key ?? null;
  const igKey = pickPosterFor(thumbnails, choices.instagram, choices.default, "9:16")?.key ?? null;

  return (
    // Folded under the media row by the page, whose summary already names it, so the section is
    // labelled rather than headed a second time.
    <section className="flex flex-col gap-2" aria-label={c.thumbnailsHeading}>
      <Hint>{c.thumbnailsHint}</Hint>
      {thumbnails.length === 0 ? (
        <EmptyState>{c.thumbnailsEmpty}</EmptyState>
      ) : (
        <ul className="pub-thumbs" role="list">
          {thumbnails.map((t) => {
            const isYT = t.key === ytKey;
            const isIG = t.key === igKey;
            return (
              <li key={t.key} className="pub-thumb" data-aspect={t.aspect}>
                <div className="pub-thumb-frame">
                  {/* A plain <img>: the bytes come from a session-guarded route,
                      so `next/image` has nothing to optimise. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.url} alt={c.thumbAlt(t.aspect)} />
                </div>
                <div className="pub-thumb-meta">
                  <span className="hint">{c.thumbAspect(t.aspect)}</span>
                  <div className="flex items-center gap-1">
                    {isYT && <Badge tone="done">{c.thumbYouTubeBadge}</Badge>}
                    {isIG && <Badge tone="done">{c.thumbInstagramBadge}</Badge>}
                  </div>
                </div>
                <div className="pub-actions">
                  <button
                    type="button"
                    className="chip"
                    data-state={isYT ? "on" : undefined}
                    aria-pressed={isYT}
                    aria-disabled={busy !== null ? "true" : undefined}
                    onClick={() => busy === null && onChoose("youtube", t.key)}
                  >
                    <span className="truncate">{c.thumbUseYouTube}</span>
                  </button>
                  <button
                    type="button"
                    className="chip"
                    data-state={isIG ? "on" : undefined}
                    aria-pressed={isIG}
                    aria-disabled={busy !== null ? "true" : undefined}
                    onClick={() => busy === null && onChoose("instagram", t.key)}
                  >
                    <span className="truncate">{c.thumbUseInstagram}</span>
                  </button>
                  <a className="chip" href={t.url} download>
                    <span className="truncate">{c.thumbDownload}</span>
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The state of an episode's one-time "write the missing tags and Instagram copy"
 * request. Absent means it has not been asked yet; `done` is a request that
 * answered (the fields are then either filled, or -- if the writer returned
 * nothing -- still missing, which the panel reports as a failure).
 */
type GenState = { phase: "running" } | { phase: "error"; message: string } | { phase: "done" };

/** POST the generate route. Resolves, never rejects: a dropped connection is a failed result like any other. */
async function requestGenerate(episodeId: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api/episodes/${episodeId}/publish/generate`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: {} };
  }
}

/**
 * What the panel says while the tags / Instagram copy are being written, or
 * when writing them failed. Never both, and never nothing: an empty field with
 * no explanation reads as a bug, and a failed model call that left no trace
 * reads as the product not working.
 *
 * Exported for `tests/publish.test.mts`, which renders it in each state.
 */
export function GenerateNotice({
  state,
  what,
  detail,
  busy,
  onGenerate,
}: {
  state: "running" | "error";
  /** What is being written, in the operator's words -- "the YouTube tags...". */
  what: string;
  /** Why it failed, when the server said. */
  detail?: string;
  busy?: boolean;
  onGenerate: () => void;
}) {
  const c = strings.publishCenter;
  if (state === "running") {
    return (
      <div className="pub-generating" role="status" aria-live="polite" aria-busy="true">
        <p>{what}</p>
        <p className="hint">{c.generatingHint}</p>
      </div>
    );
  }
  return (
    <div className="pub-problems" role="alert">
      <p>
        {c.generateFailed}
        {detail ? ` ${detail}` : ""}
      </p>
      <div className="pub-actions">
        <button type="button" className="chip" aria-disabled={busy ? "true" : undefined} onClick={() => !busy && onGenerate()}>
          <span className="truncate">{busy ? c.generating : c.generate}</span>
        </button>
      </div>
    </div>
  );
}

/** Friendly names for the fields, for the toast and the overwrite confirmation. */
const FIELD_NAMES: Record<MetadataField, string> = {
  title: "title",
  description: "description",
  hashtags: "hashtags",
  tags: "tags",
  igHook: "Instagram hook",
  igCaption: "Instagram caption",
  igHashtags: "Instagram hashtags",
};

type Busy = { kind: "save" | "regen"; field: MetadataField } | { kind: "record"; platform: string } | null;

export default function PublishCenter({
  episode,
  initialView = null,
}: {
  episode: EpisodeState | null;
  /**
   * A publish view to start from instead of waiting for the first fetch -- the seam a server render
   * (and the tests, which have no browser) use to see the loaded page. The mount still reads the
   * server's answer and replaces it, so this can never leave a stale view on screen.
   */
  initialView?: PublishView | null;
}) {
  const c = strings.publishCenter;
  const toast = useToast();

  /**
   * `fetched` carries the episode id it belongs to, so "whose state is this?"
   * is answered by the value itself rather than by a ref that has to be kept in
   * step. Switching episodes mid-fetch therefore cannot show one video's
   * metadata on another's panel: `view` below is null unless the ids match.
   */
  const [fetched, setFetched] = useState<{ id: string; view: PublishView | null; error: string | null } | null>(() =>
    initialView ? { id: initialView.episodeId, view: initialView, error: null } : null,
  );
  /** The episode whose drafts the page has started clean for, so a poll's refresh never throws away what is being typed. */
  const startedFor = useRef<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<MetadataField, string>>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState<MetadataField | null>(null);
  /** The platform whose cover is being saved right now (`youtube`/`instagram`), or null. */
  const [thumbBusy, setThumbBusy] = useState<"youtube" | "instagram" | null>(null);
  /** Bumped by the Retry button to ask the effect for another go. */
  const [reloads, setReloads] = useState(0);
  /**
   * The one-time "write the missing tags and Instagram copy" request, per
   * episode id. A map, not a single value: a request takes a minute or two and
   * the operator may switch episodes and come back, and the state of the one
   * they left must still be there to show.
   */
  const [gen, setGen] = useState<Record<string, GenState>>({});
  /** Episodes this mount has already asked about, so opening one panel asks ONCE. */
  const asked = useRef<Set<string>>(new Set());

  const id = episode?.id ?? null;
  const status = episode?.status ?? "";
  const hasVideo = episode?.hasVideo ?? false;

  /**
   * Read the publish state when the episode changes, and when either of the two
   * things that can change the answer changes: the run finishing, and a render
   * appearing. NOT on every poll — the 1.5s snapshot moves on `step` all
   * through a run, and refetching here on each tick would be dozens of requests
   * answering the same question.
   *
   * Nothing is set synchronously in this effect body, deliberately: a setState
   * in an effect body is a cascading render (React's own lint says so,
   * correctly, and the inspector's settings reads are written the same way).
   * The loading and error states below are DERIVED from `fetched` instead, so
   * there is nothing to set until the request has actually answered.
   */
  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/episodes/${id}/publish`, { cache: "no-store", signal: ac.signal });
        const body = (await res.json().catch(() => null)) as (PublishView & { error?: string; code?: string }) | null;
        if (!live) return;
        if (!res.ok) {
          // A stale Prisma client is the one failure with a fix the operator can
          // apply, so it gets its own sentence instead of the generic one.
          const message = body?.code === "publish_client_stale" ? c.stale : (body?.error ?? c.loadFailed);
          // A refresh that fails while this episode's page is already up keeps the page: the choices,
          // the open confirmation and a publish in flight are not thrown away for one dropped poll.
          setFetched((prev) => (prev && prev.id === id && prev.view ? { ...prev, error: message } : { id, view: null, error: message }));
          return;
        }
        setFetched({ id, view: body as PublishView, error: null });
        // Fresh drafts only the first time this episode loads. The page re-reads while a publish is in
        // flight (every 1.5s), and clearing here on every read threw away whatever was being typed.
        if (startedFor.current !== id) {
          startedFor.current = id;
          setDrafts({});
          setConfirming(null);
        }
      } catch {
        // An aborted fetch is this component moving on, not a failure.
        if (live) {
          setFetched((prev) => (prev && prev.id === id && prev.view ? { ...prev, error: c.loadFailed } : { id, view: null, error: c.loadFailed }));
        }
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, [id, status, hasVideo, reloads, c.loadFailed, c.stale]);

  const mine = fetched && id && fetched.id === id ? fetched : null;
  const view = mine?.view ?? null;

  /**
   * Which of the tags / Instagram fields are empty and still the pipeline's to
   * fill, by the same rule the server applies (`missingPlatformFields`). Only a
   * FINISHED episode is asked about: an earlier one has no script to write from,
   * and a running one is about to have the render write them.
   */
  const missing = view && view.status === "DONE" ? missingPlatformFields(view.metadata, view.edits) : [];
  const autoEligible = missing.length > 0;

  /**
   * Take the generate route's answer as the new state -- but only if the panel
   * is still showing the episode it was for. The request takes minutes; if the
   * operator has moved on, the answer is dropped here and the panel re-reads the
   * server when they come back, which now has the fields.
   */
  const settleGenerate = useCallback((target: string, result: { ok: boolean; body: Record<string, unknown> }) => {
    if (result.ok) {
      setFetched((prev) => (prev && prev.id === target ? { id: target, view: result.body as unknown as PublishView, error: null } : prev));
    }
    setGen((g) => ({
      ...g,
      [target]: result.ok
        ? { phase: "done" }
        : { phase: "error", message: typeof result.body.error === "string" ? result.body.error : "" },
    }));
  }, []);

  /**
   * Ask once, on open. The effect body sets nothing: "generating" is DERIVED
   * below (an eligible episode with no recorded answer is being generated), so
   * there is no setState to cascade, exactly as the load effect above is
   * written. The ref is what makes it once per episode; the server joins a
   * second request to a running one in any case.
   */
  useEffect(() => {
    if (!id || !autoEligible || asked.current.has(id)) return;
    asked.current.add(id);
    const target = id;
    void requestGenerate(target).then((result) => settleGenerate(target, result));
  }, [id, autoEligible, settleGenerate]);

  /** The Generate button after a failure: the same request, on demand. */
  function generateNow() {
    if (!id) return;
    const target = id;
    asked.current.add(target);
    setGen((g) => ({ ...g, [target]: { phase: "running" } }));
    void requestGenerate(target).then((result) => settleGenerate(target, result));
  }

  const genState: GenState | null = !id || !autoEligible ? null : (gen[id] ?? { phase: "running" });
  /** A request that "succeeded" but left the fields empty is a failure the operator must be told about. */
  const genRunning = genState?.phase === "running";
  const genError = genState?.phase === "error" ? genState.message : genState?.phase === "done" ? c.generateStillEmpty : null;
  const showYouTubeNotice = (genRunning || genError !== null) && missing.includes("tags");
  const showInstagramNotice = (genRunning || genError !== null) && missing.some((f) => f !== "tags");

  /**
   * Poll ONLY while a platform reports work genuinely in flight.
   *
   * The byte count a progress bar reads comes from the database, which the
   * upload writes after every chunk YouTube acknowledges — so the panel has to
   * re-ask to see it move. It re-asks for exactly as long as something is
   * moving: `isInFlight` is the vocabulary's own definition of that
   * (`PREPARING` or `UPLOADING`, and nothing else), so this cannot drift into
   * polling a REQUIRES_CONNECTION row forever.
   *
   * 1.5s matches the shell's own snapshot interval, and an 8 MiB chunk takes
   * longer than that on any connection this is worth doing on — so every tick
   * has a real chance of showing a new number rather than the same one.
   */
  const inFlight = (view?.platforms ?? []).some((p) => p.status === "PREPARING" || p.status === "UPLOADING");
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => setReloads((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, [inFlight]);

  const loadError = mine?.error ?? null;
  /** Derived, not stored: there is a request in flight exactly while neither answer has arrived. */
  const loading = id !== null && mine === null;

  /** What the copy blocks show: the publish view when it has loaded, the polled snapshot otherwise. */
  const copyMetadata: PublishMetadata =
    view?.metadata ?? {
      title: episode?.title ?? "",
      description: episode?.description ?? "",
      hashtags: episode?.hashtags ?? [],
      hook: episode?.hook ?? "",
    };

  const stored = (field: MetadataField): string => {
    if (!view) return "";
    const m = view.metadata;
    switch (field) {
      case "title":
        return m.title;
      case "description":
        return m.description;
      case "hashtags":
        return hashtagLine(m.hashtags);
      case "tags":
        return tagsLine(m.tags);
      case "igHook":
        return m.igHook ?? "";
      case "igCaption":
        return m.igCaption ?? "";
      case "igHashtags":
        return hashtagLine(m.igHashtags ?? []);
    }
  };

  const shown = (field: MetadataField): string => drafts[field] ?? stored(field);

  const dirty = (field: MetadataField): boolean => {
    const draft = drafts[field];
    if (draft === undefined) return false;
    if (isListField(field)) {
      const norm = field === "tags" ? normaliseTags : normaliseHashtags;
      return JSON.stringify(norm(draft)) !== JSON.stringify(norm(stored(field)));
    }
    return draft.trim() !== stored(field).trim();
  };

  /**
   * Take a write's answer as the new state.
   *
   * Every write answers with the same shape GET does, so the client never has
   * to re-fetch to find out what its own write produced -- and the answer is
   * stamped with the id it belongs to, exactly as the effect's is, so a write
   * that lands after the operator has moved on cannot repaint the new episode's
   * panel with the old one's state.
   */
  function accept(body: Record<string, unknown>) {
    if (!id) return;
    const target = id;
    // Only if the panel still shows the episode this write was for: a
    // Regenerate takes up to a couple of minutes, and an answer landing after
    // the operator has moved on must not blank the new episode's panel.
    setFetched((prev) => (prev && prev.id !== target ? prev : { id: target, view: body as unknown as PublishView, error: null }));
  }

  async function send(url: string, body: unknown, method = "POST"): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, body: parsed };
  }

  async function save(field: MetadataField) {
    if (!id || !view) return;
    setBusy({ kind: "save", field });
    const payload: Record<string, unknown> = { [field]: shown(field) };
    const { ok, body } = await send(`/api/episodes/${id}/publish`, payload, "PUT");
    setBusy(null);
    if (!ok) {
      toast.show(typeof body.error === "string" ? body.error : c.saveFailed, "error");
      return;
    }
    accept(body);
    // Only this field's draft is dropped: a save of the title must not throw
    // away an unsaved description the operator is still writing.
    setDrafts((d) => ({ ...d, [field]: undefined }));
    toast.show(c.savedToast, "ok");
  }

  async function regenerate(field: MetadataField, confirm: boolean) {
    if (!id || !view) return;
    setBusy({ kind: "regen", field });
    const { ok, body } = await send(`/api/episodes/${id}/publish/regenerate`, { field, confirm });
    setBusy(null);
    if (!ok) {
      if (body.code === "needs_confirmation") {
        setConfirming(field);
        return;
      }
      toast.show(typeof body.error === "string" ? body.error : c.saveFailed, "error");
      return;
    }
    setConfirming(null);
    accept(body);
    setDrafts((d) => ({ ...d, [field]: undefined }));
    toast.show(c.regeneratedToast(FIELD_NAMES[field]), "ok");
  }

  async function record(platform: string) {
    if (!id) return;
    setBusy({ kind: "record", platform });
    const { ok, body } = await send(`/api/episodes/${id}/publish/handoff`, { platform });
    setBusy(null);
    if (!ok) {
      toast.show(typeof body.error === "string" ? body.error : c.saveFailed, "error");
      return;
    }
    accept(body);
    toast.show(c.recordedToast, "ok");
  }

  /**
   * Choose the cover for one platform. A PUT to the same publish endpoint the
   * metadata edits use, carrying only the platform's choice column — it writes
   * a pointer to one of this episode's existing posters and generates nothing.
   * The answer is the whole view, taken the same way a save's is.
   */
  async function chooseThumbnail(platform: "youtube" | "instagram", key: string) {
    if (!id) return;
    const column = platform === "youtube" ? "thumbChoiceYouTube" : "thumbChoiceInstagram";
    setThumbBusy(platform);
    const { ok, body } = await send(`/api/episodes/${id}/publish`, { [column]: key }, "PUT");
    setThumbBusy(null);
    if (!ok) {
      toast.show(typeof body.error === "string" ? body.error : c.saveFailed, "error");
      return;
    }
    accept(body);
    toast.show(c.savedToast, "ok");
  }

  const fieldBusy = (field: MetadataField): "save" | "regen" | null =>
    busy && (busy.kind === "save" || busy.kind === "regen") && busy.field === field ? busy.kind : null;

  /** The YouTube variant supplies the title and description counters; it is the
   *  stricter of the two on both, so a value inside it is inside Instagram's. */
  const youtube = view?.platforms.find((p) => p.platform === "youtube") ?? null;
  const instagram = view?.platforms.find((p) => p.platform === "instagram") ?? null;
  const measureOf = (key: string): VariantField | null =>
    youtube?.variant.find((f) => f.key === key) ?? instagram?.variant.find((f) => f.key === key) ?? null;

  /** A live character counter for a field the platform variants do not measure on their own. */
  const charMeasure = (key: VariantFieldKey, value: string, limit: number): VariantField => {
    const length = [...value].length;
    return { key, label: "", value, length, limit, over: length > limit };
  };
  /** A live tag counter, measured the same way `variantFor` measures hashtags. */
  const tagMeasure = (value: string, limit: number): VariantField => {
    const tags = normaliseHashtags(value);
    const line = tags.join(" ");
    return { key: "hashtags", label: "", value: line, length: [...line].length, limit: null, count: tags.length, countLimit: limit, over: tags.length > limit };
  };

  /** One metadata editor, wired to this component's draft/save/regenerate/copy plumbing. */
  const renderField = (
    field: MetadataField,
    label: string,
    opts: { rows?: number; hint?: string; measure: VariantField | null; copyLabel: string },
  ) => (
    <FieldEditor
      label={label}
      name={FIELD_NAMES[field]}
      value={shown(field)}
      measure={opts.measure}
      edited={view ? view.edits[field] !== null : false}
      rows={opts.rows}
      hint={opts.hint}
      busy={fieldBusy(field)}
      dirty={dirty(field)}
      confirming={confirming === field}
      copyText={shown(field)}
      copyLabel={opts.copyLabel}
      onChange={(next) => setDrafts((d) => ({ ...d, [field]: next }))}
      onSave={() => void save(field)}
      onRegenerate={() => void regenerate(field, false)}
      onConfirm={() => void regenerate(field, true)}
      onCancelConfirm={() => setConfirming(null)}
    />
  );

  const ready = view?.readiness.ready ?? false;
  const issues = view?.readiness.issues ?? [];
  const fl = c.flow;

  /** The YouTube block's editors, in the wireframe's order: Title, Description, Tags (keyword), Hashtags. */
  const youtubeFields = view ? (
    <>
      <Hint>{c.metadataHint}</Hint>
      {showYouTubeNotice && (
        <GenerateNotice
          state={genRunning ? "running" : "error"}
          what={c.generatingYouTube}
          detail={genError ?? undefined}
          onGenerate={generateNow}
        />
      )}
      {renderField("title", c.titleLabel, { measure: measureOf("title"), copyLabel: c.copyTitle })}
      {renderField("description", c.descriptionLabel, { rows: 6, measure: measureOf("description"), copyLabel: c.copyDescription })}
      {renderField("tags", c.tagsLabel, { rows: 2, hint: c.tagsHint, measure: measureOf("tags"), copyLabel: c.copyTags })}
      {renderField("hashtags", c.hashtagsLabel, { rows: 2, hint: c.hashtagsHint, measure: measureOf("hashtags"), copyLabel: c.copyHashtags })}
      <div className="pub-actions">
        <CopyButton
          label={c.copyAll}
          text={[
            view.metadata.title,
            "",
            view.metadata.description,
            "",
            `${c.tagsLabel}: ${tagsLine(view.metadata.tags)}`,
            hashtagLine(view.metadata.hashtags),
          ].join("\n")}
        />
      </div>
    </>
  ) : null;

  /**
   * The Instagram block's editors: Title (the hook), Caption, Hashtags. Written for Instagram rather
   * than derived from the YouTube description; while they are empty the caption still falls back to
   * the composed one, and the note says so.
   */
  const instagramFields = view ? (
    <>
      <Hint>{c.instagramIntro}</Hint>
      {showInstagramNotice && (
        <GenerateNotice
          state={genRunning ? "running" : "error"}
          what={c.generatingInstagram}
          detail={genError ?? undefined}
          onGenerate={generateNow}
        />
      )}
      {!genRunning && !hasIndependentInstagram(view.metadata) && <Hint>{c.instagramDerivedNote}</Hint>}
      {renderField("igHook", c.igHookLabel, { hint: c.igHookHint, measure: null, copyLabel: c.copyHook })}
      {renderField("igCaption", c.igCaptionLabel, {
        rows: 5,
        measure: charMeasure("caption", shown("igCaption"), PLATFORM_LIMITS.instagram.body),
        copyLabel: c.copyCaption,
      })}
      {renderField("igHashtags", c.igHashtagsLabel, {
        rows: 2,
        measure: tagMeasure(shown("igHashtags"), PLATFORM_LIMITS.instagram.hashtags),
        copyLabel: c.copyHashtags,
      })}
      <div className="pub-actions">
        <CopyButton label={c.copyFullCaption} text={instagramCaption(view.metadata)} />
      </div>
      <Hint>{c.regenerateHint}</Hint>
    </>
  ) : null;

  const handoffs = view ? view.platforms.filter((p) => p.handoff.length > 0) : [];

  return (
    <Panel
      className="pub-center"
      title={fl.headingFor(view?.title ?? episode?.title ?? null)}
      actions={
        view ? (
          <Badge tone={ready ? "done" : "live"}>{ready ? c.ready : c.notReady}</Badge>
        ) : null
      }
    >
      {!episode ? (
        // The Instagram account is account-level, not per video, so it is here with nothing picked
        // too -- you connect it BEFORE choosing a video. Same position in both branches, so picking an
        // episode keeps the card (and any check in progress) instead of remounting it.
        <div className="flex flex-col gap-3">
          <InstagramConnection />
          <EmptyState>{c.none}</EmptyState>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <InstagramConnection />

          {loadError && (
            <div className="flex flex-col gap-2" role="alert">
              <Hint>{loadError}</Hint>
              <div className="pub-actions">
                <button type="button" className="chip" onClick={() => setReloads((n) => n + 1)}>
                  <span className="truncate">{c.retry}</span>
                </button>
              </div>
            </div>
          )}

          {loading && <Skeleton height={120} />}

          {view && (
            <>
              {/* What is missing, and only when something is: the whole list rather than the first
                  thing wrong. `aria-live` because it changes under the reader after a save or a
                  re-render. A finished episode says nothing here -- the badge in the header does. */}
              {!ready && (
                <div className="pub-missing" aria-live="polite">
                  <p className="eyebrow">{issues.length === 1 ? c.missingOne : c.missingMany(issues.length)}</p>
                  <ul role="list">
                    {issues.map((i) => (
                      <li key={i.code}>{i.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <MediaRow view={view} />

              <PublishFlow
                key={view.episodeId}
                view={view}
                episodeId={view.episodeId}
                onView={accept}
                youtubeFields={youtubeFields}
                instagramFields={instagramFields}
              />

              {/* Still here, folded: the per-platform cover choice (YouTube favours the wide crops,
                  Instagram the tall ones) the upload and the hand-off both use. */}
              <Disclosure summary={fl.chooseThumbnail}>
                <ThumbnailPicker
                  thumbnails={view.thumbnails}
                  choices={view.thumbChoices}
                  busy={thumbBusy}
                  onChoose={(platform, key) => void chooseThumbnail(platform, key)}
                />
              </Disclosure>

              {/* The by-hand route, for the day the operator would rather post it themselves. */}
              {handoffs.length > 0 && (
                <Disclosure summary={fl.handoffSummary}>
                  <Hint>{fl.handoffHint}</Hint>
                  <div className="pub-platforms">
                    {handoffs.map((p) => (
                      <HandoffCard
                        key={p.platform}
                        state={p}
                        recording={busy?.kind === "record" && busy.platform === p.platform}
                        onRecord={() => void record(p.platform)}
                      />
                    ))}
                  </div>
                </Disclosure>
              )}
            </>
          )}

          {/* The old panel, kept whole. Folded, because four boxes of pastable
              text is most of a laptop screen and the editors above are what the
              operator now reaches for first -- but one keypress away, with the
              same heading and the same four labels. */}
          <Disclosure className="disclosure-panel" summary={strings.publish.heading}>
            <CopyBlocks meta={copyMetadata} status={status} />
          </Disclosure>
        </div>
      )}
    </Panel>
  );
}

/**
 * The video and its thumbnail, side by side, each with its Download beneath it. The player is small on
 * purpose -- the full-size one is the preview above this page -- and is here to confirm WHICH video is
 * about to go out. A Download that would 404 is not rendered.
 */
function MediaRow({ view }: { view: PublishView }) {
  const c = strings.publishCenter;
  const f = c.flow;
  const facts =
    view.videoBytes === null && view.durationSec === null
      ? null
      : f.videoFacts(
          view.videoBytes === null ? c.noValue : c.sizeValue(view.videoBytes),
          view.durationSec === null ? c.noValue : c.durationValue(view.durationSec),
        );

  return (
    <section className="pub-media" aria-label={f.mediaLabel}>
      <div className="pub-media-col">
        <div className="pub-stage">
          {view.videoUrl ? (
            <video key={view.episodeId} controls playsInline preload="metadata" src={view.videoUrl}>
              {c.unsupported}
            </video>
          ) : (
            <p className="preview-note">{c.noVideoYet}</p>
          )}
        </div>
        {facts && <span className="hint">{facts}</span>}
        {view.videoUrl && (
          <a className="chip" href={view.videoUrl} download>
            <span className="truncate">{c.downloadVideo}</span>
          </a>
        )}
      </div>

      <div className="pub-media-col">
        <div className="pub-poster" style={view.poster ? { aspectRatio: `${view.poster.width} / ${view.poster.height}` } : undefined}>
          {view.poster ? (
            /* A plain <img>: the bytes come from a session-guarded route, not
               from `public/`, so `next/image` has nothing to optimise and would
               only add a second fetch. */
            // eslint-disable-next-line @next/next/no-img-element
            <img src={view.poster.url} alt={c.posterAlt(view.title ?? view.bookTitle)} />
          ) : (
            <p className="preview-note">{c.noPosterYet}</p>
          )}
        </div>
        {view.poster && <span className="hint">{view.poster.key}</span>}
        {view.poster && (
          <a className="chip" href={view.poster.url} download>
            <span className="truncate">{c.downloadPoster}</span>
          </a>
        )}
      </div>
    </section>
  );
}
