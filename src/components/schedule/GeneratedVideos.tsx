"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorPreview } from "@/lib/schedule/board-retry";
import { countLabel, deselectAll, parseStored, planFor, prune, schedulePlanFor, selectAll, STORAGE_KEY, toggle } from "@/lib/schedule/video-selection";
import type { BulkItem, BulkResult } from "@/lib/schedule/board-types";
import type { GeneratedVideo, PlatformState, PlatformStatus, VideoPage } from "@/lib/schedule/board-types";
import type { Platform } from "@/lib/schedule/board-types";

/**
 * The generated videos, and publishing the ones you tick, right now.
 *
 * This is the manual counterpart of the weekly schedule above it and shares nothing
 * with it but the page: pressing Publish here creates the same publish jobs the
 * single-video screen creates - through POST /api/schedule-board/bulk - and never creates,
 * changes or activates a schedule. Nothing is ticked for you, nothing is sent
 * without the confirmation, and a card only says "Published" when the job behind it
 * is one the platform confirmed.
 *
 * What a card shows is read back from the server (/api/schedule-board/videos), so a
 * refresh, a second tab or a restart shows the same thing. The only thing kept
 * here is the selection, for the session, so it survives changing pages.
 */

const mono = "font-mono";
const PAGE_SIZE = 12;
const POLL_MS = 3000;
const FIELD = { background: "var(--field)", borderColor: "var(--line)", color: "var(--ink)" } as const;

const PLATFORMS: Platform[] = ["youtube", "instagram"];
const NAME: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram" };

type Engines = Record<Platform, { api: boolean; account: string | null }>;
type Page = VideoPage & { engines: Engines };

const STATUS: Record<PlatformStatus, { label: string; tone: string }> = {
  disabled: {label:"Disabled",tone:"var(--mute-2)"},
  none: { label: "Not published", tone: "var(--mute-2)" },
  queued: { label: "Queued", tone: "var(--amber)" },
  publishing: { label: "Publishing", tone: "var(--amber)" },
  published: { label: "Published", tone: "var(--cyan)" },
  scheduled: { label: "Scheduled", tone: "var(--amber)" },
  // The platform confirmed it holds the schedule; the card adds the platform's name.
  "scheduled-on-platform": { label: "Scheduled", tone: "var(--cyan)" },
  held: { label: "On hold", tone: "var(--amber)" },
  "needs-you": { label: "Needs you", tone: "var(--amber)" },
  failed: { label: "Failed", tone: "var(--rose)" },
  cancelled: { label: "Cancelled", tone: "var(--mute-2)" },
};

const GENERATION: Record<string, { label: string; tone: string }> = {
  DONE: { label: "Completed", tone: "var(--cyan)" },
  RUNNING: { label: "Generating", tone: "var(--amber)" },
  QUEUED: { label: "Waiting to generate", tone: "var(--amber)" },
  FAILED: { label: "Generation failed", tone: "var(--rose)" },
};

const isLive = (s: PlatformStatus) => s === "queued" || s === "publishing";
const liveVideo = (v: GeneratedVideo) => PLATFORMS.some((p) => isLive(v.platforms[p].status));

async function api(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(path, { cache: "no-store", ...init, signal: AbortSignal.timeout(30_000) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server." } };
  }
}

const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

const stamp = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// A schedule's assigned time is always shown in Asia/Kolkata, whatever this computer's zone, from
// the slot's exact instant — so the summary reads the same time the schedule persisted.
const IST = "Asia/Kolkata";
const istStamp = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: IST, dateStyle: "medium", timeStyle: "short" });

function length(sec: number | null): string {
  if (sec == null) return "—";
  const whole = Math.round(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function Chip({ label, tone, title }: { label: string; tone: string; title?: string }) {
  return (
    <span
      title={title}
      className={`rounded px-1.5 py-0.5 ${mono} text-[10.5px] font-semibold`}
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` }}
    >
      {label}
    </span>
  );
}

const ghost = { borderColor: "var(--line)", color: "var(--ink)" } as const;

function AttemptHistory({episodeId}:{episodeId:string}) {
  const [open,setOpen]=useState(false);
  const [rows,setRows]=useState<{id:string;attempt:number;platform:string;status:string;message:string|null;startedAt:string;externalUrl:string|null}[]|null>(null);
  const [error,setError]=useState("");
  return <div className="mt-2 text-[11px] font-mono"><button type="button" className="underline underline-offset-4" aria-expanded={open} onClick={async()=>{setOpen(!open);if(!open){const r=await api(`/api/schedule-board/history?episodeId=${episodeId}`);if(r.ok){setRows(r.data.attempts as NonNullable<typeof rows>);setError("");}else setError(String(r.data.error??"History could not be loaded."));}}}>History</button>{open&&<div className="mt-2 max-h-48 overflow-auto rounded border p-2" style={FIELD}>{error?<p role="alert">{error}</p>:rows===null?<p>Loading history…</p>:!rows.length?<p>No attempt history has been recorded yet. Earlier job statuses remain visible above; missing history is not reconstructed.</p>:<ol className="space-y-2">{rows.map(r=><li key={r.id}><strong>{r.platform} · attempt {r.attempt} · {r.status}</strong><div>{stamp(r.startedAt)}</div>{r.message&&<p>{r.message}</p>}{r.externalUrl&&<a href={r.externalUrl} target="_blank" rel="noreferrer" className="underline">Open on platform</a>}</li>)}</ol>}</div>}</div>;
}

/* --------------------------------------------------------- one platform line -- */

function PlatformLine({
  platform,
  state,
  busy,
  onJob,
}: {
  platform: Platform;
  state: PlatformState;
  busy: boolean;
  onJob: (jobId: string, action: "retry" | "cancel" | "confirm" | "remove") => void;
}) {
  const [open, setOpen] = useState(false);
  const word = state.status === "scheduled-on-platform" ? { ...STATUS[state.status], label: `Scheduled on ${NAME[platform]}` } : STATUS[state.status];
  const job = state.job;
  const progress = state.status === "publishing" ? job?.error : null;
  // Everything but progress is something to read: why it failed, or a note that came with the post.
  const note = job?.error && state.status !== "publishing" && state.status !== "queued" ? job.error : "";

  return (
    <div className="min-w-0" data-platform={platform} data-platform-status={state.status} data-job={job?.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${mono} text-[11px]`} style={{ color: "var(--mute)" }}>{NAME[platform]}</span>
        <Chip label={word.label} tone={word.tone} />
        {job?.remoteUrl && state.status === "published" && (
          <a href={job.remoteUrl} target="_blank" rel="noreferrer" className={`${mono} text-[11px] underline underline-offset-4`} style={{ color: "var(--cyan)" }}>
            open
          </a>
        )}
      </div>

      {state.status === "queued" && (
        <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>
          Waiting for its turn: {NAME[platform]} posts one video at a time.
        </div>
      )}
      {progress && (
        <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--amber)" }} data-progress>
          {progress}
        </div>
      )}
      {state.status === "published" && job?.postedAt && (
        <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>
          confirmed by {NAME[platform]} · {stamp(job.postedAt)}
        </div>
      )}
      {state.status === "scheduled" && job && (job.publishAt || job.scheduledAt) && (
        <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>
          {job.nativeSchedule ? "will be scheduled for" : "goes out"} {stamp((job.publishAt ?? job.scheduledAt)!)}
        </div>
      )}
      {state.status === "scheduled-on-platform" && job && (
        <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }} data-platform-scheduled>
          {NAME[platform]} confirmed{job.platformStatus ? ` (${job.platformStatus})` : ""} · goes public {stamp((job.platformPublishAt ?? job.publishAt ?? job.scheduledAt)!)}
        </div>
      )}

      {note && (
        <>
          <div
            className={`mt-0.5 truncate ${mono} text-[10.5px]`}
            style={{ color: state.status === "published" ? "var(--mute-2)" : state.status === "failed" || state.status === "needs-you" ? "var(--rose)" : "var(--mute)" }}
            data-job-note
          >
            {errorPreview(note, 90)}
          </div>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${mono} text-[10.5px] underline underline-offset-4`} style={{ color: "var(--mute-2)" }}>
            {open ? "Hide" : state.status === "failed" ? "View error" : "Details"}
          </button>
          {open && (
            <pre
              className={`mt-1 max-h-48 max-w-full overflow-y-auto whitespace-pre-wrap rounded-md border p-2 ${mono} text-[10.5px] leading-relaxed`}
              style={{ borderColor: "var(--line)", color: "var(--mute)", overflowWrap: "anywhere" }}
            >
              {note}
            </pre>
          )}
        </>
      )}

      {job && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {state.status === "failed" && (
            <button type="button" disabled={busy || state.executionEnabled === false} onClick={() => onJob(job.id, "retry")} className={`rounded-md border px-2 py-0.5 ${mono} text-[11px] disabled:opacity-40`} style={ghost} title="Try this post again. It is checked against duplicates first.">
              Retry
            </button>
          )}
          {state.status === "needs-you" && (
            <button type="button" disabled={busy || state.executionEnabled === false} onClick={() => onJob(job.id, "confirm")} className={`rounded-md border px-2 py-0.5 ${mono} text-[11px] disabled:opacity-40`} style={ghost} title={job.nativeSchedule ? "Only after you have checked YouTube Studio and it lists the video as scheduled for the right time" : "Only after you have checked the platform and it is published"}>
              {job.nativeSchedule ? "It is scheduled" : "I published it"}
            </button>
          )}
          {state.status === "scheduled-on-platform" && (
            <button type="button" disabled={busy || state.executionEnabled === false} onClick={() => onJob(job.id, "remove")} className={`rounded-md border px-2 py-0.5 ${mono} text-[11px] disabled:opacity-40`} style={ghost} title="Cancelling here does not unschedule it. Use this only after you have deleted the scheduled video on the platform.">
              I deleted it there
            </button>
          )}
          {(state.status === "queued" || state.status === "needs-you") && (
            <button type="button" disabled={busy || state.executionEnabled === false} onClick={() => onJob(job.id, "cancel")} className={`rounded-md border px-2 py-0.5 ${mono} text-[11px] disabled:opacity-40`} style={ghost}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- thumbnail gallery -- */

/** The picture that publishes for a video: the layout chosen for it, or its one plain thumbnail. */
function publishingThumbnail(video: GeneratedVideo): { src: string; name: string | null } {
  const t = video.thumbnail;
  const chosen = t?.options.find((o) => o.id === t.selected);
  return chosen
    ? { src: chosen.url, name: chosen.name }
    : { src: video.thumbnailUrl, name: null };
}

const TILE_SHORT = 46; // the narrow side of a tile, in px: five of them fit on one row
const TILE_LONG = 78;

/**
 * Every thumbnail that was made for this video, side by side, to compare and choose from.
 *
 * Clicking one marks it and the card's own preview follows at once; the choice is saved
 * for this video only and is what its posts use. Each tile is a real image that exists on
 * disk for this video (nothing is repeated to fill a row), and a video with nothing to
 * choose between shows the one it has and says so.
 */
function ThumbnailGallery({
  video,
  saving,
  locked,
  onChoose,
}: {
  video: GeneratedVideo;
  saving: boolean;
  locked: string | null;
  onChoose: (id: string) => void;
}) {
  const t = video.thumbnail!;
  const [broken, setBroken] = useState<string[]>([]);
  const published = PLATFORMS.filter((p) => video.platforms[p].status === "published");
  // A schedule the platform holds already has its thumbnail too: a later choice does not reach it.
  const scheduledThere = PLATFORMS.filter((p) => video.platforms[p].status === "scheduled-on-platform");
  const choosable = t.options.length > 1 && !locked && !saving;
  const current = t.options.find((o) => o.id === t.selected);
  const tile = (vertical: boolean) => ({ width: vertical ? TILE_SHORT : TILE_LONG, aspectRatio: vertical ? "9 / 16" : "16 / 9" });

  return (
    <div
      className="flex w-full flex-col gap-1.5 @min-[500px]:w-[252px]"
      data-thumbnail-gallery
      data-option-count={t.options.length}
      data-selected-thumbnail={t.selected ?? ""}
    >
      <div
        role="radiogroup"
        aria-label={`Thumbnails for ${video.title}`}
        className="flex flex-wrap gap-[5px] @min-[500px]:justify-end"
      >
        {t.options.length > 0 ? (
          t.options.map((o) => {
            const on = o.id === t.selected;
            const vertical = o.preview === "vertical";
            const src = o.url;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${o.name} thumbnail`}
                disabled={t.options.length < 2 ? true : !choosable}
                onClick={() => onChoose(o.id)}
                title={`${o.name}: ${o.why}`}
                data-thumbnail-option={o.id}
                data-picked={on ? "yes" : "no"}
                className="relative overflow-hidden rounded-md border-2 transition-colors disabled:cursor-default"
                style={{ ...tile(vertical), borderColor: on ? "var(--green)" : "var(--line)", background: "var(--slab-2)", opacity: !choosable && !on && t.options.length > 1 ? 0.55 : 1 }}
              >
                {!broken.includes(src) ? (
                  // eslint-disable-next-line @next/next/no-img-element -- our own authenticated route, sized by the tile
                  <img src={src} alt="" loading="lazy" onError={() => setBroken((b) => [...b, src])} className="h-full w-full object-cover" />
                ) : (
                  <span className={`absolute inset-0 grid place-items-center ${mono} text-[8px]`} style={{ color: "var(--mute-2)" }}>missing</span>
                )}
                {on && (
                  <span
                    className="absolute right-0.5 top-0.5 grid h-[17px] w-[17px] place-items-center rounded-full text-[11px] font-bold leading-none"
                    style={{ background: "var(--green)", color: "var(--on-accent)" }}
                    data-thumbnail-check
                    aria-hidden="true"
                  >
                    {"\u2713"}
                  </span>
                )}
              </button>
            );
          })
        ) : (
          // Nothing but the plain thumbnail on file: shown as it is, and not offered as a choice.
          <div
            className="relative overflow-hidden rounded-md border-2"
            style={{ ...tile(t.shape === "vertical"), borderColor: "var(--line)", background: "var(--slab-2)" }}
            data-thumbnail-only
          >
            {video.thumbnailUrl && !broken.includes(video.thumbnailUrl) ? (
              // eslint-disable-next-line @next/next/no-img-element -- our own authenticated route, sized by the tile
              <img src={video.thumbnailUrl} alt="" loading="lazy" onError={() => setBroken((b) => [...b, video.thumbnailUrl])} className="h-full w-full object-cover" />
            ) : (
              <span className={`absolute inset-0 grid place-items-center ${mono} text-[8px]`} style={{ color: "var(--mute-2)" }}>no thumbnail</span>
            )}
          </div>
        )}
      </div>

      <div className={`${mono} text-[10.5px] leading-snug @min-[500px]:text-right`} style={{ color: "var(--mute)" }} data-thumbnail-caption>
        {t.options.length > 1
          ? `${current?.name ?? "No layout chosen"} · ${t.options.length} thumbnails`
          : (t.message ?? "Only one thumbnail available")}
      </div>
      {t.options.length > 1 && (
        <div className={`${mono} text-[10px] leading-snug @min-[500px]:text-right`} style={{ color: "var(--mute-2)" }}>
          Shared poster choice. BookReel’s platform-specific poster overrides are preserved.
        </div>
      )}
      {locked && (
        <div className={`${mono} text-[10px] leading-snug @min-[500px]:text-right`} style={{ color: "var(--amber)" }} data-thumbnail-locked>
          {locked}
        </div>
      )}
      {published.length > 0 && t.options.length > 1 && (
        <div className={`${mono} text-[10px] leading-snug @min-[500px]:text-right`} style={{ color: "var(--mute-2)" }} data-thumbnail-published-note>
          Already published on {published.map((p) => NAME[p]).join(" and ")}: that video keeps the thumbnail it went out with.
        </div>
      )}
      {published.length === 0 && scheduledThere.length > 0 && t.options.length > 1 && (
        <div className={`${mono} text-[10px] leading-snug @min-[500px]:text-right`} style={{ color: "var(--mute-2)" }} data-thumbnail-published-note>
          Already scheduled on {scheduledThere.map((p) => NAME[p]).join(" and ")}: that video keeps the thumbnail it was scheduled with.
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- card -- */

function VideoCard({
  video,
  checked,
  previewing,
  busy,
  onToggle,
  onPreview,
  savingThumbnail,
  onChooseThumbnail,
  onJob,
}: {
  video: GeneratedVideo;
  checked: boolean;
  previewing: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onPreview: () => void;
  savingThumbnail: boolean;
  onChooseThumbnail: (id: string) => void;
  onJob: (jobId: string, action: "retry" | "cancel" | "confirm" | "remove") => void;
}) {
  // The card's own picture is the thumbnail chosen for it, so it follows a click at once.
  const leftSrc = video.thumbnail ? publishingThumbnail(video).src : video.thumbnailUrl;
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = brokenSrc === leftSrc;
  const gen = GENERATION[video.status] ?? { label: video.status, tone: "var(--mute)" };
  const vertical = video.format === "vertical";

  return (
    <li
      className="slab @container min-w-0 p-3.5"
      data-video={video.id}
      data-selectable={video.selectable ? "yes" : "no"}
      data-selected={checked ? "yes" : "no"}
      style={checked ? { borderColor: "var(--amber)" } : undefined}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 @min-[500px]:grid-cols-[auto_minmax(0,1fr)_auto]">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <input
            type="checkbox"
            checked={checked}
            disabled={!video.selectable}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Select ${video.title}`}
            title={video.selectable ? "Select this video" : (video.reason ?? "This video cannot be selected")}
            className="h-4 w-4 cursor-pointer accent-[var(--amber)] disabled:cursor-not-allowed"
          />
          <div
            className="relative overflow-hidden rounded-md border"
            style={{ borderColor: "var(--line)", background: "var(--slab-2)", width: vertical ? 64 : 112, aspectRatio: vertical ? "9 / 16" : "16 / 9" }}
          >
            {leftSrc && !broken ? (
              // eslint-disable-next-line @next/next/no-img-element -- served by our own authenticated route; sized by the card
              <img src={leftSrc} alt="" loading="lazy" onError={() => setBrokenSrc(leftSrc)} className="h-full w-full object-cover" data-card-preview />
            ) : (
              <span className={`absolute inset-0 grid place-items-center ${mono} text-[9px]`} style={{ color: "var(--mute-2)" }}>
                no thumbnail
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13.5px] font-semibold leading-snug" title={video.title}>{video.title}</div>
          <div className={`mt-0.5 truncate ${mono} text-[11px]`} style={{ color: "var(--mute-2)" }}>{video.repo}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip label={gen.label} tone={gen.tone} />
            <span className={`${mono} text-[11px]`} style={{ color: "var(--mute)" }}>{stamp(video.createdAt)}</span>
            <span className={`${mono} text-[11px]`} style={{ color: "var(--mute)" }} data-duration>
              {length(video.durationSec)}
            </span>
            {video.schedule && (
              <Chip
                label={`In "${video.schedule.name}"`}
                tone="var(--violet)"
                title={`Assigned ${istStamp(video.schedule.slotAt)} IST in a weekly schedule (${video.schedule.status.toLowerCase()}). Publishing it here does not change that schedule.`}
              />
            )}
          </div>

          {!video.selectable && video.reason && (
            <div className={`mt-1.5 ${mono} text-[10.5px] leading-relaxed`} style={{ color: video.status === "FAILED" || !video.file.ok ? "var(--rose)" : "var(--mute-2)" }} data-reason>
              {video.status === "DONE" && !video.file.ok ? errorPreview(video.reason, 140) : video.reason}
            </div>
          )}
          {video.status === "FAILED" && video.detail && (
            <div className={`mt-1 truncate ${mono} text-[10.5px]`} style={{ color: "var(--rose)" }}>{errorPreview(video.detail, 90)}</div>
          )}
          {(video.status === "RUNNING" || video.status === "QUEUED") && video.detail && (
            <div className={`mt-1 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>{video.detail}</div>
          )}

          {video.videoUrl && (
            <button type="button" onClick={onPreview} aria-expanded={previewing} className={`mt-1.5 ${mono} text-[11px] underline underline-offset-4`} style={{ color: "var(--mute)" }}>
              {previewing ? "Hide preview" : "Preview"}
            </button>
          )}
        </div>

        {/* Every thumbnail made for this video, to compare and choose from. */}
        {video.status === "DONE" && video.thumbnail && (
          <div className="col-span-2 flex justify-start @min-[500px]:col-span-1 @min-[500px]:justify-end">
            <ThumbnailGallery
              video={video}
              saving={savingThumbnail}
              onChoose={onChooseThumbnail}
              locked={
                PLATFORMS.some((p) => video.platforms[p].status === "publishing")
                  ? "A post for this video is publishing now. Change it afterwards."
                  : null
              }
            />
          </div>
        )}
      </div>

      {previewing && video.videoUrl && (
        <video
          src={video.videoUrl}
          controls
          preload="metadata"
          playsInline
          className="mt-3 max-h-[360px] w-full rounded-md bg-black"
        />
      )}

      <AttemptHistory episodeId={video.id} />
      {video.status === "DONE" && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2" style={{ borderColor: "var(--line)" }}>
          {PLATFORMS.map((p) => (
            <PlatformLine key={p} platform={p} state={video.platforms[p]} busy={busy} onJob={onJob} />
          ))}
        </div>
      )}
    </li>
  );
}

/* --------------------------------------------------------------------- dialog -- */

type Choice = "youtube" | "instagram" | "both" | null;
const platformsOf = (c: Choice): Platform[] => (c === "both" ? PLATFORMS : c ? [c] : []);

function ConfirmDialog({
  videos,
  checking,
  engines,
  submitting,
  onCancel,
  onConfirm,
}: {
  videos: GeneratedVideo[];
  checking: boolean;
  engines: Engines;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (choice: { platforms: Platform[]; engines: Record<Platform, "browser" | "api">; youtubePrivacy: string; publishNow: boolean; madeForKids: boolean | null }) => void;
}) {
  const [choice, setChoice] = useState<Choice>(null);
  const [privacy, setPrivacy] = useState("private");
  const [kids, setKids] = useState("");
  const [engine, setEngine] = useState<Record<Platform, "browser" | "api">>({ youtube: "browser", instagram: "browser" });
  const platforms = useMemo(() => platformsOf(choice), [choice]);
  const instagramDisabled = videos.every(v=>v.platforms.instagram.executionEnabled===false);
  // Two futures for the same selection: scheduling each video at its assigned slot time (the
  // default), and publishing now. They have different eligibility — a video in no schedule can
  // only go out via Publish now — so each button reads its own plan.
  const schedulePlan = useMemo(() => schedulePlanFor(videos, platforms), [videos, platforms]);
  const plan = useMemo(() => planFor(videos, platforms), [videos, platforms]);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  const base = platforms.length > 0 && videos.length <= 50 && !checking && !submitting;
  // Schedule is enabled only when something actually has an assigned time to schedule; Publish now
  // follows the immediate rules. One can be available without the other.
  const scheduleReady = base && schedulePlan.posts > 0;
  const nowReady = base && plan.posts > 0 && (!platforms.includes("youtube") || kids !== "");
  const publicYoutube = platforms.includes("youtube") && privacy === "public";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "var(--scrim)" }}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-dialog-title"
        className="slab max-h-[90vh] w-full max-w-[640px] overflow-y-auto p-5 outline-none"
      >
        <h2 id="publish-dialog-title" className="font-display text-[20px] font-semibold">
          Schedule {countLabel(videos.length)}?
        </h2>
        <p className={`mt-1 ${mono} text-[11.5px] leading-relaxed`} style={{ color: "var(--mute)" }}>
          Schedule uses each video&apos;s own weekly-schedule time (its assigned date and time, in Asia/Kolkata) and each
          platform&apos;s native Schedule flow. A video that is not in a schedule is refused, not posted now — use Publish now
          for that. This never creates, changes or starts a schedule; drafts must be activated explicitly before their posts can be scheduled.
        </p>

        <fieldset className="mt-4">
          {videos.length > 50 && <p role="alert" className="mb-2 text-[12px]" style={{color:"var(--rose)"}}>Publish at most 50 videos at a time. Close this dialog and reduce the selection.</p>}
          <legend className="eyebrow mb-2">where to publish</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Where to publish">
            {(["youtube", "instagram", "both"] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={choice === c}
                disabled={submitting || (instagramDisabled && c === "instagram")}
                onClick={() => setChoice(c)}
                data-choice={c}
                className={`rounded-lg border px-3.5 py-1.5 ${mono} text-[12px] disabled:opacity-50`}
                style={choice === c ? { background: "var(--amber)", borderColor: "var(--amber)", color: "var(--on-accent)", fontWeight: 600 } : ghost}
              >
                {c === "both" ? "YouTube and Instagram" : c === "instagram" && instagramDisabled ? "Instagram (disabled)" : NAME[c]}
              </button>
            ))}
          </div>
          {instagramDisabled && <p className="mt-2 text-[12px]" role="status">Instagram execution is disabled. Choosing both still allows eligible YouTube posts.</p>}
          {!choice && <p className={`mt-2 ${mono} text-[11px]`} style={{ color: "var(--mute-2)" }}>Choose where these go. Nothing is chosen for you.</p>}
        </fieldset>

        {platforms.includes("youtube") && (
          <div className="mt-4">
            <label className="mb-3 block text-[12px]">YouTube audience<select aria-label="Publishing audience" value={kids} onChange={e=>setKids(e.target.value)} className="ml-2 rounded border p-2" style={FIELD}><option value="">Choose for Publish now…</option><option value="no">Not made for kids</option><option value="yes">Made for kids</option></select></label>
            <label className="eyebrow mb-1.5 block" htmlFor="publish-yt-visibility">YouTube visibility</label>
            <select id="publish-yt-visibility" value={privacy} onChange={(e) => {setPrivacy(e.target.value); if(e.target.value!=="private")setEngine(cur=>({...cur,youtube:"browser"}));}} disabled={submitting} className={`rounded-lg border px-2.5 py-1.5 ${mono} text-[12px] outline-none`} style={FIELD}>
              <option value="private">Private (only you)</option>
              <option value="unlisted">Unlisted (anyone with the link)</option>
              <option value="public">Public</option>
            </select>
            {publicYoutube && (
              <p className={`mt-1.5 ${mono} text-[11px]`} style={{ color: "var(--rose)" }}>
                Public: everyone can see these the moment YouTube confirms them.
              </p>
            )}
          </div>
        )}

        {platforms.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className={`${mono} text-[11px]`} style={{color:"var(--mute)"}}>These visibility and engine choices apply to Publish now. Schedule uses the activated plan’s saved configuration.</p>
            {platforms.map((p) => (
              <div key={p} className="flex flex-wrap items-center gap-2">
                <span className={`${mono} min-w-[104px] shrink-0 text-[11.5px]`} style={{ color: "var(--mute)" }}>{NAME[p]} via</span>
                {engines[p].api ? (
                  <select
                    aria-label={`${NAME[p]} engine`}
                    value={engine[p]}
                    onChange={(e) => setEngine((cur) => ({ ...cur, [p]: e.target.value as "browser" | "api" }))}
                    disabled={submitting}
                    className={`rounded-lg border px-2.5 py-1.5 ${mono} text-[12px] outline-none`}
                    style={FIELD}
                  >
                    <option value="browser">A browser window on this computer</option>
                    <option value="api" disabled={p === "youtube" && privacy !== "private"}>The API ({engines[p].account ?? "connected account"}){p === "youtube" && privacy !== "private" ? " · private Publish now only" : ""}</option>
                  </select>
                ) : (
                  <span className={`${mono} text-[11.5px]`} style={{ color: "var(--mute-2)" }}>
                    a browser window on this computer (needs the profile signed in to {NAME[p]})
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-4">
          <div className="eyebrow mb-1.5">videos</div>
          {checking ? (
            <p className={`${mono} text-[11.5px]`} style={{ color: "var(--mute-2)" }}>Checking each video…</p>
          ) : (
            <ul className="max-h-[240px] space-y-2.5 overflow-y-auto rounded-lg border p-2.5" style={{ borderColor: "var(--line)", background: "var(--slab-2)" }} data-summary>
              {schedulePlan.rows.map((row) => (
                <li key={row.id} className="min-w-0" data-summary-video={row.id}>
                  <div className="truncate text-[12.5px] font-semibold" title={row.title}>{row.title}</div>
                  {row.slotAt ? (
                    <div className={`${mono} text-[11px]`} style={{ color: "var(--mute)" }} data-assigned-at={row.slotAt}>
                      Assigned: {istStamp(row.slotAt)} IST
                    </div>
                  ) : (
                    <div className={`${mono} text-[11px]`} style={{ color: "var(--amber)" }} data-not-assigned>
                      Not assigned to a schedule — it will not be scheduled. Use Publish now to post it immediately.
                    </div>
                  )}
                  {platforms.length > 0 &&
                    platforms.map((p) => {
                      const cell = row.cells[p]!;
                      return (
                        <div key={p} className={`${mono} text-[11px]`} style={{ color: cell.will ? "var(--mute)" : "var(--amber)" }} data-cell={p} data-cell-will={cell.will ? "yes" : "no"}>
                          {NAME[p]}: {cell.will ? "will be scheduled" : `skipped — ${cell.note}`}
                        </div>
                      );
                    })}
                </li>
              ))}
            </ul>
          )}
        </div>

        {platforms.length > 0 && !checking && (
          <ul className={`mt-4 list-disc space-y-1 pl-5 ${mono} text-[11px] leading-relaxed`} style={{ color: "var(--mute)" }}>
            <li data-total>{schedulePlan.posts} post{schedulePlan.posts === 1 ? "" : "s"} will be scheduled{schedulePlan.skipped ? `; ${schedulePlan.skipped} skipped` : ""}.</li>
            {schedulePlan.skippedBy.map((g) => (
              <li key={g.kind} data-skipped-kind={g.kind} style={{ color: "var(--amber)" }}>
                {g.count} skipped: {g.label}.
              </li>
            ))}
            {schedulePlan.noSlot > 0 && (
              <li data-no-slot-help style={{ color: "var(--amber)" }}>
                {schedulePlan.noSlot} selected {schedulePlan.noSlot === 1 ? "video is" : "videos are"} not in a weekly schedule, so {schedulePlan.noSlot === 1 ? "it has" : "they have"} no
                assigned time and will not be scheduled. Add {schedulePlan.noSlot === 1 ? "it" : "them"} to a schedule, or use Publish now to post {schedulePlan.noSlot === 1 ? "it" : "them"} immediately.
              </li>
            )}
            <li>Each video is scheduled at its assigned time (shown above, in Asia/Kolkata) through the platform&apos;s own native Schedule flow. The time is never recalculated.</li>
            {platforms.includes("instagram") && <li>Instagram has no private reel: it goes public at its scheduled time.</li>}
            <li>Publish now, instead, posts the selected videos immediately and ignores every assigned time.</li>
            <li>A video is shown as scheduled only after the platform confirms it holds the schedule.</li>
          </ul>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={submitting} className={`rounded-lg border px-3.5 py-2 ${mono} text-[12px] disabled:opacity-40`} style={ghost}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!nowReady}
            onClick={() => onConfirm({ platforms, engines: engine, youtubePrivacy: privacy, publishNow: true, madeForKids: kids === "" ? null : kids === "yes" })}
            className={`rounded-lg border px-4 py-2 ${mono} text-[12.5px] disabled:opacity-40`}
            style={ghost}
            data-confirm-now
            title="Post these immediately, ignoring any weekly-schedule time."
          >
            {submitting ? "Sending…" : "Publish now"}
          </button>
          <button
            type="button"
            disabled={!scheduleReady}
            onClick={() => onConfirm({ platforms, engines: engine, youtubePrivacy: privacy, publishNow: false, madeForKids: kids === "" ? null : kids === "yes" })}
            className={`rounded-lg px-4 py-2 ${mono} text-[12.5px] font-semibold disabled:opacity-40`}
            style={{ background: "var(--amber)", color: "var(--on-accent)" }}
            data-confirm
            title="Schedule each video at its assigned weekly-schedule time, in Asia/Kolkata."
          >
            {submitting ? "Sending…" : `Schedule ${schedulePlan.posts ? `${schedulePlan.posts} post${schedulePlan.posts === 1 ? "" : "s"}` : ""}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- the section -- */

interface Batch {
  /** Videos in the order they were sent. */
  ids: string[];
  platforms: Platform[];
  /** What the server said about each video and platform at the time. */
  items: BulkItem[];
}

export default function GeneratedVideos({ onToast }: { onToast: (message: string, tone?: "ok" | "warn" | "error") => void }) {
  const [pageNo, setPageNo] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cache, setCache] = useState<Map<string, GeneratedVideo>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  // Videos whose thumbnail choice is being saved: their gallery waits a moment, others are free.
  const [savingThumb, setSavingThumb] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  // Search by title or source book. The box's value updates on every keystroke; the
  // request is sent from a settled value a beat later so typing does not fire a call each key.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const hydrated = useRef(false);
  const sending = useRef(false);

  const remember = useCallback((videos: GeneratedVideo[]) => {
    setCache((cur) => {
      const next = new Map(cur);
      for (const v of videos) next.set(v.id, v);
      return next;
    });
  }, []);

  /** Take an answer from the list route. */
  const apply = useCallback(
    (r: { ok: boolean; data: Record<string, unknown> }, asked: number) => {
      if (!r.ok) {
        setLoadError(String(r.data.error ?? "The video list failed to load."));
        return;
      }
      setLoadError(null);
      const page = r.data as unknown as Page;
      setData(page);
      remember(page.items);

      // The selection is kept for the session so changing pages or reloading does not lose it.
      // It is read back once, here, because only now is it known which of those can still be
      // published - and anything that cannot is dropped, so it is never sent.
      let remembered = new Set<string>();
      if (!hydrated.current) {
        try {
          remembered = parseStored(window.sessionStorage.getItem(STORAGE_KEY));
        } catch {
          /* storage can be unavailable; the selection then lasts until the page is closed */
        }
        hydrated.current = true;
      }
      setSelected((cur) => prune(new Set([...cur, ...remembered]), page.selectableIds));
      if (page.page !== asked) setPageNo(page.page);
    },
    [remember],
  );

  // Settle the search a beat after the last keystroke, so the list is fetched once, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const qs = debouncedQuery.trim() ? `&q=${encodeURIComponent(debouncedQuery.trim())}` : "";
      const r = await api(`/api/schedule-board/videos?page=${pageNo}&pageSize=${PAGE_SIZE}${qs}`);
      // A slower answer to a page that is no longer the one being looked at is dropped.
      if (!cancelled) apply(r, pageNo);
    })();
    return () => {
      cancelled = true;
    };
  }, [pageNo, reload, debouncedQuery, apply]);

  useEffect(() => {
    // Not before the remembered selection has been read back, or an empty one would overwrite it.
    if (!hydrated.current) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...selected]));
    } catch {
      /* ignore */
    }
  }, [selected]);

  const video = useCallback((v: GeneratedVideo) => cache.get(v.id) ?? v, [cache]);
  const shown = useMemo(() => (data?.items ?? []).map(video), [data, video]);

  /* progress: ask again about the videos that are being published, only while something is */
  const trackedKey = useMemo(() => {
    const ids = new Set<string>(batch?.ids ?? []);
    for (const v of data?.items ?? []) ids.add(v.id);
    return [...ids].slice(0, 100).join(",");
  }, [batch, data]);
  const anyLive = trackedKey.split(",").some((id) => {
    const v = cache.get(id);
    return v ? liveVideo(v) : false;
  });
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(async () => {
      const r = await api(`/api/schedule-board/videos?ids=${trackedKey}`);
      if (!r.ok) return;
      const items = (r.data.items as GeneratedVideo[]) ?? [];
      remember(items);
      // The last post just settled: the list's own idea of which videos can be picked is out of date.
      if (!items.some(liveVideo)) setReload((n) => n + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyLive, trackedKey, remember]);

  /* ------------------------------------------------------------- selecting */

  // A video that stopped being publishable while it sat ticked (it went out from another
  // tab, say) no longer counts, whatever the stored selection still says.
  const chosen = useMemo(() => new Set([...selected].filter((id) => cache.get(id)?.selectable !== false)), [selected, cache]);
  const count = chosen.size;
  const selectableIds = data?.selectableIds ?? [];
  const closeDialog = useCallback(() => setDialog(false), []);


  const setOne = (id: string, selectable: boolean, on: boolean) => setSelected((cur) => toggle(cur, id, selectable, on));

  /* ------------------------------------------------------------- publishing */

  const selectedVideos = useMemo(
    () =>
      [...chosen]
        .map((id) => cache.get(id))
        .filter((v): v is GeneratedVideo => !!v)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [chosen, cache],
  );

  async function openDialog() {
    if (!count || dialog) return;
    setDialog(true);
    setChecking(true);
    // The selection can span pages the list has not loaded; read them all fresh so
    // the summary describes what is true now, not what was true when they were ticked.
    const r = await api(`/api/schedule-board/videos?ids=${[...chosen].join(",")}`);
    if (r.ok) {
      const items = (r.data.items as GeneratedVideo[]) ?? [];
      remember(items);
      setSelected((cur) => prune(cur, items.filter((v) => v.selectable).map((v) => v.id)));
    }
    setChecking(false);
  }

  async function confirm(choice: { platforms: Platform[]; engines: Record<Platform, "browser" | "api">; youtubePrivacy: string; publishNow: boolean; madeForKids: boolean | null }) {
    // One request at a time: a second click while one is under way does nothing.
    if (sending.current) return;
    sending.current = true;
    setSubmitting(true);
    try {
      const ids = selectedVideos.filter((v) => v.selectable).map((v) => v.id);
      const r = await post("/api/schedule-board/bulk", {
        creationIds: ids,
        platforms: choice.platforms,
        engines: choice.engines,
        youtubePrivacy: choice.youtubePrivacy,
        madeForKids: choice.madeForKids,
        // Default (false) schedules each video at its weekly-schedule time; true posts now.
        publishNow: choice.publishNow,
        confirmed: true,
      });
      if (!r.ok) {
        onToast(String(r.data.error ?? "That did not go through."), "error");
        return;
      }
      const result = r.data as unknown as BulkResult;
      setBatch({ ids, platforms: choice.platforms, items: result.items });
      setSelected(deselectAll());
      setDialog(false);
      const verb = choice.publishNow ? "started" : "scheduled";
      const parts = [`${result.started} ${result.started === 1 ? "post" : "posts"} ${verb}`];
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      if (result.rejected) parts.push(`${result.rejected} refused`);
      onToast(parts.join(", ") + ".", result.rejected ? "warn" : "ok");

      const fresh = await api(`/api/schedule-board/videos?ids=${ids.join(",")}`);
      if (fresh.ok) remember((fresh.data.items as GeneratedVideo[]) ?? []);
      setReload((n) => n + 1);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  /**
   * Choose a thumbnail for one video.
   *
   * The card shows the choice at once (the preview on the left is the chosen file), then it
   * is saved for that video. If the server refuses - a post for it is publishing, say - the
   * card goes back to what it was and says why, so what is on screen is never a choice that
   * was not kept.
   */
  async function chooseThumbnail(id: string, variant: string) {
    const before = cache.get(id);
    if (!before?.thumbnail || before.thumbnail.selected === variant || savingThumb.includes(id)) return;
    setSavingThumb((cur) => [...cur, id]);
    remember([{ ...before, thumbnail: { ...before.thumbnail, selected: variant } }]);
    try {
      const r = await post(`/api/episodes/${id}/thumbnail`, { choice: variant });
      if (!r.ok) {
        remember([before]);
        onToast(String(r.data.error ?? "The thumbnail could not be changed."), "error");
        return;
      }
      // Read this video back, so the card shows what the server now has.
      const fresh = await api(`/api/schedule-board/videos?ids=${id}`);
      if (fresh.ok) remember((fresh.data.items as GeneratedVideo[]) ?? []);
    } finally {
      setSavingThumb((cur) => cur.filter((x) => x !== id));
    }
  }

  async function jobAction(jobId: string, action: "retry" | "cancel" | "confirm" | "remove", creationId?: string) {
    if (busy) return;
    if (action === "retry" && !window.confirm("Try this post again? It is checked first so the same video is never published twice.")) return;
    if (action === "cancel" && !window.confirm("Cancel this post?")) return;
    if (action === "remove" && !window.confirm("Only do this after you have deleted the scheduled video on the platform. Cancelling here does not unschedule it, and forgetting it while it is still there would let the same video be scheduled twice. Continue?")) return;
    setBusy(true);
    try {
      // "remove" forgets a schedule the platform holds: a cancel the server accepts only when told it is gone there.
      const r = action === "remove" ? await post(`/api/schedule-board/jobs/${jobId}/cancel`, { removedOnPlatform: true }) : await post(`/api/schedule-board/jobs/${jobId}/${action}`);
      if (!r.ok) onToast(String(r.data.error ?? "That did not go through."), "error");
      else onToast(action === "retry" ? "Started again." : action === "cancel" || action === "remove" ? "Cancelled." : "Marked as done.");
      const owner = creationId ?? [...cache.values()].find((v) => PLATFORMS.some((p) => v.platforms[p].job?.id === jobId))?.id;
      if (owner) {
        const fresh = await api(`/api/schedule-board/videos?ids=${owner}`);
        if (fresh.ok) remember((fresh.data.items as GeneratedVideo[]) ?? []);
      }
    } finally {
      setBusy(false);
    }
  }

  const batchVideos = useMemo(() => (batch ? batch.ids.map((id) => cache.get(id)).filter((v): v is GeneratedVideo => !!v) : []), [batch, cache]);
  const batchLines = useMemo(() => {
    if (!batch) return null;
    let finished = 0;
    let failed = 0;
    let total = 0;
    for (const item of batch.items) {
      if (item.outcome !== "started") continue;
      total++;
      const v = cache.get(item.creationId);
      const s = v?.platforms[item.platform].status;
      if (s === "published" || s === "scheduled-on-platform") finished++;
      else if (s === "failed" || s === "cancelled" || s === "needs-you") {
        finished++;
        if (s === "failed") failed++;
      }
    }
    return { total, finished, failed, done: total > 0 && finished === total };
  }, [batch, cache]);

  const pages = data?.pages ?? 1;
  const first = data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <section className="mt-10" aria-label="Generated videos" id="generated-videos">
      <header className="mb-4">
        <div className="eyebrow mb-1">generated videos · publish now</div>
        <h2 className="font-display text-[24px] font-bold leading-none tracking-tight">Generated videos</h2>
        <p className="mt-2 max-w-2xl text-[13px]" style={{ color: "var(--mute)" }}>
          Your most recent videos, newest first. Tick the ones to publish, then press Publish Selected Videos at the bottom.
          The confirmation dialog offers Schedule at assigned times or Publish now. Drafts must be activated explicitly before scheduling posts.
        </p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className={`${mono} text-[12.5px] font-semibold`} data-selected-count aria-live="polite">
          Selected: {countLabel(count)}
        </span>
        <button type="button" disabled={!selectableIds.length} onClick={() => setSelected(selectAll(selectableIds))} className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`} style={ghost} title="Selects every video that can be published, on every page">
          Select all{selectableIds.length ? ` (${selectableIds.length})` : ""}
        </button>
        <button type="button" disabled={!count} onClick={() => setSelected(deselectAll())} className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`} style={ghost}>
          Deselect all
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPageNo(1); // a new search starts at the first page of its matches
              }}
              placeholder="Search title or book…"
              aria-label="Search generated videos by title or booksitory"
              className={`w-[190px] rounded-lg border py-1.5 pl-3 pr-7 ${mono} text-[12px] outline-none`}
              style={FIELD}
              data-video-search
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setPageNo(1);
                }}
                aria-label="Clear search"
                className={`absolute right-1.5 top-1/2 -translate-y-1/2 ${mono} text-[13px] leading-none`}
                style={{ color: "var(--mute-2)" }}
                data-video-search-clear
              >
                ✕
              </button>
            )}
          </div>
          {data && (
            <span className={`${mono} text-[11.5px]`} style={{ color: "var(--mute-2)" }}>
              {data.total ? `Showing ${first}–${last} of ${data.total}` : debouncedQuery ? "No matches" : "No videos yet"}
            </span>
          )}
        </div>
      </div>

      {loadError && (
        <p className={`mb-3 ${mono} text-[12px]`} style={{ color: "var(--rose)" }} role="alert">
          {loadError}{" "}
          <button type="button" onClick={() => setReload((n) => n + 1)} className="underline underline-offset-4">Try again</button>
        </p>
      )}
      {!data && !loadError && <p className={`${mono} text-[12.5px]`} style={{ color: "var(--mute-2)" }}>Loading…</p>}
      {data && !data.total && (
        <p className={`${mono} text-[12.5px]`} style={{ color: "var(--mute-2)" }} data-empty>
          {debouncedQuery
            ? `No videos found for “${debouncedQuery}”. Try a different title or booksitory.`
            : "Nothing has been generated yet. Make a video in the studio and it will appear here."}
        </p>
      )}

      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Videos">
        {shown.map((v) => (
          <VideoCard
            key={v.id}
            video={v}
            checked={selected.has(v.id)}
            previewing={previewId === v.id}
            busy={busy}
            onToggle={(on) => setOne(v.id, v.selectable, on)}
            onPreview={() => setPreviewId((cur) => (cur === v.id ? null : v.id))}
            savingThumbnail={savingThumb.includes(v.id)}
            onChooseThumbnail={(variant) => void chooseThumbnail(v.id, variant)}
            onJob={(jobId, action) => void jobAction(jobId, action, v.id)}
          />
        ))}
      </ul>

      {data && data.pages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-3" aria-label="Pages">
          <button type="button" disabled={pageNo <= 1} onClick={() => setPageNo((n) => Math.max(1, n - 1))} className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`} style={ghost}>
            Previous
          </button>
          <span className={`${mono} text-[12px]`} style={{ color: "var(--mute)" }} data-page>
            Page {data.page} of {pages}
          </span>
          <button type="button" disabled={pageNo >= pages} onClick={() => setPageNo((n) => Math.min(pages, n + 1))} className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`} style={ghost}>
            Next
          </button>
        </nav>
      )}

      {batch && batchLines && (
        <section className="slab mt-6 space-y-3 p-4 sm:p-5" aria-label="Publishing progress" data-batch>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-display text-[17px] font-semibold">Publishing progress</span>
              <span className={`${mono} text-[11.5px]`} style={{ color: "var(--mute-2)" }} data-batch-counts>
                {batchLines.finished} of {batchLines.total} posts finished{batchLines.failed ? ` · ${batchLines.failed} failed` : ""}
              </span>
            </div>
            <button type="button" onClick={() => setBatch(null)} className={`${mono} text-[11.5px] underline underline-offset-4`} style={{ color: "var(--mute-2)" }}>
              Dismiss
            </button>
          </div>

          {batch.items.some((i) => i.outcome !== "started") && (
            <ul className="space-y-1" data-batch-notes>
              {batch.items
                .filter((i) => i.outcome !== "started")
                .map((i) => (
                  <li key={`${i.creationId}:${i.platform}`} className={`${mono} text-[11.5px]`} style={{ color: i.outcome === "rejected" ? "var(--rose)" : "var(--amber)" }}>
                    {cache.get(i.creationId)?.title ?? i.creationId} · {NAME[i.platform]} · {i.outcome === "rejected" ? "not sent" : "skipped"}: {i.message}
                  </li>
                ))}
            </ul>
          )}

          <ul className="grid gap-3">
            {batchVideos.map((v) => (
              <li key={v.id} className="min-w-0 border-t pt-3" style={{ borderColor: "var(--line)" }} data-batch-video={v.id}>
                <div className="mb-1.5 truncate text-[13px] font-semibold" title={v.title}>{v.title}</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {batch.platforms.map((p) => (
                    <PlatformLine key={p} platform={p} state={v.platforms[p]} busy={busy} onJob={(jobId, action) => void jobAction(jobId, action, v.id)} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- the button, at the bottom of the page and always in reach */}
      <div
        className="sticky bottom-3 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 sm:px-4"
        style={{ borderColor: "var(--line)", background: "var(--slab)", boxShadow: "0 -6px 24px rgba(0,0,0,0.25)" }}
      >
        <span className={`${mono} text-[12.5px] font-semibold`} aria-live="polite" data-bar-count>
          Selected: {countLabel(count)}
        </span>
        <button
          type="button"
          disabled={!count || dialog || submitting}
          onClick={() => void openDialog()}
          className={`rounded-lg px-5 py-2.5 ${mono} text-[13px] font-semibold disabled:opacity-40`}
          style={{ background: "var(--amber)", color: "var(--on-accent)" }}
          title={count ? "Choose where to publish, then confirm" : "Select at least one video first"}
          data-publish-selected
        >
          Publish Selected Videos
        </button>
      </div>

      {dialog && data && (
        <ConfirmDialog
          videos={selectedVideos}
          checking={checking}
          engines={data.engines}
          submitting={submitting}
          onCancel={closeDialog}
          onConfirm={(c) => void confirm(c)}
        />
      )}
    </section>
  );
}
