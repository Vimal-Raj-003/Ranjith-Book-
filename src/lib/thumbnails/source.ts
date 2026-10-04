import fs from "node:fs/promises";
import sharp from "sharp";
import type { Beat, ContentPackage } from "../content/schema";
import type { ThumbFocus, ThumbPage } from "./types";

/**
 * Everything a poster is made from, rebuilt from an episode ROW.
 *
 * The pipeline builds its posters from live objects (the content package it has
 * just written, the page images it has just prepared). A redo happens long
 * after, from the database, so those objects have to be reassembled -- and
 * where the row cannot supply them, the honest answer is "no source", not a
 * poster with no photograph on it.
 *
 * What the row does NOT keep: `hookKeywords` and the `takeaway` bullets are
 * never written to it. A redone poster therefore has no accent-coloured
 * keywords, and its supporting line falls back to the CTA. The headline is the
 * operator's own words, so this costs the redo nothing it was going to show.
 */

/** The columns of `Episode` this reads. Structural, so tests need no database. */
export interface PosterSourceRow {
  title: string | null;
  hook: string | null;
  cta: string | null;
  /** JSON Beat[]. */
  script: string | null;
  /** JSON {startPage, endPage, ..., sweeps}. */
  visualPlan: string | null;
  theme: string;
}

/** The columns of `Page` this reads. */
export interface PosterPageRow {
  pageIndex: number;
  filePath: string;
  derivedPath: string | null;
  width: number;
  height: number;
}

export interface PosterSource {
  pkg: Partial<ContentPackage>;
  /**
   * The pages the video covered, in reading order. Only the one the poster is
   * cut from is measured; the rest carry the row's own dimensions, which the
   * renderer never reads.
   */
  pages: ThumbPage[];
  focus: ThumbFocus | null;
  theme: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The strongest stroke's box, as the crop target for the poster.
 *
 * This mirrors the pipeline's own choice (the widest single stroke across the
 * whole episode, on a page that is actually in the list) so a redone poster
 * crops where the original did. `ThumbFocus.pageIndex` indexes `pages`, not the
 * book's own page numbering: an episode can cover a non-contiguous slice of an
 * upload, so the two are not interchangeable.
 *
 * `plan.sweeps[i]` is beat `i`'s strokes in page-local coordinates. Anything
 * malformed -- the plan is stored as JSON and may be missing, partial or from
 * an older shape -- costs the marker, never the poster.
 */
export function focusFromPlan(plan: unknown, beats: unknown, pages: { pageIndex: number }[]): ThumbFocus | null {
  const sweeps = isRecord(plan) && Array.isArray(plan.sweeps) ? plan.sweeps : [];
  const list = Array.isArray(beats) ? beats : [];

  let focus: ThumbFocus | null = null;
  let widest = 0;
  for (let i = 0; i < sweeps.length; i++) {
    const steps = sweeps[i];
    if (!Array.isArray(steps)) continue;
    const beat = list[i];
    const sourcePage = isRecord(beat) ? beat.sourcePage : undefined;
    const arrayIndex = pages.findIndex((p) => p.pageIndex === sourcePage);
    if (arrayIndex < 0) continue;
    for (const step of steps) {
      const box = isRecord(step) ? step.box : null;
      if (!isRecord(box)) continue;
      const { x0, y0, x1, y1 } = box;
      if (![x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      const area = Math.max(0, (x1 as number) - (x0 as number)) * Math.max(0, (y1 as number) - (y0 as number));
      if (area <= widest) continue;
      widest = area;
      focus = { pageIndex: arrayIndex, x0: x0 as number, y0: y0 as number, x1: x1 as number, y1: y1 as number };
    }
  }
  return focus;
}

/**
 * Reassemble what `generateThumbnails` needs, or null when the episode can no
 * longer be redone.
 *
 * `pageRows` is every page of the episode's upload (the caller selects only the
 * cheap columns); the episode's own pages are the ones inside the plan's page
 * range, which is what the pipeline filtered by. No range, or an unreadable
 * one, means every page -- the same fallback the pipeline uses.
 *
 * Null means: no usable script, no pages, or the photograph the poster would be
 * cut from is no longer on disk (an old episode whose work dir was cleaned).
 * Rendering anyway would put a book's name on a poster with no book on it.
 */
export async function loadPosterSource(row: PosterSourceRow, pageRows: PosterPageRow[]): Promise<PosterSource | null> {
  const beats = parseJson(row.script);
  if (!Array.isArray(beats) || beats.length === 0) return null;

  const plan = parseJson(row.visualPlan);
  const start = isRecord(plan) ? plan.startPage : undefined;
  const end = isRecord(plan) ? plan.endPage : undefined;
  const ranged = typeof start === "number" && typeof end === "number";

  const covered = pageRows
    .filter((p) => !ranged || (p.pageIndex >= start && p.pageIndex <= end))
    .sort((a, b) => a.pageIndex - b.pageIndex);
  if (covered.length === 0) return null;

  const focus = focusFromPlan(plan, beats, covered);

  // The page the renderer will read: the focus page, else the first. Measured
  // from the image itself, as the pipeline does -- a focus box is in the
  // derived image's pixels, which are not the row's. Read into memory rather
  // than opened by path: on Windows libvips keeps a path-opened file mapped,
  // and a mapped poster source cannot be overwritten or deleted afterwards.
  const at = focus?.pageIndex ?? 0;
  const photo = covered[at];
  const photoSrc = photo.derivedPath ?? photo.filePath;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(await fs.readFile(photoSrc)).metadata();
    width = meta.width;
    height = meta.height;
  } catch {
    return null;
  }
  if (!width || !height) return null;

  const pages: ThumbPage[] = covered.map((p) => ({ src: p.derivedPath ?? p.filePath, width: p.width, height: p.height }));
  pages[at] = { src: photoSrc, width, height };

  return {
    pkg: {
      title: row.title ?? "",
      hook: row.hook ?? "",
      cta: row.cta ?? "",
      beats: beats as Beat[],
    },
    pages,
    focus,
    theme: row.theme,
  };
}
