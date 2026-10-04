import fs from "node:fs/promises";
import sharp from "sharp";
import type { Beat, ContentPackage } from "../content/schema";
import type { ThumbFocus, ThumbPage } from "./types";
import { clean } from "./text";

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
 * keywords -- the headline is the operator's own words, so that costs nothing
 * it was going to show. The supporting line is rebuilt from the script instead
 * (`takeawayFromBeats`), because its fallback, the CTA, is the same sentence on
 * every episode and would make every retitled poster read alike.
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

/** A beat label that is a call to action, whatever its id says. */
const CTA_LABEL = /^(follow|save|share|comment|subscribe|like|bookmark|tag|send)\b/i;

/** Lowercase letters and digits only, for comparing a label against the CTA. */
const squash = (s: string) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The poster's supporting line, rebuilt from the script, or null for none.
 *
 * `takeaway[0]` is what the pipeline used and it is not stored. Without
 * something in its place the line falls back to the CTA, which is the same
 * sentence on every episode.
 *
 * The convention is a beat whose id is "takeaway", and it is used when present
 * -- but it is a convention, not a constraint, and the stored scripts mostly
 * ignore it: measured on 2026-10-04 across the 111 scripts in the library, 4
 * have such a beat. The rest use positional ids ("b1".."b7") or the writer's own
 * ("payoff", "rollback"), and in those the final beat is the call to action
 * whatever it is called ("Follow for more" ends 25 of them). So the fallback is
 * the last beat that is NOT a call to action, and a beat is one when its id is
 * "cta", or its label is a stem of the episode's own CTA sentence ("Follow for
 * more" against "Follow for more book ideas..."), or it opens with a CTA verb.
 * Taking merely the last beat would reproduce the boilerplate this exists to
 * avoid.
 */
export function takeawayFromBeats(beats: unknown, cta: string | null): string | null {
  const labelled = (Array.isArray(beats) ? beats : [])
    .filter(isRecord)
    .map((b) => ({ id: b.id, label: typeof b.onScreen === "string" ? clean(b.onScreen) : "" }))
    .filter((b) => b.label !== "");

  const named = labelled.find((b) => b.id === "takeaway");
  if (named) return named.label;

  const ctaText = squash(cta ?? "");
  const isCta = (b: { id: unknown; label: string }) => {
    if (b.id === "cta" || CTA_LABEL.test(b.label)) return true;
    const stem = squash(b.label);
    return stem !== "" && ctaText.includes(stem);
  };
  return labelled.filter((b) => !isCta(b)).at(-1)?.label ?? null;
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

  const takeaway = takeawayFromBeats(beats, row.cta);

  return {
    pkg: {
      title: row.title ?? "",
      hook: row.hook ?? "",
      cta: row.cta ?? "",
      beats: beats as Beat[],
      ...(takeaway ? { takeaway: [takeaway] } : {}),
    },
    pages,
    focus,
    theme: row.theme,
  };
}
