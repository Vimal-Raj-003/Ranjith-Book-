// Do scene transitions dip to an empty frame?
//
// Each scene layer fades IN over SCENE_FADE from its own start and fades OUT
// over SCENE_FADE ending at its own end. Scene i+1 starts exactly where scene i
// ends, so that is a SEQUENTIAL fade, not a crossfade: at the boundary instant
// the outgoing layer has reached zero and the incoming one has not yet begun.
//
// Whether that is visible depends on what is behind. A book scene is carried by
// the page card (#card), which is a separate element, so "no scene layer" there
// is correct and not a defect. Only a boundary where neither a scene layer nor
// the card is on screen actually shows the viewer bare backdrop.
//
// Usage: node --import tsx scripts/_transitions.mjs [theme] [plain]
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

const theme = BOOK_THEMES[process.argv[2] ?? "spotlight"];
const cinematic = process.argv[3] !== "plain";
const html = buildComposition(fixtureInput({ theme, withScenes: true, cinematic }));

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__tl), { timeout: 20_000 });

const out = await page.evaluate(() => {
  const data = JSON.parse(document.getElementById("composition-data").textContent);
  const scenes = (data.scenes || []).map((s, i) => ({ i, kind: s.kind, start: s.start, end: s.end }));
  const cardEl = document.getElementById("card");

  const at = (t) => {
    window.__tl.seek(t, false);
    let best = 0;
    for (const el of document.querySelectorAll(".sc[data-scene]")) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      const o = parseFloat(cs.opacity) || 0;
      if (o > best) best = o;
    }
    const ccs = cardEl ? getComputedStyle(cardEl) : null;
    const card = ccs && ccs.visibility !== "hidden" ? parseFloat(ccs.opacity) || 0 : 0;
    return { scene: +best.toFixed(3), card: +card.toFixed(3) };
  };

  const boundaries = [];
  for (let k = 0; k + 1 < scenes.length; k++) {
    const b = scenes[k].end;
    boundaries.push({
      from: scenes[k].kind,
      to: scenes[k + 1].kind,
      t: +b.toFixed(2),
      before: at(b - 0.25),
      mid: at(b),
      after: at(b + 0.25),
    });
  }
  return { dur: window.__tl.duration(), boundaries };
});

console.log(`timeline ${out.dur.toFixed(2)}s`);
console.log("\nAT EACH SCENE BOUNDARY   scene-cover / page-card-cover");
let empty = 0;
for (const b of out.boundaries) {
  const f = (x) => `${x.scene.toFixed(2)}/${x.card.toFixed(2)}`;
  const blank = b.mid.scene < 0.12 && b.mid.card < 0.12;
  if (blank) empty++;
  console.log(
    `  ${String(b.t).padStart(6)}s  ${b.from.padEnd(12)} -> ${b.to.padEnd(12)}` +
      `  before ${f(b.before)}   AT ${f(b.mid)}   after ${f(b.after)}` +
      (blank ? "   <-- FRAME EMPTY" : ""),
  );
}
console.log(`\n${empty} of ${out.boundaries.length} boundaries leave the frame empty.`);
await browser.close();
