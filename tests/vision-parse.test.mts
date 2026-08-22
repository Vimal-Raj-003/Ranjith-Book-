import test from "node:test";
import assert from "node:assert/strict";
import { wordsOf, parsePageText } from "../src/lib/ingest/vision";
import { CliError } from "../src/lib/content/cli";

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

test("a non-string paragraph element throws a named error, not an unnamed crash in wordsOf", () => {
  assert.throws(
    () => parsePageText({ chapterHeading: null, paragraphs: [123], legible: true, note: null }, 0),
    CliError,
  );
  assert.throws(
    () => parsePageText({ chapterHeading: null, paragraphs: [null], legible: true, note: null }, 0),
    CliError,
  );
});

test("a reply with no paragraphs key at all is a protocol failure, not a blank page", () => {
  assert.throws(
    () => parsePageText({ chapterHeading: null, legible: true, note: null }, 0),
    CliError,
  );
  assert.throws(() => parsePageText({}, 0), CliError);
});

test("an empty paragraphs array is a legitimate blank page, not an error", () => {
  const page = parsePageText(
    { chapterHeading: null, paragraphs: [], legible: true, note: null },
    0,
  );

  assert.deepEqual(page.paragraphs, []);
  assert.equal(page.legible, true);
});

test("a hyphenated token with no line break anywhere in its paragraph is flagged, not silently mangled", () => {
  const page = parsePageText(
    {
      chapterHeading: null,
      paragraphs: ["watching her own breath fog the con-centration of frost"],
      legible: true,
      note: null,
    },
    0,
  );

  assert.ok(page.note, "a dropped newline must announce itself, since it cannot be repaired");
  assert.match(page.note ?? "", /con-centration/);
  // The word stream is left exactly as transcribed — flagged, not fixed —
  // since a blanket fix would just as happily mangle "well-known".
  assert.ok(wordsOf(page).includes("con-centration"));
});

test("a genuine hyphenated line break does not trip the anomaly note", () => {
  const page = parsePageText(
    { chapterHeading: null, paragraphs: ["concen-\ntration matters"], legible: true, note: null },
    0,
  );

  assert.equal(page.note, null);
});
