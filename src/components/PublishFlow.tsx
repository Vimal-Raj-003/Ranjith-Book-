"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Badge, Hint } from "./ui";
import { useToast } from "./Toast";
import { strings } from "@/lib/strings";
import {
  TARGETS_OF,
  canAsk,
  clockNow,
  earliestInput,
  governingSlot,
  localInputFor,
  offersSignIn,
  planTargets,
  reportFor,
  requestFor,
  resolveSchedule,
  safeHref,
  scheduleProblem,
  sectionStatus,
  triggerLabel,
  whenText,
  type ActionTargets,
  type PlanContext,
  type SlotLookup,
  type TargetPlan,
  type Visibility,
} from "@/lib/publish/flow";
import { PLATFORM_LABELS, type PlatformId } from "@/lib/publish/limits";
import type { PlatformState, PublishView } from "@/lib/publish/view";
import type { EpisodeSlotResponse } from "@/lib/schedule/view";

/**
 * The lower half of the Publish page, in the wireframe's order: the YouTube block, the
 * Instagram block, Visibility, Schedule, and the three publish buttons.
 *
 * It owns the CHOICES (visibility, a picked time, the kids answer, the "I looked" ticks) and
 * the one open confirmation; it owns no publish logic. What a press would do is decided by
 * `@/lib/publish/flow`, and what happened is whatever the platform's job row says. The
 * metadata editors inside the two blocks are handed in by `PublishCenter`, which keeps their
 * draft/save/rewrite plumbing exactly as it was.
 *
 * THE RULES IT IS WRITTEN TO:
 *
 *  1. NOTHING IS SENT WITHOUT OK. Every Publish button -- the two in the blocks and the three
 *     at the bottom -- only opens a confirmation that says what will happen; OK is the one
 *     press that sends. Anything that goes live (a public or scheduled YouTube post, every
 *     Instagram post) goes with `confirmPublic: true`, and only from that press.
 *  2. A SCHEDULE IS NEVER A SILENT "NOW". Choosing Instagram while a schedule is set says
 *     that Instagram cannot be scheduled and will post at once, in the confirmation itself.
 *  3. A VIDEO IN AN ACTIVATED WEEKLY SCHEDULE IS POSTED AT ITS SLOT'S TIME. The time is read
 *     from the schedule, shown locked, and sent as the server's own string. While that is
 *     being checked, or if the check failed, scheduling is off rather than guessed.
 *  4. NO DUPLICATE. A platform already posted, scheduled or in flight has nothing to send and
 *     says so; one that stopped for a person is retried only behind the operator's own tick.
 *  5. NO FAKE SUCCESS. The status shown is the job row's: "Posted" and "Scheduled" only with
 *     the platform's own id and time, "Needs you" for a stop, and a press that the server
 *     refused is shown as refused, in words, where the button is.
 *  6. THE CONNECTION IS NOT A SECTION. Sign-in is offered where it is needed -- on the result
 *     of a YouTube attempt that stopped for a sign-in -- and nowhere else.
 */

const f = strings.publishCenter.flow;

/** What the server said about the last press on a platform. Shown where the button is, until the next press. */
interface SentNote {
  tone: "ok" | "error";
  text: string;
}

type Anchor = PlatformId | "bottom";

/** The calendar glyph. Decorative: the button around it carries the name. */
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

// ------------------------------------------------------------------ the result of an attempt

/**
 * Open the one-time sign-in window (a plain Chrome on BookReel's own profile). The same POST the
 * browser card used to make: it sends the platform name and nothing else, receives a sentence back,
 * and never sees a password, a cookie or the profile.
 */
function SignIn({ platform }: { platform: PlatformId }) {
  const c = strings.publishCenter.browser;
  const toast = useToast();
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function open() {
    if (opening) return;
    setOpening(true);
    try {
      const res = await fetch("/api/publish/browser/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setNote(null);
        toast.show(typeof body.error === "string" ? body.error : c.signIn.failed, "error");
        return;
      }
      setNote(typeof body.message === "string" ? body.message : c.signIn.opened);
      toast.show(c.signIn.opened, "ok");
    } catch {
      toast.show(c.signIn.failed, "error");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="pub-actions">
        <button type="button" className="chip" aria-disabled={opening ? "true" : undefined} onClick={() => void open()}>
          <span className="truncate">{opening ? c.signIn.opening : c.signIn.button}</span>
        </button>
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      <Hint>{c.signIn.closeFirst}</Hint>
    </div>
  );
}

/**
 * Where one platform stands, from its job row and nothing else -- with the "I looked" tick a
 * retry needs and, for a YouTube stop that wants a sign-in, the Sign in button. Exported so a
 * test can render each state without a browser.
 */
export function PlatformReport({
  state,
  sent,
  looked,
  onLooked,
}: {
  state: PlatformState;
  sent: SentNote | null;
  looked: boolean;
  onLooked: (next: boolean) => void;
}) {
  const report = reportFor(state);
  const awaiting = state.status === "AWAITING_HUMAN" && !state.job?.externalId;
  const tickId = useId();

  return (
    <div className="flex flex-col gap-2" data-platform={state.platform}>
      {report && (
        <div
          className="pub-result"
          data-tone={report.tone}
          data-confirmed={report.confirmed ? "true" : "false"}
          role={report.needsHuman || report.tone === "failed" ? "alert" : "status"}
        >
          <p className="pub-result-head">{report.headline}</p>
          {report.detail && <p className="hint">{report.detail}</p>}
          {report.link && (
            <div className="pub-actions">
              <a className="chip" data-state="on" href={report.link.href} target="_blank" rel="noopener noreferrer">
                <span className="truncate">{report.link.label}</span>
              </a>
            </div>
          )}
        </div>
      )}

      {awaiting && (
        <label className="flex items-start gap-2 text-[12px]" htmlFor={tickId} style={{ color: "var(--ink)" }}>
          <input id={tickId} type="checkbox" checked={looked} onChange={(e) => onLooked(e.target.checked)} />
          <span>{strings.publishCenter.browser.ackLabel}</span>
        </label>
      )}

      {offersSignIn(state) && <SignIn platform={state.platform} />}

      {sent && (
        <p className="hint" role={sent.tone === "error" ? "alert" : "status"} style={sent.tone === "error" ? { color: "var(--rose)" } : undefined}>
          {sent.text}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the buttons and the confirmation

function Trigger({
  plans,
  busy,
  mode,
  children,
  ariaLabel,
  onPress,
  describedBy,
}: {
  plans: TargetPlan[];
  busy: boolean;
  mode: "publish" | "retry";
  children: ReactNode;
  ariaLabel: string;
  onPress: () => void;
  describedBy?: string;
}) {
  const enabled = canAsk(plans) && !busy;
  return (
    <button
      type="button"
      className="pub-primary"
      // Not `disabled`: a control that disables itself drops keyboard focus, and the reason it is
      // inert is a sentence right beside it, which a disabled button cannot be linked to.
      aria-disabled={enabled ? undefined : "true"}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      data-mode={mode}
      onClick={() => enabled && onPress()}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

/** Why a press does nothing yet, one line per platform that has a reason. */
function Reasons({ plans, id, named = false }: { plans: TargetPlan[]; id: string; named?: boolean }) {
  const lines = plans.filter((p) => p.note !== null);
  if (lines.length === 0) return null;
  return (
    <ul className="pub-reasons" id={id} role="list">
      {lines.map((p) => (
        <li key={p.platform} data-kind={p.kind}>
          {named && <strong>{p.label}: </strong>}
          {p.note}
        </li>
      ))}
    </ul>
  );
}

/** What OK will do. Anything that goes live is drawn in the warning style, like the browser card's. */
export function ConfirmPanel({
  plans,
  busy,
  onOk,
  onCancel,
}: {
  plans: TargetPlan[];
  busy: boolean;
  onOk: () => void;
  onCancel: () => void;
}) {
  const sending = plans.filter((p) => p.kind === "send");
  const live = sending.some((p) => p.goesLive);
  return (
    <div className={live ? "pub-problems" : "pub-confirm-box"} role="alertdialog" aria-label={f.confirmTitle(sending.map((p) => p.label))}>
      <p className="text-[12.5px] font-semibold" style={{ color: "var(--ink)" }}>
        {f.confirmTitle(sending.map((p) => p.label))}
      </p>
      <ul className="pub-reasons" role="list">
        {plans.map((p) =>
          p.kind === "send" ? (
            <li key={p.platform} data-kind="send">
              <strong>{p.label}.</strong> {p.lines.join(" ")}{" "}
              <span className="hint">{p.route === "api" ? f.routeApi(p.label) : f.routeBrowser(p.label)}</span>
            </li>
          ) : (
            <li key={p.platform} data-kind={p.kind}>
              {f.confirmSkipped(p.note ?? "")}
            </li>
          ),
        )}
      </ul>
      <div className="pub-actions">
        <button type="button" className="pub-primary" aria-disabled={busy ? "true" : undefined} onClick={() => !busy && onOk()}>
          <span className="truncate">{busy ? f.publishing : f.confirmOk}</span>
        </button>
        <button type="button" className="chip" aria-disabled={busy ? "true" : undefined} onClick={() => !busy && onCancel()}>
          <span className="truncate">{f.confirmCancel}</span>
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ visibility and schedule

/**
 * Visibility, platform by platform: YouTube's three, and Instagram's one. The YouTube select is
 * locked to "public at the scheduled time" while a schedule is set, because that is what a
 * schedule is; Instagram offers only Public because that is all it has.
 */
export function VisibilityBlock({
  visibility,
  scheduled,
  kids,
  kidsFromSchedule,
  onVisibility,
  onKids,
}: {
  visibility: Visibility;
  scheduled: boolean;
  kids: "yes" | "no" | null;
  kidsFromSchedule: boolean;
  onVisibility: (next: Visibility) => void;
  onKids: (next: "yes" | "no") => void;
}) {
  const id = useId();
  const c = strings.publishCenter.browser;
  return (
    <section className="pub-package" aria-labelledby={`${id}-h`}>
      <h4 id={`${id}-h`} className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
        {f.visibilityHeading}
      </h4>

      <div className="pub-pair">
        <label className="field-label" htmlFor={`${id}-yt`}>
          {f.visibilityYouTube}
        </label>
        <select
          id={`${id}-yt`}
          className="control"
          value={scheduled ? "public" : visibility}
          disabled={scheduled}
          aria-describedby={scheduled ? `${id}-locked` : undefined}
          onChange={(e) => onVisibility(e.target.value as Visibility)}
        >
          {scheduled ? (
            <option value="public">{f.visibilityScheduled}</option>
          ) : (
            <>
              <option value="private">{c.visibilityPrivate}</option>
              <option value="unlisted">{c.visibilityUnlisted}</option>
              <option value="public">{c.visibilityPublic}</option>
            </>
          )}
        </select>
      </div>
      {scheduled && <Hint id={`${id}-locked`}>{f.visibilityLockedBySchedule}</Hint>}

      <div className="pub-pair">
        <label className="field-label" htmlFor={`${id}-ig`}>
          {f.visibilityInstagram}
        </label>
        {/* One option, and inert: Instagram has nothing else to offer, and saying so beats hiding it. */}
        <select id={`${id}-ig`} className="control" value="public" disabled aria-describedby={`${id}-ignote`}>
          <option value="public">{f.igVisibilityValue}</option>
        </select>
      </div>
      <Hint id={`${id}-ignote`}>{f.igVisibilityNote}</Hint>

      {/* A legal declaration the operator makes -- never defaulted. YouTube's browser route cannot go without it. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="field-label">{c.kidsLegend}</legend>
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--ink)" }}>
          <input type="radio" name={`${id}-kids`} checked={kids === "no"} onChange={() => onKids("no")} />
          <span>{c.kidsNo}</span>
        </label>
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--ink)" }}>
          <input type="radio" name={`${id}-kids`} checked={kids === "yes"} onChange={() => onKids("yes")} />
          <span>{c.kidsYes}</span>
        </label>
        <Hint>{kidsFromSchedule ? f.kidsFromSchedule : c.kidsNote}</Hint>
      </fieldset>
    </section>
  );
}

/**
 * The schedule: a date-and-time field, the calendar beside it, and what the time means. The field
 * reads as India time on any computer, shows the exact moment it resolves to, and is locked to the
 * Weekly Schedule's slot when the video has one. Exported for tests.
 */
export function ScheduleBlock({
  picked,
  lookup,
  now,
  onPick,
  onRetryLookup,
}: {
  picked: string;
  lookup: SlotLookup;
  now: number;
  onPick: (next: string) => void;
  onRetryLookup: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const choice = resolveSchedule({ picked, lookup });
  const slot = governingSlot(lookup);
  const checking = lookup.state === "loading";
  const failed = lookup.state === "error";
  const locked = slot !== null;
  const off = locked || checking || failed;
  const problem = scheduleProblem(choice, now);
  const shown = choice.kind === "slot" ? localInputFor(choice.instant) : picked;

  function openCalendar() {
    const input = ref.current;
    if (!input || input.disabled) return;
    try {
      input.showPicker();
    } catch {
      // A browser without `showPicker`, or one that refuses it outside a gesture: the field itself still takes typing.
      input.focus();
    }
  }

  return (
    <section className="pub-package" aria-labelledby={`${id}-h`}>
      <h4 id={`${id}-h`} className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
        {f.scheduleHeading}
      </h4>

      <label className="field-label" htmlFor={`${id}-dt`}>
        {f.scheduleField}
      </label>
      <div className="pub-schedule-row">
        <input
          id={`${id}-dt`}
          ref={ref}
          className="control pub-datetime"
          type="datetime-local"
          value={shown}
          min={earliestInput(now)}
          disabled={off}
          aria-describedby={`${id}-zone`}
          onChange={(e) => onPick(e.target.value)}
        />
        <button
          type="button"
          className="chip pub-cal"
          aria-label={f.scheduleCalendar}
          title={f.scheduleCalendar}
          aria-disabled={off ? "true" : undefined}
          onClick={openCalendar}
        >
          <CalendarIcon />
        </button>
        {picked !== "" && !off && (
          <button type="button" className="chip" onClick={() => onPick("")}>
            <span className="truncate">{f.scheduleClear}</span>
          </button>
        )}
      </div>
      <Hint id={`${id}-zone`}>{f.scheduleZone}</Hint>

      {checking && (
        <p className="hint" role="status">
          {f.slotChecking}
        </p>
      )}
      {failed && (
        <div className="flex flex-col gap-1" role="alert">
          <Hint>{f.slotCheckFailed}</Hint>
          <div className="pub-actions">
            <button type="button" className="chip" onClick={onRetryLookup}>
              <span className="truncate">{f.slotRetry}</span>
            </button>
          </div>
        </div>
      )}
      {locked && choice.kind === "slot" && (
        <p className="hint" data-slot="locked">
          {f.slotLocked(whenText(choice.instant, choice.slot.timezone))}
        </p>
      )}
      {!locked && (choice.kind === "picked" || choice.kind === "slot") && !problem && (
        <p className="hint" role="status">
          {f.schedulePreview(whenText(choice.instant))}
        </p>
      )}
      {problem && (picked !== "" || locked) && (
        <p className="hint" role="alert" style={{ color: "var(--rose)" }}>
          {problem}
        </p>
      )}
      {choice.kind !== "none" && <Hint>{f.scheduleYouTubeOnly}</Hint>}
      {choice.kind === "none" && !off && <Hint>{f.scheduleOptional}</Hint>}
    </section>
  );
}

// ------------------------------------------------------------------ the block

/** One platform's block: its editors, its Publish button, its confirmation and its result. */
function PlatformBlock({
  state,
  heading,
  fields,
  plans,
  busy,
  sendingHere,
  confirmHere,
  confirmPlans,
  sent,
  looked,
  onLooked,
  onPress,
  onOk,
  onCancel,
}: {
  state: PlatformState;
  heading: string;
  fields: ReactNode;
  plans: TargetPlan[];
  /** Something is being sent: every button is inert. */
  busy: boolean;
  /** THIS platform is the one being sent. */
  sendingHere: boolean;
  confirmHere: boolean;
  confirmPlans: TargetPlan[];
  sent: SentNote | null;
  looked: boolean;
  onLooked: (next: boolean) => void;
  onPress: () => void;
  onOk: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const label = PLATFORM_LABELS[state.platform];
  const status = sectionStatus(state.status);
  const retry = state.status === "AWAITING_HUMAN";
  const reasonsId = `${id}-why`;

  return (
    <section className="pub-package" aria-labelledby={`${id}-h`} data-platform={state.platform}>
      <header className="pub-platform-head">
        <h4 id={`${id}-h`} className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
          {heading}
        </h4>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>

      {fields}

      <div className="pub-publish-row">
        <Trigger
          plans={plans}
          busy={busy}
          mode={retry ? "retry" : "publish"}
          ariaLabel={retry ? f.retryAria(label) : f.publishAria(label)}
          describedBy={plans.some((p) => p.note !== null) ? reasonsId : undefined}
          onPress={onPress}
        >
          {sendingHere ? f.publishing : retry ? f.retry : f.publish}
        </Trigger>
      </div>
      <Reasons plans={plans} id={reasonsId} />

      {confirmHere && <ConfirmPanel plans={confirmPlans} busy={busy} onOk={onOk} onCancel={onCancel} />}

      <PlatformReport state={state} sent={sent} looked={looked} onLooked={onLooked} />
    </section>
  );
}

export default function PublishFlow({
  view,
  episodeId,
  onView,
  youtubeFields,
  instagramFields,
}: {
  view: PublishView;
  episodeId: string;
  /** Hand the server's answer back, so the page repaints from one source. */
  onView: (view: Record<string, unknown>) => void;
  /** The metadata editors, rendered by the page that owns their drafts. */
  youtubeFields: ReactNode;
  instagramFields: ReactNode;
}) {
  const toast = useToast();
  const actionsId = useId();

  const [visibility, setVisibility] = useState<Visibility>("private");
  const [picked, setPicked] = useState("");
  const [kids, setKids] = useState<"yes" | "no" | null>(null);
  const [looked, setLooked] = useState<Record<PlatformId, boolean>>({ youtube: false, instagram: false });
  const [confirm, setConfirm] = useState<{ anchor: Anchor; targets: PlatformId[] } | null>(null);
  const [sending, setSending] = useState<PlatformId[]>([]);
  const [sent, setSent] = useState<Partial<Record<PlatformId, SentNote>>>({});
  // True from the instant OK is pressed until the last request has answered. State alone is not enough:
  // two presses inside one frame both read the same render's `sending`. (The server would refuse the
  // second as a duplicate anyway; this keeps it from being asked.)
  const inFlight = useRef(false);

  // Weekly Schedule: is this video in an activated schedule, and at what instant?
  const [lookup, setLookup] = useState<SlotLookup>({ state: "loading" });
  const [lookups, setLookups] = useState(0);
  // Only moves on a timer, so "at least 15 minutes from now" is judged against a clock that is not frozen.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/schedules?episodeId=${encodeURIComponent(episodeId)}`, { cache: "no-store", signal: ac.signal });
        const body = (await res.json().catch(() => null)) as (EpisodeSlotResponse & { error?: string }) | null;
        if (ac.signal.aborted) return;
        if (!res.ok || !body || !("slot" in body)) {
          setLookup({ state: "error" });
          return;
        }
        setLookup({ state: "ready", slot: body.slot ?? null });
      } catch {
        // An aborted lookup is this component moving on; anything else is a lookup that failed.
        if (!ac.signal.aborted) setLookup({ state: "error" });
      }
    })();
    return () => ac.abort();
  }, [episodeId, lookups]);

  // Changing anything the confirmation was written for closes it: OK must answer the question that is on screen.
  const choose = {
    visibility: (next: Visibility) => {
      setConfirm(null);
      setVisibility(next);
    },
    picked: (next: string) => {
      setConfirm(null);
      setPicked(next);
    },
    kids: (next: "yes" | "no") => {
      setConfirm(null);
      setKids(next);
    },
  };

  const schedule = resolveSchedule({ picked, lookup });
  const slot = governingSlot(lookup);
  const scheduled = schedule.kind === "picked" || schedule.kind === "slot";
  // The operator's own answer wins; failing that, the one they saved on the schedule for this very video.
  const kidsAnswer: boolean | null = kids !== null ? kids === "yes" : slot && typeof slot.madeForKids === "boolean" ? slot.madeForKids : null;
  const kidsShown: "yes" | "no" | null = kidsAnswer === null ? null : kidsAnswer ? "yes" : "no";
  const kidsFromSchedule = kids === null && kidsAnswer !== null;

  const ctxFor =
    (at: number) =>
    (platform: PlatformId): PlanContext => ({
      owned: view.owned,
      visibility,
      schedule,
      kids: kidsAnswer,
      looked: looked[platform],
      now: at,
    });
  const plansFor = (targets: PlatformId[], at: number = now) => planTargets(view.platforms, targets, ctxFor(at));

  const stateOf = (platform: PlatformId) => view.platforms.find((p) => p.platform === platform) ?? null;
  const busy = sending.length > 0;

  function ask(anchor: Anchor, targets: PlatformId[]) {
    if (busy) return;
    const at = clockNow();
    setNow(at);
    if (!canAsk(plansFor(targets, at))) return;
    setConfirm({ anchor, targets });
  }

  async function send() {
    if (!confirm || busy || inFlight.current) return;
    const at = clockNow();
    // Decided again at the moment of OK: the time, a tick, or a job may have moved since the button was drawn.
    const plans = plansFor(confirm.targets, at);
    if (!canAsk(plans)) {
      setNow(at);
      setConfirm(null);
      return;
    }
    const toSend = plans.filter((p) => p.kind === "send");
    inFlight.current = true;
    setSending(toSend.map((p) => p.platform));
    setSent((prev) => {
      const next = { ...prev };
      for (const p of toSend) delete next[p.platform];
      return next;
    });

    // One at a time, in the order the button names them. Each platform's own answer is kept apart: one
    // being refused never stops the other from being asked, and never hides what the other said.
    try {
      for (const plan of toSend) {
        const request = requestFor(episodeId, plan);
        if (!request) continue;
        const label = plan.label;
        let note: SentNote | null = null;
        try {
          const res = await fetch(request.url, request.init);
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (!res.ok) {
            note = { tone: "error", text: typeof body.error === "string" ? body.error : f.sentFailed(label) };
          } else {
            onView(body);
            // Said from what the returned view holds, never from the fact that the request was accepted.
            const after = (body.platforms as PlatformState[] | undefined)?.find((p) => p.platform === plan.platform);
            note =
              after && (after.status === "PREPARING" || after.status === "UPLOADING")
                ? { tone: "ok", text: f.sentStarted(label) }
                : after && ["PUBLISHED", "SCHEDULED", "AWAITING_HUMAN", "FAILED"].includes(after.status)
                  ? null
                  : { tone: "ok", text: f.sentNothing(label) };
          }
        } catch {
          note = { tone: "error", text: f.sentNetwork(label) };
        }
        if (note) {
          const kept = note;
          setSent((prev) => ({ ...prev, [plan.platform]: kept }));
          toast.show(kept.text, kept.tone === "error" ? "error" : "ok");
        }
      }
    } finally {
      // However it ends, the buttons come back and the one confirmation closes.
      setLooked((prev) => {
        const next = { ...prev };
        for (const p of toSend) next[p.platform] = false;
        return next;
      });
      inFlight.current = false;
      setSending([]);
      setConfirm(null);
    }
  }

  const youtube = stateOf("youtube");
  const instagram = stateOf("instagram");
  const confirmPlans = confirm ? plansFor(confirm.targets) : [];

  const block = (state: PlatformState | null, heading: string, fields: ReactNode) => {
    if (!state) return null;
    const platform = state.platform;
    return (
      <PlatformBlock
        state={state}
        heading={heading}
        fields={fields}
        plans={plansFor([platform])}
        busy={busy}
        sendingHere={sending.includes(platform)}
        confirmHere={confirm?.anchor === platform}
        confirmPlans={confirmPlans}
        sent={sent[platform] ?? null}
        looked={looked[platform]}
        onLooked={(next) => setLooked((prev) => ({ ...prev, [platform]: next }))}
        onPress={() => ask(platform, [platform])}
        onOk={() => void send()}
        onCancel={() => setConfirm(null)}
      />
    );
  };

  // The bottom row: the same asks, from one place.
  const actions: Array<{ key: ActionTargets; label: string }> = [
    { key: "instagram", label: f.actionInstagram },
    { key: "youtube", label: f.actionYouTube },
    { key: "both", label: f.actionBoth },
  ];
  const bottomPlans = plansFor(TARGETS_OF.both);
  const bottomId = `${actionsId}-why`;

  return (
    <>
      {block(youtube, strings.publishCenter.youtubePackageHeading, youtubeFields)}
      {block(instagram, strings.publishCenter.instagramPackageHeading, instagramFields)}

      <VisibilityBlock
        visibility={visibility}
        scheduled={scheduled}
        kids={kidsShown}
        kidsFromSchedule={kidsFromSchedule}
        onVisibility={choose.visibility}
        onKids={choose.kids}
      />

      <ScheduleBlock
        picked={picked}
        lookup={lookup}
        now={now}
        onPick={choose.picked}
        onRetryLookup={() => {
          setLookup({ state: "loading" });
          setLookups((n) => n + 1);
        }}
      />

      <section className="pub-package" aria-labelledby={`${actionsId}-h`}>
        <h4 id={`${actionsId}-h`} className="font-display text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
          {f.actionsHeading}
        </h4>
        <div className="pub-publish-row" role="group" aria-labelledby={`${actionsId}-h`}>
          {actions.map(({ key, label }) => {
            const targets = TARGETS_OF[key];
            const mode = triggerLabel(view.platforms, targets);
            const names = targets.map((t) => PLATFORM_LABELS[t]);
            return (
              <Trigger
                key={key}
                plans={plansFor(targets)}
                busy={busy}
                mode={mode}
                ariaLabel={mode === "retry" ? f.retryAria(names.join(" and ")) : f.publishAria(names.join(" and "))}
                describedBy={bottomPlans.some((p) => p.note !== null) ? bottomId : undefined}
                onPress={() => ask("bottom", targets)}
              >
                {busy && confirm?.anchor === "bottom" && confirm.targets.length === targets.length && confirm.targets.every((t) => targets.includes(t))
                  ? f.publishing
                  : label}
              </Trigger>
            );
          })}
        </div>
        <Reasons plans={bottomPlans} id={bottomId} named />

        {confirm?.anchor === "bottom" && (
          <ConfirmPanel plans={confirmPlans} busy={busy} onOk={() => void send()} onCancel={() => setConfirm(null)} />
        )}

        {/* Each platform's own standing, side by side, from the job rows -- so a press on "both" shows both answers here. */}
        <ul className="pub-strip" role="list" aria-live="polite" aria-label={f.resultsHeading}>
          {view.platforms.map((p) => {
            const report = reportFor(p);
            const status = sectionStatus(p.status);
            const href = report?.link ? safeHref(report.link.href) : null;
            return (
              <li key={p.platform} data-platform={p.platform}>
                <span className="font-semibold" style={{ color: "var(--ink)" }}>
                  {PLATFORM_LABELS[p.platform]}
                </span>
                <Badge tone={status.tone}>{status.label}</Badge>
                {report && <span className="hint">{report.headline}</span>}
                {href && (
                  <a className="hint" href={href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>
                    {report?.link?.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
