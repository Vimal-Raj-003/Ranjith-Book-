import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  formatLocal,
  isValidDate,
  isValidTime,
  isValidZone,
  localParts,
  minutesOf,
  timeOf,
  todayIn,
  zoneLabel,
  zonedInstant,
} from "../src/lib/schedule/reference-time";
import { DEFAULT_WINDOWS, checkSlots, generatePlan, rng, validateWindows, windowMinutes, type PlanInput, type SlotTime } from "../src/lib/schedule/plan";

const IST = "Asia/Kolkata";
const IST_OFFSET_MS = 5.5 * 3600_000;

/* ================================================================== time == */

test("a local time in Asia/Kolkata is the instant five and a half hours earlier in UTC", () => {
  assert.equal(zonedInstant("2026-10-15", "05:23", IST).toISOString(), "2026-10-14T23:53:00.000Z");
  assert.equal(zonedInstant("2026-10-15", "13:00", IST).toISOString(), "2026-10-15T07:30:00.000Z");
  assert.equal(zonedInstant("2026-10-15", "23:30", IST).toISOString(), "2026-10-15T18:00:00.000Z");
  assert.equal(zonedInstant("2026-10-15", "00:00", IST).toISOString(), "2026-10-14T18:30:00.000Z", "midnight is the evening before in UTC");
});

test("an instant reads back as the same local date and time, for every minute of a day", () => {
  for (let m = 0; m < 24 * 60; m++) {
    const time = timeOf(m);
    const at = zonedInstant("2026-10-15", time, IST);
    assert.deepEqual(localParts(at, IST), { date: "2026-10-15", time });
  }
});

test("the same instant is a different local time in another zone, and neither answer depends on this machine's zone", () => {
  const at = zonedInstant("2026-10-15", "05:23", IST);
  assert.deepEqual(localParts(at, "UTC"), { date: "2026-10-14", time: "23:53" });
  assert.deepEqual(localParts(at, IST), { date: "2026-10-15", time: "05:23" });
  assert.deepEqual(localParts(at, "Asia/Tokyo"), { date: "2026-10-15", time: "08:53" });
});

test("a zone with daylight saving gets the right offset on either side of the change", () => {
  assert.equal(zonedInstant("2026-07-01", "12:00", "America/New_York").toISOString(), "2026-07-01T16:00:00.000Z", "summer, UTC-4");
  assert.equal(zonedInstant("2026-12-01", "12:00", "America/New_York").toISOString(), "2026-12-01T17:00:00.000Z", "winter, UTC-5");
  assert.equal(zonedInstant("2026-07-01", "12:00", "Europe/London").toISOString(), "2026-07-01T11:00:00.000Z");
});

test("a local time the clocks skip does not exist and is refused; one they repeat takes the first", () => {
  assert.throws(() => zonedInstant("2026-03-08", "02:30", "America/New_York"), /does not exist/);
  // 01:30 on 1 Nov 2026 happens twice in New York; the first is still daylight time (UTC-4).
  assert.equal(zonedInstant("2026-11-01", "01:30", "America/New_York").toISOString(), "2026-11-01T05:30:00.000Z");
});

test("dates, times and zones are checked, not guessed at", () => {
  for (const ok of ["2026-10-15", "2028-02-29"]) assert.ok(isValidDate(ok), ok);
  for (const bad of ["2026-02-30", "2026-13-01", "2026-10-1", "15-10-2026", "", "2026-10-15T05:00"]) assert.ok(!isValidDate(bad), bad);
  for (const ok of ["00:00", "05:07", "23:59"]) assert.ok(isValidTime(ok), ok);
  for (const bad of ["24:00", "5:00", "05:60", "05:0", "05:00:00", "noon", ""]) assert.ok(!isValidTime(bad), bad);
  assert.ok(isValidZone("Asia/Kolkata"));
  assert.ok(!isValidZone("Mars/Olympus"));
  assert.ok(!isValidZone(""));
  assert.throws(() => zonedInstant("2026-02-30", "05:00", IST), /not a date/);
  assert.throws(() => zonedInstant("2026-10-15", "5:00", IST), /not a time/);
  assert.throws(() => zonedInstant("2026-10-15", "05:00", "Mars/Olympus"), /not a time zone/);
});

test("calendar arithmetic crosses month, year and leap day without involving a zone", () => {
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(addDays("2026-10-15", -15), "2026-09-30");
  assert.equal(minutesOf("13:07"), 787);
  assert.equal(timeOf(787), "13:07");
});

test("today is read in the named zone: late evening UTC is already tomorrow in India", () => {
  const evening = Date.parse("2026-10-14T20:00:00Z"); // 01:30 on the 15th in IST
  assert.equal(todayIn(IST, evening), "2026-10-15");
  assert.equal(todayIn("UTC", evening), "2026-10-14");
});

test("labels read as people write them", () => {
  assert.equal(zoneLabel(IST), "IST");
  assert.match(formatLocal(zonedInstant("2026-10-15", "05:23", IST), IST), /^Thu, 15 Oct, 05:23 IST$|15 Oct.*05:23 IST/);
});

/* ================================================================= plan == */

const base: PlanInput = { startDate: "2026-10-20", days: 7, windows: DEFAULT_WINDOWS, timezone: IST, seed: 12345, endInclusive: false };

test("a week is 21 post times: three a day for seven days, in order", () => {
  const { times } = generatePlan(base);
  assert.equal(times.length, 21);
  assert.deepEqual(times.map((t) => t.day), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6]);
  assert.deepEqual(times.map((t) => t.position), [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
  assert.deepEqual([...new Set(times.map((t) => t.localDate))], ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
});

test("every time is a minute inside its own window", () => {
  for (const seed of [1, 2, 3, 99, 12345, 777777]) {
    for (const t of generatePlan({ ...base, seed }).times) {
      assert.match(t.localTime, /^\d\d:\d\d$/);
      const m = minutesOf(t.localTime);
      const w = DEFAULT_WINDOWS[t.position - 1];
      assert.ok(m >= minutesOf(w.start) && m < minutesOf(w.end), `seed ${seed}: ${t.localTime} is outside ${w.start}-${w.end}`);
    }
  }
});

test("the slot windows are the ones asked for: 05:00-06:00, 13:00-14:00 and 21:00-23:30", () => {
  const { times } = generatePlan(base);
  const range = (position: number) => {
    const ms = times.filter((t) => t.position === position).map((t) => minutesOf(t.localTime));
    return [Math.min(...ms), Math.max(...ms)];
  };
  const [a0, a1] = range(1);
  const [b0, b1] = range(2);
  const [c0, c1] = range(3);
  assert.ok(a0 >= 300 && a1 <= 359, `slot 1 ${a0}-${a1}`);
  assert.ok(b0 >= 780 && b1 <= 839, `slot 2 ${b0}-${b1}`);
  assert.ok(c0 >= 1260 && c1 <= 1409, `slot 3 ${c0}-${c1}`);
});

test("no slot repeats a time across the week, whatever the seed", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { times, warnings } = generatePlan({ ...base, seed });
    assert.deepEqual(warnings, []);
    for (const position of [1, 2, 3]) {
      const mine = times.filter((t) => t.position === position).map((t) => t.localTime);
      assert.equal(new Set(mine).size, 7, `seed ${seed}, slot ${position}: ${mine.join(" ")}`);
    }
  }
});

test("the same seed draws the same week, and a different seed draws a different one", () => {
  const a = generatePlan(base).times.map((t) => t.localTime);
  const b = generatePlan({ ...base }).times.map((t) => t.localTime);
  const c = generatePlan({ ...base, seed: 54321 }).times.map((t) => t.localTime);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("the times do not simply creep later through the week", () => {
  // Drawn from one band per day and then dealt out by a shuffle, so the days are not in ascending order of time.
  let ascending = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const ms = generatePlan({ ...base, seed }).times.filter((t) => t.position === 1).map((t) => minutesOf(t.localTime));
    if (ms.every((v, i) => i === 0 || v > ms[i - 1])) ascending++;
  }
  assert.ok(ascending <= 2, `${ascending} of 40 seeds came out strictly ascending`);
});

test("each instant is the local time in Asia/Kolkata, and the whole week is in time order", () => {
  const { times } = generatePlan(base);
  for (const t of times) {
    const [y, mo, d] = t.localDate.split("-").map(Number);
    const [h, mi] = t.localTime.split(":").map(Number);
    assert.equal(t.scheduledAt.getTime(), Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);
  }
  for (let i = 1; i < times.length; i++) assert.ok(times[i].scheduledAt.getTime() > times[i - 1].scheduledAt.getTime(), `slot ${i} is not after slot ${i - 1}`);
});

test("the end of a window is exclusive by default and can be made inclusive", () => {
  assert.deepEqual(windowMinutes({ start: "05:00", end: "06:00" }, false).slice(-1), [359]);
  assert.deepEqual(windowMinutes({ start: "05:00", end: "06:00" }, true).slice(-1), [360]);
  assert.equal(windowMinutes({ start: "05:00", end: "06:00" }, false).length, 60);
  assert.equal(windowMinutes({ start: "05:00", end: "06:00" }, true).length, 61);
  assert.equal(windowMinutes({ start: "21:00", end: "23:30" }, false).length, 150);

  // With the end included, 06:00 can really be drawn; with it excluded it never can.
  const narrow = { start: "05:00", end: "05:01" };
  const inclusive = generatePlan({ ...base, days: 2, windows: [narrow], endInclusive: true });
  assert.deepEqual(inclusive.times.map((t) => t.localTime).sort(), ["05:00", "05:01"]);
  assert.deepEqual(inclusive.warnings, []);
  const exclusive = generatePlan({ ...base, days: 2, windows: [narrow], endInclusive: false });
  assert.deepEqual(exclusive.times.map((t) => t.localTime), ["05:00", "05:00"]);
  assert.match(exclusive.warnings.join(" "), /only 1 minute/);
});

test("a window too narrow to give every day its own minute says so, and uses every minute it has", () => {
  const { times, warnings } = generatePlan({ ...base, windows: [{ start: "05:00", end: "05:04" }], days: 7 });
  assert.equal(times.length, 7);
  assert.match(warnings.join(" "), /only 4 minutes for 7 days/);
  assert.deepEqual([...new Set(times.map((t) => t.localTime))].sort(), ["05:00", "05:01", "05:02", "05:03"]);
});

test("bad windows are refused with a sentence about each", () => {
  assert.deepEqual(validateWindows(DEFAULT_WINDOWS, false), []);
  assert.match(validateWindows([{ start: "5:00", end: "06:00" }], false).join(" "), /24-hour HH:mm/);
  assert.match(validateWindows([{ start: "06:00", end: "05:00" }], false).join(" "), /no minute/);
  assert.match(validateWindows([{ start: "05:00", end: "05:00" }], false).join(" "), /no minute/);
  assert.deepEqual(validateWindows([{ start: "05:00", end: "05:00" }], true), [], "an inclusive end makes a one-minute window");
  assert.match(validateWindows([{ start: "05:00", end: "14:00" }, { start: "13:00", end: "14:00" }], false).join(" "), /order could not be kept/);
  assert.match(validateWindows([], false).join(" "), /at least one/);
  assert.throws(() => generatePlan({ ...base, windows: [{ start: "06:00", end: "05:00" }] }), /no minute/);
  assert.throws(() => generatePlan({ ...base, startDate: "2026-02-30" }), /not a date/);
  assert.throws(() => generatePlan({ ...base, timezone: "Mars/Olympus" }), /time zone/);
  assert.throws(() => generatePlan({ ...base, days: 0 }), /Days/);
});

test("the generator is seeded, not random: the same seed gives the same numbers", () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
  const v = rng(7)();
  assert.ok(v >= 0 && v < 1);
});

/* ============================================================== checking == */

const NOW = new Date("2026-10-19T10:00:00Z"); // before the plan starts
const opts = { now: NOW, timezone: IST, windows: DEFAULT_WINDOWS, endInclusive: false, minGapMinutes: 30 };
const slotsOf = (input: PlanInput = base): SlotTime[] =>
  generatePlan(input).times.map((t) => ({ key: `${t.day}-${t.position}`, ...t }));
const slot = (key: string, day: number, position: number, date: string, time: string): SlotTime => ({
  key, day, position, localDate: date, localTime: time, scheduledAt: zonedInstant(date, time, IST),
});

test("a freshly drawn week has no errors and no warnings", () => {
  assert.deepEqual(checkSlots(slotsOf(), opts), []);
});

test("a time in the past, and one too soon to prepare for, are errors", () => {
  const past = [slot("a", 0, 1, "2026-10-19", "05:10")];
  assert.match(checkSlots(past, { ...opts, now: new Date("2026-10-19T06:00:00Z") })[0].message, /already passed/);
  const soon = [slot("a", 0, 1, "2026-10-19", "15:32")]; // 10:02Z, two minutes after NOW
  const found = checkSlots(soon, opts).find((i) => i.severity === "error");
  assert.match(found?.message ?? "", /less than 5 minutes/);
});

test("two posts at the same moment, or too close together, are errors", () => {
  const same = checkSlots([slot("a", 0, 2, "2026-10-20", "13:10"), slot("b", 1, 2, "2026-10-20", "13:10")], opts);
  assert.ok(same.some((i) => i.severity === "error" && /Same moment/.test(i.message)));
  const close = checkSlots([slot("a", 0, 1, "2026-10-20", "05:40"), slot("b", 0, 2, "2026-10-20", "05:55")], opts);
  assert.ok(close.some((i) => i.key === "b" && i.severity === "error" && /Only 15 minutes/.test(i.message)));
  const fine = checkSlots([slot("a", 0, 1, "2026-10-20", "05:40"), slot("b", 0, 2, "2026-10-20", "13:00")], opts);
  assert.ok(!fine.some((i) => i.severity === "error"));
});

test("a day's slots must stay in order", () => {
  const swapped = checkSlots([slot("a", 0, 1, "2026-10-20", "21:30"), slot("b", 0, 2, "2026-10-20", "13:30")], opts);
  assert.ok(swapped.some((i) => i.key === "a" && /has to come after slot 2|has to come after/.test(i.message) || i.key === "b"));
  assert.ok(swapped.some((i) => i.severity === "error" && /has to come after/.test(i.message)), JSON.stringify(swapped));
});

test("a time moved outside its window is a warning, not an error", () => {
  const moved = checkSlots([slot("a", 0, 1, "2026-10-20", "07:30")], opts);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].severity, "warning");
  assert.match(moved[0].message, /outside the 05:00 to 06:00 window for slot 1/);
  // The excluded end counts as outside by default.
  assert.equal(checkSlots([slot("a", 0, 1, "2026-10-20", "06:00")], opts)[0].severity, "warning");
  assert.deepEqual(checkSlots([slot("a", 0, 1, "2026-10-20", "06:00")], { ...opts, endInclusive: true }), []);
});

test("an invalid date or time is reported without throwing", () => {
  const bad: SlotTime = { key: "x", day: 0, position: 1, localDate: "2026-02-30", localTime: "05:10", scheduledAt: new Date(NaN) };
  assert.match(checkSlots([bad], opts)[0].message, /not valid/);
});
