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
//
// IMPORTANT for anyone writing a new effect: `stateAt()` below drives the
// timeline with `window.__tl.pause(t)`, and the real frame-by-frame renderer
// (Task 18+) does the same thing with `.seek(t)` — both are GSAP APIs that
// move the playhead WITHOUT dispatching the timeline's own `onUpdate`,
// `onStart` or `onComplete` callbacks. An effect wired to fire on one of those
// callbacks (rather than driven by the tween's own progress/property values,
// which this harness and the renderer both evaluate correctly) never runs
// under either one — it looks fine scrubbing in a live browser tab, where
// `play()`/`seek()` from user interaction can still touch those callbacks
// depending on how the effect is wired, and then renders as silently dead
// here and in the actual output. If an effect depends on `onUpdate` /
// `onStart` / `onComplete`, that dependency itself is the bug to fix, not
// something this harness or the renderer should be made to accommodate.
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
// The whole registry, not one theme: see checkTheme's doc comment.
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
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
      // Every element the timeline writes to. The framed layout (spec
      // 2026-08-23) added four tweened elements — #card-pop, #progress, #hook
      // and #cta-card — and #card-pop is the riskiest tween in the whole
      // composition (several non-overlapping fromTo scale tweens on one
      // element). A harness that did not look at them would report
      // "seek-safe" while proving nothing about the new work, so the selector
      // grew with the composition rather than the composition being trimmed
      // to fit the harness.
      //
      // The presentation addendum (spec 2026-08-23 §8/§11) added three more:
      // #card-drift (the depth drift's own wrapper), #card-sweep (the light
      // band, a chain of non-overlapping fromTo xPercent tweens — the same
      // riskiest-shape-in-the-composition as #card-pop) and #buy-card. Same
      // reasoning as above: an untracked tweened element is an untested one.
      for (const el of document.querySelectorAll(
        // The scene stack (Phase 3C) added the riskiest shape yet: one layer
        // per scene, each with its own inner elements, all tweened from a
        // generic data-driven loop. Every one is tracked — the layers, every
        // animated element inside them, the card's own visibility, the crop
        // zoom and the backdrop glow — because an untracked tweened element
        // is an untested one, and this is where a whole template could be
        // silently wrong.
        "[data-stroke], .caption-line, .cue, #column, #card-pop, #card-drift, #card-sweep, #progress, #hook, #cta-card, #buy-card, #card, #card-zoom, #scene-glow, .sc, .sc [data-el]",
      )) {
        const cs = getComputedStyle(el);
        const key =
          el.dataset.stroke !== undefined
            ? `stroke:${el.dataset.stroke}`
            : el.dataset.caption !== undefined
              ? `caption:${el.dataset.caption}`
              : el.dataset.cue !== undefined
                ? `cue:${el.dataset.cue}`
                : el.dataset.scene !== undefined
                  ? `scene:${el.dataset.scene}`
                  : el.dataset.el !== undefined
                    ? `el:${el.closest("[data-scene]")?.dataset.scene}:${el.dataset.el}`
                    : el.id;
        out[key] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
      }
      return out;
    },
    { t, props: TRACKED },
  );
}

/**
 * One theme, sampled `SAMPLE_COUNT` times. Returns the number of state
 * mismatches found.
 *
 * Every theme is checked, not just the default one, and that is not
 * belt-and-braces: a theme supplies `css()` and `strokeMarkup()` into the same
 * document the timeline drives, so a theme is perfectly capable of introducing
 * a seek-unsafe frame on its own — a CSS transition on a tweened property, a
 * `transform` declared on an element GSAP also writes, an `animation` that
 * resolves by wall clock rather than by playhead. None of those would be
 * caught by running this harness against Marginalia alone, and all of them
 * render as a video that is subtly wrong in a way no test would explain.
 */
async function checkTheme(browser, id, theme, withScenes = false) {
  // The byline and the purchase card (spec 2026-08-23 §9/§11) are the
  // present-only branches of the composition: with no `bookLink` there is no
  // #buy-card element in the document at all, so widening the selector above
  // to include it would have proved exactly nothing on the bare fixture. These
  // three fields are supplied HERE rather than in the shared fixture so the
  // fixture keeps describing the geometry case it was written for, and so the
  // "absent" shape it already covers stays covered by every other consumer.
  const html = buildComposition({
    ...fixtureInput({ theme, withScenes }),
    bookTitle: "The Fixture Book of Very Long Titles Indeed",
    author: "A Verified Author",
    bookLink: "https://example.com/fixture-book",
  });

  // A page per theme rather than one reused across all of them: a stale
  // timeline left paused at some timestamp by the previous theme is exactly
  // the kind of shared state this harness exists to rule out.
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

  page.on("pageerror", (err) => {
    console.error(`[${id}] Page error while loading the composition: ${err.message}`);
  });

  try {
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
      console.error(`[${id}] window.__tl.duration() returned ${duration} — not a usable timeline.`);
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
          console.error(`[${id}] NOT SEEK-SAFE at t=${t.toFixed(3)}s — element "${key}" disappeared after seeking away and back`);
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
              `[${id}] NOT SEEK-SAFE at t=${t.toFixed(3)}s — ${key}.${prop}: "${before}" then "${after}"`,
            );
          }
        }
      }
    }

    if (failures === 0) console.log(`${id}: seek-safe across ${samples.length} timestamps.`);
    return failures;
  } finally {
    await page.close();
  }
}

async function main() {
  // An id may be passed to check a single theme (`npm run e2e:seek -- terminal`)
  // while working on it; with no argument EVERY theme is checked, which is what
  // CI and `npm run e2e:seek` do.
  const only = process.argv[2];
  if (only && !(only in BOOK_THEMES)) {
    console.error(`Unknown theme "${only}". Known: ${Object.keys(BOOK_THEMES).join(", ")}`);
    process.exit(1);
  }
  const themes = Object.entries(BOOK_THEMES).filter(([id]) => !only || id === only);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.error(`Could not launch Chromium: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    let failures = 0;
    for (const [id, theme] of themes) {
      // Both shapes: the page-only composition every photographed episode
      // still renders, and the scene stack an idea episode renders.
      failures += await checkTheme(browser, id, theme, false);
      failures += await checkTheme(browser, `${id}+scenes`, theme, true);
    }

    if (failures) {
      console.error(`\n${failures} state mismatches across ${themes.length} theme(s). The same timestamp renders two different frames depending on how it was reached.`);
      process.exit(1);
    }

    console.log(`\nSeek-safe: ${themes.length} theme(s) × ${SAMPLE_COUNT} timestamps.`);
  } finally {
    await browser.close();
  }
}

await main();
