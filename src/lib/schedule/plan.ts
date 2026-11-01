/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import { addDays, isValidDate, isValidTime, isValidZone, minutesOf, timeOf, zonedInstant } from "./reference-time";

/**
 * Drawing a week of post times, and checking one.
 *
 * Pure: no database, no clock of its own, no randomness that is not seeded. The
 * same seed and the same settings always draw the same week, which is what makes
 * a schedule something that can be reviewed and then trusted - nothing here ever
 * runs again after the plan is approved, and re-drawing is a button a person has
 * to press.
 */

export interface TimeWindow {
  /** Local `HH:mm`, inclusive. */
  start: string;
  /** Local `HH:mm`. Exclusive unless `endInclusive` says otherwise. */
  end: string;
}

/** The three slots of a day, as asked for: early morning, early afternoon, late evening. */
export const DEFAULT_WINDOWS: TimeWindow[] = [
  { start: "05:00", end: "06:00" },
  { start: "13:00", end: "14:00" },
  { start: "21:00", end: "23:30" },
];

export interface PlanInput {
  /** Local date of day one, `YYYY-MM-DD`. */
  startDate: string;
  days: number;
  windows: TimeWindow[];
  timezone: string;
  seed: number;
  endInclusive: boolean;
}

export interface PlannedTime {
  /** 0-based. */
  day: number;
  /** 1-based, in time order within the day. */
  position: number;
  localDate: string;
  localTime: string;
  scheduledAt: Date;
}

export interface Plan {
  times: PlannedTime[];
  /** Things worth saying that do not stop the plan: a window too narrow to give every day its own minute. */
  warnings: string[];
}

/* ------------------------------------------------------------------- rng -- */

/** A small seeded generator (mulberry32). Not cryptographic, and does not need to be. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* --------------------------------------------------------------- windows -- */

/**
 * Every minute of a window that can be chosen, as minutes since midnight.
 *
 * The end is exclusive unless asked otherwise. A reel scheduled for 06:00 is
 * pressed at 06:00 and shows up some seconds later, so a window that ends at 06:00
 * has already ended by the time the post is public. Ending at 05:59 keeps the post
 * inside the window it was promised in; `endInclusive` is there for a person who
 * decides otherwise.
 */
export function windowMinutes(window: TimeWindow, endInclusive: boolean): number[] {
  const from = minutesOf(window.start);
  const to = minutesOf(window.end) - (endInclusive ? 0 : 1);
  const out: number[] = [];
  for (let m = from; m <= to; m++) out.push(m);
  return out;
}

/** What is wrong with a set of windows, in words. Empty means usable. */
export function validateWindows(windows: TimeWindow[], endInclusive: boolean): string[] {
  const problems: string[] = [];
  if (!Array.isArray(windows) || windows.length === 0) return ["There has to be at least one time window."];

  windows.forEach((w, i) => {
    const label = `Slot ${i + 1}`;
    if (!isValidTime(w?.start) || !isValidTime(w?.end)) {
      problems.push(`${label}: times must be written as 24-hour HH:mm.`);
      return;
    }
    if (windowMinutes(w, endInclusive).length === 0) {
      problems.push(`${label}: ${w.start} to ${w.end} has no minute in it that can be chosen.`);
    }
  });
  if (problems.length) return problems;

  // The three slots of a day keep their order only if the windows do.
  for (let i = 1; i < windows.length; i++) {
    const before = windows[i - 1];
    const after = windows[i];
    const lastOfBefore = minutesOf(before.end) - (endInclusive ? 0 : 1);
    if (minutesOf(after.start) <= lastOfBefore) {
      problems.push(`Slot ${i + 1} (${after.start}) starts before slot ${i} (${before.end}) ends, so the day's order could not be kept.`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------ generating -- */

/**
 * Draw every post time for every day.
 *
 * For each slot of the day the window's minutes are cut into one band per day and
 * one minute is drawn from each band; the draws are then dealt out to the days in
 * a seeded shuffle. Cutting into bands is what guarantees the week does not
 * repeat itself - seven draws from one pool of sixty minutes collide often, seven
 * draws from seven bands cannot - and the shuffle is what stops the times from
 * simply creeping later all week.
 */
export function generatePlan(input: PlanInput): Plan {
  const problems = validateWindows(input.windows, input.endInclusive);
  if (problems.length) throw new Error(problems.join(" "));
  if (!isValidZone(input.timezone)) throw new Error(`"${input.timezone}" is not a time zone this system knows.`);
  if (!isValidDate(input.startDate)) throw new Error(`"${input.startDate}" is not a date (use YYYY-MM-DD).`);
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 31) throw new Error("Days has to be a whole number from 1 to 31.");

  const warnings: string[] = [];
  const perPosition: number[][] = input.windows.map((window, index) => {
    const pool = windowMinutes(window, input.endInclusive);
    const next = rng((input.seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);

    if (pool.length < input.days) {
      warnings.push(
        `Slot ${index + 1} (${window.start} to ${window.end}) has only ${pool.length} minute${pool.length === 1 ? "" : "s"} for ${input.days} days, so some days have to share a time.`,
      );
      const cycled: number[] = [];
      while (cycled.length < input.days) cycled.push(...shuffled(pool, next));
      return cycled.slice(0, input.days);
    }

    const picks: number[] = [];
    for (let day = 0; day < input.days; day++) {
      const lo = Math.floor((day * pool.length) / input.days);
      const hi = Math.floor(((day + 1) * pool.length) / input.days);
      picks.push(pool[lo + Math.floor(next() * (hi - lo))]);
    }
    return shuffled(picks, next);
  });

  const times: PlannedTime[] = [];
  for (let day = 0; day < input.days; day++) {
    const localDate = addDays(input.startDate, day);
    for (let index = 0; index < input.windows.length; index++) {
      const localTime = timeOf(perPosition[index][day]);
      times.push({
        day,
        position: index + 1,
        localDate,
        localTime,
        scheduledAt: zonedInstant(localDate, localTime, input.timezone),
      });
    }
  }
  return { times, warnings };
}

/* ------------------------------------------------------------- checking -- */

export interface SlotTime {
  /** An id to attach a finding to. */
  key: string;
  day: number;
  position: number;
  localDate: string;
  localTime: string;
  scheduledAt: Date;
}

export interface Issue {
  key: string;
  severity: "error" | "warning";
  message: string;
}

export interface CheckOptions {
  now: Date;
  timezone: string;
  windows: TimeWindow[];
  endInclusive: boolean;
  /** Slots closer together than this are refused: one platform's window does one job at a time. */
  minGapMinutes: number;
  /** A time less than this far ahead cannot be prepared for, and is refused. */
  minAheadMinutes?: number;
}

/**
 * What is wrong with a set of slot times.
 *
 * Errors stop a schedule being activated; warnings are said and left to the
 * person, because moving a post outside the window it was drawn in is a choice
 * they are allowed to make.
 */
export function checkSlots(slots: SlotTime[], opts: CheckOptions): Issue[] {
  const issues: Issue[] = [];
  const minAhead = opts.minAheadMinutes ?? 5;

  for (const s of slots) {
    if (!isValidDate(s.localDate) || !isValidTime(s.localTime)) {
      issues.push({ key: s.key, severity: "error", message: "The date or time is not valid." });
      continue;
    }
    if (s.scheduledAt.getTime() < opts.now.getTime() + minAhead * 60_000) {
      issues.push({
        key: s.key,
        severity: "error",
        message: s.scheduledAt.getTime() < opts.now.getTime() ? "That time has already passed." : `That is less than ${minAhead} minutes away, too soon to prepare the post.`,
      });
    }

    const window = opts.windows[s.position - 1];
    if (window) {
      const minute = minutesOf(s.localTime);
      const last = minutesOf(window.end) - (opts.endInclusive ? 0 : 1);
      if (minute < minutesOf(window.start) || minute > last) {
        issues.push({
          key: s.key,
          severity: "warning",
          message: `${s.localTime} is outside the ${window.start} to ${window.end} window for slot ${s.position}.`,
        });
      }
    }
  }

  const usable = slots.filter((s) => isValidDate(s.localDate) && isValidTime(s.localTime));
  const byTime = [...usable].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.key.localeCompare(b.key));

  for (let i = 1; i < byTime.length; i++) {
    const before = byTime[i - 1];
    const after = byTime[i];
    const gap = (after.scheduledAt.getTime() - before.scheduledAt.getTime()) / 60_000;
    if (gap === 0) {
      issues.push({ key: after.key, severity: "error", message: `Same moment as another post (${after.localDate} ${after.localTime}).` });
    } else if (gap < opts.minGapMinutes) {
      issues.push({
        key: after.key,
        severity: "error",
        message: `Only ${Math.round(gap)} minute${Math.round(gap) === 1 ? "" : "s"} after the post before it; at least ${opts.minGapMinutes} are needed so the browser can finish one before starting the next.`,
      });
    }
  }

  // The order of a day's slots is the order of their numbers.
  const days = new Map<string, SlotTime[]>();
  for (const s of usable) {
    const list = days.get(s.localDate) ?? [];
    list.push(s);
    days.set(s.localDate, list);
  }
  for (const list of days.values()) {
    const byPosition = [...list].sort((a, b) => a.position - b.position);
    for (let i = 1; i < byPosition.length; i++) {
      if (byPosition[i].scheduledAt.getTime() <= byPosition[i - 1].scheduledAt.getTime()) {
        issues.push({
          key: byPosition[i].key,
          severity: "error",
          message: `Slot ${byPosition[i].position} has to come after slot ${byPosition[i - 1].position} on the same day.`,
        });
      }
    }
  }
  return issues;
}

/* --------------------------------------------------------------- job times -- */

export interface JobTimeSettings {
  leadMinutes: number;
  instagramOffsetMinutes: number;
}

/**
 * When an upload becomes eligible and when the platform should publish it.
 *
 * Native schedules upload at activation, independently of the saved preparation
 * lead. Only legacy timed publishing subtracts that lead and holds until go-live.
 * Instagram's deliberate offset changes publication, never native upload start.
 * Callers must explicitly choose the workflow so native jobs cannot accidentally
 * inherit timed publishing's default.
 */
export function jobTimes(
  slotAt: Date,
  platform: "youtube" | "instagram",
  settings: JobTimeSettings,
  now: Date,
  native: boolean,
): { startAt: Date; publishAt: Date } {
  const publishAt = new Date(slotAt.getTime() + (platform === "instagram" ? settings.instagramOffsetMinutes * 60_000 : 0));
  // A native schedule uploads now and hands the future publication time to the platform.
  // Waiting until the preparation lead prevented Instagram schedules from being submitted
  // when the user activated them. Only timed browser publishing needs the preparation lead.
  const startAt =
    native
      ? now
      : new Date(Math.max(publishAt.getTime() - settings.leadMinutes * 60_000, now.getTime()));
  return { startAt, publishAt };
}

/**
 * Posts that sit too close to ones in OTHER schedules. One channel, one Instagram
 * account: two schedules do not get a platform window each.
 */
export function checkAgainst(own: SlotTime[], foreign: SlotTime[], minGapMinutes: number, where = "in another schedule"): Issue[] {
  const issues: Issue[] = [];
  for (const s of own) {
    for (const f of foreign) {
      const gap = Math.abs(s.scheduledAt.getTime() - f.scheduledAt.getTime()) / 60_000;
      if (gap < minGapMinutes) {
        issues.push({
          key: s.key,
          severity: "error",
          message: `Only ${Math.round(gap)} minute${Math.round(gap) === 1 ? "" : "s"} from a post ${where} (${f.localDate} ${f.localTime}); at least ${minGapMinutes} are needed.`,
        });
        break;
      }
    }
  }
  return issues;
}

/**
 * Whether one post, moved, still comes in its day's order against the others of that day.
 *
 * Findings from `checkSlots` land on whichever post is later in time, which is the
 * wrong one to report when the post that moved is the earlier of the pair. This
 * checks the moved post against each of the others and always reports on it.
 */
export function checkOrder(own: SlotTime, mates: SlotTime[]): Issue[] {
  const issues: Issue[] = [];
  for (const m of mates) {
    if (m.localDate !== own.localDate || m.position === own.position) continue;
    if (m.position < own.position && m.scheduledAt.getTime() >= own.scheduledAt.getTime()) {
      issues.push({ key: own.key, severity: "error", message: `Slot ${own.position} has to come after slot ${m.position} on the same day (${m.localTime}).` });
    }
    if (m.position > own.position && m.scheduledAt.getTime() <= own.scheduledAt.getTime()) {
      issues.push({ key: own.key, severity: "error", message: `Slot ${own.position} has to come before slot ${m.position} on the same day (${m.localTime}).` });
    }
  }
  return issues;
}
