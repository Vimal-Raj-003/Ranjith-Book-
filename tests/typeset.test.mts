import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { typesetPages, PAGE, TYPE } from "../src/lib/typeset";
import { toParagraphs, toSegments, toWords, wordsOfText } from "../src/lib/typeset/text";
import { buildLineRuns } from "../src/lib/ingest/lines";
import { sweepForBeat } from "../src/lib/video/sweep";
import type { Box } from "../src/lib/ingest/ocr";

// ------------------------------------------------------------------ the text

test("a hard-wrapped file becomes paragraphs, not lines", () => {
  const paragraphs = toParagraphs(
    "It was the best of times,\nit was the worst of times.\n\nA second paragraph\nwrapped too.",
  );
  assert.deepEqual(paragraphs, [
    "It was the best of times, it was the worst of times.",
    "A second paragraph wrapped too.",
  ]);
});

test("carriage returns, form feeds and runs of blank lines are all paragraph breaks or noise", () => {
  assert.deepEqual(toParagraphs("one\r\ntwo\r\n\r\n\r\nthree"), ["one two", "three"]);
  assert.deepEqual(toParagraphs("page one\fpage two"), ["page one", "page two"]);
  assert.deepEqual(toParagraphs("a\n   \n\t\nb"), ["a", "b"]);
});

test("nothing to typeset yields no paragraphs rather than one empty one", () => {
  for (const empty of ["", "   ", "\n\n\n", "\t \r\n \n"]) {
    assert.deepEqual(toParagraphs(empty), [], JSON.stringify(empty));
  }
  assert.deepEqual(toParagraphs(undefined), []);
  assert.deepEqual(toParagraphs(42), []);
});

test("Gutenberg's _emphasis_ becomes italics, not underscores in the words", () => {
  assert.deepEqual(toSegments("He read _Paradise Lost_ twice."), [
    { text: "He read ", italic: false },
    { text: "Paradise Lost", italic: true },
    { text: " twice.", italic: false },
  ]);

  const words = toWords(["He read _Paradise Lost_ twice."]);
  assert.deepEqual(
    words.map((w) => w.word),
    ["He", "read", "Paradise", "Lost", "twice."],
    "an underscore is markup, and must not survive into a narrated token",
  );
  assert.deepEqual(
    words.map((w) => w.italic),
    [false, false, true, true, false],
  );
});

test("an unmatched underscore is printed, not silently deleted", () => {
  assert.deepEqual(toSegments("a _ b"), [{ text: "a _ b", italic: false }]);
  assert.deepEqual(
    toWords(["snake_case and a lone _ mark"]).map((w) => w.word),
    ["snake_case", "and", "a", "lone", "_", "mark"],
  );
});

test("words carry the paragraph they belong to, in reading order", () => {
  const words = wordsOfText("First one.\n\nSecond one here.");
  assert.deepEqual(
    words.map((w) => `${w.paragraph}:${w.word}`),
    ["0:First", "0:one.", "1:Second", "1:one", "1:here."],
  );
});

// ------------------------------------------- edge cases that never see a browser

test("thin input returns no pages instead of throwing", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-typeset-empty-"));
  try {
    const nothing = { outDir, pageCount: 3 };
    assert.deepEqual(await typesetPages({ ...nothing, text: "" }), [], "empty text");
    assert.deepEqual(await typesetPages({ ...nothing, text: "   \n\n\t " }), [], "whitespace only");
    assert.deepEqual(
      await typesetPages({ ...nothing, text: "three words here", startWord: 99 }),
      [],
      "startWord past the end",
    );
    assert.deepEqual(
      await typesetPages({ text: "a real sentence to set", outDir, pageCount: 0 }),
      [],
      "no pages asked for",
    );
    assert.deepEqual(
      await typesetPages({ text: "a real sentence to set", outDir, pageCount: -4 }),
      [],
      "a negative page count",
    );
    assert.deepEqual(
      await typesetPages({ text: "a real sentence to set", outDir, pageCount: Number.NaN }),
      [],
      "a page count that is not a number",
    );

    const written = await fs.readdir(outDir);
    assert.deepEqual(written, [], "nothing to typeset writes nothing");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- full render

// Chromium is cached on a developer machine and in the render image, but the
// suite must stay green somewhere it is not.
const chromiumAvailable = await chromium
  .launch()
  .then((b) => b.close())
  .then(() => true)
  .catch(() => false);
const needsChromium = { skip: chromiumAvailable ? false : "chromium is not available here" };

/** Deterministic prose: no clock, no randomness, and long enough for pages. */
function prose(paragraphs: number): string {
  const sentences = [
    "The lamp on the desk had been burning since the middle of the afternoon, and the room smelled faintly of hot brass.",
    "He turned the page without reading it, and then turned it back, ashamed of himself for the habit.",
    "Outside, the rain had settled into the steady, unhurried rhythm that means it has no intention of stopping.",
    "She said nothing at all for a long moment, which was answer enough, and he had the grace not to ask again.",
    "It is a curious thing, how a house one has lived in for years can become unfamiliar in a single evening.",
  ];
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const line: string[] = [];
    for (let s = 0; s < 5; s++) line.push(sentences[(p * 3 + s) % sentences.length]);
    out.push(line.join(" "));
  }
  return out.join("\n\n");
}

async function typesetInto(
  name: string,
  opts: { text: string; pageCount: number; startWord?: number; title?: string },
) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `bookreel-typeset-${name}-`));
  const pages = await typesetPages({ ...opts, outDir });
  return { pages, outDir };
}

test("a typeset page is exactly the photo derivative's geometry", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("geom", { text: prose(12), pageCount: 2 });
  try {
    assert.equal(pages.length, 2);
    for (const page of pages) {
      assert.equal(page.width, 1100, "the width the camera maths was calibrated against");
      assert.equal(page.height, 1600);
      assert.equal(Math.max(page.width, page.height), 1600, "1600px long edge, as deriveForComposition emits");
      assert.ok(page.height > page.width, "portrait");

      // Not just the reported numbers — the file on disk.
      const meta = await sharp(page.path).metadata();
      assert.equal(meta.width, PAGE.width);
      assert.equal(meta.height, PAGE.height);
      assert.equal(meta.format, "jpeg");
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("visionIndex restarts at 0 on every page", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("index", { text: prose(30), pageCount: 3 });
  try {
    assert.equal(pages.length, 3, "three full pages of prose");
    for (const page of pages) {
      assert.ok(page.words.length > 100, "a full page of words");
      assert.equal(page.words[0].visionIndex, 0, "every page counts from zero");
      page.words.forEach((w, i) => {
        assert.equal(w.visionIndex, i, "and counts up by one, with no gaps");
        assert.equal(w.ocrIndex, i, "a typeset word is its own measurement");
        assert.ok(w.box, "every word carries a real box — there is no unboxed case here");
      });
    }

    // The words themselves do continue across the page break, in reading order.
    const all = wordsOfText(prose(30)).map((w) => w.word);
    const flat = pages.flatMap((p) => p.words.map((w) => w.word));
    assert.deepEqual(flat, all.slice(0, flat.length), "pages are consecutive, not overlapping");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("boxes stay on the sheet and advance down it", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("boxes", { text: prose(20), pageCount: 2, title: "A Test Book" });
  try {
    for (const page of pages) {
      let previousTop = -1;
      for (const w of page.words) {
        const box = w.box as Box;
        assert.ok(box.x0 >= 0 && box.x1 <= PAGE.width, `${w.word} inside the sheet horizontally`);
        assert.ok(box.y0 >= TYPE.top - 2, `${w.word} below the running head`);
        assert.ok(box.y1 <= TYPE.top + TYPE.height + 2, `${w.word} above the folio`);
        assert.ok(box.x1 > box.x0 && box.y1 > box.y0, `${w.word} has a real extent`);
        assert.ok(box.y0 >= previousTop, "reading order runs down the page");
        previousTop = box.y0;
      }
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

/**
 * The property the whole feature rests on: the boxes describe the ink.
 *
 * Counting dark pixels inside the boxes against every dark pixel in the type
 * block is a measurement, not a look — a set of boxes that is plausible but
 * twenty pixels out fails it. The same count with the boxes deliberately
 * shifted is the control: without it, "98% of the ink is inside the boxes"
 * could be an artefact of boxes so large they cover the whole block.
 */
async function inkInsideBoxes(file: string, boxes: Box[], shiftX = 0, shiftY = 0) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  const dark = (x: number, y: number) => data[y * info.width + x] < 128;

  const covered = new Uint8Array(info.width * info.height);
  for (const b of boxes) {
    for (let y = Math.max(0, b.y0 + shiftY); y < Math.min(info.height, b.y1 + shiftY); y++) {
      for (let x = Math.max(0, b.x0 + shiftX); x < Math.min(info.width, b.x1 + shiftX); x++) {
        covered[y * info.width + x] = 1;
      }
    }
  }

  let ink = 0;
  let inside = 0;
  for (let y = TYPE.top; y < TYPE.top + TYPE.height; y++) {
    for (let x = TYPE.left; x < TYPE.left + TYPE.width; x++) {
      if (!dark(x, y)) continue;
      ink++;
      if (covered[y * info.width + x]) inside++;
    }
  }
  return { ink, share: ink === 0 ? 0 : inside / ink };
}

test("the boxes land on the words, measured in ink", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("ink", { text: prose(20), pageCount: 2, title: "A Test Book" });
  try {
    for (const page of pages) {
      const boxes = page.words.map((w) => w.box as Box);
      const on = await inkInsideBoxes(page.path, boxes);
      assert.ok(on.ink > 50_000, `the page actually has type on it (${on.ink} dark pixels)`);
      assert.ok(
        on.share > 0.995,
        `virtually every inked pixel in the type block is inside a word box (${(on.share * 100).toFixed(2)}%)`,
      );

      // Controls. Without them, "99.9% of the ink is inside the boxes" could
      // just as well be true of boxes big enough to cover the whole block.
      // A horizontal shift never falls as far as a vertical one, because the
      // boxes of a line tile it end to end and a shifted box lands on its
      // neighbour's word — which is exactly the drift this feature must not
      // have, so the bound is what matters, not the size of the fall.
      const right = await inkInsideBoxes(page.path, boxes, 10, 0);
      const down = await inkInsideBoxes(page.path, boxes, 0, 20);
      assert.ok(right.share < 0.95, `10px right loses ink (${(right.share * 100).toFixed(1)}%)`);
      assert.ok(down.share < 0.85, `20px down loses ink (${(down.share * 100).toFixed(1)}%)`);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("the words feed clusterLineRuns and the sweep with no adaptation", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("lines", { text: prose(20), pageCount: 1 });
  try {
    const page = pages[0];
    const { words, lines } = buildLineRuns(page.words);

    assert.equal(words.length, page.words.length, "nothing needed a box inherited — every word had one");
    assert.ok(lines.length >= 20 && lines.length <= 30, `one run per printed line (${lines.length})`);

    const seen = lines.flatMap((l) => l.wordIndices);
    assert.equal(seen.length, page.words.length, "every word belongs to exactly one line");
    assert.deepEqual([...seen].sort((a, b) => a - b), page.words.map((_, i) => i));

    for (const line of lines) {
      assert.deepEqual([...line.wordIndices].sort((a, b) => a - b), line.wordIndices, "ascending");
      assert.equal(line.wordBoxes.length, line.wordIndices.length);
      // A line's hull must not swallow the line above or below it.
      assert.ok(line.box.y1 - line.box.y0 < TYPE.size * TYPE.leading, "one line tall");
    }

    const steps = sweepForBeat(lines, 0, 40, 0, 4);
    assert.ok(steps.length >= 2, "a 41-word beat sweeps several lines");
    assert.equal(steps[0].start, 0);
    assert.equal(steps[steps.length - 1].end, 4);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("the same text and options render the same bytes and the same boxes", needsChromium, async () => {
  const text = prose(16);
  const first = await typesetInto("det-a", { text, pageCount: 2, title: "Repeatable" });
  const second = await typesetInto("det-b", { text, pageCount: 2, title: "Repeatable" });
  try {
    assert.equal(first.pages.length, second.pages.length);
    for (let i = 0; i < first.pages.length; i++) {
      const a = await fs.readFile(first.pages[i].path);
      const b = await fs.readFile(second.pages[i].path);
      assert.ok(a.equals(b), `page ${i + 1} is byte-identical`);
      assert.deepEqual(second.pages[i].words, first.pages[i].words, `page ${i + 1} boxes are identical`);
    }
  } finally {
    await fs.rm(first.outDir, { recursive: true, force: true });
    await fs.rm(second.outDir, { recursive: true, force: true });
  }
});

test("startWord picks up mid-book, and the page still starts at word 0", needsChromium, async () => {
  const text = prose(20);
  const all = wordsOfText(text).map((w) => w.word);
  const { pages, outDir } = await typesetInto("start", { text, pageCount: 1, startWord: 300 });
  try {
    assert.equal(pages.length, 1);
    assert.equal(pages[0].words[0].visionIndex, 0);
    assert.equal(pages[0].words[0].word, all[300], "the page opens on the word asked for");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("more pages than the text supports returns the pages that exist", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("short", { text: prose(2), pageCount: 10 });
  try {
    assert.ok(pages.length >= 1 && pages.length < 10, `${pages.length} pages, not ten`);
    const written = (await fs.readdir(outDir)).sort();
    assert.equal(written.length, pages.length, "no half-written extra page images");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("text shorter than one page is still a page", needsChromium, async () => {
  const { pages, outDir } = await typesetInto("tiny", {
    text: "One short sentence, and nothing else at all.",
    pageCount: 4,
    title: "A Thin Book",
  });
  try {
    assert.equal(pages.length, 1);
    assert.equal(pages[0].words.length, 8);
    assert.equal(pages[0].words[7].word, "all.");
    const stat = await fs.stat(pages[0].path);
    assert.ok(stat.size > 4096, "a real image");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("a word longer than the measure breaks instead of running off the sheet", needsChromium, async () => {
  const monster = "M".repeat(400);
  const { pages, outDir } = await typesetInto("monster", {
    text: `A sentence before it. ${monster} And one after it.`,
    pageCount: 2,
  });
  try {
    assert.ok(pages.length >= 1);
    const word = pages[0].words.find((w) => w.word.startsWith("MMMM"));
    assert.ok(word, "the long word is still a word in the stream");
    const box = word.box as Box;
    assert.ok(box.x0 >= 0 && box.x1 <= PAGE.width, "its box stays on the sheet");
    assert.ok(box.x1 - box.x0 <= TYPE.width + 2, "and inside the measure");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("text with no paragraph breaks at all typesets as one long paragraph", needsChromium, async () => {
  const oneParagraph = prose(6).replace(/\n\n/g, " ");
  const { pages, outDir } = await typesetInto("flow", { text: oneParagraph, pageCount: 2 });
  try {
    assert.ok(pages.length >= 1);
    for (const page of pages) {
      assert.ok(page.words.every((w) => w.box), "boxed all the way through");
    }
    if (pages.length > 1) {
      // The second page resumes the paragraph, so its first line is flush left
      // rather than indented.
      assert.ok(pages[1].words[0].box!.x0 <= TYPE.left + 2, "a carried-over paragraph is not re-indented");
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
