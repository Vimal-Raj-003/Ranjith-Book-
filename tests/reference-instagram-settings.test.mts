import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { locateChromium as findChromium } from "../src/lib/publish/browser/engine";
import { enableAiLabel, fillNativeInstagramCaption } from "../src/lib/publish/browser/instagram-settings";
import { sameInstagramCaption } from "../src/lib/publish/browser/instagram-calendar";

let browser: Browser;
const executablePath = await findChromium();
test.before(async () => {
  if (executablePath) browser = await chromium.launch({ executablePath });
});
test.after(async () => { await browser?.close(); });

const fixture = (on = false, inert = false) => `<!doctype html>
<style>
body{height:1600px;margin:0} [role=dialog]{position:fixed;top:40px;left:200px;width:400px;height:180px;overflow:auto}
[role=switch]{display:inline-block;width:44px;height:24px;background:#888}
</style>
<div style="display:none"><span>Add AI label</span><button role="switch" aria-checked="false"></button></div>
<div role="dialog">
 <div><span>Schedule content</span><button id="schedule" role="switch" aria-checked="false"></button></div>
 <div style="height:450px"></div>
 <div><span>Add AI label</span><button id="ai" role="switch" aria-checked="${on}"></button></div>
 <div style="height:450px"></div>
</div>
<script>
window.clicks=0;document.querySelector('#ai').onclick=()=>{window.clicks++;
 ${inert ? "" : "setTimeout(()=>{const old=document.querySelector('#ai');const next=old.cloneNode(true);next.setAttribute('aria-checked','true');old.replaceWith(next)},300);"}
};
</script>`;

test("filling the approved caption never opens Instagram's Escape-triggered discard dialog", { skip: !executablePath }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="dialog"><div contenteditable="true" style="white-space:pre-wrap" aria-label="Write a caption"></div></div>
      <script>window.discard=false;window.addEventListener('keydown',e=>{if(e.key==='Escape')window.discard=true})</script>`);
    const caption = "The approved caption.\n\nhttps://github.com/4ian/GDevelop\n#gdevelop";
    await fillNativeInstagramCaption(page, '[contenteditable="true"]', caption);
    assert.equal(sameInstagramCaption(await page.locator('[contenteditable="true"]').innerText(), caption), true);
    assert.equal(await page.evaluate(() => (window as unknown as {discard:boolean}).discard), false);
  } finally { await page.close(); }
});

test("AI disclosure turns on inside a scrolled dialog and survives an asynchronous rerender", { skip: !executablePath }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture());
    assert.equal(await enableAiLabel(page, () => {}), true);
    assert.equal(await page.locator('#ai').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#schedule').getAttribute('aria-checked'), 'false');
    assert.equal(await page.evaluate(() => (window as unknown as {clicks:number}).clicks), 1);
  } finally { await page.close(); }
});

test("an enabled AI disclosure is verified without toggling it off", { skip: !executablePath }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture(true));
    assert.equal(await enableAiLabel(page, () => {}), true);
    assert.equal(await page.evaluate(() => (window as unknown as {clicks:number}).clicks), 0);
  } finally { await page.close(); }
});

test("an unresponsive AI disclosure fails closed, leaving the other switch untouched", { skip: !executablePath }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture(false, true));
    assert.equal(await enableAiLabel(page, () => {}), false);
    assert.equal(await page.locator('#schedule').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#ai').getAttribute('aria-checked'), 'false');
  } finally { await page.close(); }
});
