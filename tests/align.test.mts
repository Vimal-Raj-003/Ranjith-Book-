import test from "node:test";
import assert from "node:assert/strict";
import { alignWords, normalizeToken, ALIGNMENT_FLOOR } from "../src/lib/ingest/align";
import type { OcrWord } from "../src/lib/ingest/ocr";

const ocr = (words: string[]): OcrWord[] =>
  words.map((text, i) => ({
    text,
    confidence: 90,
    box: { x0: i * 100, y0: 0, x1: i * 100 + 90, y1: 40 },
  }));

test("punctuation and case do not stop a word matching its box", () => {
  assert.equal(normalizeToken("Discipline,"), "discipline");
  assert.equal(normalizeToken("“beats”"), "beats");
  assert.equal(normalizeToken("—"), "");
});

test("a clean page maps every word onto its own box", () => {
  const vision = ["Discipline", "beats", "motivation."];
  const { aligned, confidence } = alignWords(vision, ocr(["Discipline", "beats", "motivation"]));

  assert.equal(confidence, 1);
  assert.deepEqual(aligned.map((a) => a.ocrIndex), [0, 1, 2]);
  assert.equal(aligned[1].box?.x0, 100);
});

test("a word OCR misread is left without a box rather than given the wrong one", () => {
  const vision = ["Discipline", "beats", "motivation"];
  // OCR mangles the middle word into something unrecognisable.
  const { aligned, confidence } = alignWords(vision, ocr(["Discipline", "bcats", "motivation"]));

  assert.equal(aligned[0].ocrIndex, 0);
  assert.equal(aligned[1].ocrIndex, null, "a guess here paints the marker over the wrong words");
  assert.equal(aligned[2].ocrIndex, 2, "alignment recovers after the gap");
  assert.ok(confidence > 0.6 && confidence < 1);
});

test("OCR inventing extra words does not shift every later word one box left", () => {
  const vision = ["the", "quick", "brown", "fox"];
  const { aligned } = alignWords(vision, ocr(["the", "|", "quick", "brown", "fox"]));

  assert.deepEqual(
    aligned.map((a) => a.ocrIndex),
    [0, 2, 3, 4],
    "spurious OCR tokens must be skipped, not absorbed",
  );
});

test("OCR dropping words leaves those words unboxed and keeps the rest correct", () => {
  const vision = ["one", "two", "three", "four"];
  const { aligned } = alignWords(vision, ocr(["one", "three", "four"]));

  assert.deepEqual(aligned.map((a) => a.ocrIndex), [0, null, 1, 2]);
});

test("a page OCR could not read at all falls under the floor", () => {
  const vision = ["alpha", "beta", "gamma", "delta"];
  const { confidence } = alignWords(vision, ocr(["zzz", "qqq"]));

  assert.ok(confidence < ALIGNMENT_FLOOR, "this page must degrade to block highlighting");
});

test("an empty OCR result is survivable, not a crash", () => {
  const { aligned, confidence } = alignWords(["a", "b"], []);
  assert.equal(confidence, 0);
  assert.deepEqual(aligned.map((a) => a.box), [null, null]);
});

// --- Beyond the brief's seven: cases a real photographed page produces. ---

test("a running head OCR reads but the vision model correctly omitted (leading insertion)", () => {
  // The vision model was told to leave running heads out of paragraphs, so it
  // never emits "Chapter Three" as a vision word — but OCR, which reads pixels
  // indiscriminately, picks it up sitting above the body text.
  const vision = ["Discipline", "beats", "motivation"];
  const { aligned, confidence } = alignWords(
    vision,
    ocr(["Chapter", "Three", "Discipline", "beats", "motivation"]),
  );

  assert.deepEqual(aligned.map((a) => a.ocrIndex), [2, 3, 4]);
  assert.equal(confidence, 1);
});

test("a trailing page number OCR reads but the vision model correctly omitted", () => {
  const vision = ["Discipline", "beats", "motivation"];
  const { aligned, confidence } = alignWords(
    vision,
    ocr(["Discipline", "beats", "motivation", "42"]),
  );

  assert.deepEqual(aligned.map((a) => a.ocrIndex), [0, 1, 2]);
  assert.equal(confidence, 1);
});

test("repeated words bind to their own instance, not a neighbour's", () => {
  // A naive matcher (e.g. "find the next OCR token with this text") could bind
  // every "the" to the first unused occurrence, drifting the rest of the row.
  // The LCS must pick the alignment that keeps everything else matching too.
  const vision = ["the", "cat", "sat", "on", "the", "mat", "in", "the", "hat"];
  const { aligned, confidence } = alignWords(
    vision,
    ocr(["the", "cat", "sat", "on", "the", "mat", "in", "the", "hat"]),
  );

  assert.deepEqual(
    aligned.map((a) => a.ocrIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(confidence, 1);
});

test("repeated words still align correctly around a dropped instance", () => {
  // OCR drops the middle "the" (index 4 in vision); the LCS must not instead
  // bind vision's later "the"s to the wrong OCR "the".
  const vision = ["the", "cat", "sat", "on", "the", "mat", "in", "the", "hat"];
  const { aligned } = alignWords(vision, ocr(["the", "cat", "sat", "on", "mat", "in", "the", "hat"]));

  assert.deepEqual(
    aligned.map((a) => a.ocrIndex),
    [0, 1, 2, 3, null, 4, 5, 6, 7],
  );
});

test("an accented vision word matches its unaccented OCR spelling", () => {
  const vision = ["García", "Márquez", "wrote"];
  const { aligned, confidence } = alignWords(vision, ocr(["Garcia", "Marquez", "wrote"]));

  assert.deepEqual(aligned.map((a) => a.ocrIndex), [0, 1, 2]);
  assert.equal(confidence, 1);
});
