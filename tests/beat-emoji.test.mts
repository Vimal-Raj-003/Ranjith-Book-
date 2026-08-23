import test from "node:test";
import assert from "node:assert/strict";
import {
  voScriptFromPackage,
  beatTexts,
  CONTENT_JSON_SCHEMA,
  type ContentPackage,
} from "../src/lib/content/schema";
import { buildSystemPrompt } from "../src/lib/content/prompt";

/**
 * Any emoji, any pictograph, any variation selector — the test never asks
 * "which emoji", only "is anything unspeakable left in here". A narrower
 * check would pass for the one emoji the fixture happens to use and miss the
 * next one.
 */
const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

const pkg = (): ContentPackage => ({
  title: "The two-minute rule",
  hook: "Most habits die in the first week.",
  hookKeywords: ["die", "first week"],
  ideaKey: "two-minute-rule",
  beats: [
    { id: "hook", emoji: "🕯️", voiceover: "Most habits die in the first week.", onScreen: "Week one", sourcePage: 0, startWord: 0, endWord: 12 },
    { id: "idea", emoji: "🧱", voiceover: "The page argues you start too big.", onScreen: "Start smaller", sourcePage: 0, startWord: 13, endWord: 40 },
    // No emoji at all: the field is optional in both directions, and a beat
    // without one must still produce its audio slot like any other.
    { id: "turn", voiceover: "Two minutes is not the goal. It is the door.", onScreen: "The door", sourcePage: 0, startWord: 41, endWord: 60 },
    { id: "cta", emoji: "📌", voiceover: "Follow for part two.", onScreen: "Part two tomorrow", sourcePage: 0, startWord: 61, endWord: 70 },
  ],
  cta: "Follow for part two.",
  description: "d",
  hashtags: ["books", "reading"],
  takeaway: ["Start smaller than feels useful."],
});

/**
 * The load-bearing test for §10 of the presentation spec. A speech engine
 * handed an emoji either skips it silently — dead air in the middle of a
 * sentence — or reads its name aloud ("candle", "brick"). `beatTexts` is what
 * actually reaches text-to-speech, one file per beat, so an emoji reaching
 * it is heard by every viewer.
 */
test("a beat's emoji never reaches the spoken script", () => {
  const p = pkg();
  const vo = voScriptFromPackage(p);

  assert.doesNotMatch(vo, PICTOGRAPHIC, "an emoji leaked into the full spoken script");
  assert.ok(vo.includes("Most habits die"), "the actual narration is still there");

  for (const [i, text] of beatTexts(p).entries()) {
    assert.doesNotMatch(text, PICTOGRAPHIC, `an emoji leaked into the audio text for beat ${i}`);
  }
});

test("the emoji field is carried on the beat, not spliced into onScreen or voiceover", () => {
  const p = pkg();
  assert.equal(p.beats[0].emoji, "🕯️", "the cue card still has an emoji to render");
  assert.equal(p.beats[2].emoji, undefined, "a beat with no honest emoji keeps none");
  assert.equal(beatTexts(p).length, p.beats.length, "every beat still owns its audio slot");
});

/**
 * The defensive net under the prompt: the CLI providers have no
 * structured-output mode, so a writer that puts the emoji in the line as well
 * as in the field cannot be rejected — only sanitised.
 */
test("an emoji written into voiceover itself is still stripped before speech", () => {
  const p = pkg();
  p.beats[0].voiceover = "Most habits die in the first week 🔥.";

  const texts = beatTexts(p);
  assert.doesNotMatch(texts[0], PICTOGRAPHIC);
  assert.ok(texts[0].startsWith("Most habits die"), "the sentence survives, only the emoji goes");
});

test("the JSON schema offers emoji but never demands it", () => {
  const beat = CONTENT_JSON_SCHEMA.properties.beats.items;
  const emoji = beat.properties.emoji as { type: string; maxLength: number };

  assert.equal(emoji.type, "string");
  assert.ok(
    emoji.maxLength <= 8,
    "the cap must admit one emoji, not a string of them or a sentence",
  );
  assert.ok(
    !(beat.required as readonly string[]).includes("emoji"),
    "a beat with no honest emoji must be allowed to have none",
  );
});

test("the prompt asks for one meaningful emoji per beat, and forbids repeats", () => {
  const s = buildSystemPrompt({ hasAuthor: true });
  assert.match(s, /emoji is optional/i);
  assert.match(s, /ONE emoji/);
  assert.match(s, /never the same emoji twice/i);
});

/**
 * §11: the purchase link is composed in code. If the prompt ever starts
 * inviting the writer to add one, it will invent a plausible-looking URL for
 * a book it cannot look up — published under the operator's name.
 */
test("the prompt tells the writer never to write a link", () => {
  const s = buildSystemPrompt({ hasAuthor: true });
  assert.match(s, /NEVER write a URL/);
  assert.doesNotMatch(s, /include (a )?link|add (a )?link|write the link/i);
});
