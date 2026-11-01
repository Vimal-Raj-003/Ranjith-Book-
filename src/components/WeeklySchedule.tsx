"use client";

import { useEffect, useId, useState } from "react";
import { strings } from "@/lib/strings";
import { DEFAULT_WINDOWS, validateWindows, type TimeWindow } from "@/lib/schedule/plan";
import {
  DEFAULT_TIMEZONE,
  MAX_DAYS,
  MAX_SLOTS_PER_DAY,
  addDays,
  configProblem,
  expandSchedule,
  formatInZone,
  isTimeHHmm,
  normaliseSlots,
  scheduleCapacity,
  wallClock,
} from "@/lib/schedule/time";
import {
  SCHEDULE_LEAD_MINUTES,
  SCHEDULE_PLATFORMS,
  type SaveDraftBody,
  type SchedulePlatform,
  type ScheduleView,
  type SlotView,
} from "@/lib/schedule/view";
import { Badge, Dialog, EmptyState, Hint, type BadgeTone } from "./ui";
import { useToast } from "./Toast";

/**
 * The Weekly Schedule: a button in the Book PDFs header and the panel it opens,
 * for putting a book's finished videos on YouTube across a week.
 *
 * WHAT IT IS AND IS NOT. It PLANS and it ASKS. The plan (a week, daily times, which
 * videos) is saved on the server, which works out the exact time of every slot; the
 * ask is Activate, which makes the server upload each video through the same
 * browser-window route a single Publish does. Nothing on this page ever says a video
 * is scheduled because a request succeeded: a slot reads "Scheduled" only when the
 * server reports it, and the server writes that only after YouTube Studio's own page
 * read the time back.
 *
 * THE RULES IT IS WRITTEN TO:
 *
 *  1. THE PREVIEW IS THE PLAN. It runs `expandSchedule` -- the function the server
 *     runs -- on what is on screen, so the time shown for a video is the time that
 *     is saved. All times are Asia/Kolkata and say so.
 *  2. NOTHING IS DECLARED OR CONFIRMED FOR THE OPERATOR. "Made for kids" has no
 *     default and Activate stays inert until it is answered (for YouTube). Activate
 *     is the one go-live confirmation, and the copy beside it says what it does.
 *  3. HONEST ABOUT THE COST. It publishes now or at the slot time, one video at a
 *     time, through the signed-in Chrome on this computer, and a run takes minutes
 *     per video.
 *  4. A STOP IS SHOWN AS ONE. A video that needs attention shows the server's
 *     sentence verbatim, and the videos behind it stay "Waiting"; Run again picks up
 *     where it stopped and never publishes a video twice.
 *  5. HONEST ABOUT INSTAGRAM. You may pick YouTube, Instagram, or both. YouTube is
 *     genuinely scheduled: uploaded now, held by YouTube, confirmed by its page.
 *     Instagram CANNOT be scheduled, and this panel does not pretend it can -- it
 *     says so, and an Instagram video is posted BY THIS APP at its slot time, which
 *     is why the computer must stay on and signed in.
 */

/** A video the panel may offer: `ready` is `publishEnabled` (DONE with a file), decided by the caller. */
export interface ScheduleVideo {
  id: string;
  title: string | null;
  ready: boolean;
}

const POLL_MS = 3000;

/** Only an https URL may become an href. The same guard the Publish panel uses. */
function safeHref(href: string | null | undefined): string | null {
  return typeof href === "string" && /^https:\/\//i.test(href) ? href : null;
}

const SLOT_TONE: Record<string, BadgeTone> = {
  pending: "plain",
  scheduling: "live",
  scheduled: "done",
  published: "done",
  failed: "failed",
  skipped: "plain",
};

const PLATFORM_LABEL: Record<SchedulePlatform, string> = {
  youtube: strings.schedule.platformYouTube,
  instagram: strings.schedule.platformInstagram,
};

/** The header button, and the dialog it opens. The panel is mounted only while it is open. */
export default function WeeklySchedule({ uploadId, videos }: { uploadId: string; videos: ScheduleVideo[] }) {
  const c = strings.schedule;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={c.buttonLabel}
        title={c.buttonLabel}
        className="rounded-lg border px-3.5 py-1.5 text-[13px] font-semibold transition-colors hover:bg-[color-mix(in_srgb,var(--cyan)_14%,transparent)]"
        style={{ borderColor: "var(--cyan)", color: "var(--cyan)", background: "transparent" }}
      >
        {c.button}
      </button>
      {open && (
        <Dialog title={c.title} closeLabel={c.close} onClose={() => setOpen(false)}>
          <SchedulePanel uploadId={uploadId} videos={videos} />
        </Dialog>
      )}
    </>
  );
}

/** One request to the schedule routes: the schedule it answers with, or an Error carrying the server's sentence. */
async function send(url: string, init: RequestInit, fallback: string): Promise<ScheduleView | null> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => null)) as { schedule?: ScheduleView | null; error?: string } | null;
  if (!res.ok || !body) throw new Error(typeof body?.error === "string" ? body.error : fallback);
  return body.schedule ?? null;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

interface FormState {
  weekStart: string;
  days: number;
  times: string[];
  platforms: ReadonlySet<SchedulePlatform>;
  kids: "yes" | "no" | null;
  picked: ReadonlySet<string>;
  mode: "plan" | "status";
}

const DEFAULT_DAYS = 7;
const DEFAULT_TIMES = ["09:00"];
const DEFAULT_PLATFORMS: ReadonlySet<SchedulePlatform> = new Set(["youtube"]);

/**
 * What the form shows for a schedule the server holds (or none): a draft refills it, an active
 * schedule opens on its status, and nothing at all starts from tomorrow, a week of one time a day,
 * with the first finished videos that fit ticked (a book with twenty would otherwise open on an
 * error). Tomorrow because today's slots are mostly inside YouTube's 15-minute floor.
 */
function formFor(s: ScheduleView | null, videos: ScheduleVideo[]): FormState {
  const ready = videos.filter((v) => v.ready);
  if (s && s.status === "draft") {
    const saved = new Set(s.slots.map((slot) => slot.episodeId));
    return {
      weekStart: s.weekStart,
      days: s.days,
      times: s.timeSlots,
      platforms: new Set(s.platforms.length ? s.platforms : ["youtube"]),
      kids: s.madeForKids === null ? null : s.madeForKids ? "yes" : "no",
      picked: new Set([...saved].filter(id => ready.some(v => v.id === id))),
      mode: "plan",
    };
  }
  return {
    weekStart: addDays(wallClock(new Date(), DEFAULT_TIMEZONE).date, 1),
    days: DEFAULT_DAYS,
    times: DEFAULT_TIMES,
    platforms: new Set(DEFAULT_PLATFORMS),
    // No default, on purpose: it is a declaration the operator makes.
    kids: null,
    picked: new Set(ready.slice(0, scheduleCapacity(DEFAULT_DAYS, DEFAULT_TIMES)).map((v) => v.id)),
    mode: s ? "status" : "plan",
  };
}

/**
 * `initial` skips the load: pass the schedule the caller already holds (or `null` for none) and the
 * panel opens on it. Left out, the panel asks the server for the book's schedule on open.
 */
export function SchedulePanel({
  uploadId,
  videos,
  initial,
}: {
  uploadId: string;
  videos: ScheduleVideo[];
  initial?: ScheduleView | null;
}) {
  const c = strings.schedule;
  const toast = useToast();
  const id = useId();

  const ready = videos.filter((v) => v.ready);

  const [seed] = useState(() => formFor(initial ?? null, videos));
  const [loaded, setLoaded] = useState(initial !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleView | null>(initial ?? null);
  const [mode, setMode] = useState(seed.mode);

  const [weekStart, setWeekStart] = useState(seed.weekStart);
  const [days, setDays] = useState(seed.days);
  const [times, setTimes] = useState<string[]>(seed.times);
  const [newTime, setNewTime] = useState("18:00");
  const [windows, setWindows] = useState<TimeWindow[] | undefined>(initial?.windows);
  const [planSeed, setPlanSeed] = useState(initial?.seed ?? 1);
  const [timezone, setTimezone] = useState(initial?.timezone ?? DEFAULT_TIMEZONE);
  const [instagramOffset, setInstagramOffset] = useState(initial?.instagramOffsetMinutes ?? 0);
  const [retryChecked, setRetryChecked] = useState(false);
  const [platforms, setPlatforms] = useState<ReadonlySet<SchedulePlatform>>(seed.platforms);
  const [kids, setKids] = useState(seed.kids);
  const [picked, setPicked] = useState(seed.picked);

  const [busy, setBusy] = useState<"save" | "activate" | "again" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Now" for the too-soon warning, refreshed so a panel left open does not keep calling a past slot fine.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Load what the server holds for this book: a draft refills the form, an active schedule shows its status.
  useEffect(() => {
    if (initial !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await send(`/api/schedules?uploadId=${encodeURIComponent(uploadId)}`, {}, c.loadError);
        if (cancelled || !s) return;
        const f = formFor(s, videos);
        setSchedule(s);
        setMode(f.mode);
        if (s.status === "draft") {
          setWeekStart(f.weekStart);
          setDays(f.days);
          setTimes(f.times);
          setWindows(s.windows);
          setPlanSeed(s.seed ?? 1);
          setTimezone(s.timezone);
          setInstagramOffset(s.instagramOffsetMinutes ?? 0);
          setPlatforms(f.platforms);
          setKids(f.kids);
          setPicked(f.picked);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : c.loadError);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once per open. `videos` is read for the draft's selection only; a poll that changes it must not refill the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId]);

  // While a run is going -- or while an Instagram slot is still waiting for its time, since the due-runner
  // posts it server-side and an open panel should show that happen -- ask the server how it is getting on.
  const working =
    schedule?.status === "active" &&
    (schedule.running ||
      schedule.slots.some((s) => s.status === "scheduling") ||
      schedule.slots.some((s) => s.status === "pending" && (s.platform === "youtube" || schedule.instagramEnabled)));
  useEffect(() => {
    if (!working) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const s = await send(`/api/schedules?uploadId=${encodeURIComponent(uploadId)}`, {}, c.loadError);
        if (!cancelled && s) setSchedule(s);
      } catch {
        // One dropped poll must not freeze the list; the next one asks again.
        if (!cancelled) setSchedule((prev) => (prev ? { ...prev } : prev));
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [working, schedule, uploadId, c.loadError]);

  // The preview is the plan: the same function the server runs, on what is on screen.
  const wantYouTube = platforms.has("youtube");
  const wantInstagram = platforms.has("instagram");
  const chosen = [...picked].map(id => ready.find(v => v.id === id)).filter((v): v is ScheduleVideo => !!v);
  const planTimes = windows?.map(w => w.start) ?? times;
  const config = { weekStart, days, timeSlots: planTimes, timezone, windows, seed: planSeed };
  let problem = configProblem(config) || (windows ? validateWindows(windows, false).join(" ") : null);
  const room = problem ? 0 : scheduleCapacity(days, planTimes);
  const overflow = !problem && chosen.length > room;
  let rows: ReturnType<typeof expandSchedule> = [];
  try { if (!problem && !overflow && chosen.length) rows = expandSchedule(config, chosen.map(v => v.id)); }
  catch (error) { problem = error instanceof Error ? error.message : String(error); }
  // Only enabled platform lanes contribute lead-time errors.
  const tooSoon = wantYouTube && rows.some((r) => r.assignedAt.getTime() < now + SCHEDULE_LEAD_MINUTES * 60_000);
  const inPast = wantInstagram && schedule?.instagramEnabled === true && rows.some((r) => r.assignedAt.getTime() + instagramOffset * 60_000 < now + 20 * 60_000);
  const daily = normaliseSlots(planTimes);
  const titleOf = new Map(videos.map((v) => [v.id, v.title]));
  const fits = rows.length > 0;

  const canSave = fits && platforms.size > 0 && busy === null;
  const reason =
    !fits
      ? c.needFit
      : platforms.size === 0
        ? c.needPlatform
        : wantYouTube && kids === null
          ? c.needKids
          : tooSoon
            ? c.needLead
            : inPast
              ? c.needFuture
              : null;
  const canActivate = reason === null && busy === null;

  function toggle(videoId: string, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(videoId);
      else next.delete(videoId);
      return next;
    });
  }

  function togglePlatform(platform: SchedulePlatform, on: boolean) {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (on) next.add(platform);
      else next.delete(platform);
      return next;
    });
  }

  function moveVideo(videoId: string, delta: number) {
    const ids = [...picked];
    const index = ids.indexOf(videoId);
    if (index < 0 || index + delta < 0 || index + delta >= ids.length) return;
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    setPicked(new Set(ids));
  }

  function addTime() {
    if (!isTimeHHmm(newTime) || times.length >= MAX_SLOTS_PER_DAY) return;
    setTimes(normaliseSlots([...times, newTime]));
  }

  async function saveDraft(): Promise<ScheduleView | null> {
    const body: SaveDraftBody = {
      uploadId,
      weekStart,
      days,
      timeSlots: planTimes,
      timezone, windows, seed: planSeed, instagramOffsetMinutes: instagramOffset,
      platforms: SCHEDULE_PLATFORMS.filter((p) => platforms.has(p)),
      madeForKids: kids === null ? null : kids === "yes",
      videoIds: chosen.map((v) => v.id),
    };
    const s = await send("/api/schedules", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, c.saveError);
    if (s) setSchedule(s);
    return s;
  }

  async function onSave() {
    if (!canSave) return;
    setBusy("save");
    setError(null);
    try {
      await saveDraft();
      toast.show(c.saved, "ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : c.saveError);
    } finally {
      setBusy(null);
    }
  }

  /** Save what is on screen, then activate THAT: the schedule that goes live is the one the preview showed. */
  async function onActivate() {
    if (!canActivate) return;
    setBusy("activate");
    setError(null);
    try {
      const saved = await saveDraft();
      if (!saved) throw new Error(c.saveError);
      const active = await send(`/api/schedules/${encodeURIComponent(saved.id)}/activate`, { method: "POST" }, c.activateError);
      if (active) {
        setSchedule(active);
        setMode("status");
      }
      toast.show(c.activated, "ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : c.activateError);
    } finally {
      setBusy(null);
    }
  }

  async function onRunAgain() {
    if (!schedule || busy !== null) return;
    setBusy("again");
    setError(null);
    try {
      const active = await send(`/api/schedules/${encodeURIComponent(schedule.id)}/control`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "retry", acknowledgeRetry: retryChecked }) }, c.activateError);
      if (active) setSchedule(active);
      setRetryChecked(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : c.activateError);
    } finally {
      setBusy(null);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!schedule || busy) return;
    setBusy("again");
    try {
      const next = await send(`/api/schedules/${encodeURIComponent(schedule.id)}/control`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) }, c.activateError);
      if (next) setSchedule(next);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  }

  if (!loaded) return <EmptyState>{c.loading}</EmptyState>;

  const headerCopy = (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink)" }}>
        {c.intro}
      </p>
      <Hint>{c.chromeNote}</Hint>
    </div>
  );

  // The per-platform truth: YouTube is genuinely scheduled; Instagram is posted by this app at the slot time.
  const platformNotes = (set: ReadonlySet<SchedulePlatform>) => (
    <>
      {set.has("youtube") && <Hint>{c.youtubeNote}</Hint>}
      {set.has("instagram") && <Hint>{c.instagramNote}</Hint>}
    </>
  );

  const errorLine = (message: string | null) =>
    message ? (
      <p role="alert" className="text-[12.5px]" style={{ color: "var(--rose)" }}>
        {message}
      </p>
    ) : null;

  // ---------------------------------------------------------------- an activated schedule

  if (mode === "status" && schedule) {
    const doneCount = schedule.slots.filter((s) => s.status === "scheduled" || s.status === "published").length;
    // Run again re-runs the YouTube slots and re-arms the Instagram ticker, so it is offered only when a
    // YouTube slot can still make progress. An Instagram failure is retried from the video's own Publish
    // panel (the due-runner never re-runs a failed slot), and an Instagram slot still waiting for its time
    // is not stuck -- neither is a reason to offer a button that would do nothing for it.
    const canRunAgain = schedule.slots.some(
      (s) => (s.platform === "youtube" || schedule.instagramEnabled) && (s.status === "pending" || s.status === "failed"),
    );
    return (
      <div className="flex flex-col gap-3">
        {headerCopy}
        {platformNotes(new Set(schedule.platforms))}
        {schedule.platforms.includes("instagram") && !schedule.instagramEnabled && <Hint>Instagram execution is disabled. Its saved slots do not block YouTube.</Hint>}
        {!schedule.workerEnabled && <Hint>Background restart recovery is off. An explicitly started run can finish while this server stays open.</Hint>}
        {schedule.workflowVersion === 1 && <Hint>This historical plan will not run automatically. Review its existing platform posts before using Run again.</Hint>}
        <section aria-labelledby={`${id}-status`} className="flex flex-col gap-2">
          <h3 id={`${id}-status`} className="font-display text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
            {c.statusHeading}
          </h3>
          <p role="status" className="text-[12.5px]" style={{ color: "var(--mute)" }}>
            {schedule.running ? c.running : c.statusDone(doneCount, schedule.slots.length)}
          </p>
          <ul role="list" className="flex flex-col gap-1.5">
            {schedule.slots.map((slot) => (
              <SlotRow key={slot.id} slot={slot} timezone={schedule.timezone} now={now} />
            ))}
          </ul>
        </section>
        {errorLine(error)}
        <div className="flex flex-wrap items-center gap-2">
          {schedule.status === "active" && <button className="chip" disabled={busy !== null} onClick={() => void control("pause")}>Pause queue</button>}
          {schedule.status === "paused" && <button className="chip" disabled={busy !== null} onClick={() => void control("resume")}>Resume queue</button>}
          {schedule.status !== "cancelled" && <button className="chip" disabled={busy !== null} onClick={() => void control("cancel")}>Cancel remaining uploads</button>}
          <Hint>Pause and cancel stop further uploads. Videos already scheduled on a platform keep their publication times.</Hint>
          {canRunAgain && !schedule.running && (
            <>
              <label className="text-[12px]"><input type="checkbox" checked={retryChecked} onChange={e => setRetryChecked(e.target.checked)} /> I checked the platform for existing videos, drafts and schedules.</label>
              <button
                type="button"
                onClick={() => void onRunAgain()}
                disabled={busy !== null || !retryChecked || schedule.status === "cancelled"}
                className="rounded-lg px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
              >
                {busy === "again" ? c.activating : c.runAgain}
              </button>
              <Hint>{c.runAgainNote}</Hint>
            </>
          )}
          <button
            type="button"
            onClick={() => setMode("plan")}
            className="ml-auto rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {c.planAnother}
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- the plan

  return (
    <div className="flex flex-col gap-4">
      {headerCopy}
      {loadError && errorLine(loadError)}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="field-label">{c.platformsHeading}</legend>
        <div className="flex flex-wrap items-center gap-2">
          {SCHEDULE_PLATFORMS.map((p) => {
            const on = platforms.has(p);
            return (
              <label
                key={p}
                className="chip"
                style={{
                  width: "auto",
                  cursor: "pointer",
                  borderColor: on ? "var(--cyan)" : "var(--line)",
                  color: on ? "var(--cyan)" : "var(--mute)",
                }}
              >
                <input
                  type="checkbox"
                  className="mr-1.5"
                  checked={on}
                  onChange={(e) => togglePlatform(p, e.target.checked)}
                />
                {PLATFORM_LABEL[p]}
              </label>
            );
          })}
        </div>
        {platformNotes(platforms)}
      </fieldset>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}>
        <div>
          <label className="field-label" htmlFor={`${id}-start`}>
            {c.weekStart}
          </label>
          <input
            id={`${id}-start`}
            className="control"
            type="date"
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor={`${id}-days`}>
            {c.days}
          </label>
          <select id={`${id}-days`} className="control" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {Array.from({ length: MAX_DAYS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {c.daysOption(n)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="field-label">{c.timezone}</span>
          <input className="control" aria-label="Time zone" value={timezone} onChange={e => setTimezone(e.target.value)} />
          <span id={`${id}-tz`} className="sr-only">
            {c.timezoneNote}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[12.5px]"><input type="checkbox" checked={!!windows} onChange={e => setWindows(e.target.checked ? DEFAULT_WINDOWS.map(w => ({ ...w })) : undefined)} /> Vary the time within daily windows</label>
        {windows && <div className="flex flex-col gap-2">
          {windows.map((window, index) => <label key={index} className="flex items-center gap-2 text-[12px]">Window {index + 1}
            <input aria-label={`Window ${index + 1} start`} type="time" className="control" value={window.start} onChange={e => setWindows(windows.map((w, i) => i === index ? { ...w, start: e.target.value } : w))} />
            to <input aria-label={`Window ${index + 1} end`} type="time" className="control" value={window.end} onChange={e => setWindows(windows.map((w, i) => i === index ? { ...w, end: e.target.value } : w))} />
          </label>)}
          <label className="text-[12px]">Time variation seed <input type="number" value={planSeed} onChange={e => setPlanSeed(Number(e.target.value))} /></label>
          <Hint>The end of each window is excluded. The same seed preserves the previewed times.</Hint>
        </div>}
        {wantInstagram && <label className="text-[12px]">Instagram offset after YouTube (minutes) <input type="number" min={0} max={120} value={instagramOffset} onChange={e => setInstagramOffset(Number(e.target.value))} /></label>}
        <span className="field-label">{c.timesHeading}</span>
        <ul role="list" className="flex flex-wrap items-center gap-1.5">
          {times.map((t) => (
            <li key={t} className="chip" style={{ width: "auto" }}>
              <span className="font-mono">{t}</span>
              {times.length > 1 && (
                <button
                  type="button"
                  onClick={() => setTimes(times.filter((x) => x !== t))}
                  aria-label={c.removeTime(t)}
                  className="px-1 leading-none"
                  style={{ color: "var(--mute)" }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="control"
            style={{ width: "auto" }}
            type="time"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            aria-label={c.newTimeLabel}
          />
          <button
            type="button"
            className="chip"
            style={{ width: "auto" }}
            onClick={addTime}
            aria-disabled={!isTimeHHmm(newTime) || times.length >= MAX_SLOTS_PER_DAY ? "true" : undefined}
          >
            {c.addTime}
          </button>
        </div>
        <Hint>{c.timesNote}</Hint>
        <Hint>{c.timezoneNote}</Hint>
      </div>

      {wantYouTube && (
        <fieldset className="flex flex-col gap-1">
          <legend className="field-label">{c.kidsLegend}</legend>
          <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--ink)" }}>
            <input type="radio" name={`${id}-kids`} checked={kids === "no"} onChange={() => setKids("no")} />
            <span>{c.kidsNo}</span>
          </label>
          <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--ink)" }}>
            <input type="radio" name={`${id}-kids`} checked={kids === "yes"} onChange={() => setKids("yes")} />
            <span>{c.kidsYes}</span>
          </label>
          <Hint>{c.kidsNote}</Hint>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-1">
        <legend className="field-label">{c.videosHeading}</legend>
        {videos.length === 0 || ready.length === 0 ? (
          <EmptyState>{c.noVideos}</EmptyState>
        ) : (
          <>
            <p className="font-mono text-[11.5px]" style={{ color: "var(--mute)" }}>
              {c.videosNote(chosen.length, ready.length)}
              <span className="ml-2 inline-flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setPicked(new Set(ready.map((v) => v.id)))}
                  disabled={chosen.length === ready.length}
                  className="rounded border px-2 py-0.5 font-sans text-[11.5px] font-medium disabled:opacity-50"
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                >
                  {c.selectAll}
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  disabled={chosen.length === 0}
                  className="rounded border px-2 py-0.5 font-sans text-[11.5px] font-medium disabled:opacity-50"
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                >
                  {c.deselectAll}
                </button>
              </span>
            </p>
            <ul role="list" className="flex flex-col gap-1">
              {videos.map((v) => (
                <li key={v.id}>
                  <label className="flex items-center gap-2 text-[12.5px]" style={{ color: v.ready ? "var(--ink)" : "var(--mute)" }}>
                    <input
                      type="checkbox"
                      checked={v.ready && picked.has(v.id)}
                      disabled={!v.ready}
                      onChange={(e) => toggle(v.id, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1 truncate" title={v.title ?? undefined}>
                      {v.title ?? v.id}
                    </span>
                    {!v.ready && <Badge tone="plain">{c.notFinished}</Badge>}
                  </label>
                  {picked.has(v.id) && <span className="flex gap-2 text-[11px]">Order {[...picked].indexOf(v.id) + 1}
                    <button type="button" onClick={() => moveVideo(v.id, -1)} aria-label={`Move ${v.title ?? v.id} earlier`}>Move earlier</button>
                    <button type="button" onClick={() => moveVideo(v.id, 1)} aria-label={`Move ${v.title ?? v.id} later`}>Move later</button>
                  </span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </fieldset>

      <section aria-labelledby={`${id}-preview`} className="flex flex-col gap-1.5">
        <h3 id={`${id}-preview`} className="font-display text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
          {c.previewHeading}
        </h3>
        <Hint>{c.previewNote}</Hint>
        {problem ? (
          errorLine(problem)
        ) : overflow ? (
          errorLine(c.capacity(chosen.length, room))
        ) : !fits ? (
          <EmptyState>{c.previewEmpty}</EmptyState>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-left text-[12.5px]" style={{ color: "var(--ink)" }}>
              <thead>
                <tr style={{ color: "var(--mute-2)" }}>
                  <th className="py-1 pr-3 font-mono text-[11px] font-normal uppercase tracking-wider">{c.columns.order}</th>
                  <th className="py-1 pr-3 font-mono text-[11px] font-normal uppercase tracking-wider">{c.columns.video}</th>
                  <th className="py-1 pr-3 font-mono text-[11px] font-normal uppercase tracking-wider">{c.columns.slot}</th>
                  <th className="py-1 font-mono text-[11px] font-normal uppercase tracking-wider">{c.columns.live}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const soon = wantYouTube
                    ? r.assignedAt.getTime() < now + SCHEDULE_LEAD_MINUTES * 60_000
                    : r.assignedAt.getTime() < now;
                  return (
                    <tr key={r.episodeId} style={{ borderTop: "1px solid var(--line)" }}>
                      <td className="py-1.5 pr-3 font-mono">{r.position + 1}</td>
                      <td className="max-w-[28ch] truncate py-1.5 pr-3" title={titleOf.get(r.episodeId) ?? undefined}>
                        {titleOf.get(r.episodeId) ?? r.episodeId}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3" style={{ color: "var(--mute)" }}>
                        {c.slotLabel(Math.floor(r.position / daily.length) + 1, daily[r.position % daily.length])}
                      </td>
                      <td className="whitespace-nowrap py-1.5 font-mono" style={{ color: soon ? "var(--rose)" : "var(--ink)" }}>
                        {wantYouTube && <div>YouTube: {formatInZone(r.assignedAt, timezone)}</div>}
                        {wantInstagram && <div>Instagram: {formatInZone(new Date(r.assignedAt.getTime() + instagramOffset * 60_000), timezone)}</div>}
                        {soon && <span className="sr-only"> {wantYouTube ? c.tooSoon : c.needFuture}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {tooSoon && errorLine(c.tooSoon)}
        {inPast && errorLine(c.needFuture)}
      </section>

      {errorLine(error)}

      <div className="flex flex-col gap-2">
        <Hint>{c.activateNote}</Hint>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!canSave}
            className="rounded-lg border px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {busy === "save" ? c.saving : c.saveDraft}
          </button>
          <button
            type="button"
            onClick={() => void onActivate()}
            disabled={!canActivate}
            aria-describedby={reason ? `${id}-why` : undefined}
            className="rounded-lg px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
            style={{ background: "var(--cyan)", color: "var(--on-accent)" }}
          >
            {busy === "activate" ? c.activating : c.activate}
          </button>
          {schedule?.status === "active" && (
            <button
              type="button"
              onClick={() => setMode("status")}
              className="ml-auto rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}
            >
              {c.statusHeading}
            </button>
          )}
        </div>
        {reason && (
          <p id={`${id}-why`} className="text-[11.5px]" style={{ color: "var(--mute-2)" }}>
            {reason}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One video on one platform in an activated schedule: its platform, its time, the
 * server's status, and the sentence behind it. A video on both platforms is two
 * rows, each reading its own outcome, so an Instagram failure never hides a
 * YouTube success.
 */
function SlotRow({ slot, timezone }: { slot: SlotView; timezone: string; now: number }) {
  const c = strings.schedule;
  const ig = slot.platform === "instagram";
  const href = safeHref(slot.job?.externalUrl);
  // YouTube read a time back for a scheduled post; everywhere else, the time the slot is set to.
  const when = formatInZone(
    new Date(slot.status === "scheduled" && slot.job?.scheduledFor ? slot.job.scheduledFor : slot.assignedAt),
    timezone,
  );
  const statusLabel = c.status[slot.status] ?? slot.status;
  const showLink = Boolean(href) && (slot.status === "published" || slot.status === "scheduled");
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[11.5px]" style={{ color: "var(--mute)" }}>
          {slot.position + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: "var(--ink)" }} title={slot.title ?? undefined}>
          {slot.title ?? slot.episodeId}
        </span>
        <Badge tone="plain">{PLATFORM_LABEL[slot.platform]}</Badge>
        <span className="font-mono text-[12px]" style={{ color: "var(--mute)" }}>
          {when}
        </span>
        <Badge tone={SLOT_TONE[slot.status] ?? "plain"}>{statusLabel}</Badge>
      </div>
      {slot.note && (
        <p className="text-[12px] leading-snug" style={{ color: slot.status === "failed" ? "var(--rose)" : "var(--mute)" }}>
          {slot.note}
        </p>
      )}
      {slot.job?.progress && <p className="text-[12px]" style={{ color: "var(--mute)" }}>{slot.job.progress}</p>}
      {showLink && (
        <a className="text-[12px] underline" style={{ color: "var(--cyan)" }} href={href!} target="_blank" rel="noopener noreferrer">
          {ig ? c.openOnInstagram : c.openOnYouTube}
        </a>
      )}
    </li>
  );
}
