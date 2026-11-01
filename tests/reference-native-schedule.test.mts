import test from "node:test";
import assert from "node:assert/strict";
import {
  STYLE_EN_GB,
  STYLE_EN_US,
  detectPickerStyle,
  studioTargetAtOffset,
  NATIVE_MIN_LEAD_MS,
  checkGoLive,
  describeTarget,
  gmtLabel,
  goLiveOf,
  judgeApiSchedule,
  judgePicker,
  judgeScheduledView,
  nativeEngineFor,
  parseOffset,
  parseStudioDate,
  parseStudioTime,
  studioTarget,
} from "../src/lib/publish/native-schedule";
import { zonedInstant } from "../src/lib/schedule/reference-time";

const KOLKATA = "Asia/Kolkata";
const at = (date: string, time: string, zone = KOLKATA) => zonedInstant(date, time, zone);

/* ---------------------------------------------------------------- the target -- */

test("the target is written the way an English Studio is typed into", () => {
  const t = studioTarget(at("2026-10-16", "05:00"), KOLKATA);
  assert.equal(t.dateText, "Oct 16, 2026");
  assert.equal(t.timeText, "5:00 AM");
  assert.equal(t.gmtLabel, "GMT+5:30");
  assert.equal(t.offsetMinutes, 330);
  assert.equal(t.minutes, 300);
});

test("noon, midnight and the evening windows read the way Studio reads them", () => {
  assert.equal(studioTarget(at("2026-10-16", "00:05"), KOLKATA).timeText, "12:05 AM");
  assert.equal(studioTarget(at("2026-10-16", "12:00"), KOLKATA).timeText, "12:00 PM");
  assert.equal(studioTarget(at("2026-10-16", "13:07"), KOLKATA).timeText, "1:07 PM");
  assert.equal(studioTarget(at("2026-10-16", "23:30"), KOLKATA).timeText, "11:30 PM");
  assert.equal(studioTarget(at("2026-10-16", "21:00"), KOLKATA).timeText, "9:00 PM");
});

test("the same instant is a different wall time in a different zone, and the target follows the zone it is given", () => {
  const instant = at("2026-10-16", "05:00"); // 23:30 UTC the evening before
  const utc = studioTarget(instant, "UTC");
  assert.equal(utc.dateText, "Oct 15, 2026");
  assert.equal(utc.timeText, "11:30 PM");
  assert.equal(utc.gmtLabel, "GMT+0");
  const la = studioTarget(instant, "America/Los_Angeles");
  assert.equal(la.dateText, "Oct 15, 2026");
  assert.equal(la.timeText, "4:30 PM");
  assert.equal(la.gmtLabel, "GMT-7");
});

test("a zone with daylight saving uses the offset of that day, not today's", () => {
  const winter = studioTarget(at("2026-12-20", "09:00", "America/New_York"), "America/New_York");
  assert.equal(winter.gmtLabel, "GMT-5");
  const summer = studioTarget(at("2026-07-20", "09:00", "America/New_York"), "America/New_York");
  assert.equal(summer.gmtLabel, "GMT-4");
  assert.equal(summer.timeText, "9:00 AM");
});

test("offset labels", () => {
  assert.equal(gmtLabel(330), "GMT+5:30");
  assert.equal(gmtLabel(-480), "GMT-8");
  assert.equal(gmtLabel(0), "GMT+0");
  assert.equal(gmtLabel(345), "GMT+5:45");
});

/* ------------------------------------------------------------------- parsing -- */

test("dates are understood in the shapes Studio prints them", () => {
  const want = { year: 2026, month: 10, day: 16 };
  for (const text of ["Oct 16, 2026", "October 16, 2026", "Fri, Oct 16, 2026", "16 Oct 2026", "2026-10-16", "10/16/2026", "Scheduled Oct 16, 2026, 5:00 AM", "Oct 16th, 2026"]) {
    assert.deepEqual(parseStudioDate(text), want, text);
  }
});

test("a date without a year, or one that does not exist, is not a date", () => {
  assert.equal(parseStudioDate("Oct 16"), null);
  assert.equal(parseStudioDate("Feb 30, 2026"), null);
  assert.equal(parseStudioDate("13/45/2026"), null);
  assert.equal(parseStudioDate(""), null);
  assert.equal(parseStudioDate("Scheduled"), null);
});

test("times are understood in the shapes Studio prints them", () => {
  assert.equal(parseStudioTime("5:00 AM"), 300);
  assert.equal(parseStudioTime("5:00 am"), 300);
  assert.equal(parseStudioTime("5:00 a.m."), 300);
  assert.equal(parseStudioTime("5 PM"), 17 * 60);
  assert.equal(parseStudioTime("12:00 AM"), 0);
  assert.equal(parseStudioTime("12:30 PM"), 750);
  assert.equal(parseStudioTime("17:00"), 1020);
  assert.equal(parseStudioTime("Oct 16, 2026, 9:45 PM"), 21 * 60 + 45);
  // The narrow no-break space newer engines put before AM/PM.
  assert.equal(parseStudioTime("5:00 AM"), 300);
  assert.equal(parseStudioTime("5:00 PM"), 17 * 60);
});

test("a time that is not a time is not read as one", () => {
  assert.equal(parseStudioTime("13:00 PM"), null);
  assert.equal(parseStudioTime("0:30 AM"), null);
  assert.equal(parseStudioTime("Scheduled"), null);
  assert.equal(parseStudioTime(""), null);
  // The year is not a time.
  assert.equal(parseStudioTime("Oct 16, 2026"), null);
});

test("offsets are read from the labels Studio uses", () => {
  assert.equal(parseOffset("GMT+5:30"), 330);
  assert.equal(parseOffset("(GMT+05:30) India Standard Time"), 330);
  assert.equal(parseOffset("UTC-08:00"), -480);
  assert.equal(parseOffset("GMT−8"), -480);
  assert.equal(parseOffset("GMT+0530"), 330);
  assert.equal(parseOffset("India Standard Time"), null);
  assert.equal(parseOffset(""), null);
});

/* ---------------------------------------------------------------- the picker -- */

const target = studioTarget(at("2026-10-16", "05:00"), KOLKATA);

test("a picker holding the asked-for moment is accepted", () => {
  const v = judgePicker({ dateText: "Oct 16, 2026", timeText: "5:00 AM", zoneText: null }, target);
  assert.equal(v.ok, true);
  assert.equal(v.zoneVerified, false, "Studio printed no zone, so the zone was not seen to be right");
});

test("a zone label that agrees is recorded as verified", () => {
  const v = judgePicker({ dateText: "Oct 16, 2026", timeText: "5:00 AM", zoneText: "(GMT+05:30) India Standard Time" }, target);
  assert.equal(v.ok, true);
  assert.equal(v.zoneVerified, true);
});

test("a wrong date, time or zone each fail, and say which", () => {
  const wrongDate = judgePicker({ dateText: "Oct 17, 2026", timeText: "5:00 AM", zoneText: null }, target);
  assert.equal(wrongDate.ok, false);
  assert.match(wrongDate.problems[0], /date shows Oct 17, 2026, not Oct 16, 2026/);

  const wrongTime = judgePicker({ dateText: "Oct 16, 2026", timeText: "5:00 PM", zoneText: null }, target);
  assert.equal(wrongTime.ok, false);
  assert.match(wrongTime.problems[0], /time shows 5:00 PM, not 5:00 AM/);

  const wrongZone = judgePicker({ dateText: "Oct 16, 2026", timeText: "5:00 AM", zoneText: "GMT-7" }, target);
  assert.equal(wrongZone.ok, false);
  assert.match(wrongZone.problems[0], /GMT-7.*GMT\+5:30/);
});

test("a picker that cannot be read is not accepted", () => {
  const v = judgePicker({ dateText: null, timeText: "", zoneText: null }, target);
  assert.equal(v.ok, false);
  assert.equal(v.problems.length, 2);
});

test("an AM/PM slip is caught even though the digits agree", () => {
  const v = judgePicker({ dateText: "Oct 16, 2026", timeText: "5:00 PM", zoneText: null }, target);
  assert.equal(v.ok, false);
});

/* ------------------------------------------------------------ the go-live time -- */

test("a go-live is taken from publishAt, and from scheduledAt for a job that predates it", () => {
  const a = new Date("2026-10-16T00:00:00Z");
  const b = new Date("2026-10-17T00:00:00Z");
  assert.equal(goLiveOf({ publishAt: a, scheduledAt: b }), a);
  assert.equal(goLiveOf({ publishAt: null, scheduledAt: b }), b);
  assert.equal(goLiveOf({ publishAt: null, scheduledAt: null }), null);
  assert.equal(goLiveOf({ publishAt: new Date("nope"), scheduledAt: null }), null);
});

test("a go-live that is missing, past, or too near is refused and says why", () => {
  const now = new Date("2026-10-15T10:00:00Z");
  assert.deepEqual(checkGoLive(new Date(now.getTime() + NATIVE_MIN_LEAD_MS + 60_000), now, KOLKATA), { ok: true });

  const missing = checkGoLive(null, now, KOLKATA);
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.code, "missing");

  const past = checkGoLive(new Date(now.getTime() - 60_000), now, KOLKATA);
  assert.equal(!past.ok && past.code, "too-soon");
  assert.match(!past.ok ? past.message : "", /already past/);
  assert.match(!past.ok ? past.message : "", /Nothing was scheduled/);

  const near = checkGoLive(new Date(now.getTime() + 5 * 60_000), now, KOLKATA);
  assert.equal(!near.ok && near.code, "too-soon");
  assert.match(!near.ok ? near.message : "", /less than 20 minutes/);
});

test("exactly the minimum lead is accepted and a second less is not", () => {
  const now = new Date("2026-10-15T10:00:00Z");
  assert.equal(checkGoLive(new Date(now.getTime() + NATIVE_MIN_LEAD_MS), now, KOLKATA).ok, true);
  assert.equal(checkGoLive(new Date(now.getTime() + NATIVE_MIN_LEAD_MS - 1000), now, KOLKATA).ok, false);
});

/* ---------------------------------------------------------- the channel's view -- */

const want = { title: "Why this repo matters", target };

test("Scheduled with the right date and time is a confirmation", () => {
  const v = judgeScheduledView({ text: "Visibility Scheduled Oct 16, 2026, 5:00 AM", title: "Why this repo matters" }, want);
  assert.equal(v.scheduled, true);
  assert.equal(v.timeConfirmed, true);
  assert.equal(v.titleMatches, true);
  assert.deepEqual(v.problems, []);
});

test("Scheduled for the wrong time is not a confirmation", () => {
  const v = judgeScheduledView({ text: "Scheduled Oct 16, 2026, 6:00 AM", title: "Why this repo matters" }, want);
  assert.equal(v.scheduled, true);
  assert.equal(v.timeConfirmed, false);
  assert.match(v.problems.join(" "), /different time/);
});

test("Scheduled for the wrong date is not a confirmation", () => {
  const v = judgeScheduledView({ text: "Scheduled Oct 23, 2026, 5:00 AM", title: null }, want);
  assert.equal(v.timeConfirmed, false);
  assert.match(v.problems.join(" "), /different date/);
});

test("Scheduled with no readable date or time is not a confirmation", () => {
  const v = judgeScheduledView({ text: "Visibility Scheduled", title: null }, want);
  assert.equal(v.scheduled, true);
  assert.equal(v.timeConfirmed, false);
  assert.match(v.problems.join(" "), /could not be read/);
});

test("a schedule shown in another zone is not a confirmation", () => {
  const v = judgeScheduledView({ text: "Scheduled Oct 16, 2026, 5:00 AM GMT-7", title: null }, want);
  assert.equal(v.timeConfirmed, false);
  assert.match(v.problems.join(" "), /GMT-7/);
});

test("Public, Private, Unlisted and Draft are none of them Scheduled", () => {
  for (const [text, pattern] of [
    ["Visibility Public", /Public, not Scheduled/],
    ["Visibility Private", /Private, not Scheduled/],
    ["Visibility Unlisted", /Unlisted, not Scheduled/],
    ["Draft - finish your upload", /still lists the video as a draft/],
  ] as const) {
    const v = judgeScheduledView({ text, title: null }, want);
    assert.equal(v.scheduled, false, text);
    assert.equal(v.timeConfirmed, false, text);
    assert.match(v.problems.join(" "), pattern, text);
  }
});

test("a page that could not be read confirms nothing", () => {
  for (const view of [null, { text: null, title: null }, { text: "   ", title: "x" }]) {
    const v = judgeScheduledView(view, want);
    assert.equal(v.unreadable, true);
    assert.equal(v.scheduled, false);
  }
});

test("a different title is reported, and an unreadable one is not held against it", () => {
  const wrong = judgeScheduledView({ text: "Scheduled Oct 16, 2026, 5:00 AM", title: "Some other video entirely" }, want);
  assert.equal(wrong.titleMatches, false);
  assert.match(wrong.problems.join(" "), /not the one that was approved/);

  const unread = judgeScheduledView({ text: "Scheduled Oct 16, 2026, 5:00 AM", title: null }, want);
  assert.equal(unread.titleMatches, true);
});

test("describing a target for the log", () => {
  assert.equal(describeTarget(target), "Oct 16, 2026, 5:00 AM (GMT+5:30)");
});

/* ----------------------------------------------------------------- the API ---- */

test("an API response that holds the asked-for publish time confirms the schedule", () => {
  const goLive = at("2026-10-16", "05:00");
  const v = judgeApiSchedule({ privacyStatus: "private", publishAt: goLive.toISOString() }, goLive);
  assert.equal(v.confirmed, true);
  assert.equal(v.publishAt?.getTime(), goLive.getTime());
  assert.match(v.platformStatus, /scheduled/);
});

test("an API response with no publish time did not take the schedule", () => {
  const v = judgeApiSchedule({ privacyStatus: "private" }, at("2026-10-16", "05:00"));
  assert.equal(v.confirmed, false);
  assert.match(v.problems[0], /no publish time/);
  assert.match(v.problems[0], /not audited/);
});

test("an API response with another publish time, or a public video, is not a confirmation", () => {
  const goLive = at("2026-10-16", "05:00");
  const other = judgeApiSchedule({ privacyStatus: "private", publishAt: at("2026-10-16", "06:00").toISOString() }, goLive);
  assert.equal(other.confirmed, false);
  assert.match(other.problems[0], /different publish time/);

  const live = judgeApiSchedule({ privacyStatus: "public", publishAt: goLive.toISOString() }, goLive);
  assert.equal(live.confirmed, false);
  assert.match(live.problems.join(" "), /held private/);

  assert.equal(judgeApiSchedule(undefined, goLive).confirmed, false);
});

test("the engine is the API only when a channel is connected", () => {
  assert.equal(nativeEngineFor({ hasConnectedChannel: true }), "api");
  assert.equal(nativeEngineFor({ hasConnectedChannel: false }), "browser");
});


/* ------------------------------------------------ the style the page writes in -- */

test("the style is read from what the page is showing: UK dates and 24-hour times, US dates and AM/PM, numeric dates", () => {
  assert.deepEqual(detectPickerStyle("16 Oct 2026", "00:00"), { date: "dmy-short", hour12: false });
  assert.deepEqual(detectPickerStyle("Oct 16, 2026", "12:00 AM"), { date: "mdy-short", hour12: true });
  assert.deepEqual(detectPickerStyle("Oct 16, 2026", "5:00 pm"), { date: "mdy-short", hour12: true });
  assert.deepEqual(detectPickerStyle("16/10/2026", "17:45"), { date: "dmy-numeric", hour12: false });
  assert.deepEqual(detectPickerStyle("10/16/2026", "5:45 PM"), { date: "mdy-numeric", hour12: true });
  assert.deepEqual(detectPickerStyle("5th Oct 2026", "09:00"), { date: "dmy-short", hour12: false });
  // What cannot be told is the Studio that was observed.
  assert.deepEqual(detectPickerStyle(null, null), STYLE_EN_GB);
  assert.deepEqual(detectPickerStyle("", ""), STYLE_EN_GB);
});

test("the target is written in the style of the page: UK for the adapter, US where the page is US", () => {
  const instant = at("2026-10-16", "05:39");
  const uk = studioTarget(instant, KOLKATA, STYLE_EN_GB);
  assert.equal(uk.dateText, "16 Oct 2026");
  assert.equal(uk.timeText, "05:39");
  const us = studioTarget(instant, KOLKATA, STYLE_EN_US);
  assert.equal(us.dateText, "Oct 16, 2026");
  assert.equal(us.timeText, "5:39 AM");
  // What every other test in this file expects when no style is given.
  assert.equal(studioTarget(instant, KOLKATA).dateText, "Oct 16, 2026");

  const numeric = studioTarget(instant, KOLKATA, { date: "dmy-numeric", hour12: false });
  assert.equal(numeric.dateText, "16/10/2026");
  assert.equal(studioTarget(instant, KOLKATA, { date: "mdy-numeric", hour12: true }).dateText, "10/16/2026");
});

test("a 24-hour time is zero-padded, midnight is 00:00, and the evening windows read as 21:00 and 23:30", () => {
  assert.equal(studioTarget(at("2026-10-16", "00:05"), KOLKATA, STYLE_EN_GB).timeText, "00:05");
  assert.equal(studioTarget(at("2026-10-16", "05:00"), KOLKATA, STYLE_EN_GB).timeText, "05:00");
  assert.equal(studioTarget(at("2026-10-16", "13:08"), KOLKATA, STYLE_EN_GB).timeText, "13:08");
  assert.equal(studioTarget(at("2026-10-16", "21:00"), KOLKATA, STYLE_EN_GB).timeText, "21:00");
  assert.equal(studioTarget(at("2026-10-16", "23:30"), KOLKATA, STYLE_EN_GB).timeText, "23:30");
});

test("a schedule for a zone Studio names only by an offset is the same instant, written for that offset", () => {
  const instant = at("2026-10-16", "05:00"); // 23:30 UTC on the 15th
  const pdt = studioTargetAtOffset(instant, -420, STYLE_EN_GB);
  assert.equal(pdt.dateText, "15 Oct 2026");
  assert.equal(pdt.timeText, "16:30");
  assert.equal(pdt.gmtLabel, "GMT-7");
  assert.equal(pdt.zone, "GMT-7");

  const ist = studioTargetAtOffset(instant, 330, STYLE_EN_GB);
  assert.equal(ist.dateText, "16 Oct 2026");
  assert.equal(ist.timeText, "05:00");
  assert.equal(ist.year, 2026);
  assert.equal(ist.minutes, 300);

  // Crossing a month and a year.
  const nye = studioTargetAtOffset(new Date("2026-12-31T20:00:00Z"), 330, STYLE_EN_GB);
  assert.equal(nye.dateText, "1 Jan 2027");
  assert.equal(nye.timeText, "01:30");
});

test("dates written with slashes are read the way the style of the page says", () => {
  assert.deepEqual(parseStudioDate("16/10/2026", "dmy"), { year: 2026, month: 10, day: 16 });
  assert.deepEqual(parseStudioDate("10/16/2026", "mdy"), { year: 2026, month: 10, day: 16 });
  assert.equal(parseStudioDate("16/10/2026", "mdy"), null, "month 16 is not a month");
  assert.deepEqual(parseStudioDate("16.10.2026", "dmy"), { year: 2026, month: 10, day: 16 });
});

test("the picker is judged in its own style: a UK page reading 16 Oct 2026 and 05:39 is right, 17:39 is not", () => {
  const target = studioTarget(at("2026-10-16", "05:39"), KOLKATA, STYLE_EN_GB);
  assert.equal(judgePicker({ dateText: "16 Oct 2026", timeText: "05:39", zoneText: null }, target).ok, true);
  const slip = judgePicker({ dateText: "16 Oct 2026", timeText: "17:39", zoneText: null }, target);
  assert.equal(slip.ok, false);
  assert.match(slip.problems[0], /time shows 17:39, not 05:39/);
  // A numeric UK date.
  const numeric = studioTarget(at("2026-10-16", "05:39"), KOLKATA, { date: "dmy-numeric", hour12: false });
  assert.equal(judgePicker({ dateText: "16/10/2026", timeText: "05:39", zoneText: null }, numeric).ok, true);
  assert.equal(judgePicker({ dateText: "10/16/2026", timeText: "05:39", zoneText: null }, numeric).ok, false, "month 16 is not a date");
});

test("the channel page in the UK style, and the draft wording from a real run, are understood", () => {
  const target = studioTarget(at("2026-10-16", "05:39"), KOLKATA, STYLE_EN_GB);
  const ok = judgeScheduledView({ text: "Visibility Scheduled 16 Oct 2026, 05:39", title: "Why this repo matters" }, { title: "Why this repo matters", target });
  assert.equal(ok.scheduled && ok.timeConfirmed && ok.titleMatches, true);

  // What Studio printed for a video that was only a draft, from a real run.
  const draft = judgeScheduledView({ text: "This video is in a draft state Edit draft", title: null }, { title: "x", target });
  assert.equal(draft.scheduled, false);
  assert.match(draft.problems.join(" "), /still lists the video as a draft/);

  const wrong = judgeScheduledView({ text: "Scheduled 16 Oct 2026, 06:39", title: null }, { title: "x", target });
  assert.equal(wrong.timeConfirmed, false);
});
