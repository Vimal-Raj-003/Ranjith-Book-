import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";
import { mkdirSync } from "node:fs";
mkdirSync(".ov/val", { recursive: true });
const log = (m) => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
const T0 = Date.now();

const GLYPH = {
  food: '<path d="M4 3v18M4 10h5M9 3v18" /><path d="M17 3c-1.5 3-1.5 7 0 10v8" />',
  friends: '<circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />',
  piano: '<rect x="3" y="7" width="18" height="11" rx="1" /><path d="M8 7v7M12 7v7M16 7v7" />',
};
const input = fixtureInput({ theme: BOOK_THEMES.spotlight, withScenes: true });
for (const s of input.scenes ?? []) {
  if (s.kind !== "icon-concept") continue;
  s.icons = Object.entries(GLYPH).map(([name, paths]) => ({ name, paths, query: name, score: 0.6 }));
  s.items = ["Food", "Friends", "Piano"];
}
const html = buildComposition(input);
log(`built; <canvas class="sc-three"> count = ${(html.match(/<canvas class="sc-three"/g)||[]).length}`);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
log("browser up");
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
page.on("pageerror", (e) => log("PAGEERROR " + e.message));
await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "domcontentloaded" });
log("content set");
await page.waitForFunction(() => Boolean(window.__tl), { timeout: 25000 });
log("timeline up");
await page.evaluate(() => { window.__tl.seek(6.4, false); });
log("seeked");
await page.screenshot({ path: ".ov/val/icons_fixed.png" });
log("shot written");
await browser.close();
