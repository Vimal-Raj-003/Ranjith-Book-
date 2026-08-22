import test from "node:test";
import assert from "node:assert/strict";
import { buildComposition, AUDIO_OFFSET, OUTRO_TAIL } from "../src/lib/video/composition/build";
import { marginalia } from "../src/lib/video/composition/themes/marginalia";

const input = () => ({
  pkg: {
    title: "T", hook: "A hook.", ideaKey: "k", cta: "Follow.", description: "", hashtags: [], takeaway: [],
    beats: [
      { id: "hook", voiceover: "A hook.", onScreen: "Hook", sourcePage: 0, startWord: 0, endWord: 2 },
      { id: "cta", voiceover: "Follow.", onScreen: "Follow", sourcePage: 0, startWord: 3, endWord: 5 },
    ],
  },
  beats: [
    { index: 0, text: "A hook.", file: "b0.wav", start: 0, end: 2, speechStart: 0.1, speechEnd: 1.9 },
    { index: 1, text: "Follow.", file: "b1.wav", start: 2, end: 4, speechStart: 2.1, speechEnd: 3.9 },
  ],
  captions: [{ text: "A hook.", start: 0.1, end: 1.9, beatIndex: 0, words: [] }],
  pages: [{ src: "assets/page-00.jpg", width: 1000, height: 1400 }],
  sweeps: [
    [{ box: { x0: 0, y0: 0, x1: 500, y1: 40 }, start: 0.1, end: 1.9 }],
    [{ box: { x0: 0, y0: 60, x1: 500, y1: 100 }, start: 2.1, end: 3.9 }],
  ],
  camera: [{ t: 0, y: 0 }, { t: 4, y: 100 }],
  theme: marginalia,
  totalDuration: 4,
});

test("the composition is one self-contained file with a paused timeline", () => {
  const html = buildComposition(input());

  assert.ok(html.includes("<style"), "CSS is inline");
  assert.ok(!html.includes("<link rel=\"stylesheet\""), "nothing is fetched at render time");
  assert.match(html, /\.pause\(\)|paused:\s*true/, "the timeline must start paused — the renderer seeks it");
});

test("no CSS animation survives into the output", () => {
  const html = buildComposition(input());
  assert.doesNotMatch(html, /@keyframes|animation\s*:/, "seeking cannot reproduce a CSS animation's state");
});

test("nothing is random at render time", () => {
  const html = buildComposition(input());
  assert.doesNotMatch(html, /Math\.random/, "two renders of one frame must be identical");
});

test("every fromTo away from zero disables immediate render", () => {
  const html = buildComposition(input());
  const fromTos = html.match(/fromTo\(/g) ?? [];
  const guarded = html.match(/immediateRender:\s*false/g) ?? [];
  assert.ok(
    guarded.length >= fromTos.length,
    `${fromTos.length} fromTo calls but only ${guarded.length} immediateRender guards — a chain of them parks elements at the wrong offset`,
  );
});

test("a closing script tag in page text cannot end the embedded JSON early", () => {
  const evil = input();
  evil.pkg.beats[0].onScreen = "</script><b>gotcha";

  const html = buildComposition(evil);
  const payload = html.split("id=\"composition-data\"")[1] ?? "";
  assert.ok(!payload.slice(0, 4000).includes("</script><b>"), "'<' must be escaped inside embedded JSON");
});

test("the timeline runs at least as long as the audio", () => {
  const html = buildComposition(input());
  const match = html.match(/data-duration="([\d.]+)"/);
  assert.ok(match, "the duration is declared for the renderer");
  assert.ok(Number(match![1]) >= 4, "a composition shorter than its audio truncates the CTA");
});

// --- Beyond the brief's six -------------------------------------------------

test("escaping holds everywhere embedded data is written, not just in the JSON payload", () => {
  const evil = input();
  const nasty = `</script><tag>&"'`;
  evil.pkg.beats[0].onScreen = nasty;
  evil.captions[0].text = nasty;

  const html = buildComposition(evil);

  // If any of these characters closed a tag early, the document would not
  // have exactly the real <script> tags this composition actually declares
  // (gsap from the CDN, the JSON data island, the timeline script).
  const opens = html.match(/<script[\s>]/g) ?? [];
  const closes = html.match(/<\/script>/g) ?? [];
  assert.equal(opens.length, 3, "gsap cdn + composition-data + timeline js");
  assert.equal(closes.length, 3);

  // The on-screen label is written directly as markup (the cue card), not
  // through textContent — a raw "<tag>" appearing verbatim means that site's
  // escaping is missing even though the JSON site (checked below) is fine.
  assert.ok(!html.includes("<tag>"), "onScreen text must be HTML-escaped where it is written as literal markup");
  assert.ok(html.includes("data-cue=\"0\""), "the cue card for beat 0 must still exist");

  // The caption text travels through the JSON payload instead (read back by
  // the runtime script and assigned via .textContent). That site's escaping
  // is what the brief's own test exercises for onScreen; this asserts the
  // SAME escaping covers a caption's text too, closing the "only one site"
  // gap the task called out by name.
  const payload = html.split("id=\"composition-data\"")[1] ?? "";
  assert.ok(!payload.slice(0, 4000).includes("</script><tag>"), "caption text must be escaped inside the JSON payload too");
});

test("zero sweep steps still produces a valid composition (alignment failure is non-fatal)", () => {
  const degraded = input();
  degraded.sweeps = degraded.beats.map(() => []); // every beat's alignment failed

  const html = buildComposition(degraded);

  assert.ok(html.includes("<style"));
  assert.match(html, /paused:\s*true/);
  assert.ok(!html.includes("<div class=\"stroke\""), "no geometry means no stroke elements, not broken ones");
  assert.match(html, /class="page"/, "the page itself must still render");
  assert.match(html, /id="captions"/, "captions must still render with no highlight");
});

test("the declared duration covers the audio's own lead-in, not just its length plus the outro", () => {
  const html = buildComposition(input());
  const match = html.match(/data-duration="([\d.]+)"/);
  assert.ok(match);
  // totalDuration (4) + AUDIO_OFFSET (the audio element itself starts late,
  // per data-start on <audio>) + OUTRO_TAIL — a duration that only accounted
  // for totalDuration + OUTRO_TAIL would truncate the last AUDIO_OFFSET
  // seconds of the CTA hold.
  const expected = 4 + AUDIO_OFFSET + OUTRO_TAIL;
  assert.ok(Math.abs(Number(match![1]) - expected) < 1e-6, `expected ${expected}, got ${match![1]}`);
});

test("two strokes adjacent in time do not overlap", () => {
  const html = buildComposition(input());
  const match = html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, "the JSON data island must exist");
  const data = JSON.parse(match![1]) as { strokes: { start: number; end: number }[] };

  assert.ok(data.strokes.length >= 2, "the fixture has strokes from two different beats");
  for (let i = 1; i < data.strokes.length; i++) {
    assert.ok(
      data.strokes[i].start >= data.strokes[i - 1].end - 1e-9,
      `stroke ${i} starts (${data.strokes[i].start}) before stroke ${i - 1} ends (${data.strokes[i - 1].end})`,
    );
  }
});
