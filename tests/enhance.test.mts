import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { enhancePage } from "../src/lib/ingest/enhance";
import { deriveForComposition } from "../src/lib/ingest/normalize";

const tmpdir = () => fs.mkdtemp(path.join(os.tmpdir(), "bookreel-enhance-"));

/**
 * A stand-in for an indoor phone photograph of a book page: dim, warm
 * (tungsten light puts far more red than blue on white paper), low contrast,
 * and deliberately NOT square — 1203 x 901, odd on both axes, because an
 * off-by-one in a resize or a rounding bug in an aspect-preserving fit shows
 * up on odd non-square dimensions and hides on 1000 x 1000.
 */
async function dimWarmPage(
  file: string,
  opts: { width?: number; height?: number; highlight?: boolean } = {},
): Promise<{ width: number; height: number }> {
  const width = opts.width ?? 1203;
  const height = opts.height ?? 901;

  const line = (w: number, h: number, colour: { r: number; g: number; b: number }) =>
    sharp({ create: { width: w, height: h, channels: 3, background: colour } })
      .png()
      .toBuffer();

  // Paper under a tungsten bulb: mid-grey, and 45 points warmer in red than
  // in blue. Ink is not black in such a photograph either — it is dark grey.
  const ink = { r: 92, g: 84, b: 66 };
  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < 12; i++) {
    composites.push({ input: await line(Math.round(width * 0.7), 18, ink), left: 90, top: 120 + i * 46 });
  }
  if (opts.highlight) {
    // A marker stripe the operator drew on the page itself.
    composites.push({
      input: await line(Math.round(width * 0.5), 40, { r: 236, g: 206, b: 52 }),
      left: 90,
      top: 700,
    });
  }

  await sharp({ create: { width, height, channels: 3, background: { r: 178, g: 163, b: 133 } } })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(file);

  return { width, height };
}

async function region(file: string, box: sharp.Region) {
  const { data, info } = await sharp(file).extract(box).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    r += data[i * 3];
    g += data[i * 3 + 1];
    b += data[i * 3 + 2];
  }
  return { r: r / n, g: g / n, b: b / n, luma: (0.299 * r + 0.587 * g + 0.114 * b) / n };
}

test("the enhanced page has byte-identical dimensions to the page it replaces", async () => {
  const dir = await tmpdir();
  const src = path.join(dir, "page.jpg");
  const out = path.join(dir, "page-enhanced.jpg");

  // Non-square and odd on both axes: 1203 x 901. A grade that quietly resized
  // would land on 1202 or 900 here, where a square fixture would hide it.
  const before = await dimWarmPage(src);
  assert.notEqual(before.width, before.height, "the fixture must be non-square for this test to mean anything");

  assert.equal(await enhancePage(src, out), true);
  const after = await sharp(out).metadata();

  // THE load-bearing assertion of this module. Every OCR word box, line run,
  // sweep step and camera key in the app is measured in the pixel space of
  // this exact image and is never re-measured or rescaled afterwards. If the
  // grade changed the raster by even one pixel in either direction, every
  // one of those coordinates would point at slightly the wrong place, the
  // yellow highlighter would drift off its words in every video ever
  // rendered, and nothing anywhere would report an error.
  assert.equal(after.width, before.width, "enhancement changed the width; every highlight box now points at the wrong pixels");
  assert.equal(after.height, before.height, "enhancement changed the height; every highlight box now points at the wrong pixels");
});

test("a dim warm photograph comes back reading as printed paper and black ink", async () => {
  const dir = await tmpdir();
  const src = path.join(dir, "page.jpg");
  const out = path.join(dir, "page-enhanced.jpg");
  await dimWarmPage(src);

  const paperBox = { left: 60, top: 760, width: 400, height: 100 };
  const inkBox = { left: 200, top: 122, width: 300, height: 14 };

  const paperBefore = await region(src, paperBox);
  const inkBefore = await region(src, inkBox);

  assert.equal(await enhancePage(src, out), true);

  const paperAfter = await region(out, paperBox);
  const inkAfter = await region(out, inkBox);

  // Grey paper reads as white paper.
  assert.ok(
    paperAfter.luma > 235,
    `paper should read as white, got luma ${paperAfter.luma.toFixed(1)} from ${paperBefore.luma.toFixed(1)}`,
  );
  // The warm cast is neutralised. Not to zero: a deliberate ivory tone is put
  // back on top so the page reads as book paper rather than an office scan,
  // and that tone is a small, CONSISTENT red-over-blue lift rather than the
  // ~45 point cast the bulb left.
  const castBefore = paperBefore.r - paperBefore.b;
  const castAfter = paperAfter.r - paperAfter.b;
  assert.ok(castBefore > 35, `fixture should have a real cast, got ${castBefore.toFixed(1)}`);
  assert.ok(
    castAfter > 4 && castAfter < 26,
    `paper should end up gently warm, not orange and not bleached neutral, got ${castAfter.toFixed(1)}`,
  );
  // Ink that photographed as dark grey now reads as ink.
  assert.ok(
    inkAfter.luma < 60 && inkAfter.luma < inkBefore.luma - 20,
    `ink should read as black, got luma ${inkAfter.luma.toFixed(1)} from ${inkBefore.luma.toFixed(1)}`,
  );
  // ...but not crushed to a solid slab. Below ~4 the antialiased edges of
  // thin serif strokes have been eaten and the text goes blobby.
  assert.ok(inkAfter.luma > 2, `ink should not be crushed flat, got luma ${inkAfter.luma.toFixed(1)}`);
});

test("yellow survives the grade, so a highlight can never read as grey", async () => {
  const dir = await tmpdir();
  const src = path.join(dir, "page.jpg");
  const out = path.join(dir, "page-enhanced.jpg");
  await dimWarmPage(src, { highlight: true });

  const mark = { left: 120, top: 710, width: 400, height: 20 };
  const before = await region(src, mark);
  assert.equal(await enhancePage(src, out), true);
  const after = await region(out, mark);

  // The grade neutralises the illuminant and pulls chroma back to tame the
  // colour noise a phone sensor leaves in the paper. Pulled too far, every
  // yellow near this page — the marker the operator drew, and the yellow
  // highlighter the composition paints over it later — would drift towards
  // grey. Yellow is red-and-green over blue: that separation must survive.
  assert.ok(before.r - before.b > 100, "fixture marker should start clearly yellow");
  assert.ok(
    after.r - after.b > 100 && after.g > after.b + 60,
    `the marker must still read yellow: r=${after.r.toFixed(0)} g=${after.g.toFixed(0)} b=${after.b.toFixed(0)}`,
  );
});

test("a page that cannot be graded leaves the original untouched and no debris behind", async () => {
  const dir = await tmpdir();
  const notAnImage = path.join(dir, "broken.jpg");
  const out = path.join(dir, "derived.jpg");
  await fs.writeFile(notAnImage, "GIF89a-ish, but really just prose about a book");
  await fs.writeFile(out, "the original derivative");

  // Best-effort by contract: never throws, and a failure must not sink the
  // upload — the ungraded derivative ships instead.
  assert.equal(await enhancePage(notAnImage, out), false);
  assert.equal(await fs.readFile(out, "utf8"), "the original derivative", "the existing derivative was overwritten");

  const left = await fs.readdir(dir);
  assert.deepEqual(
    left.filter((f) => f.includes(".tmp")),
    [],
    "a half-written grade was left on disk",
  );
});

test("grading in place is safe: same path in and out", async () => {
  const dir = await tmpdir();
  const page = path.join(dir, "page.jpg");
  const before = await dimWarmPage(page, { width: 800, height: 1100 });

  assert.equal(await enhancePage(page, page), true);

  const after = await sharp(page).metadata();
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((f) => f.includes(".tmp")),
    [],
  );
});

test("the derivative the whole app measures against is still 1600px on its long edge", async () => {
  const dir = await tmpdir();
  const src = path.join(dir, "photo.jpg");
  const derived = path.join(dir, "photo-derived.jpg");
  await dimWarmPage(src, { width: 3000, height: 2250 });

  await deriveForComposition(src, derived);
  const meta = await sharp(derived).metadata();

  // The grade runs inside deriveForComposition. It must not have moved the
  // resize target the entire coordinate space is built on.
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 1200);
  assert.deepEqual(
    (await fs.readdir(dir)).filter((f) => f.includes(".tmp")),
    [],
  );
});
