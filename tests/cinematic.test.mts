import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { chromium } from "playwright-core";
import { HERO_IDS, HERO_GUIDE, heroForText, heroMatch, heroCatalogue, isHeroId } from "../src/lib/video/scenes/heroes";
import { sentencesOf, capOpening, HOOK_MAX_SEC, HOOK_MIN_SEC } from "../src/lib/video/scenes/plan";
import { validateScenes, pickKeyword, pickLead, MAX_QUOTES, MAX_HERO_USES, CINEMATIC_SHARE, type ValidateContext } from "../src/lib/video/scenes/validate";
import { renderScene, overlappingAnims, sceneCss, isLightPalette, FULL_FRAME, cineRuntimeSource, DRIFT_EL, DRIFT_SCALE } from "../src/lib/video/scenes/render";
import { DIRECTOR_SCHEMA, DIRECTOR_SYSTEM, buildDirectorPrompt } from "../src/lib/video/scenes/director";
import { buildComposition, cardCineMoves, bokehField, AUDIO_OFFSET } from "../src/lib/video/composition/build";
import { bookThemeById } from "../src/lib/video/composition/themes";
import { lexicalEmbedder } from "../src/lib/analysis/embed";
import type { Beat } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";
import type { Scene, SceneSpec, VisualKind } from "../src/lib/video/scenes/types";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";
import type { CompositionInput } from "../src/lib/video/composition/build";

// --- fixtures ------------------------------------------------------------------

const beat = (i: number, voiceover: string, page = 0): Beat => ({ id: `b${i}`, voiceover, onScreen: "", sourcePage: page, startWord: 0, endWord: 9 });
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
  return {
    sentences: over.sentences ?? [],
    pageWords: new Map([[0, PAGE_WORDS]]),
    cropFor: () => ({ x0: 10, y0: 20, x1: 900, y1: 140 }),
    hasPage: () => true,
    locate: () => null,
    embedder: lexicalEmbedder,
    ...over,
  };
}
const spec = (from: number, to: number, kind: VisualKind, extra: Partial<SceneSpec> = {}) => ({ fromSentence: from, toSentence: to, from, to, kind, concept: "a thing", reason: "because", ...extra });

/** A twelve-sentence narration about time, habits, a book, a choice and a feeling. */
const NARRATION = [
  "Time is the one thing nobody gets back.",
  "Small steps every day build real progress.",
  "Reading a good book changes how you think.",
  "Your past can weigh you down like a chain.",
  "Every decision is a choice between two roads.",
  "Anger spreads like a feeling through a room.",
  "A single idea can change everything you do.",
  "Focus means ignoring almost everything else.",
  "Money grows when you let it compound.",
  "The challenge is a mountain, not a wall.",
  "Friends and family make a community.",
  "Follow for more.",
].map((t, i) => beat(i, t));

// --- the catalogue ---------------------------------------------------------------

test("every hero has a brief, and the matcher picks the object that fits the narration", () => {
  assert.equal(new Set(HERO_IDS).size, HERO_IDS.length);
  for (const id of HERO_IDS) assert.ok(HERO_GUIDE[id].shows.length > 5, id);
  assert.equal(heroForText("Time is running out before the deadline"), "hourglass");
  assert.equal(heroForText("Small steps and good habits build progress"), "staircase");
  assert.equal(heroForText("Reading a book changes how you learn"), "bookletters");
  assert.equal(heroForText("Your past is a burden that holds you back"), "chain");
  assert.equal(heroForText("Every decision is a choice about direction"), "path");
  assert.equal(heroForText("It compounds, and the gains pile up"), "growth");
  assert.equal(heroForText("zzz qqq xyzzy"), "orb", "nothing matches: the generic fallback, never an error");
  assert.equal(heroMatch("zzz qqq"), 0);
  assert.ok(heroMatch("time and deadline") >= 2);
});

test("a hero already used is skipped while a different one also matches", () => {
  const text = "Time passes and the past is a burden";
  const first = heroForText(text);
  const second = heroForText(text, [first]);
  assert.notEqual(first, second);
  assert.equal(heroForText(text, [first, second]), first, "when every match is used, the best match repeats rather than failing");
  assert.ok(isHeroId("mountain") && !isHeroId("dragon") && !isHeroId(undefined));
});

test("the director is offered exactly the heroes that exist, and told the rules of the opening and of variety", () => {
  const heroEnum = DIRECTOR_SCHEMA.properties.scenes.items.properties.hero.enum as readonly string[];
  assert.deepEqual([...heroEnum].sort(), [...HERO_IDS].sort());
  const kinds = DIRECTOR_SCHEMA.properties.scenes.items.properties.kind.enum as readonly string[];
  assert.ok(kinds.includes("cinematic"));
  assert.match(DIRECTOR_SYSTEM, /Scene 0 MUST be cinematic/);
  assert.match(DIRECTOR_SYSTEM, /At least 40% of the scenes must be cinematic/);
  assert.match(DIRECTOR_SYSTEM, /at most two quote scenes/);
  for (const id of HERO_IDS) assert.ok(heroCatalogue().includes(`- ${id} —`), id);
  const prompt = buildDirectorPrompt("Book", sentencesOf(NARRATION, timed(NARRATION)), new Map(), 11, "The hook line");
  assert.match(prompt, /The hook \(what scene 0 is about\): The hook line/);
});

// --- the runtime itself ----------------------------------------------------------

const runtimeSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "video", "scenes", "cine-runtime.js"), "utf8");

test("the runtime defines exactly the catalogue's heroes, and is the source the composition inlines", () => {
  const defined = [...runtimeSource.matchAll(/^\s*HEROES\.(\w+)\s*=\s*function/gm)].map((m) => m[1]);
  assert.deepEqual([...defined].sort(), [...HERO_IDS].sort());
  assert.equal(cineRuntimeSource(), runtimeSource);
});

test("the runtime compiles, and keeps the rules that make a render reproducible", () => {
  assert.doesNotThrow(() => new vm.Script(runtimeSource, { filename: "cine-runtime.js" }));
  const code = runtimeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Single-group geometries only: Cone/Cylinder/Box painted blank in a real screenshot render.
  for (const banned of ["CylinderGeometry", "ConeGeometry", "BoxGeometry", "CapsuleGeometry"]) {
    assert.ok(!code.includes(banned), `${banned} is multi-group`);
  }
  // A frame is a pure function of (hero, t, p): no clocks, no unseeded randomness, no network.
  for (const banned of ["Math.random", "Date.now", "performance.now", "requestAnimationFrame", "setTimeout", "setInterval", "fetch(", "XMLHttpRequest", "new Image"]) {
    assert.ok(!code.includes(banned), `${banned} would make a frame depend on more than (hero, t, p)`);
  }
  assert.match(code, /preserveDrawingBuffer:\s*true/, "the blit reads the buffer after the render call returns");
});

// --- the opening hook ------------------------------------------------------------

test("the video ALWAYS opens on a cinematic hook about its own topic — whatever the director chose", async () => {
  const sentences = sentencesOf(NARRATION, timed(NARRATION));
  for (const kind of ["book-page", "quote", "kinetic-text", "icon-concept", "stat"] as VisualKind[]) {
    const specs = sentences.map((s) => spec(s.index, s.index, s.index === 0 ? kind : "kinetic-text"));
    const r = await validateScenes(specs, ctx({ sentences, hook: { text: "Time is running out", keywords: ["time"] } }));
    assert.equal(r.scenes[0].kind, "cinematic", `scene 0 asked for ${kind}`);
    assert.equal(r.scenes[0].cine?.hook, true);
    assert.equal(r.scenes[0].cine?.hero, "hourglass", "the hero is about the hook's topic");
    assert.deepEqual(r.scenes[0].cine?.accentWords, ["time"]);
    assert.ok((r.scenes[0].words ?? []).length > 3, "the spoken hook sentence is carried for the type");
  }
});

test("a director's own hero for scene 0 is kept; a hero that does not exist is repaired from the narration", async () => {
  const sentences = sentencesOf(NARRATION, timed(NARRATION));
  const keep = await validateScenes([spec(0, 0, "cinematic", { hero: "mountain" }), ...sentences.slice(1).map((s) => spec(s.index, s.index, "kinetic-text"))], ctx({ sentences }));
  assert.equal(keep.scenes[0].cine?.hero, "mountain");
  const repaired = await validateScenes([spec(0, 0, "cinematic", { hero: "dragon" }), ...sentences.slice(1).map((s) => spec(s.index, s.index, "kinetic-text"))], ctx({ sentences }));
  assert.equal(repaired.scenes[0].cine?.hero, "hourglass", "'Time is the one thing nobody gets back' is about time");
});

test("the opening scene is capped at the first sentence boundary after 3 s, so a hook never outstays its welcome", () => {
  const sentences = sentencesOf(NARRATION, timed(NARRATION, 0.4));
  const wide = [{ fromSentence: 0, toSentence: 5 }, { fromSentence: 6, toSentence: 11 }];
  const out = capOpening(wide, sentences);
  assert.equal(out.length, 3);
  const span = sentences[out[0].toSentence].end - sentences[0].start;
  assert.ok(span >= HOOK_MIN_SEC && span <= HOOK_MAX_SEC + 3, `the hook runs ${span.toFixed(1)} s`);
  assert.deepEqual(capOpening([{ fromSentence: 0, toSentence: 0 }, { fromSentence: 1, toSentence: 11 }], sentences)[0], { fromSentence: 0, toSentence: 0 });
  // a single long sentence has no boundary to cut on
  const oneLong = sentencesOf([beat(0, Array.from({ length: 30 }, () => "word").join(" ") + ".")], timed([beat(0, Array.from({ length: 30 }, () => "word").join(" ") + ".")]));
  assert.equal(capOpening([{ fromSentence: 0, toSentence: 0 }], oneLong).length, 1);
});

// --- keyword and lead are always words the narrator says ---------------------------

test("type on screen can only be words that are spoken", () => {
  const words = "Small habits compound over time".split(" ").map((w, i) => ({ word: w, start: i, end: i + 0.5 }));
  assert.equal(pickKeyword("habits", words), "habits");
  assert.equal(pickKeyword("compound over", words), "compound over");
  assert.equal(pickKeyword("invented thing", words), "compound", "an unspoken keyword is replaced by an emphasised spoken word");
  assert.equal(pickKeyword(undefined, words), "compound");
  assert.equal(pickKeyword("a b c d", words), "compound", "more than two words is not a keyword");
  assert.equal(pickLead("small", "habits", words), "Small");
  assert.equal(pickLead("totally made up", "habits", words), "Small", "an unspoken lead is replaced by the words before the keyword");
  assert.equal(pickLead(undefined, "small", words), "", "a keyword that opens the sentence has no lead");
});

// --- visual variety --------------------------------------------------------------

test("a plan of plain text and quote cards is turned into a varied one: cinematic share, quote cap, no repeated hero", async () => {
  const sentences = sentencesOf(NARRATION, timed(NARRATION));
  const specs = sentences.map((s, i) => spec(s.index, s.index, i % 3 === 2 ? "quote" : "kinetic-text", i % 3 === 2 ? { quote: "What stands in the way becomes the way" } : {}));
  const c = ctx({ sentences, locate: () => ({ text: "What stands in the way becomes the way", startWord: 0, endWord: 5 }) });
  const r = await validateScenes(specs, c);
  const n = r.scenes.length;
  const cine = r.scenes.filter((s) => s.kind === "cinematic");
  assert.ok(cine.length >= Math.ceil(n * CINEMATIC_SHARE), `${cine.length} of ${n} are cinematic`);
  assert.ok(r.scenes.filter((s) => s.kind === "quote").length <= MAX_QUOTES);
  const heroes = cine.map((s) => s.cine!.hero);
  for (let i = 1; i < r.scenes.length; i++) {
    const a = r.scenes[i - 1].cine?.hero, b = r.scenes[i].cine?.hero;
    assert.ok(!a || !b || a !== b, `scenes ${i - 1},${i} share the ${a} hero`);
  }
  for (const h of new Set(heroes)) assert.ok(heroes.filter((x) => x === h).length <= MAX_HERO_USES, `${h} used too often`);
  // Timing and sources are untouched by any of this.
  for (let i = 1; i < r.scenes.length; i++) assert.equal(r.scenes[i].start, r.scenes[i - 1].end === r.scenes[i].start ? r.scenes[i - 1].end : r.scenes[i].start);
  assert.ok(r.scenes.every((s) => s.source.pageIndex === 0 && s.end > s.start));
  assert.ok(r.notes.some((m) => /cinematic/.test(m)));
});

test("the narration's own concepts choose each scene's hero", async () => {
  const sentences = sentencesOf(NARRATION, timed(NARRATION));
  const r = await validateScenes(sentences.map((s) => spec(s.index, s.index, "cinematic")), ctx({ sentences }));
  const hero = (i: number) => r.scenes[i].cine?.hero;
  assert.equal(hero(1), "staircase");
  assert.equal(hero(2), "bookletters");
  assert.equal(hero(3), "chain");
  assert.equal(hero(4), "path");
  assert.equal(hero(9), "mountain");
  assert.equal(hero(10), "network");
});

// --- rendering --------------------------------------------------------------------

function cineScene(over: Partial<Scene> = {}, cine: Partial<NonNullable<Scene["cine"]>> = {}): Scene {
  return {
    index: 3, kind: "cinematic", start: 10, end: 16, tone: "deep", sentences: [0], beatIndex: 0,
    source: { pageIndex: 0, startWord: 0, endWord: 3 }, reason: "r", concept: "time",
    words: "Time is the one thing nobody gets back".split(" ").map((w, i) => ({ word: w, start: 10.4 + i * 0.4, end: 10.7 + i * 0.4 })),
    cine: { hero: "hourglass", keyword: "time", lead: "", ...cine },
    ...over,
  };
}
const RECT = { x: 60, y: 250, w: 960, h: 1120 };

test("a cinematic scene is a full-frame layer: hero canvas, bloom, fallback glow, and the keyword set letter by letter", () => {
  const r = renderScene(cineScene({}, { keyword: "time & tide", lead: "It is" }), RECT, "#d9531e")!;
  assert.match(r.markup, /class="sc sc-cine"/);
  assert.match(r.markup, new RegExp(`left:0px;top:0px;width:${FULL_FRAME.w}px;height:${FULL_FRAME.h}px`), "not confined to the page card");
  assert.match(r.markup, /<canvas class="cine-canvas" data-el="0"/);
  assert.match(r.markup, /<canvas class="cine-bloom" data-el="1"/);
  assert.match(r.markup, /class="cine-fallback"/);
  assert.match(r.markup, /class="cine-lead"[^>]*>It is</);
  assert.equal((r.markup.match(/class="cine-letter"/g) ?? []).length, "time&tide".length, "one element per letter, not per space");
  assert.match(r.markup, /time &amp; tide|t<\/span>/);
  assert.deepEqual(overlappingAnims(r.anims), []);
  const cine = r.anims.filter((a) => a.k === "cine");
  assert.equal(cine.length, 1);
  assert.equal(cine[0].hero, "hourglass");
  assert.equal(cine[0].t, 10);
  assert.equal(cine[0].d, 6);
  assert.ok(r.anims.filter((a) => a.k === "focus").length >= "time&tide".length + 1, "a rack-focus reveal per letter and for the lead");
});

test("the keyword arrives on the exact spoken time of that word", () => {
  const r = renderScene(cineScene({}, { keyword: "nobody" }), RECT, "#d9531e")!;
  const focus = r.anims.filter((a) => a.k === "focus").map((a) => a.t).sort((a, b) => a - b);
  // "nobody" is the 6th spoken word, at 10.4 + 5 * 0.4
  assert.ok(Math.abs(focus[0] - 12.4) < 0.001, `the first letter lands at ${focus[0]}`);
  assert.ok(focus[1] > focus[0], "then the letters follow, one after another");
});

test("the hook layer rests visible, because it owns frame zero, and shows the spoken sentence word by word", () => {
  const hook = cineScene({ index: 0, start: 0, end: 4 }, { hook: true, accentWords: ["time"] });
  const r = renderScene(hook, RECT, "#d9531e")!;
  assert.match(r.markup, /class="sc sc-cine sc-first"/);
  assert.ok(!r.anims.some((a) => a.e === -1 && a.k !== "out"), "the layer itself has only an exit, like the old hook card");
  assert.equal((r.markup.match(/class="sc-word/g) ?? []).length, 8, "one element per spoken word");
  assert.match(r.markup, /sc-word sc-word-emph" data-el="2">Time</, "the hook's accent word is emphasised");
  assert.deepEqual(overlappingAnims(r.anims), []);
  const firstWord = r.anims.find((a) => a.e === 2)!;
  assert.ok(Math.abs(firstWord.t - 10.4) < 0.001, "each word arrives at its measured start");
});

test("a quote card and kinetic text drift closer for the whole scene — type on a plain page is never a still", () => {
  for (const kind of ["quote", "kinetic-text"] as const) {
    const scene = cineScene({ kind, start: 20, end: 31, quote: { text: "free from all contentiousness", page: 3 }, cine: undefined });
    const r = renderScene(scene, RECT, "#d9531e")!;
    const drift = r.anims.filter((a) => a.k === "drift");
    assert.equal(drift.length, 1, kind);
    assert.deepEqual([drift[0].e, drift[0].t, drift[0].d, drift[0].v], [DRIFT_EL, 20, 11, DRIFT_SCALE], kind);
    assert.equal((r.markup.match(/data-drift/g) ?? []).length, 1, `${kind}: exactly one wrapper carries it`);
    assert.deepEqual(overlappingAnims(r.anims), [], kind);
  }
});

test("scene text is escaped, so a closing script tag in a keyword cannot break the page", () => {
  const r = renderScene(cineScene({}, { keyword: "x", lead: "</script><b>" }), RECT, "#d9531e")!;
  assert.ok(!r.markup.includes("</script>"));
});

test("cinematic CSS follows the theme: light on paper themes, dark on film themes, only palette colours", () => {
  assert.equal(isLightPalette(bookThemeById("editorial").palette.backdropDeep), true);
  assert.equal(isLightPalette(bookThemeById("marginalia").palette.backdropDeep), false);
  for (const id of ["marginalia", "editorial", "terminal", "spotlight", "blueprint"]) {
    const theme = bookThemeById(id);
    const css = sceneCss(theme, RECT);
    for (const cls of [".cine-canvas", ".cine-bloom", ".cine-fallback", ".cine-key", ".cine-lead", ".cine-hook", ".sc-first"]) assert.ok(css.includes(cls), `${id}: ${cls}`);
    const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    const palette = new Set(Object.values(theme.palette).map((v) => String(v).toLowerCase()));
    for (const h of hex) assert.ok([...palette].some((p) => p.includes(h.toLowerCase())), `${id}: ${h} is not a palette colour`);
  }
});

// --- the composition --------------------------------------------------------------

const fixture = (themeId: string, opts: { withScenes?: boolean; cinematic?: boolean } = {}) =>
  fixtureInput({ theme: bookThemeById(themeId), ...opts }) as unknown as CompositionInput;
function composition(themeId: string, cinematic = true): string {
  return buildComposition({ ...fixture(themeId, { withScenes: true, cinematic }), bookTitle: "The Fixture Book" });
}

test("a composition with a cinematic scene inlines the engine and three.js; one without does not", () => {
  const withCine = composition("marginalia");
  assert.match(withCine, /window\.CINE = \{ create: create/);
  assert.match(withCine, /three@0\.160\.0\/build\/three\.min\.js" integrity="sha384-/);
  const without = composition("marginalia", false);
  assert.ok(!without.includes("window.CINE = {"), "a plan with no hero scene does not pay for the engine");
});

test("the cinematic hook replaces the scrim card, starts at frame zero, and the data records it", () => {
  const html = composition("editorial");
  assert.ok(!html.includes('id="hook"'), "no scrim-over-the-page hook card");
  const data = JSON.parse(/<script id="composition-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
  assert.equal(data.hook, null);
  assert.equal(data.scenes[0].kind, "cinematic");
  assert.equal(data.scenes[0].start, 0, "the hook scene starts at frame zero, not after the lead-in");
  assert.equal(data.scenes[1].start, AUDIO_OFFSET + 2.0);
  assert.equal(data.cineLight, true);
  assert.ok(data.anims.some((a: { k: string }) => a.k === "cine"));
  assert.equal(composition("marginalia").includes('"cineLight":false'), true);
});

test("a scene's words arrive when they are HEARD: word times shift by the lead-in like every other time on a scene", () => {
  const anim = (html: string, scene: number, el: number) => {
    const data = JSON.parse(/<script id="composition-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
    return (data.anims as { s: number; e: number; t: number }[]).find((a) => a.s === scene && a.e === el)!;
  };
  // The fixture's narration says "A" at 0.1 s, "quiet" at 0.6 s of the VOICE track, which starts AUDIO_OFFSET into the video.
  const hook = composition("marginalia");
  assert.ok(Math.abs(anim(hook, 0, 2).t - (AUDIO_OFFSET + 0.1)) < 0.002, "the hook's first word");
  assert.ok(Math.abs(anim(hook, 0, 3).t - (AUDIO_OFFSET + 0.6)) < 0.002, "the hook's second word");
  const plain = buildComposition({ ...fixture("marginalia", { withScenes: true }), bookTitle: "T" });
  assert.ok(Math.abs(anim(plain, 0, 0).t - (AUDIO_OFFSET + 0.1)) < 0.002, "kinetic text: the first word");
  assert.ok(Math.abs(anim(plain, 0, 1).t - (AUDIO_OFFSET + 0.6)) < 0.002, "kinetic text: the second word");
});

test("a beat's highlight lands on the page it cites, even when the book's page numbers are not 0, 1, 2 (a PDF slice)", () => {
  const dataOf = (input: CompositionInput) =>
    JSON.parse(/<script id="composition-data" type="application\/json">([\s\S]*?)<\/script>/.exec(buildComposition({ ...input, bookTitle: "T" }))![1]) as {
      strokes: { y: number }[];
    };
  const base = fixture("marginalia", { withScenes: true });
  const bookNumbers = [2, 8, 10]; // the pages of the book this slice shows
  const numbered: CompositionInput = {
    ...base,
    pages: base.pages.map((p, i) => ({ ...p, pageIndex: bookNumbers[i] })),
    pkg: { ...base.pkg, beats: base.pkg.beats.map((b) => ({ ...b, sourcePage: bookNumbers[b.sourcePage] })) },
  };
  const byPosition = dataOf(base).strokes;
  assert.deepEqual(dataOf(numbered).strokes, byPosition, "same strokes as when page numbers happen to equal positions");
  // Without the numbers a beat citing page 8 or 10 is clamped onto the LAST page: the bug this guards.
  assert.notDeepEqual(dataOf({ ...numbered, pages: base.pages }).strokes, byPosition);
});

test("without scenes the old hook card is still drawn: photo episodes are unchanged", () => {
  const html = buildComposition({ ...fixture("editorial"), bookTitle: "T" });
  assert.ok(html.includes('id="hook"'));
  assert.ok(!html.includes('<div class="cine-vignette">') && !html.includes('class="sc sc-cine'));
});

test("every page scene gets a perspective camera move; they alternate and never overlap", () => {
  const scenes = fixture("editorial", { withScenes: true, cinematic: true }).scenes as Scene[];
  const moves = cardCineMoves(scenes, AUDIO_OFFSET);
  assert.equal(moves.length, scenes.filter((s) => s.kind === "book-page" || s.kind === "book-crop").length);
  assert.ok(moves.length >= 2);
  for (let i = 1; i < moves.length; i++) {
    assert.ok(moves[i - 1].t + moves[i - 1].d <= moves[i].t, "no two moves tween the card's transform at once");
    assert.equal(Math.sign(moves[i].from.ry), -Math.sign(moves[i - 1].from.ry), "directions alternate");
  }
  for (const m of moves) assert.ok(Math.abs(m.to.ry) < Math.abs(m.from.ry) && m.to.s > m.from.s, "each move settles and pushes in");
});

test("the bokeh is seeded: the same plan renders the same light every time", () => {
  assert.deepEqual(bokehField(), bokehField());
  assert.equal(bokehField().length, 11);
});

// --- live browser -----------------------------------------------------------------

/** A browser step that can never hang a run: a page that stops answering fails the test instead. */
const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

async function withPage<T>(html: string, run: (page: import("playwright-core").Page, errors: string[]) => Promise<T>, init?: string): Promise<T> {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await within(page.setContent(init ? html.replace("<head>", `<head>\n<script>${init}</script>`) : html, { waitUntil: "load" }), 30_000, "load");
    await within(page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl), null, { timeout: 30_000 }), 35_000, "timeline");
    await new Promise((r) => setTimeout(r, 1500)); // the CDN scripts finish evaluating
    return await within(run(page, errors), 150_000, "the test body");
  } finally {
    await browser.close();
  }
}
/**
 * Seeks the timeline the way the renderer does: with events NOT suppressed (HyperFrames' own
 * GSAP adapter), so the hero's onUpdate fires on every seek. Returns nothing on purpose: a
 * GSAP timeline cannot be serialised out of the page.
 */
const seek = (page: import("playwright-core").Page, t: number) =>
  within(
    page.evaluate((time) => {
      (window as unknown as { __tl: { seek(t: number, suppressEvents: boolean): void } }).__tl.seek(time, false);
      return 1;
    }, t),
    30_000,
    `seek to ${t}`,
  );
/** The visible hero canvas of scene `i`: how many pixels are painted, and a fingerprint of them. */
const heroPixels = (page: import("playwright-core").Page, scene: number) =>
  page.evaluate((i) => {
    const c = document.querySelector(`[data-scene="${i}"] canvas.cine-canvas`) as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    const samples: number[] = [];
    for (let k = 0; k < d.length; k += 4 * 7) {
      if (d[k + 3] > 8) painted++;
      samples.push(d[k], d[k + 1], d[k + 2], d[k + 3]);
    }
    return { painted: painted * 4, samples, visible: getComputedStyle(c).visibility, opacity: getComputedStyle(c).opacity };
  }, scene);
/** How different two frames are: the share of samples that changed by more than rounding noise, and the largest change. */
const frameDiff = (a: number[], b: number[]) => {
  let big = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Math.abs(a[i] - b[i]);
    if (x > max) max = x;
    if (x > 6) big++;
  }
  return { share: big / a.length, max };
};

test("the opening frame is already a drawn hero (live browser, both light and dark themes)", async () => {
  for (const id of ["editorial", "marginalia"]) {
    await withPage(composition(id), async (page, errors) => {
      await seek(page, 0);
      const px = await heroPixels(page, 0);
      assert.equal(px.visible, "visible", `${id}: the hero canvas is revealed at t=0`);
      assert.ok(px.painted > 3000, `${id}: ${px.painted} painted samples at frame zero`);
      const layer = await page.evaluate(() => {
        const el = document.querySelector('[data-scene="0"]') as HTMLElement;
        return { o: getComputedStyle(el).opacity, v: getComputedStyle(el).visibility };
      });
      assert.deepEqual(layer, { o: "1", v: "visible" }, `${id}: the hook layer shows at frame zero`);
      assert.deepEqual(errors, [], `${id}: no page errors`);
    });
  }
});

test("a hero frame depends only on the instant, however it was reached: cold seek, seek away, seek back (live browser)", async () => {
  await withPage(composition("editorial"), async (page) => {
    await seek(page, 5.9);
    const cold = await heroPixels(page, 2);
    assert.ok(cold.painted > 1500, `the hourglass is drawn on a cold seek into its middle (${cold.painted} painted samples)`);
    await seek(page, 1.2);
    await seek(page, 11.8);
    await seek(page, 5.9);
    const warm = await heroPixels(page, 2);
    // GPU rasterisation is not bit-exact (a handful of edge samples differ by 1–3 levels run to run),
    // so "the same pixels" means: nothing visible differs.
    const same = frameDiff(cold.samples, warm.samples);
    assert.ok(same.share < 0.0005 && same.max <= 8, `same instant, same picture: ${JSON.stringify(same)}`);
    await seek(page, 6.4);
    const later = await heroPixels(page, 2);
    assert.ok(frameDiff(cold.samples, later.samples).share > 0.002, "…and the hero really does move between instants");
  });
});

test("the keyword is legible at its time: it arrives out of focus and finishes sharp (live browser)", async () => {
  await withPage(composition("marginalia"), async (page) => {
    const state = (t: number) => seek(page, t).then(() => page.evaluate(() => {
      const el = document.querySelector('[data-scene="2"] .cine-letter') as HTMLElement;
      const cs = getComputedStyle(el);
      return { o: Number(cs.opacity), f: cs.filter };
    }));
    // The fixture's scene 2 is on screen 5.0–7.3 s; "idea" is heard at 4.9 s of the voice + the 0.7 s lead-in.
    const before = await state(5.3);
    const during = await state(5.85);
    const after = await state(6.5);
    assert.equal(before.o, 0, "hidden before its word is spoken");
    assert.ok(during.o > 0 && during.o < 1 && /blur/.test(during.f) && during.f !== "blur(0px)", `mid-reveal: ${JSON.stringify(during)}`);
    assert.equal(after.o, 1);
    assert.ok(after.f === "blur(0px)" || after.f === "none", `sharp afterwards: ${after.f}`);
  });
});

test("with no WebGL the scene degrades to type on a glow — never a blank, never an error (live browser)", async () => {
  const noGl = `(function(){var g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t){if(t&&String(t).indexOf("webgl")===0||t==="experimental-webgl")return null;return g.apply(this,arguments);};})();`;
  await withPage(composition("editorial"), async (page, errors) => {
    await seek(page, 5.9);
    const s = await page.evaluate(() => {
      const scene = document.querySelector('[data-scene="2"]') as HTMLElement;
      const fb = scene.querySelector(".cine-fallback") as HTMLElement;
      const canvas = scene.querySelector("canvas.cine-canvas") as HTMLElement;
      const letter = scene.querySelector(".cine-letter") as HTMLElement;
      return { fb: getComputedStyle(fb).display, canvas: getComputedStyle(canvas).visibility, letter: Number(getComputedStyle(letter).opacity), layer: Number(getComputedStyle(scene).opacity) };
    });
    assert.notEqual(s.fb, "none", "the fallback glow is showing");
    assert.equal(s.canvas, "hidden", "the canvas never revealed");
    assert.ok(s.layer > 0.9 && s.letter > 0.9, "the layer and its type are on screen");
    assert.deepEqual(errors, []);
  }, noGl);
});
