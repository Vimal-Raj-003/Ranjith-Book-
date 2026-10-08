/**
 * Book covers: which sizes exist, how a request names one, and the URL a card
 * asks for.
 *
 * No imports, ever. `BookCover` is a client component and loads this in the
 * browser, so a line that reached `sharp` or Prisma from here would 500 every
 * route that renders the books list. A test holds this file to that, and the
 * client-ui allowlist names it; the same arrangement `thumbnails/url.ts` and
 * `setting-writes.ts` have. The derivation itself lives in `./derive`.
 */

/** The only sizes this build makes, smallest first. */
export const COVER_SIZES = ["small", "medium", "large"] as const;
export type CoverSize = (typeof COVER_SIZES)[number];

/**
 * The nominal width of each size, in pixels. 160 is 4x the ~40px a book card
 * paints, so it stays sharp on a 2x display and a 3x phone; 360 and 720 are for
 * a detail view and a full-bleed one.
 *
 * A page that is narrower than its box is NOT enlarged to fill it: a cover is a
 * downscale of the page, never an upscale of it.
 */
export const COVER_WIDTH: Record<CoverSize, number> = { small: 160, medium: 360, large: 720 };

/**
 * The long edge is capped at this multiple of the width. A book page is about
 * 1.4-1.6 times taller than it is wide, so for every real page the WIDTH is what
 * binds and the sizes above are exact. The cap exists for the page that is not
 * a page -- a very tall strip, a banner -- which would otherwise come out
 * 160px wide and several thousand tall.
 */
export const COVER_MAX_ASPECT = 2;

/** What a request with no `size`, or one that is not recognised, gets. */
export const DEFAULT_COVER_SIZE: CoverSize = "medium";

/**
 * Validate the `size` query parameter.
 *
 * `size` is hostile input and is treated like `parseSize` treats the poster
 * one: it is never joined to a path, never normalised, never interpolated. It
 * is compared against three literals, and what comes back is the module's OWN
 * literal rather than the caller's string, so there is no code path in which a
 * request value reaches the filesystem. Anything else -- a traversal attempt, a
 * casing variant, an array from a repeated query parameter -- is
 * indistinguishable from the parameter being absent.
 */
export function parseCoverSize(raw: unknown): CoverSize | null {
  return COVER_SIZES.find((size) => size === raw) ?? null;
}

/** Where a card's cover is fetched from, as the books list reports it. */
export type CoverStatus = "pending" | "ready" | "failed";

/**
 * The URL for one cover.
 *
 * `rev` is the version token: the covers are served `immutable` for a year, so
 * the only way a regenerated or re-rendered one reaches the browser is a
 * different URL. It is `coverRev` from `GET /api/books`. The server ignores the
 * value -- it is a cache key, never an input -- and a `rev` that is not a
 * non-negative number reads as 0, so a malformed row cannot put `NaN` in a URL.
 */
export function coverUrl(uploadId: string, size: CoverSize, rev: number): string {
  const v = Number.isFinite(rev) && rev > 0 ? Math.trunc(rev) : 0;
  return `/api/uploads/${encodeURIComponent(uploadId)}/cover?size=${size}&v=${v}`;
}
