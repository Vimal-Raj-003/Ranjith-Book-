import test from "node:test";
import assert from "node:assert/strict";
import { classifyEmphasis, emphasizeWords } from "../src/lib/video/scenes/emphasis";
import { renderScene, entranceFor, counted, overlappingAnims, sceneCss } from "../src/lib/video/scenes/render";
import { validateScenes, type ValidateContext } from "../src/lib/video/scenes/validate";
import { sentencesOf } from "../src/lib/video/scenes/plan";
import { lexicalEmbedder } from "../src/lib/analysis/embed";
import { bookThemeById } from "../src/lib/video/composition/themes";
import { CARD_X, CARD_Y, CARD_W, CARD_H } from "../src/lib/video/composition/build";
import type { Beat } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";
import type { Scene, VisualKind } from "../src/lib/video/scenes/types";

// --- shared fixtures, same shape scenes.test.mts already uses ----------------

const beatOf = (i: number, voiceover: string): Beat => ({
  id: `b${i}`, voiceover, onScreen: "", sourcePage: 0, startWord: 0, endWord: 9,
});

function timed(beats: Beat[], perWord = 0.4): TimedWord[] {
  const out: TimedWord[] = [];
  let t = 1;
  beats.forEach((b, bi) => {
    b.voiceover.split(/\s+/).filter(Boolean).forEach((word, i) => {
      out.push({ word, start: +t.toFixed(3), end: +(t + perWord * 0.8).toFixed(3), beatIndex: bi, index: i, source: "audio" });
      t += perWord;
    });
    t += 0.34;
  });
  return out;
}

const RECT = { x: CARD_X, y: CARD_Y, w: CARD_W, h: CARD_H };

function sceneOf(kind: VisualKind, extra: Partial<Scene> = {}): Scene {
  return {
    index: 0, kind, start: 2, end: 9, tone: "cool", sentences: [0], beatIndex: 0,
    source: { pageIndex: 0, startWord: 0, endWord: 5 }, reason: "r", concept: "a clock",
    words: [
      { word: "Small", start: 2.0, end: 2.3 },
      { word: "habits", start: 2.35, end: 2.7 },
      { word: "compound.", start: 2.75, end: 3.2 },
    ],
    steps: ["first thing", "second thing"],
    stat: { value: "3", label: "degrees" },
    curve: { points: [4, 10, 22, 48, 96], label: "compounding" },
    ...extra,
  };
}

function ctx(over: Partial<ValidateContext> = {}): ValidateContext {
  return {
    sentences: [],
    pageWords: new Map(),
    cropFor: () => null,
    hasPage: () => false,
    locate: () => null,
    embedder: lexicalEmbedder,
    ...over,
  };
}

// --- text emphasis (emphasis.ts) ----------------------------------------------

test("the requirement's own examples classify into their categories", () => {
  assert.equal(classifyEmphasis("time")?.category, "time");
  assert.equal(classifyEmphasis("money")?.category, "money");
  assert.equal(classifyEmphasis("growth")?.category, "growth");
  assert.equal(classifyEmphasis("problem")?.category, "problem");
  assert.equal(classifyEmphasis("solution")?.category, "solution");
});

test("a bare number, a percentage and a currency amount all classify as 'number'", () => {
  assert.equal(classifyEmphasis("87")?.category, "number");
  assert.equal(classifyEmphasis("87%")?.category, "number");
  assert.equal(classifyEmphasis("$4,000")?.category, "number");
  assert.equal(classifyEmphasis("3x")?.category, "number");
});

test("inflected forms of a category word still classify — 'grows', 'growing', 'costs'", () => {
  assert.equal(classifyEmphasis("grows")?.category, "growth");
  assert.equal(classifyEmphasis("growing")?.category, "growth");
  assert.equal(classifyEmphasis("costs")?.category, "money");
});

test("an ordinary word, and every stop word, classify as nothing", () => {
  for (const w of ["the", "and", "walked", "purple", "because", "a", "of"]) {
    assert.equal(classifyEmphasis(w), null, `"${w}" should not be emphasised`);
  }
});

test("emphasis is occasional, not constant — a sentence dense with matches still spaces them out", () => {
  const words = "time and money and growth and problem and solution".split(" ");
  const hits = emphasizeWords(words);
  const indices = hits.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  assert.ok(indices.length < words.length, "not every word is emphasised");
  assert.ok(indices.length > 0, "but at least one genuinely important word is");
  for (let k = 1; k < indices.length; k++) {
    assert.ok(indices[k] - indices[k - 1] >= 3, `emphasised words ${indices[k - 1]} and ${indices[k]} are too close together`);
  }
});

// --- kinetic text rendering ----------------------------------------------------

test("an emphasised word gets a bigger, coloured treatment and a snappier arrival than a plain word", () => {
  // "compound" and "money" are deliberately far apart — emphasizeWords'
  // MIN_GAP spacing rule (only one emphasis per few words) is its own,
  // separately tested behaviour, and putting two hits back to back here
  // would test that rule by accident instead of this one.
  const scene = sceneOf("kinetic-text", {
    words: [
      { word: "Small", start: 2.0, end: 2.3 },
      { word: "habits", start: 2.6, end: 2.9 },
      { word: "compound", start: 3.2, end: 3.6 },
      { word: "over", start: 3.9, end: 4.1 },
      { word: "time", start: 4.2, end: 4.4 },
      { word: "into", start: 4.5, end: 4.7 },
      { word: "real", start: 4.8, end: 5.0 },
      { word: "money.", start: 5.1, end: 5.4 },
    ],
    concept: "",
  });
  const r = renderScene(scene, RECT)!;
  assert.match(r.markup, /sc-word-emph sc-cat-growth/, "compound is a growth word");
  assert.match(r.markup, /sc-word-emph sc-cat-money/, "money is a money word");
  const growthAnim = r.anims.find((a) => a.e === 2);
  assert.equal(growthAnim?.k, "pop", "an emphasised word pops in rather than just rising");
  const plainAnim = r.anims.find((a) => a.e === 0);
  assert.equal(plainAnim?.k, "rise", "an ordinary word still just rises, unchanged");
});

test("kinetic text with no accent icon renders exactly as before — the feature is additive, never required", () => {
  const scene = sceneOf("kinetic-text", { icon: undefined, concept: "" });
  const r = renderScene(scene, RECT)!;
  assert.ok(!r.markup.includes("sc-kinetic-icon"));
  assert.deepEqual(overlappingAnims(r.anims), []);
});

test("kinetic text WITH an accent icon adds one extra, non-overlapping element", () => {
  const scene = sceneOf("kinetic-text", {
    concept: "a clock",
    icon: { name: "clock", paths: "<path/>", query: "a clock", score: 0.6 },
  });
  const r = renderScene(scene, RECT)!;
  assert.match(r.markup, /sc-kinetic-icon/);
  assert.deepEqual(overlappingAnims(r.anims), []);
});

// --- scene entrance variety (transitions) --------------------------------------

test("scene entrances are deterministic and never repeat on the scene right after", () => {
  const first = [0, 1, 2, 3, 4, 5].map(entranceFor);
  const second = [0, 1, 2, 3, 4, 5].map(entranceFor);
  assert.deepEqual(first, second, "the same index always produces the same entrance");
  for (let i = 1; i < first.length; i++) {
    assert.notEqual(first[i].k, first[i - 1].k, `scenes ${i - 1} and ${i} share the same entrance (${first[i].k})`);
  }
});

test("every entrance kind actually appears across a normal-length plan", () => {
  const kinds = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => entranceFor(i).k));
  assert.deepEqual([...kinds].sort(), ["in", "pop", "rise"]);
});

test("a scene layer's own entrance uses whatever entranceFor(index) says, at the SCENE_FADE duration", () => {
  const scene = sceneOf("stat", { index: 4 });
  const r = renderScene({ ...scene, index: 4 }, RECT)!;
  const layer = r.anims.find((a) => a.e === -1 && a.t === scene.start);
  const expected = entranceFor(4);
  assert.equal(layer?.k, expected.k);
  assert.equal(layer?.v, expected.v);
});

// --- stat count-up (counted()) --------------------------------------------------

test("clean whole numbers, percentages and currency amounts are countable", () => {
  assert.deepEqual(counted("87"), { prefix: "", digits: "87", suffix: "", n: 87 });
  assert.deepEqual(counted("87%"), { prefix: "", digits: "87", suffix: "%", n: 87 });
  assert.deepEqual(counted("$4,000"), { prefix: "$", digits: "4,000", suffix: "", n: 4000 });
  assert.deepEqual(counted("10x"), { prefix: "", digits: "10", suffix: "x", n: 10 });
});

test("a decimal, a range or a bare word are not countable — the pop treatment still shows them", () => {
  assert.equal(counted("3.5"), null);
  assert.equal(counted("50-100"), null);
  assert.equal(counted("double"), null);
  assert.equal(counted(""), null);
  assert.equal(counted("0"), null, "counting to zero is not worth a tween");
});

test("a stat scene with a countable value renders a separate count element that never overlaps the pop", () => {
  const scene = sceneOf("stat", { stat: { value: "87%", label: "of readers" } });
  const r = renderScene(scene, RECT)!;
  assert.match(r.markup, /sc-stat-count/);
  assert.match(r.markup, />0%</, "rest state shows the from-value, matching the count tween's own from");
  const count = r.anims.find((a) => a.k === "count");
  assert.equal(count?.v, 87);
  assert.equal(count?.suffix, "%");
  assert.deepEqual(overlappingAnims(r.anims), []);
});

test("a stat scene with an uncountable value falls back to the plain pop, no count element at all", () => {
  const scene = sceneOf("stat", { stat: { value: "double", label: "the results" } });
  const r = renderScene(scene, RECT)!;
  assert.ok(!r.markup.includes("sc-stat-count"));
  assert.equal(r.anims.some((a) => a.k === "count"), false);
  assert.match(r.markup, />double</);
});

// --- growth-curve polish --------------------------------------------------------

test("the growth curve renders a filled area and gridlines behind the line, revealed only after the line finishes drawing", () => {
  const scene = sceneOf("growth-curve");
  const r = renderScene(scene, RECT)!;
  assert.match(r.markup, /sc-curve-fill/);
  assert.match(r.markup, /sc-grid/);
  const draw = r.anims.find((a) => a.k === "draw")!;
  const fillIn = r.anims.find((a) => a.k === "in" && a.e === 3)!;
  assert.ok(fillIn.t >= draw.t + draw.d - 1e-6, "the fill must not appear before the line has finished drawing");
  assert.deepEqual(overlappingAnims(r.anims), []);
});

// --- steps connector -------------------------------------------------------------

test("a steps scene with two or more items gets a connector line; the anim never overlaps a step's own rise", () => {
  const scene = sceneOf("steps", { steps: ["first", "second", "third"] });
  const r = renderScene(scene, RECT)!;
  assert.match(r.markup, /sc-step-connector/);
  assert.ok(r.anims.some((a) => a.k === "grow"));
  assert.deepEqual(overlappingAnims(r.anims), []);
});

test("a steps scene with a single item (malformed input) skips the connector rather than drawing a line to nowhere", () => {
  const scene = sceneOf("steps", { steps: ["only one"] });
  const r = renderScene(scene, RECT)!;
  assert.ok(!r.markup.includes("sc-step-connector"));
});

// --- the optional kinetic-text accent icon, end to end through validateScenes --

test("a kinetic-text scene with an empty concept never gets an accent icon", async () => {
  const beats = [beatOf(0, "Small habits compound over time.")];
  const sentences = sentencesOf(beats, timed(beats));
  const r = await validateScenes(
    [{ fromSentence: 0, toSentence: sentences.length - 1, from: 0, to: sentences.length - 1, kind: "kinetic-text", concept: "", reason: "r" }],
    ctx({ sentences }),
  );
  assert.equal(r.scenes[0].icon, undefined);
});

test("a kinetic-text scene whose concept confidently names a real, drawable icon gets it attached", async () => {
  const beats = [beatOf(0, "Small habits compound over time.")];
  const sentences = sentencesOf(beats, timed(beats));
  const r = await validateScenes(
    [{ fromSentence: 0, toSentence: sentences.length - 1, from: 0, to: sentences.length - 1, kind: "kinetic-text", concept: "clock", reason: "r" }],
    ctx({ sentences }),
  );
  assert.ok(r.scenes[0].icon, "a literal, exact-match icon name should confidently resolve");
  assert.ok(r.scenes[0].icon!.paths.length > 0);
});

test("a non-kinetic-text scene never receives the accent icon field, whatever its concept", async () => {
  const beats = [beatOf(0, "Small habits compound over time. They add up fast.")];
  const sentences = sentencesOf(beats, timed(beats));
  const r = await validateScenes(
    [{ fromSentence: 0, toSentence: sentences.length - 1, from: 0, to: sentences.length - 1, kind: "stat", value: "3", label: "over time", concept: "clock", reason: "r" }],
    ctx({ sentences, pageWords: new Map([[0, "Small habits compound over three time".split(" ")]]) }),
  );
  assert.equal(r.scenes[0].kind, "stat");
  assert.equal(r.scenes[0].icon, undefined);
});

// --- CSS stays within the palette contract --------------------------------------

test("new CSS added for this phase references only the theme's own palette, never a literal colour", () => {
  const theme = bookThemeById("marginalia");
  const css = sceneCss(theme, RECT);
  const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  const palette = new Set(Object.values(theme.palette).map((v) => String(v).toLowerCase()));
  for (const h of hex) {
    assert.ok([...palette].some((p) => p.includes(h.toLowerCase())), `${h} is not a palette colour`);
  }
  // And the new classes this phase added are actually present, not silently
  // missing (a typo'd selector would still pass the hex-colour check above).
  for (const cls of [".sc-word-emph", ".sc-kinetic-icon", ".sc-stat-count", ".sc-grid", ".sc-curve-fill-top", ".sc-step-connector"]) {
    assert.ok(css.includes(cls), `${cls} is missing from sceneCss`);
  }
});
