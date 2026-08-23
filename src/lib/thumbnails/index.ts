import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { ContentPackage } from "../content/schema";
import { ASPECTS, VARIANTS, type ThumbFocus, type ThumbPage, type ThumbSpec } from "./types";
import { clean } from "./text";
import { thumbPalette } from "./palette";
import { FIT_SCRIPT, buildThumbHtml, normaliseFocus, type Box, type Photo, type ThumbCopy } from "./render";

export type { ThumbSpec, ThumbFocus, ThumbPage } from "./types";
export { THUMB_KEYS, THUMBS_ROOT, thumbsDir } from "./types";
export { parseThumbnails, serializeThumbnails, selectThumb, isThumbKey } from "./store";
export { escapeHtml, headlineText, paintKeywords, trimWords } from "./text";
export { thumbPalette, contrast, type ThumbPalette } from "./palette";
export { normaliseFocus, computeCrop, buildThumbHtml } from "./render";

/**
 * JPEG quality, tried in order until a poster fits `MAX_BYTES`.
 *
 * 88 alone was fine while every thumbnail was Marginalia's: a dark ground
 * costs almost nothing to encode. A LIGHT theme is a different picture —
 * Editorial is an ecru sheet with a woven texture and a brightly-lit page
 * photograph across half the frame, which is high-frequency detail in every
 * block, and its 1080x1920 posters came out over half a megabyte. The delivery
 * route serves these to a browser one after another, so a poster nobody can
 * tell apart at 88 and at 74 should not cost twice the bytes.
 *
 * Deterministic: a fixed ladder walked in a fixed order against a fixed
 * threshold, so the same package always lands on the same rung and the same
 * bytes. The last rung is used whether or not it fits — a slightly heavy
 * poster beats no poster.
 */
const QUALITY_LADDER = [88, 74, 60] as const;
const MAX_BYTES = 340 * 1024;
const NAV_TIMEOUT_MS = 20_000;

function warn(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  console.warn(`[thumbnails] ${message}${detail ? `: ${detail}` : ""}`);
}

/** Read one page image as a data URI. A missing or unreadable file is not an
 *  error — the variants that wanted a photograph render without one. */
async function loadPhoto(page: ThumbPage | undefined): Promise<Photo | null> {
  if (!page || typeof page.src !== "string" || !page.src) return null;
  if (!(page.width > 0) || !(page.height > 0)) return null;
  try {
    const buf = await fs.readFile(page.src);
    if (buf.length === 0) return null;
    const ext = path.extname(page.src).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return {
      dataUri: `data:${mime};base64,${buf.toString("base64")}`,
      width: page.width,
      height: page.height,
    };
  } catch (err) {
    warn(`could not read page image ${page.src}`, err);
    return null;
  }
}

/**
 * Render the six posters for an episode: three variants x two aspect ratios.
 *
 * Contract with the pipeline: this NEVER sinks a render. Every foreseeable
 * failure — no page image on disk, a hook with no keywords, a focus box that is
 * inverted or off the page, a single screenshot that fails — costs at most the
 * thumbnails it affects, and the function returns whatever subset succeeded
 * (possibly none). Only a genuinely unexpected error propagates.
 *
 * Deterministic by construction: no randomness, no clock, no network. The one
 * measured quantity is the type size, which is a binary search over integers
 * against a fixed layout, so the same package renders the same bytes.
 */
export async function generateThumbnails(opts: {
  episodeId: string;
  pkg: ContentPackage;
  /** The DERIVED page images (1600px long edge), same ones the video uses. */
  pages: ThumbPage[];
  /** Optional: the highlight box of the strongest beat, in page-image pixels,
   *  so a crop can centre on the words that matter. */
  focus?: ThumbFocus | null;
  /**
   * The episode's stored theme id — the same `Episode.theme` string the video
   * renderer is handed. A poster must be painted in the palette of the theme
   * the video is actually rendered in, or it advertises a different channel.
   *
   * Optional, and resolved through `bookThemeById`, which never throws and
   * never returns undefined: an absent id (a caller not yet wired up, or a row
   * written before the picker existed) and an id that has since been renamed
   * both render the DEFAULT theme's poster rather than failing.
   */
  theme?: string | null;
  outDir: string;
}): Promise<ThumbSpec[]> {
  const pkg = (opts.pkg ?? {}) as Partial<ContentPackage>;
  const pages = Array.isArray(opts.pages) ? opts.pages : [];

  // The beats' on-screen labels, hook beat first. These are headline material,
  // not a fallback: the writer is asked for at most six words per label, which
  // is a poster headline in everything but name, and a hook written to be
  // *heard* is routinely three words too long to be read at 200px. See
  // `headlineText`.
  const beats = Array.isArray(pkg.beats) ? pkg.beats : [];
  const onScreen = [
    ...beats.filter((b) => b?.id === "hook"),
    ...beats.filter((b) => b?.id !== "hook"),
  ]
    .map((b) => clean(b?.onScreen))
    .filter(Boolean);

  const copy: ThumbCopy = {
    title: clean(pkg.title),
    hook: clean(pkg.hook),
    keywords: Array.isArray(pkg.hookKeywords) ? pkg.hookKeywords : [],
    cta: clean(pkg.cta),
    onScreen,
    takeaway: (Array.isArray(pkg.takeaway) ? pkg.takeaway : []).map(clean).filter(Boolean),
  };

  // Which photograph, and does the focus box belong to it? A `pageIndex` that
  // is out of range keeps the crop (page 0) and loses only the marker.
  const focusIndex = opts.focus?.pageIndex;
  const focusPage =
    typeof focusIndex === "number" && Number.isInteger(focusIndex) && focusIndex >= 0 && focusIndex < pages.length
      ? pages[focusIndex]
      : undefined;
  const chosen = focusPage ?? pages[0];
  const photo = await loadPhoto(chosen);

  let focus: Box | null = null;
  if (photo && focusPage) focus = normaliseFocus(opts.focus, focusPage);

  // Resolved once, not per poster: six screenshots of the same episode must be
  // six views of one design, and it is also the only place a bad theme id can
  // be turned into a good theme.
  const palette = thumbPalette(opts.theme);

  try {
    await fs.mkdir(opts.outDir, { recursive: true });
  } catch (err) {
    warn(`could not create ${opts.outDir}`, err);
    return [];
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({ timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    // A missing or broken Chromium is an environment problem, and an
    // environment problem must not cost the operator their video.
    warn("could not launch Chromium; skipping thumbnails", err);
    return [];
  }

  const specs: ThumbSpec[] = [];
  try {
    for (const aspect of ASPECTS) {
      for (const variant of VARIANTS) {
        const key = `${aspect.tag}-${variant}`;
        const file = path.join(opts.outDir, `${key}.jpg`);
        try {
          const html = buildThumbHtml({ aspect, variant, copy, photo, focus, palette });
          const page = await browser.newPage({
            viewport: { width: aspect.width, height: aspect.height },
            deviceScaleFactor: 1,
          });
          try {
            page.setDefaultTimeout(NAV_TIMEOUT_MS);
            await page.setContent(html, { waitUntil: "load" });
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(FIT_SCRIPT);
            let buf: Buffer | null = null;
            for (const quality of QUALITY_LADDER) {
              buf = await page.screenshot({ type: "jpeg", quality });
              if (buf.length === 0) throw new Error("empty screenshot");
              if (buf.length <= MAX_BYTES) break;
            }
            if (!buf || buf.length === 0) throw new Error("empty screenshot");
            await fs.writeFile(file, buf);
          } finally {
            await page.close().catch(() => {});
          }
          specs.push({
            key,
            aspect: aspect.aspect,
            variant,
            path: file,
            width: aspect.width,
            height: aspect.height,
          });
        } catch (err) {
          warn(`thumbnail ${key} failed`, err);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return specs;
}
