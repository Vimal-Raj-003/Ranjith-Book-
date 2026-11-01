/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import type { PublishLog } from "../types";
import { humanClick, pause } from "./actions";
import { localParts } from "../../schedule/reference-time";
import { appendFileSync, mkdirSync } from "node:fs";

/**
 * The Schedule part of Instagram's "New reel" screen, driven and read back.
 *
 * From the real screen (the operator's screenshots):
 *  - a "Schedule content" row with a `[role="switch"]`; turning it on reveals two fields.
 *  - "Date", a control that shows the day it is set to ("Sat, 17 Oct 2026").
 *  - "Time", a text box holding a 24-hour time ("15:32").
 *  - the top-right button then reads "Schedule" instead of "Share".
 *
 * Nothing here is found by position. The switch is reached from its own label text
 * (the same way the AI-label switch is), the date and time by their field labels, and
 * the final button by its exact word. Every step reads back what it did, and the caller
 * presses the final button only on a clean read-back and never presses "Share".
 *
 * Instagram shows no time-zone control, so the wall time is worked out in the schedule's
 * own zone; the browser is launched in that zone, which is the time Instagram reads.
 */

const SEEN = "data-rr-ig-sched";

/** A peek at the schedule fields, on only when BOOKREEL_IG_SCHED_DEBUG names a folder. */
async function igShot(page: Page, name: string): Promise<void> {
  const dir = process.env.BOOKREEL_IG_SCHED_DEBUG;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/ig-sched-${name}.png` }).catch(() => {});
    const text = await page
      .evaluate(() => {
        const d = document.querySelector('div[role="dialog"]') as HTMLElement | null;
        return ((d ? d.innerText : document.body.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 2500);
      })
      .catch(() => "");
    appendFileSync(`${dir}/ig-sched-dump.txt`, `\n=== ${name} ===\n${text}\n`);
  } catch {
    /* diagnostics must never affect the run */
  }
}

export interface ReelTarget {
  year: number;
  month: number;
  day: number;
  /** 24-hour HH:mm, kept for logging. */
  timeText: string;
  /** 12-hour, as Instagram's Time box shows it, e.g. "3:32 PM". */
  timeText12: string;
  /** Minutes past midnight, for comparing a read-back in either clock. */
  minutes: number;
  /** YYYY-MM-DD, for logging. */
  date: string;
  /** The month's short name, e.g. "Oct", for matching and for the picker. */
  monthShort: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** What to type/pick for a go-live instant, worked out in the schedule's own zone. */
export function reelScheduleTarget(instant: Date, zone: string): ReelTarget {
  const { date, time } = localParts(instant, zone);
  const [year, month, day] = date.split("-").map(Number);
  const [h24, mi] = time.split(":").map(Number);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    year, month, day,
    timeText: time,
    timeText12: `${h12}:${String(mi).padStart(2, "0")} ${ampm}`,
    minutes: h24 * 60 + mi,
    date,
    monthShort: MONTHS[month - 1],
  };
}

/** Minutes past midnight from a clock string, 24-hour or 12-hour (AM/PM), or null. */
export function parseClock(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2})\s*:\s*(\d{2})\s*([AaPp])\.?\s*[Mm]\.?/) ?? raw.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const ap = m[3]?.toUpperCase();
  if (ap === "P" && h < 12) h += 12;
  if (ap === "A" && h === 12) h = 0;
  return h * 60 + mi;
}

/** Whether a read-back date string is the target day: its day, month name and year all appear. */
export function dateMatches(shown: string | null, target: ReelTarget): boolean {
  if (!shown) return false;
  const t = shown.replace(/\s+/g, " ").trim();
  const dayRe = new RegExp(`\\b0?${target.day}\\b`);
  return dayRe.test(t) && new RegExp(target.monthShort, "i").test(t) && t.includes(String(target.year));
}

/* ------------------------------------------------------------- the toggle -- */

/** Where the "Schedule content" switch sits among all the switches on the page. */
export async function scheduleSwitchIndex(page: Page): Promise<number | null> {
  return page
    .evaluate(() => {
      const all = [...document.querySelectorAll('[role="switch"]')];
      const label = [...document.querySelectorAll("span,div,label")].find(
        (el) => el.children.length === 0 && /^\s*schedule content\s*$/i.test(el.textContent ?? ""),
      );
      if (!label) return -1;
      let node: HTMLElement | null = label.parentElement;
      for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
        const found = node.querySelectorAll('[role="switch"]');
        if (found.length === 1) return all.indexOf(found[0]);
      }
      return -1;
    })
    .then((i) => (i >= 0 ? i : null))
    .catch(() => null);
}

const switchIsOn = async (page: Page, index: number): Promise<boolean> =>
  (await page.locator('[role="switch"]').nth(index).getAttribute("aria-checked").catch(() => null)) === "true";

/** Turn "Schedule content" on, and wait for the Date/Time fields it reveals. Returns whether it is on. */
export async function enableScheduleContent(page: Page, log: PublishLog): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const index = await scheduleSwitchIndex(page);
    if (index === null) {
      log("Schedule: no “Schedule content” toggle on this screen");
      return false;
    }
    if (await switchIsOn(page, index)) {
      log(attempt === 1 ? "Schedule: content toggle already ON" : "Schedule: content toggle verified ON");
    } else {
      log(attempt === 1 ? "Schedule: turning the content toggle ON" : "Schedule: toggle still OFF — trying once more");
      await page.locator('[role="switch"]').nth(index).click({ timeout: 10_000 });
      await pause(1000, 1800);
      if (!(await switchIsOn(page, index))) continue;
      log("Schedule: content toggle verified ON");
    }
    // The Date and Time fields arrive as the toggle turns on.
    for (let i = 0; i < 20; i++) {
      if (await scheduleFieldsPresent(page)) {
        await igShot(page, "01-fields-open");
        return true;
      }
      await page.waitForTimeout(400);
    }
    return true;
  }
  log("Schedule: the content toggle could not be turned on");
  return false;
}

/** The Date field (shows a date) and the Time field (a 24-hour time) are both on screen. */
async function scheduleFieldsPresent(page: Page): Promise<boolean> {
  return (await markTimeInput(page)) && (await markDateControl(page));
}

/* ----------------------------------------------------------- the fields -- */

/** Mark the Time box: an input or small element holding a time (12- or 24-hour), inside the dialog. */
async function markTimeInput(page: Page): Promise<boolean> {
  return page
    .evaluate((attr) => {
      for (const old of document.querySelectorAll(`[${attr}="time"]`)) old.removeAttribute(attr);
      const root = document.querySelector('div[role="dialog"]') || document.body;
      const timeRe = /\b\d{1,2}\s*:\s*\d{2}\s*(?:[AaPp]\.?\s*[Mm]\.?)?\b/;
      // Instagram's Time is three role="spinbutton" segments (Hours, Minutes, AM/PM): mark the
      // smallest element that holds the Hours and Minutes ones.
      let host: HTMLElement | null = null;
      let hostArea = Infinity;
      for (const el of root.querySelectorAll("div,span")) {
        const h = el as HTMLElement;
        if (h.getClientRects().length === 0) continue;
        const spins = [...h.querySelectorAll('[role="spinbutton"]')];
        if (spins.length < 2 || spins.length > 4) continue;
        const labels = spins.map((s) => (s.getAttribute("aria-label") || "").toLowerCase()).join(" ");
        if (!/hour/.test(labels) || !/min/.test(labels)) continue;
        const r = h.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 0 && area < hostArea) {
          host = h;
          hostArea = area;
        }
      }
      if (host) {
        host.setAttribute(attr, "time");
        return true;
      }
      // A plain input next: some builds show "05:33 PM" in one text box.
      const input = [...root.querySelectorAll("input")].find(
        (i) => timeRe.test((i as HTMLInputElement).value || "") || /time/i.test(i.getAttribute("aria-label") || i.getAttribute("name") || ""),
      );
      if (input) {
        (input as HTMLElement).setAttribute(attr, "time");
        return true;
      }
      // Otherwise the smallest element whose text is a time.
      let best: HTMLElement | null = null;
      let bestArea = Infinity;
      for (const el of root.querySelectorAll("div,span,button,[role='button'],[role='textbox']")) {
        const h = el as HTMLElement;
        if (h.getClientRects().length === 0) continue;
        const txt = (h.innerText || "").replace(/\s+/g, " ").trim();
        if (txt.length > 16 || !timeRe.test(txt)) continue;
        const r = h.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 0 && area < bestArea) {
          best = h;
          bestArea = area;
        }
      }
      if (best) best.setAttribute(attr, "time");
      return !!best;
    }, SEEN)
    .catch(() => false);
}

/** Mark the Date control: the element that shows the set date (a button/input near a "Date" label). */
async function markDateControl(page: Page): Promise<boolean> {
  return page
    .evaluate(
      ({ attr, months }) => {
        for (const old of document.querySelectorAll(`[${attr}="date"]`)) old.removeAttribute(attr);
        const root = document.querySelector('div[role="dialog"]') || document.body;
        const dateRe = new RegExp(`\\b\\d{1,2}\\s+(${months})\\s+\\d{4}\\b|\\b(${months})\\s+\\d{1,2},?\\s+\\d{4}\\b`, "i");
        // A date input first (its value is the date), else the smallest element whose text is a date.
        const input = [...root.querySelectorAll("input")].find(
          (i) => dateRe.test((i as HTMLInputElement).value || "") || /date/i.test(i.getAttribute("aria-label") || i.getAttribute("name") || ""),
        );
        if (input) {
          (input as HTMLElement).setAttribute(attr, "date");
          return true;
        }
        let best: HTMLElement | null = null;
        let bestArea = Infinity;
        for (const el of root.querySelectorAll("div,span,button,[role='button']")) {
          const h = el as HTMLElement;
          if (h.getClientRects().length === 0) continue;
          const txt = (h.innerText || "").replace(/\s+/g, " ").trim();
          if (txt.length > 40 || !dateRe.test(txt)) continue;
          const r = h.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > 0 && area < bestArea) {
            best = h;
            bestArea = area;
          }
        }
        if (best) best.setAttribute(attr, "date");
        return !!best;
      },
      { attr: SEEN, months: MONTHS.join("|") },
    )
    .catch(() => false);
}

const marked = (kind: "time" | "date") => `[${SEEN}="${kind}"]`;

/** The value or text the Time box holds now. */
async function timeValue(page: Page): Promise<string | null> {
  if (!(await markTimeInput(page))) return null;
  const el = page.locator(marked("time")).first();
  const v = (await el.inputValue().catch(() => "")) || (await el.innerText().catch(() => ""));
  return v.replace(/\s+/g, " ").trim() || null;
}

/** The value or text the Date control shows now. */
async function dateShown(page: Page): Promise<string | null> {
  if (!(await markDateControl(page))) return null;
  const el = page.locator(marked("date")).first();
  const v = (await el.inputValue().catch(() => "")) || (await el.innerText().catch(() => ""));
  return v.replace(/\s+/g, " ").trim() || null;
}

/** The first spinbutton in the container whose aria-label matches, or null. */
async function spinByLabel(container: ReturnType<Page["locator"]>, re: RegExp): Promise<ReturnType<Page["locator"]> | null> {
  const spins = container.locator('[role="spinbutton"]');
  const n = await spins.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const label = await spins.nth(i).getAttribute("aria-label").catch(() => "");
    if (label && re.test(label)) return spins.nth(i);
  }
  return null;
}

/** Focus a spinbutton and type its digits (it accumulates two digits for the minute). */
async function typeSpin(page: Page, loc: ReturnType<Page["locator"]>, digits: string): Promise<void> {
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await loc.click({ timeout: 8_000 }).catch(() => {});
  await pause(150, 300);
  for (const ch of digits) {
    await page.keyboard.type(ch);
  }
  await pause(200, 350);
}

/**
 * Set Instagram's Time, which is three `role="spinbutton"` segments (Hours, Minutes, AM/PM),
 * not a text box — typing a string into the box does nothing. Each segment is focused and set,
 * and the read-back is what proves it took.
 */
export async function setReelTime(page: Page, target: ReelTarget, log: PublishLog): Promise<void> {
  log(`Schedule: setting the time to ${target.timeText12}`);
  if (!(await markTimeInput(page))) throw new Error("the time box is not on the screen");
  const container = page.locator(marked("time")).first();
  const m = target.timeText12.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) throw new Error(`cannot read the target time "${target.timeText12}"`);
  const [, hh, mm, ap] = m;

  const spins = container.locator('[role="spinbutton"]');
  const count = await spins.count().catch(() => 0);
  if (process.env.BOOKREEL_IG_SCHED_DEBUG) {
    const labels = await spins
      .evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-label")}=${e.getAttribute("aria-valuenow") ?? e.getAttribute("aria-valuetext") ?? (e as HTMLInputElement).value}`))
      .catch(() => []);
    log(`Schedule[debug]: ${count} spinbuttons: ${JSON.stringify(labels)}`);
  }

  const hours = (await spinByLabel(container, /hour/i)) ?? spins.nth(0);
  const minutes = (await spinByLabel(container, /min/i)) ?? spins.nth(1);
  const period = (await spinByLabel(container, /am\s*\/?\s*pm|period|meridiem/i)) ?? spins.nth(Math.max(0, count - 1));

  await typeSpin(page, hours, String(Number(hh)));
  await typeSpin(page, minutes, mm);

  // AM/PM: set only if it is not already the target, by its letter, then by stepping if needed.
  await period.click({ timeout: 8_000 }).catch(() => {});
  await pause(120, 250);
  const cur = (await period.getAttribute("aria-valuetext").catch(() => null)) || (await period.getAttribute("aria-valuenow").catch(() => null)) || "";
  if (!new RegExp(ap, "i").test(String(cur))) {
    await page.keyboard.type(ap[0]);
    await pause(150, 300);
    const now = (await period.getAttribute("aria-valuetext").catch(() => null)) || "";
    if (!new RegExp(ap, "i").test(String(now))) {
      await page.keyboard.press("ArrowUp").catch(() => {});
      await pause(150, 300);
    }
  }
  await igShot(page, "02-time-set");
}

/**
 * Set the Date to the target day.
 *
 * A date input takes it typed; a date that opens a picker is set by choosing the day in
 * the picker's grid for the target month. The exact picker is tuned against the live
 * screen; this is the shape most pickers take.
 */
export async function setReelDate(page: Page, target: ReelTarget, log: PublishLog): Promise<void> {
  log(`Schedule: setting the date to ${target.day} ${target.monthShort} ${target.year}`);
  if (!(await markDateControl(page))) throw new Error("the date control is not on the screen");
  const control = page.locator(marked("date")).first();

  // A plain date input: type it. (The read-back is what proves it took.)
  const tag = await control.evaluate((el) => el.tagName).catch(() => "");
  if (tag === "INPUT") {
    await control.click({ timeout: 8_000 }).catch(() => {});
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(`${target.day} ${target.monthShort} ${target.year}`);
    await page.keyboard.press("Enter");
    await pause(300, 600);
    if (dateMatches(await dateShown(page), target)) {
      await igShot(page, "03-date-set");
      return;
    }
  }

  // Otherwise open the control and choose the day in the month grid.
  await control.click({ timeout: 8_000 }).catch(() => {});
  await pause(600, 1000);
  await igShot(page, "03-date-picker");
  const chose = await page
    .evaluate(
      ({ attr, day }) => {
        for (const old of document.querySelectorAll(`[${attr}="day"]`)) old.removeAttribute(attr);
        // The day cell: an element whose whole text is the day number, not disabled.
        const cells = [...document.querySelectorAll('[role="option"],[role="gridcell"],button,td,div,span')].filter((e) => {
          const h = e as HTMLElement;
          if (h.getClientRects().length === 0) return false;
          return new RegExp(`^${day}$`).test((h.innerText || "").trim());
        }) as HTMLElement[];
        const wanted = cells.find((c) => !c.closest('[aria-disabled="true"],[disabled]'));
        if (wanted) wanted.setAttribute(attr, "day");
        return !!wanted;
      },
      { attr: SEEN, day: target.day },
    )
    .catch(() => false);
  if (chose) {
    await page.locator(`[${SEEN}="day"]`).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await humanClick(page, `[${SEEN}="day"]`).catch(() => {});
    await pause(400, 800);
  }
  await igShot(page, "03-date-set");
}

export interface ReelScheduleVerdict {
  ok: boolean;
  problems: string[];
  reading: { dateText: string | null; timeText: string | null };
}

/** Read the Date and Time back and judge them against the target. */
export async function readReelSchedule(page: Page): Promise<{ dateText: string | null; timeText: string | null }> {
  return { dateText: await dateShown(page), timeText: await timeValue(page) };
}

export function judgeReelSchedule(reading: { dateText: string | null; timeText: string | null }, target: ReelTarget): ReelScheduleVerdict {
  const problems: string[] = [];
  if (!dateMatches(reading.dateText, target)) {
    problems.push(`The schedule's date reads back as ${reading.dateText ? `"${reading.dateText}"` : "nothing"}, not ${target.day} ${target.monthShort} ${target.year}.`);
  }
  if (parseClock(reading.timeText) !== target.minutes) {
    problems.push(`The schedule's time reads back as ${reading.timeText ? `"${reading.timeText}"` : "nothing"}, not ${target.timeText12}.`);
  }
  return { ok: problems.length === 0, problems, reading };
}

/* ------------------------------------------------------- the final button -- */

const BTN = "data-rr-ig-btn";

/** Find a dialog button whose whole text is `label`, tag it, and say whether it is enabled. */
async function findButton(page: Page, label: string): Promise<{ found: boolean; enabled: boolean }> {
  return page
    .evaluate(
      ({ mark, want }) => {
        for (const stale of document.querySelectorAll(`[${mark}]`)) stale.removeAttribute(mark);
        const buttons = [...document.querySelectorAll('div[role="dialog"] [role="button"], div[role="dialog"] button')];
        const re = new RegExp(`^\\s*${want}\\s*$`, "i");
        const hit = buttons.find((b) => re.test((b as HTMLElement).innerText || b.textContent || ""));
        if (!hit) return { found: false, enabled: false };
        hit.setAttribute(mark, "1");
        const disabled = hit.getAttribute("aria-disabled") === "true" || (hit as HTMLButtonElement).disabled === true;
        return { found: true, enabled: !disabled };
      },
      { mark: BTN, want: label },
    )
    .catch(() => ({ found: false, enabled: false }));
}

/** Whether the top-right button now reads "Schedule" (not "Share"). */
export async function scheduleButtonReady(page: Page): Promise<boolean> {
  const s = await findButton(page, "Schedule");
  return s.found && s.enabled;
}

/** Press Schedule. Throws, without pressing, when the button is not there or not enabled. Never presses Share. */
export async function pressSchedule(page: Page, log: PublishLog): Promise<void> {
  const deadline = Date.now() + 60_000;
  let state = await findButton(page, "Schedule");
  while (!(state.found && state.enabled) && Date.now() < deadline) {
    await page.waitForTimeout(1500);
    state = await findButton(page, "Schedule");
  }
  if (!state.found) {
    throw new Error('The "Schedule" button is not on the page, so nothing was scheduled. The reel is filled in in the open window.');
  }
  if (!state.enabled) {
    throw new Error('Instagram kept the "Schedule" button disabled, so nothing was scheduled. The reel is filled in in the open window.');
  }
  log("Pressing Schedule");
  await humanClick(page, `[${BTN}="1"]`);
}

export { igShot };
