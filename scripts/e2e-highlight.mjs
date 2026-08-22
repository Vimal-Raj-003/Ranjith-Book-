// Highlight-accuracy harness (Task 17).
//
// Does the yellow actually land on the words? A synthetic page with known
// word positions (tests/fixtures/page-fixture.png + .json, built once by
// scripts/build-page-fixture.mjs) goes through the REAL chain — OCR,
// alignment, line clustering, sweep timing — and the resulting stroke boxes
// must cover at least 90% of the area of the word boxes they are supposed
// to be highlighting.
//
// Geometry, not pixels: the check is a box-overlap ratio in page
// coordinates, never a screenshot comparison. A pixel check would fail on
// antialiasing no viewer could ever see; this checks the thing that
// actually determines whether the marker looks right — where the box is.
import { readFile } from "node:fs/promises";
import { measurePage, disposeOcr } from "../src/lib/ingest/ocr.ts";
import { alignWords } from "../src/lib/ingest/align.ts";
import { buildLineRuns } from "../src/lib/ingest/lines.ts";
import { sweepForBeat } from "../src/lib/video/sweep.ts";

const OVERLAP_FLOOR = 0.9;
const FIXTURE_PNG = "tests/fixtures/page-fixture.png";
const FIXTURE_JSON = "tests/fixtures/page-fixture.json";

// The word range the synthetic beat "narrates" — spans a line boundary
// (words 3-5 are one line, 6-7 are the next), the same shape a real
// mid-line-to-mid-line beat produces, so the harness exercises
// `runsForRange`'s per-line clipping, not just a single whole line.
const START_WORD = 3;
const END_WORD = 7;

const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const intersect = (a, b) => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});

async function main() {
  const truth = JSON.parse(await readFile(FIXTURE_JSON, "utf8"));

  let ocr;
  try {
    ocr = await measurePage(FIXTURE_PNG);
  } catch (err) {
    console.error(`OCR failed to measure ${FIXTURE_PNG}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { aligned, confidence } = alignWords(truth.words, ocr);
  console.log(`alignment confidence ${(confidence * 100).toFixed(1)}%`);
  if (confidence < 1) {
    // The synthetic fixture is clean, high-contrast text with no ambiguity —
    // anything less than perfect alignment here means OCR or alignment
    // itself regressed, not ordinary photograph noise. Named and specific:
    // which vision words came back with no box.
    const misses = aligned.filter((w) => w.box === null).map((w) => `${w.visionIndex}:"${w.word}"`);
    console.error(
      `Alignment confidence ${(confidence * 100).toFixed(1)}% on a synthetic, noise-free fixture — expected 100%. Unmatched words: ${misses.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const { lines } = buildLineRuns(aligned);
  const steps = sweepForBeat(lines, START_WORD, END_WORD, 0, 4);
  if (steps.length === 0) {
    console.error(
      `No sweep steps produced for word range ${START_WORD}-${END_WORD}, which has known geometry in the fixture. sweepForBeat or the line clustering feeding it is broken.`,
    );
    process.exitCode = 1;
    return;
  }

  let worst = 1;
  let worstWord = -1;
  let failed = false;
  for (let w = START_WORD; w <= END_WORD; w++) {
    const target = truth.boxes[w];
    const targetArea = area(target);
    if (targetArea <= 0) {
      console.error(`Fixture word ${w} ("${truth.words[w]}") has a degenerate ground-truth box — fixture is broken.`);
      process.exitCode = 1;
      return;
    }
    const covered = steps.reduce((sum, s) => sum + area(intersect(s.box, target)), 0);
    const ratio = covered / targetArea;
    if (ratio < worst) {
      worst = ratio;
      worstWord = w;
    }
    if (ratio < OVERLAP_FLOOR) {
      failed = true;
      console.error(`word ${w} ("${truth.words[w]}") only ${(ratio * 100).toFixed(1)}% covered`);
    }
  }

  if (failed) {
    console.error(
      `\nWorst coverage ${(worst * 100).toFixed(1)}% on word ${worstWord} ("${truth.words[worstWord]}"), floor is ${OVERLAP_FLOOR * 100}%.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Every targeted word (${START_WORD}-${END_WORD}) at least ${(worst * 100).toFixed(1)}% covered.`);
}

try {
  await main();
} finally {
  // A live tesseract.js worker holds the Node event loop open; without this
  // the process hangs after printing its result instead of exiting.
  await disposeOcr();
}
