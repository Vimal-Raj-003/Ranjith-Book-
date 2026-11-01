/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import { formatLocal, localParts, offsetMinutesAt } from "../schedule/reference-time";

/**
 * Asking YouTube to publish a video at a time, instead of publishing it ourselves.
 *
 * Everything here is a decision made over plain values - an instant, a time zone,
 * the words a page or an API response contained - so the rules can be tested
 * without a browser and without a channel. The functions that read Studio's page
 * and the ones that press its buttons are in browser/youtube-schedule.ts; they
 * hand what they read to these and act only on the answer.
 *
 * The rule that runs through all of it: a video is "scheduled" only when YouTube
 * says it is, with the time that was asked for. A button having been pressed, a
 * dialog having closed, a request having returned - none of those is that.
 */

/**
 * The nearest a scheduled time may be to the moment it is submitted.
 *
 * YouTube turns a time that is too close away (the picker says to pick a later
 * one), and a time that passes while the upload is still finishing is then in the
 * past. Twenty minutes is a margin over both: it is far enough that the page
 * accepts it, and a post this close is better reported than squeezed in.
 */
export const NATIVE_MIN_LEAD_MS = 20 * 60_000;

/** The instant YouTube is to publish a job's video, or null when none was set. */
export function goLiveOf(job: { publishAt: Date | null; scheduledAt: Date | null }): Date | null {
  // `publishAt` is the go-live of a scheduled job. A job made before that column
  // was used this way kept the go-live in `scheduledAt`, so it is the fallback.
  const at = job.publishAt ?? job.scheduledAt;
  return at && Number.isFinite(at.getTime()) ? at : null;
}

export type GoLiveCheck =
  | { ok: true }
  | { ok: false; code: "missing" | "too-soon"; message: string };

/**
 * Whether a go-live time can still be handed to YouTube.
 *
 * Refuses rather than adjusts: moving a video to "the next possible minute" would
 * publish it at a time nobody planned, on a channel whose schedule is the point.
 */
export function checkGoLive(goLive: Date | null, now: Date, zone: string): GoLiveCheck {
  if (!goLive) {
    return { ok: false, code: "missing", message: "This post has no scheduled time, so there is nothing to give YouTube. Nothing was scheduled." };
  }
  const ahead = goLive.getTime() - now.getTime();
  if (ahead < NATIVE_MIN_LEAD_MS) {
    const minutes = Math.round(NATIVE_MIN_LEAD_MS / 60_000);
    return {
      ok: false,
      code: "too-soon",
      message:
        `Its scheduled time, ${formatLocal(goLive, zone)}, is ${ahead <= 0 ? "already past" : "less than " + minutes + " minutes away"}, ` +
        `and YouTube needs at least ${minutes} to accept a schedule. Nothing was scheduled. Move the post to a later time and run it again.`,
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------- what Studio shows -- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A time zone's offset the way Studio's label prints it: "GMT+5:30", "GMT-8". */
export function gmtLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * How Studio writes dates and times, which follows the account's language and not
 * this code's: the Studio this was written against is English (UK), which prints
 * "16 Oct 2026" and "05:39", and an English (US) one prints "Oct 16, 2026" and
 * "5:39 AM". A date typed in the wrong shape is read as another date or refused, so
 * what is typed is written in the shape the page itself is showing.
 */
export interface PickerStyle {
  /** "dmy-short" 16 Oct 2026 · "mdy-short" Oct 16, 2026 · "dmy-numeric" 16/10/2026 · "mdy-numeric" 10/16/2026 */
  date: "dmy-short" | "mdy-short" | "dmy-numeric" | "mdy-numeric";
  /** 12-hour with AM/PM, or 24-hour. */
  hour12: boolean;
}

/** The Studio this was written against: English (UK). */
export const STYLE_EN_GB: PickerStyle = { date: "dmy-short", hour12: false };
export const STYLE_EN_US: PickerStyle = { date: "mdy-short", hour12: true };

/** Which way round a date written with slashes is read in this style. */
export const slashOrderOf = (style: PickerStyle): "dmy" | "mdy" => (style.date.startsWith("dmy") ? "dmy" : "mdy");

/**
 * The style a page is using, read from the date and time it is showing now.
 * Anything it cannot tell is taken as the UK style, which is the one observed.
 */
export function detectPickerStyle(dateText: string | null, timeText: string | null): PickerStyle {
  const d = (dateText ?? "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
  const t = (timeText ?? "").replace(/[\u00a0\u202f]/g, " ").trim();

  let date: PickerStyle["date"] = "dmy-short";
  if (new RegExp(`^${MONTH_WORD}\\s+\\d`, "i").test(d)) date = "mdy-short";
  else if (new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}`, "i").test(d)) date = "dmy-short";
  else {
    const n = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}$/.exec(d);
    if (n) date = Number(n[2]) > 12 ? "mdy-numeric" : "dmy-numeric";
  }

  return { date, hour12: /[ap]\.?\s?m\.?$/i.test(t) };
}

/** The scheduled moment, written the way Studio is typed into and reads back. */
export interface StudioTarget {
  instant: Date;
  /** The zone it was worked out in, or a fixed offset such as "GMT+5:30" when Studio named only an offset. */
  zone: string;
  year: number;
  month: number;
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** "16 Oct 2026" or "Oct 16, 2026", in the page's own style. */
  dateText: string;
  /** "05:39" or "5:39 AM", in the page's own style. */
  timeText: string;
  offsetMinutes: number;
  /** "GMT+5:30" */
  gmtLabel: string;
  style: PickerStyle;
}

const two = (n: number): string => String(n).padStart(2, "0");

function writtenDate(year: number, month: number, day: number, style: PickerStyle): string {
  switch (style.date) {
    case "dmy-short":
      return `${day} ${MONTHS[month - 1]} ${year}`;
    case "mdy-short":
      return `${MONTHS[month - 1]} ${day}, ${year}`;
    case "dmy-numeric":
      return `${two(day)}/${two(month)}/${year}`;
    case "mdy-numeric":
      return `${month}/${day}/${year}`;
  }
}

function writtenTime(minutes: number, style: PickerStyle): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  if (!style.hour12) return `${two(hh)}:${two(mm)}`;
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${two(mm)} ${hh < 12 ? "AM" : "PM"}`;
}

/**
 * The date and time to type into Studio so that, in `zone`, it is `instant`.
 *
 * `zone` is the zone Studio's picker works in. That is the browser's own, which
 * is why the caller reads it from the browser instead of assuming the schedule's:
 * typing 05:00 into a picker that is working in another zone schedules another
 * moment, and nothing on the page would say so.
 */
export function studioTarget(instant: Date, zone: string, style: PickerStyle = STYLE_EN_US): StudioTarget {
  const { date, time } = localParts(instant, zone);
  const [year, month, day] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const offsetMinutes = offsetMinutesAt(instant, zone);
  return {
    instant,
    zone,
    year,
    month,
    day,
    minutes: hh * 60 + mm,
    dateText: writtenDate(year, month, day, style),
    timeText: writtenTime(hh * 60 + mm, style),
    offsetMinutes,
    gmtLabel: gmtLabel(offsetMinutes),
    style,
  };
}

/**
 * The same, for a Studio that names its time zone only by an offset ("GMT+05:30").
 * A fixed offset has no daylight saving, so this is exact only for the moment the
 * offset was read for; the caller prefers a named zone whenever it knows one.
 */
export function studioTargetAtOffset(instant: Date, offsetMinutes: number, style: PickerStyle = STYLE_EN_US): StudioTarget {
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return {
    instant,
    zone: gmtLabel(offsetMinutes),
    year,
    month,
    day,
    minutes,
    dateText: writtenDate(year, month, day, style),
    timeText: writtenTime(minutes, style),
    offsetMinutes,
    gmtLabel: gmtLabel(offsetMinutes),
    style,
  };
}

/** "Fri, Oct 16, 2026, 5:00 AM (GMT+5:30)": for logs and notes. */
export const describeTarget = (t: StudioTarget): string => `${t.dateText}, ${t.timeText} (${t.gmtLabel})`;

const clean = (s: string): string =>
  (s ?? "")
    // Newer engines print a narrow no-break space before AM/PM; a page can use any of these.
    .replace(/[\u00a0\u202f\u2009\u2007]/g, " ")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export interface ParsedDate {
  year: number;
  month: number;
  day: number;
}

const monthIndex = (name: string): number => MONTHS.findIndex((m) => name.slice(0, 3).toLowerCase() === m.toLowerCase()) + 1;
const MONTH_WORD = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";

const real = (y: number, m: number, d: number): ParsedDate | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2200) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? { year: y, month: m, day: d } : null;
};

/**
 * The first full date in a piece of Studio text, in any of the shapes it prints.
 * A date without a year is not a date: "Oct 16" could be this year's or next's.
 */
export function parseStudioDate(raw: string, slashOrder: "dmy" | "mdy" = "mdy"): ParsedDate | null {
  const text = clean(raw);

  const mdy = new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i").exec(text);
  if (mdy) return real(Number(mdy[3]), monthIndex(mdy[1]), Number(mdy[2]));

  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORD},?\\s+(\\d{4})\\b`, "i").exec(text);
  if (dmy) return real(Number(dmy[3]), monthIndex(dmy[2]), Number(dmy[1]));

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return real(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(text);
  if (slash) {
    return slashOrder === "dmy"
      ? real(Number(slash[3]), Number(slash[2]), Number(slash[1]))
      : real(Number(slash[3]), Number(slash[1]), Number(slash[2]));
  }

  return null;
}

/**
 * The first time of day in a piece of Studio text, as minutes since midnight.
 * "5:00 AM", "5 PM", "17:00" and "5:00 a.m." are all understood; "12:00 AM" is midnight.
 */
export function parseStudioTime(raw: string): number | null {
  const text = clean(raw);

  const twelve = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/i.exec(text);
  if (twelve) {
    const h = Number(twelve[1]);
    const m = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (h < 1 || h > 12 || m > 59) return null;
    return (h % 12) * 60 + (twelve[3].toLowerCase() === "p" ? 12 * 60 : 0) + m;
  }

  const twentyFour = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/.exec(text);
  if (twentyFour) return Number(twentyFour[1]) * 60 + Number(twentyFour[2]);

  return null;
}

/** The offset a "GMT+5:30" / "UTC-08:00" / "(GMT+05:30)" label stands for, in minutes; null if there is none. */
export function parseOffset(raw: string): number | null {
  const m = /\b(?:GMT|UTC)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?(?!\d)/i.exec(clean(raw));
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0);
  return m[1] === "-" ? -minutes : minutes;
}

/* ---------------------------------------------------------- the picker ---- */

/** What the date, time and time-zone parts of Studio's schedule section show. */
export interface PickerReading {
  dateText: string | null;
  timeText: string | null;
  /** Whatever near the pickers names the time zone, when Studio prints one. */
  zoneText: string | null;
}

export interface PickerVerdict {
  ok: boolean;
  problems: string[];
  /** The page itself named a zone and it was the right one. False when Studio printed none. */
  zoneVerified: boolean;
}

/** Whether the pickers now hold exactly the moment that was asked for. */
export function judgePicker(reading: PickerReading, target: StudioTarget): PickerVerdict {
  const problems: string[] = [];

  const date = reading.dateText ? parseStudioDate(reading.dateText, slashOrderOf(target.style)) : null;
  if (!date) {
    problems.push(`The schedule's date could not be read back${reading.dateText ? ` (it shows "${clean(reading.dateText).slice(0, 40)}")` : ""}.`);
  } else if (date.year !== target.year || date.month !== target.month || date.day !== target.day) {
    problems.push(`The schedule's date shows ${clean(reading.dateText ?? "").slice(0, 40)}, not ${target.dateText}.`);
  }

  const minutes = reading.timeText ? parseStudioTime(reading.timeText) : null;
  if (minutes === null) {
    problems.push(`The schedule's time could not be read back${reading.timeText ? ` (it shows "${clean(reading.timeText).slice(0, 40)}")` : ""}.`);
  } else if (minutes !== target.minutes) {
    problems.push(`The schedule's time shows ${clean(reading.timeText ?? "").slice(0, 40)}, not ${target.timeText}.`);
  }

  let zoneVerified = false;
  const shown = reading.zoneText ? parseOffset(reading.zoneText) : null;
  if (shown !== null) {
    if (shown !== target.offsetMinutes) {
      problems.push(`Studio is scheduling in ${gmtLabel(shown)}, but the time was worked out for ${target.gmtLabel}.`);
    } else {
      zoneVerified = true;
    }
  }

  return { ok: problems.length === 0, problems, zoneVerified };
}

/* ------------------------------------------------- what the channel says -- */

export interface ScheduledView {
  /** The words of the video's visibility area, or of its page if that area was not found. */
  text: string | null;
  title: string | null;
}

export interface ScheduledVerdict {
  /** The channel lists the video as Scheduled. */
  scheduled: boolean;
  /** It also shows the date and time that were asked for. Only this plus `scheduled` is a confirmation. */
  timeConfirmed: boolean;
  titleMatches: boolean;
  problems: string[];
  /** Nothing readable at all: the page did not load, or is not the one expected. */
  unreadable: boolean;
}

const squash = (s: string) => clean(s);

/**
 * Whether the video's own Studio page says it is scheduled for the asked-for moment.
 *
 * Stricter than the publish check on purpose. "Public" is one word that is either
 * there or not; "Scheduled" is only worth anything with its date and time, because
 * a video scheduled for the wrong moment is a video that goes public at the wrong
 * moment. So this returns two facts, and the caller needs both.
 */
export function judgeScheduledView(view: ScheduledView | null, want: { title: string; target: StudioTarget }): ScheduledVerdict {
  const text = squash(view?.text ?? "");
  if (!view || !text) {
    return {
      scheduled: false,
      timeConfirmed: false,
      titleMatches: false,
      problems: ["The video's Studio page could not be read, so the schedule is not confirmed."],
      unreadable: true,
    };
  }

  const problems: string[] = [];
  const word = /\bscheduled\b/i.exec(text);

  if (!word) {
    if (/\bdraft\b/i.test(text)) problems.push(`Studio still lists the video as a draft ("${text.slice(0, 60)}"), so it was not scheduled.`);
    else {
      const other = /\b(Public|Private|Unlisted)\b/i.exec(text);
      problems.push(
        other ? `Studio shows the visibility as ${other[1]}, not Scheduled.` : "Studio's page for the video does not say it is scheduled.",
      );
    }
    return { scheduled: false, timeConfirmed: false, titleMatches: titleMatches(view.title, want.title), problems, unreadable: false };
  }

  // The date and time sit beside the word, so read after it first; a page that
  // prints them elsewhere is still read, but only from the same area.
  const after = text.slice(word.index, word.index + 200);
  const date = parseStudioDate(after, slashOrderOf(want.target.style)) ?? parseStudioDate(text, slashOrderOf(want.target.style));
  const minutes = parseStudioTime(after) ?? parseStudioTime(text);

  let timeConfirmed = true;
  if (!date || minutes === null) {
    timeConfirmed = false;
    problems.push(`Studio lists the video as Scheduled but the date and time could not be read from the page ("${after.slice(0, 80)}").`);
  } else {
    if (date.year !== want.target.year || date.month !== want.target.month || date.day !== want.target.day) {
      timeConfirmed = false;
      problems.push(`Studio has it scheduled for a different date than the one asked for (wanted ${want.target.dateText}).`);
    }
    if (minutes !== want.target.minutes) {
      timeConfirmed = false;
      problems.push(`Studio has it scheduled for a different time than the one asked for (wanted ${want.target.timeText}).`);
    }
  }

  const shown = parseOffset(after);
  if (shown !== null && shown !== want.target.offsetMinutes) {
    timeConfirmed = false;
    problems.push(`Studio shows the schedule in ${gmtLabel(shown)}, not ${want.target.gmtLabel}.`);
  }

  const matches = titleMatches(view.title, want.title);
  if (!matches) problems.push(`Studio shows the title as "${squash(view.title ?? "").slice(0, 60)}", which is not the one that was approved.`);

  return { scheduled: true, timeConfirmed, titleMatches: matches, problems, unreadable: false };
}

function titleMatches(shown: string | null, wanted: string): boolean {
  // A title that could not be read is not a mismatch; one that was read and differs is.
  if (!shown || !squash(shown)) return true;
  return squash(shown).toLowerCase().includes(squash(wanted).slice(0, 40).toLowerCase());
}

/* ------------------------------------------------------------- the API ---- */

export interface ApiScheduleVerdict {
  confirmed: boolean;
  /** The platform's own words for what it stored. */
  platformStatus: string;
  publishAt: Date | null;
  problems: string[];
}

/**
 * Whether YouTube's upload response says the video is held for the asked-for moment.
 *
 * A scheduled upload is stored private with a `publishAt`; a response without it,
 * or with another time, means YouTube did not take the schedule. That is the case
 * for a project Google has not audited, whose uploads are locked private whatever
 * was asked - so the response is read instead of being trusted for its id.
 */
export function judgeApiSchedule(
  status: { privacyStatus?: string; publishAt?: string } | undefined,
  want: Date,
): ApiScheduleVerdict {
  const problems: string[] = [];
  const got = status?.publishAt ? new Date(status.publishAt) : null;
  const valid = got && Number.isFinite(got.getTime()) ? got : null;

  if (!valid) {
    problems.push(
      `YouTube's response carries no publish time (visibility "${status?.privacyStatus ?? "unknown"}"), so it did not take the schedule. ` +
        "An upload from a project Google has not audited is locked private whatever is asked for.",
    );
  } else if (Math.abs(valid.getTime() - want.getTime()) > 1000) {
    problems.push(`YouTube stored a different publish time (${valid.toISOString()}) than the one asked for (${want.toISOString()}).`);
  }
  if (status?.privacyStatus && status.privacyStatus !== "private") {
    problems.push(`YouTube stored the visibility as "${status.privacyStatus}", but a scheduled video is held private until its time.`);
  }

  return {
    confirmed: problems.length === 0,
    platformStatus: problems.length === 0 ? "scheduled (private until publishAt)" : status?.privacyStatus ?? "unknown",
    publishAt: valid,
    problems,
  };
}

/** Which engine carries a native schedule: the API when a channel is connected, Studio's own page when not. */
export function nativeEngineFor(opts: { hasConnectedChannel: boolean }): "api" | "browser" {
  return opts.hasConnectedChannel ? "api" : "browser";
}

/* ------------------------------------------------------------- the gate ---- */

export interface NativeGateInput {
  /** The visibility the post was approved with. */
  privacy: string;
  goLive: Date | null;
  now: Date;
  zone: string;
  /** The thumbnail file that was chosen for this video, when there is one that exists. */
  thumbnailFile: string | null;
  thumbnailExists: boolean;
}

export type NativeGate = { ok: true } | { ok: false; problems: string[] };

/**
 * Everything a native schedule needs, checked before a browser is opened.
 *
 * Each missing piece is reported rather than patched over: a scheduled video that
 * goes public later without the thumbnail that was picked for it, or at a time
 * nobody chose, cannot be put right once it is out. All the problems are returned
 * together so the operator fixes them in one pass.
 */
export function nativeGate(i: NativeGateInput): NativeGate {
  const problems: string[] = [];

  if (i.privacy !== "public") {
    problems.push(
      `A scheduled YouTube video is published publicly at its time, but this post is set to ${i.privacy}. Nothing was scheduled.`,
    );
  }

  const time = checkGoLive(i.goLive, i.now, i.zone);
  if (!time.ok) problems.push(time.message);

  if (!i.thumbnailFile) {
    problems.push("No thumbnail is chosen for this video, and a scheduled video needs one. Pick one on the video's card. Nothing was scheduled.");
  } else if (!i.thumbnailExists) {
    problems.push("The thumbnail chosen for this video is no longer on disk. Pick one on the video's card. Nothing was scheduled.");
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}
