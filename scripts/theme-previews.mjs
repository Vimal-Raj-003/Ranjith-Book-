// Render one still per theme, from the real compositor.
//
//   node --import tsx scripts/theme-previews.mjs
//
// Why a rendered still and not a hand-drawn swatch. Eleven themes is past the
// point where a row of named chips tells an operator anything — "Atelier" and
// "Dossier" are words, not looks — and the cost of guessing wrong is a full
// render: OCR, a model call, text-to-speech and ffmpeg. A swatch would be a
// drawing of a promise; this is the promise itself, because every pixel below
// comes out of `buildComposition` and the theme's own `css()`, seeked and
// screenshotted exactly the way `renderProject` seeks and screenshots a frame.
//
// Deterministic, and it has to be: same themes in, same bytes out. One fixture,
// one timestamp, a seeded bokeh field (`bokehField` is a counter-based PRNG,
// not Math.random), and no network. Re-running this on an unchanged tree
// rewrites eleven identical files.
//
// The page in the frame is `tests/fixtures/page-fixture.png`, this repo's own
// photographed-page stand-in. It is a sample, and the cards say so; no preview
// claims to be a frame of the operator's actual book.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { buildComposition, AUDIO_OFFSET } from "../src/lib/video/composition/build.ts";
import { BOOK_THEMES } from "../src/lib/video/composition/themes/index.ts";
import { themeFingerprint } from "../src/lib/video/composition/themes/fingerprint.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "public", "theme-previews");
const PAGE_SRC = path.join(ROOT, "tests", "fixtures", "page-fixture.png");

/** The card's own aspect, at a size a 2x inspector column can show crisply. */
const PREVIEW_W = 270;
const PREVIEW_H = 480;

/**
 * The instant every preview is taken at, chosen against the fixture below for
 * three things at once:
 *
 *  - Past the hook. It holds the frame for `HOOK_MAX_VISIBLE` from t=0, so
 *    anything under ~4.2s is a picture of the hook scrim and says nothing about
 *    the theme.
 *  - Past beat 1's light sweep. `sweepPasses` fires one pass at each beat start
 *    for up to `SWEEP_MAX_DUR` (2.6s), so beat 1's runs 5.4–8.0 — and a
 *    screen-blended band crossing the card makes every theme look like the same
 *    washed-out gradient. Beat 1's narration is deliberately long enough that
 *    the pass finishes well before the caption does.
 *  - Inside beat 1's caption and marker, which are up until 10.6.
 *
 * 9.5 satisfies all three with room on either side.
 */
const AT = AUDIO_OFFSET + 8.8;

function fixture(theme, pageSrc) {
  const pkgBeats = [
    { id: "hook", voiceover: "One page can change how you work.", onScreen: "Hook", sourcePage: 0, startWord: 0, endWord: 3 },
    { id: "idea", voiceover: "The quick brown fox jumps over lazy dogs.", onScreen: "Idea", sourcePage: 0, startWord: 4, endWord: 8 },
    { id: "turn", voiceover: "Reading every page is the whole of it.", onScreen: "Turn", sourcePage: 0, startWord: 9, endWord: 12 },
    { id: "cta", voiceover: "Follow for more.", onScreen: "Follow", sourcePage: 0, startWord: 13, endWord: 15 },
  ];
  const beats = [
    { index: 0, text: pkgBeats[0].voiceover, file: "b0.wav", start: 0, end: 4.4, speechStart: 0.1, speechEnd: 4.3 },
    { index: 1, text: pkgBeats[1].voiceover, file: "b1.wav", start: 4.7, end: 10.0, speechStart: 4.8, speechEnd: 9.9 },
    { index: 2, text: pkgBeats[2].voiceover, file: "b2.wav", start: 10.3, end: 15.6, speechStart: 10.4, speechEnd: 15.5 },
    { index: 3, text: pkgBeats[3].voiceover, file: "b3.wav", start: 15.9, end: 18.0, speechStart: 16.0, speechEnd: 17.9 },
  ];
  const captions = beats.map((b) => ({
    text: b.text,
    start: b.speechStart,
    end: b.speechEnd,
    beatIndex: b.index,
    words: [],
  }));
  // Boxes measured against the fixture page's own 1600x2000 coordinate space:
  // its word rows sit at roughly y=270, 640, 980 and 1340.
  const sweeps = [
    [{ box: { x0: 100, y0: 230, x1: 1290, y1: 320 }, start: 0.1, end: 4.3 }],
    [{ box: { x0: 100, y0: 600, x1: 1230, y1: 690 }, start: 4.8, end: 9.9 }],
    [{ box: { x0: 100, y0: 940, x1: 1250, y1: 1030 }, start: 10.4, end: 15.5 }],
    [{ box: { x0: 100, y0: 1300, x1: 1240, y1: 1390 }, start: 16.0, end: 17.9 }],
  ];
  return {
    pkg: {
      title: "A sample page",
      hook: "One page can change how you work.",
      hookKeywords: ["change"],
      ideaKey: "preview",
      cta: "Follow for more.",
      description: "",
      hashtags: [],
      takeaway: [],
      beats: pkgBeats,
    },
    beats,
    captions,
    pages: [{ src: pageSrc, width: 1600, height: 2000 }],
    sweeps,
    camera: [{ t: 0, y: 0 }, { t: 18.0, y: 420 }],
    theme,
    totalDuration: 18.0,
    bookTitle: "Sample Book",
    author: "A. Writer",
    bookLink: null,
  };
}

// The page travels as a data URI rather than as a file beside the document.
// `setContent` is the call every other harness in this repo uses, and it leaves
// the document on `about:blank`, where the CDN <script> tags the composition
// carries resolve exactly as they do in `tests/themes.test.mts`. Served from a
// `file://` document instead, the same page never finishes loading.
const pageSrc = `data:image/png;base64,${(await fs.readFile(PAGE_SRC)).toString("base64")}`;
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
let written = 0;
/**
 * What each still is a picture OF, by theme fingerprint.
 *
 * Without this a preview can go stale in silence: edit a spec's palette or its
 * grain and the card keeps showing the theme as it used to be — a wrong
 * picture, which is worse than a missing one, and every test stays green
 * because the file still exists and is still a 270x480 PNG.
 * `tests/theme-picker.test.mts` compares each entry against the live theme, so
 * a spec change fails until this script is re-run.
 */
const manifest = {};
try {
  for (const [id, theme] of Object.entries(BOOK_THEMES)) {
    const html = buildComposition(fixture(theme, pageSrc));

    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    try {
      await page.setContent(`<!doctype html><html><body>${html}</body></html>`, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(window.__tl), { timeout: 20_000 });
      // Fonts first: a screenshot taken before `document.fonts.ready` resolves
      // catches the fallback face, which on a theme whose whole identity is a
      // didone or an old-style serif is a picture of the wrong theme.
      await page.evaluate(() => document.fonts.ready);
      // `pause(t)`, the same call the renderer makes per frame — never `play()`.
      //
      // The braces are load-bearing. `pause()` returns the GSAP timeline, and an
      // arrow with an expression body hands that back to Playwright, which then
      // tries to serialise a deeply self-referential object across CDP and never
      // returns — the call does not throw, it hangs forever. Return nothing.
      await page.evaluate((t) => {
        window.__tl.pause(t);
      }, AT);
      const full = await page.screenshot({ type: "png" });
      await sharp(full)
        .resize(PREVIEW_W, PREVIEW_H, { fit: "fill", kernel: "lanczos3" })
        .png({ compressionLevel: 9, palette: true })
        .toFile(path.join(OUT, `${id}.png`));
      manifest[id] = themeFingerprint(theme);
      written++;
      console.log(`  ${id} -> public/theme-previews/${id}.png`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

// Sorted keys and a trailing newline: the manifest is re-written on every run,
// and a file whose key order wandered would show as a diff after a no-op
// regenerate.
const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
await fs.writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");

console.log(`${written} theme preview${written === 1 ? "" : "s"} written to public/theme-previews/`);
