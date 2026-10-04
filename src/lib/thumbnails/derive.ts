import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { gridDir, type ThumbSpec } from "./types";

/**
 * Grid-sized derivatives of the full-resolution posters.
 *
 * Why this exists: the library renders each poster at 164 CSS px but used to
 * download the 1080px, ~270 KB original. Measured on 2026-10-04 against a
 * 100-episode library, only 38 of 63 images had decoded after twenty seconds.
 * The posters were never broken — they simply never arrived.
 *
 * The width, in pixels, whatever the aspect. 324 is 3x the 164px the grid
 * paints, so it stays sharp on a 2x display and on a 3x phone, and lands
 * around 20 KB.
 */
export const GRID_WIDTH = 324;

/** The only `size` value this build serves. Anything else means "full". */
export type ThumbSize = "grid";

/**
 * Validate the `size` query parameter.
 *
 * `size` is hostile input and is treated exactly like `key` is: it is never
 * joined to a path, never normalised, never interpolated. It is compared
 * against one literal. Anything that is not that literal — a traversal
 * attempt, a casing variant, an array from a repeated query parameter — is
 * indistinguishable from the parameter being absent, which serves the
 * original. There is no code path in which this value reaches the filesystem.
 */
export function parseSize(raw: unknown): ThumbSize | null {
  return raw === "grid" ? "grid" : null;
}

/**
 * Is the derivative at `made` still a faithful copy of the poster at `source`?
 *
 * A derivative is a pure function of the original, so it is valid for exactly
 * as long as it is no older than that original. The renderer overwrites
 * `<key>.jpg` in place when a poster is redone, which makes the original's
 * mtime -- file metadata, not a clock read -- the whole freshness test.
 * Without it a redone poster would be shown stale from this cache.
 */
async function isFresh(made: string, source: string): Promise<boolean> {
  try {
    const [m, s] = await Promise.all([fs.stat(made), fs.stat(source)]);
    return m.size > 0 && m.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

/** Names each in-progress write, so concurrent derivations never share a file. */
let partSeq = 0;

/**
 * The grid-sized copy of one poster, deriving and caching it on first request.
 *
 * Returns the path, or `null` when no derivative could be produced — a missing
 * original, an unreadable one, a sharp failure. `null` is not an error: the
 * caller serves the full-resolution JPEG instead, which is slow but correct.
 * A thumbnail is never worth a 500.
 *
 * `spec.path` has already been through `selectThumb`, so it is confined to
 * this episode's own directory. The output name is built from `spec.key`,
 * which `selectThumb` matched byte-for-byte against the stored keys.
 */
export async function deriveGrid(spec: ThumbSpec, episodeId: string): Promise<string | null> {
  const dir = path.resolve(gridDir(episodeId));
  const out = path.join(dir, `${spec.key}.webp`);

  if (await isFresh(out, spec.path)) return out;

  // Written beside its destination and renamed into place. The grid fires many
  // requests at once and the same poster can be asked for twice (the library
  // card and the open inspector), so a reader must never find a half-written
  // file at `out` -- it would be served with a year-long cache lifetime. The
  // sequence number keeps simultaneous derivations of one key off each other's
  // temp file; it is a counter, not randomness.
  const part = path.join(dir, `${spec.key}.${process.pid}-${partSeq++}.part.webp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    // Read the original into memory rather than handing sharp its path. On
    // Windows libvips keeps a path-opened file mapped after it has finished
    // with it, and a mapped poster cannot be overwritten by a re-render or
    // deleted with its episode. ~270 KB is cheap; a stuck file is not.
    const original = await fs.readFile(spec.path);
    await sharp(original)
      .resize({ width: GRID_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(part);
    if ((await fs.stat(part)).size === 0) throw new Error("empty derivative");
    await fs.rename(part, out);
    return out;
  } catch {
    // Deliberately quiet and deliberately not fatal. The full-resolution
    // poster is still there and still correct.
    await fs.rm(part, { force: true }).catch(() => {});
    // Losing a race is not failing. On Windows a rename onto a name that a
    // simultaneous derivation has just taken can be refused (EPERM), but then
    // the file this call was trying to make is already in place and whole.
    return (await isFresh(out, spec.path)) ? out : null;
  }
}
