/**
 * What the Publish page decides, as pure functions. No network, no React, no storage,
 * and the one read of the clock (`clockNow`) is a function of its own: the component
 * hands in what it knows (the platform state, the choices, the time) and gets back a
 * sentence or a request. Pure for two reasons: the page and
 * its test run the SAME code, and a publish decision that lives in a click handler is
 * a publish decision nobody has read.
 *
 * It decides, and it never sends. The only things that ever reach a platform are the
 * routes this file names -- the browser publisher (`POST .../publish/browser`) and the
 * two official-API routes -- and every one of them has its own refusals (ownership,
 * `confirmPublic`, the 15-minute floor, one job per episode and platform). This file is
 * the front half of those, so the operator is told BEFORE a press rather than after it;
 * the server stays the half that cannot be talked out of it.
 *
 * THE RULES IT IS WRITTEN TO:
 *
 *  1. NO SILENT PROMOTION TO PUBLIC. A public or scheduled YouTube post, and every
 *     Instagram post, is `goesLive`, and the request carries `confirmPublic: true` only
 *     for those -- which the page sends only from the OK press. A private upload never
 *     carries it. An Instagram press while a schedule is set says, in so many words,
 *     that Instagram cannot be scheduled and will post at once.
 *  2. THE SCHEDULE IS INDIA TIME, EXACTLY. A picked wall-clock time is read in
 *     Asia/Kolkata through `zonedInstant` (the function the Weekly Schedule uses), so
 *     the two cannot disagree, and a video that is in an ACTIVATED Weekly Schedule is
 *     posted at that slot's own `assignedAt`, sent as the server's string untouched.
 *  3. ALREADY DONE MEANS NOTHING TO SEND. A platform whose job is PUBLISHED,
 *     SCHEDULED or in flight yields no request at all -- never a second job -- and one
 *     that stopped for a person yields a request only behind the operator's "I looked"
 *     tick. The server refuses the same cases; this is only the honest front of them.
 *  4. A RESULT IS WHAT THE JOB SAYS. `reportFor` reads "posted" or "scheduled" only
 *     from a job row that carries the platform's own id AND its own time (the engine
 *     writes those only after reading the platform's page back). A row without them is
 *     shown as needing a check, never as a success.
 *
 * Client-safe: it imports only the import-free `limits`, `schedule/time`,
 * `schedule/view` and the strings, and types from `view`. `tests/publish-page.test.mts`
 * holds it to that, so it cannot become a route to Prisma or the engine.
 */
import { strings } from "@/lib/strings";
import { DEFAULT_TIMEZONE, formatInZone, wallClock, zonedInstant } from "@/lib/schedule/time";
import { SCHEDULE_LEAD_MINUTES, type EpisodeSlotView } from "@/lib/schedule/view";
import { PLATFORM_LABELS, type PlatformId } from "./limits";
import type { PlatformState, PublishStatus } from "./view";

const f = strings.publishCenter.flow;

export type Visibility = "private" | "unlisted" | "public";
export type Route = "api" | "browser";

/** The zone every time on the Publish page is read and shown in. The Weekly Schedule's default, by construction. */
export const PUBLISH_TIMEZONE = DEFAULT_TIMEZONE;

/** The floor the engine enforces (`MIN_SCHEDULE_LEAD_MS`); the page mirrors it to warn early, the server decides. */
export const LEAD_MS = SCHEDULE_LEAD_MINUTES * 60_000;

/**
 * The wall clock, read at the moment of a press. A function of its own so the page asks "what time is it
 * NOW" from an event handler -- at the instant OK is pressed, not at the instant the button was drawn --
 * and a test can see the one place the clock is read.
 */
export function clockNow(): number {
  return Date.now();
}

/** `IST` for the default zone, the zone's own name for any other. */
export function zoneLabel(timeZone: string): string {
  return timeZone === "Asia/Kolkata" ? "IST" : timeZone;
}

/** A moment as the operator reads it: `Mon 5 Oct 2026, 09:00 IST`. */
export function whenText(instant: Date, timeZone: string = PUBLISH_TIMEZONE): string {
  return `${formatInZone(instant, timeZone)} ${zoneLabel(timeZone)}`;
}

// ------------------------------------------------------------------ the schedule

const LOCAL_INPUT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * The instant at which the clock in `timeZone` reads what a `datetime-local` input holds
 * (`YYYY-MM-DDTHH:mm`), or null for anything that is not a real date and time. The input has
 * no zone of its own, and `new Date(value)` would quietly give it THIS computer's: the page
 * says "India time", so it is read as India time, on any computer.
 */
export function instantFromLocalInput(value: string, timeZone: string = PUBLISH_TIMEZONE): Date | null {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;
  try {
    return zonedInstant(match[1], match[2], timeZone);
  } catch {
    return null;
  }
}

/** What a `datetime-local` input shows for an instant: the zone's wall clock, `YYYY-MM-DDTHH:mm`. */
export function localInputFor(instant: Date, timeZone: string = PUBLISH_TIMEZONE): string {
  const w = wallClock(instant, timeZone);
  return `${w.date}T${w.time}`;
}

/** What the page knows about the Weekly Schedule slot lookup. Loading and failed are distinct from "no slot". */
export type SlotLookup = { state: "loading" } | { state: "error" } | { state: "ready"; slot: EpisodeSlotView | null };

/**
 * The slot that GOVERNS this video's time: one in an activated schedule that was not skipped.
 * `skipped` means the video was already scheduled or posted when the schedule ran, so its
 * slot time no longer says anything about what to do next.
 */
export function governingSlot(lookup: SlotLookup): EpisodeSlotView | null {
  if (lookup.state !== "ready" || !lookup.slot) return null;
  return lookup.slot.status === "skipped" ? null : lookup.slot;
}

export type ScheduleChoice =
  | { kind: "none" }
  | { kind: "picked"; instant: Date }
  | { kind: "slot"; instant: Date; slot: EpisodeSlotView }
  | { kind: "invalid"; problem: string };

/** The time this publish is for: the slot's own instant if a slot governs, else what was picked, else none. */
export function resolveSchedule(input: { picked: string; lookup: SlotLookup }): ScheduleChoice {
  const slot = governingSlot(input.lookup);
  if (slot) {
    const instant = new Date(slot.assignedAt);
    return Number.isNaN(instant.getTime())
      ? { kind: "invalid", problem: f.slotUnreadable }
      : { kind: "slot", instant, slot };
  }
  if (input.picked.trim() === "") return { kind: "none" };
  const instant = instantFromLocalInput(input.picked);
  return instant ? { kind: "picked", instant } : { kind: "invalid", problem: f.scheduleInvalid };
}

/** Why this schedule cannot be sent, or null: not a real date, or closer than the floor YouTube Studio enforces. */
export function scheduleProblem(choice: ScheduleChoice, now: number): string | null {
  if (choice.kind === "invalid") return choice.problem;
  if (choice.kind === "none") return null;
  if (choice.instant.getTime() >= now + LEAD_MS) return null;
  return choice.kind === "slot"
    ? f.slotTooSoon(whenText(choice.instant, choice.slot.timezone), SCHEDULE_LEAD_MINUTES)
    : f.scheduleTooSoon(SCHEDULE_LEAD_MINUTES);
}

/** The earliest value the picker should offer, as the input holds it: now plus the floor, in India time. */
export function earliestInput(now: number): string {
  return localInputFor(new Date(now + LEAD_MS));
}

// ------------------------------------------------------------------ what a press would do

export interface PlanContext {
  /** Does this account own the episode? Publishing requires it. */
  owned: boolean;
  visibility: Visibility;
  schedule: ScheduleChoice;
  /** The operator's own answer, or null while unanswered. It is never defaulted. */
  kids: boolean | null;
  /** The operator ticked "I looked at the platform" for this platform's stopped attempt. */
  looked: boolean;
  now: number;
}

/**
 * - `send`: pressing OK sends a request for this platform.
 * - `done`: there is nothing to send because it already happened or is happening.
 * - `blocked`: the operator has to fix something first; `note` says what.
 */
export type PlanKind = "send" | "done" | "blocked";

export interface TargetPlan {
  platform: PlatformId;
  label: string;
  kind: PlanKind;
  /** The reason it is `done` or `blocked`; null when it will be sent. */
  note: string | null;
  route: Route | null;
  /** True when the post is public the moment it lands (or at its schedule): needs `confirmPublic`. */
  goesLive: boolean;
  /** What OK will do, one sentence each. Empty unless `kind` is `send`. */
  lines: string[];
  /** Is this an AWAITING_HUMAN retry? Then the request carries `acknowledgeRetry`. */
  retry: boolean;
  /** The request body (null when nothing is sent, or for the API YouTube route which takes none). */
  body: Record<string, unknown> | null;
}

/** The platform's official API is connected, identity-verified and able to upload. */
export function apiReady(state: PlatformState): boolean {
  return state.hasPublisher && state.configured && state.capabilities.canUpload;
}

const idle = (platform: PlatformId): Pick<TargetPlan, "platform" | "label" | "route" | "goesLive" | "lines" | "retry" | "body"> => ({
  platform,
  label: PLATFORM_LABELS[platform],
  route: null,
  goesLive: false,
  lines: [],
  retry: false,
  body: null,
});

const done = (platform: PlatformId, note: string): TargetPlan => ({ ...idle(platform), kind: "done", note });
const blocked = (platform: PlatformId, note: string): TargetPlan => ({ ...idle(platform), kind: "blocked", note });

/** What a press on this platform would do. Never sends anything. */
export function planTarget(state: PlatformState, ctx: PlanContext): TargetPlan {
  const platform = state.platform;
  const label = PLATFORM_LABELS[platform];
  const job = state.job;

  if (!ctx.owned) return blocked(platform, f.notOwned);

  // Already done, or being done: no second job, ever.
  if (state.status === "PUBLISHED") return done(platform, f.donePosted(label));
  if (state.status === "SCHEDULED") {
    const when = job?.scheduledFor ? whenText(new Date(job.scheduledFor)) : null;
    return done(platform, f.doneScheduled(label, when));
  }
  if (state.status === "PREPARING" || state.status === "UPLOADING") return done(platform, f.doneInProgress(label));

  // Stopped for a person. A video the platform already showed is never retried; otherwise a
  // retry needs the operator's own statement that they looked.
  const retry = state.status === "AWAITING_HUMAN";
  if (retry) {
    if (job?.externalId) return done(platform, f.doneSeen(label, job.externalId));
    if (!ctx.looked) return blocked(platform, f.retryNeedsLook(label));
  }

  if (state.status === "NOT_READY") return blocked(platform, f.notReady);
  if (state.problems.length > 0) return blocked(platform, state.problems.join(" "));

  if (platform === "instagram") return planInstagram(state, ctx, retry);
  return planYouTube(state, ctx, retry);
}

function browserBlock(state: PlatformState, label: string): string | null {
  if (!state.browser) return f.noBrowserRoute(label);
  if (!state.browser.available) return state.browser.reason ?? f.browserUnavailable(label);
  return null;
}

function planYouTube(state: PlatformState, ctx: PlanContext, retry: boolean): TargetPlan {
  const platform = "youtube" as const;
  const label = PLATFORM_LABELS[platform];
  const scheduled = ctx.schedule.kind === "picked" || ctx.schedule.kind === "slot";

  const timeProblem = scheduleProblem(ctx.schedule, ctx.now);
  if (timeProblem) return blocked(platform, timeProblem);

  const goesLive = scheduled || ctx.visibility === "public";

  // The official API uploads PRIVATE and cannot schedule or declare anything, so it serves exactly
  // that request and no other. A public, unlisted or scheduled post goes through the browser route,
  // which carries every one of those choices and the operator's own confirmation -- the API is never
  // used to quietly deliver something other than what was asked for. A retry is a browser job's.
  const viaApi = !retry && !scheduled && ctx.visibility === "private" && apiReady(state);
  if (viaApi) {
    return { ...idle(platform), kind: "send", note: null, route: "api", goesLive: false, lines: [f.sumYtApi] };
  }

  const block = browserBlock(state, label);
  if (block) return blocked(platform, block);
  if (scheduled && state.browser && !state.browser.canSchedule) return blocked(platform, f.cannotSchedule(label));
  if (ctx.kids === null) return blocked(platform, f.kidsRequired);

  const lines = [
    scheduled && ctx.schedule.kind !== "none" && ctx.schedule.kind !== "invalid"
      ? f.sumYtScheduled(whenText(ctx.schedule.instant, ctx.schedule.kind === "slot" ? ctx.schedule.slot.timezone : PUBLISH_TIMEZONE))
      : ctx.visibility === "public"
        ? f.sumYtPublic
        : ctx.visibility === "unlisted"
          ? f.sumYtUnlisted
          : f.sumYtPrivate,
  ];

  return {
    ...idle(platform),
    kind: "send",
    note: null,
    route: "browser",
    goesLive,
    lines,
    retry,
    body: {
      platform,
      // A schedule is public-at-a-time, and the page says so; the engine reads it as scheduled whatever else is said.
      visibility: scheduled ? "public" : ctx.visibility,
      // The exact instant: the slot's own string for a Weekly Schedule video, never re-derived from a display value.
      scheduledAt:
        ctx.schedule.kind === "slot" ? ctx.schedule.slot.assignedAt : ctx.schedule.kind === "picked" ? ctx.schedule.instant.toISOString() : null,
      madeForKids: ctx.kids,
      // Sent as true only for what goes live, and only ever from the OK press.
      confirmPublic: goesLive,
      acknowledgeRetry: retry && ctx.looked,
    },
  };
}

function planInstagram(state: PlatformState, ctx: PlanContext, retry: boolean): TargetPlan {
  const platform = "instagram" as const;
  const label = PLATFORM_LABELS[platform];
  // A schedule that is set but cannot be used is the operator's to fix; one that is merely not for
  // Instagram is said out loud in the confirmation instead.
  const scheduleSet = ctx.schedule.kind === "picked" || ctx.schedule.kind === "slot";
  const lines: string[] = [f.sumIg, ...(scheduleSet ? [f.sumIgIgnoresSchedule] : [])];

  if (!retry && apiReady(state)) {
    return { ...idle(platform), kind: "send", note: null, route: "api", goesLive: true, lines, body: { confirmPublic: true } };
  }

  const block = browserBlock(state, label);
  if (block) return blocked(platform, block);

  return {
    ...idle(platform),
    kind: "send",
    note: null,
    route: "browser",
    goesLive: true,
    lines,
    retry,
    body: {
      platform,
      // Instagram has no private or unlisted post; the engine refuses anything but public, so say public.
      visibility: "public",
      confirmPublic: true,
      acknowledgeRetry: retry && ctx.looked,
    },
  };
}

/** The route and body a plan sends, ready for `fetch`. Null when the plan sends nothing. */
export function requestFor(episodeId: string, plan: TargetPlan): { url: string; init: RequestInit } | null {
  if (plan.kind !== "send" || !plan.route) return null;
  const base = `/api/episodes/${encodeURIComponent(episodeId)}/publish`;
  if (plan.route === "browser") {
    return {
      url: `${base}/browser`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan.body ?? {}) },
    };
  }
  if (plan.platform === "instagram") {
    return {
      url: `${base}/instagram`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan.body ?? {}) },
    };
  }
  return { url: `${base}/youtube`, init: { method: "POST" } };
}

/** The plans for a set of targets, in the order given. */
export function planTargets(states: PlatformState[], targets: PlatformId[], ctxFor: (platform: PlatformId) => PlanContext): TargetPlan[] {
  return targets.flatMap((platform) => {
    const state = states.find((s) => s.platform === platform);
    return state ? [planTarget(state, ctxFor(platform))] : [];
  });
}

/** Every target a bottom-row button can name. */
export type ActionTargets = "instagram" | "youtube" | "both";

/** Instagram first, as the button reads. Independent: one platform's refusal never stops the other. */
export const TARGETS_OF: Record<ActionTargets, PlatformId[]> = {
  instagram: ["instagram"],
  youtube: ["youtube"],
  both: ["instagram", "youtube"],
};

/**
 * Can a press on these plans go on to a confirmation? Only if nothing is blocked and at least
 * one target has something to send. A `done` target beside a `send` one is simply left out of the send.
 */
export function canAsk(plans: TargetPlan[]): boolean {
  return plans.length > 0 && plans.every((p) => p.kind !== "blocked") && plans.some((p) => p.kind === "send");
}

// ------------------------------------------------------------------ what the job says

/** What `PlatformState` shows for one platform, derived ONLY from the job row and its status. */
export interface Report {
  /** The platform's own page confirmed it: the job carries its id and its time. Only then are the words "posted"/"scheduled" used. */
  confirmed: boolean;
  tone: "done" | "live" | "soon" | "failed";
  headline: string;
  detail: string | null;
  link: { href: string; label: string } | null;
  /** The job stopped for a person (a sign-in, a security check, an unknown outcome). */
  needsHuman: boolean;
}

/**
 * Only an app path or an https URL may become an `href`. An app path is `/x`, not `//host` or `/\host`: a
 * protocol-relative URL starts with a slash too, and would leave the app for whatever host it names.
 */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  if (href.startsWith("/")) return href.startsWith("//") || href.startsWith("/\\") ? null : href;
  return /^https:\/\//i.test(href) ? href : null;
}

/** The report for a platform, or null when nothing has been attempted. */
export function reportFor(state: PlatformState): Report | null {
  const job = state.job;
  const label = PLATFORM_LABELS[state.platform];
  const open = safeHref(state.platform === "youtube" ? (job?.reviewUrl ?? job?.externalUrl) : job?.externalUrl);
  const link = open ? { href: open, label: state.platform === "youtube" ? f.openStudio : strings.publishCenter.openOn(label) } : null;

  switch (state.status) {
    case "PUBLISHED": {
      if (job?.externalId && job.publishedAt) {
        return {
          confirmed: true,
          tone: "done",
          headline: f.reportPosted(label),
          detail: f.reportPostedDetail(whenText(new Date(job.publishedAt)), job.externalId),
          link,
          needsHuman: false,
        };
      }
      return unconfirmed(label, f.unconfirmedPosted(label));
    }
    case "SCHEDULED": {
      if (job?.externalId && job.scheduledFor) {
        return {
          confirmed: true,
          tone: "done",
          headline: f.reportScheduled(label, whenText(new Date(job.scheduledFor))),
          detail: f.reportScheduledDetail(label),
          link,
          needsHuman: false,
        };
      }
      return unconfirmed(label, f.unconfirmedScheduled(label));
    }
    case "PREPARING":
    case "UPLOADING":
      return { confirmed: false, tone: "live", headline: f.reportInProgress(label), detail: f.reportInProgressDetail, link: null, needsHuman: false };
    case "AWAITING_HUMAN":
      return {
        confirmed: false,
        tone: "soon",
        headline: f.reportNeedsYou(label),
        detail: job?.lastError ?? f.reportNeedsYouDetail(label),
        link,
        needsHuman: true,
      };
    case "FAILED":
      return { confirmed: false, tone: "failed", headline: f.reportFailed(label), detail: job?.lastError ?? null, link: null, needsHuman: false };
    default:
      return null;
  }
}

function unconfirmed(label: string, detail: string): Report {
  return { confirmed: false, tone: "soon", headline: f.reportCheck(label), detail, link: null, needsHuman: true };
}

/**
 * The badge a platform section wears. Derived from the job's status alone, so "Posted" and
 * "Scheduled" appear only when the engine recorded them; everything else is "Not posted yet",
 * which is also what a platform with no API connection says -- the page publishes through the
 * browser window too, so "requires connection" would claim a blocker that is not there.
 */
export function sectionStatus(status: PublishStatus): { tone: "done" | "live" | "soon" | "failed" | "cancelled" | "plain"; label: string } {
  switch (status) {
    case "PUBLISHED":
      return { tone: "done", label: f.statusPosted };
    case "SCHEDULED":
      return { tone: "done", label: f.statusScheduled };
    case "PREPARING":
    case "UPLOADING":
      return { tone: "live", label: f.statusInProgress };
    case "AWAITING_HUMAN":
      return { tone: "soon", label: f.statusNeedsYou };
    case "FAILED":
      return { tone: "failed", label: f.statusFailed };
    case "NOT_READY":
      return { tone: "cancelled", label: f.statusNotReady };
    default:
      return { tone: "plain", label: f.statusNotPosted };
  }
}

/**
 * Should the result offer "Sign in to YouTube"? Only when a YouTube attempt stopped for a person
 * that never saw a video, and the server opens the installed Chrome on its own profile (channel
 * mode) -- the one mode the sign-in route can serve. It is an affordance on the result, not a section.
 */
export function offersSignIn(state: PlatformState): boolean {
  return (
    state.platform === "youtube" &&
    state.status === "AWAITING_HUMAN" &&
    !state.job?.externalId &&
    Boolean(state.browser?.channel) &&
    !state.browser?.attach
  );
}

/** Which button label a trigger wears: Retry after a stop for a person, else Publish. */
export function triggerLabel(states: PlatformState[], targets: PlatformId[]): "publish" | "retry" {
  return targets.some((t) => states.find((s) => s.platform === t)?.status === "AWAITING_HUMAN") ? "retry" : "publish";
}
