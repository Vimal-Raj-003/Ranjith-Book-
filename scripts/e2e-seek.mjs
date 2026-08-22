// Seek-safety harness (Task 16).
//
// Rendering seeks to a timestamp and screenshots; it never plays forward.
// Any animation whose resolved state depends on HOW that timestamp was
// reached — rather than purely WHAT the timestamp is — renders two
// different frames for the same instant depending on render order. That
// class of bug looks exactly like a renderer bug and is not one, so this
// harness exists to catch it before the frame-by-frame renderer is built at
// all (Task 18+).
//
// Method: seek to t, seek away in both directions, seek back to t, and
// compare COMPUTED STYLES (not pixels) of every tracked element. Pixels can
// legitimately rasterise a sub-pixel apart between two calls at an identical
// computed state depending on compositing — a check that fails on that noise
// is a check nobody will trust, and a harness nobody trusts is a harness
// nobody runs.
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { marginalia } from "../src/lib/video/composition/themes/marginalia.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

const TRACKED = ["transform", "opacity", "visibility", "width", "height", "left", "top"];
const SAMPLE_COUNT = 24;

/**
 * `transform` needs its own comparison, not a raw string compare: GSAP
 * represents an untouched element's identity transform as the CSS keyword
 * `"none"`, but once its rendering engine has written to that element even
 * once (e.g. a camera key whose y happens to be 0), the SAME identity
 * transform serialises as `"matrix(1, 0, 0, 1, 0, 0)"` (or `matrix3d(...)`
 * with `force3D`) instead. Comparing those two strings literally reports a
 * "seek-unsafe" failure for a pair of states that rasterise pixel-for-pixel
 * identically — exactly the kind of check nobody would trust, just from the
 * opposite direction of the pixel-jitter case the brief warns about (two
 * genuinely different states looking the same, rather than two identical
 * states looking different). Canonicalising both `none` and every algebraic
 * matrix form down to their (a,b,c,d,tx,ty) 2D affine components, rounded to
 * kill float noise, compares what actually gets painted rather than which
 * syntax GSAP happened to pick.
 */
function canonicalizeTransform(value) {
  if (value === "none") return "I(1,0,0,1,0,0)";
  const nums = (value.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
  let a, b, c, d, tx, ty;
  if (value.startsWith("matrix3d(") && nums.length === 16) {
    [a, b, , , c, d, , , , , , , tx, ty] = nums;
  } else if (value.startsWith("matrix(") && nums.length === 6) {
    [a, b, c, d, tx, ty] = nums;
  } else {
    return value; // unrecognised shape — fall back to a literal compare
  }
  const r = (n) => Math.round(n * 1000) / 1000;
  return `I(${r(a)},${r(b)},${r(c)},${r(d)},${r(tx)},${r(ty)})`;
}

async function stateAt(page, t) {
  return page.evaluate(
    ({ t, props }) => {
      window.__tl.pause(t);
      const out = {};
      for (const el of document.querySelectorAll("[data-stroke], .caption-line, #column")) {
        const cs = getComputedStyle(el);
        const key =
          el.dataset.stroke !== undefined
            ? `stroke:${el.dataset.stroke}`
            : el.dataset.caption !== undefined
              ? `caption:${el.dataset.caption}`
              : el.id;
        out[key] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
      }
      return out;
    },
    { t, props: TRACKED },
  );
}

async function main() {
  const html = buildComposition(fixtureInput({ theme: marginalia }));

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.error(`Could not launch Chromium: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

    page.on("pageerror", (err) => {
      console.error(`Page error while loading the composition: ${err.message}`);
    });

    await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "load" });

    try {
      await page.waitForFunction(() => Boolean(window.__tl), { timeout: 10_000 });
    } catch {
      // The composition loads GSAP from a CDN — if the network is
      // unavailable the script tag never fires and window.__tl never
      // appears. That is an environment problem, not a seek-safety
      // failure, and reporting it as one would send someone chasing a
      // regression that does not exist.
      console.error(
        "window.__tl never appeared. The composition loads GSAP from a CDN " +
          "(cdn.jsdelivr.net) — if the network is unavailable here, that is " +
          "why, not a seek-safety failure. Check connectivity and re-run.",
      );
      process.exit(1);
    }

    const duration = await page.evaluate(() => window.__tl.duration());
    if (!Number.isFinite(duration) || duration <= 0) {
      console.error(`window.__tl.duration() returned ${duration} — not a usable timeline.`);
      process.exit(1);
    }

    const samples = Array.from(
      { length: SAMPLE_COUNT },
      (_, i) => (duration * (i + 0.5)) / SAMPLE_COUNT,
    );

    let failures = 0;
    for (const t of samples) {
      const first = await stateAt(page, t);
      // Seek away in both directions, then back. The bug this catches is
      // GSAP reverting a fromTo to a different from-state after a backward
      // seek, or a tween whose immediateRender snaps an element on the way
      // past rather than only at its own start time.
      await stateAt(page, Math.min(duration, t + duration * 0.4));
      await stateAt(page, Math.max(0, t - duration * 0.4));
      const again = await stateAt(page, t);

      for (const key of Object.keys(first)) {
        const afterProps = again[key];
        if (!afterProps) {
          failures++;
          console.error(`NOT SEEK-SAFE at t=${t.toFixed(3)}s — element "${key}" disappeared after seeking away and back`);
          continue;
        }
        for (const prop of TRACKED) {
          const before = first[key][prop];
          const after = afterProps[prop];
          const changed =
            prop === "transform" ? canonicalizeTransform(before) !== canonicalizeTransform(after) : before !== after;
          if (changed) {
            failures++;
            console.error(
              `NOT SEEK-SAFE at t=${t.toFixed(3)}s — ${key}.${prop}: "${before}" then "${after}"`,
            );
          }
        }
      }
    }

    if (failures) {
      console.error(`\n${failures} state mismatches across ${samples.length} timestamps. The same timestamp renders two different frames depending on how it was reached.`);
      process.exit(1);
    }

    console.log(`Seek-safe across ${samples.length} timestamps.`);
  } finally {
    await browser.close();
  }
}

await main();
