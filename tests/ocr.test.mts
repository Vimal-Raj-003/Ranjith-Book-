import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { measurePage, disposeOcr, setOcrEngine, type OcrEngine, type OcrWord } from "../src/lib/ingest/ocr";
import { OcrTimeoutError } from "../src/lib/errors";

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

// A single rendered line only ever exercises one block, one paragraph, one
// line, three words — the block/paragraph/line loops in `measurePage` never
// go past depth one, and a traversal bug that returned the LINE's shared
// bbox for every word would still pass the test above: three identical,
// valid, in-bounds boxes are non-decreasing in x0 by definition. Word-level
// boxes are the entire point of this task (they're what lets the marker
// sweep one word instead of a whole line), so this fixture renders two
// separate lines of three words each and asserts something a line-level
// fallback would actually fail.
test("word boxes are per-word, not the shared line box repeated for every word on it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-ocr-multi-"));
  const img = path.join(dir, "page.png");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400">
    <rect width="1000" height="400" fill="white"/>
    <text x="40" y="120" font-family="Georgia, serif" font-size="54" fill="black">discipline beats motivation</text>
    <text x="40" y="300" font-family="Georgia, serif" font-size="54" fill="black">consistency creates freedom</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(img);

  const words = await measurePage(img);
  assert.ok(words.length >= 6, `expected at least 6 words across two lines, got ${words.length}`);

  // The two rendered lines sit ~180px apart at a 54px font, so their word
  // y-centers cluster into two well-separated bands. Grouping by that band
  // proves the traversal actually walked more than one line (`para.lines`
  // beyond index 0), which the single-line fixture above cannot show.
  const bandOf = (w: (typeof words)[number]) => Math.round((w.box.y0 + w.box.y1) / 2 / 40);
  const byBand = new Map<number, typeof words>();
  for (const w of words) byBand.set(bandOf(w), [...(byBand.get(bandOf(w)) ?? []), w]);
  assert.ok(byBand.size >= 2, `expected words spread across at least two lines, got bands ${[...byBand.keys()]}`);

  let checkedAMultiWordLine = false;
  for (const lineWords of byBand.values()) {
    if (lineWords.length < 2) continue;
    checkedAMultiWordLine = true;

    // Distinct words on the same line must get distinct boxes. A traversal
    // that stamped the LINE's bbox onto every word in it would make every
    // word on this line come back with the exact same box.
    const boxKeys = lineWords.map((w) => `${w.box.x0},${w.box.x1}`);
    assert.equal(
      new Set(boxKeys).size,
      lineWords.length,
      `words on the same line must have distinct boxes, got ${boxKeys.join(" | ")}`,
    );

    // And each word's box must be narrower than the line it sits on — if a
    // word's box were really the line's box, its width would equal the
    // line's width exactly instead of being a fraction of it.
    const lineX0 = Math.min(...lineWords.map((w) => w.box.x0));
    const lineX1 = Math.max(...lineWords.map((w) => w.box.x1));
    const lineWidth = lineX1 - lineX0;
    for (const w of lineWords) {
      const wordWidth = w.box.x1 - w.box.x0;
      assert.ok(
        wordWidth < lineWidth,
        `a word's box (${wordWidth}px wide) must be narrower than the line it sits on (${lineWidth}px) — equal widths mean a line-level box leaked into a word`,
      );
    }
  }
  assert.ok(checkedAMultiWordLine, "fixture must render at least one line with 2+ words to exercise this check");

  await fs.rm(dir, { recursive: true, force: true });
});

// Reproduces a crash found in review: `disposeOcr()` calling `terminate()`
// while a `measurePage()` call is still in flight on the same worker used to
// kill the whole process. tesseract.js's `worker.terminate()` nulls its
// *internal* worker reference, but the in-flight `recognize()` later makes
// an un-awaited internal `send()` call against that same (now-null) worker,
// which throws `TypeError: Cannot read properties of null (reading
// 'postMessage')` as an unhandled rejection — outside the promise
// `measure()` is awaiting, so Node's default is to kill the process rather
// than reject anything. Reproduced against the pre-fix code with a
// standalone script (see task-7-report.md); this is the regression test.
test("disposeOcr() while a measurePage() call is still in flight does not crash and both settle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-ocr-race-"));
  const img = path.join(dir, "line.png");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
    <rect width="900" height="200" fill="white"/>
    <text x="40" y="120" font-family="Georgia, serif" font-size="64" fill="black">discipline beats motivation</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(img);

  const measuring = measurePage(img);
  // Give the in-flight call time to actually reach the worker before
  // disposing underneath it — the crash needs a real race, not dispose()
  // winning outright before recognize() has started.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const disposing = disposeOcr();

  // Orderly teardown: the call that was already running gets to finish with
  // a real result, and disposeOcr() only resolves once it has.
  const [words] = await Promise.all([measuring, disposing]);
  assert.ok(words.length >= 3, `expected the in-flight call to still complete normally, got ${words.length} words`);

  // A fresh call after full disposal gets a fresh engine and worker rather
  // than hanging or reusing a terminated one — the other defensible policy
  // named in review, chosen here over a permanent named error so a stray
  // disposeOcr() mid-pipeline is recoverable rather than fatal to every page
  // after it.
  const wordsAfterDispose = await measurePage(img);
  assert.ok(wordsAfterDispose.length >= 3, "a call after full disposal should get a fresh worker, not hang or throw");

  await fs.rm(dir, { recursive: true, force: true });
});

// Reproduces the production incident this task fixes: `tesseract.js`'s
// `createWorker()` spawning a worker that never resolves and never rejects
// (confirmed live, in an actual Next.js dev server route, to be caused by
// Turbopack bundling the worker's `__dirname`-derived path resolution —
// fixed by `serverExternalPackages` in `next.config.ts`). Regardless of
// root cause, `measurePage` must never let a hung OCR pass turn into a dead
// ingest run: it has to time out on its own, with a name the caller can
// recognize as "OCR stalled" rather than some other failure. A fake engine
// whose `measure()` never settles reproduces the hang deterministically,
// without waiting on a real worker; `timeoutMs` is overridden so the test
// does not have to wait out the real (60s) production timeout to see it
// fire.
test("measurePage times out instead of hanging forever, and throws a named error", async () => {
  class NeverResolvingEngine implements OcrEngine {
    async measure(): Promise<OcrWord[]> {
      return new Promise(() => {
        // Deliberately never resolves or rejects — this is the hang.
      });
    }
    async dispose(): Promise<void> {}
  }

  setOcrEngine(new NeverResolvingEngine());
  try {
    await assert.rejects(
      () => measurePage("/does/not/matter.jpg", 20),
      (err: unknown) => {
        assert.ok(err instanceof OcrTimeoutError, `expected OcrTimeoutError, got ${err}`);
        assert.match((err as Error).message, /timed out/);
        return true;
      },
    );
  } finally {
    // Drop the fake engine so later tests (and `test.after` below) get a
    // fresh, real `TesseractEngine` instead of the one that never resolves.
    await disposeOcr();
  }
});

// A live tesseract.js worker holds the Node event loop open (it is a
// persistent WASM child process), which would hang `npm test` forever if
// nothing ever terminated it. This is that termination.
test.after(async () => {
  await disposeOcr();
});
