import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BadUpload } from "../errors";
import { detectImageType } from "./validate";
import { enhancePage } from "./enhance";

/**
 * Re-encode through a decoder before anything else touches the file, and drop
 * every metadata block on the way through. Phone photographs of books carry GPS
 * coordinates; a published video must not.
 *
 * `rotate()` with no argument reads the EXIF orientation tag, physically
 * transposes the pixels to match it, and then discards the tag — the pixels
 * no longer need it once they are actually upright. That has to happen before
 * `.jpeg()` re-encodes and drops the metadata block outright: `rotate()` runs
 * first in the pipeline (Sharp applies operations as they are chained, and the
 * metadata strip is a side effect of the output encode that comes after), so
 * orientation is consumed and burned into the pixels before the tag carrying
 * it is ever discarded. Only the EXIF orientation tag is read; every other
 * EXIF block (including GPS) is dropped unread — Sharp does not copy
 * metadata forward unless `withMetadata()` is used, and this pipeline never
 * calls it.
 */
export async function normalizePhoto(
  buf: Buffer,
  outPath: string,
): Promise<{ width: number; height: number }> {
  if (!detectImageType(buf)) throw new BadUpload("That file is not an image the app can read.");

  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const out = await sharp(buf, { failOn: "error" })
    .rotate()
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outPath);

  return { width: out.width, height: out.height };
}

/**
 * The composition frame is 1,080 px wide; phone photographs arrive around
 * 4,000 px. This downscale happens at upload time (not at render time),
 * because the OCR geometry pass and the video composition must share one
 * coordinate space — both consume this derived image, never the original —
 * or highlight boxes computed against one resolution will not land on the
 * right words when drawn against another.
 *
 * `fit: "inside"` with `withoutEnlargement: true` preserves aspect ratio
 * exactly and never upscales a photo that is already smaller than the
 * target long edge. The full-resolution original is kept on disk separately
 * (this function never touches it) in case a future task needs it.
 *
 * The derivative is then graded in place by `enhancePage` (spec §7) so an
 * indoor phone photograph reads as a printed book rather than a photocopy.
 * That step is deliberately last and deliberately best-effort: it returns
 * `false` instead of throwing, and a `false` leaves the resized derivative
 * on disk exactly as written here. It also cannot resize — it writes to a
 * temp file and refuses to install it unless the dimensions came back
 * identical — so the coordinate space every OCR box, line run, sweep step
 * and camera key is measured in is the same one either way.
 */
export async function deriveForComposition(
  srcPath: string,
  outPath: string,
  longEdge = 1600,
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(srcPath)
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outPath);

  await enhancePage(outPath, outPath);
}
