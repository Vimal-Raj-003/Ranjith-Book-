import path from "node:path";
import { WORK_ROOT } from "../paths";

/**
 * One rendered thumbnail. Serialised as a JSON array into `Episode.thumbnails`,
 * which is the only thing the delivery route trusts: a request names a `key`,
 * and unless that exact key is in this list nothing on disk is touched.
 */
export interface ThumbSpec {
  /** filename-safe, unique within an episode, e.g. "9x16-quote". */
  key: string;
  aspect: "9:16" | "16:9";
  variant: "quote" | "bold" | "split";
  /** Absolute path on disk, always under `THUMBS_ROOT`. */
  path: string;
  width: number;
  height: number;
  /**
   * The poster file's `mtimeMs` (truncated), taken when it was written.
   *
   * It exists only to be put in a URL. Posters are served `immutable` for a
   * year from `.../thumbnail/<key>`, and a redo overwrites `<key>.jpg` in
   * place, so without a token that changes with the file a retitled poster
   * stays stale in the browser for a year -- including the full-size JPEG the
   * operator downloads and uploads to YouTube. `Episode.updatedAt` cannot
   * stand in: it moves on any update to the row. 0 on rows stored before this
   * field existed (see `parseThumbnails`).
   */
  rev: number;
}

export interface ThumbFocus {
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ThumbPage {
  src: string;
  width: number;
  height: number;
}

export const ASPECTS = [
  { aspect: "9:16", tag: "9x16", width: 1080, height: 1920 },
  { aspect: "16:9", tag: "16x9", width: 1280, height: 720 },
] as const;

export const VARIANTS = ["quote", "bold", "split"] as const;

export type Variant = (typeof VARIANTS)[number];
export type AspectSpec = (typeof ASPECTS)[number];

/** Every key this module can ever produce, in render order. */
export const THUMB_KEYS: string[] = ASPECTS.flatMap((a) => VARIANTS.map((v) => `${a.tag}-${v}`));

/**
 * Deliberately outside `public/`, for the same reason renders are: a file under
 * `public/` is served by name with no handler in front of it, so any signed-in
 * user who guessed an episode id could read another operator's page photograph.
 */
export const THUMBS_ROOT = path.join(WORK_ROOT, "thumbs");

export function thumbsDir(episodeId: string): string {
  return path.join(THUMBS_ROOT, episodeId);
}

/**
 * Derived, grid-sized copies of an episode's posters.
 *
 * A cache, not a product: every file in here is reproducible from the
 * full-resolution JPEG beside it, so deleting the directory costs one
 * re-derivation and nothing else. Kept inside the episode's own folder so
 * that removing an episode removes its derivatives with it.
 */
export function gridDir(episodeId: string): string {
  return path.join(thumbsDir(episodeId), "grid");
}
