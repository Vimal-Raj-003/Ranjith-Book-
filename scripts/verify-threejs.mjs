// Phase 4 / Three.js — real-browser verification (not a unit test).
//
// Four things a unit test cannot prove, because they need an actual browser
// actually fetching an actual CDN script and actually creating a WebGL
// context (or, deliberately, failing to):
//   1. The composition loads three@0.160.0 from the CDN, WebGL initialises,
//      and the icon-concept canvas ends up with real, non-blank pixel
//      content — not just present in the DOM (see verify-lottie.mjs's own
//      header for why "present" and "actually painted" are different
//      claims, and why only a real browser distinguishes them).
//   2. Seeking away from a timestamp and back renders IDENTICAL canvas
//      pixels both times — the same seek-safety property scripts/e2e-seek.mjs
//      already proves for every CSS-driven primitive, checked here for
//      actual WebGL pixel output, which that harness does not inspect.
//   3. If the CDN script is blocked (a real network failure), the flat
//      Tabler icon underneath is what renders — cleanly, no page error.
//   4. If WebGL itself is unavailable — the exact "no hardware GPU in a
//      cloud renderer" case the spec calls out by name — the SAME flat icon
//      renders, even with the CDN script loading successfully. This is a
//      DIFFERENT failure mode from #3 (the library loads; the platform
//      can't use it) and needs its own check: getContext("webgl"/"webgl2")
//      is monkey-patched to return null via page.addInitScript(), which
//      simulates the platform limitation precisely, rather than hoping a
//      real headless browser happens to lack GPU access in this environment.
//
// Every sample does exactly ONE page.evaluate (seek + read state together) —
// see verify-lottie.mjs's own header for why a bare evaluate() touching
// window.lottie/window.THREE right after one that already did hangs
// Playwright's next round-trip; the same discipline is kept here even though
// this script has not (yet) reproduced that specific hang, since the
// combined-evaluate shape costs nothing and sidesteps it either way.
//
// Screenshots are written to .three-verify/ for visual inspection.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { bookThemeById } from "../src/lib/video/composition/themes/index.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

const OUT_DIR = path.join(process.cwd(), ".three-verify");
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

// Fixture scene 2 is icon-concept with icons "clock" and "bulb" (see
// scripts/fixtures/composition-fixture.mjs) — torus and octahedron under
// three-shapes.ts's classifier. Its own window (per the fixture's own beat
// timing) is used below to pick sample timestamps.
function html(extraHead) {
  const theme = bookThemeById("marginalia");
  const doc = buildComposition({
    ...fixtureInput({ theme, withScenes: true }),
    bookTitle: "The Fixture Book of Very Long Titles Indeed",
    author: "A Verified Author",
    bookLink: null,
  });
  if (!extraHead) return doc;
  // page.addInitScript() does NOT run before page.setContent() — confirmed
  // directly (a bare `window.__flag = true` init script never fires before
  // a setContent-loaded page reads it back). Injected into the document
  // itself instead, ahead of every other <head> script, which is a
  // mechanism already proven to run in order: it is exactly the guarantee
  // build.ts's own TIMELINE_JS relies on to find window.THREE already
  // loaded by the time it runs.
  return doc.replace("<head>", `<head>\n<script>${extraHead}</script>`);
}

/** Force every getContext("webgl"/"webgl2") call on this page to return null,
 *  simulating a platform with no usable WebGL — software or hardware — at
 *  all, precisely and reliably rather than hoping this machine happens to
 *  lack one. Installed BEFORE any page script runs, so detectThreeSupport()
 *  itself sees the same failure a real GPU-less cloud renderer would. */
const DISABLE_WEBGL_SCRIPT = `
(function () {
  var real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
    return real.apply(this, arguments);
  };
})();
`;

async function withPage(browser, opts, fn) {
  const page = await withTimeout(browser.newPage({ viewport: { width: 1080, height: 1920 } }), STEP_MS, "newPage");
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  if (opts?.blockThreeCdn) {
    await withTimeout(page.route("**/three@*/**", (route) => route.abort("failed")), STEP_MS, "route");
  }
  try {
    const doc = html(opts?.disableWebgl ? DISABLE_WEBGL_SCRIPT : null);
    await withTimeout(page.setContent(`<!doctype html><body>${doc}</body>`, { waitUntil: "load" }), STEP_MS, "setContent");
    await withTimeout(page.waitForFunction(() => Boolean(window.__tl), { timeout: STEP_MS }), STEP_MS + 1000, "waitForFunction(__tl)");
    return await fn(page, errors);
  } finally {
    await withTimeout(page.close(), 5000, "page.close").catch(() => {});
  }
}

/** Seek and read the first icon-concept canvas's state in ONE evaluate. */
async function seekAndReadThreeState(page, t) {
  return withTimeout(
    page.evaluate((t) => {
      window.__tl.pause(t);
      var el = document.querySelector('[data-scene="2"] .sc-three');
      var svgEl = document.querySelector('[data-scene="2"] .sc-icon');
      if (!el) return { hasThree: typeof window.THREE !== "undefined", element: null, svgVisible: null };
      var cs = getComputedStyle(el);
      var ctx = el.getContext("2d");
      var pixels = null;
      var nonTransparentPixels = 0;
      if (ctx) {
        var data = ctx.getImageData(0, 0, el.width, el.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonTransparentPixels++;
        pixels = el.toDataURL();
      }
      var svgCs = svgEl ? getComputedStyle(svgEl) : null;
      return {
        hasThree: typeof window.THREE !== "undefined",
        element: {
          opacity: cs.getPropertyValue("opacity"),
          visibility: cs.getPropertyValue("visibility"),
          nonTransparentPixels: nonTransparentPixels,
          pixels: pixels,
        },
        svgVisible: svgCs ? svgCs.getPropertyValue("opacity") !== "0" : null,
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
    // --- 1: the CDN script loads, WebGL initialises, real pixels appear ---
    await withPage(browser, {}, async (page, errors) => {
      // Scene 2 (icon-concept, clock + bulb) is 4.3-6.6s in the fixture's
      // OWN clock, but the composition shifts every scene by AUDIO_OFFSET
      // (0.7s) at render time — its real on-screen window is 5.0-7.3s.
      // Three points across it: just after the first icon's own arrival
      // (the "three" tween's own start, t=5.0), once both icons are
      // active, and late.
      const samples = [5.2, 6.0, 7.0];
      let sawPixels = false;
      for (const t of samples) {
        const state = await seekAndReadThreeState(page, t);
        if (!state.hasThree) {
          console.error("FAIL: three.js did not load from the CDN — check network connectivity and re-run.");
          failed = true;
          return;
        }
        if (state.element && state.element.nonTransparentPixels > 0) sawPixels = true;
        console.log(`t=${t}: opacity=${state.element?.opacity} visibility=${state.element?.visibility} nonTransparentPixels=${state.element?.nonTransparentPixels}`);
        const shot = path.join(OUT_DIR, `three-t${t.toFixed(2)}.png`);
        await withTimeout(page.screenshot({ path: shot, clip: { x: 60, y: 250, width: 960, height: 700 } }), STEP_MS, `screenshot@${t}`);
        console.log(`wrote ${shot}`);
      }
      if (!sawPixels) {
        console.error("FAIL: window.THREE loaded and the canvas is visible, but no non-transparent pixels were ever drawn.");
        failed = true;
      }

      if (errors.length) {
        console.error("FAIL: page errors while the Three.js accent rendered:");
        errors.forEach((e) => console.error(`  ${e}`));
        failed = true;
      } else {
        console.log("OK: no page errors while the Three.js accent rendered.");
      }
    });

    // --- 2: seek-safety, for the canvas's actual pixel output -------------
    await withPage(browser, {}, async (page) => {
      const t = 6.0;
      const first = await seekAndReadThreeState(page, t);
      await seekAndReadThreeState(page, 7.2);
      await seekAndReadThreeState(page, 2.0);
      const again = await seekAndReadThreeState(page, t);

      const same = first.element?.pixels === again.element?.pixels;
      console.log(`seek-safety sample @${t}s: ${first.element?.nonTransparentPixels} vs ${again.element?.nonTransparentPixels} non-transparent pixels after seeking away and back; pixel-identical=${same}`);
      if (!same) {
        console.error("FAIL: the Three.js accent is NOT seek-safe — the same timestamp rendered different pixels after seeking away and back.");
        failed = true;
      } else {
        console.log("OK: the Three.js accent is seek-safe.");
      }
    });

    // --- 3: the CDN script is blocked — must fall back to the flat icon ---
    await withPage(browser, { blockThreeCdn: true }, async (page, errors) => {
      const state = await seekAndReadThreeState(page, 6.0);
      const shot = path.join(OUT_DIR, "fallback-cdn-blocked.png");
      await withTimeout(page.screenshot({ path: shot, clip: { x: 60, y: 250, width: 960, height: 700 } }), STEP_MS, "screenshot(cdn-blocked)");
      console.log(`wrote ${shot}`);
      console.log(`with the CDN blocked: hasThree=${state.hasThree} nonTransparentPixels=${state.element?.nonTransparentPixels} svgVisible=${state.svgVisible}`);

      if (state.hasThree) {
        console.error("FAIL: window.THREE should be undefined when the CDN script is blocked — the test itself is not exercising the failure path.");
        failed = true;
      } else if (errors.length) {
        console.error("FAIL: blocking the CDN script broke the composition instead of falling back cleanly:");
        errors.forEach((e) => console.error(`  ${e}`));
        failed = true;
      } else if (state.element && state.element.nonTransparentPixels !== 0) {
        console.error(`FAIL: the canvas should be blank with the CDN blocked, got ${state.element.nonTransparentPixels} non-transparent pixels`);
        failed = true;
      } else if (!state.svgVisible) {
        console.error("FAIL: the flat Tabler icon should still be visible with the CDN blocked — it is the required fallback.");
        failed = true;
      } else {
        console.log("OK: with the CDN blocked, the flat icon fallback holds and nothing broke.");
      }
    });

    // --- 4: WebGL itself is unavailable — must ALSO fall back cleanly -----
    // Distinct from #3: window.THREE loads fine here (the CDN is not
    // blocked in this run), but getContext("webgl"/"webgl2") is
    // monkey-patched to return null, simulating a platform with no usable
    // WebGL at all — the spec's own "do not assume cloud rendering has
    // hardware WebGL" case, exercised precisely rather than hoped for.
    await withPage(browser, { disableWebgl: true }, async (page, errors) => {
      const state = await seekAndReadThreeState(page, 6.0);
      const shot = path.join(OUT_DIR, "fallback-webgl-disabled.png");
      await withTimeout(page.screenshot({ path: shot, clip: { x: 60, y: 250, width: 960, height: 700 } }), STEP_MS, "screenshot(webgl-disabled)");
      console.log(`wrote ${shot}`);
      console.log(`with WebGL disabled: hasThree=${state.hasThree} nonTransparentPixels=${state.element?.nonTransparentPixels} svgVisible=${state.svgVisible}`);

      if (!state.hasThree) {
        console.error("FAIL: window.THREE should still be defined with WebGL disabled — the CDN script itself was not blocked in this run, so this would mean the test is not isolating the failure it claims to.");
        failed = true;
      } else if (errors.length) {
        console.error("FAIL: a missing WebGL context broke the composition instead of falling back cleanly:");
        errors.forEach((e) => console.error(`  ${e}`));
        failed = true;
      } else if (state.element && state.element.nonTransparentPixels !== 0) {
        console.error(`FAIL: the canvas should be blank with WebGL unavailable, got ${state.element.nonTransparentPixels} non-transparent pixels`);
        failed = true;
      } else if (!state.svgVisible) {
        console.error("FAIL: the flat Tabler icon should still be visible with WebGL unavailable — it is the required fallback.");
        failed = true;
      } else {
        console.log("OK: with WebGL unavailable, the flat icon fallback holds and nothing broke.");
      }
    });
  } catch (err) {
    console.error("Verification aborted by a step timeout or error:", err instanceof Error ? err.message : String(err));
    failed = true;
  } finally {
    await withTimeout(browser.close(), 5000, "browser.close").catch(() => {});
  }

  if (failed) {
    console.error("\nThree.js verification FAILED — see above.");
    process.exit(1);
  }
  console.log(`\nAll Three.js verifications passed. Screenshots in ${OUT_DIR}`);
}

await main();
