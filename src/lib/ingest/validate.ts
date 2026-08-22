import { BadUpload } from "../errors";

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
export const MAX_PHOTOS = 20;

export type ImageType = "jpeg" | "png" | "heic" | "webp";

const starts = (buf: Buffer, bytes: number[], at = 0) =>
  bytes.every((b, i) => buf[at + i] === b);

/**
 * Sniff the container from its own bytes. The filename is supplied by whoever
 * is uploading and is therefore not evidence of anything.
 */
export function detectImageType(buf: Buffer): ImageType | null {
  // No blanket minimum-length gate: JPEG's signature is 3 bytes and PNG's is
  // 8. `starts()` and `subarray()` never throw on a short buffer, they just
  // fail to match, so each format is safe to check at whatever length it
  // needs without rejecting a short-but-valid JPEG/PNG signature up front.
  if (starts(buf, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return "webp";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

/** Throws BadUpload naming the offending file, so the UI can say which one. */
export function checkPhotoBatch(files: { name: string; bytes: number }[]): void {
  if (files.length === 0) throw new BadUpload("No photographs were attached.");
  if (files.length > MAX_PHOTOS)
    throw new BadUpload(`That is ${files.length} photographs; at most ${MAX_PHOTOS} can go in one upload.`);

  for (const f of files) {
    if (f.bytes > MAX_PHOTO_BYTES)
      throw new BadUpload(
        `${f.name} is ${(f.bytes / 1024 / 1024).toFixed(1)} MB. Each photograph must be under ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`,
      );
  }

  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > MAX_UPLOAD_BYTES)
    throw new BadUpload(
      `The upload totals ${(total / 1024 / 1024).toFixed(1)} MB. Keep it under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
}
