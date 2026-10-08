import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";
import { mkdirSync } from "node:fs";

const hero = process.argv[2] || "mountain";
mkdirSync(".ov/hero", { recursive: true });
const input = fixtureInput({ theme: BOOK_THEMES.marginalia, withScenes: true, cinematic: true });
// Scene 2 is a cinematic scene running 4.3-6.6s; make it the hero under test.
for (const s of input.scenes ?? []) if (s.cine && !s.cine.hook) s.cine = { ...s.cine, hero, keyword: hero };
const html = buildComposition(input);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
page.on("pageerror", e => console.log("PAGEERROR", e.message));
await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "load" });
await page.waitForFunction(() => Boolean(window.__tl), { timeout: 20000 });
await page.waitForTimeout(2500); // let three@0.160 arrive from the CDN
// Scene 2 runs 4.3-6.6 plus AUDIO_OFFSET 0.7 => 5.0-7.3
const times = [5.3, 5.7, 6.1, 6.5, 6.9, 7.2];
let i = 0;
for (const t of times) {
  const info = await page.evaluate((t) => {
    window.__tl.seek(t, false);
    const c = document.querySelector(".cine-canvas");
    if (!c) return "no canvas";
    // Is anything actually painted? Count non-background pixels.
    const g = document.createElement("canvas"); g.width = 160; g.height = 284;
    const cx = g.getContext("2d"); cx.drawImage(c, 0, 0, 160, 284);
    const d = cx.getImageData(0, 0, 160, 284).data;
    let lit = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] + d[k+1] + d[k+2] > 40) lit++;
    return { lit, of: 160 * 284 };
  }, t);
  console.log(`t=${t}`, JSON.stringify(info));
  await page.screenshot({ path: `.ov/hero/${hero}-${i++}.png` });
}
await browser.close();
