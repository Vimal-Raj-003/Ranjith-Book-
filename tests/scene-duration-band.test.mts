import test from "node:test";
import assert from "node:assert/strict";
import { enforceDurations, sentencesOf, MIN_SCENE_SEC, MAX_SCENE_SEC } from "../src/lib/video/scenes/plan";
import { timeBeat } from "../src/lib/media/word-timing";
import type { Sentence } from "../src/lib/video/scenes/types";
import type { Beat } from "../src/lib/content/schema";
import type { AsrWord } from "../src/lib/media/word-timing";
import type { CompositionInput } from "../src/lib/video/composition/build";

/* ===========================================================================
 * The duration band, and the word timings underneath it
 *
 * Measured in a real episode ("Stop Getting Angry at Waiters"): one scene
 * rendered with start === end === 34.29s, and the sentence after it became a
 * single 13.9s block — 41% of a 65s video sitting on one photographed page.
 * Both came from the same place. `timeBeat` clamped a matched word's end to the
 * beat's window end, which set its monotonic `floor` to that same instant, so
 * every later word in the beat resolved to start === end === window.end. Eight
 * of that video's 51 caption lines had zero duration and two ran backwards.
 *
 * The sentences built from those words inherited the collapse, and
 * `enforceDurations` then merged the zero-length one away correctly and split
 * it straight back out again, because its split pass only ever looks forward.
 *
 * These are the regressions for both halves.
 * ======================================================================== */

const sentence = (index: number, start: number, end: number): Sentence => ({
  index,
  text: `sentence ${index}`,
  start,
  end,
  beatIndex: 0,
  sourcePage: 0,
  startWord: 0,
  endWord: 1,
  words: [{ word: `w${index}`, start, end }],
});

const spanOf = (r: { fromSentence: number; toSentence: number }, s: Sentence[]) =>
  s[r.toSentence].end - s[r.fromSentence].start;

test("no scene is ever handed back with zero duration", () => {
  // The exact shape from the real episode: a normal sentence, a zero-duration
  // one, a long one, a normal one.
  const sentences = [
    sentence(0, 23.96, 29.22),
    sentence(1, 34.29, 34.29), // the collapse
    sentence(2, 34.29, 48.209),
    sentence(3, 48.209, 56.84),
  ];
  const ranges = sentences.map((_, i) => ({ fromSentence: i, toSentence: i }));
  const out = enforceDurations(ranges, sentences);

  for (const r of out) {
    assert.ok(
      spanOf(r, sentences) > 0,
      `sentences ${r.fromSentence}..${r.toSentence} render for no time at all`,
    );
  }
});

test("a zero-duration sentence is folded FORWARD, so its own scene keeps its content", () => {
  const sentences = [
    sentence(0, 23.96, 29.22),
    sentence(1, 34.29, 34.29),
    sentence(2, 34.29, 48.209),
    sentence(3, 48.209, 56.84),
  ];
  const out = enforceDurations(
    sentences.map((_, i) => ({ fromSentence: i, toSentence: i })),
    sentences,
  );
  // A range keeps the director's spec for the sentence it BEGINS on, so the
  // collapsed sentence must still start a range — otherwise whatever the
  // director chose to show for it is silently dropped.
  assert.ok(
    out.some((r) => r.fromSentence === 1),
    `sentence 1's own scene was discarded rather than given time: ${JSON.stringify(out)}`,
  );
});

test("every scene is inside the duration band wherever the sentences allow it", () => {
  // Ordinary narration: nothing degenerate, so the band must hold exactly.
  const sentences: Sentence[] = [];
  let t = 0;
  for (let i = 0; i < 14; i++) {
    const d = 1.4 + (i % 5) * 0.6; // 1.4s .. 4.0s, none over MAX on its own
    sentences.push(sentence(i, t, t + d));
    t += d;
  }
  const out = enforceDurations(
    sentences.map((_, i) => ({ fromSentence: i, toSentence: i })),
    sentences,
  );
  for (const r of out) {
    const d = spanOf(r, sentences);
    assert.ok(d >= MIN_SCENE_SEC, `a ${d.toFixed(2)}s scene is under the ${MIN_SCENE_SEC}s floor`);
    assert.ok(d <= MAX_SCENE_SEC, `a ${d.toFixed(2)}s scene is over the ${MAX_SCENE_SEC}s ceiling`);
  }
});

test("the ranges still cover every sentence exactly once", () => {
  // The band pass merges; it must never drop narration or show it twice.
  const sentences = [
    sentence(0, 0, 3),
    sentence(1, 3, 3), // zero
    sentence(2, 3, 3), // zero
    sentence(3, 3, 9),
    sentence(4, 9, 12),
  ];
  const out = enforceDurations(
    sentences.map((_, i) => ({ fromSentence: i, toSentence: i })),
    sentences,
  );
  const covered: number[] = [];
  for (const r of out) for (let i = r.fromSentence; i <= r.toSentence; i++) covered.push(i);
  assert.deepEqual(covered, [0, 1, 2, 3, 4], "sentences were dropped, duplicated or reordered");
});

/* --- the word timings underneath -------------------------------------- */

const asr = (word: string, start: number, end: number): AsrWord => ({ word, start, end });

test("a match that cannot fit the beat window does not collapse everything after it", () => {
  // The recogniser runs past the end of the beat's own audio window. The old
  // code pinned that word to window.end, which set the monotonic floor to
  // window.end and flattened every later word onto the same instant.
  const text = "one two three four five six seven eight";
  const heard = [
    asr("one", 0.0, 0.4),
    asr("two", 0.4, 0.8),
    // from here the recogniser is past the window end of 2.0
    asr("three", 2.0, 2.4),
    asr("four", 2.4, 2.8),
    asr("five", 2.8, 3.2),
    asr("six", 3.2, 3.6),
    asr("seven", 3.6, 4.0),
    asr("eight", 4.0, 4.4),
  ];
  const { words } = timeBeat(0, text, heard, { start: 0, end: 2.0 });

  assert.equal(words.length, 8);
  for (const w of words) {
    assert.ok(w.end > w.start, `"${w.word}" has no duration (${w.start} -> ${w.end})`);
  }
  for (let i = 1; i < words.length; i++) {
    assert.ok(
      words[i].start >= words[i - 1].end - 1e-9,
      `"${words[i].word}" starts before "${words[i - 1].word}" ends`,
    );
  }
  const distinct = new Set(words.map((w) => w.start.toFixed(4))).size;
  assert.ok(distinct > 1, "every word landed on the same instant");
});

test("word timings never run backwards, whatever the recogniser says", () => {
  // Out-of-order and duplicated recogniser output, which is what produced the
  // two backwards caption lines in the real episode.
  const heard = [
    asr("alpha", 0.0, 0.5),
    asr("beta", 0.3, 0.2), // ends before it starts
    asr("gamma", 0.1, 0.4), // earlier than the one before it
    asr("delta", 1.8, 2.6), // past the window
  ];
  const { words } = timeBeat(0, "alpha beta gamma delta", heard, { start: 0, end: 2.0 });
  for (let i = 0; i < words.length; i++) {
    assert.ok(words[i].end > words[i].start, `"${words[i].word}" has no duration`);
    if (i > 0) {
      assert.ok(
        words[i].start >= words[i - 1].end - 1e-9,
        `"${words[i].word}" runs backwards into "${words[i - 1].word}"`,
      );
    }
  }
});

test("collapsed word timings no longer produce a zero-length sentence", () => {
  // End to end over the two modules: timings, then the sentences built from
  // them. This is the shape the real episode had.
  const beats: Beat[] = [
    { id: "b0", voiceover: "First line here. Second line here. Third line here.", onScreen: "", sourcePage: 0, startWord: 0, endWord: 9 },
  ];
  const heard = [
    asr("First", 0.0, 0.4), asr("line", 0.4, 0.8), asr("here.", 0.8, 1.2),
    // the rest all report past the window end of 3.0
    asr("Second", 3.0, 3.4), asr("line", 3.4, 3.8), asr("here.", 3.8, 4.2),
    asr("Third", 4.2, 4.6), asr("line", 4.6, 5.0), asr("here.", 5.0, 5.4),
  ];
  const { words } = timeBeat(0, beats[0].voiceover, heard, { start: 0, end: 3.0 });
  const sentences = sentencesOf(beats, words);

  assert.ok(sentences.length >= 2, "the beat did not split into sentences at all");
  for (const s of sentences) {
    assert.ok(s.end > s.start, `sentence "${s.text}" has zero duration`);
  }
});

/* --- a long sentence must not become one dominating scene --------------- */

const w = (word: string, start: number, end: number) => ({ word, start, end, index: 0, beatIndex: 0, source: "audio" as const });

test("a long sentence is split at a clause boundary, not left to dominate", () => {
  // One 14s sentence with commas in it — the shape that produced a 13.9s
  // book-page scene holding 41% of a real 65s video.
  const beats: Beat[] = [
    { id: "b0", voiceover: "The server now resents you, the steak sits cooling in front of you, and the evening you meant to enjoy is already spent.", onScreen: "", sourcePage: 0, startWord: 0, endWord: 20 },
  ];
  const tokens = beats[0].voiceover.split(" ");
  const per = 14 / tokens.length;
  const words = tokens.map((t, i) => w(t, i * per, (i + 1) * per));

  const sentences = sentencesOf(beats, words);
  assert.ok(sentences.length >= 2, `a 14s sentence was left whole: ${sentences.length} sentence(s)`);
  for (const s of sentences) {
    assert.ok(
      s.end - s.start <= MAX_SCENE_SEC,
      `a ${(s.end - s.start).toFixed(1)}s sentence survives, over the ${MAX_SCENE_SEC}s ceiling`,
    );
  }
  // The narration must come through whole: same words, same order.
  assert.equal(sentences.flatMap((s) => s.words.map((x) => x.word)).join(" "), tokens.join(" "));
});

test("ordinary short sentences are not fragmented by the clause rule", () => {
  // Nothing here is anywhere near the threshold, so commas must be ignored.
  const beats: Beat[] = [
    { id: "b0", voiceover: "He is late, again. You wait, and wait.", onScreen: "", sourcePage: 0, startWord: 0, endWord: 8 },
  ];
  const tokens = beats[0].voiceover.split(" ");
  const per = 2.4 / tokens.length;
  const words = tokens.map((t, i) => w(t, i * per, (i + 1) * per));
  const sentences = sentencesOf(beats, words);
  // Two real sentences, split on the full stops only — the commas are left alone.
  assert.equal(sentences.length, 2, `the clause rule fragmented short narration: ${JSON.stringify(sentences.map((s) => s.text))}`);
});

test("a clause split never cuts mid-phrase", () => {
  const beats: Beat[] = [
    { id: "b0", voiceover: "One two three four five, six seven eight nine ten, eleven twelve thirteen fourteen fifteen.", onScreen: "", sourcePage: 0, startWord: 0, endWord: 15 },
  ];
  const tokens = beats[0].voiceover.split(" ");
  const per = 15 / tokens.length;
  const words = tokens.map((t, i) => w(t, i * per, (i + 1) * per));
  const sentences = sentencesOf(beats, words);
  for (const s of sentences.slice(0, -1)) {
    const last = s.words[s.words.length - 1].word;
    assert.ok(
      /[,;:—–.!?]["'”’)\]]*$/.test(last),
      `a sentence ended on "${last}", which is not a boundary the author wrote`,
    );
  }
});

/* --- scene transitions must overlap, not leave a hole ------------------- */

test("each scene's exit overlaps the next scene's entrance", async () => {
  const { buildComposition } = await import("../src/lib/video/composition/build");
  const { BOOK_THEMES } = await import("../src/lib/video/composition/themes");
  const { fixtureInput } = await import("../scripts/fixtures/composition-fixture.mjs");
  const { SCENE_FADE } = await import("../src/lib/video/scenes/render");

  for (const cinematic of [false, true]) {
    const html = buildComposition(
      fixtureInput({ theme: BOOK_THEMES.spotlight, withScenes: true, cinematic }) as unknown as CompositionInput,
    );
    const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
    const scenes = data.scenes as { start: number; end: number }[];
    const anims = data.anims as { s: number; e: number; k: string; t: number; d: number }[];

    // The layer's own tweens are the ones on element -1.
    const layerAnim = (s: number, kinds: string[]) =>
      anims.find((a) => a.s === s && a.e === -1 && kinds.includes(a.k));

    for (let i = 0; i + 1 < scenes.length; i++) {
      const out = layerAnim(i, ["out"]);
      const nextIn = layerAnim(i + 1, ["in", "rise", "pop"]);
      if (!out || !nextIn) continue; // the opening hook has no entrance of its own
      // Before the fix the exit ENDED where the next entrance began, so at the
      // boundary instant neither layer was carrying the frame and the viewer saw
      // bare backdrop. They have to overlap.
      assert.ok(
        out.t + out.d > nextIn.t + 1e-9,
        `scene ${i}'s exit finishes at ${(out.t + out.d).toFixed(2)}s but scene ${i + 1} only starts appearing at ${nextIn.t.toFixed(2)}s — the frame goes empty between them`,
      );
      // ...and the exit must still not collide with this layer's OWN entrance,
      // which would put two tweens on one element's opacity and break seeking.
      const ownIn = layerAnim(i, ["in", "rise", "pop"]);
      if (ownIn) {
        assert.ok(
          out.t >= ownIn.t + ownIn.d - 1e-9,
          `scene ${i}'s exit at ${out.t.toFixed(2)}s overlaps its own entrance ending at ${(ownIn.t + ownIn.d).toFixed(2)}s`,
        );
      }
    }
    assert.ok(SCENE_FADE > 0, "SCENE_FADE must be a real duration");
  }
});

test("closing the floor never builds an over-long scene", () => {
  // A short-but-real piece next to a long one. Folding the short piece forward
  // to satisfy MIN_SCENE_SEC would make a scene far past the ceiling — which is
  // the defect this whole function exists to prevent, arrived at from the other
  // direction. A slightly short scene is the better trade.
  const sentences = [
    sentence(0, 0, 2.0),    // 2.0s — under the floor, but real time on screen
    sentence(1, 2.0, 12.5), // 10.5s — already near the ceiling
    sentence(2, 12.5, 16.0),
  ];
  const out = enforceDurations(
    sentences.map((_, i) => ({ fromSentence: i, toSentence: i })),
    sentences,
  );
  for (const r of out) {
    const d = spanOf(r, sentences);
    assert.ok(
      d <= MAX_SCENE_SEC,
      `merging to satisfy the ${MIN_SCENE_SEC}s floor produced a ${d.toFixed(1)}s scene`,
    );
    assert.ok(d > 0, "a scene was left with no duration");
  }
});

test("a timeless piece is still merged even when its neighbour is long", () => {
  // The opposite trade: no time at all cannot be left alone, even though the
  // merge overshoots the ceiling, because a scene that renders for zero seconds
  // is always worse than a long one.
  const sentences = [
    sentence(0, 0, 4.0),
    sentence(1, 4.0, 4.0),  // timeless
    sentence(2, 4.0, 16.0), // long
  ];
  const out = enforceDurations(
    sentences.map((_, i) => ({ fromSentence: i, toSentence: i })),
    sentences,
  );
  for (const r of out) {
    assert.ok(spanOf(r, sentences) > 0, `sentences ${r.fromSentence}..${r.toSentence} render for no time`);
  }
  const covered: number[] = [];
  for (const r of out) for (let i = r.fromSentence; i <= r.toSentence; i++) covered.push(i);
  assert.deepEqual(covered, [0, 1, 2], "narration was dropped or duplicated");
});
