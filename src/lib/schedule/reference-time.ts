/**
 * Local clock times in a named zone, and the instants they are.
 *
 * A schedule is written the way a person reads it - "Wednesday, 05:23, in
 * Asia/Kolkata" - and carried out as an instant. Going from one to the other has
 * to be exact and has to work without ever asking what zone THIS machine, or the
 * browser that typed the value, happens to be in: `new Date("2026-10-15T05:23")`
 * means 05:23 wherever the code runs, which is the wrong answer on every machine
 * but one. So nothing here uses the host's zone. Local values are plain strings
 * (`YYYY-MM-DD`, `HH:mm`) and the zone is always named.
 *
 * Asia/Kolkata has no daylight saving, so its offset is a constant +05:30 and the
 * conversions are exact. The functions below are written for any IANA zone, and
 * say so loudly in the two cases a zone with daylight saving makes ambiguous: a
 * local time that does not exist (the clocks skip it) throws, and one that
 * happens twice (the clocks go back) takes the first.
 */

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function fieldsAt(ms: number, timeZone: string): Fields {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  // Some engines print midnight as 24 even with h23.
  if (out.hour === 24) out.hour = 0;
  return out as unknown as Fields;
}

/** How far the zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const f = fieldsAt(ms, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const two = (n: number) => String(n).padStart(2, "0");

/* ------------------------------------------------------------- validation -- */

export function isValidZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A real calendar date, `YYYY-MM-DD`. 2026-02-30 is not one. */
export function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** A 24-hour time of day, `HH:mm`. */
export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? "");
}

/* ----------------------------------------------------------- conversions -- */

/** Minutes since midnight for an `HH:mm`. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** `HH:mm` for minutes since midnight. */
export function timeOf(minutes: number): string {
  return `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
}

/** The date `days` after (or before, if negative) a local date. Calendar arithmetic: no zone is involved. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
}

/** The local date and time an instant is, in a zone. */
export function localParts(instant: Date | number, timeZone: string): { date: string; time: string } {
  const f = fieldsAt(typeof instant === "number" ? instant : instant.getTime(), timeZone);
  return { date: `${f.year}-${two(f.month)}-${two(f.day)}`, time: `${two(f.hour)}:${two(f.minute)}` };
}

/** Today's date in a zone. */
export const todayIn = (timeZone: string, now: Date | number = Date.now()): string => localParts(now, timeZone).date;

/**
 * The instant a local date and time is, in a zone.
 *
 * Throws for a value that is not a date and time, and for a local time that does
 * not exist in the zone. A time that happens twice resolves to the first one.
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  if (!isValidZone(timeZone)) throw new Error(`"${timeZone}" is not a time zone this system knows.`);
  if (!isValidDate(date)) throw new Error(`"${date}" is not a date (use YYYY-MM-DD).`);
  if (!isValidTime(time)) throw new Error(`"${time}" is not a time (use 24-hour HH:mm).`);

  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);

  // The offset is read at the guess, then again at the corrected guess: across a
  // daylight saving change the first read can be the other side of it.
  let guess = wallAsUtc - offsetAt(wallAsUtc, timeZone);
  guess = wallAsUtc - offsetAt(guess, timeZone);

  const back = localParts(guess, timeZone);
  if (back.date !== date || back.time !== time) {
    throw new Error(`${date} ${time} does not exist in ${timeZone}: the clocks skip it.`);
  }
  return new Date(guess);
}

/** A short name for a zone, for labelling times on screen. */
export function zoneLabel(timeZone: string): string {
  if (timeZone === "Asia/Kolkata" || timeZone === "Asia/Calcutta") return "IST";
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  return timeZone;
}

/** "Wed 15 Oct, 05:23 IST", for an instant in a zone. */
export function formatLocal(instant: Date | number, timeZone: string): string {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  const { date, time } = localParts(ms, timeZone);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
  void date;
  return `${day}, ${time} ${zoneLabel(timeZone)}`;
}

/**
 * How far a zone's clock is ahead of UTC at an instant, in whole minutes
 * (+330 for Asia/Kolkata). The number a "GMT+5:30" label stands for.
 */
export function offsetMinutesAt(instant: Date | number, timeZone: string): number {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  return Math.round(offsetAt(ms, timeZone) / 60_000);
}
