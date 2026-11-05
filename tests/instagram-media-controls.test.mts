import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { locateChromium } from "../src/lib/publish/browser/engine";
import { chooseOriginalCrop } from "../src/lib/publish/browser/instagram-crop";
import { applyReelCover } from "../src/lib/publish/browser/instagram-cover";
import { WORK_ROOT } from "../src/lib/paths";
import { requireIsolation } from "./setup/isolation";

let browser: Browser;
const cover = path.join(WORK_ROOT, "selected-cover.png");
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZf8AAAAASUVORK5CYII=", "base64");
test.before(async () => {
  requireIsolation("media tests only use fixture files and disposable browser pages");
  await fs.writeFile(cover, bytes);
  browser = await chromium.launch({ executablePath: locateChromium() ?? undefined });
});
test.after(async () => { await browser?.close(); });

test("crop opens the icon, waits for delayed options, and selects only Original", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button style="display:none">Original</button><div role="dialog"><h1>Crop</h1>
      <button aria-label="Select crop" onclick="setTimeout(()=>document.querySelector('#options').hidden=false,100)">Expand</button>
      <div id="options" hidden>${["Original","1:1","9:16","16:9"].map(t=>`<button onclick="window.choice=this.textContent;this.setAttribute('aria-pressed','true')">${t}</button>`).join("")}</div></div>`);
    await chooseOriginalCrop(page, () => {}, 1500);
    assert.equal(await page.evaluate(() => (window as unknown as {choice:string}).choice), "Original");
  } finally { await page.close(); }
});

test("missing or rejected Original blocks the workflow", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div role="dialog"><h1>Crop</h1><button>Next</button></div>');
    await assert.rejects(chooseOriginalCrop(page, () => {}, 100), /Original could not be selected/);
    await page.setContent('<div role="dialog"><h1>Crop</h1><button aria-pressed="false">Original</button></div>');
    await assert.rejects(chooseOriginalCrop(page, () => {}, 100), /unselected/);
  } finally { await page.close(); }
});

test("live Crop markup: capitalised SVG name clicks its button, not the media gallery, and verifies selection", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>#ratios { --ig-secondary-text:106,113,122 } #ratios span,#ratios svg {color:rgb(106,113,122)} #ratios .selected span,#ratios .selected svg {color:white}</style>
      <div role="dialog"><h1>Crop</h1><div role="button"><button onclick="document.querySelector('#ratios').hidden=false;window.cropClicked=true"><svg aria-label="Select Crop"></svg></button></div>
      <button onclick="window.galleryClicked=true"><svg aria-label="Open Media Gallery"></svg></button>
      <div id="ratios" hidden>${['Original','1:1','9:16','16:9'].map(text=>`<div role="button" class="${text==='1:1'?'selected':''}" onclick="document.querySelector('.selected').className='';this.className='selected'"><span>${text}</span><svg><title>${text==='Original'?'Photo outline icon':'Crop icon'}</title></svg></div>`).join('')}</div></div>`);
    await chooseOriginalCrop(page, () => {}, 1500);
    assert.equal(await page.evaluate(() => (window as unknown as {cropClicked:boolean}).cropClicked), true);
    assert.equal(await page.evaluate(() => (window as unknown as {galleryClicked?:boolean}).galleryClicked), undefined);
    assert.equal(await page.locator('.selected span').innerText(), 'Original');
    // A click that does nothing must not be mistaken for a selection.
    await page.locator('#ratios [role=button]').evaluateAll(els => els.forEach(el => { el.removeAttribute('onclick'); el.setAttribute('class', ''); }));
    await assert.rejects(chooseOriginalCrop(page, () => {}, 200), /could not be verified/);
  } finally { await page.close(); }
});

function coverHtml(where: "cover" | "elsewhere" | "none") {
  return `<div role="dialog"><section><h2>Cover photo</h2><input id="file" type="file" accept="image/png" hidden>
    <button onclick="document.querySelector('#file').click()">Select from computer</button><img id="preview" width="60" height="60"></section>
    <img id="unrelated" width="60" height="60"></div><script>
    document.querySelector('#file').onchange=e=>{
      ${where === "none" ? "" : `document.querySelector('${where === "cover" ? "#preview" : "#unrelated"}').src=URL.createObjectURL(e.target.files[0]);`}
    };</script>`;
}

test("custom cover uses the exact selected file and verifies its own preview", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(coverHtml("cover"));
    assert.equal(await applyReelCover(page, cover, () => {}, 1500), true);
    const attached = await page.locator('#file').evaluate(async el => Array.from(new Uint8Array(await (el as HTMLInputElement).files![0].arrayBuffer())));
    assert.deepEqual(attached, [...bytes]);
  } finally { await page.close(); }
});

test("unrelated image changes and ignored uploads cannot verify a cover", async () => {
  const page = await browser.newPage();
  try {
    for (const where of ["elsewhere","none"] as const) {
      await page.setContent(coverHtml(where));
      await assert.rejects(applyReelCover(page, cover, () => {}, 300), /did not update the Cover photo preview/);
    }
  } finally { await page.close(); }
});

test("unsupported custom-cover composer stops rather than using an automatic frame", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div role="dialog">Edit video<button>Next</button></div>');
    await assert.rejects(applyReelCover(page, cover, () => {}, 100), /does not offer custom cover upload/);
  } finally { await page.close(); }
});

test("live cover layout: picker header excludes the video overlay; verify exact bytes there", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="dialog"><div><video></video><div id="overlay" style="width:80px;height:80px"></div></div>
      <section><span>Cover photo</span><form><input type="file" accept="image/png"></form>
      <button onclick="document.querySelector('input').click()">Select From Computer</button></section></div>
      <script>document.querySelector('input').onchange=e=>document.querySelector('#overlay').style.backgroundImage='url('+URL.createObjectURL(e.target.files[0])+')'</script>`);
    assert.equal(await applyReelCover(page, cover, () => {}, 1500), true);
    await page.locator('input').evaluate(el => {
      (el as HTMLInputElement).onchange = () => {
        document.querySelector<HTMLElement>('#overlay')!.style.backgroundImage = `url(${URL.createObjectURL(new Blob(['wrong frame']))})`;
      };
    });
    await assert.rejects(applyReelCover(page, cover, () => {}, 300), /did not update/);
  } finally { await page.close(); }
});
