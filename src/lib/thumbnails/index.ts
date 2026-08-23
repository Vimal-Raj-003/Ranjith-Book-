import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { ContentPackage } from "../content/schema";
import { ASPECTS, VARIANTS, type ThumbFocus, type ThumbPage, type ThumbSpec } from "./types";
import { clean } from "./text";
import { FIT_SCRIPT, buildThumbHtml, normaliseFocus, type Box, type Photo, type ThumbCopy } from "./render";

export type { ThumbSpec, ThumbFocus, ThumbPage } from "./types";
export { THUMB_KEYS, THUMBS_ROOT, thumbsDir, PALETTE } from "./types";
export { parseThumbnails, serializeThumbnails, selectThumb, isThumbKey } from "./store";
export { escapeHtml, paintKeywords, trimWords } from "./text";
export { normaliseFocus, computeCrop, buildThumbHtml } from "./render";

/** JPEG quality. 88 keeps a 1080x1920 poster comfortably inside 300KB. */
const QUALITY = 88;
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
  outDir: string;
}): Promise<ThumbSpec[]> {
  const pkg = (opts.pkg ?? {}) as Partial<ContentPackage>;
  const pages = Array.isArray(opts.pages) ? opts.pages : [];

  const copy: ThumbCopy = {
    title: clean(pkg.title),
    hook: clean(pkg.hook),
    keywords: Array.isArray(pkg.hookKeywords) ? pkg.hookKeywords : [],
    cta: clean(pkg.cta),
  };
  // Last resort for the words: a package with no hook and no title still has
  // beats, and a beat's on-screen line is already written to be short.
  if (!copy.hook && !copy.title) {
    copy.hook = clean(pkg.beats?.[0]?.onScreen);
  }

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
          const html = buildThumbHtml({ aspect, variant, copy, photo, focus });
          const page = await browser.newPage({
            viewport: { width: aspect.width, height: aspect.height },
            deviceScaleFactor: 1,
          });
          try {
            page.setDefaultTimeout(NAV_TIMEOUT_MS);
            await page.setContent(html, { waitUntil: "load" });
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(FIT_SCRIPT);
            const buf = await page.screenshot({ type: "jpeg", quality: QUALITY });
            if (buf.length === 0) throw new Error("empty screenshot");
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
