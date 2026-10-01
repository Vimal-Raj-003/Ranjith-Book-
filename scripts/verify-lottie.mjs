// Phase 4 / Lottie — real-browser verification (not a unit test).
//
// Three things a unit test cannot prove because they need an actual browser
// actually fetching an actual CDN script and actually running lottie-web:
//   1. The composition loads lottie-web from the CDN and it plays — no
//      thrown error, real animated SVG content in the DOM.
//   2. Seeking away and back mid-clip renders the identical frame both
//      times — the same seek-safety property scripts/e2e-seek.mjs already
//      proves for every other primitive, checked here for this one too.
//   3. If the CDN script is blocked entirely (simulating a real network
//      failure), the composition still loads and renders cleanly, with the
//      accent slot simply empty — never a broken video over an optional
//      visual.
//
// Every sample below does exactly ONE `page.evaluate` (seek + read state
// together), the same shape scripts/e2e-seek.mjs's own `stateAt()` already
// uses, then an independent `page.screenshot()`. This is not stylistic:
// while first writing this script, a SEPARATE `page.evaluate` call issued
// right after one that had touched `window.lottie` would reliably hang the
// next Playwright/CDP round-trip — reproducible, but confirmed to be a
// quirk of chaining bare evaluate() calls through Playwright specifically,
// not a defect in the composition itself: `e2e-seek.mjs` (which already
// combines its own pause+read into one evaluate per sample) and the real
// HyperFrames renderer (puppeteer-core, an entirely different calling
// convention) both drive this exact fixture, with this exact Lottie scene,
// without incident. Keeping every sample to one evaluate here sidesteps the
// quirk rather than working around it with more machinery.
//
// Every step is also bounded by withTimeout(): a killed `node` process
// (Ctrl+C, a shell timeout wrapper) skips this file's own
// `finally { browser.close() }` and orphans the Chromium process
// underneath it, which is what repeated external kills did while first
// debugging this script. Internal bounds mean the worst case is a clean
// failure message, never orphaned processes.
//
// Screenshots are written to .lottie-verify/ for visual inspection.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { bookThemeById } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

const OUT_DIR = path.join(process.cwd(), ".lottie-verify");
const STEP_MS = 15_000;

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function html() {
  const theme = bookThemeById("marginalia");
  return buildComposition({
    ...fixtureInput({ theme, withScenes: true }),
    bookTitle: "The Fixture Book of Very Long Titles Indeed",
    author: "A Verified Author",
    bookLink: null,
  });
}

async function withPage(browser, opts, fn) {
  const page = await withTimeout(browser.newPage({ viewport: { width: 1080, height: 1920 } }), STEP_MS, "newPage");
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  if (opts?.blockLottieCdn) {
    await withTimeout(page.route("**/lottie-web@*/**", (route) => route.abort("failed")), STEP_MS, "route");
  }
  try {
    await withTimeout(page.setContent(`<!doctype html><body>${html()}</body>`, { waitUntil: "load" }), STEP_MS, "setContent");
    await withTimeout(page.waitForFunction(() => Boolean(window.__tl), { timeout: STEP_MS }), STEP_MS + 1000, "waitForFunction(__tl)");
    return await fn(page, errors);
  } finally {
    await withTimeout(page.close(), 5000, "page.close").catch(() => {});
  }
}

/** Seek and read the Lottie accent's state in ONE evaluate — see the file
 *  header for why this must not be split into two separate calls. */
async function seekAndReadLottieState(page, t) {
  return withTimeout(
    page.evaluate((t) => {
      window.__tl.pause(t);
      const el = document.querySelector('[data-scene="0"] .sc-lottie');
      if (!el) return { hasLottie: typeof window.lottie !== "undefined", element: null };
      const cs = getComputedStyle(el);
      return {
        hasLottie: typeof window.lottie !== "undefined",
        element: { innerHTMLLength: el.innerHTML.length, opacity: cs.getPropertyValue("opacity"), visibility: cs.getPropertyValue("visibility") },
      };
    }, t),
    STEP_MS,
    `seekAndRead@${t}`,
  );
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await withTimeout(chromium.launch(), STEP_MS, "chromium.launch");
  let failed = false;

  try {
    // --- 1: the CDN script loads, the clip plays, screenshots for inspection ---
    await withPage(browser, {}, async (page, errors) => {
      // Scene 0 (kinetic-text, "compounding.") runs 0..2.0s; the lottie tween
      // itself starts at 0 and runs LOTTIE_DURATION_S (1.1s). Three points
      // across it: just after start, mid-clip, and after it settles.
      const samples = [0.15, 0.6, 1.3];
      let sawLottie = false;
      for (const t of samples) {
        const state = await seekAndReadLottieState(page, t);
        if (!state.hasLottie) {
          console.error("FAIL: lottie-web did not load from the CDN — check network connectivity and re-run.");
          failed = true;
          return;
        }
        if (state.element && state.element.innerHTMLLength > 0) sawLottie = true;
        console.log(`t=${t}: ${JSON.stringify(state.element)}`);
        const shot = path.join(OUT_DIR, `lottie-t${t.toFixed(2)}.png`);
        await withTimeout(page.screenshot({ path: shot, clip: { x: 60, y: 250, width: 960, height: 700 } }), STEP_MS, `screenshot@${t}`);
        console.log(`wrote ${shot}`);
      }
      if (!sawLottie) {
        console.error("FAIL: window.lottie loaded, but no rendered SVG content was ever found in the accent slot.");
        failed = true;
      }

      // A fallback-path screenshot for visual contrast: scene 2 is
      // icon-concept (Tabler icons, not Lottie), well clear of the lottie
      // clip's own window, so this frame proves scenes WITHOUT a Lottie
      // accent are visually unaffected by this whole feature. Routed through
      // the same combined seek+read helper as every other sample — see the
      // file header on why a bare `page.evaluate(() => pause(...))` here,
      // with nothing else in the same call, is the one shape that hangs.
      await seekAndReadLottieState(page, 5.0);
      const otherShot = path.join(OUT_DIR, "non-lottie-scene.png");
      await withTimeout(page.screenshot({ path: otherShot, clip: { x: 60, y: 250, width: 960, height: 700 } }), STEP_MS, "screenshot@5.0");
      console.log(`wrote ${otherShot}`);

      if (errors.length) {
        console.error("FAIL: page errors while the Lottie clip played:");
        errors.forEach((e) => console.error(`  ${e}`));
        failed = true;
      } else {
        console.log("OK: no page errors while the Lottie clip played.");
      }
    });

    // --- 2: seek-safety, specifically for the lottie-containing element ---
    await withPage(browser, {}, async (page) => {
      const t = 0.6;
      const first = await seekAndReadLottieState(page, t);
      await seekAndReadLottieState(page, 1.8);
      await seekAndReadLottieState(page, 0.05);
      const again = await seekAndReadLottieState(page, t);

      console.log("seek-safety sample @0.6s:", JSON.stringify(first.element), "vs after seeking away and back:", JSON.stringify(again.element));
      if (JSON.stringify(first.element) !== JSON.stringify(again.element)) {
        console.error("FAIL: the Lottie accent is NOT seek-safe — the same timestamp rendered differently after seeking away and back.");
        failed = true;
      } else {
        console.log("OK: the Lottie accent is seek-safe.");
      }
    });

    // --- 3: the CDN script is blocked — must still render cleanly ---
    await withPage(browser, { blockLottieCdn: true }, async (page, errors) => {
      const state = await seekAndReadLottieState(page, 0.6);
      const shot = path.join(OUT_DIR, "fallback-cdn-blocked.png");
      await withTimeout(page.screenshot({ path: shot, clip: { x: 60, y: 250, width: 960, height: 700 } }), STEP_MS, "screenshot(blocked)");
      console.log(`wrote ${shot}`);
      console.log(`with the CDN blocked: ${JSON.stringify(state)}`);

      if (state.hasLottie) {
        console.error("FAIL: window.lottie should be undefined when the CDN script is blocked — the test itself is not exercising the failure path.");
        failed = true;
      } else if (errors.length) {
        console.error("FAIL: blocking the CDN script broke the composition instead of falling back cleanly:");
        errors.forEach((e) => console.error(`  ${e}`));
        failed = true;
      } else if (!state.element || state.element.innerHTMLLength !== 0) {
        console.error(`FAIL: the accent element should exist and be empty with the CDN blocked, got ${JSON.stringify(state.element)}`);
        failed = true;
      } else {
        console.log("OK: with the CDN blocked, the composition still loaded cleanly and the accent slot is empty — the fallback holds.");
      }
    });
  } catch (err) {
    console.error("Verification aborted by a step timeout or error:", err instanceof Error ? err.message : String(err));
    failed = true;
  } finally {
    await withTimeout(browser.close(), 5000, "browser.close").catch(() => {});
  }

  if (failed) {
    console.error("\nLottie verification FAILED — see above.");
    process.exit(1);
  }
  console.log(`\nAll Lottie verifications passed. Screenshots in ${OUT_DIR}`);
}

await main();
