"use client";

import { useEffect, useId, useRef, useState } from "react";
import CopyBlock from "./CopyBlock";
import YouTubePublish from "./YouTubePublish";
import { Badge, Disclosure, EmptyState, Hint, Panel, Skeleton, StatRow } from "./ui";
import { useToast } from "./Toast";
import { strings } from "@/lib/strings";
import { hashtagLine, instagramCaption, normaliseHashtags, type PublishMetadata } from "@/lib/publish/limits";
import type {
  HandoffStep,
  MetadataField,
  PlatformState,
  PublishStatus,
  PublishView,
  VariantField,
} from "@/lib/publish/view";
import type { BadgeTone } from "./ui";
import type { EpisodeState } from "./types";

/**
 * The Publish Center: what goes out, what it says, where it stands, and what is
 * stopping it.
 *
 * It replaces `PublishPanel`, which was forty-eight lines and a `<details>`
 * holding four copy-to-clipboard boxes. Those four boxes are still here, byte
 * for byte, under the same heading — the operator has been pasting from them
 * for months and a rewrite that improved them would have broken a habit for no
 * reason. Everything else is new: the readiness verdict, the assets, the
 * editable metadata with a per-field Regenerate, and a card per platform.
 *
 * TWO RULES SHAPE EVERY LINE OF THIS FILE.
 *
 * 1. NOTHING IS FAKED. There is no progress bar, no spinner and no "uploading"
 *    wording for work that is not happening, because nothing in this build
 *    uploads anything. Every platform card says `REQUIRES_CONNECTION` and says
 *    what that means. Every control either does its job or is not rendered: a
 *    Download that would 404 is not shown, and a Publish button does not exist
 *    at all because no provider here can upload (`capabilities().canUpload`).
 *    The one spinner-ish state is on buttons doing real work — a save, a model
 *    call, a record — and it stops when that work does.
 *
 * 2. THE COPY BLOCKS CANNOT REGRESS. They are fed from the publish view when it
 *    has loaded and from the polled episode snapshot when it has not, so a
 *    failed or stale `GET .../publish` leaves them working exactly as they did
 *    before this surface existed. That is why `copyMetadata` falls back the way
 *    it does rather than rendering nothing until the fetch lands.
 *
 * All provider knowledge stops at the API. This component never names an API,
 * never holds a token, and never sees a credential: it renders capabilities,
 * statuses and handoff steps that arrived as JSON. Which is what makes adding
 * YouTube later a change to `src/lib/publish/registry.ts` and nothing here.
 */

const TONE: Record<PublishStatus, BadgeTone> = {
  NOT_READY: "cancelled",
  READY: "done",
  // Violet, the same tone the Queue's "Coming soon" uses: a real connection is
  // a later workstream, and this is the honest colour for "not yet".
  REQUIRES_CONNECTION: "soon",
  PREPARING: "live",
  UPLOADING: "live",
  PUBLISHED: "done",
  FAILED: "failed",
};

/**
 * Only an app-relative path or an https URL may become an `href`.
 *
 * Today every one of these comes from `limits.ts` (a constant) or from the
 * server's own asset URLs, so nothing can fail this. It is here because the
 * handoff steps are DATA from a provider, and the first third-party provider
 * that returns a `javascript:` label would otherwise find a DOM sink waiting
 * for it. A refused href renders as plain text, not as a dead link.
 */
function safeHref(href: string | undefined): string | null {
  if (typeof href !== "string") return null;
  if (href.startsWith("/")) return href;
  return /^https:\/\//i.test(href) ? href : null;
}

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

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <button
      type="button"
      className="chip"
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

function PlatformCard({
  state,
  recording,
  onRecord,
  episodeId,
  owned,
  onPublished,
}: {
  state: PlatformState;
  recording: boolean;
  onRecord: () => void;
  episodeId: string | null;
  /** Whether this account owns the episode — publishing requires it. */
  owned: boolean;
  onPublished: (view: Record<string, unknown>) => void;
}) {
  const c = strings.publishCenter;
  const job = state.job;

  return (
    <section className="pub-platform" aria-labelledby={`pub-${state.platform}`}>
      <header className="pub-platform-head">
        <h4 id={`pub-${state.platform}`} className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
          {state.label}
        </h4>
        <Badge tone={TONE[state.status]}>{c.statusLabel[state.status] ?? state.status}</Badge>
      </header>

      <p className="hint">{c.statusNote[state.status] ?? ""}</p>

      {/* Said plainly rather than left to be inferred from a missing button. */}
      {!state.capabilities.canUpload && <p className="hint">{c.cannotUpload}</p>}

      {/* A platform that CAN upload gets its connection card: the grant, the
          Connect/Disconnect pair, the one Publish button, measured progress and
          the review link. It is a separate component because an OAuth grant is
          a different subject from an episode's metadata — and because nothing
          platform-specific belongs in this file. The card decides for itself
          what to show; this only says which platform has one. */}
      {state.platform === "youtube" && state.capabilities.canUpload && (
        <YouTubePublish episodeId={episodeId} state={state} owned={owned} onPublished={onPublished} />
      )}

      {/* `PublishJob` carries an externalId only when a platform returned one,
          so this block cannot appear without a real confirmation. Nothing in
          this build can produce one — it is here so the platform workstreams do
          not have to add it, and so the shape is already proven by a test. */}
      {job?.publishedAt && job.externalId && (
        <div className="pub-rows">
          <StatRow label={c.publishedLabel} value={new Date(job.publishedAt).toLocaleString()} />
          <StatRow label={c.platformIdLabel} value={job.externalId} />
          {safeHref(job.externalUrl ?? undefined) && (
            <a className="chip" href={safeHref(job.externalUrl ?? undefined)!} target="_blank" rel="noopener noreferrer">
              <span className="truncate">{c.openOn(state.label)}</span>
            </a>
          )}
        </div>
      )}

      {state.variant.length > 0 && (
        <ul className="pub-measures" role="list">
          {state.variant.map((f) => (
            <li key={f.key}>
              <span className="truncate" style={{ color: "var(--mute)" }}>{f.label}</span>
              <Measure field={f} />
            </li>
          ))}
        </ul>
      )}

      {state.problems.length > 0 && (
        <div className="pub-problems" role="alert">
          <p className="eyebrow">{c.problemsHeading}</p>
          <ul role="list">
            {state.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {state.handoff.length > 0 && (
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
      )}

      {job?.lastError && state.status === "FAILED" && (
        <p className="hint" role="alert" style={{ color: "var(--rose)" }}>
          {job.lastError}
        </p>
      )}

      <Disclosure quiet summary={c.requiresHeading}>
        <ul className="pub-requires" role="list">
          {state.requires.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Disclosure>
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
  field,
  label,
  value,
  measure,
  edited,
  rows,
  hint,
  busy,
  dirty,
  confirming,
  onChange,
  onSave,
  onRegenerate,
  onConfirm,
  onCancelConfirm,
}: {
  field: MetadataField;
  label: string;
  value: string;
  measure: VariantField | null;
  edited: boolean;
  rows?: number;
  hint?: string;
  busy: "save" | "regen" | null;
  dirty: boolean;
  confirming: boolean;
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

      <div className="pub-actions">
        <button
          type="button"
          className="chip"
          data-state={dirty ? "on" : undefined}
          aria-disabled={!dirty || busy !== null ? "true" : undefined}
          onClick={() => dirty && busy === null && onSave()}
        >
          <span className="truncate">{busy === "save" ? c.saving : c.save}</span>
        </button>
        <button
          type="button"
          className="chip"
          aria-disabled={busy !== null ? "true" : undefined}
          onClick={() => busy === null && onRegenerate()}
        >
          <span className="truncate">{busy === "regen" ? c.regenerating : c.regenerate}</span>
        </button>
      </div>

      {confirming && (
        <div className="pub-confirm" role="alert">
          <p>{c.confirmBody(field)}</p>
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

type Busy = { kind: "save" | "regen"; field: MetadataField } | { kind: "record"; platform: string } | null;

export default function PublishCenter({ episode }: { episode: EpisodeState | null }) {
  const c = strings.publishCenter;
  const toast = useToast();

  /**
   * `fetched` carries the episode id it belongs to, so "whose state is this?"
   * is answered by the value itself rather than by a ref that has to be kept in
   * step. Switching episodes mid-fetch therefore cannot show one video's
   * metadata on another's panel: `view` below is null unless the ids match.
   */
  const [fetched, setFetched] = useState<{ id: string; view: PublishView | null; error: string | null } | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<MetadataField, string>>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState<MetadataField | null>(null);
  /** Bumped by the Retry button to ask the effect for another go. */
  const [reloads, setReloads] = useState(0);

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
          setFetched({ id, view: null, error: message });
          return;
        }
        setFetched({ id, view: body as PublishView, error: null });
        setDrafts({});
        setConfirming(null);
      } catch {
        // An aborted fetch is this component moving on, not a failure.
        if (live) setFetched({ id, view: null, error: c.loadFailed });
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
    if (field === "hashtags") return hashtagLine(view.metadata.hashtags);
    return view.metadata[field];
  };

  const shown = (field: MetadataField): string => drafts[field] ?? stored(field);

  const dirty = (field: MetadataField): boolean => {
    const draft = drafts[field];
    if (draft === undefined) return false;
    if (field === "hashtags") {
      return JSON.stringify(normaliseHashtags(draft)) !== JSON.stringify(normaliseHashtags(stored(field)));
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
    setFetched({ id, view: body as unknown as PublishView, error: null });
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
    toast.show(c.regeneratedToast(field), "ok");
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

  const fieldBusy = (field: MetadataField): "save" | "regen" | null =>
    busy && (busy.kind === "save" || busy.kind === "regen") && busy.field === field ? busy.kind : null;

  /** The YouTube variant supplies the title and description counters; it is the
   *  stricter of the two on both, so a value inside it is inside Instagram's. */
  const youtube = view?.platforms.find((p) => p.platform === "youtube") ?? null;
  const instagram = view?.platforms.find((p) => p.platform === "instagram") ?? null;
  const measureOf = (key: string): VariantField | null =>
    youtube?.variant.find((f) => f.key === key) ?? instagram?.variant.find((f) => f.key === key) ?? null;

  const ready = view?.readiness.ready ?? false;
  const issues = view?.readiness.issues ?? [];

  return (
    <Panel
      title={c.heading}
      actions={
        view ? (
          <Badge tone={ready ? "done" : "live"}>{ready ? c.ready : c.notReady}</Badge>
        ) : null
      }
    >
      {!episode ? (
        <EmptyState>{c.none}</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
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
              {/* The verdict, and when it is no, the whole list rather than the
                  first thing wrong. `aria-live` because it changes under the
                  reader after a save or a re-render. */}
              <div className="pub-missing" aria-live="polite">
                {ready ? (
                  <p className="hint">{c.noConfirmation}</p>
                ) : (
                  <>
                    <p className="eyebrow">{issues.length === 1 ? c.missingOne : c.missingMany(issues.length)}</p>
                    <ul role="list">
                      {issues.map((i) => (
                        <li key={i.code}>{i.message}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <section className="flex flex-col gap-2" aria-labelledby="pub-assets">
                <h3 id="pub-assets" className="eyebrow">
                  {c.assetsHeading}
                </h3>
                <div className="pub-assets">
                  <div className="pub-stage">
                    {view.videoUrl ? (
                      <video key={view.episodeId} controls playsInline preload="metadata" src={view.videoUrl}>
                        {c.unsupported}
                      </video>
                    ) : (
                      <p className="preview-note">{c.noVideoYet}</p>
                    )}
                  </div>

                  <div className="pub-poster">
                    {view.poster ? (
                      /* A plain <img>: the bytes come from a session-guarded
                         route, not from `public/`, so `next/image` has nothing
                         to optimise and would only add a second fetch. */
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={view.poster.url} alt={c.posterAlt(view.title ?? view.bookTitle)} />
                    ) : (
                      <p className="preview-note">{c.noPosterYet}</p>
                    )}
                  </div>

                  <div className="pub-rows">
                    <StatRow
                      label={c.videoLabel}
                      value={view.videoBytes === null ? c.noValue : c.sizeValue(view.videoBytes)}
                    />
                    <StatRow
                      label={c.lengthLabel}
                      value={view.durationSec === null ? c.noValue : c.durationValue(view.durationSec)}
                    />
                    <StatRow label={c.posterLabel} value={view.poster?.key ?? c.noValue} />
                    <div className="pub-actions">
                      {view.videoUrl && (
                        <a className="chip" href={view.videoUrl} download>
                          <span className="truncate">{c.downloadVideo}</span>
                        </a>
                      )}
                      {view.poster && (
                        <a className="chip" href={view.poster.url} download>
                          <span className="truncate">{c.downloadPoster}</span>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section className="flex flex-col gap-2" aria-labelledby="pub-meta">
                <h3 id="pub-meta" className="eyebrow">
                  {c.metadataHeading}
                </h3>
                <Hint>{c.metadataHint}</Hint>

                <FieldEditor
                  field="title"
                  label={c.titleLabel}
                  value={shown("title")}
                  measure={measureOf("title")}
                  edited={view.edits.title !== null}
                  busy={fieldBusy("title")}
                  dirty={dirty("title")}
                  confirming={confirming === "title"}
                  onChange={(next) => setDrafts((d) => ({ ...d, title: next }))}
                  onSave={() => void save("title")}
                  onRegenerate={() => void regenerate("title", false)}
                  onConfirm={() => void regenerate("title", true)}
                  onCancelConfirm={() => setConfirming(null)}
                />

                <FieldEditor
                  field="description"
                  label={c.descriptionLabel}
                  value={shown("description")}
                  measure={measureOf("description")}
                  edited={view.edits.description !== null}
                  rows={6}
                  busy={fieldBusy("description")}
                  dirty={dirty("description")}
                  confirming={confirming === "description"}
                  onChange={(next) => setDrafts((d) => ({ ...d, description: next }))}
                  onSave={() => void save("description")}
                  onRegenerate={() => void regenerate("description", false)}
                  onConfirm={() => void regenerate("description", true)}
                  onCancelConfirm={() => setConfirming(null)}
                />

                <FieldEditor
                  field="hashtags"
                  label={c.hashtagsLabel}
                  value={shown("hashtags")}
                  measure={measureOf("hashtags")}
                  edited={view.edits.hashtags !== null}
                  rows={2}
                  hint={c.hashtagsHint}
                  busy={fieldBusy("hashtags")}
                  dirty={dirty("hashtags")}
                  confirming={confirming === "hashtags"}
                  onChange={(next) => setDrafts((d) => ({ ...d, hashtags: next }))}
                  onSave={() => void save("hashtags")}
                  onRegenerate={() => void regenerate("hashtags", false)}
                  onConfirm={() => void regenerate("hashtags", true)}
                  onCancelConfirm={() => setConfirming(null)}
                />

                <Hint>{c.regenerateHint}</Hint>
              </section>

              <section className="flex flex-col gap-2" aria-labelledby="pub-platforms">
                <h3 id="pub-platforms" className="eyebrow">
                  {c.platformsHeading}
                </h3>
                <div className="pub-platforms">
                  {view.platforms.map((p) => (
                    <PlatformCard
                      key={p.platform}
                      state={p}
                      recording={busy?.kind === "record" && busy.platform === p.platform}
                      onRecord={() => void record(p.platform)}
                      episodeId={id}
                      owned={view.owned}
                      onPublished={accept}
                    />
                  ))}
                </div>
              </section>
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
