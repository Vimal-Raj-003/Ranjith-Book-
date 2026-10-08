// Layout-stability harness: catches elements whose POSITION depends on whether
// something is animating.
//
// The bug this was written for, found in a real episode: the timeline scene's
// bullet dots sat on top of the second letter of their own labels. The dots are
// `position:absolute; left:20px`, written to resolve against `.sc-timeline`,
// whose `padding-left:86px` puts the labels clear of them. That is correct
// right up until the row's entrance tween runs — because a transformed element
// becomes the containing block for its absolutely positioned descendants, so
// the instant GSAP wrote a transform on `.sc-tl-row` every dot re-resolved its
// `left` against the ROW instead, 86px further right, straight onto the text.
// And GSAP leaves the identity `matrix(1,0,0,1,0,0)` behind once a tween
// settles, so it was not a flicker during the animation: it was every frame of
// the scene from the entrance onwards.
//
// Nothing in the existing suites could see it. The seek-safety harness compares
// a timestamp against ITSELF reached two ways, and this was wrong identically
// every time it was reached, so it passed. The composition tests read markup
// and never lay it out. Only the finished video showed it.
//
// The check is deliberately free of heuristics: apply an IDENTITY transform to
// every element the timeline animates. An identity transform is by definition
// a visual no-op, so any element that MOVES under one has a containing block
// that depends on whether it is mid-animation — which is this bug, whatever
// shape it takes. There is nothing to tune and nothing to special-case: a
// failure here is always real.
//
// Run: npm run e2e:layout
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

/** Anything the composition moves carries one of these. */
const ANIMATED = "[data-el], [data-drift], [data-stroke], [data-scene]";

const PROBE = (animatedSel) => {
  // Measured against the element's own scene layer rather than the viewport, so
  // a scene that is itself legitimately offset does not look like every one of
  // its children moved.
  const snapshot = () => {
    const out = new Map();
    for (const el of document.querySelectorAll(".sc *")) {
      const cs = getComputedStyle(el);
      // Only absolutely positioned elements can have their containing block
      // swapped out from under them; everything else is laid out in flow by
      // its parent and is unaffected by an ancestor's transform.
      if (cs.position !== "absolute" && cs.position !== "fixed") continue;
      const layer = el.closest("[data-scene]");
      if (!layer) continue;
      const r = el.getBoundingClientRect();
      const base = layer.getBoundingClientRect();
      out.set(el, {
        scene: layer.dataset.scene,
        cls: el.className || el.tagName.toLowerCase(),
        x: Math.round(r.left - base.left),
        y: Math.round(r.top - base.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  };

  const before = snapshot();

  // The no-op. If the document is sane, this changes nothing at all.
  const style = document.createElement("style");
  style.textContent = `${animatedSel} { transform: translate(0px, 0px) !important; }`;
  document.head.appendChild(style);

  const after = snapshot();
  style.remove();

  const moved = [];
  for (const [el, a] of before) {
    const b = after.get(el);
    if (!b) continue;
    if (a.x !== b.x || a.y !== b.y) {
      moved.push({
        scene: a.scene,
        cls: a.cls,
        from: [a.x, a.y],
        to: [b.x, b.y],
        by: [b.x - a.x, b.y - a.y],
        // The nearest animated ancestor is the one that stole the containing
        // block, which is the element whose CSS needs position:relative.
        culprit: (() => {
          let n = el.parentElement;
          while (n && !n.hasAttribute("data-scene")) {
            if (n.matches(animatedSel)) return n.className || n.tagName.toLowerCase();
            n = n.parentElement;
          }
          return "(none found)";
        })(),
      });
    }
  }
  return moved;
};

async function checkOne(browser, label, input) {
  const html = buildComposition(input);
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  try {
    await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "load" });
    try {
      await page.waitForFunction(() => Boolean(window.__tl), { timeout: 15_000 });
    } catch {
      console.error(
        "window.__tl never appeared. The composition loads GSAP from a CDN " +
          "(cdn.jsdelivr.net) — if the network is unavailable here that is why, " +
          "not a layout failure. Check connectivity and re-run.",
      );
      process.exit(1);
    }
    await page.evaluate(() => document.fonts.ready);
    const moved = await page.evaluate(PROBE, ANIMATED);
    if (errors.length) console.error(`[${label}] page errors: ${errors.join(" | ")}`);
    return moved;
  } finally {
    await page.close();
  }
}

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
  } catch (err) {
    console.error(`Could not launch Chromium: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    let failures = 0;
    for (const [id, theme] of Object.entries(BOOK_THEMES)) {
      // Both scene shapes, so every template is laid out at least once: the
      // plain stack, and the one where three scenes become cinematic heroes.
      for (const cinematic of [false, true]) {
        const label = `${id}${cinematic ? "+cinematic" : ""}`;
        const moved = await checkOne(browser, label, fixtureInput({ theme, withScenes: true, cinematic }));
        for (const m of moved) {
          failures++;
          console.error(
            `[${label}] scene ${m.scene}: .${m.cls} MOVES ${m.by[0]},${m.by[1]}px ` +
              `(${m.from} to ${m.to}) when "${m.culprit}" is animated — ` +
              `that ancestor steals the containing block; give it position:relative ` +
              `and measure this element from it.`,
          );
        }
        if (!moved.length) console.log(`${label}: layout stable under animation.`);
      }
    }
    if (failures) {
      console.error(`\n${failures} element(s) move under an identity transform, which must be a no-op.`);
      process.exit(1);
    }
    console.log(`\nLayout stable: ${Object.keys(BOOK_THEMES).length} theme(s) x 2 scene shapes.`);
  } finally {
    await browser.close();
  }
}

await main();
