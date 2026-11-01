import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { locateChromium as findChromium } from "../src/lib/publish/browser/engine";
import { settleNoOverlay, visibleScrims } from "../src/lib/publish/browser/youtube-schedule";

/**
 * The failure the dry run showed: on Studio's Schedule card, each control opens its
 * own overlay (the date calendar, the time list, the time-zone picker), and while one
 * is open a transparent `.dialog-scrim` covers the card and swallows clicks. Setting the
 * date left the calendar's scrim up, so the click on the time box never landed and the
 * time stayed "00:00". The fix dismisses the overlay — Escape, but only while a scrim is
 * actually there, so it never closes the whole upload dialog — before touching the box.
 *
 * The fixture models exactly that: a transparent, fixed scrim over an input that a nested
 * overlay would raise, and an Escape handler that drops it the way closing the overlay does.
 * These run in a real Chromium so the scrim's pointer-interception is the real thing.
 */
let browser: Browser;
const haveBrowser = Boolean(await findChromium());

test.before(async () => {
  if (haveBrowser) browser = await chromium.launch({ executablePath: (await findChromium()) ?? undefined });
});
test.after(async () => {
  await browser?.close();
});

/** A time box with a transparent scrim over it; Escape removes the scrim (closing the "overlay"). */
function fixture({ withScrim }: { withScrim: boolean }): string {
  return `<!doctype html><html><body>
    <input id="time" value="00:00">
    ${withScrim ? '<div class="dialog-scrim" style="position:fixed;inset:0;z-index:9999;background:transparent"></div>' : ""}
    <script>
      window.__escapes = 0;
      window.__clicked = false;
      document.getElementById("time").addEventListener("click", () => { window.__clicked = true; });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        window.__escapes++;
        const s = document.querySelector(".dialog-scrim");
        if (s) s.remove();
      });
    </script>
  </body></html>`;
}

const page = async (html: string): Promise<Page> => {
  const p = await browser.newPage();
  await p.setContent(html);
  return p;
};
const escapes = (p: Page) => p.evaluate(() => (window as unknown as { __escapes: number }).__escapes);
const clicked = (p: Page) => p.evaluate(() => (window as unknown as { __clicked: boolean }).__clicked);

test("Polymer picker backdrop is dismissed without closing the upload dialog", { skip: !haveBrowser }, async () => {
  const p = await page(`<style>
    tp-yt-iron-overlay-backdrop {position:fixed;inset:0;z-index:10}
    ytcp-uploads-dialog {display:block;position:fixed;inset:40px;background:white;z-index:20}
    #picker {z-index:30}
  </style>
  <tp-yt-iron-overlay-backdrop id="background" opened class="opened"></tp-yt-iron-overlay-backdrop>
  <ytcp-uploads-dialog><input data-rr-sched="time-input" value="00:00"></ytcp-uploads-dialog>
  <tp-yt-iron-overlay-backdrop id="picker" opened class="opened"></tp-yt-iron-overlay-backdrop>
  <script>window.__escapes=0;document.addEventListener('keydown',e=>{if(e.key==='Escape'){window.__escapes++;document.querySelector('#picker')?.remove();}})</script>`);
  try {
    assert.equal(await visibleScrims(p), 1);
    await settleNoOverlay(p);
    await p.locator('input').click({ timeout: 2000 });
    assert.equal(await escapes(p), 1);
    assert.equal(await p.locator('#background').count(), 1);
    await settleNoOverlay(p);
    assert.equal(await escapes(p), 1, "the upload's background does not cause another Escape");
  } finally { await p.close(); }
});

test("an unresponsive picker stops after four attempts", { skip: !haveBrowser }, async () => {
  const p = await page('<tp-yt-iron-overlay-backdrop opened style="position:fixed;inset:0"></tp-yt-iron-overlay-backdrop><script>window.__escapes=0;document.addEventListener("keydown",e=>{if(e.key==="Escape")window.__escapes++;})</script>');
  try {
    await assert.rejects(settleNoOverlay(p), /still blocks.*four Escape/);
    assert.equal(await escapes(p), 4);
  } finally { await p.close(); }
});

test("the fixture is real: a scrim intercepts a click on the box beneath it", { skip: !haveBrowser }, async () => {
  const p = await page(fixture({ withScrim: true }));
  // This is the bug: the control is visible and enabled, but the scrim eats the click.
  await assert.rejects(p.locator("#time").click({ timeout: 1500 }), /intercepts pointer events|Timeout/);
  await p.close();
});

test("settleNoOverlay clears the scrim, so the box beneath can be clicked", { skip: !haveBrowser }, async () => {
  const p = await page(fixture({ withScrim: true }));
  assert.equal(await visibleScrims(p), 1, "the scrim is up to start with");
  await settleNoOverlay(p);
  assert.equal(await visibleScrims(p), 0, "the scrim is gone after settling");
  // The same click that was intercepted now lands.
  await p.locator("#time").click({ timeout: 3000 });
  assert.equal(await clicked(p), true, "the click reached the time box");
  await p.close();
});

test("settleNoOverlay does nothing — and presses nothing — when no scrim is up", { skip: !haveBrowser }, async () => {
  const p = await page(fixture({ withScrim: false }));
  assert.equal(await visibleScrims(p), 0);
  await settleNoOverlay(p);
  // Crucial: it must not press Escape when there is no overlay, or it could dismiss the
  // upload dialog itself. No scrim ⇒ no Escape.
  assert.equal(await escapes(p), 0, "Escape was never pressed with nothing to dismiss");
  await p.close();
});
