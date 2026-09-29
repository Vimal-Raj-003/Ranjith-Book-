import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { sentencesOf, slotSentences, normalizeRanges, enforceDurations, MIN_SCENE_SEC, MAX_SCENE_SEC } from "../src/lib/video/scenes/plan";
import { validateScenes, groundedIn, numberIsSaid, MIN_BOOK_SCENES, type ValidateContext } from "../src/lib/video/scenes/validate";
import { renderScene, overlappingAnims, sceneCss } from "../src/lib/video/scenes/render";
import { targetSceneCount, planScenes } from "../src/lib/video/scenes";
import { cardVisibility, cardZooms, glowKeys, buildComposition, CARD_X, CARD_Y, CARD_W, CARD_H, AUDIO_OFFSET } from "../src/lib/video/composition/build";
import { bookThemeById } from "../src/lib/video/composition/themes";
import type { CompositionInput } from "../src/lib/video/composition/build";
import { lexicalEmbedder } from "../src/lib/analysis/embed";
import { resolveIcon, iconText, iconIndex, iconPaths, findIcons, resetIconIndex, takeIconTrouble } from "../src/lib/video/scenes/icons";
import type { Beat } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";
import type { Scene, SceneSpec, VisualKind } from "../src/lib/video/scenes/types";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";

// --- fixtures ----------------------------------------------------------------

const beat = (i: number, voiceover: string, page = 0, s = 0, e = 9): Beat => ({
  id: `b${i}`, voiceover, onScreen: "", sourcePage: page, startWord: s, endWord: e,
});

/** Words at a steady pace, so sentence times are predictable. */
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

const PAGE_WORDS = "The impediment to action advances action. What stands in the way becomes the way. Small habits compound over time into remarkable results".split(" ");

function ctx(over: Partial<ValidateContext> = {}): ValidateContext {
  const sentences = over.sentences ?? [];
  return {
    sentences,
    pageWords: new Map([[0, PAGE_WORDS]]),
    cropFor: () => ({ x0: 10, y0: 20, x1: 900, y1: 140 }),
    hasPage: () => true,
    locate: (page, quote) => {
      const hay = PAGE_WORDS.join(" ").toLowerCase();
      const q = quote.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      const at = hay.replace(/[^a-z0-9 ]/g, "").indexOf(q);
      if (at < 0 || q.length < 8) return null;
      return { text: quote, startWord: 0, endWord: 5 };
    },
    embedder: lexicalEmbedder,
    ...over,
  };
}

const spec = (from: number, to: number, kind: VisualKind, extra: Partial<SceneSpec> = {}) => ({
  fromSentence: from, toSentence: to, from, to, kind, concept: "a thing", reason: "because", ...extra,
});

// --- sentences ---------------------------------------------------------------

test("sentences are cut on real spoken word times and never span two beats", () => {
  const beats = [beat(0, "One thing happens. Then another thing."), beat(1, "A third thing entirely.")];
  const words = timed(beats);
  const s = sentencesOf(beats, words);
  assert.deepEqual(s.map((x) => x.text), ["One thing happens.", "Then another thing.", "A third thing entirely."]);
  assert.deepEqual(s.map((x) => x.beatIndex), [0, 0, 1]);
  // Every boundary is a measured word edge, not an interpolation.
  const starts = new Set(words.map((w) => w.start));
  const ends = new Set(words.map((w) => w.end));
  for (const x of s) {
    assert.ok(starts.has(x.start), `sentence starts on a spoken word (${x.start})`);
    assert.ok(ends.has(x.end), `sentence ends on a spoken word (${x.end})`);
  }
});

test("a beat with no terminal punctuation is still one sentence, not dropped", () => {
  const beats = [beat(0, "no full stop here")];
  assert.deepEqual(sentencesOf(beats, timed(beats)).map((s) => s.text), ["no full stop here"]);
});

// --- slots and ranges ---------------------------------------------------------

test("the fallback grouping keeps every scene inside the duration band and covers every sentence", () => {
  const beats = Array.from({ length: 9 }, (_, i) => beat(i, `Sentence ${i} runs on for a little while here. And a second clause follows it.`));
  const sentences = sentencesOf(beats, timed(beats));
  const slots = slotSentences(sentences, 11);
  assert.equal(slots[0].fromSentence, 0);
  assert.equal(slots[slots.length - 1].toSentence, sentences.length - 1);
  for (let i = 1; i < slots.length; i++) assert.equal(slots[i].fromSentence, slots[i - 1].toSentence + 1, "no gap, no overlap");
  for (const s of slots) assert.ok(s.end - s.start >= MIN_SCENE_SEC - 1e-9, `${(s.end - s.start).toFixed(2)}s`);
});

test("a director's ranges are corrected into a legal cover: gaps closed, overlaps removed, the end extended", () => {
  // Overlapping, out of order, and stopping short of the last sentence.
  const fixed = normalizeRanges([{ fromSentence: 4, toSentence: 6 }, { fromSentence: 0, toSentence: 5 }], 10);
  assert.deepEqual(fixed, [{ fromSentence: 0, toSentence: 5 }, { fromSentence: 6, toSentence: 9 }]);
  assert.deepEqual(normalizeRanges([], 3), [{ fromSentence: 0, toSentence: 2 }]);
});

test("ranges that are too long are split and too short are merged", () => {
  const beats = [beat(0, "A. B. C. D. E. F. G. H.")];
  const sentences = sentencesOf(beats, timed(beats, 3.0));
  // One range over everything: each sentence is 2.4s, so 8 of them is 19s+.
  const out = enforceDurations([{ fromSentence: 0, toSentence: sentences.length - 1 }], sentences);
  assert.ok(out.length > 1, "a long range is split");
  for (const r of out) {
    const span = sentences[r.toSentence].end - sentences[r.fromSentence].start;
    assert.ok(span <= MAX_SCENE_SEC + 1e-6, `${span.toFixed(1)}s is inside the cap`);
  }
  assert.equal(out[0].fromSentence, 0);
  assert.equal(out[out.length - 1].toSentence, sentences.length - 1);
});

test("the scene count follows the video's length and stays in the 8–15 band", () => {
  assert.equal(targetSceneCount(60), 8);
  assert.equal(targetSceneCount(96), 12);
  assert.equal(targetSceneCount(120), 15);
  assert.equal(targetSceneCount(300), 15);
});

// --- grounding ----------------------------------------------------------------

test("a label is grounded only when its content words are actually said", () => {
  const hay = ["What stands in the way becomes the way.", "The impediment to action advances action."];
  assert.ok(groundedIn("the impediment", hay));
  assert.ok(groundedIn("stands in the way", hay));
  assert.ok(groundedIn("advancing action", hay), "stems match: advancing/advances, action/action");
  assert.ok(!groundedIn("quarterly revenue targets", hay));
  assert.ok(!groundedIn("", hay));
});

test("a quote that is not in the book falls back to the narration, and a real one is kept", async () => {
  const beats = [beat(0, "The page says something. It matters a lot.")];
  const sentences = sentencesOf(beats, timed(beats));
  // No page to show, so a refused template can only fall back to the
  // narration — which is what this test is about. The book-scene floor is
  // covered separately.
  const c = ctx({ sentences, hasPage: () => false });

  const bad = await validateScenes([spec(0, 1, "quote", { quote: "a line the book never contained at all" })], c);
  assert.equal(bad.scenes[0].kind, "kinetic-text");
  assert.equal(bad.scenes[0].fallbackFrom, "quote");
  assert.match(bad.notes[0], /quote was not found/);

  const good = await validateScenes([spec(0, 1, "quote", { quote: "The impediment to action advances action" })], c);
  assert.equal(good.scenes[0].kind, "quote");
  assert.equal(good.scenes[0].quote?.page, 0);
});

test("a stat whose number is not in the narration or the page is refused", async () => {
  const beats = [beat(0, "Just three degrees changes everything. That is the whole point.")];
  const sentences = sentencesOf(beats, timed(beats));
  const c = ctx({ sentences, hasPage: () => false });
  const invented = await validateScenes([spec(0, 1, "stat", { value: "87%", label: "of people" })], c);
  assert.equal(invented.scenes[0].kind, "kinetic-text");
  assert.match(invented.notes[0], /number is not in/);

  // "three degrees" is said; a card reading "3" is the same fact.
  const real = await validateScenes([spec(0, 1, "stat", { value: "3", label: "degrees changes everything" })], c);
  assert.equal(real.scenes[0].kind, "stat");
  assert.equal(real.scenes[0].stat?.value, "3");
  assert.ok(numberIsSaid("3", ["Just three degrees changes everything."]));
  assert.ok(numberIsSaid("25", ["it took 25 minutes"]));
  assert.ok(!numberIsSaid("87", ["Just three degrees changes everything."]));
});

test("comparison and steps are refused when their labels are not in what is said", async () => {
  const beats = [beat(0, "Motivation rises and falls. Systems keep working anyway.")];
  const sentences = sentencesOf(beats, timed(beats));
  const c = ctx({ sentences, hasPage: () => false });

  const ok = await validateScenes([spec(0, 1, "comparison", { left: "motivation", right: "systems" })], c);
  assert.equal(ok.scenes[0].kind, "comparison");

  const bad = await validateScenes([spec(0, 1, "comparison", { left: "quarterly profit", right: "market share" })], c);
  assert.equal(bad.scenes[0].kind, "kinetic-text");

  const oneStep = await validateScenes([spec(0, 1, "steps", { steps: ["motivation rises"] })], c);
  assert.equal(oneStep.scenes[0].kind, "kinetic-text", "a list of one is not a list");
});

test("a crop with no word geometry becomes the whole page, not a failure", async () => {
  const beats = [beat(0, "One. Two.")];
  const sentences = sentencesOf(beats, timed(beats));
  const r = await validateScenes([spec(0, 1, "book-crop")], ctx({ sentences, cropFor: () => null }));
  assert.equal(r.scenes[0].kind, "book-page");
  assert.match(r.notes[0], /no word geometry/);
});

// --- whole-video rules ---------------------------------------------------------

test("no template runs three times in a row", async () => {
  const beats = [beat(0, "A. B. C. D. E. F.")];
  const sentences = sentencesOf(beats, timed(beats));
  const specs = [0, 1, 2, 3, 4, 5].map((i) => spec(i, i, "kinetic-text"));
  const r = await validateScenes(specs, ctx({ sentences }));
  for (let i = 2; i < r.scenes.length; i++) {
    const run = r.scenes.slice(i - 2, i + 1).map((s) => s.kind);
    assert.ok(new Set(run).size > 1, `scenes ${i - 2}-${i} are all ${run[0]}`);
  }
});

test("the book stays visible: at least three scenes show the page", async () => {
  const beats = [beat(0, "A. B. C. D. E. F. G. H.")];
  const sentences = sentencesOf(beats, timed(beats));
  const specs = sentences.map((s) => spec(s.index, s.index, "kinetic-text"));
  const r = await validateScenes(specs, ctx({ sentences }));
  const book = r.scenes.filter((s) => ["book-page", "book-crop", "quote"].includes(s.kind));
  assert.ok(book.length >= MIN_BOOK_SCENES, `${book.length} book scenes`);
  // …and never two of them back to back, which would undo the variety.
  for (let i = 1; i < r.scenes.length; i++) {
    const pair = [r.scenes[i - 1].kind, r.scenes[i].kind];
    assert.ok(!pair.every((k) => k === "book-page"), `scenes ${i - 1},${i} are both book-page`);
  }
});

test("every scene records where in the book it came from", async () => {
  const beats = [beat(0, "A. B. C.", 2, 11, 40)];
  const sentences = sentencesOf(beats, timed(beats));
  const r = await validateScenes(sentences.map((s) => spec(s.index, s.index, "kinetic-text")), ctx({ sentences, pageWords: new Map([[2, PAGE_WORDS]]) }));
  for (const s of r.scenes) {
    assert.equal(s.source.pageIndex, 2);
    assert.ok(s.sentences.length >= 1);
    assert.ok(Number.isFinite(s.start) && s.end > s.start);
  }
});

// --- rendering -----------------------------------------------------------------

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
    quote: { text: "What stands in the way becomes the way", page: 4 },
    icons: [
      { name: "clock", paths: '<path d="M12 7v5l3 3" />', query: "a clock", score: 0.5 },
      { name: "bulb", paths: '<path d="M3 3" />', query: "an idea", score: 0.5 },
    ],
    items: ["time", "ideas"],
    left: "motivation", right: "systems",
    steps: ["first thing", "second thing", "third thing"],
    stat: { value: "3", label: "degrees" },
    curve: { points: [4, 10, 22, 48, 96], label: "compounding" },
    ...extra,
  };
}

test("every template renders, and no element is ever tweened twice at once", () => {
  for (const kind of ["kinetic-text", "quote", "icon-concept", "comparison", "steps", "timeline", "growth-curve", "stat"] as VisualKind[]) {
    const r = renderScene(sceneOf(kind), RECT);
    assert.ok(r, `${kind} renders`);
    assert.match(r!.markup, /data-scene="0"/);
    assert.ok(r!.anims.length > 0, `${kind} animates`);
    const overlaps = overlappingAnims(r!.anims);
    assert.deepEqual(overlaps, [], `${kind}: ${overlaps.join("; ")}`);
    // Every animated element exists in the markup it was declared against.
    for (const a of r!.anims) {
      if (a.e >= 0) assert.match(r!.markup, new RegExp(`data-el="${a.e}"`), `${kind} has element ${a.e}`);
    }
  }
});

test("book scenes have no layer of their own — the real page card is shown instead", () => {
  assert.equal(renderScene(sceneOf("book-page"), RECT), null);
  assert.equal(renderScene(sceneOf("book-crop"), RECT), null);
});

test("kinetic text puts each word on its own measured spoken time", () => {
  const r = renderScene(sceneOf("kinetic-text"), RECT)!;
  const words = sceneOf("kinetic-text").words!;
  const wordAnims = r.anims.filter((a) => a.e >= 0);
  assert.equal(wordAnims.length, words.length);
  wordAnims.forEach((a, i) => assert.equal(a.t, words[i].start));
});

test("scene text is escaped, so a closing script tag in book text cannot break the page", () => {
  const nasty = '</script><img src=x onerror=alert(1)>';
  const r = renderScene(sceneOf("quote", { quote: { text: nasty, page: 0 } }), RECT)!;
  assert.ok(!r.markup.includes("</script>"));
  assert.ok(!r.markup.includes("<img"));
  assert.match(r.markup, /&lt;\/script&gt;/);
});

test("scene CSS uses palette roles, never literal colours", () => {
  const css = sceneCss(bookThemeById("marginalia"), RECT);
  const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  const palette = new Set(Object.values(bookThemeById("marginalia").palette).map((v) => String(v).toLowerCase()));
  for (const h of hex) {
    assert.ok([...palette].some((p) => p.includes(h.toLowerCase())), `${h} is not a palette colour`);
  }
});

// --- composition integration ------------------------------------------------------

test("with no scenes the composition is exactly what it was before scenes existed", () => {
  const theme = bookThemeById("marginalia");
  const base = fixtureInput({ theme }) as unknown as CompositionInput;
  const html = buildComposition({ ...base, bookTitle: "Fixture" });
  assert.ok(!html.includes('class="sc"'), "no scene layers");
  assert.ok(!html.includes('id="scene-glow"'), "no glow layer");
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
  assert.deepEqual(data.anims, []);
  assert.equal(data.cardVis, null);
  assert.deepEqual(data.zooms, []);
  assert.deepEqual(data.scenes, []);
});

test("with scenes the composition carries the layers, the card's visibility, its zoom and the glow", () => {
  const theme = bookThemeById("marginalia");
  const base = fixtureInput({ theme }) as unknown as CompositionInput;
  const scenes: Scene[] = [
    { ...sceneOf("kinetic-text"), index: 0, start: 0, end: 4 },
    { ...sceneOf("book-page"), index: 1, start: 4, end: 8, tone: "warm" },
    { ...sceneOf("book-crop"), index: 2, start: 8, end: 11, tone: "warm", crop: { x0: 0, y0: 100, x1: 900, y1: 220 } },
    { ...sceneOf("stat"), index: 3, start: 11, end: 13.4, tone: "deep" },
  ];
  const html = buildComposition({ ...base, bookTitle: "Fixture", scenes });
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]);

  assert.equal(data.scenes.length, 4);
  assert.ok(html.includes('data-scene="0"') && html.includes('data-scene="3"'), "non-book scenes have layers");
  assert.ok(!html.includes('data-scene="1"'), "a book scene has no layer of its own");
  assert.ok(html.includes('id="scene-glow"') && html.includes('id="card-zoom"'));

  // Scene times are shifted onto the composition clock, like every other cue.
  assert.equal(data.scenes[1].start, AUDIO_OFFSET + 4);
  // The card is hidden for the opening kinetic-text scene and comes back for
  // the book scenes, then goes again for the stat.
  assert.equal(data.cardVis.start, 0);
  assert.deepEqual(data.cardVis.at.map((c: { v: number }) => c.v), [1, 0]);
  // The crop zooms in; the page scene before it sits at 1.
  assert.ok(data.zooms.length >= 1);
  assert.ok(data.zooms.every((z: { v: number }) => z.v >= 1 && z.v <= 1.8));
  assert.equal(data.glow.length, 4);

  const overlaps = overlappingAnims(data.anims);
  assert.deepEqual(overlaps, [], overlaps.join("; "));
});

test("the card's visibility changes once per run of page scenes, not once per scene", () => {
  const s = (i: number, kind: VisualKind): Scene => ({ ...sceneOf(kind), index: i, start: i * 4, end: i * 4 + 4 });
  const vis = cardVisibility([s(0, "book-page"), s(1, "book-crop"), s(2, "kinetic-text"), s(3, "stat"), s(4, "book-page")], 0);
  assert.equal(vis.start, 1, "the first scene shows the page, so the card starts visible");
  assert.deepEqual(vis.at.map((c) => c.v), [0, 1], "one fade out across the two middle scenes, one fade back");
});

test("a quote scene hides the page card: its own layer carries the book's words", () => {
  // The quote renders light text on its own layer. Leaving the page up behind
  // it put that text over a bright page, where a real render showed nothing.
  const s = (i: number, kind: VisualKind): Scene => ({ ...sceneOf(kind), index: i, start: i * 4, end: i * 4 + 4 });
  const vis = cardVisibility([s(0, "book-page"), s(1, "quote")], 0);
  assert.equal(vis.start, 1);
  assert.deepEqual(vis.at.map((c) => c.v), [0], "the card goes when the quote arrives");
  // It still counts as showing the book, for the floor.
  assert.ok(renderScene(s(1, "quote"), RECT), "and it does have a layer of its own");
});

test("a crop zoom is bounded, and a page scene returns the card to life size", () => {
  const s = (i: number, kind: VisualKind, crop?: Scene["crop"]): Scene => ({ ...sceneOf(kind), index: i, start: i * 4, end: i * 4 + 4, crop });
  const zooms = cardZooms([s(0, "book-crop", { x0: 0, y0: 0, x1: 900, y1: 60 }), s(1, "book-page")], 0, 1280);
  assert.ok(zooms[0].v > 1 && zooms[0].v <= 1.8, `zoom ${zooms[0].v}`);
  assert.equal(zooms[1].v, 1, "back to life size for the whole page");
  assert.deepEqual(glowKeys([s(0, "stat")], 0).length, 1);
});

// --- icons -------------------------------------------------------------------------

test("an icon's search text carries its name, category and tags", () => {
  assert.equal(iconText("chart-line", { category: "Charts", tags: ["graph", "growth"] }), "chart line. Charts. graph, growth");
});

test("nothing is returned when no icon means what was asked for", async () => {
  const icon = await resolveIcon("qwertyuiop asdfghjkl zxcvbnm", { embedder: lexicalEmbedder, minScore: 0.95 });
  assert.equal(icon, null);
});

test("the icon catalogue is found from the real package, not from a derived path", async () => {
  // The bug this guards: the package directory was derived as "three levels
  // above a resolved icon". Inside Next.js the resolver returns a virtual
  // path containing a `[project]` segment, so that arithmetic produced
  // `<cwd>/[project]/node_modules/@tabler/icons` and every icon lookup died
  // with ENOENT — which failed the whole "Planning the scenes" step.
  resetIconIndex();
  const index = await iconIndex(lexicalEmbedder);
  assert.ok(index.names.length > 3000, `${index.names.length} icons`);
  assert.equal(index.names.length, index.vectors.length);
  assert.ok(index.tagged, "the tag metadata was read, so matching is the strong kind");
  assert.ok(index.names.includes("clock") && index.names.includes("barrier-block"));
  // And the icons themselves are readable, which is what actually gets drawn.
  assert.match((await iconPaths("clock")) ?? "", /<path/);
  assert.equal(await iconPaths("definitely-not-an-icon"), null);
});

test("a missing icon package degrades to no icons, with a reason, instead of failing the video", async () => {
  // The original bug in its general form: the package could not be read, and
  // the exception took down the whole "Planning the scenes" step. Pointing the
  // lookup at a directory that does not exist reproduces that condition
  // without needing a bundler.
  const prev = process.env.BOOKREEL_TABLER_DIR;
  process.env.BOOKREEL_TABLER_DIR = path.join(os.tmpdir(), "bookreel-no-such-icons");
  resetIconIndex();
  takeIconTrouble();
  try {
    assert.deepEqual(await findIcons("a clock", 3, { embedder: lexicalEmbedder }), []);
    assert.match(takeIconTrouble() ?? "", /could not be found/);
    assert.equal(await iconPaths("clock"), null);
  } finally {
    if (prev === undefined) delete process.env.BOOKREEL_TABLER_DIR;
    else process.env.BOOKREEL_TABLER_DIR = prev;
    resetIconIndex();
  }
});

test("an icon lookup that fails is reported and returns no icon — it never throws", async () => {
  // Any breakage here (package gone, index unreadable, embedder down) must
  // degrade to "no icon for this phrase", which the caller already handles by
  // showing the narration. It must never fail the episode, which is exactly
  // what happened when the path was wrong.
  takeIconTrouble();
  const broken = {
    id: "broken-embedder",
    embed: async () => {
      throw new Error("embedder unavailable");
    },
  };
  resetIconIndex();
  const found = await findIcons("a clock and calendar", 3, { embedder: broken });
  assert.deepEqual(found, [], "no icons, no exception");
  assert.match(takeIconTrouble() ?? "", /embedder unavailable/, "and the reason is recorded for the notes");
  assert.equal(takeIconTrouble(), null, "reading it clears it");
  resetIconIndex();
});

// --- the whole plan, without a model -------------------------------------------------

test("with no director at all, the plan still covers the narration and is still grounded", async () => {
  const beats = [
    beat(0, "The impediment to action advances action. That is the claim."),
    beat(1, "What stands in the way becomes the way. It is a method."),
    beat(2, "Small habits compound over time. Follow for more."),
  ];
  const plan = await planScenes({
    bookTitle: "Meditations",
    beats,
    words: timed(beats, 0.55),
    pageWords: new Map([[0, PAGE_WORDS]]),
    cropFor: () => ({ x0: 0, y0: 0, x1: 900, y1: 120 }),
    hasPage: () => true,
    provider: "claude-cli",
    skipDirector: true,
  });
  assert.equal(plan.directed, false);
  assert.ok(plan.scenes.length >= 2, `${plan.scenes.length} scenes`);
  // Contiguous in time, covering the narration from first word to last.
  for (let i = 1; i < plan.scenes.length; i++) {
    assert.equal(plan.scenes[i].start, plan.scenes[i - 1].end, "scenes are contiguous");
  }
  assert.ok(plan.scenes.every((s) => s.kind === "kinetic-text" || s.kind === "book-page"));
  assert.ok(plan.scenes.every((s) => s.source.pageIndex === 0));
});
