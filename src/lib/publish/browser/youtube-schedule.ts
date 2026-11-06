/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import type { PublishLog } from "../types";
import { humanClick, pause } from "./actions";
import {
  describeTarget,
  detectPickerStyle,
  judgePicker,
  parseOffset,
  parseStudioDate,
  parseStudioTime,
  slashOrderOf,
  studioTarget,
  studioTargetAtOffset,
  type PickerReading,
  type PickerStyle,
  type PickerVerdict,
  type ScheduledView,
  type StudioTarget,
} from "../native-schedule";
import { offsetMinutesAt } from "../../schedule/reference-time";
import { appendFileSync, mkdirSync } from "node:fs";

/**
 * A diagnostic peek at the Schedule card, on only when BOOKREEL_YT_SCHED_DEBUG names a folder.
 * It screenshots and dumps the card's text so a selector or layout change can be seen
 * without guessing. Off by default; nothing is captured and no files are written.
 */
async function schedShot(page: Page, name: string): Promise<void> {
  const dir = process.env.BOOKREEL_YT_SCHED_DEBUG;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/sched-${name}.png` }).catch(() => {});
    const text = await page
      .evaluate(() => {
        const d = document.querySelector("ytcp-uploads-dialog") as HTMLElement | null;
        return ((d ? d.innerText : document.body.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 2500);
      })
      .catch(() => "");
    appendFileSync(`${dir}/sched-dump.txt`, `\n=== ${name} ===\n${text}\n`);
  } catch {
    /* diagnostics must never affect the run */
  }
}

/**
 * The Schedule part of YouTube Studio's Visibility screen, driven and read back.
 *
 * Written from the screens of the real Studio, which differ in ways that matter from
 * what this was first written against:
 *
 *  - "Save or publish" and "Schedule" are two cards of an accordion. Opening Schedule
 *    CLOSES "Save or publish", so Public has to be chosen first (the caller does) and
 *    can only be re-read afterwards from the button and from "Schedule as public".
 *  - The open Schedule card shows a date control ("16 Oct 2026"), a time box ("00:00",
 *    with a list of quarter hours), a "Time zone" button and the words "Video will be
 *    private before publishing". The final button then reads "Schedule".
 *  - Dates and times are written in the account's language: the Studio observed is
 *    English (UK), so 16 Oct 2026 and 24-hour times. What is typed is written in whatever
 *    shape the page is showing (see detectPickerStyle).
 *  - The date control opens a calendar with a text box (the date typed in) and a grid of
 *    days grouped by month.
 *
 * None of the element ids are relied on. The controls are found by what they say and
 * what they hold (the date, the time, "Time zone"), marked on the page, and then clicked
 * like any other element - never by position on the screen. Every step reads back what it
 * did, and the caller presses the final button only on a clean report.
 */

/** A date as Studio writes it, in any of its styles. */
const DATE_RE =
  "^(?:\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4})$";
/** A time of day as Studio writes it: 05:39 or 5:39 AM. */
const TIME_RE = "^\\d{1,2}:\\d{2}(?:\\s?[AaPp]\\.?\\s?[Mm]\\.?)?$";

/** Kept for the older layout: a control with this id is still tried before the text search. */
export const SCHEDULE_SELECTORS = {
  expand: "#second-container-expand-button, ytcp-video-visibility-select #second-container-expand-button",
} as const;

/** What a popup, menu or dialog looks like in Studio's markup. */
const POPUP = "tp-yt-paper-dialog, ytcp-dialog, [role=dialog], [role=listbox], [role=menu], tp-yt-iron-dropdown, ytcp-text-menu, [aria-modal=true]";
const SEEN = "data-rr-seen";

type MarkKind = "schedule-header" | "save-header" | "date-trigger" | "time-input" | "calendar-input" | "zone-button";

const MARK = "data-rr-sched";
const marked = (kind: MarkKind) => `[${MARK}="${kind}"]`;

/**
 * Find one control by what it says or holds, and mark it so it can be clicked.
 *
 * Nothing in here may declare a named function: the transpiler rewrites those into a
 * helper the page does not have. Everything is inlined, and the smallest matching element
 * wins, which is the control itself and not a card that contains it.
 */
async function mark(page: Page, kind: MarkKind): Promise<boolean> {
  return page
    .evaluate(
      ({ kind, dateRe, timeRe, attr }) => {
        for (const old of document.querySelectorAll(`[${attr}]`)) {
          if (old.getAttribute(attr) === kind) old.removeAttribute(attr);
        }
        const dRe = new RegExp(dateRe, "i");
        // The control may carry a little more than the date (a label, an arrow): the date only has to be in short text.
        const dFind = new RegExp(dateRe.replace(/^\^/, "").replace(/\$$/, ""), "i");
        const tRe = new RegExp(timeRe, "i");
        const root = document.querySelector("ytcp-uploads-dialog") || document.body;
        const all = kind === "calendar-input" ? document.querySelectorAll("input") : root.querySelectorAll("*");

        let best: HTMLElement | null = null;
        let bestArea = Infinity;
        for (const el of all) {
          const h = el as HTMLElement;
          if (h.getClientRects().length === 0) continue;
          const r = h.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;

          let ok = false;
          if (kind === "time-input") {
            ok = h.tagName === "INPUT" && tRe.test(((h as HTMLInputElement).value || "").trim());
          } else if (kind === "calendar-input") {
            ok = h.tagName === "INPUT" && dRe.test(((h as HTMLInputElement).value || "").trim());
          } else {
            const txt = (h.innerText || "").replace(/\s+/g, " ").trim();
            if (kind === "date-trigger") ok = h.tagName !== "INPUT" && txt.length < 40 && dFind.test(txt) && r.height <= 90 && r.width <= 320;
            else if (kind === "zone-button") ok = /^time zone$/i.test(txt) && r.height <= 90;
            else if (kind === "save-header") ok = /^save or publish\b/i.test(txt) && /make your video/i.test(txt) && txt.length <= 160 && r.height >= 20 && r.height <= 160;
            else ok = /^schedule\b/i.test(txt) && /select a date to make your video/i.test(txt) && txt.length <= 160 && r.height >= 20 && r.height <= 160;
          }
          if (!ok) continue;
          const area = r.width * r.height;
          if (area < bestArea) {
            best = h;
            bestArea = area;
          }
        }
        if (best) best.setAttribute(attr, kind);
        return !!best;
      },
      { kind, dateRe: DATE_RE, timeRe: TIME_RE, attr: MARK },
    )
    .catch(() => false);
}

/** Click what `mark` found, the way a person would. */
async function clickMarked(page: Page, kind: MarkKind): Promise<void> {
  await page.locator(marked(kind)).first().scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
  await humanClick(page, marked(kind));
}

/** How many modal scrims are visible: a nested overlay is open over the card while any are. */
export async function visibleScrims(page: Page): Promise<number> {
  return page
    .locator(".dialog-scrim, tp-yt-iron-overlay-backdrop[opened], tp-yt-iron-overlay-backdrop.opened")
    .evaluateAll((els) => {
      const root = document.querySelector("ytcp-uploads-dialog, ytcp-video-metadata-editor");
      const anchors = [...document.querySelectorAll('[data-rr-sched="date-trigger"], [data-rr-sched="time-input"]')];
      if (root) anchors.push(root);
      const points = anchors.flatMap(el => {
        const r = el.getBoundingClientRect();
        return r.width && r.height ? [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 4, r.top + 4], [r.right - 4, r.bottom - 4]] : [];
      });
      return els.filter(el => {
        const h = el as HTMLElement, style = getComputedStyle(h);
        if (!h.getClientRects().length || style.visibility === "hidden" || style.pointerEvents === "none") return false;
        // Keep the upload dialog's own backdrop; dismiss only nested pickers
        // that actually cover its controls.
        return !root || points.some(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === el || el.contains(hit));
        });
      }).length;
    })
    .catch(() => 0);
}

/**
 * Close any nested overlay covering the Schedule card, and wait for its scrim to go.
 *
 * Each control on the card — the date calendar, the time list, the time-zone picker —
 * opens its own overlay, and while one is open a transparent scrim covers everything
 * behind it and swallows clicks. That is why setting the time after the date failed: the
 * calendar's scrim was still up over the time box, so the click never reached it. Escape
 * closes the overlay (the upload dialog itself has no Escape-to-discard) and is pressed
 * only while a scrim is actually there, so it can never dismiss the whole upload.
 */
export async function settleNoOverlay(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if ((await visibleScrims(page)) === 0) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
  if (await visibleScrims(page)) throw new Error("Studio's scheduling picker still blocks the controls after four Escape attempts. Check the open picker; no further controls were pressed.");
}

/** The zone Studio's picker works in by default: the browser's own. Read from the page, never assumed. */
export async function browserZone(page: Page): Promise<string> {
  return page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/* ------------------------------------------------------------ the section -- */

/** Whether the Schedule card is open: its date control and its time box are both on screen. */
export async function scheduleSectionOpen(page: Page): Promise<boolean> {
  return (await mark(page, "date-trigger")) && (await mark(page, "time-input"));
}

/** What the open dialog says, whole: for noticing "Schedule as public" and for the log. */
async function dialogText(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const d = document.querySelector("ytcp-uploads-dialog") as HTMLElement | null;
      return ((d ? d.innerText : document.body.innerText) || "").replace(/\s+/g, " ").trim();
    })
    .catch(() => "");
}

/**
 * Open the "Save or publish" card when the Visibility screen is up but its radios are not.
 *
 * The two cards are an accordion, so the radios are only on screen while this card is open:
 * it is open when the screen arrives, and closed again by anything that opened the Schedule
 * card before. Returns true if it pressed the header, so the caller can look again.
 */
export async function openSaveOrPublish(page: Page, log: PublishLog): Promise<boolean> {
  // The card's header names itself ("Save or publish" / "Make your video public, unlisted or private"),
  // which is on the Visibility screen and nowhere else, so finding it is the test that we are there.
  if (!(await mark(page, "save-header"))) return false;
  log('Visibility: opening the "Save or publish" card');
  await clickMarked(page, "save-header").catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

/** Open the Schedule card if it is not open, and say whether it now is. */
export async function openScheduleSection(page: Page, log: PublishLog): Promise<boolean> {
  if (await scheduleSectionOpen(page)) {
    log("Schedule: the card is already open");
    return true;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    // The older layout had an id for it; the text search is the rule now.
    const legacy = (await page.locator(SCHEDULE_SELECTORS.expand).count().catch(() => 0)) > 0;
    const found = legacy ? false : await mark(page, "schedule-header");
    if (!legacy && !found) {
      log(`Schedule: no "Schedule" card on this screen (try ${attempt})`);
      await page.waitForTimeout(1200);
      continue;
    }

    log(`Schedule: opening the card (try ${attempt})`);
    if (legacy) {
      await page.locator(SCHEDULE_SELECTORS.expand).first().scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
      await humanClick(page, SCHEDULE_SELECTORS.expand).catch(() => {});
    } else {
      await clickMarked(page, "schedule-header").catch(() => {});
    }

    // The card animates open and the "Save or publish" card closes as it does.
    for (let i = 0; i < 20; i++) {
      if (await scheduleSectionOpen(page)) return true;
      await page.waitForTimeout(400);
    }
  }
  return false;
}

/* ---------------------------------------------------------------- reading -- */

/** The date, time and time-zone words the card shows now. */
export async function readSchedulePicker(page: Page, zoneText: string | null = null): Promise<PickerReading> {
  const dateText = (await mark(page, "date-trigger"))
    ? await page.locator(marked("date-trigger")).first().innerText().then((t) => t.replace(/\s+/g, " ").trim()).catch(() => null)
    : null;
  const timeText = (await mark(page, "time-input"))
    ? await page.locator(marked("time-input")).first().inputValue().then((t) => t.trim()).catch(() => null)
    : null;
  return { dateText, timeText, zoneText };
}

/* ------------------------------------------------------------- time zone -- */

export interface StudioZone {
  /** The dialog was found and read. */
  read: boolean;
  /** What it names as the zone in use, e.g. "(GMT+05:30) India Standard Time". */
  label: string | null;
  offsetMinutes: number | null;
}

/**
 * Ask Studio which time zone it is scheduling in, by opening the "Time zone" button and
 * reading the zone it marks as chosen, then closing it again without changing anything.
 *
 * The dialog's layout has not been observed, so this is built to read what a zone list
 * almost always carries - a chosen item, or an input holding the zone - and to say plainly
 * when it cannot tell. It never selects a zone: changing it would change Studio's setting
 * for the account, and the right answer is to work out the time in the zone Studio has.
 */
export async function readStudioZone(page: Page, log: PublishLog): Promise<StudioZone> {
  if (!(await mark(page, "zone-button"))) {
    log("Time zone: no \"Time zone\" button on this screen");
    return { read: false, label: null, offsetMinutes: null };
  }

  // Everything dialog-like that is on screen now is remembered, so that what the button opens is
  // whatever is new afterwards - wherever in the page it is put, inside the upload dialog or beside it.
  await page
    .evaluate(
      ({ sel, attr }) => {
        for (const old of document.querySelectorAll(`[${attr}]`)) old.removeAttribute(attr);
        for (const d of document.querySelectorAll(sel)) {
          if ((d as HTMLElement).getClientRects().length > 0) d.setAttribute(attr, "before");
        }
      },
      { sel: POPUP, attr: SEEN },
    )
    .catch(() => {});

  try {
    await clickMarked(page, "zone-button");
  } catch (err) {
    log(`Time zone: could not open it (${(err as Error).message})`);
    return { read: false, label: null, offsetMinutes: null };
  }

  let seen: { present: boolean; text: string; chosen: string; inputs: string[] } = { present: false, text: "", chosen: "", inputs: [] };
  for (let i = 0; i < 12 && !seen.present; i++) {
    await page.waitForTimeout(400);
    seen = await page
      .evaluate(
        ({ sel, attr }) => {
          const fresh = [...document.querySelectorAll(sel)].filter(
            (d) => (d as HTMLElement).getClientRects().length > 0 && !d.hasAttribute(attr) && d.tagName.toLowerCase() !== "ytcp-uploads-dialog",
          ) as HTMLElement[];
          if (!fresh.length) return { present: false, text: "", chosen: "", inputs: [] as string[] };

          let text = "";
          let chosen = "";
          const inputs: string[] = [];
          for (const d of fresh) {
            text += " " + (d.innerText || "");
            for (const el of d.querySelectorAll("[aria-selected='true'], [aria-checked='true'], .iron-selected, [checked], [selected]")) {
              const t = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
              if (t && !chosen) chosen = t;
            }
            for (const i of d.querySelectorAll("input")) {
              const v = ((i as HTMLInputElement).value || "").trim();
              if (v) inputs.push(v);
            }
          }
          return { present: true, text: text.replace(/\s+/g, " ").trim(), chosen, inputs };
        },
        { sel: POPUP, attr: SEEN },
      )
      .catch(() => ({ present: false, text: "", chosen: "", inputs: [] as string[] }));
  }

  if (!seen.present) {
    await settleNoOverlay(page);
    log("Time zone: pressing the button showed no dialog to read");
    return { read: false, label: null, offsetMinutes: null };
  }

  // The chosen item, else an input that holds a zone, else a single offset on the whole dialog.
  let label: string | null = null;
  let offsetMinutes: number | null = null;
  for (const c of [seen.chosen, ...seen.inputs]) {
    const off = parseOffset(c);
    if (off !== null) {
      label = c.slice(0, 80);
      offsetMinutes = off;
      break;
    }
  }
  if (offsetMinutes === null) {
    const all = [...seen.text.matchAll(/(?:GMT|UTC)\s*[+-]\s*\d{1,2}(?::?\d{2})?/gi)].map((m) => m[0]);
    const distinct = [...new Set(all.map((a) => parseOffset(a)))].filter((n): n is number => n !== null);
    if (distinct.length === 1) {
      offsetMinutes = distinct[0];
      label = all[0];
    }
  }

  await schedShot(page, "zone-open");

  // Close the picker the way a person closes one they only read: by pressing Escape, never
  // by choosing anything. A visible scrim is the reliable sign a picker is still open — the
  // old check matched a hidden, permanently-present error dialog and so said "could not be
  // closed" on every run even though the picker had in fact gone.
  await settleNoOverlay(page);
  if ((await visibleScrims(page)) > 0) log("Time zone: a picker is still open over the card");
  await schedShot(page, "zone-closed");

  log(offsetMinutes === null ? `Time zone: the dialog was read but names no zone (it says: "${seen.text.slice(0, 120)}")` : `Time zone: Studio is scheduling in ${label}`);
  return { read: true, label, offsetMinutes };
}

/* ------------------------------------------------------------ entering it -- */

/** Replace a text box's contents with `text` and commit it. */
async function typeInto(page: Page, selector: string, text: string, commit: "Enter" | "Tab" = "Enter"): Promise<void> {
  await humanClick(page, selector);
  await pause(150, 350);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await pause(120, 260);
  await page.keyboard.type(text);
  await pause(200, 450);
  await page.keyboard.press(commit);
  await pause(500, 900);
}

/** The date shown on the control now, as a date, in the page's style. */
async function shownDate(page: Page, style: PickerStyle): Promise<{ y: number; m: number; d: number } | null> {
  const text = (await mark(page, "date-trigger")) ? await page.locator(marked("date-trigger")).first().innerText().catch(() => "") : "";
  const parsed = parseStudioDate(text, slashOrderOf(style));
  return parsed ? { y: parsed.year, m: parsed.month, d: parsed.day } : null;
}

const sameDay = (a: { y: number; m: number; d: number } | null, t: StudioTarget) => !!a && a.y === t.year && a.m === t.month && a.d === t.day;

/** Click the day in the calendar grid: the month's heading is found, and the day under it. */
async function clickDayInGrid(page: Page, target: StudioTarget): Promise<boolean> {
  const found = await page
    .evaluate(
      ({ year, month, day, attr }) => {
        for (const old of document.querySelectorAll(`[${attr}="day"]`)) old.removeAttribute(attr);
        const names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const everything = [...document.querySelectorAll("*")].filter((e) => (e as HTMLElement).getClientRects().length > 0) as HTMLElement[];
        const headings: { el: HTMLElement; y: number; m: number }[] = [];
        const cells: HTMLElement[] = [];
        for (const e of everything) {
          if (e.children.length > 0 && !/^(button|td|div|span)$/i.test(e.tagName)) continue;
          const t = (e.innerText || "").replace(/\s+/g, " ").trim();
          const mh = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(t);
          if (mh && names.indexOf(mh[1].slice(0, 3).toLowerCase()) >= 0 && e.children.length === 0) {
            headings.push({ el: e, y: Number(mh[2]), m: names.indexOf(mh[1].slice(0, 3).toLowerCase()) + 1 });
          } else if (/^\d{1,2}$/.test(t) && e.children.length === 0) cells.push(e);
        }
        let hit: HTMLElement | null = null;
        for (const c of cells) {
          if (Number((c.innerText || "").trim()) !== day) continue;
          if (c.closest("[disabled], [aria-disabled='true']")) continue;
          let owner: { y: number; m: number } | null = null;
          for (const h of headings) {
            if (h.el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) owner = h;
          }
          if (owner && owner.y === year && owner.m === month) {
            hit = c;
            break;
          }
        }
        if (hit) hit.setAttribute(attr, "day");
        return !!hit;
      },
      { year: target.year, month: target.month, day: target.day, attr: MARK },
    )
    .catch(() => false);
  if (!found) return false;
  await page.locator(`[${MARK}="day"]`).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await humanClick(page, `[${MARK}="day"]`).catch(() => {});
  await pause(500, 900);
  return true;
}

export async function setDate(page: Page, target: StudioTarget, log: PublishLog): Promise<void> {
  log(`Schedule: setting the date to ${target.dateText}`);
  if (!(await mark(page, "date-trigger"))) throw new Error("the date control is not on the screen");
  // Reading the zone can scroll this control offscreen. Bring it into view
  // before hit-testing the remaining overlay; offscreen hit-tests return null.
  await page.locator(marked("date-trigger")).first().scrollIntoViewIfNeeded({timeout:8000});
  await settleNoOverlay(page);
  await clickMarked(page, "date-trigger");

  // The calendar opens with a text box holding the date. Typing into it is the exact way in.
  let typed = false;
  for (let i = 0; i < 15 && !typed; i++) {
    typed = await mark(page, "calendar-input");
    if (!typed) await page.waitForTimeout(400);
  }
  if (typed) {
    await typeInto(page, marked("calendar-input"), target.dateText).catch((err) => log(`Schedule: could not type the date (${(err as Error).message})`));
  } else {
    log("Schedule: the calendar showed no text box for the date; choosing the day in its grid");
  }

  if (!sameDay(await shownDate(page, target.style), target)) {
    // Typing did not take, or there was nowhere to type: the grid is the other way in. Opened again if it closed.
    if (!(await mark(page, "calendar-input"))) {
      await mark(page, "date-trigger");
      await clickMarked(page, "date-trigger").catch(() => {});
      await page.waitForTimeout(700);
    }
    if (await clickDayInGrid(page, target)) log(`Schedule: chose ${target.day} in the calendar grid`);
  }
  // The calendar closes once a date is accepted; make sure its overlay and scrim are gone
  // before the next control, or the time box will be clicked through a scrim that eats it.
  await settleNoOverlay(page);
}

/** The value the time box holds now, re-finding it (its attribute is dropped when it re-renders). */
async function timeBoxValue(page: Page): Promise<string> {
  if (!(await mark(page, "time-input"))) return "";
  return (await page.locator(marked("time-input")).first().inputValue().catch(() => "")).trim();
}

/**
 * Type `text` into the time box and commit it.
 *
 * The box is a paper-input that RE-RENDERS when its value changes, dropping the
 * `data-rr-sched` mark — so a locator tied to that mark goes stale mid-edit (that is
 * why `pressSequentially` on it timed out). The way that survives: a reliable click to
 * focus the element while the mark is still there, then type with the page keyboard,
 * which goes to whatever is focused rather than to the (now unmarked) element.
 */
async function typeTime(page: Page, text: string, commit: "Enter" | "Tab"): Promise<void> {
  if (!(await mark(page, "time-input"))) throw new Error("the time box is not on the screen");
  const box = page.locator(marked("time-input")).first();
  await box.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
  await box.click({ timeout: 8_000 });
  await pause(150, 300);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await pause(120, 260);
  await page.keyboard.type(text);
  await pause(250, 450);
  await schedShot(page, `time-typed-${commit}`);
  await page.keyboard.press(commit);
  await pause(400, 700);
}

async function setTime(page: Page, target: StudioTarget, log: PublishLog): Promise<void> {
  log(`Schedule: setting the time to ${target.timeText}`);
  if (!(await mark(page, "time-input"))) throw new Error("the time box is not on the screen");

  // The date calendar leaves its scrim over this box; clear it or the click never lands.
  await settleNoOverlay(page);

  // Type the time and commit it with Enter, which is what accepts a typed time in Studio.
  // Only the committed value is read back: a box that rejects what is typed reverts it on
  // commit, so this does not mistake an uncommitted string for a time that was accepted.
  await typeTime(page, target.timeText, "Enter");
  const got = await timeBoxValue(page);
  log(`Schedule: after typing, the time box holds "${got}"`);
  if (parseStudioTime(got) === target.minutes) return;

  // Not taken: the box's own list is the other way in, for a time it offers (a quarter hour).
  // An off-grid minute it does not offer leaves this a no-op, and the mismatch is reported.
  const now = got;
  log(`Schedule: the time box holds "${now}" after typing; trying its list`);
  if (!(await mark(page, "time-input"))) return;
  await page.locator(marked("time-input")).first().click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
  const chose = await page
    .evaluate(
      ({ wanted, attr }) => {
        for (const old of document.querySelectorAll(`[${attr}="time-option"]`)) old.removeAttribute(attr);
        let best: HTMLElement | null = null;
        let bestArea = Infinity;
        for (const el of document.querySelectorAll("*")) {
          const h = el as HTMLElement;
          if (h.tagName === "INPUT" || h.getClientRects().length === 0) continue;
          const t = (h.innerText || "").replace(/\s+/g, " ").trim();
          if (t !== wanted && !t.startsWith(wanted + " ")) continue;
          const r = h.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > 0 && area < bestArea) {
            best = h;
            bestArea = area;
          }
        }
        if (best) best.setAttribute(attr, "time-option");
        return !!best;
      },
      { wanted: target.timeText, attr: MARK },
    )
    .catch(() => false);
  if (chose) {
    // The list scrolls; Playwright's scroll reaches an overflow container that a wheel event does not.
    await page.locator(`[${MARK}="time-option"]`).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await humanClick(page, `[${MARK}="time-option"]`).catch(() => {});
    await pause(400, 800);
  }
}

export interface AppliedSchedule extends PickerVerdict {
  reading: PickerReading;
  /** The moment as it was written for Studio: what the page was asked for. Null only when the card could not be opened. */
  target: StudioTarget | null;
  /** Whether Studio named the zone and it was the one used. */
  zoneRead: boolean;
}

/**
 * Put the scheduled moment into Studio's Schedule card and read it back.
 *
 * `instant` is the moment YouTube is to publish; this works out what to type from what
 * the page shows: its date and time style from the values it has now, and its time zone
 * from the "Time zone" button. Returns the verdict rather than throwing: whether a mismatch
 * is the end of the job or something a person can fix in the open window is the caller's.
 */
export async function applySchedule(page: Page, instant: Date, log: PublishLog): Promise<AppliedSchedule> {
  const none = { dateText: null, timeText: null, zoneText: null };
  if (!(await openScheduleSection(page, log))) {
    return { ok: false, zoneVerified: false, problems: ["Studio's Schedule card could not be opened, so no time could be set."], reading: none, target: null, zoneRead: false };
  }

  // How the page writes dates and times, from what it is showing before anything is typed.
  const before = await readSchedulePicker(page);
  const style = detectPickerStyle(before.dateText, before.timeText);
  log(`Schedule: the page shows "${before.dateText}" and "${before.timeText}" (${style.date}, ${style.hour12 ? "12-hour" : "24-hour"})`);
  await schedShot(page, "01-card-open");

  // The words that say this card schedules a public release. Reported, and the final button is the safeguard.
  const words = await dialogText(page);
  if (!/schedule as public/i.test(words)) log('Schedule: the card does not say "Schedule as public"');
  if (/private before publishing/i.test(words)) log('Schedule: Studio says "Video will be private before publishing"');

  // Which zone Studio will read the time in. The zone is never changed, only read: the right
  // answer is the wall time that is the asked-for moment IN the zone Studio has.
  const browser = await browserZone(page);
  await schedShot(page, "02-before-zone");
  const studio = await readStudioZone(page, log);
  await schedShot(page, "03-after-zone");
  if (studio.offsetMinutes === null) {
    const problem = "Studio did not identify its scheduling timezone. Date/time fields were left unchanged; scheduling was not submitted.";
    log(`Schedule: ${problem}`);
    return { ok: false, zoneVerified: false, problems: [problem], reading: before, target: null, zoneRead: false };
  }
  let target: StudioTarget;
  let zoneText: string | null = null;
  if (studio.offsetMinutes !== null) {
    // Studio names an offset. If it is the browser's zone's offset today, Studio is using that zone, and its own
    // daylight-saving rules apply on the day; otherwise all that is known is the offset.
    const sameAsBrowser = offsetMinutesAt(new Date(), browser) === studio.offsetMinutes;
    target = sameAsBrowser ? studioTarget(instant, browser, style) : studioTargetAtOffset(instant, studio.offsetMinutes, style);
    if (!sameAsBrowser) log(`Schedule: Studio's zone (${studio.label}) is not the browser's (${browser}); the time is worked out for ${target.gmtLabel}`);
    if (target.offsetMinutes === studio.offsetMinutes) zoneText = studio.label;
  } else {
    target = studioTarget(instant, browser, style);
    log(`Schedule: Studio did not say which zone it uses; the time is worked out in the browser's own zone (${browser}, ${target.gmtLabel})`);
  }

  log(`Schedule: wanted ${describeTarget(target)}`);
  let reading: PickerReading = { ...none };
  let verdict: PickerVerdict = { ok: false, zoneVerified: false, problems: [] };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await setDate(page, target, log);
      await setTime(page, target, log);
    } catch (err) {
      log(`Schedule: could not enter the date or time (${(err as Error).message})`);
    }
    await schedShot(page, `04-after-set-${attempt}`);
    reading = await readSchedulePicker(page, zoneText);
    verdict = judgePicker(reading, target);
    log(
      verdict.ok
        ? `Schedule: verified ${reading.dateText} ${reading.timeText}${verdict.zoneVerified ? " (time zone confirmed by Studio)" : " (Studio did not confirm the zone)"}`
        : `Schedule: PROBLEM (try ${attempt}) - ${verdict.problems.join(" ")}`,
    );
    if (verdict.ok) break;
  }
  return { ...verdict, reading, target, zoneRead: studio.offsetMinutes !== null };
}

/* --------------------------------------------------------- the channel's view -- */

/**
 * Open the video's own Studio page and read how it is listed: its visibility area
 * and its title.
 *
 * The video's own words are hidden for the length of the read, for the reason the
 * dialog readers hide them: a description that says "scheduled" is not Studio
 * saying the video is. Best effort - a page that will not load is reported as
 * unreadable, never as scheduled.
 */
export async function readScheduledFromChannel(page: Page, videoId: string): Promise<ScheduledView | null> {
  try {
    await page.goto(`https://studio.youtube.com/video/${videoId}/edit`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#title-textarea #textbox, ytcp-video-metadata-editor", { timeout: 45_000 });
    await page.waitForTimeout(2500);
    const view = await page.evaluate(() => {
      const title = document.querySelector("#title-textarea #textbox") as HTMLElement | null;
      const titleText = title ? (title.innerText || "").replace(/\s+/g, " ").trim() : null;

      const own = "[contenteditable], textarea, input, #title-textarea, #description-textarea, #tags-container, ytcp-chip-bar";
      const hidden: [HTMLElement, string][] = [];
      for (const n of document.querySelectorAll(own)) {
        hidden.push([n as HTMLElement, (n as HTMLElement).style.display]);
        (n as HTMLElement).style.display = "none";
      }

      const vis = document.querySelector(
        "ytcp-video-metadata-visibility, ytcp-video-metadata-editor-sidepanel .visibility, #visibility-text",
      ) as HTMLElement | null;
      let text = vis ? (vis.innerText || "").replace(/\s+/g, " ").trim() : "";
      if (!/\bscheduled\b/i.test(text)) {
        const body = (document.body.innerText || "").replace(/\s+/g, " ");
        const m = /\bscheduled\b/i.exec(body);
        // A video that is only a draft says so in words of its own ("This video is in a draft state").
        if (m) text = body.slice(Math.max(0, m.index - 40), m.index + 200);
        else if (!text) text = body.slice(0, 400);
      }

      for (const [n, was] of hidden) n.style.display = was;
      return { title: titleText, text };
    });
    // Studio's saved Visibility summary often says only "Scheduled". Open that
    // existing summary to READ its saved date/time; never select a radio or save.
    if (/\bscheduled\b/i.test(view.text) && (!parseStudioDate(view.text) || parseStudioTime(view.text) === null || parseOffset(view.text) === null)) {
      const visibility = page.locator("ytcp-video-metadata-visibility, #visibility-text").first();
      if (await visibility.isVisible().catch(() => false) && /^\s*(?:visibility\s*)?scheduled\b/i.test(await visibility.innerText())) {
        const details = visibility.getByRole("button", {name:"Edit video visibility status",exact:true});
        if (await details.isVisible().catch(() => false)) await details.click({ timeout: 5000 });
        else await visibility.click({ timeout: 5000 });
        let saved = await readSchedulePicker(page);
        for (let attempt=0; attempt<20 && (!saved.dateText || !saved.timeText); attempt++) {
          await page.waitForTimeout(300);
          saved = await readSchedulePicker(page);
        }
        // Closing Studio's timezone popup can also close the outer visibility
        // panel. Capture the saved date/time first, while that panel is visible.
        const zone = await readStudioZone(page, () => {});
        if (saved.dateText && saved.timeText && zone.label) return {
          title: view.title, text: `Scheduled ${saved.dateText} ${saved.timeText} ${zone.label}`,
        };
      }
    }
    return view;
  } catch {
    return null;
  }
}
