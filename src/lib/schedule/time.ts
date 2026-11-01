/**
 * Wall-clock time in a named zone, and the weekly grid built from it. PURE: no
 * imports, no clock, no database, so the browser preview and the server's saved
 * slots run the same code and cannot disagree about when a video goes live.
 *
 * WHY THIS EXISTS. "09:00 on 5 October" means a different instant depending on
 * where it is said. `new Date(y, m, d, 9, 0)` answers in the SERVER's zone, which
 * is whatever the computer running BookReel is set to; a schedule is the
 * operator's, in the zone they plan in (Asia/Kolkata), so the conversion goes
 * through `Intl.DateTimeFormat` with that zone named. The offset is MEASURED for
 * the instant in question, not assumed, so a zone with daylight saving is right
 * too -- India has none, but nothing here depends on that.
 */

import { zonedInstant as fromZonedTime } from "./reference-time";
import { generatePlan, type TimeWindow } from "./plan";

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Is this a zone `Intl` knows? An unknown one throws on construction. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` naming a real calendar day (not 2026-02-30). */
export function isDateYYYYMMDD(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** `HH:mm`, 00:00 to 23:59. */
export function isTimeHHmm(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = TIME_RE.exec(value);
  return Boolean(m) && Number(m![1]) <= 23 && Number(m![2]) <= 59;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** What a wall clock in `timeZone` reads at this instant. */
function wallParts(instant: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `{ date: "YYYY-MM-DD", time: "HH:mm" }` -- what `timeZone`'s clock reads at `instant`. */
export function wallClock(instant: Date, timeZone: string = DEFAULT_TIMEZONE): { date: string; time: string } {
  const w = wallParts(instant, timeZone);
  return { date: `${w.year}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

/**
 * The UTC instant at which the clock in `timeZone` reads `dateYYYYMMDD` `timeHHmm`.
 *
 * Reads the zone's offset at a first guess, applies it, then reads the offset
 * AGAIN at the answer: when the two differ the guess straddled a daylight-saving
 * change, and the second offset is the one in force at that wall time. A wall time
 * that does not exist (the hour skipped by a spring-forward) resolves to a real
 * instant beside the gap rather than throwing. Throws `RangeError` for input that
 * is not a real date, time or zone.
 */
export function zonedInstant(dateYYYYMMDD: string, timeHHmm: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  if (!isDateYYYYMMDD(dateYYYYMMDD)) throw new RangeError(`Not a date (YYYY-MM-DD): ${String(dateYYYYMMDD)}`);
  if (!isTimeHHmm(timeHHmm)) throw new RangeError(`Not a time (HH:mm): ${String(timeHHmm)}`);
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Not a time zone: ${String(timeZone)}`);

  return fromZonedTime(dateYYYYMMDD, timeHHmm, timeZone);
}

/** The calendar day `n` days after `dateYYYYMMDD`. Calendar arithmetic, so month ends roll. */
export function addDays(dateYYYYMMDD: string, n: number): string {
  if (!isDateYYYYMMDD(dateYYYYMMDD)) throw new RangeError(`Not a date (YYYY-MM-DD): ${String(dateYYYYMMDD)}`);
  const [y, mo, d] = dateYYYYMMDD.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** A moment, as the zone's clock reads it, e.g. `Mon 5 Oct 2026, 09:00`. For display only. */
export function formatInZone(instant: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" })
    .formatToParts(instant)
    .filter((p) => p.type !== "literal")
    .map((p) => p.value)
    .join(" ");
  return `${day}, ${wallClock(instant, timeZone).time}`;
}

// ------------------------------------------------------------------ the weekly grid

export const MAX_DAYS = 7;
export const MAX_SLOTS_PER_DAY = 8;

export interface ScheduleConfig {
  windows?: TimeWindow[];
  seed?: number;
  endInclusive?: boolean;
  /** First day, `YYYY-MM-DD`, in `timezone`. */
  weekStart: string;
  /** 1..7 consecutive days from `weekStart`. */
  days: number;
  /** `HH:mm` wall-clock times in `timezone`. Order and repeats do not matter: see `normaliseSlots`. */
  timeSlots: string[];
  timezone?: string;
}

export interface SlotAssignment {
  episodeId: string;
  /** The exact UTC instant this video should go live. */
  assignedAt: Date;
  /** 0-based: the order the videos were given in, which is the order they are uploaded. */
  position: number;
}

/** Ascending and unique, so the grid does not depend on the order the operator added them in. */
export function normaliseSlots(timeSlots: readonly string[]): string[] {
  return [...new Set(timeSlots)].sort();
}

/** How many videos a `days` x `timeSlots` grid holds. */
export function scheduleCapacity(days: number, timeSlots: readonly string[]): number {
  return days * normaliseSlots(timeSlots).length;
}

/** Why a config cannot be expanded, in a sentence; `null` when it can. */
export function configProblem(config: ScheduleConfig): string | null {
  if (!isDateYYYYMMDD(config.weekStart)) return "Pick the first day of the week.";
  if (!Number.isInteger(config.days) || config.days < 1 || config.days > MAX_DAYS) {
    return `Choose between 1 and ${MAX_DAYS} days.`;
  }
  if (!Array.isArray(config.timeSlots) || config.timeSlots.length === 0) return "Add at least one daily time.";
  if (!config.timeSlots.every(isTimeHHmm)) return "Every time must look like 09:30.";
  if (normaliseSlots(config.timeSlots).length > MAX_SLOTS_PER_DAY) {
    return `At most ${MAX_SLOTS_PER_DAY} times a day.`;
  }
  if (config.timezone !== undefined && !isValidTimeZone(config.timezone)) return "That time zone is not recognised.";
  return null;
}

/**
 * Lay the videos onto the day x time grid, in the order given.
 *
 * DAY-MAJOR: the first day's times are filled in order, then the second day's, and
 * so on, so the videos go live in the order they were listed (part 1 before part 2).
 * To spread a few videos over the whole week, give the grid fewer times per day --
 * one time a day over seven days is one video a day.
 *
 * Throws `RangeError` on a config that `configProblem` names, and when there are
 * more videos than cells: dropping the extras silently would leave videos out of a
 * schedule that looks complete.
 */
export function expandSchedule(config: ScheduleConfig, episodeIds: readonly string[]): SlotAssignment[] {
  const problem = configProblem(config);
  if (problem) throw new RangeError(problem);
  const timezone = config.timezone ?? DEFAULT_TIMEZONE;
  const slots = normaliseSlots(config.timeSlots);
  const capacity = config.days * slots.length;
  if (episodeIds.length > capacity) {
    throw new RangeError(
      `${episodeIds.length} videos do not fit in ${config.days} day${config.days === 1 ? "" : "s"} of ${slots.length} time${slots.length === 1 ? "" : "s"} (room for ${capacity}).`,
    );
  }
  const plan = generatePlan({ startDate: config.weekStart, days: config.days, timezone, seed: config.seed ?? 1,
    windows: config.windows ?? slots.map(time => ({ start: time, end: time })), endInclusive: config.windows ? config.endInclusive ?? false : true });
  return episodeIds.map((episodeId, position) => ({ episodeId, position, assignedAt: plan.times[position].scheduledAt }));
}
