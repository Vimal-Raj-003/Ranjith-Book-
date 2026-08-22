import test from "node:test";
import assert from "node:assert/strict";
import { clusterLineRuns, inheritBoxes, runsForRange } from "../src/lib/ingest/lines";
import type { AlignedWord } from "../src/lib/ingest/align";

/** Three words on line one at y 0-40, three on line two at y 60-100. */
const twoLines = (): AlignedWord[] =>
  [
    { visionIndex: 0, word: "a", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "b", ocrIndex: 1, box: { x0: 100, y0: 2, x1: 180, y1: 42 } },
    { visionIndex: 2, word: "c", ocrIndex: 2, box: { x0: 190, y0: 1, x1: 270, y1: 41 } },
    { visionIndex: 3, word: "d", ocrIndex: 3, box: { x0: 10, y0: 60, x1: 90, y1: 100 } },
    { visionIndex: 4, word: "e", ocrIndex: 4, box: { x0: 100, y0: 61, x1: 180, y1: 101 } },
    { visionIndex: 5, word: "f", ocrIndex: 5, box: { x0: 190, y0: 60, x1: 270, y1: 100 } },
  ];

test("words sharing a baseline become one continuous stroke", () => {
  const lines = clusterLineRuns(twoLines());

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].wordIndices, [0, 1, 2]);
  assert.equal(lines[0].box.x0, 10, "the stroke starts at the first word");
  assert.equal(lines[0].box.x1, 270, "and runs to the last — no gaps between words");
  assert.deepEqual(lines[1].wordIndices, [3, 4, 5]);
  assert.deepEqual(
    lines[0].wordBoxes.map((b) => b.x0),
    [10, 100, 190],
    "wordBoxes is parallel to wordIndices — element i is that word's real box",
  );
});

test("lines come out in reading order, top to bottom", () => {
  const shuffled = [...twoLines()].reverse();
  const lines = clusterLineRuns(shuffled);
  assert.ok(lines[0].box.y0 < lines[1].box.y0);
});

test("an unmatched word inherits the line its neighbours are on", () => {
  const words = twoLines();
  words[1].box = null;
  words[1].ocrIndex = null;

  const lines = clusterLineRuns(words);
  const filled = inheritBoxes(words, lines);

  assert.ok(filled[1].box, "a word between two boxed neighbours is not left unpaintable");
  assert.equal(filled[1].box!.y0, lines[0].box.y0, "and it sits on their line, not somewhere else");
});

test("a word range spanning two lines yields both strokes, clipped to the range", () => {
  const lines = clusterLineRuns(twoLines());
  const runs = runsForRange(lines, 1, 4);

  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].wordIndices, [1, 2], "line one contributes only the words in range");
  assert.deepEqual(runs[1].wordIndices, [3, 4]);
  // With real (non-uniform) word boxes, these are now exact rather than
  // interpolated: x0 is word 1's own x0, and x1 (below) is word 2's own x1.
  assert.equal(runs[0].box.x0, 100, "the stroke starts at the first word IN RANGE, not the line start");
  assert.equal(runs[0].box.x1, 270, "and ends at the last word in range's own x1, not the line end");
});

test("a range with no boxes at all yields nothing rather than throwing", () => {
  const bare: AlignedWord[] = [{ visionIndex: 0, word: "x", ocrIndex: null, box: null }];
  assert.deepEqual(clusterLineRuns(bare), []);
  assert.deepEqual(runsForRange([], 0, 5), []);
});

// --- Beyond the brief's five: what a real photographed page produces. ---

test("a range covering only part of a single line hulls the real boxes in range, not an equal division", () => {
  // Deliberately non-uniform word widths, proportional to real type: a narrow
  // word, a very wide one, then two more narrow ones. If runsForRange divided
  // the line's total width evenly by word count (the brief's original,
  // ruled-out approach), the stroke for words 1..2 would start at
  // 10 + 1*((400-10)/4) = 107.5, not at word 1's real x0 of 65.
  const line: AlignedWord[] = [
    { visionIndex: 0, word: "a", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 60, y1: 40 } },
    { visionIndex: 1, word: "extraordinarily", ocrIndex: 1, box: { x0: 65, y0: 0, x1: 300, y1: 40 } },
    { visionIndex: 2, word: "is", ocrIndex: 2, box: { x0: 305, y0: 0, x1: 340, y1: 40 } },
    { visionIndex: 3, word: "great", ocrIndex: 3, box: { x0: 345, y0: 0, x1: 400, y1: 40 } },
  ];

  const lines = clusterLineRuns(line);
  assert.equal(lines.length, 1);

  const runs = runsForRange(lines, 1, 2);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].wordIndices, [1, 2]);
  assert.equal(runs[0].box.x0, 65, "starts at word 1's real x0");
  assert.equal(runs[0].box.x1, 340, "ends at word 2's real x1");
});

test("a range spanning three or more lines yields one clipped stroke per line", () => {
  const threeLines: AlignedWord[] = [
    { visionIndex: 0, word: "a", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "b", ocrIndex: 1, box: { x0: 100, y0: 0, x1: 180, y1: 40 } },
    { visionIndex: 2, word: "c", ocrIndex: 2, box: { x0: 190, y0: 0, x1: 270, y1: 40 } },
    { visionIndex: 3, word: "d", ocrIndex: 3, box: { x0: 10, y0: 60, x1: 90, y1: 100 } },
    { visionIndex: 4, word: "e", ocrIndex: 4, box: { x0: 100, y0: 60, x1: 180, y1: 100 } },
    { visionIndex: 5, word: "f", ocrIndex: 5, box: { x0: 190, y0: 60, x1: 270, y1: 100 } },
    { visionIndex: 6, word: "g", ocrIndex: 6, box: { x0: 10, y0: 120, x1: 90, y1: 160 } },
    { visionIndex: 7, word: "h", ocrIndex: 7, box: { x0: 100, y0: 120, x1: 180, y1: 160 } },
    { visionIndex: 8, word: "i", ocrIndex: 8, box: { x0: 190, y0: 120, x1: 270, y1: 160 } },
  ];

  const lines = clusterLineRuns(threeLines);
  assert.equal(lines.length, 3);

  // Range starts mid-line-one (word 2) and ends mid-line-three (word 7).
  const runs = runsForRange(lines, 2, 7);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].wordIndices, [2], "only the last word of line one is in range");
  assert.deepEqual(runs[1].wordIndices, [3, 4, 5], "line two is fully in range");
  assert.deepEqual(runs[2].wordIndices, [6, 7], "only the first two words of line three are in range");
  assert.equal(runs[0].box.x0, 190);
  assert.equal(runs[2].box.x1, 180);
});

test("a line whose first or last word is unboxed keeps that word null — no guessing outward", () => {
  const words: AlignedWord[] = [
    { visionIndex: 0, word: "first", ocrIndex: null, box: null },
    { visionIndex: 1, word: "middle", ocrIndex: 0, box: { x0: 100, y0: 0, x1: 180, y1: 40 } },
    { visionIndex: 2, word: "last", ocrIndex: null, box: null },
  ];

  const lines = clusterLineRuns(words);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].wordIndices, [1], "the unboxed edge words never entered the line run");

  const filled = inheritBoxes(words, lines);
  assert.equal(filled[0].box, null, "no left neighbour to interpolate from — stays null");
  assert.equal(filled[2].box, null, "no right neighbour to interpolate from — stays null");

  // Re-clustering the (unchanged) result still excludes them.
  const relines = clusterLineRuns(filled);
  assert.deepEqual(relines[0].wordIndices, [1]);
});

test("re-clustering after inheritBoxes folds the inherited box into wordBoxes, so runsForRange can hull it too", () => {
  // This is the intended two-step pipeline: cluster once so inheritBoxes knows
  // each line's vertical extent, fill in the gaps, then cluster again so the
  // resulting LineRuns' wordBoxes include the newly-boxed word. Skipping the
  // second cluster leaves a stroke that silently omits a mid-range word's
  // real geometry from the hull.
  const words = twoLines();
  words[1].box = null;
  words[1].ocrIndex = null;

  const firstPass = clusterLineRuns(words);
  const filled = inheritBoxes(words, firstPass);
  const lines = clusterLineRuns(filled);

  assert.deepEqual(lines[0].wordIndices, [0, 1, 2], "the inherited word rejoins its line");

  const inheritedBox = lines[0].wordBoxes[1];
  assert.equal(inheritedBox.x0, 90, "interpolated from word 0's real x1");
  assert.equal(inheritedBox.x1, 190, "interpolated from word 2's real x0");

  // A range covering only the inherited word hulls its own inherited box —
  // not the whole line and not a guess.
  const runs = runsForRange(lines, 1, 1);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].box, inheritedBox);
});

test("two-column pages do not cluster correctly — same-baseline rows across the gutter merge into one stroke", () => {
  // Clustering groups purely on vertical centre. A two-column layout (e.g. a
  // dictionary or reference page) commonly has a row in the left column and
  // a row in the right column sitting at the very same baseline, separated
  // by a wide empty gutter rather than a vertical offset. This function has
  // no notion of columns, so it merges them into a single "line" whose hull
  // spans the gutter — which would paint a highlight stroke bridging two
  // unrelated columns. This is a real limitation, not a hypothetical: any
  // two-column source page will trigger it. It would need explicit
  // column-detection (e.g. splitting on a large horizontal gap before
  // clustering) to handle correctly, which is out of scope for this task.
  const twoColumn: AlignedWord[] = [
    { visionIndex: 0, word: "left", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "column", ocrIndex: 1, box: { x0: 100, y0: 0, x1: 180, y1: 40 } },
    { visionIndex: 2, word: "right", ocrIndex: 2, box: { x0: 500, y0: 1, x1: 580, y1: 41 } },
    { visionIndex: 3, word: "column", ocrIndex: 3, box: { x0: 590, y0: 0, x1: 670, y1: 40 } },
  ];

  const lines = clusterLineRuns(twoColumn);

  assert.equal(lines.length, 1, "documenting the merge: two columns become one line run");
  assert.deepEqual(lines[0].wordIndices, [0, 1, 2, 3]);
  assert.equal(lines[0].box.x0, 10);
  assert.equal(lines[0].box.x1, 670, "the hull spans the gutter between columns");
});
