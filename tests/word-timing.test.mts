import test from "node:test";
import assert from "node:assert/strict";
import { alignTokens, timeBeat, speechSpan, soundBounds, fitToSound, snapToSound, type AsrWord } from "../src/lib/media/word-timing";
import { buildCaptionsFromWords, toSrt, PAUSE_BREAK } from "../src/lib/media/captions";
import { timedSweepForBeat, quotedAnchors, QUOTE_RUN } from "../src/lib/video/sweep";
import { timeNarration } from "../src/lib/media/narration-timing";
import type { LineRun } from "../src/lib/ingest/lines";

/** Recognised words, one every `step` seconds from `t0`, each `dur` long. */
function heard(words: string[], t0 = 1, step = 0.4, dur = 0.3): AsrWord[] {
  return words.map((w, i) => ({ word: w, start: +(t0 + i * step).toFixed(3), end: +(t0 + i * step + dur).toFixed(3), p: 0.9 }));
}
const W = { start: 0.9, end: 6 };

// --- matching ------------------------------------------------------------------

test("an exact recognition times every word from the audio", () => {
  const t = timeBeat(0, "Small habits compound over time.", heard(["small", "habits", "compound", "over", "time"]), W);
  assert.equal(t.matched, 5);
  assert.ok(t.words.every((w) => w.source === "audio"));
  assert.deepEqual(t.words.map((w) => [w.word, w.start, w.end]), [
    ["Small", 1, 1.3], ["habits", 1.4, 1.7], ["compound", 1.8, 2.1], ["over", 2.2, 2.5], ["time.", 2.6, 2.9],
  ]);
});

test("a word the recogniser dropped is placed in the real gap between its neighbours", () => {
  // "habits" and "over" were never heard.
  const t = timeBeat(0, "Small habits compound over time.", [
    { word: "small", start: 1, end: 1.3 },
    { word: "compound", start: 1.8, end: 2.1 },
    { word: "time", start: 2.6, end: 2.9 },
  ], W);
  assert.equal(t.matched, 3);
  const [small, habits, compound, over, time] = t.words;
  assert.equal(habits.source, "interpolated");
  assert.deepEqual([habits.start, habits.end], [1.3, 1.8], "exactly the silence between 'Small' and 'compound'");
  assert.equal(over.source, "interpolated");
  assert.deepEqual([over.start, over.end], [2.1, 2.6]);
  assert.equal(small.source, "audio");
  assert.equal(compound.source, "audio");
  assert.equal(time.source, "audio");
});

test("several missing words share their gap equally, in order", () => {
  const t = timeBeat(0, "one two three four five", [{ word: "one", start: 1, end: 1.2 }, { word: "five", start: 2.2, end: 2.5 }], W);
  assert.deepEqual(t.words.slice(1, 4).map((w) => [w.start, w.end].map((x) => +x.toFixed(3))), [[1.2, 1.533], [1.533, 1.867], [1.867, 2.2]]);
});

test("missing words at the edges fill back to the beat's window", () => {
  const t = timeBeat(0, "first second third", [{ word: "second", start: 2, end: 2.3 }], W);
  assert.equal(t.words[0].start, W.start);
  assert.equal(t.words[0].end, 2);
  assert.equal(t.words[2].start, 2.3);
  assert.equal(t.words[2].end, W.end);
});

test("extra words the recogniser invented (fillers, repeats) are ignored", () => {
  const t = timeBeat(0, "Habits compound", [
    { word: "uh", start: 1, end: 1.1 },
    { word: "habits", start: 1.2, end: 1.5 },
    { word: "habits", start: 1.55, end: 1.8 },
    { word: "compound", start: 1.9, end: 2.3 },
    { word: "you", start: 2.4, end: 2.5 },
  ], W);
  assert.equal(t.matched, 2);
  assert.equal(t.words[0].start, 1.2, "the first 'habits' heard is the script's");
  assert.equal(t.words[1].start, 1.9);
});

test("case, punctuation, numbers and one-letter slips still match", () => {
  assert.deepEqual(alignTokens(["It's", "1,900", "years—old.", "philosophy"], ["its", "1900", "years", "philosphy"]), [0, 1, null, 3]);
  assert.deepEqual(alignTokens(["cat"], ["cut"]), [null], "short words must match exactly");
});

test("recognised times outside the beat are clamped into it, and times never run backwards", () => {
  const t = timeBeat(0, "a b c", [
    { word: "a", start: 0.2, end: 1.0 },
    { word: "b", start: 0.95, end: 1.2 },
    { word: "c", start: 5.5, end: 9 },
  ], W);
  for (const w of t.words) {
    assert.ok(w.start >= W.start && w.end <= W.end, `${w.word} inside the window`);
    assert.ok(w.end >= w.start);
  }
  for (let i = 1; i < t.words.length; i++) assert.ok(t.words[i].start >= t.words[i - 1].end - 1e-9);
});

test("a beat with nothing recognised is marked estimated, never audio", () => {
  const t = timeBeat(3, "nothing here matched", heard(["zzz", "qqq"]), W);
  assert.equal(t.matched, 0);
  assert.ok(t.words.every((w) => w.source === "estimated" && w.beatIndex === 3));
  assert.equal(t.words[0].start, W.start);
  assert.equal(t.words[2].end, W.end);
  assert.deepEqual(speechSpan(t.words), { start: W.start, end: W.end });
});

// --- correcting edges against measured silence ------------------------------------

const tw = (word: string, start: number, end: number, index: number) => ({ word, start, end, beatIndex: 0, index, source: "audio" as const });

test("sound bounds skip the lead-in silence and a click at the edge", () => {
  // Window 0–5 s; a click at 0–0.08, silence 0.08–0.45, speech, silence 4.2–5.
  const quiet = [{ start: 0.08, end: 0.45 }, { start: 4.2, end: 5 }];
  assert.deepEqual(soundBounds({ start: 0, end: 5 }, quiet), { start: 0.45, end: 4.2 });
  assert.equal(soundBounds({ start: 0, end: 1 }, [{ start: 0, end: 1 }]), null, "a window of pure silence has no sound");
});

test("only the beat's first and last edges move to the measured sound; the interior keeps the recogniser's times", () => {
  // Whisper pinned the first word early and ended the last one early.
  const words = [tw("A", 4.21, 4.99, 0), tw("page", 4.99, 5.19, 1), tw("says", 5.2, 5.5, 2), tw("so.", 5.6, 6.0, 3)];
  const fitted = fitToSound(words, { start: 4.47, end: 6.3 });
  assert.deepEqual(fitted.map((w) => [w.start, w.end]), [[4.47, 4.99], [4.99, 5.19], [5.2, 5.5], [5.6, 6.3]]);
  assert.equal(words[0].start, 4.21, "the input is not mutated");
  assert.deepEqual(fitToSound(words, { start: 9, end: 12 }).map((w) => w.start), [4.21, 4.99, 5.2, 5.6], "an edge more than 1.5 s away is not moved");
  // Measured on a real beat: the first word pinned 1.01 s before the voice, at the window start.
  assert.equal(fitToSound([tw("Then", 42.36, 43.44, 0), tw("the", 43.44, 43.6, 1)], { start: 43.371, end: 44 })[0].start, 43.371);
});

test("a word edge inside a measured pause is pulled out of it, without reordering words", () => {
  const words = [tw("way.", 2.8, 3.5, 0), tw("It", 3.4, 3.9, 1)];
  const snapped = snapToSound(words, [{ start: 3.1, end: 3.6 }]);
  assert.deepEqual(snapped.map((w) => [w.start, w.end]), [[2.8, 3.1], [3.6, 3.9]]);
  const inside = snapToSound([tw("uh", 3.2, 3.4, 0)], [{ start: 3.1, end: 3.6 }]);
  assert.deepEqual([inside[0].start, inside[0].end], [3.2, 3.4], "a word wholly inside a pause is left, not invented a place");
});

// --- subtitles ------------------------------------------------------------------

test("subtitles come from real word times: 2–4 words, broken at pauses and clauses, no lone words", () => {
  // A pause after "habit," and a long gap after "work."
  const words = [
    ["Every", 1.0, 1.2], ["habit,", 1.25, 1.6],
    ["once", 2.1, 2.3], ["repeated,", 2.35, 2.8],
    ["becomes", 2.85, 3.1], ["who", 3.15, 3.3], ["you", 3.35, 3.5], ["are.", 3.55, 3.8],
    ["Work.", 5.0, 5.4],
  ].map(([w, s, e], i) => ({ word: w as string, start: s as number, end: e as number, beatIndex: 0, index: i, source: "audio" as const }));
  const lines = buildCaptionsFromWords(words);
  assert.deepEqual(lines.map((l) => l.text), ["Every habit,", "once repeated,", "becomes who you are.", "Work."]);
  for (const l of lines) {
    assert.ok(l.words.length >= 1 && l.words.length <= 4, l.text);
    assert.equal(l.start, l.words[0].start, "a line appears exactly when its first word is spoken");
  }
  assert.equal(lines[0].end, lines[1].start, "a short pause is bridged: no blink between lines");
  assert.equal(lines[2].end, 3.8 + 0.3, "before a long pause a line lingers briefly, then clears");
  assert.equal(lines[3].end, 5.4 + 0.3, "the last line lingers briefly after its last word");
  assert.ok(lines.slice(0, 3).every((l) => l.words.length >= 2), "a one-word line only where the speech isolates the word");
  assert.ok(0.5 >= PAUSE_BREAK);
});

test("a real pause ends a line even after one word, so no line is shown across a silence", () => {
  // From a real narration: "…your work. [1.1 s] Not a metaphor." once rendered
  // as "work. Not a metaphor." — on screen through the whole pause.
  const words = [
    ["is", 4.16, 4.36], ["your", 4.36, 4.48], ["work.", 4.48, 4.74],
    ["Not", 5.88, 5.96], ["a", 5.96, 6.12], ["metaphor.", 6.12, 6.46],
  ].map(([w, s, e], i) => ({ word: w as string, start: s as number, end: e as number, beatIndex: 0, index: i, source: "audio" as const }));
  const lines = buildCaptionsFromWords(words);
  assert.deepEqual(lines.map((l) => l.text), ["is your work.", "Not a metaphor."]);
  assert.equal(lines[1].start, 5.88, "the second sentence's line appears when it is spoken");
  assert.ok(lines[0].end <= 4.74 + 0.3 + 1e-9, "the first line clears during the pause instead of bridging it");
});

test("subtitle lines never span two beats", () => {
  const words = [
    { word: "one", start: 1, end: 1.2, beatIndex: 0, index: 0, source: "audio" as const },
    { word: "two", start: 1.3, end: 1.5, beatIndex: 0, index: 1, source: "audio" as const },
    { word: "three", start: 2, end: 2.2, beatIndex: 1, index: 0, source: "audio" as const },
    { word: "four", start: 2.3, end: 2.5, beatIndex: 1, index: 1, source: "audio" as const },
  ];
  const lines = buildCaptionsFromWords(words);
  assert.deepEqual(lines.map((l) => [l.text, l.beatIndex]), [["one two", 0], ["three four", 1]]);
  assert.ok(lines[0].end <= lines[1].start);
});

test("the SRT is in the finished video's clock", () => {
  const srt = toSrt([{ text: "Hi there", start: 1, end: 2.5, beatIndex: 0, words: [] }], 0.7);
  assert.equal(srt, "1\n00:00:01,700 --> 00:00:03,200\nHi there\n");
  assert.equal(toSrt([{ text: "x", start: 1, end: 2, beatIndex: 0, words: [] }]), "1\n00:00:01,000 --> 00:00:02,000\nx\n", "no offset: unchanged");
});

// --- highlights ------------------------------------------------------------------

const box = (y: number) => ({ x0: 0, y0: y, x1: 100, y1: y + 20 });
/** Three printed lines of four words each: words 0–3, 4–7, 8–11. */
const lines: LineRun[] = [0, 1, 2].map((l) => ({
  box: box(l * 30),
  wordIndices: [l * 4, l * 4 + 1, l * 4 + 2, l * 4 + 3],
  wordBoxes: [0, 1, 2, 3].map((k) => ({ x0: k * 25, y0: l * 30, x1: k * 25 + 20, y1: l * 30 + 20 })),
}));
const page = "the obstacle is the way what stands in the way becomes way".split(" ");

test("a passage read aloud is swept exactly while its words are spoken", () => {
  // The narration says "what stands in the way" — page words 5–9 — at 3.0–4.0 s.
  const spoken = [
    { word: "The", start: 1, end: 1.2 }, { word: "book", start: 1.3, end: 1.5 }, { word: "says", start: 1.6, end: 1.9 },
    { word: "what", start: 3.0, end: 3.2 }, { word: "stands", start: 3.2, end: 3.5 }, { word: "in", start: 3.5, end: 3.6 },
    { word: "the", start: 3.6, end: 3.7 }, { word: "way", start: 3.7, end: 4.0 },
  ];
  const anchors = quotedAnchors(spoken, page, 0, 11);
  assert.deepEqual([...anchors.keys()].sort((a, b) => a - b), [5, 6, 7, 8, 9]);
  const steps = timedSweepForBeat(lines, 0, 11, spoken, page);
  assert.equal(steps.length, 3);
  assert.deepEqual([steps[1].start, steps[1].end], [3.0, 3.6], "line 2 (page words 4–7) while 'what stands in' is said");
  assert.deepEqual([steps[2].start, steps[2].end], [3.6, 4.0], "line 3 (page words 8–11) while 'the way' is said");
  assert.equal(steps[0].start, 1, "the unquoted first line runs from the first spoken word…");
  assert.equal(steps[0].end, 3.0, "…up to the quote");
});

test("commentary sweeps the cited lines in order, every stroke on a real word boundary", () => {
  const spoken = "this idea turns every setback into the next thing to work on".split(" ")
    .map((w, i) => ({ word: w, start: 2 + i * 0.5, end: 2 + i * 0.5 + 0.35 }));
  const steps = timedSweepForBeat(lines, 0, 11, spoken, page);
  assert.equal(steps.length, 3);
  const boundaries = new Set(spoken.flatMap((w) => [w.start, w.end]));
  for (const s of steps) {
    assert.ok(boundaries.has(s.start), `stroke starts on a word boundary (${s.start})`);
    assert.ok(boundaries.has(s.end), `stroke ends on a word boundary (${s.end})`);
  }
  assert.equal(steps[0].start, spoken[0].start);
  assert.equal(steps[2].end, spoken[spoken.length - 1].end);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].start >= steps[i - 1].end - 1e-9, "never backwards");
});

test("fewer spoken words than lines still never runs backwards", () => {
  const steps = timedSweepForBeat(lines, 0, 11, [{ word: "Right.", start: 5, end: 5.4 }], page);
  assert.equal(steps.length, 3);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].start >= steps[i - 1].end - 1e-9);
  assert.ok(steps.every((s) => s.start >= 5 && s.end <= 5.4));
});

test("two shared words are not a quotation", () => {
  const spoken = [{ word: "the", start: 1, end: 1.1 }, { word: "way", start: 1.1, end: 1.3 }];
  assert.equal(quotedAnchors(spoken, page, 0, 11).size, 0);
  assert.equal(QUOTE_RUN, 3);
  assert.deepEqual(timedSweepForBeat(lines, 0, 11, [], page), [], "no speech, no strokes");
});

// --- the explicit fallback -----------------------------------------------------------

test("when word timing cannot run, the estimate is used AND labelled as an estimate", async () => {
  const prev = process.env.BOOKREEL_ALIGN_PYTHON;
  process.env.BOOKREEL_ALIGN_PYTHON = "Z:/definitely/not/a/python.exe";
  try {
    const voice = {
      audioPath: "none.wav",
      totalDuration: 4,
      beats: [{ index: 0, text: "Two words here.", file: "", start: 0, end: 4, speechStart: 0.09, speechEnd: 3.78 }],
    };
    const t = await timeNarration(voice, process.env.TEMP ?? ".");
    assert.equal(t.source, "estimated");
    assert.ok(t.words.every((w) => w.source === "estimated"));
    assert.equal(t.perBeat[0].source, "estimated");
    assert.match(t.notes[0], /ESTIMATED, not taken from the audio/);
    assert.ok(t.captions.length > 0);
  } finally {
    if (prev === undefined) delete process.env.BOOKREEL_ALIGN_PYTHON;
    else process.env.BOOKREEL_ALIGN_PYTHON = prev;
  }
});
