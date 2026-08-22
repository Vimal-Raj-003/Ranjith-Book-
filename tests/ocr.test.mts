import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { measurePage, disposeOcr } from "../src/lib/ingest/ocr";

test("a rendered line of text comes back as words with plausible boxes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-ocr-"));
  const img = path.join(dir, "line.png");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
    <rect width="900" height="200" fill="white"/>
    <text x="40" y="120" font-family="Georgia, serif" font-size="64" fill="black">discipline beats motivation</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(img);

  const words = await measurePage(img);

  assert.ok(words.length >= 3, `expected at least 3 words, got ${words.length}`);
  const texts = words.map((w) => w.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes("discipline")), `no 'discipline' in ${texts.join(" ")}`);

  // Boxes must be ordered left to right and sit inside the image.
  for (const w of words) {
    assert.ok(w.box.x1 > w.box.x0 && w.box.y1 > w.box.y0, "a box must have area");
    assert.ok(w.box.x1 <= 900 && w.box.y1 <= 200, "a box must sit inside the image");
  }
  const xs = words.map((w) => w.box.x0);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "words come back in reading order");

  await fs.rm(dir, { recursive: true, force: true });
});

// A live tesseract.js worker holds the Node event loop open (it is a
// persistent WASM child process), which would hang `npm test` forever if
// nothing ever terminated it. This is that termination.
test.after(async () => {
  await disposeOcr();
});
