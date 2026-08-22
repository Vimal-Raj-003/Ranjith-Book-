import test from "node:test";
import assert from "node:assert/strict";
import { sweepForBeat, cameraTrack } from "../src/lib/video/sweep";
import type { LineRun } from "../src/lib/ingest/lines";

// Two lines, 3 words then 7 words. wordBoxes are hand-built so that each
// line's hull (its `box`) equals the union of its own wordBoxes — asserting
// against geometry that could not actually occur (an interpolated, uniform
// per-word width) would defeat the point of carrying real boxes at all.
const lines: LineRun[] = [
  {
    box: { x0: 0, y0: 0, x1: 300, y1: 40 },
    wordIndices: [0, 1, 2],
    wordBoxes: [
      { x0: 0, y0: 0, x1: 100, y1: 40 },
      { x0: 100, y0: 0, x1: 200, y1: 40 },
      { x0: 200, y0: 0, x1: 300, y1: 40 },
    ],
  },
  {
    box: { x0: 0, y0: 60, x1: 300, y1: 100 },
    wordIndices: [3, 4, 5, 6, 7, 8, 9],
    wordBoxes: [
      { x0: 0, y0: 60, x1: 30, y1: 100 },
      { x0: 30, y0: 60, x1: 80, y1: 100 },
      { x0: 80, y0: 60, x1: 120, y1: 100 },
      { x0: 120, y0: 60, x1: 155, y1: 100 },
      { x0: 155, y0: 60, x1: 200, y1: 100 },
      { x0: 200, y0: 60, x1: 260, y1: 100 },
      { x0: 260, y0: 60, x1: 300, y1: 100 },
    ],
  },
];

test("the sweep starts when the beat starts and finishes when it finishes", () => {
  const steps = sweepForBeat(lines, 0, 9, 2, 6);

  assert.equal(steps[0].start, 2);
  assert.equal(steps[steps.length - 1].end, 6, "the marker must not still be moving in silence");
});

test("time is shared between lines in proportion to their words, not evenly", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 10);

  assert.equal(steps.length, 2);
  const first = steps[0].end - steps[0].start;
  const second = steps[1].end - steps[1].start;

  assert.ok(Math.abs(first - 3) < 0.01, `3 of 10 words should take ~3s, got ${first}`);
  assert.ok(Math.abs(second - 7) < 0.01, `7 of 10 words should take ~7s, got ${second}`);
});

test("steps are contiguous — no gap where the marker sits still mid-sentence", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 10);
  assert.equal(steps[0].end, steps[1].start);
});

test("a beat whose words have no geometry yields no sweep rather than a wrong one", () => {
  assert.deepEqual(sweepForBeat(lines, 40, 50, 0, 5), []);
  assert.deepEqual(sweepForBeat([], 0, 5, 0, 5), []);
});

test("the camera keeps the active stroke inside the middle third, unless it is clamped at a limit", () => {
  // A stroke near the very top and one thousands of pixels below on a page
  // much taller than the frame: the first key cannot be centred (nothing
  // above y=0 to scroll into view), so it must sit at the top clamp instead.
  const tall: LineRun[] = [
    { box: { x0: 0, y0: 100, x1: 300, y1: 140 }, wordIndices: [0], wordBoxes: [{ x0: 0, y0: 100, x1: 300, y1: 140 }] },
    {
      box: { x0: 0, y0: 3000, x1: 300, y1: 3040 },
      wordIndices: [1],
      wordBoxes: [{ x0: 0, y0: 3000, x1: 300, y1: 3040 }],
    },
  ];
  const steps = sweepForBeat(tall, 0, 1, 0, 4);
  const track = cameraTrack(steps, 1920, 4000);
  const maxY = 4000 - 1920;

  // Pair keys with steps by index rather than by searching `steps` for one
  // whose [start, end] contains a key's `t`: cameraTrack emits exactly two
  // keys per step, in order, and adjacent steps share a boundary `t` — a
  // time-range lookup at that shared instant cannot tell which step's key
  // it found, and can silently grab the wrong step's box.
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const centre = (step.box.y0 + step.box.y1) / 2;
    for (const key of [track[2 * i], track[2 * i + 1]]) {
      const onScreen = centre - key.y;
      const inMiddleThird = onScreen > 1920 / 3 - 1 && onScreen < (1920 * 2) / 3 + 1;
      const atALimit = Math.abs(key.y - 0) < 1e-9 || Math.abs(key.y - maxY) < 1e-9;
      assert.ok(
        inMiddleThird || atALimit,
        `stroke at ${onScreen} is outside the middle third at t=${key.t}, and the camera (y=${key.y}) is not at either limit (0 or ${maxY})`,
      );
    }
  }

  // And the invariant isn't vacuous: the first key (the near-top stroke) must
  // actually BE clamped, not just excused by a loose assertion.
  assert.equal(track[0].y, 0, "the top stroke cannot be centred; the camera sits at the top of the page");
});

test("the camera never scrolls past the ends of the page", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 4);
  const track = cameraTrack(steps, 1920, 2400);

  for (const key of track) {
    assert.ok(key.y >= 0, "never above the top of the page");
    assert.ok(key.y <= 2400 - 1920, "never below the bottom");
  }
});

// --- Beyond the brief's six: what real audio and real pages produce. ---

test("zero-length speech (a TTS failure) produces no NaN and no negative-duration step", () => {
  const steps = sweepForBeat(lines, 0, 9, 5, 5);

  assert.ok(steps.length > 0, "geometry still exists, so strokes are still produced");
  for (const step of steps) {
    assert.ok(Number.isFinite(step.start) && Number.isFinite(step.end), "no NaN/Infinity");
    assert.ok(step.end - step.start >= 0, "no negative duration");
  }
  assert.equal(steps[0].start, 5);
  assert.equal(steps[steps.length - 1].end, 5);

  // The camera must survive this too: a degenerate (zero-length) step still
  // produces two coincident keys, not a divide-by-zero or a NaN y.
  const track = cameraTrack(steps, 1920, 4000);
  for (const key of track) assert.ok(Number.isFinite(key.y));
});

test("a beat covering exactly one word yields exactly one stroke spanning the whole window", () => {
  // Word 4 alone, in the middle of the seven-word second line.
  const steps = sweepForBeat(lines, 4, 4, 1, 3);

  assert.equal(steps.length, 1);
  assert.equal(steps[0].start, 1);
  assert.equal(steps[0].end, 3);
  assert.deepEqual(steps[0].box, { x0: 30, y0: 60, x1: 80, y1: 100 }, "hull of the single word in range");
});

test("strokes never overlap in time, and the sequence is gapless end-to-end", () => {
  const threeLines: LineRun[] = [
    { box: { x0: 0, y0: 0, x1: 100, y1: 40 }, wordIndices: [0, 1], wordBoxes: [{ x0: 0, y0: 0, x1: 50, y1: 40 }, { x0: 50, y0: 0, x1: 100, y1: 40 }] },
    { box: { x0: 0, y0: 60, x1: 100, y1: 100 }, wordIndices: [2, 3, 4], wordBoxes: [{ x0: 0, y0: 60, x1: 30, y1: 100 }, { x0: 30, y0: 60, x1: 70, y1: 100 }, { x0: 70, y0: 60, x1: 100, y1: 100 }] },
    { box: { x0: 0, y0: 120, x1: 100, y1: 160 }, wordIndices: [5], wordBoxes: [{ x0: 0, y0: 120, x1: 100, y1: 160 }] },
  ];

  const steps = sweepForBeat(threeLines, 0, 5, 10, 22);
  assert.equal(steps.length, 3);

  for (let i = 0; i < steps.length; i++) {
    assert.ok(steps[i].end >= steps[i].start, `step ${i} has non-negative duration`);
    if (i > 0) {
      assert.equal(steps[i - 1].end, steps[i].start, `step ${i} starts exactly where step ${i - 1} ends — no gap, no overlap`);
    }
  }
  assert.equal(steps[0].start, 10);
  assert.equal(steps[steps.length - 1].end, 22);
});

test("a page shorter than the frame clamps the camera flat at the top (pageHeight - frameHeight is negative)", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 4);
  // The page photograph is only 300px tall, far shorter than a 1920px frame.
  const track = cameraTrack(steps, 1920, 300);

  for (const key of track) {
    assert.equal(key.y, 0, "with nowhere to scroll, the camera sits at the top for the whole page");
  }
});

test("a beat cannot span a page boundary in a single call — LineRun word indices are page-local", () => {
  // `lines` here carries no page identifier, and vision-model word indices
  // reset to 0 on every photographed page (see align.ts / vision.ts). So two
  // different pages can — and ordinarily do — reuse the same small integers
  // for their own first few words. A single (startWord, endWord) pair against
  // a single `lines` array can only ever mean "these words on THIS page";
  // there is no way to name "the last two words of page A through the first
  // word of page B" in one call, because "word 0" is ambiguous without
  // knowing which page's `lines` it's being resolved against.
  const pageALines: LineRun[] = [
    {
      box: { x0: 0, y0: 900, x1: 300, y1: 940 },
      wordIndices: [0, 1, 2],
      wordBoxes: [
        { x0: 0, y0: 900, x1: 100, y1: 940 },
        { x0: 100, y0: 900, x1: 200, y1: 940 },
        { x0: 200, y0: 900, x1: 300, y1: 940 },
      ],
    },
  ];
  const pageBLines: LineRun[] = [
    {
      box: { x0: 0, y0: 0, x1: 300, y1: 40 },
      wordIndices: [0, 1, 2],
      wordBoxes: [
        { x0: 0, y0: 0, x1: 100, y1: 40 },
        { x0: 100, y0: 0, x1: 200, y1: 40 },
        { x0: 200, y0: 0, x1: 300, y1: 40 },
      ],
    },
  ];

  // A caller that needs to cross this boundary has to detect it itself, split
  // the beat's word range into one page-local sub-range per page, split the
  // timing window proportionally by word count (5 of the beat's 8 words are
  // on page A, 3 on page B), and call sweepForBeat once per page.
  const beatSpeechStart = 0;
  const beatSpeechEnd = 8; // 1s/word for round numbers below
  const totalBeatWords = 5 + 3;
  const splitAt = beatSpeechStart + (5 / totalBeatWords) * (beatSpeechEnd - beatSpeechStart);

  const pageASteps = sweepForBeat(pageALines, 0, 2, beatSpeechStart, splitAt);
  const pageBSteps = sweepForBeat(pageBLines, 0, 1, splitAt, beatSpeechEnd);

  assert.ok(pageASteps.length > 0 && pageBSteps.length > 0, "both halves produce strokes");
  assert.equal(
    pageASteps[pageASteps.length - 1].end,
    pageBSteps[0].start,
    "the caller-assembled sequence is contiguous across the page boundary, exactly like within one page",
  );
  assert.equal(pageASteps[0].start, beatSpeechStart);
  assert.equal(pageBSteps[pageBSteps.length - 1].end, beatSpeechEnd);
});

// --- Review findings: non-finite and inverted windows must not reach output. ---

test("a NaN speechStart (a corrupted TTS render's NaN duration) yields no strokes, not NaN timestamps", () => {
  const steps = sweepForBeat(lines, 0, 9, NaN, 6);
  assert.deepEqual(steps, [], "unmeasurable audio has no honest timing, so no stroke is emitted");
});

test("a NaN speechEnd yields no strokes, not NaN timestamps", () => {
  const steps = sweepForBeat(lines, 0, 9, 2, NaN);
  assert.deepEqual(steps, [], "unmeasurable audio has no honest timing, so no stroke is emitted");
});

test("an Infinite window yields no strokes", () => {
  assert.deepEqual(sweepForBeat(lines, 0, 9, 0, Infinity), []);
  assert.deepEqual(sweepForBeat(lines, 0, 9, -Infinity, 6), []);
});

test("cameraTrack never emits a NaN y even if fed NaN steps directly", () => {
  const nanSteps = [{ box: { x0: 0, y0: NaN, x1: 300, y1: 40 }, start: NaN, end: 6 }];
  const track = cameraTrack(nanSteps, 1920, 4000);
  assert.deepEqual(track, [], "a step with non-finite geometry or timing contributes no key");
});

test("cameraTrack returns no keys for a non-finite frame or page height", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 4);
  assert.deepEqual(cameraTrack(steps, NaN, 4000), []);
  assert.deepEqual(cameraTrack(steps, 1920, NaN), []);
  assert.deepEqual(cameraTrack(steps, Infinity, 4000), []);
});

test("an inverted window (speechEnd < speechStart) collapses to zero duration, never a negative one", () => {
  // The reviewer's repro: sweepForBeat(lines, 0, 2, 10, 4) — endWord 2 only
  // reaches into the first line, so this is a single-stroke case; assert it
  // directly against the full two-line fixture too, where the "last step
  // ends exactly on speechEnd" rule is the one that used to leak a negative
  // duration into the final step.
  const single = sweepForBeat(lines, 0, 2, 10, 4);
  assert.equal(single.length, 1);
  assert.equal(single[0].start, 10);
  assert.equal(single[0].end, 10, "collapses to the (sane) start, not the raw inverted speechEnd");
  assert.ok(single[0].end - single[0].start >= 0, "never a negative duration");

  const multi = sweepForBeat(lines, 0, 9, 10, 4);
  assert.equal(multi.length, 2);
  for (const step of multi) {
    assert.ok(Number.isFinite(step.start) && Number.isFinite(step.end));
    assert.ok(step.end - step.start >= 0, "no negative duration on any step");
  }
  assert.equal(multi[0].start, 10);
  assert.equal(multi[multi.length - 1].end, 10);

  // And the camera survives it too — no NaN, no crash.
  const track = cameraTrack(multi, 1920, 4000);
  for (const key of track) assert.ok(Number.isFinite(key.y));
});
