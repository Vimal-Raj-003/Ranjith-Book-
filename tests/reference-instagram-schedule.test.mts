import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { locateChromium as findChromium } from "../src/lib/publish/browser/engine";
import { zonedInstant } from "../src/lib/schedule/reference-time";
import {
  reelScheduleTarget,
  dateMatches,
  enableScheduleContent,
  setReelDate,
  setReelTime,
  readReelSchedule,
  judgeReelSchedule,
  scheduleButtonReady,
  pressSchedule,
  parseClock,
} from "../src/lib/publish/browser/instagram-schedule";

/**
 * Instagram's "New reel" final screen, cut down to what scheduling touches: a
 * "Schedule content" switch that reveals a Date and a Time field and turns the
 * top-right button from "Share" into "Schedule", a confirmation on Schedule, and a
 * separate "Add AI label" switch so the schedule switch cannot be picked by index.
 * These run in a real Chromium so the toggle, typing and button are the real thing.
 */
const quiet = () => {};
let browser: Browser;
const haveBrowser = Boolean(await findChromium());

test.before(async () => {
  if (haveBrowser) browser = await chromium.launch({ executablePath: (await findChromium()) ?? undefined });
});
test.after(async () => {
  await browser?.close();
});

function fixture({ noToggle = false }: { noToggle?: boolean } = {}): string {
  return `<!doctype html><html><body>
    <style>
      body{font:14px sans-serif}
      [role="switch"]{display:inline-block;width:44px;height:24px;border:1px solid #888;vertical-align:middle;margin:6px}
      [role="button"]{display:inline-block;padding:8px 14px;border:1px solid #888;cursor:pointer}
      input{display:inline-block;padding:4px;margin:4px;border:1px solid #888}
      #fields label{display:inline-block;width:48px}
    </style>
    <div role="dialog">
      <div><span>Add AI label</span><div role="switch" aria-checked="true"></div></div>
      ${noToggle ? "" : '<div><span>Schedule content</span><div role="switch" id="sched" aria-checked="false"></div></div>'}
      <div id="fields" style="display:none">
        <label>Date</label><input id="date" aria-label="Date" value="">
        <label>Time</label>
        <!-- Instagram's Time is three spinbuttons (Hours, Minutes, AM/PM) with a shown value. -->
        <div id="timewrap">
          <input role="spinbutton" aria-label="Hours" aria-valuenow="5">
          <input role="spinbutton" aria-label="Minutes" aria-valuenow="33">
          <input role="spinbutton" aria-label="AM/PM" aria-valuetext="PM">
          <span id="tdisp">05 : 33 PM</span>
        </div>
      </div>
      <div role="button" id="final">Share</div>
    </div>
    <script>
      window.__shared = false; window.__scheduled = false;
      function pad(n){ n = String(n); return n.length < 2 ? "0" + n : n; }
      function refreshTime(){
        var h = document.querySelector('[aria-label="Hours"]'), m = document.querySelector('[aria-label="Minutes"]'), p = document.querySelector('[aria-label="AM/PM"]');
        document.getElementById("tdisp").textContent = pad(h.getAttribute("aria-valuenow")) + " : " + pad(m.getAttribute("aria-valuenow")) + " " + p.getAttribute("aria-valuetext");
      }
      var hbuf = "", mbuf = "";
      document.querySelector('[aria-label="Hours"]').addEventListener("keydown", function (e) {
        if (!/^\\d$/.test(e.key)) return;
        hbuf = (hbuf + e.key).slice(-2);
        e.target.setAttribute("aria-valuenow", String(Math.min(12, Math.max(1, Number(hbuf))))); refreshTime();
      });
      document.querySelector('[aria-label="Minutes"]').addEventListener("keydown", function (e) {
        if (!/^\\d$/.test(e.key)) return;
        mbuf = (mbuf + e.key).slice(-2);
        e.target.setAttribute("aria-valuenow", String(Math.min(59, Number(mbuf)))); refreshTime();
      });
      document.querySelector('[aria-label="AM/PM"]').addEventListener("keydown", function (e) {
        var p = e.target;
        if (/^[ap]$/i.test(e.key)) { p.setAttribute("aria-valuetext", e.key.toUpperCase() === "P" ? "PM" : "AM"); refreshTime(); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") { p.setAttribute("aria-valuetext", p.getAttribute("aria-valuetext") === "PM" ? "AM" : "PM"); refreshTime(); }
      });
      var sw = document.getElementById("sched");
      if (sw) sw.addEventListener("click", function () {
        var on = sw.getAttribute("aria-checked") !== "true";
        sw.setAttribute("aria-checked", on ? "true" : "false");
        document.getElementById("fields").style.display = on ? "block" : "none";
        // Instagram prefills a date; make it DIFFERENT from the target so setting it is proven.
        if (on && !document.getElementById("date").value) document.getElementById("date").value = "1 Jan 2026";
        document.getElementById("final").textContent = on ? "Schedule" : "Share";
      });
      var fin = document.getElementById("final");
      fin.addEventListener("click", function () {
        var label = (fin.textContent || "").trim();
        if (label === "Share") { window.__shared = true; return; }
        if (label === "Schedule") {
          window.__scheduled = true;
          var d = document.getElementById("date").value, t = document.getElementById("tdisp").textContent;
          var c = document.createElement("div");
          c.textContent = "Your reel will be shared on " + d + " at " + t + ".";
          document.querySelector('[role=dialog]').appendChild(c);
        }
      });
    </script>
  </body></html>`;
}

const page = async (html: string): Promise<Page> => {
  const p = await browser.newPage();
  await p.setContent(html);
  return p;
};
const readDialog = (p: Page) => p.evaluate(() => (document.querySelector('[role="dialog"]') as HTMLElement).innerText.replace(/\s+/g, " ").trim());
const flags = (p: Page) => p.evaluate(() => ({ shared: (window as unknown as { __shared: boolean }).__shared, scheduled: (window as unknown as { __scheduled: boolean }).__scheduled }));

// 17 Oct 2026, 15:32 in Asia/Kolkata.
const target = reelScheduleTarget(zonedInstant("2026-10-17", "15:32", "Asia/Kolkata"), "Asia/Kolkata");

/* ------------------------------------------------------------- pure bits -- */

test("the target is worked out in the schedule's zone, in Instagram's 12-hour clock", () => {
  assert.equal(target.day, 17);
  assert.equal(target.monthShort, "Oct");
  assert.equal(target.year, 2026);
  assert.equal(target.timeText, "15:32");
  assert.equal(target.timeText12, "3:32 PM", "Instagram's Time box is 12-hour");
  assert.equal(target.minutes, 15 * 60 + 32);
});

test("parseClock reads 12-hour and 24-hour clocks back to minutes", () => {
  assert.equal(parseClock("3:32 PM"), 15 * 60 + 32);
  assert.equal(parseClock("05:33 PM"), 17 * 60 + 33);
  assert.equal(parseClock("12:00 AM"), 0);
  assert.equal(parseClock("12:15 PM"), 12 * 60 + 15);
  assert.equal(parseClock("15:32"), 15 * 60 + 32);
  assert.equal(parseClock("nope"), null);
});

test("a wrong time or date does not pass the read-back (Instagram's own formats)", () => {
  assert.equal(judgeReelSchedule({ dateText: "Sat, Oct 17, 2026", timeText: "3:32 PM" }, target).ok, true);
  assert.equal(judgeReelSchedule({ dateText: "Sat, Oct 17, 2026", timeText: "3:30 PM" }, target).ok, false, "wrong time");
  assert.equal(judgeReelSchedule({ dateText: "Sat, Oct 17, 2026", timeText: "3:32 AM" }, target).ok, false, "wrong AM/PM");
  assert.equal(judgeReelSchedule({ dateText: "Fri, Oct 16, 2026", timeText: "3:32 PM" }, target).ok, false, "wrong date");
  assert.equal(judgeReelSchedule({ dateText: null, timeText: null }, target).ok, false, "nothing");
  assert.equal(dateMatches("Tue, Oct 17, 2026", target), true);
  assert.equal(dateMatches("Mon, Jan 1, 2026", target), false);
});

/* --------------------------------------------------------- against the UI -- */

test("Schedule content turns on and reveals the Date and Time fields", { skip: !haveBrowser }, async () => {
  const p = await page(fixture());
  assert.equal(await enableScheduleContent(p, quiet), true);
  assert.equal(await p.locator('[role="switch"]#sched').getAttribute("aria-checked"), "true");
  assert.equal(await p.locator("#fields").isVisible(), true);
  await p.close();
});

test("Schedule content is enabled inside a scrolled dialog without toggling AI disclosure", { skip: !haveBrowser }, async () => {
  const p = await page(fixture());
  try {
    await p.addStyleTag({ content: 'div[role="dialog"]{position:fixed;top:40px;left:200px;width:450px;height:180px;overflow:auto} #sched{margin-top:450px}' });
    assert.equal(await enableScheduleContent(p, quiet), true);
    assert.equal(await p.locator('#sched').getAttribute('aria-checked'), 'true');
    assert.equal(await p.locator('[role="switch"]').first().getAttribute('aria-checked'), 'true');
  } finally { await p.close(); }
});

test("the exact date and time are entered and read back, and the button becomes Schedule not Share", { skip: !haveBrowser }, async () => {
  const p = await page(fixture());
  await enableScheduleContent(p, quiet);
  await setReelDate(p, target, quiet);
  await setReelTime(p, target, quiet);

  const reading = await readReelSchedule(p);
  const verdict = judgeReelSchedule(reading, target);
  assert.equal(verdict.ok, true, `read back: ${JSON.stringify(reading)} / problems: ${verdict.problems.join(" ")}`);
  assert.equal(await p.locator("#date").inputValue(), "17 Oct 2026", "the prefilled date was replaced with the target");
  assert.match(await p.locator("#tdisp").innerText(), /0?3 : 32 PM/, "the hours and minutes were set to the 12-hour target");
  assert.equal(await scheduleButtonReady(p), true, "the final button reads Schedule and is enabled");
  await p.close();
});

test("pressing Schedule clicks Schedule, never Share; dialog text alone is not proof of acceptance", { skip: !haveBrowser }, async () => {
  const p = await page(fixture());
  await enableScheduleContent(p, quiet);
  await setReelDate(p, target, quiet);
  await setReelTime(p, target, quiet);
  await pressSchedule(p, quiet);
  const f = await flags(p);
  assert.equal(f.scheduled, true, "the Schedule button was pressed");
  assert.equal(f.shared, false, "Share was never pressed");
  assert.match(await readDialog(p), /will be shared on .*17 Oct 2026.*0?3 : 32 PM/);
  await p.close();
});

test("a screen with no Schedule content toggle is reported, not forced", { skip: !haveBrowser }, async () => {
  const p = await page(fixture({ noToggle: true }));
  assert.equal(await enableScheduleContent(p, quiet), false);
  await p.close();
});

test("pressSchedule throws (without sharing) when there is no Schedule button", { skip: !haveBrowser }, async () => {
  const p = await page(fixture({ noToggle: true })); // button stays "Share"
  await assert.rejects(pressSchedule(p, quiet), /Schedule.*button is not on the page|not on the page/);
  assert.equal((await flags(p)).shared, false, "it did not fall back to Share");
  await p.close();
});
