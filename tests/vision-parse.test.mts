import test from "node:test";
import assert from "node:assert/strict";
import { wordsOf } from "../src/lib/ingest/vision";

test("words are taken in reading order, paragraph by paragraph", () => {
  const words = wordsOf({
    pageIndex: 0,
    chapterHeading: "Chapter Two",
    paragraphs: ["The first sentence.", "A second one, here."],
    legible: true,
    note: null,
  });

  assert.deepEqual(words, ["The", "first", "sentence.", "A", "second", "one,", "here."]);
});

test("the chapter heading is not part of the word stream", () => {
  const words = wordsOf({
    pageIndex: 0,
    chapterHeading: "Deep Work",
    paragraphs: ["Body text."],
    legible: true,
    note: null,
  });

  assert.ok(!words.includes("Deep"), "the heading is shown, not narrated, so it is not alignable body text");
  assert.deepEqual(words, ["Body", "text."]);
});

test("a hyphen broken across a line is rejoined", () => {
  const words = wordsOf({
    pageIndex: 0,
    chapterHeading: null,
    paragraphs: ["concen-\ntration matters"],
    legible: true,
    note: null,
  });

  assert.deepEqual(words, ["concentration", "matters"], "otherwise the highlight sweeps half a word");
});
