/**
 * Book text in, book PAGES out — images the rest of the pipeline cannot tell
 * apart from a photograph, except that they are better.
 *
 * A Gutenberg book has no photograph, so there is nothing to enhance and
 * nothing to OCR. The page is typeset here instead, and that is strictly
 * better: because this module lays the words out, it can ask the layout engine
 * where every one of them ended up. No vision model, no OCR, no LCS alignment,
 * no confidence floor, no degradation to block highlighting. The highlight is
 * correct by construction — the failure mode the whole `align.ts`/`lines.ts`
 * machinery exists to survive cannot occur on this path.
 *
 * The one thing that would throw that away is round-tripping the render back
 * through OCR to "check" it. That would reintroduce every source of error this
 * path removes, in order to verify something already known exactly.
 *
 * What comes out is the same shape a photographed page stores in
 * `page.alignment`: `AlignedWord[]`, in reading order, `visionIndex` counting
 * from 0 on every page, every word carrying a real box. `clusterLineRuns`,
 * `sweepForBeat` and `cameraTrack` consume it unchanged.
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright-core";
import { IngestFailed } from "../errors";
import type { AlignedWord } from "../ingest/align";
import type { Box } from "../ingest/ocr";
import { PAGE, pageShell, renderAndMeasure, type Measurement, type PageRequest } from "./layout";
import { wordsOfText, type TypesetWord } from "./text";

export { PAGE, TYPE } from "./layout";
export { toParagraphs, toSegments, toWords, wordsOfText, type TypesetWord } from "./text";

export interface TypesetPage {
  /** Page image, written to disk. */
  path: string;
  /** MUST match the photo derivative's geometry: 1600px long edge. */
  width: number;
  height: number;
  /** The words on this page, in reading order, every one carrying a real box.
   *  Same shape `page.alignment` stores for a photographed page, so
   *  `clusterLineRuns` consumes it with no change. `visionIndex` restarts at
   *  0 on every page, exactly as the photo path does. */
  words: AlignedWord[];
}

/** Matches `deriveForComposition`: the same encoder, the same quality. */
const JPEG_QUALITY = 92;

const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * How many words are laid out to find where a page ends. A page holds about
 * 270, so this overflows it three times over on the first try; when it does
 * not (a much smaller type block, or a caller who changed `TYPE`), the fill
 * loop doubles it rather than quietly emitting a half-empty page.
 */
const PROBE_WORDS = 900;

/**
 * A runaway bound, not a product rule. The operator's control offers 2..10
 * pages; this only stops a caller who asks for ten thousand from rendering
 * for an hour.
 */
const MAX_PAGES = 120;

/** Floating-point slack when asking whether a word fell below the type block. */
const EPSILON = 0.5;

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * The photographed path's boxes are whole pixels, so these are too — and they
 * round OUTWARD (floor the near edges, ceil the far ones) so a box is never
 * smaller than the glyphs it describes. A marker a fraction of a pixel wide of
 * a word is invisible; one a fraction short leaves a sliver of unhighlighted
 * letter at the end of every stroke.
 */
function toBox(rect: { x0: number; y0: number; x1: number; y1: number }): Box {
  return {
    x0: Math.max(0, Math.floor(rect.x0)),
    y0: Math.max(0, Math.floor(rect.y0)),
    x1: Math.min(PAGE.width, Math.ceil(rect.x1)),
    y1: Math.min(PAGE.height, Math.ceil(rect.y1)),
  };
}

/**
 * Lay out from `cursor` and report how many words fit on one page.
 *
 * Word rectangles come back in flow order, so their bottoms only ever
 * increase — the first word whose bottom falls past the type block is the
 * first word of the next page, and because every word on a line shares a
 * bottom, that cut always lands on a line boundary.
 */
async function fill(
  browserPage: Page,
  words: TypesetWord[],
  cursor: number,
  head: string,
  folio: string,
): Promise<{ count: number; measurement: Measurement; request: PageRequest }> {
  const continues = cursor > 0 && words[cursor - 1].paragraph === words[cursor].paragraph;

  let probe = PROBE_WORDS;
  for (;;) {
    const request: PageRequest = {
      words: words.slice(cursor, cursor + probe),
      head,
      folio,
      continues,
      // The probe deliberately overflows, so its last paragraph is nowhere
      // near the bottom of the type block and nothing needs justifying
      // specially. The final pass sets this for real.
      spills: false,
    };
    const measurement = await browserPage.evaluate(renderAndMeasure, request);

    let count = 0;
    while (
      count < measurement.rects.length &&
      measurement.rects[count].y1 <= measurement.bodyBottom + EPSILON
    ) {
      count++;
    }

    // Everything offered fit, and there was more text to offer: the probe was
    // too small to find the bottom of the page, not the page too small to
    // fill. Try again with more.
    if (count >= request.words.length && cursor + probe < words.length) {
      probe *= 2;
      continue;
    }

    // A type block too short for even one line would otherwise return 0 and
    // leave the caller looping forever on the same word. Always consume one.
    return { count: Math.max(1, count), measurement, request };
  }
}

/**
 * Typeset `pageCount` pages of `text`, starting `startWord` words in.
 *
 * Deterministic: no randomness, no clock, no network. The same text and the
 * same options produce the same images, byte for byte, and the same boxes.
 *
 * Nothing here throws on thin input. Text that is empty, whitespace-only or
 * entirely consumed before `startWord`, and a `pageCount` of zero or less,
 * all return an empty list; a `pageCount` larger than the text supports
 * returns the pages that exist. Only a browser that will not start — an
 * environment failure, not a data one — raises, because on this path there is
 * no page image without it and therefore no video.
 */
export async function typesetPages(opts: {
  text: string;
  /** Word offset into `text` to start from. */
  startWord?: number;
  /** How many pages to produce — the operator's 2..10 choice. */
  pageCount: number;
  outDir: string;
  title?: string;
}): Promise<TypesetPage[]> {
  const words = wordsOfText(opts.text);
  const start = Math.max(0, integer(opts.startWord, 0));
  const wanted = Math.min(MAX_PAGES, Math.max(0, integer(opts.pageCount, 0)));
  const head = typeof opts.title === "string" ? opts.title.replace(/\s+/g, " ").trim() : "";

  if (words.length === 0 || start >= words.length || wanted === 0) return [];

  await fs.mkdir(opts.outDir, { recursive: true });

  let browser: Browser;
  try {
    browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
  } catch (err) {
    throw new IngestFailed(
      `A free book is typeset in a headless browser, and Chromium would not start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const pad = String(wanted).length;
  const pages: TypesetPage[] = [];

  try {
    const browserPage = await browser.newPage({
      viewport: { width: PAGE.width, height: PAGE.height },
      deviceScaleFactor: 1,
    });
    browserPage.setDefaultTimeout(LAUNCH_TIMEOUT_MS);
    await browserPage.setContent(pageShell(), { waitUntil: "load" });
    await browserPage.evaluate(() => document.fonts.ready);

    let cursor = start;
    for (let index = 0; index < wanted && cursor < words.length; index++) {
      const folio = String(index + 1);
      const fitted = await fill(browserPage, words, cursor, head, folio);

      // Re-lay out with only the words that fit. This is the layout that gets
      // screenshotted, so it must also be the one that was measured: dropping
      // the overflow turns the page's last surviving line into a paragraph's
      // last line, which justification leaves ragged instead of flush, moving
      // every word on it. Skipped only when nothing was dropped, in which
      // case the DOM already holds exactly these words.
      const slice = fitted.request.words.slice(0, fitted.count);
      const next = cursor + fitted.count;
      const spills = next < words.length && words[next].paragraph === words[next - 1].paragraph;
      const measurement =
        fitted.count === fitted.request.words.length && !spills
          ? fitted.measurement
          : await browserPage.evaluate(renderAndMeasure, { ...fitted.request, words: slice, spills });

      const file = path.join(opts.outDir, `page-${String(index + 1).padStart(pad, "0")}.jpg`);
      const shot = await browserPage.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: PAGE.width, height: PAGE.height },
      });
      await sharp(shot).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toFile(file);

      pages.push({
        path: file,
        width: PAGE.width,
        height: PAGE.height,
        // `visionIndex` restarts at 0 here, deliberately: every downstream
        // word range (`sweepForBeat`, `runsForRange`) is scoped to one page,
        // and a counter that ran on across pages would mis-aim every
        // highlight after the first. `ocrIndex` is the same index rather
        // than null — a typeset word IS its own measurement, so the
        // "boxed implies measured" invariant the photo path happens to hold
        // holds here too.
        words: slice.map((w, i) => ({
          visionIndex: i,
          word: w.word,
          ocrIndex: i,
          box: toBox(measurement.rects[i]),
        })),
      });

      cursor = next;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return pages;
}
