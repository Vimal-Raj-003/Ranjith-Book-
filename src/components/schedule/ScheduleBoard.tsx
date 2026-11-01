"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToastHost, useToast } from "../Toast";
import GeneratedVideos from "./GeneratedVideos";
import { ScheduleDatePicker, ScheduleTimePicker } from "./SchedulePickers";
import { DEFAULT_WINDOWS } from "@/lib/schedule/plan";
import { DEFAULT_TIMEZONE, addDays, todayIn, zoneLabel } from "@/lib/schedule/reference-time";
import { jobTiming } from "@/lib/schedule/job-timing";
import { errorPreview } from "@/lib/schedule/board-retry";
import { scheduleRetryCandidate } from "@/lib/schedule/board-retry";
import { CONFLICT_WORDS, STORAGE_KEY, parseStored } from "@/lib/schedule/video-selection";
import type { Candidate, JobView, ScheduleView, SlotView } from "@/lib/schedule/board-types";

/**
 * The weekly schedule: review it, edit it, arm it, and watch it run.
 *
 * Everything on this screen is read from, and written to, the schedule's own rows
 * through /api/schedule-board. Nothing here keeps a timer or a copy of the plan: a
 * refresh, a second tab, or a restart of the server shows exactly the same thing,
 * because the thing it shows is in the database. A draft arms nothing, so every
 * edit on it is safe; arming is a deliberate button with its own confirmation.
 */

interface ListedSchedule {
  id: string;
  name: string;
  status: string;
  startDate: string;
  days: number;
  slots: number;
  withVideo: number;
}

interface Issue {
  key: string;
  severity: "error" | "warning";
  message: string;
}

const mono = "font-mono";
const FIELD = { background: "var(--field)", borderColor: "var(--line)", color: "var(--ink)" } as const;
const fieldClass = `rounded-lg border px-2.5 py-1.5 ${mono} text-[12px] outline-none`;

const TONE: Record<string, string> = {
  DRAFT: "var(--mute-2)",
  ACTIVE: "var(--cyan)",
  PAUSED: "var(--amber)",
  CANCELLED: "var(--mute-2)",
  SCHEDULED: "var(--amber)",
  PUBLISHING: "var(--amber)",
  POSTED: "var(--cyan)",
  PLATFORM_SCHEDULED: "var(--cyan)",
  FAILED: "var(--rose)",
  AWAITING_HUMAN: "var(--amber)",
  PLANNED: "var(--mute-2)",
  SKIPPED: "var(--mute-2)",
};

async function api(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(path, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server." } };
  }
}

const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const issuesOf = (data: Record<string, unknown>): Issue[] => (Array.isArray(data.issues) ? (data.issues as Issue[]) : []);

/** What a cancel did, including what it could not take back: a schedule YouTube holds stays there. */
function cancelled(data: Record<string, unknown>): string {
  const held = Number(data.stillScheduled ?? 0);
  const running = Number(data.stillRunning ?? 0);
  if(running)return `Cancelled locally. ${running} upload${running===1?" is":"s are"} already running and may finish; inspect the platform. ${held} already-confirmed platform schedules remain unchanged.`;
  return held > 0
    ? `Cancelled locally. ${held} post${held === 1 ? " is" : "s are"} still scheduled on the platform. Remove those schedules on the platform if you do not want them to publish.`
    : "Cancelled.";
}

/* ------------------------------------------------------------------ pieces -- */

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

/** "05:23" from an ISO instant, in the schedule's own zone. */
function clock(iso: string | null, timezone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

const minutesBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);

/** "Wed 21 Oct, 05:23", for an instant in the schedule's own zone. */
function dayAndClock(iso: string, timezone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  return `${day}, ${clock(iso, timezone)} ${zoneLabel(timezone)}`;
}

/** What one platform's job says about itself, in words. */
function jobWords(job: JobView | null, slot: SlotView, platform: string, timezone: string): { label: string; tone: string; detail: string } {
  if (!job) return { label: slot.status === "SKIPPED" ? "Skipped" : "Not armed", tone: "var(--mute-2)", detail: "" };

  if (job.status === "DRAFT") {
    const missed = /^(Missed|Not scheduled)/.test(job.error ?? "");
    const label = missed ? (job.nativeSchedule ? "Not scheduled" : "Missed") : "On hold";
    return { label, tone: missed ? "var(--rose)" : "var(--amber)", detail: "" };
  }
  if (job.status === "PLATFORM_SCHEDULED") {
    // The platform confirmed it. Said as the platform's, with the time the platform has.
    return {
      label: `Scheduled on ${platform}`,
      tone: "var(--cyan)",
      detail: job.platformPublishAt ? `${platform} publishes it ${dayAndClock(job.platformPublishAt, timezone)}` : "",
    };
  }
  if (job.status === "POSTED") {
    const late = job.publishAt && job.postedAt ? minutesBetween(job.publishAt, job.postedAt) : 0;
    return {
      label: "Posted",
      tone: "var(--cyan)",
      detail: job.postedAt ? (late > 3 ? `recorded ${late} min after its time` : "on time") : "",
    };
  }
  if (job.status === "SCHEDULED") return { label: job.nativeSchedule ? "Queued" : "Scheduled", tone: "var(--amber)", detail: "" };
  if (job.status === "PUBLISHING") return { label: job.nativeSchedule ? "Scheduling" : "Publishing", tone: "var(--amber)", detail: job.error ?? "" };
  if (job.status === "AWAITING_HUMAN") return { label: "Needs you", tone: "var(--amber)", detail: "" };
  if (job.status === "FAILED") return { label: "Failed", tone: "var(--rose)", detail: "" };
  return { label: "Cancelled", tone: "var(--mute-2)", detail: "" };
}

/**
 * Whether one platform's job can be (re)started: it failed, or was held/missed.
 *
 * A post whose time slipped by while the server was off is already turned into a held DRAFT by the
 * reconciler, so "held/missed" covers the overdue case without the UI having to read the clock.
 */
function jobRecoverable(job: JobView | null): boolean {
  if (!job || job.preUpload === false) return false; // no job of its own, or remote state exists: inspect first
  return (
    job.status === "FAILED" ||
    job.status === "CANCELLED" ||
    job.status === "DRAFT" ||
    (job.status === "AWAITING_HUMAN" && job.preUpload === true)
  );
  // SCHEDULED (still waiting), PUBLISHING, POSTED, PLATFORM_SCHEDULED and non-pre-upload AWAITING_HUMAN are left alone.
}

/**
 * Whether to offer "OK, Start Now" for a slot: it has a video and something that can be restarted.
 *
 * A draft slot qualifies when it cannot be activated as it stands (its time has passed, its video
 * is already used, …) — exactly the slot-level errors the board already shows. An armed slot
 * qualifies when a platform failed or was held/missed. A video YouTube already holds the schedule
 * for is left to its own card, and a post that is publishing, posted or waiting on a person is
 * never offered here.
 */
function slotStartable(slot: SlotView, draft: boolean, scheduleActive: boolean): boolean {
  if (!slot.creation || slot.status === "SKIPPED" || slot.status === "CANCELLED") return false;
  if (slot.jobs.youtube?.status === "PLATFORM_SCHEDULED") return false;
  if (draft) return false; // Drafts require the explicit Activate confirmation.
  if (!scheduleActive) return false; // resume a paused schedule first
  return jobRecoverable(slot.jobs.youtube) || jobRecoverable(slot.jobs.instagram);
}

function JobCell({
  platform,
  job,
  slot,
  timezone,
  busy,
  retryAllowed,
  enabled = true,
  onRetry,
  onConfirm,
}: {
  platform: "YouTube" | "Instagram";
  job: JobView | null;
  slot: SlotView;
  timezone: string;
  busy: boolean;
  retryAllowed: boolean;
  enabled?: boolean;
  onRetry: (id: string) => Promise<void>;
  onConfirm: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);
  const w = !enabled && (!job || job.status === "SCHEDULED") ? {label:"Disabled",tone:"var(--mute-2)",detail:"Instagram execution is disabled; YouTube proceeds independently."} : jobWords(job, slot, platform, timezone);
  const timing = job ? jobTiming(job, platform, timezone) : "";
  const note = job?.error && job.status !== "PUBLISHING" ? job.error : "";
  const hideCalendarId = platform === "Instagram" && /Instagram calendar item\b/i.test(note);
  const alreadyDone = !!job && (job.status === "PLATFORM_SCHEDULED" || job.status === "POSTED" || !!job.platformPublishAt);
  const canRetry = enabled && retryAllowed && slot.status === "ACTIVE" && !!job && scheduleRetryCandidate(job);

  return (
    <div className="min-w-[150px] flex-1" data-job={job?.id} data-platform={platform.toLowerCase()} data-job-status={job?.status ?? "NONE"}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${mono} text-[11px]`} style={{ color: "var(--mute)" }}>{platform}</span>
        <Chip label={w.label} tone={w.tone} />
        {job?.remoteUrl && (
          <a href={job.remoteUrl} target="_blank" rel="noreferrer" className={`${mono} text-[11px] underline underline-offset-4`} style={{ color: "var(--cyan)" }}>
            open
          </a>
        )}
      </div>
      {timing && (
        <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>
          {timing}
        </div>
      )}
      {w.detail && <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>{w.detail}</div>}
      {note && !hideCalendarId && (
        <div className={`mt-0.5 truncate ${mono} text-[10.5px]`} style={{ color: job?.status === "POSTED" ? "var(--mute-2)" : "var(--rose)" }} data-job-note>
          {errorPreview(note, 70)}
        </div>
      )}
      {(note || job) && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {note && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${mono} text-[10.5px] underline underline-offset-4`} style={{ color: "var(--mute-2)" }}>
            {open ? "Hide" : "Details"}
          </button>
          )}
          {job && (
            <button
              type="button"
              disabled={busy || retrying || !canRetry}
              aria-busy={retrying}
              data-platform-retry={job.id}
              onClick={async () => {
                if (!canRetry || retryInFlight.current) return;
                retryInFlight.current = true;
                setRetrying(true);
                try { await onRetry(job.id); }
                finally { retryInFlight.current = false; setRetrying(false); }
              }}
              className={`rounded-md border px-2 py-0.5 ${mono} text-[11px] disabled:opacity-40`}
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              title={alreadyDone ? `${platform} already has this post scheduled or published. No retry is needed.`
                : canRetry ? `Retry only this ${platform} job at its original publication time, using the existing upload and duplicate checks.`
                : "Retry becomes available for a failed or recovered job in an active schedule. Processing and approval-held jobs are left alone."}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
      {note && open && (
        <pre
          className={`mt-1 max-h-48 max-w-full overflow-y-auto whitespace-pre-wrap rounded-md border p-2 ${mono} text-[10.5px] leading-relaxed`}
          style={{ borderColor: "var(--line)", color: "var(--mute)", overflowWrap: "anywhere" }}
        >
          {note}
        </pre>
      )}
      {job && job.status === "AWAITING_HUMAN" && (
        <button
          type="button"
          disabled={busy || !enabled}
          onClick={() => onConfirm(job.id)}
          className={`mt-1 rounded-md border px-2 py-0.5 ${mono} text-[11px] disabled:opacity-40`}
          style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          title={job.nativeSchedule ? "Only after you have checked YouTube Studio and it lists the video as scheduled for this time" : "Only after you have checked the platform and it is published"}
        >
          {job.nativeSchedule ? "It is scheduled" : "I published it"}
        </button>
      )}
    </div>
  );
}

function SlotRow({
  slot,
  view,
  candidates,
  busy,
  onMove,
  onVideo,
  onSlotAction,
  onStartNow,
  onRetry,
  onConfirm,
}: {
  slot: SlotView;
  view: ScheduleView;
  candidates: Candidate[];
  busy: boolean;
  onMove: (slot: SlotView, date: string, time: string) => Promise<boolean>;
  onVideo: (slot: SlotView, creationId: string | null) => void;
  onSlotAction: (slot: SlotView, action: "pause" | "resume" | "cancel") => void;
  onStartNow: (slot: SlotView) => void;
  onRetry: (jobId: string) => Promise<void>;
  onConfirm: (jobId: string) => void;
}) {
  const draft = view.status === "DRAFT";
  const [date, setDate] = useState(slot.localDate);
  const [time, setTime] = useState(slot.localTime);
  const [editing, setEditing] = useState(false);

  // The server's copy is the truth: when it changes (a poll, a redraw), the inputs follow it.
  const [seen, setSeen] = useState(`${slot.localDate} ${slot.localTime}`);
  if (seen !== `${slot.localDate} ${slot.localTime}`) {
    setSeen(`${slot.localDate} ${slot.localTime}`);
    setDate(slot.localDate);
    setTime(slot.localTime);
  }

  const changed = date !== slot.localDate || time !== slot.localTime;
  const errors = slot.issues.filter((i) => i.severity === "error");
  const warnings = slot.issues.filter((i) => i.severity === "warning");
  const options = slot.creation ? [slot.creation, ...candidates.filter((c) => c.id !== slot.creation!.id)] : candidates;
  const live = slot.status === "ACTIVE" || slot.status === "PAUSED";
  const startable = slotStartable(slot, draft, view.status === "ACTIVE");
  const label = view.windows[slot.position - 1];

  return (
    <li
      data-slot={slot.id}
      data-slot-status={slot.status}
      className="rounded-lg border p-3"
      style={{ borderColor: errors.length ? "color-mix(in srgb, var(--rose) 45%, transparent)" : "var(--line)", opacity: slot.status === "CANCELLED" || slot.status === "SKIPPED" ? 0.6 : 1 }}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2.5">
        {/* when */}
        <div className="w-[190px] flex-none">
          <div className={`${mono} text-[11px]`} style={{ color: "var(--mute-2)" }}>
            slot {slot.position}{label ? ` · ${label.start}–${label.end}` : ""}
          </div>
          {draft || editing ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <ScheduleDatePicker value={date} onChange={setDate} label="Date" timezone={view.timezone} disabled={busy} />
              <ScheduleTimePicker value={time} onChange={setTime} label="Time" timezone={view.timezone} disabled={busy} />
              {(changed || editing) && (
                <>
                  <button
                    type="button"
                    disabled={busy || !changed}
                    onClick={async () => {
                      if (await onMove(slot, date, time)) setEditing(false);
                    }}
                    className={`rounded-md border px-2 py-1 ${mono} text-[11px] disabled:opacity-40`}
                    style={{ borderColor: "var(--amber)", color: "var(--amber)" }}
                  >
                    {draft ? "Save time" : "Move"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDate(slot.localDate);
                      setTime(slot.localTime);
                      setEditing(false);
                    }}
                    className={`${mono} text-[11px] underline underline-offset-4`}
                    style={{ color: "var(--mute-2)" }}
                  >
                    Undo
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="mt-0.5">
              <span className={`${mono} text-[15px] font-semibold tabular-nums`} style={{ color: "var(--ink)" }} data-slot-time>
                {slot.localTime}
              </span>{" "}
              <span className={`${mono} text-[11px]`} style={{ color: "var(--mute-2)" }}>{slot.localDate} {zoneLabel(view.timezone)}</span>
            </div>
          )}
        </div>

        {/* what */}
        <div className="min-w-[200px] flex-1">
          {draft ? (
            <select
              value={slot.creation?.id ?? ""}
              onChange={(e) => onVideo(slot, e.target.value || null)}
              aria-label="Video"
              disabled={busy}
              className={`${fieldClass} w-full`}
              style={FIELD}
            >
              <option value="">(empty: skipped)</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {("title" in c ? c.title : "").slice(0, 60)} · {c.repo}
                </option>
              ))}
            </select>
          ) : slot.creation ? (
            <div className={`${mono} text-[12.5px]`} style={{ color: "var(--ink)" }}>{slot.creation.title}</div>
          ) : (
            <div className={`${mono} text-[12.5px]`} style={{ color: "var(--mute-2)" }}>No video</div>
          )}
          {slot.creation && (
            <div className={`mt-0.5 ${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>
              {slot.creation.repo} · {slot.creation.format === "vertical" ? "9:16" : "16:9"}
              {!slot.creation.hasPlatformCopy && " · generic copy"}
              {!slot.creation.hasThumbnail && " · no thumbnail"}
            </div>
          )}
        </div>

        {/* where, and what became of it */}
        {slot.creation && (
          <div className="flex min-w-0 w-full flex-[2] flex-wrap gap-3 sm:min-w-[320px]">
            <JobCell platform="YouTube" job={slot.jobs.youtube} slot={slot} timezone={view.timezone} busy={busy} retryAllowed={view.status === "ACTIVE"} onRetry={onRetry} onConfirm={onConfirm} />
            <JobCell platform="Instagram" job={slot.jobs.instagram} slot={slot} timezone={view.timezone} busy={busy} enabled={view.instagramEnabled} retryAllowed={view.status === "ACTIVE"} onRetry={onRetry} onConfirm={onConfirm} />
          </div>
        )}

        {/* what can be done to this one post */}
        {!draft && live && (
          <div className="flex flex-wrap items-center gap-2">
            {!editing && (
              <button
                type="button"
                disabled={busy || slot.jobs.youtube?.status === "PLATFORM_SCHEDULED"}
                onClick={() => setEditing(true)}
                className={`rounded-md border px-2 py-1 ${mono} text-[11px] disabled:opacity-40`}
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                title={slot.jobs.youtube?.status === "PLATFORM_SCHEDULED" ? "YouTube already holds this video's schedule. Change or delete it in YouTube Studio; moving it only here would leave the two at different times." : undefined}
              >
                Reschedule
              </button>
            )}
            {slot.status === "ACTIVE" && view.status === "ACTIVE" && (
              <button type="button" disabled={busy} onClick={() => onSlotAction(slot, "pause")} className={`${mono} text-[11px] underline underline-offset-4`} style={{ color: "var(--mute-2)" }}>
                Pause
              </button>
            )}
            {slot.status === "PAUSED" && view.status === "ACTIVE" && (
              <button type="button" disabled={busy} onClick={() => onSlotAction(slot, "resume")} className={`${mono} text-[11px] underline underline-offset-4`} style={{ color: "var(--cyan)" }}>
                Resume
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => onSlotAction(slot, "cancel")} className={`${mono} text-[11px] underline underline-offset-4`} style={{ color: "var(--rose)" }}>
              Cancel
            </button>
          </div>
        )}
        {!draft && slot.status === "CANCELLED" && slot.creation && (
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className={`rounded-md border px-2 py-1 ${mono} text-[11px] disabled:opacity-40`} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            Bring back at a new time
          </button>
        )}
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="mt-2 space-y-0.5">
          {errors.map((i, n) => (
            <li key={`e${n}`} className={`${mono} text-[11px]`} style={{ color: "var(--rose)" }}>{i.message}</li>
          ))}
          {warnings.map((i, n) => (
            <li key={`w${n}`} className={`${mono} text-[11px]`} style={{ color: "var(--amber)" }}>{i.message}</li>
          ))}
        </ul>
      )}

      {startable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onStartNow(slot)}
            data-start-now
            className={`rounded-md border px-2.5 py-1 ${mono} text-[11px] font-semibold disabled:opacity-40`}
            style={{ borderColor: "var(--amber)", color: "var(--amber)" }}
            title="Move this post to the soonest valid time and start it. YouTube and Instagram are checked for an existing post first, so nothing is published twice; a platform already posted or scheduled is left as it is."
          >
            {busy ? "Starting…" : "OK, Start Now"}
          </button>
          <span className={`${mono} text-[10.5px]`} style={{ color: "var(--mute-2)" }}>
            re-arms at a valid future time; already-done platforms are left as they are
          </span>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------- new schedule -- */

export function NewSchedule({ busy, onCreate }: { busy: boolean; onCreate: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(() => addDays(todayIn(DEFAULT_TIMEZONE), 1));
  const [days, setDays] = useState(7);
  const [windows, setWindows] = useState(() => DEFAULT_WINDOWS.map((w) => ({ ...w })));
  const [endInclusive, setEndInclusive] = useState(false);
  const [privacy, setPrivacy] = useState("public");
  const [offset, setOffset] = useState(0);
  const [seed, setSeed] = useState("");
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    // Session-only configuration; no account credentials or media are stored here.
    let saved: Record<string, unknown> = {};
    try { saved = JSON.parse(sessionStorage.getItem("bookreel.schedule-form") ?? "{}"); } catch { /* defaults */ }
    Promise.resolve().then(() => {
      if (typeof saved.name === "string") setName(saved.name);
      if (typeof saved.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.startDate)) setStartDate(saved.startDate);
      if (typeof saved.days === "number" && saved.days >= 1 && saved.days <= 31) setDays(saved.days);
      if (Array.isArray(saved.windows) && saved.windows.length === 3 && saved.windows.every(w => w && typeof w.start === "string" && typeof w.end === "string")) setWindows(saved.windows);
      if (typeof saved.endInclusive === "boolean") setEndInclusive(saved.endInclusive);
      if (["public","unlisted","private"].includes(String(saved.privacy))) setPrivacy(String(saved.privacy));
      if (typeof saved.offset === "number") setOffset(saved.offset);
      if (typeof saved.seed === "string") setSeed(saved.seed);
      setRestored(true);
    });
  }, []);
  useEffect(() => {
    if (!restored) return;
    try { sessionStorage.setItem("bookreel.schedule-form", JSON.stringify({name,startDate,days,windows,endInclusive,privacy,offset,seed})); } catch { /* storage may be unavailable */ }
  }, [restored,name,startDate,days,windows,endInclusive,privacy,offset,seed]);

  return (
    <div className="space-y-3 rounded-lg border p-3.5" style={{ borderColor: "var(--line)" }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1">
          <span className="eyebrow">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Week of ${startDate}`} className={`${fieldClass} w-full`} style={FIELD} />
        </label>
        <label className="space-y-1">
          <span className="eyebrow">First day ({zoneLabel(DEFAULT_TIMEZONE)})</span>
          <ScheduleDatePicker value={startDate} onChange={setStartDate} label={`First day (${zoneLabel(DEFAULT_TIMEZONE)})`} disabled={busy} className="w-full" />
        </label>
        <label className="space-y-1">
          <span className="eyebrow">Days</span>
          <input type="number" min={1} max={31} value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${fieldClass} w-full`} style={FIELD} />
        </label>
        <label className="space-y-1">
          <span className="eyebrow">YouTube visibility</span>
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} className={`${fieldClass} w-full`} style={FIELD}>
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
          <span className={`block ${mono} text-[10.5px] leading-snug`} style={{ color: "var(--mute-2)" }} data-visibility-hint>
            {privacy === "public" ? "YouTube schedules each video and publishes it at its time." : "YouTube cannot schedule this: each video is uploaded at its time."}
          </span>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {windows.map((w, i) => (
          <div key={i} className="space-y-1">
            <span className="eyebrow">Slot {i + 1} window</span>
            <div className="flex items-center gap-1.5">
              <ScheduleTimePicker value={w.start} onChange={(value) => setWindows(windows.map((x, j) => (j === i ? { ...x, start: value } : x)))} label={`Slot ${i + 1} start`} disabled={busy} className="min-w-0 flex-1" />
              <span className={`${mono} text-[11px]`} style={{ color: "var(--mute-2)" }}>to</span>
              <ScheduleTimePicker value={w.end} onChange={(value) => setWindows(windows.map((x, j) => (j === i ? { ...x, end: value } : x)))} label={`Slot ${i + 1} end`} disabled={busy} className="min-w-0 flex-1" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1">
          <span className="eyebrow">Instagram after YouTube (min)</span>
          <input type="number" min={0} max={180} value={offset} onChange={(e) => setOffset(Number(e.target.value))} className={`${fieldClass} w-24`} style={FIELD} />
        </label>
        <label className="space-y-1">
          <span className="eyebrow">Seed (optional)</span>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" className={`${fieldClass} w-28`} style={FIELD} />
        </label>
        <label className="flex items-center gap-2 pb-1.5">
          <input type="checkbox" checked={endInclusive} onChange={(e) => setEndInclusive(e.target.checked)} />
          <span className={`${mono} text-[11.5px]`} style={{ color: "var(--mute)" }}>A window&apos;s end minute can be chosen</span>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => onCreate({ name, startDate, days, windows, endInclusive, youtubePrivacy: privacy, instagramOffsetMinutes: offset,
      ...(seed.trim() ? { seed: Number(seed) } : {}) })}
          className={`rounded-lg px-4 py-2 ${mono} text-[12.5px] font-semibold disabled:opacity-40`}
          style={{ background: "var(--amber)", color: "var(--on-accent)" }}
        >
          {busy ? "Working…" : "Draw the week"}
        </button>
      </div>
      <p className={`${mono} text-[11px] leading-relaxed`} style={{ color: "var(--mute-2)" }}>
        This only makes a draft to read and edit. Nothing can publish until you activate it. It uses the videos you have ticked in
        Generated Videos below, in the order you ticked them — the first fills Day&nbsp;1 Slot&nbsp;1, the next Slot&nbsp;2, and so on;
        only those, and nothing is chosen for you. Any that cannot be scheduled are named afterwards, not replaced. Tick your videos
        first; you can still swap a slot below.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- board -- */

function Board() {
  const toast = useToast();
  const [list, setList] = useState<ListedSchedule[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const selectedRef = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ScheduleView | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [refused, setRefused] = useState<Issue[]>([]);
  /** What the server said about the videos when the week was last drawn: which were placed, which were left out and why. */
  const [drawNotes, setDrawNotes] = useState<string[]>([]);
  const [settings, setSettings] = useState<{ name: string; privacy: string; offset: number } | null>(null);
  const [seedText, setSeedText] = useState("");
  const inFlight = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const retryableJobs = view?.status === "ACTIVE"
    ? view.slots.filter(s => s.status === "ACTIVE").flatMap(s => Object.values(s.jobs)).filter(j => j && scheduleRetryCandidate(j)).length
    : 0;

  useEffect(() => { selectedRef.current = selected; if(selected)try{sessionStorage.setItem("bookreel.schedule-selected",selected);}catch{} }, [selected]);

  const loadList = useCallback(async () => {
    const r = await api("/api/schedule-board");
    if (r.ok) { setList((r.data.schedules as ListedSchedule[]) ?? []); setLoadError(""); }
    else setLoadError(String(r.data.error ?? "Schedules could not be loaded."));
  }, []);

  const loadView = useCallback(async (id: string) => {
    const r = await api(`/api/schedule-board/${id}`);
    if (selectedRef.current !== id) return;
    if (r.ok) { setView(r.data.schedule as ScheduleView); setLoadError(""); }
    else { setLoadError(String(r.data.error ?? "The schedule could not be loaded.")); if(r.status === 404)setView(null); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api("/api/schedule-board");
      if (cancelled) return;
      const schedules = r.ok ? ((r.data.schedules as ListedSchedule[]) ?? []) : [];
      setList(schedules);
      if(!r.ok)setLoadError(String(r.data.error ?? "Schedules could not be loaded."));
      let remembered: string | null = null; try{remembered=sessionStorage.getItem("bookreel.schedule-selected");}catch{}
      // The newest one that is not cancelled, or simply the newest.
      setSelected((cur) => cur ?? schedules.find(s=>s.id===remembered)?.id ?? (schedules.find((s) => s.status !== "CANCELLED") ?? schedules[0])?.id ?? null);
      if (!schedules.length) setShowNew(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      const r = await api(`/api/schedule-board/${selected}`);
      if (cancelled) return;
      if(!r.ok){setLoadError(String(r.data.error ?? "The schedule could not be loaded."));return;}
      setLoadError("");
      const v = r.data.schedule as ScheduleView;
      setView(v);
      setSettings({ name: v.name, privacy: v.youtubePrivacy, offset: v.instagramOffsetMinutes });
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Only a schedule that is armed is worth asking about again: it is the one that changes by itself.
  const watching = view?.status === "ACTIVE" || view?.status === "PAUSED";
  useEffect(() => {
    if (!watching || !selected) return;
    const timer = setInterval(() => void loadView(selected), 5000);
    return () => clearInterval(timer);
  }, [watching, selected, loadView]);

  /** One action at a time: a second click while one is under way does nothing. */
  async function run(action: () => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>, done?: string | ((data: Record<string, unknown>) => string), after?: () => Promise<void>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setRefused([]);
    try {
      const r = await action();
      if (!r.ok) {
        toast.show(String(r.data.error ?? "That did not go through."), "error");
        setRefused(issuesOf(r.data));
        return false;
      }
      if (done) toast.show(typeof done === "function" ? done(r.data) : done);
      if (after) await after();
      return true;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const refresh = async () => {
    await loadList();
    if (selected) await loadView(selected);
  };

  async function retryPlatformJob(jobId: string) {
    if (!view || inFlight.current) return;
    await run(async () => {
      // Re-read this schedule before using the existing job-specific endpoint;
      // a poll or automatic confirmation may have completed this job meanwhile.
      const response = await api(`/api/schedule-board/${view.id}`);
      if (!response.ok) return response;
      const latest = response.data.schedule as ScheduleView | undefined;
      const slot = latest?.slots.find(s => Object.values(s.jobs).some(j => j?.id === jobId));
      const job = slot && Object.values(slot.jobs).find(j => j?.id === jobId);
      if (!job) return { ok: false, status: 404, data: { error: "This job is no longer in the schedule. Refresh before retrying." } };
      if (job.status === "PLATFORM_SCHEDULED" || job.status === "POSTED" || job.platformPublishAt) {
        return { ok: true, status: 200, data: { alreadyDone: true } };
      }
      if (latest?.status !== "ACTIVE" || slot?.status !== "ACTIVE" || !scheduleRetryCandidate(job)) {
        return { ok: false, status: 409, data: { error: "Only a failed or recovered job in an active schedule can be retried at its original future publication time." } };
      }
      return post(`/api/schedule-board/jobs/${job.id}/retry`);
    }, data => data.alreadyDone ? "This platform already has the post scheduled or published. Nothing was retried." : "Retry requested for this platform at its original publication time.", refresh);
  }

  async function retryFailed() {
    if (!view || inFlight.current) return;
    setRetrying(true);
    try {
      await run(async () => {
        const response = await post(`/api/schedule-board/${view.id}/retry`);
        if (response.ok) {
          setRefused(issuesOf(response.data));
          const d = response.data;
          toast.show(`${Number(d.started ?? 0)} retry requests accepted; ${Number(d.failed ?? 0)} refused or failed; ${Number(d.awaitingReview ?? 0)} need review; ${Number(d.skipped ?? 0)} skipped. Follow the platform statuses below for confirmed results.`,
            Number(d.failed ?? 0) > 0 ? "error" : Number(d.awaitingReview ?? 0) > 0 ? "warn" : "ok");
        }
        return response;
      }, undefined, refresh);
    } finally { setRetrying(false); }
  }

  /** The videos ticked in Generated Videos, in tick order — the source of truth for a draw. */
  function selectedIds(): string[] {
    try {
      return [...parseStored(window.sessionStorage.getItem(STORAGE_KEY))];
    } catch {
      return [];
    }
  }

  async function create(body: Record<string, unknown>) {
    const creationIds = selectedIds();
    let notes: string[] = [];
    const ok = await run(
      async () => {
        const r = await post("/api/schedule-board", { ...body, creationIds });
        if (r.ok && Array.isArray(r.data.warnings)) notes = r.data.warnings as string[];
        return r;
      },
      creationIds.length
        ? `Drew the week from your ${creationIds.length} selected video${creationIds.length === 1 ? "" : "s"}. Read it through before activating.`
        : "Drew the week. Read it through before activating.",
      async () => undefined,
    );
    if (!ok) return;
    setDrawNotes(notes);
    const r = await api("/api/schedule-board");
    const schedules = (r.data.schedules as ListedSchedule[]) ?? [];
    setList(schedules);
    if (schedules[0]) {
      setSelected(schedules[0].id);
      setShowNew(false);
    }
  }

  const slotsByDay = useMemo(() => {
    const days = new Map<number, SlotView[]>();
    for (const s of view?.slots ?? []) days.set(s.day, [...(days.get(s.day) ?? []), s]);
    return [...days.entries()].sort((a, b) => a[0] - b[0]);
  }, [view]);

  // What is in the way of this draft's videos, counted by kind.
  const conflictGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const s of view?.slots ?? []) for (const c of s.conflicts) groups.set(c.kind, (groups.get(c.kind) ?? 0) + 1);
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }, [view]);
  const unavailableGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const u of view?.unavailable ?? []) groups.set(u.kind, (groups.get(u.kind) ?? 0) + 1);
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }, [view]);

  const errors = (view?.issues ?? []).filter((i) => i.severity === "error");
  const warnings = (view?.issues ?? []).filter((i) => i.severity === "warning");
  const draft = view?.status === "DRAFT";

  function confirmActivate(v: ScheduleView): boolean {
    const lines = [
      'Activate "' + v.name + '"?',
      v.counts.withVideo + ' videos for YouTube' + (v.instagramEnabled ? ' and Instagram.' : '. Instagram execution is disabled.'),
      'YouTube target: ' + v.youtubeChannel + '. The active channel is verified before upload.',
      'YouTube visibility: ' + v.youtubePrivacy + '.',
      v.youtubeNative ? 'Videos upload now and YouTube publishes them at the saved future times. Change a confirmed schedule in YouTube Studio.' : 'Videos wait in the queue until their assigned times, then are saved with the chosen visibility.',
      v.instagramEnabled ? 'Instagram uploads ahead and must confirm each native schedule.' : 'Instagram settings are retained, but no Instagram upload will run.',
      'Keep this computer and BookReel running. Background queue processing is ' + (v.workerEnabled ? 'enabled.' : 'disabled; this click explicitly starts the current upload pass.'),
      'Nothing goes public before its time.'
    ];
    return window.confirm(lines.join("\n\n"));
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">BookReel · automatic publishing</div>
          <h1 className="font-display text-[30px] font-bold leading-none tracking-tight">Weekly schedule</h1>
          <p className="mt-2 max-w-2xl text-[13.5px]" style={{ color: "var(--mute)" }}>
            Three videos a day, with times drawn inside your windows. YouTube is ready to configure; Instagram publishing stays disabled until enabled. Every time is
            in {zoneLabel(DEFAULT_TIMEZONE)} ({DEFAULT_TIMEZONE}). Read the draft, edit what you like, then activate it.
          </p>
        </div>
        <Link href="/" className={`${mono} text-[12px] underline underline-offset-4`} style={{ color: "var(--mute-2)" }}>
          Back to the studio
        </Link>
      </header>

      {loadError && <section className="slab mb-4 p-4" role="alert">{loadError} <button type="button" className="underline" onClick={()=>{void loadList();if(selected)void loadView(selected);}}>Try again</button></section>}
      {/* ---- which schedule */}
      <section className="slab mb-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Schedule</span>
          <select
            value={selected ?? ""}
            onChange={(e) => {
              setSelected(e.target.value || null);
              setView(null);
              setRefused([]);
              setDrawNotes([]);
            }}
            aria-label="Schedule"
            className={`${fieldClass} min-w-[240px]`}
            style={FIELD}
          >
            {(list ?? []).length === 0 && <option value="">No schedules yet</option>}
            {(list ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.status.toLowerCase()} · {s.withVideo}/{s.slots} videos
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setShowNew((s) => !s)} className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px]`} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            {showNew ? "Close" : "New schedule"}
          </button>
        </div>
        {showNew && (
          <div className="mt-4">
            <NewSchedule busy={busy} onCreate={create} />
          </div>
        )}

        {drawNotes.length > 0 && (
          <div className="mt-4 space-y-1 rounded-lg border p-3" role="status" style={{ borderColor: "color-mix(in srgb, var(--amber) 40%, transparent)", background: "color-mix(in srgb, var(--amber) 7%, transparent)" }} data-draw-notes>
            <p className={`${mono} text-[11.5px] font-semibold`} style={{ color: "var(--amber)" }}>About the videos in this draw</p>
            {drawNotes.map((n, i) => (
              <p key={i} className={`${mono} text-[11px] leading-relaxed`} style={{ color: "var(--mute)" }}>{n}</p>
            ))}
          </div>
        )}
      </section>

      {!view && selected && (
        <p className={`${mono} text-[12.5px]`} style={{ color: "var(--mute-2)" }}>Loading…</p>
      )}
      {view && view.workflowVersion < 2 && view.status !== "DRAFT" && <p role="status" className="slab mb-4 p-4 text-[12px]" style={{color:"var(--amber)"}}>This historical plan is excluded from automatic processing. Review its existing platform results before creating or activating further posts; uncertain uploads are never repeated automatically.</p>}

      {view && (
        <>
          {/* ---- the schedule as a whole */}
          <section className="slab mb-5 space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="font-display text-[20px] font-semibold">{view.name}</span>
                <Chip label={view.status} tone={TONE[view.status] ?? "var(--mute)"} />
                <span className={`${mono} text-[11.5px]`} style={{ color: "var(--mute-2)" }} data-counts>
                  {view.counts.withVideo}/{view.counts.slots} videos · {view.counts.jobs} posts · {view.counts.posted} posted
                  {view.counts.scheduledOnPlatform ? ` · ${view.counts.scheduledOnPlatform} scheduled on platforms` : ""}
                  {view.counts.failed ? ` · ${view.counts.failed} failed` : ""}
                  {view.counts.waiting ? ` · ${view.counts.waiting} waiting` : ""}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {draft && (
                  <button
                    type="button"
                    disabled={busy || errors.length > 0 || conflictGroups.length > 0 || !view.counts.withVideo}
                    onClick={() => {
                      if (!confirmActivate(view)) return;
                      void run(() => post(`/api/schedule-board/${view.id}/activate`), "Activated. Follow each platform’s progress below.", refresh);
                    }}
                    className={`rounded-lg px-4 py-2 ${mono} text-[12.5px] font-semibold disabled:opacity-40`}
                    style={{ background: "var(--amber)", color: "var(--on-accent)" }}
                    title={errors.length ? "Fix the problems listed below first" : conflictGroups.length ? "Some of these videos already have a post: see the box below for how to clear them" : "Arms every post. Nothing publishes before its time."}
                  >
                    Activate
                  </button>
                )}
                {view.status === "ACTIVE" && (
                  <button type="button" disabled={busy || retrying} aria-busy={retrying} data-schedule-retry
                    onClick={() => void retryFailed()}
                    className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] font-semibold disabled:opacity-40`}
                    style={{ borderColor: "var(--amber)", color: "var(--amber)" }}
                    title={retryableJobs > 0
                      ? "Retry failed scheduling jobs at their original times. Existing uploads and schedules are checked first."
                      : "Check for safely retryable jobs. Scheduled, published, processing and approval-required jobs are skipped."}
                  >{retrying ? "Retrying…" : "Retry"}</button>
                )}
                {view.status === "ACTIVE" && (
                  <button type="button" disabled={busy} onClick={() => void run(() => post(`/api/schedule-board/${view.id}/pause`), "Paused. Nothing will start until you resume.", refresh)} className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                    Pause
                  </button>
                )}
                {view.status === "PAUSED" && (
                  <button type="button" disabled={busy} onClick={() => void run(() => post(`/api/schedule-board/${view.id}/resume`), "Resumed. A post whose time has passed is held, not published late.", refresh)} className={`rounded-lg px-3 py-1.5 ${mono} text-[12px] font-semibold disabled:opacity-40`} style={{ background: "var(--cyan)", color: "var(--on-accent)" }}>
                    Resume
                  </button>
                )}
                {(view.status === "ACTIVE" || view.status === "PAUSED") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm("Cancel this whole schedule? Posts that have not started are cancelled. One that is publishing right now is left to finish, and anything already posted stays posted.")) return;
                      void run(() => post(`/api/schedule-board/${view.id}/cancel`), cancelled, refresh);
                    }}
                    className={`${mono} text-[12px] underline underline-offset-4 disabled:opacity-40`}
                    style={{ color: "var(--rose)" }}
                  >
                    Cancel schedule
                  </button>
                )}
                {(draft || view.status === "CANCELLED") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Delete "${view.name}"?`)) return;
                      void run(() => api(`/api/schedule-board/${view.id}`, { method: "DELETE" }), "Deleted.", async () => {
                        setView(null);
                        const r = await api("/api/schedule-board");
                        const schedules = (r.data.schedules as ListedSchedule[]) ?? [];
                        setList(schedules);
                        setSelected(schedules[0]?.id ?? null);
                        if (!schedules.length) setShowNew(true);
                      });
                    }}
                    className={`${mono} text-[12px] underline underline-offset-4 disabled:opacity-40`}
                    style={{ color: "var(--mute-2)" }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            <div className={`grid gap-x-6 gap-y-1 ${mono} text-[11.5px] sm:grid-cols-2 lg:grid-cols-4`} style={{ color: "var(--mute)" }}>
              <div>zone: {view.timezone} ({zoneLabel(view.timezone)})</div>
              <div>YouTube: {view.youtubePrivacy}{view.youtubeNative ? " · scheduled by YouTube" : ""}</div>
              <div>
                {view.youtubeNative
                  ? `Public YouTube videos upload at activation. YouTube publishes at the future time only after confirming the native schedule.`
                  : `Private and unlisted videos wait for their assigned time before uploading. The background worker must be enabled to start them unattended.`}
              </div>
              <div>Instagram: {!view.instagramEnabled && "disabled · configured "}{view.instagramOffsetMinutes === 0 ? "with YouTube" : `${view.instagramOffsetMinutes} min after`}</div>
              <div>posts at least {view.minGapMinutes} min apart</div>
              <div>a post is held, not run late, after {view.missGraceMinutes} min</div>
              <div>browser profiles used before: YouTube {view.profiles.youtube ? "yes" : "NO"}, Instagram {view.profiles.instagram ? "yes" : "NO"}</div>
              <div>seed {view.seed}{view.endInclusive ? " · end minute allowed" : ""}</div>
            </div>

            {draft && settings && (
              <div className="flex flex-wrap items-end gap-4 border-t pt-3" style={{ borderColor: "var(--line)" }}>
                <label className="space-y-1">
                  <span className="eyebrow">Name</span>
                  <input value={settings.name} onChange={(e) => setSettings({ ...settings, name: e.target.value })} className={`${fieldClass} w-48`} style={FIELD} />
                </label>
                <label className="space-y-1">
                  <span className="eyebrow">YouTube visibility</span>
                  <select value={settings.privacy} onChange={(e) => setSettings({ ...settings, privacy: e.target.value })} className={fieldClass} style={FIELD}>
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="eyebrow">Instagram after (min)</span>
                  <input type="number" min={0} max={180} value={settings.offset} onChange={(e) => setSettings({ ...settings, offset: Number(e.target.value) })} className={`${fieldClass} w-20`} style={FIELD} />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => patch(`/api/schedule-board/${view.id}`, { name: settings.name, youtubePrivacy: settings.privacy, instagramOffsetMinutes: settings.offset }), "Saved.", refresh)}
                  className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`}
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                >
                  Save settings
                </button>
                <span className="flex items-end gap-2">
                  <input value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="seed (optional)" aria-label="Seed" className={`${fieldClass} w-32`} style={FIELD} />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm("Draw every time again? The times you have edited are replaced. The videos stay where they are.")) return;
                      void run(() => post(`/api/schedule-board/${view.id}/redraw`, seedText.trim() ? { seed: Number(seedText) } : {}), "Drew the times again.", refresh);
                    }}
                    className={`rounded-lg border px-3 py-1.5 ${mono} text-[12px] disabled:opacity-40`}
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  >
                    Draw the times again
                  </button>
                </span>
              </div>
            )}
          </section>

          {/* ---- what is wrong, and what to know, before anything is armed */}
          {(errors.length > 0 || warnings.length > 0 || refused.length > 0) && (
            <section className="slab mb-5 space-y-1.5 p-4" role="status" aria-label="Problems">
              {[...refused, ...errors].map((i, n) => (
                <p key={`e${n}`} className={`${mono} text-[12px]`} style={{ color: "var(--rose)" }}>{i.message}</p>
              ))}
              {warnings.filter((i) => i.key === "schedule").map((i, n) => (
                <p key={`w${n}`} className={`${mono} text-[12px]`} style={{ color: "var(--amber)" }}>{i.message}</p>
              ))}
            </section>
          )}

          {/* ---- posts that already exist for this draft's videos, and the safe ways past them */}
          {draft && conflictGroups.length > 0 && (
            <section className="slab mb-5 space-y-2 p-4" aria-label="Videos that already have a post" data-conflicts>
              <p className={`${mono} text-[12.5px] font-semibold`} style={{ color: "var(--amber)" }}>
                {conflictGroups.reduce((n, [, c]) => n + c, 0)} post{conflictGroups.reduce((n, [, c]) => n + c, 0) === 1 ? "" : "s"} already exist for videos in this draft, so it cannot be activated yet.
                Nothing has been cancelled or changed.
              </p>
              <ul className={`list-disc space-y-1 pl-5 ${mono} text-[11.5px] leading-relaxed`} style={{ color: "var(--mute)" }}>
                {conflictGroups.map(([kind, count]) => (
                  <li key={kind} data-conflict-kind={kind}>
                    {count} {CONFLICT_WORDS[kind] ?? kind}
                    {kind === "immediate-queued" && ": cancel them here, or on each video's card, then activate."}
                    {kind === "immediate-publishing" && ": let it finish, then put a different video in that slot."}
                    {kind === "waiting-on-you" && ": open the platform and check, then press \"I published it\" or cancel it on the video's card."}
                    {kind === "posted" && ": it is already on the platform; put a different video in that slot."}
                  </li>
                ))}
              </ul>
              {view.releasable > 0 && (
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="button"
                    disabled={busy}
                    data-release-queued
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Cancel ${view.releasable} queued post${view.releasable === 1 ? "" : "s"}?\n\n` +
                            `These are immediate posts that were queued for videos in this draft and have NOT started. Cancelling them lets the videos be scheduled for their dates instead.\n\n` +
                            `A post that is uploading right now, one waiting on you, one already published, and every post that belongs to a schedule is left exactly as it is.`,
                        )
                      )
                        return;
                      void run(
                        () => post(`/api/schedule-board/${view.id}/release-queued`, { confirmed: true }),
                        (d) => `Cancelled ${String(d.cancelled)} queued post${d.cancelled === 1 ? "" : "s"}.${Array.isArray(d.left) && d.left.length ? ` ${d.left.length} other post${d.left.length === 1 ? " is" : "s are"} still in the way: see the slots.` : ""}`,
                        refresh,
                      );
                    }}
                    className={`rounded-lg border px-3.5 py-1.5 ${mono} text-[12px] disabled:opacity-40`}
                    style={{ borderColor: "var(--amber)", color: "var(--ink)" }}
                  >
                    Cancel the {view.releasable} queued post{view.releasable === 1 ? "" : "s"}
                  </button>
                  <span className={`${mono} text-[11px]`} style={{ color: "var(--mute-2)" }}>Only posts that have not started. Nothing else is touched.</span>
                </div>
              )}
            </section>
          )}

          {draft && view.unavailable.length > 0 && (
            <details className="slab mb-5 p-4" data-unavailable>
              <summary className={`cursor-pointer ${mono} text-[12px]`} style={{ color: "var(--mute)" }}>
                {view.unavailable.length} finished video{view.unavailable.length === 1 ? " is" : "s are"} not offered for this schedule
                {unavailableGroups.length ? ` (${unavailableGroups.map(([k, n]) => `${n} ${k === "in-schedule" ? "in another schedule" : (CONFLICT_WORDS[k] ?? k)}`).join("; ")})` : ""}
              </summary>
              <ul className="mt-3 max-h-[320px] space-y-2 overflow-y-auto">
                {view.unavailable.map((u) => (
                  <li key={u.id} className="min-w-0">
                    <div className="truncate text-[12.5px] font-semibold" title={u.title}>{u.title}</div>
                    <div className={`${mono} text-[11px] leading-snug`} style={{ color: "var(--mute-2)" }}>{u.message}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* ---- the week */}
          <section className="space-y-5" aria-label="The week">
            {slotsByDay.map(([day, slots]) => (
              <div key={day}>
                <h2 className={`mb-2 ${mono} text-[12px] font-semibold`} style={{ color: "var(--mute)" }}>
                  Day {day + 1} · {slots[0].localDate}
                </h2>
                <ul className="grid gap-2">
                  {slots.map((slot) => (
                    <SlotRow
                      key={slot.id}
                      slot={slot}
                      view={view}
                      candidates={view.candidates}
                      busy={busy}
                      onMove={(s, d, t) => run(() => patch(`/api/schedule-board/${view.id}/slots/${s.id}`, { localDate: d, localTime: t }), draft ? "Time saved." : "Moved.", refresh)}
                      onVideo={(s, id) => void run(() => patch(`/api/schedule-board/${view.id}/slots/${s.id}`, { creationId: id }), "Video changed.", refresh)}
                      onSlotAction={(s, action) => {
                        if (action === "cancel" && !window.confirm("Cancel this post, on both platforms?")) return;
                        void run(() => post(`/api/schedule-board/${view.id}/slots/${s.id}/${action}`), action === "pause" ? "Paused." : action === "resume" ? "Resumed." : cancelled, refresh);
                      }}
                      onStartNow={(s) => {
                        if (!window.confirm("Move this post to the soonest valid time and arm it now? It is never posted immediately and never at a past time. YouTube and Instagram are each checked for an existing post first, so nothing goes out twice.")) return;
                        void run(() => post(`/api/schedule-board/${view.id}/slots/${s.id}/start-now`), "Re-armed for a valid future time. A platform already posted or scheduled was left as it is.", refresh);
                      }}
                      onRetry={retryPlatformJob}
                      onConfirm={(jobId) => void run(() => post(`/api/schedule-board/jobs/${jobId}/confirm`), "Marked as posted.", refresh)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section className="slab mt-6 p-4 sm:p-5">
            <div className="eyebrow mb-2">what this needs to publish unattended</div>
            <ul className={`list-disc space-y-1 pl-5 ${mono} text-[11.5px] leading-relaxed`} style={{ color: "var(--mute)" }}>
              <li>Keep this computer awake and the BookReel server running at the upload start times shown above. Once a platform confirms a native schedule, it handles publication. Closing this page changes nothing.</li>
              <li>YouTube needs BookReel’s connected API account or signed-in Chrome profile. Browser uploads open a window for several minutes; leave it alone.</li>
              <li>A post whose time passed while the server was off is held, never published in a burst. You will see it here as Missed.</li>
              <li>Queued means waiting to start. Scheduled on a platform requires its confirmation; it does not claim that publication has already happened.</li>
              <li>Instagram execution remains disabled until explicitly enabled. Its prepared browser workflow requires a verified BookReel account with native scheduling controls. A missing control, login or challenge holds the job for review.</li>
              <li>Only BookReel’s credentials and browser profiles are used. Historical jobs with uncertain outcomes are held for inspection, never blindly uploaded again.</li>
            </ul>
          </section>
        </>
      )}

      <section className="slab mt-5 p-4 text-[12px]" aria-label="Publishing readiness"><p>YouTube target: {view?.youtubeChannel ?? "BookReel’s configured channel"}. The account is verified before any file is uploaded.</p><p className="mt-1">{view?.instagramEnabled ? "Instagram execution is enabled by configuration." : "Instagram publishing is disabled until explicitly enabled. Its settings do not block YouTube."}</p><p className="mt-1">{view?.workerEnabled ? "Background queue processing is enabled." : "Background publishing is disabled. Drafts do not upload anything. Activate is an explicit request to start uploads; queued work needs this server running."}</p>{view && <p className="mt-1" style={{color:"var(--amber)"}}>BookReel reviews the video’s audience before upload. Child-directed or uncertain content needs human review; a general-audience result is required before selecting Not made for kids.</p>}</section>
      {/* ---- videos that are already made: pick some and publish them now, apart from the schedule */}
      <GeneratedVideos onToast={toast.show} />
    </div>
  );
}

export default function ScheduleBoard() {
  return (
    <div data-weekly-page><ToastHost>
      <Board />
    </ToastHost></div>
  );
}
