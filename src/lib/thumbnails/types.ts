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

/**
 * The Marginalia palette, copied rather than imported: `themes/marginalia.ts`
 * hands out CSS for a 1080x1920 composition, and a thumbnail needs the colours
 * without the composition's element rules. The values must stay identical to
 * `marginalia.palette` — a thumbnail in a different yellow than the video it
 * advertises reads as a different channel.
 */
export const PALETTE = {
  paper: "#f6f1e4",
  ink: "#221d16",
  marker: "#ffe14d",
  markerEdge: "#f2c200",
  accent: "#d9531e",

  /** The framed layout's deep warm desk — what the `bold` variant sits on. */
  backdropDeep: "#150f09",
  backdropMid: "#2a1b10",
  backdropWarm: "#4b3220",
  bloomA: "rgba(217,83,30,0.55)",
  bloomB: "rgba(255,201,77,0.34)",
  /** Paper-white type on the dark backdrop, as the video's hook card uses. */
  hookInk: "#fdf6e6",
  /**
   * The accent as it is painted ON the dark backdrop. The video's own hook card
   * uses this tint (`.hook-key`) rather than raw `#d9531e`, which only reaches
   * about 4:1 against `#150f09`; at 200px wide in a feed that difference is the
   * difference between a keyword that pops and one that disappears.
   */
  hookKey: "#ffd23f",
} as const;

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
