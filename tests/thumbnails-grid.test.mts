import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cacheControlFor, deriveGrid, parseSize } from "../src/lib/thumbnails/derive";
import { gridDir, thumbsDir, type ThumbSpec } from "../src/lib/thumbnails/types";

const EPISODE = "ep-grid-test";

/**
 * A 1080x1920 JPEG poster. `busy` fills it with noise so the file is
 * realistically heavy (a flat colour compresses to a few KB, which would let
 * any size assertion pass whether or not anything had been resized).
 */
async function makeFullPoster(key: string, busy = false): Promise<ThumbSpec> {
  const dir = thumbsDir(EPISODE);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.jpg`);
  await sharp({
    create: {
      width: 1080,
      height: 1920,
      channels: 3,
      background: "#204060",
      ...(busy ? { noise: { type: "gaussian" as const, mean: 128, sigma: 40 } } : {}),
    },
  })
    .jpeg({ quality: 80 })
    .toFile(file);
  return { key, aspect: "9:16", variant: "quote", path: file, width: 1080, height: 1920 };
}

test("parseSize accepts only 'grid' and treats hostile input as absent", () => {
  assert.equal(parseSize("grid"), "grid");
  assert.equal(parseSize(null), null);
  assert.equal(parseSize(""), null);
  assert.equal(parseSize("full"), null);
  // Review Focus 1: hostile values are absent, never a path fragment.
  assert.equal(parseSize("../../etc/passwd"), null);
  assert.equal(parseSize("grid/../.."), null);
  assert.equal(parseSize("GRID"), null);
  assert.equal(parseSize("x".repeat(10_000)), null);
  assert.equal(parseSize(["grid"]), null);
});

test("deriveGrid writes a small webp under the episode's own grid dir", async () => {
  const spec = await makeFullPoster("9x16-quote", true);
  const out = await deriveGrid(spec, EPISODE);
  assert.ok(out, "expected a derived file");
  assert.equal(path.dirname(out!), path.resolve(gridDir(EPISODE)));

  // Read through a Buffer, not by path: on Windows libvips keeps a path-opened
  // file mapped, which makes the cleanup below fail with EBUSY.
  const meta = await sharp(await fs.readFile(out!)).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 324);

  // The derivative must be a fraction of the poster it came from. The fixture
  // is noisy, so the original is large and a derivative that was never resized
  // (or was resized to the wrong width) would be of the same order and fail.
  const original = (await fs.stat(spec.path)).size;
  const derived = (await fs.stat(out!)).size;
  assert.ok(original > 200_000, `the fixture should be a heavy poster, got ${original} bytes`);
  assert.ok(derived * 4 < original, `grid variant (${derived} B) should be under a quarter of its original (${original} B)`);
});

test("deriveGrid is a cache: a second call returns the same path without rewriting", async () => {
  const spec = await makeFullPoster("9x16-bold");
  const first = await deriveGrid(spec, EPISODE);
  const stampBefore = (await fs.stat(first!)).mtimeMs;
  const second = await deriveGrid(spec, EPISODE);
  assert.equal(second, first);
  assert.equal((await fs.stat(second!)).mtimeMs, stampBefore);
});

test("a poster re-rendered under the same key is re-derived, not served stale", async () => {
  // The renderer overwrites `<key>.jpg` in place, so "the original never
  // changes" is not a safe assumption. A derivative older than its original
  // is a derivative of a poster that no longer exists.
  const spec = await makeFullPoster("9x16-redo");
  const first = await deriveGrid(spec, EPISODE);
  const before = await sharp(await fs.readFile(first!)).raw().toBuffer();
  assert.ok(before[0] < 100, "the first poster is dark blue");

  await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#c03020" } })
    .jpeg({ quality: 80 })
    .toFile(spec.path);
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(spec.path, later, later);

  const again = await deriveGrid(spec, EPISODE);
  assert.equal(again, first);
  const after = await sharp(await fs.readFile(again!)).raw().toBuffer();
  assert.ok(after[0] > 150, `the re-rendered poster is red, got R=${after[0]}`);
});

test("simultaneous requests for one poster all get a whole file and leave no temp behind", async () => {
  // The library card and the open inspector can ask for the same poster at once.
  // Several rounds, because on Windows the loser of a rename race fails only
  // some of the time and one clean round proves little.
  for (let round = 0; round < 6; round++) {
    const spec = await makeFullPoster(`9x16-race${round}`);
    const outs = await Promise.all(Array.from({ length: 8 }, () => deriveGrid(spec, EPISODE)));
    assert.ok(outs.every((o) => o && o === outs[0]), `round ${round}: every caller is handed the same path`);
    const meta = await sharp(await fs.readFile(outs[0]!)).metadata();
    assert.equal(meta.width, 324, "the file is complete and decodes");
  }
  const leftovers = (await fs.readdir(gridDir(EPISODE))).filter((n) => n.includes(".part."));
  assert.deepEqual(leftovers, []);
});

test("a degraded grid response is never cached as immutable", async () => {
  // A derivation that fails serves the full JPEG under the `?size=grid` URL.
  // If that were cached for a year the browser would never retry the
  // derivation, and one transient failure would defeat the whole point for
  // that poster.
  const broken = path.join(thumbsDir(EPISODE), "9x16-broken.jpg");
  await fs.mkdir(thumbsDir(EPISODE), { recursive: true });
  await fs.writeFile(broken, "this is not a jpeg");
  const spec: ThumbSpec = { key: "9x16-broken", aspect: "9:16", variant: "quote", path: broken, width: 1080, height: 1920 };
  const derived = await deriveGrid(spec, EPISODE);
  assert.equal(derived, null, "an undecodable original yields no derivative");

  const degraded = cacheControlFor("grid", derived);
  assert.doesNotMatch(degraded, /immutable/);
  assert.match(degraded, /\bno-cache\b/);
  assert.match(degraded, /^private\b/, "still never shared-cacheable");
});

test("a derivative that was made, and a plain full request, are cached for a year", () => {
  for (const header of [cacheControlFor("grid", "/x/9x16-quote.webp"), cacheControlFor(null, null)]) {
    assert.match(header, /^private\b/);
    assert.match(header, /max-age=31536000/);
    assert.match(header, /\bimmutable\b/);
  }
});

test("deriveGrid returns null rather than throwing when the original is gone", async () => {
  // Review Focus 2: a DB row outliving its file must not throw.
  const spec: ThumbSpec = {
    key: "9x16-split", aspect: "9:16", variant: "split",
    path: path.join(thumbsDir(EPISODE), "does-not-exist.jpg"),
    width: 1080, height: 1920,
  };
  assert.equal(await deriveGrid(spec, EPISODE), null);
});

test("a deleted grid cache is re-derived on the next call", async () => {
  const spec = await makeFullPoster("16x9-quote");
  const first = await deriveGrid(spec, EPISODE);
  await fs.rm(gridDir(EPISODE), { recursive: true, force: true });
  const again = await deriveGrid(spec, EPISODE);
  assert.equal(again, first);
  await fs.access(again!);
});

test.after(async () => {
  await fs.rm(thumbsDir(EPISODE), { recursive: true, force: true });
});
