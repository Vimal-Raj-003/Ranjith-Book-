import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  detectImageType,
  checkPhotoBatch,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
} from "../src/lib/ingest/validate";
import { normalizePhoto } from "../src/lib/ingest/normalize";

test("the declared extension is not trusted; the bytes are", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const script = Buffer.from("<?php system($_GET['c']); ?>", "utf8");

  assert.equal(detectImageType(jpeg), "jpeg");
  assert.equal(detectImageType(png), "png");
  assert.equal(detectImageType(script), null, "a php file named photo.jpg is not a photo");
});

test("a batch that is too big, or too many, is refused with a readable reason", () => {
  assert.throws(
    () => checkPhotoBatch([{ name: "huge.jpg", bytes: MAX_PHOTO_BYTES + 1 }]),
    /huge\.jpg/,
    "the message names the offending file",
  );

  const tooMany = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => ({
    name: `p${i}.jpg`,
    bytes: 1000,
  }));
  assert.throws(() => checkPhotoBatch(tooMany), /at most/i);

  assert.doesNotThrow(() => checkPhotoBatch([{ name: "ok.jpg", bytes: 500_000 }]));
});

test("normalising a photo removes its EXIF, GPS included", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-exif-"));
  const out = path.join(dir, "clean.jpg");

  const withGps = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#ffffff" },
  })
    .withExif({ IFD0: { Copyright: "somebody" }, IFD3: { GPSLatitudeRef: "N" } })
    .jpeg()
    .toBuffer();

  assert.ok(
    (await sharp(withGps).metadata()).exif,
    "precondition: the fixture actually carries EXIF",
  );

  const size = await normalizePhoto(withGps, out);
  const cleaned = await sharp(out).metadata();

  assert.equal(cleaned.exif, undefined, "no EXIF survives — a published video must not carry home coordinates");
  assert.equal(size.width, 40);
  assert.equal(size.height, 30);

  await fs.rm(dir, { recursive: true, force: true });
});
