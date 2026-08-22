import test from "node:test";
import assert from "node:assert/strict";
import { voScriptFromPackage, beatTexts, type ContentPackage } from "../src/lib/content/schema";
import { buildSystemPrompt, buildUserPrompt } from "../src/lib/content/prompt";
import type { GenerateInput } from "../src/lib/content/schema";

const pkg = (): ContentPackage => ({
  title: "The two-minute rule",
  hook: "Most habits die in the first week.",
  hookKeywords: ["die", "first week"],
  ideaKey: "two-minute-rule",
  beats: [
    { id: "hook", voiceover: "Most habits die in the first week.", onScreen: "Week one", sourcePage: 0, startWord: 0, endWord: 12 },
    { id: "idea", voiceover: "The page argues you start too big.", onScreen: "Start smaller", sourcePage: 0, startWord: 13, endWord: 40 },
    { id: "cta", voiceover: "Follow for part two.", onScreen: "Part two tomorrow", sourcePage: 0, startWord: 41, endWord: 50 },
  ],
  cta: "Follow for part two.",
  description: "d",
  hashtags: ["books", "reading"],
  takeaway: ["Start smaller than feels useful."],
});

test("the spoken script is the beats in order, and nothing else", () => {
  const vo = voScriptFromPackage(pkg());
  assert.ok(vo.startsWith("Most habits die"));
  assert.ok(vo.endsWith("Follow for part two."));
  assert.ok(!vo.includes("Week one"), "on-screen labels are shown, not spoken");
});

test("one text per beat, because each becomes its own audio file", () => {
  assert.equal(beatTexts(pkg()).length, 3, "beat boundaries must be measurable, not estimated");
});

test("with no verified author, the prompt forbids naming one", () => {
  const s = buildSystemPrompt({ hasAuthor: false });
  assert.match(s, /do not name|never name|no author/i);
});

test("with a verified author, the prompt does not forbid it", () => {
  const s = buildSystemPrompt({ hasAuthor: true });
  assert.doesNotMatch(s, /do not name the author/i);
});

test("the prompt tells the model to split a beat at a page boundary, not draw one beat from two pages", () => {
  // Review finding 3: nothing previously told the model a beat is scoped to
  // one page, so an idea running from page N onto page N+1 could legally
  // become one schema-valid beat whose sourcePage/word range name only one
  // of the two pages while its voiceover draws on both — the marker sweeps
  // the named page correctly while the narration describes a page the
  // viewer never sees highlighted. This asserts the fix is actually present
  // in the prompt the model receives, not just documented in a comment.
  const s = buildSystemPrompt({ hasAuthor: true });
  assert.match(
    s,
    /one page/i,
    "the index rule must state a beat covers words on a single page",
  );
  assert.match(
    s,
    /(two|consecutive) beats/i,
    "the index rule must instruct writing two consecutive beats when an idea continues onto the next page",
  );
  assert.match(s, /page boundary/i, "the split must be described as happening at the page boundary");
});

test("voScriptFromPackage: an empty or whitespace-only beat contributes no double space or stray edge space", () => {
  const withBlank: ContentPackage = {
    ...pkg(),
    beats: [
      { id: "hook", voiceover: "Most habits die in the first week.", onScreen: "Week one", sourcePage: 0, startWord: 0, endWord: 12 },
      { id: "filler", voiceover: "   ", onScreen: "", sourcePage: 0, startWord: 13, endWord: 13 },
      { id: "blank", voiceover: "", onScreen: "", sourcePage: 0, startWord: 14, endWord: 14 },
      { id: "cta", voiceover: "Follow for part two.", onScreen: "Part two tomorrow", sourcePage: 0, startWord: 41, endWord: 50 },
    ],
  };
  const vo = voScriptFromPackage(withBlank);
  assert.ok(!vo.includes("  "), "no double space from a blank beat");
  assert.equal(vo, vo.trim(), "no leading or trailing space");
  assert.equal(vo, "Most habits die in the first week. Follow for part two.");
});

test("beatTexts preserves order and count exactly, so index alignment with audio files holds", () => {
  const original = pkg();
  const texts = beatTexts(original);
  assert.equal(texts.length, original.beats.length);
  texts.forEach((t, i) => {
    assert.equal(t, original.beats[i].voiceover.trim(), `beat ${i} text must correspond to beat ${i}`);
  });

  // Even a blank beat keeps its slot — a downstream audio file at index i
  // must always name beat i, never a beat shifted by a dropped blank.
  const withBlank: ContentPackage = {
    ...original,
    beats: [
      original.beats[0],
      { id: "blank", voiceover: "", onScreen: "", sourcePage: 0, startWord: 0, endWord: 0 },
      original.beats[1],
    ],
  };
  const blankTexts = beatTexts(withBlank);
  assert.equal(blankTexts.length, 3);
  assert.equal(blankTexts[1], "");
});

const genInput = (author: string | null): GenerateInput => ({
  bookTitle: "Atomic Habits",
  author,
  archetype: "howto",
  rightsStatus: "in-copyright",
  ideaKey: "two-minute-rule",
  avoidHooks: [],
  pages: [
    { pageIndex: 0, chapterHeading: "Chapter One", words: ["The", "first", "sentence."] },
    { pageIndex: 3, chapterHeading: null, words: ["Another", "page", "entirely."] },
  ],
});

test("buildUserPrompt numbers every word from 0 on each page and includes every page given", () => {
  const p = buildUserPrompt(genInput("James Clear"));
  assert.match(p, /--- PAGE 0 ---/);
  assert.match(p, /--- PAGE 3 ---/);
  assert.match(p, /0:The 1:first 2:sentence\./);
  // Word indices restart at 0 on the second page too.
  assert.match(p, /0:Another 1:page 2:entirely\./);
});

test("buildUserPrompt states the author when established, and says none is established otherwise", () => {
  const withAuthor = buildUserPrompt(genInput("James Clear"));
  assert.match(withAuthor, /Author: James Clear/);

  const withoutAuthor = buildUserPrompt(genInput(null));
  assert.match(withoutAuthor, /Author: not established/i);
});

test("buildSystemPrompt(hasAuthor: false) actively forbids inventing an author, not merely omits permission", () => {
  const s = buildSystemPrompt({ hasAuthor: false });
  // A prompt that just left out "you may name the author" would already fail
  // this test if it were satisfied by silence — it must say, in terms, that
  // guessing or inventing a name is forbidden.
  assert.match(s, /do not guess|do not invent|never guess|never invent/i);
  assert.match(s, /fabrication|not established/i);
});

test("buildSystemPrompt(hasAuthor: false) forbids personifying an unnamed writer, not just naming one", () => {
  const s = buildSystemPrompt({ hasAuthor: false });
  // Banning the name alone still leaves "the writer believes X" available —
  // that never names anyone, but it invents a person behind the page and
  // asserts a belief for them. The rule must close that door explicitly.
  assert.match(s, /the writer/i);
  assert.match(s, /whoever wrote this/i);
  assert.match(s, /attribut(e|es|ing) (belief|argument|intent)/i);
});

test("sanitized speech strips the prompt's own named parenthetical stage directions", () => {
  const withDirection: ContentPackage = {
    ...pkg(),
    beats: [
      { id: "hook", voiceover: "He said this (pause) and then continued.", onScreen: "x", sourcePage: 0, startWord: 0, endWord: 1 },
      { id: "cta", voiceover: "It was funny (laughs) and sad (sighs) at once, a real turn (beat) there.", onScreen: "x", sourcePage: 0, startWord: 2, endWord: 3 },
    ],
  };
  const vo = voScriptFromPackage(withDirection);
  assert.ok(!/pause|laughs|sighs|beat/i.test(vo), `stage directions must not reach speech: "${vo}"`);
  assert.ok(!vo.includes("  "), "stripping a stage direction must not leave a double space");

  const texts = beatTexts(withDirection);
  assert.equal(texts[0], "He said this and then continued.");
  assert.ok(!/\(|\)/.test(texts[1]), "no stray parens left behind once their contents are removed");
});

test("sanitized speech leaves an ordinary parenthetical aside alone", () => {
  const withAside: ContentPackage = {
    ...pkg(),
    beats: [
      { id: "hook", voiceover: "The page (and this is the whole point) never says that.", onScreen: "x", sourcePage: 0, startWord: 0, endWord: 1 },
    ],
  };
  const vo = voScriptFromPackage(withAside);
  assert.match(vo, /\(and this is the whole point\)/, "a legitimate aside must survive the sanitizer");
});
