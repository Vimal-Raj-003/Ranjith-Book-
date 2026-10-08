// Environment harness: proves the background actually CHANGES, and by how much.
//
// Defect A was that forty finished episodes shared two backgrounds between them,
// because `theme.backdrop()` was emitted once per video from a global setting —
// there was no code path by which a sentence's meaning could reach the
// background at all. `scenes/environment.ts` is that path. This harness is the
// evidence that the path leads somewhere visible: a catalogue of seven worlds
// that a viewer cannot tell apart is the same defect with more code behind it.
//
// It captures each environment on its own and compares every pair. The numbers
// are mean absolute pixel difference (0-255) over the whole frame, computed
// from raw RGBA that Playwright hands back, so there is no codec, no PSNR curve
// and nothing to interpret: 0 means identical, and a pair that a person would
// call "the same background" sits near it.
//
// Run: npm run e2e:env [themeId]
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { ENVIRONMENTS } from "../src/lib/video/scenes/types.ts";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

// Below this, two worlds are close enough that a viewer scrolling a feed would
// read them as the same background — which is the defect, not a near miss.
const MIN_DIFF = 2.0;
// A small render, because this is about overall light and weight, not detail;
// it also keeps the pixel maths cheap enough to do in the page.
const W = 108;
const H = 192;

/** Paint one environment alone and read back its raw pixels. */
const CAPTURE = async ({ env, w, h }) => {
  // Everything except the worlds: the scene stack, the page card, the captions
  // and the chrome all sit ON the background and would swamp the comparison.
  let hide = document.getElementById("env-probe-hide");
  if (!hide) {
    hide = document.createElement("style");
    hide.id = "env-probe-hide";
    hide.textContent =
      "#column, .sc, #card, #card-zoom, #page-dim, .caption-line, #hook, #progress," +
      " #cta-card, #buy-card, .byline, [data-stroke] { display:none !important; }" +
      " .env { transition:none !important; }";
    document.head.appendChild(hide);
  }
  for (const el of document.querySelectorAll(".env")) {
    el.style.opacity = el.id === "env-" + env ? "1" : "0";
  }

  // html2canvas-free capture: the worlds are CSS gradients on plain divs, so the
  // only honest way to rasterise them here is to let the browser do it and read
  // the result back through the screenshot API. That happens outside this
  // function; this one just sets the state up.
  return true;
};

function meanAbsDiff(a, b) {
  let sum = 0;
  // RGB only — alpha is 255 everywhere and would just dilute the number.
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3);
}

/** Decode a PNG buffer to raw RGBA, in the page, where a decoder already exists. */
async function decode(page, buf, w, h) {
  return page.evaluate(
    async ({ b64, w, h }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return Array.from(ctx.getImageData(0, 0, w, h).data);
    },
    { b64: buf.toString("base64"), w, h },
  );
}

async function checkTheme(browser, id, theme) {
  const html = buildComposition(fixtureInput({ theme, withScenes: true, cinematic: true }));
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    await page.setContent(`<!doctype html><body>${html}</body>`, { waitUntil: "load" });
    try {
      await page.waitForFunction(() => Boolean(window.__tl), { timeout: 15_000 });
    } catch {
      console.error(
        "window.__tl never appeared. The composition loads GSAP from a CDN — if the " +
          "network is unavailable here, that is why, not an environment failure.",
      );
      process.exit(1);
    }

    const pixels = {};
    for (const env of ENVIRONMENTS) {
      await page.evaluate(CAPTURE, { env, w: W, h: H });
      const shot = await page.screenshot({ type: "png" });
      pixels[env] = await decode(page, shot, W, H);
    }

    let worst = { pair: null, diff: Infinity };
    const failures = [];
    for (let i = 0; i < ENVIRONMENTS.length; i++) {
      for (let j = i + 1; j < ENVIRONMENTS.length; j++) {
        const a = ENVIRONMENTS[i];
        const b = ENVIRONMENTS[j];
        const d = meanAbsDiff(pixels[a], pixels[b]);
        if (d < worst.diff) worst = { pair: `${a}/${b}`, diff: d };
        if (d < MIN_DIFF) failures.push({ pair: `${a}/${b}`, diff: d });
      }
    }

    for (const f of failures) {
      console.error(
        `[${id}] ${f.pair} differ by only ${f.diff.toFixed(2)}/255 — a viewer would read ` +
          `these as the same background, so the catalogue is not giving this theme ${ENVIRONMENTS.length} worlds.`,
      );
    }
    console.log(
      `${id}: ${ENVIRONMENTS.length} worlds, closest pair ${worst.pair} at ${worst.diff.toFixed(2)}/255` +
        (failures.length ? ` — ${failures.length} TOO CLOSE` : ""),
    );
    return failures.length;
  } finally {
    await page.close();
  }
}

async function main() {
  const only = process.argv[2];
  if (only && !(only in BOOK_THEMES)) {
    console.error(`Unknown theme "${only}". Known: ${Object.keys(BOOK_THEMES).join(", ")}`);
    process.exit(1);
  }
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
      if (only && id !== only) continue;
      failures += await checkTheme(browser, id, theme);
    }
    if (failures) {
      console.error(`\n${failures} environment pair(s) are too close to tell apart.`);
      process.exit(1);
    }
    console.log("\nEvery environment is visibly distinct in every theme.");
  } finally {
    await browser.close();
  }
}

await main();
