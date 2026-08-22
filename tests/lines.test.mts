import test from "node:test";
import assert from "node:assert/strict";
import { clusterLineRuns, inheritBoxes, runsForRange, buildLineRuns } from "../src/lib/ingest/lines";
import type { AlignedWord } from "../src/lib/ingest/align";
import type { Box } from "../src/lib/ingest/ocr";

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

test("a dropped run is recognized as known data loss and never split, no matter how narrow the page is", () => {
  // This is the fix for a real gap the gutter split otherwise had: a gap
  // between two boxed words is exempt from the gutter test entirely when
  // every vision-index slot between them is present in the input but
  // unboxed — that's not page structure, it's data loss `aligned` already
  // told us about. Proven here on a deliberately TINY page (a 3-word line,
  // 260px total) with a 2-word dropped run, which the pixel-only version of
  // this heuristic (median-gap + block-fraction alone) got wrong: on a page
  // this narrow, a dropped run's inflated neighbour-gap is a huge fraction
  // of the whole block, and would misread as a gutter on pixels alone.
  const words: AlignedWord[] = [
    { visionIndex: 0, word: "before", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "one", ocrIndex: null, box: null },
    { visionIndex: 2, word: "two", ocrIndex: null, box: null },
    { visionIndex: 3, word: "after", ocrIndex: 3, box: { x0: 190, y0: 0, x1: 270, y1: 40 } },
  ];

  const lines = clusterLineRuns(words);

  assert.equal(lines.length, 1, "the dropped run must not read as a gutter, however narrow the page");
  assert.deepEqual(lines[0].wordIndices, [0, 3]);
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

test("two-column pages: the gutter split stops a stroke bridging the gutter, but line order is still not reading order", () => {
  // Clustering groups purely on vertical centre. A two-column layout (e.g. a
  // dictionary or reference page) commonly has a row in the left column and
  // a row in the right column sitting at the very same baseline, separated
  // by a wide empty gutter rather than a vertical offset. The gutter split
  // (requiring both a large-relative-to-typical-gap AND a large-relative-to-
  // block-width signal) now stops those two rows' hull from bridging that
  // gutter into one stroke.
  //
  // What it does NOT do: reorder lines into column-major reading order. Two
  // rows of a two-column page still come out row-major (left row 1, right
  // row 1, left row 2, right row 2) rather than column-major (all of the
  // left column, then all of the right column) — a real, separate gap,
  // documented here rather than hidden.
  const twoColumnTwoRows: AlignedWord[] = [
    // Row 1: left column, then right column, same baseline.
    { visionIndex: 0, word: "left", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "column", ocrIndex: 1, box: { x0: 100, y0: 0, x1: 180, y1: 40 } },
    { visionIndex: 2, word: "right", ocrIndex: 2, box: { x0: 500, y0: 1, x1: 580, y1: 41 } },
    { visionIndex: 3, word: "column", ocrIndex: 3, box: { x0: 590, y0: 0, x1: 670, y1: 40 } },
    // Row 2: same layout, lower on the page.
    { visionIndex: 4, word: "second", ocrIndex: 4, box: { x0: 10, y0: 60, x1: 90, y1: 100 } },
    { visionIndex: 5, word: "row", ocrIndex: 5, box: { x0: 100, y0: 60, x1: 180, y1: 100 } },
    { visionIndex: 6, word: "second", ocrIndex: 6, box: { x0: 500, y0: 61, x1: 580, y1: 101 } },
    { visionIndex: 7, word: "row", ocrIndex: 7, box: { x0: 590, y0: 60, x1: 670, y1: 100 } },
  ];

  const lines = clusterLineRuns(twoColumnTwoRows);

  assert.equal(lines.length, 4, "each row now yields two lines, one per column, not one bridging both");
  assert.deepEqual(lines[0].wordIndices, [0, 1], "row one, left column");
  assert.deepEqual(lines[1].wordIndices, [2, 3], "row one, right column");
  assert.deepEqual(lines[2].wordIndices, [4, 5], "row two, left column");
  assert.deepEqual(lines[3].wordIndices, [6, 7], "row two, right column");
  assert.equal(lines[0].box.x1, 180, "left column's stroke stays inside the left column");
  assert.equal(lines[1].box.x0, 500, "right column's stroke does not start until the right column");

  // Documenting the remaining gap: this is row-major order, not the
  // column-major reading order a two-column page actually needs.
  assert.deepEqual(
    lines.map((l) => l.wordIndices[0]),
    [0, 2, 4, 6],
    "order is row-major (left, right, left, right) — not column-major reading order",
  );
});

// --- FINDING 3 / FINDING 5: the gutter split needs two signals, not one,
// validated across all four classes: justified text (below), dialogue with
// an em-dash (below), a modest real gutter, and a wide real gutter (the
// existing two-column test above). Real numbers for all four are in the
// report. ---

test("Class A: a short justified line's stretched inter-word gap does not trigger the gutter split", () => {
  // The one input class that genuinely resembles a gutter is justified text,
  // where the last gap on a short line is stretched to fill the margin. A
  // real gutter is typically as wide as a whole word or more; ordinary
  // justification stretch is nowhere near that.
  //
  // Measured: gaps are 10, 10, 40. Median gap = 10, so signal 1's threshold
  // is 10*5 = 50 — the 40px stretch (4x normal, a generous stretch) stays
  // under it. Block width = 380, so signal 2's threshold is 380*0.08 = 30.4
  // — 40 would clear THIS one alone, which is exactly why both signals are
  // required: signal 1 alone correctly vetoes the split here.
  const justifiedLine: AlignedWord[] = [
    { visionIndex: 0, word: "a", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "short", ocrIndex: 1, box: { x0: 100, y0: 0, x1: 180, y1: 40 } },
    { visionIndex: 2, word: "line", ocrIndex: 2, box: { x0: 190, y0: 0, x1: 270, y1: 40 } },
    // Justification stretches this gap to reach the right margin.
    { visionIndex: 3, word: "here", ocrIndex: 3, box: { x0: 310, y0: 0, x1: 390, y1: 40 } },
  ];

  const lines = clusterLineRuns(justifiedLine);

  assert.equal(lines.length, 1, "the stretched gap must not split the justified line in two");
  assert.deepEqual(lines[0].wordIndices, [0, 1, 2, 3]);
  assert.equal(lines[0].box.x1, 390);
});

test("Class B: short-word dialogue with an em-dash-scale gap does not trigger the gutter split", () => {
  // This is the case that broke under the word-width anchor: short words
  // ("I", "am") shrink median word WIDTH but not the space between them, so
  // a width-anchored threshold shrinks along with the words and an ordinary
  // em-dash-scale gap ends up looking huge by comparison. Anchoring to
  // median GAP instead of median word width fixes that directly.
  //
  // 40 words, 12px wide, normal 6px gaps, with one 45px em-dash-scale gap
  // (word count chosen to give a realistically wide block — a handful of
  // short words alone would make even a modest stretch look huge in
  // isolation, which would be an artifact of the fixture, not of real text).
  //
  // Measured: median gap = 6, so signal 1's threshold is 6*5 = 30 — the 45px
  // gap DOES clear this (45 > 30), reproducing the reviewer's false-positive
  // report if this were the only signal. Block width = 753, so signal 2's
  // threshold is 753*0.08 = 60.24 — 45 does NOT clear this. Requiring both
  // signals is exactly what saves this case.
  const words: AlignedWord[] = [];
  let x = 10;
  const EM_DASH_AFTER_WORD = 20;
  for (let i = 0; i < 40; i++) {
    words.push({
      visionIndex: i,
      word: i % 2 === 0 ? "I" : "am",
      ocrIndex: i,
      box: { x0: x, y0: 0, x1: x + 12, y1: 20 },
    });
    x += 12 + (i === EM_DASH_AFTER_WORD ? 45 : 6);
  }

  const lines = clusterLineRuns(words);

  assert.equal(lines.length, 1, "the em-dash-scale gap must not split an ordinary dialogue line");
  assert.equal(lines[0].wordIndices.length, 40);
});

test("Class C: a modest gutter roughly one word's width still triggers the gutter split", () => {
  // The finding's own framing: a real gutter is "typically as wide as a
  // whole word or more". This is the failure the width-anchored threshold
  // missed in the other direction — a 2x-median-width threshold refused to
  // split at exactly this scale. The gap-and-block-fraction anchor must
  // still catch it.
  //
  // Two columns of four 80px words each, separated by an 80px gutter (1x the
  // page's own word width). Measured: median gap = 10 (the ordinary 10px
  // in-column gaps dominate), so signal 1's threshold is 10*5 = 50 — 80
  // clears it. Block width = 780, so signal 2's threshold is 780*0.08 = 62.4
  // — 80 clears that too. Both signals agree: split.
  const words: AlignedWord[] = [
    { visionIndex: 0, word: "left", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "col", ocrIndex: 1, box: { x0: 100, y0: 0, x1: 180, y1: 40 } },
    { visionIndex: 2, word: "words", ocrIndex: 2, box: { x0: 190, y0: 0, x1: 270, y1: 40 } },
    { visionIndex: 3, word: "here", ocrIndex: 3, box: { x0: 280, y0: 0, x1: 360, y1: 40 } },
    { visionIndex: 4, word: "right", ocrIndex: 4, box: { x0: 440, y0: 0, x1: 520, y1: 40 } },
    { visionIndex: 5, word: "col", ocrIndex: 5, box: { x0: 530, y0: 0, x1: 610, y1: 40 } },
    { visionIndex: 6, word: "words", ocrIndex: 6, box: { x0: 620, y0: 0, x1: 700, y1: 40 } },
    { visionIndex: 7, word: "here", ocrIndex: 7, box: { x0: 710, y0: 0, x1: 790, y1: 40 } },
  ];

  const lines = clusterLineRuns(words);

  assert.equal(lines.length, 2, "a modest, roughly-one-word-wide gutter must still split");
  assert.deepEqual(lines[0].wordIndices, [0, 1, 2, 3]);
  assert.deepEqual(lines[1].wordIndices, [4, 5, 6, 7]);
});

// --- FINDING 1: a run of consecutive unboxed words must not all claim the
// identical full gap between their outer neighbours. ---

test("two consecutive unboxed words divide their gap proportionally to character count, not identically", () => {
  // Boundary words are 80px wide (this file's usual word scale) with a 140px
  // gap between them. The dropped run in between is fully present in the
  // input (as unboxed entries), so clusterLineRuns recognizes this gap as
  // known data loss and never treats it as a candidate gutter at all — see
  // "a dropped run is recognized as known data loss..." above.
  const words: AlignedWord[] = [
    { visionIndex: 0, word: "I", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "extraordinarily", ocrIndex: null, box: null }, // 15 chars
    { visionIndex: 2, word: "am", ocrIndex: null, box: null }, // 2 chars
    { visionIndex: 3, word: "great", ocrIndex: 3, box: { x0: 230, y0: 0, x1: 310, y1: 40 } },
  ];

  const lines = clusterLineRuns(words);
  assert.equal(lines.length, 1, "the run's neighbours stay on one line, not split as a false gutter");

  const filled = inheritBoxes(words, lines);

  const b1 = filled[1].box!;
  const b2 = filled[2].box!;
  assert.ok(b1, "word 1 gets a box");
  assert.ok(b2, "word 2 gets a box");

  // Not identical — the bug this fixes gave both the full {x0:90, x1:230} gap.
  assert.notDeepEqual(b1, b2);

  // Contiguous and non-overlapping: word 1 ends exactly where word 2 starts.
  assert.ok(Math.abs(b1.x1 - b2.x0) < 1e-9, "the two slices tile the gap with no gap or overlap between them");
  assert.ok(Math.abs(b1.x0 - 90) < 1e-9, "the run starts exactly at the left neighbour's x1");
  assert.ok(Math.abs(b2.x1 - 230) < 1e-9, "the run ends exactly at the right neighbour's x0");

  // Proportional to character count: "extraordinarily" (15 chars) gets a much
  // larger share of the 140px gap than "am" (2 chars).
  const share1 = b1.x1 - b1.x0;
  const share2 = b2.x1 - b2.x0;
  assert.ok(share1 > share2 * 5, "the longer word claims proportionally more of the gap");
  assert.ok(Math.abs(share1 + share2 - 140) < 1e-9, "the two shares exactly fill the 140px gap");
});

test("a three-word unboxed run divides its gap into three non-overlapping, proportional slices", () => {
  // Same reasoning as above: the dropped run is fully present as unboxed
  // entries, so this gap is recognized as known data loss and never treated
  // as a candidate gutter.
  const words: AlignedWord[] = [
    { visionIndex: 0, word: "start", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "a", ocrIndex: null, box: null }, // 1 char
    { visionIndex: 2, word: "middle", ocrIndex: null, box: null }, // 6 chars
    { visionIndex: 3, word: "b", ocrIndex: null, box: null }, // 1 char
    { visionIndex: 4, word: "end", ocrIndex: 4, box: { x0: 190, y0: 0, x1: 270, y1: 40 } },
  ];

  const lines = clusterLineRuns(words);
  assert.equal(lines.length, 1, "the run's neighbours stay on one line, not split as a false gutter");

  const filled = inheritBoxes(words, lines);

  const boxes = [filled[1].box!, filled[2].box!, filled[3].box!];
  assert.ok(boxes.every(Boolean), "all three words in the run get a box");

  // Contiguous chain from the left neighbour's x1 to the right neighbour's x0.
  assert.ok(Math.abs(boxes[0].x0 - 90) < 1e-9);
  assert.ok(Math.abs(boxes[0].x1 - boxes[1].x0) < 1e-9, "word 1 to word 2: no gap, no overlap");
  assert.ok(Math.abs(boxes[1].x1 - boxes[2].x0) < 1e-9, "word 2 to word 3: no gap, no overlap");
  assert.ok(Math.abs(boxes[2].x1 - 190) < 1e-9);

  // The middle word ("middle", 6 chars) gets a bigger share than either
  // 1-character neighbour in the run.
  const share = (b: Box) => b.x1 - b.x0;
  assert.ok(share(boxes[1]) > share(boxes[0]));
  assert.ok(share(boxes[1]) > share(boxes[2]));
});

// --- FINDING 2: skipping the re-cluster step after inheritBoxes fails
// silently in two ways; buildLineRuns avoids both. ---

test("skipping the re-cluster step reproduces both documented failure shapes; buildLineRuns avoids them", () => {
  const words = twoLines();
  words[1].box = null;
  words[1].ocrIndex = null;

  // The natural-but-wrong sequence: cluster, inherit, then keep using the
  // FIRST-PASS lines instead of re-clustering.
  const staleLines = clusterLineRuns(words);
  inheritBoxes(words, staleLines);

  // Failure shape 1: the inherited word's own range vanishes entirely.
  assert.deepEqual(
    runsForRange(staleLines, 1, 1),
    [],
    "with stale lines, word 1's own range yields nothing — indistinguishable from 'out of range'",
  );

  // Failure shape 2: a wider range looks fine but silently drops the index.
  const staleFull = runsForRange(staleLines, 0, 2);
  assert.deepEqual(
    staleFull[0].wordIndices,
    [0, 2],
    "index 1 is silently missing even though inheritBoxes gave it a real box",
  );

  // buildLineRuns does the required second cluster internally, so neither
  // failure shape occurs.
  const { lines } = buildLineRuns(words);
  assert.equal(runsForRange(lines, 1, 1).length, 1, "word 1's own range now yields a stroke");
  assert.deepEqual(
    runsForRange(lines, 0, 2)[0].wordIndices,
    [0, 1, 2],
    "the inherited word's index is present",
  );
});
