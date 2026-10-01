import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_MAX_SECONDS,
  PACE,
  TIERS,
  VIDEO_MAX_SECONDS,
  expectedSeconds,
  gateSpecFor,
  ideaSignals,
  maxWordsFor,
  overrunFix,
  OVERRUN_MARGIN_SECONDS,
  planDuration,
  scoreIdea,
  tierOfScript,
  videoSecondsVerdict,
  writerSpecFor,
  ENVELOPE,
  type IdeaSignals,
} from "../src/lib/content/duration";
import { checkLength } from "../src/lib/content";
import { buildSystemPrompt } from "../src/lib/content/prompt";

const sig = (over: Partial<IdeaSignals> = {}): IdeaSignals => ({
  angle: "counterintuitive-insight", coreIdea: "One short idea.", whyItMatters: "It matters.", citedWords: 20, quotes: 1, pages: 1, ...over,
});
/** A normal idea: a mental model, two quotes, a claim and its reason. Scores 2.0, a 60 s video. */
const normal = () => sig({ angle: "mental-model", citedWords: 45, quotes: 2, coreIdea: "A claim. Its reason." });
const beats = (n: number, wordsEach: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, voiceover: Array.from({ length: wordsEach }, () => "word").join(" "), onScreen: "", sourcePage: 0, startWord: 0, endWord: 0 }));

test("seconds are predicted from words and beats, and the prediction inverts cleanly", () => {
  // The fit was made on 30 real videos: 203 words in 9 beats finished at 76.5 s, 276 words in 9 at 101 s.
  assert.ok(Math.abs(expectedSeconds(203, 9) - 76.5) < 3);
  assert.ok(Math.abs(expectedSeconds(276, 9) - 101) < 3);
  assert.equal(PACE.fixed, 3.9);
  for (const b of [5, 8, 11]) {
    const w = maxWordsFor(80, b);
    assert.ok(expectedSeconds(w, b) <= 80 && expectedSeconds(w + 1, b) > 80, `${b} beats: ${w} words is the most that fits 80 s`);
  }
});

test("NO tier can predict past the cap: its largest script still lands under EXPECTED_MAX_SECONDS, with room for the model's error", () => {
  for (const [tier, t] of Object.entries(TIERS)) {
    const worst = expectedSeconds(t.maxWords, t.maxBeats);
    assert.ok(worst <= EXPECTED_MAX_SECONDS, `${tier}-second tier: ${t.maxWords} words in ${t.maxBeats} beats predicts ${worst.toFixed(1)} s`);
    // The fit's worst error on real data was 5 s; the cap must survive it.
    assert.ok(worst + 5 <= VIDEO_MAX_SECONDS, `${tier}-second tier survives a 5 s underestimate`);
  }
  assert.equal(VIDEO_MAX_SECONDS, 90);
});

test("the tiers are what was asked for: about 45 s, about 60 s, up to 90 s", () => {
  const mid = (t: { aim: number; minBeats: number; maxBeats: number }) => expectedSeconds(t.aim, Math.round((t.minBeats + t.maxBeats) / 2));
  assert.ok(Math.abs(mid(TIERS[45]) - 47) <= 4, `45-second tier aims at ${mid(TIERS[45]).toFixed(1)} s`);
  assert.ok(Math.abs(mid(TIERS[60]) - 60) <= 4, `60-second tier aims at ${mid(TIERS[60]).toFixed(1)} s`);
  assert.ok(mid(TIERS[90]) <= 85 && mid(TIERS[90]) >= 72, `90-second tier aims at ${mid(TIERS[90]).toFixed(1)} s`);
  assert.ok(expectedSeconds(TIERS[45].minWords, TIERS[45].minBeats) >= 43, "even the shortest 45 s script predicts about 45 s, not less");
});

test("a simple idea gets 45 s, a normal one 60 s, a complex multi-concept one up to 90 s", () => {
  const simple = planDuration(sig({ angle: "emotional-truth", citedWords: 14 }));
  assert.equal(simple.tier, 45);

  assert.equal(planDuration(normal()).tier, 60);

  const complex = planDuration(
    sig({ angle: "framework", citedWords: 180, quotes: 3, pages: 3, coreIdea: "Three steps to follow. Each builds on the last. Together they change the habit.", whyItMatters: "It is the whole method." }),
  );
  assert.equal(complex.tier, 90);
  assert.ok(complex.reasons.length >= 4, "the reasons say why: " + complex.reasons.join("; "));
  assert.ok(complex.expectedSeconds <= EXPECTED_MAX_SECONDS);
});

test("more evidence, more quotes, more pages, an enumerated set and a framework each push the score up — never down", () => {
  const base = scoreIdea(sig()).score;
  assert.ok(scoreIdea(sig({ citedWords: 130 })).score > base);
  assert.ok(scoreIdea(sig({ quotes: 3 })).score > base);
  assert.ok(scoreIdea(sig({ pages: 3 })).score > base);
  assert.ok(scoreIdea(sig({ coreIdea: "There are three steps to it." })).score > base, "an enumerated set");
  assert.ok(scoreIdea(sig({ angle: "framework" })).score > base);
  assert.ok(scoreIdea(sig({ angle: "surprising-fact" })).score < base, "a single surprising fact needs less room");
});

test("the writer is told the tier exactly; a draft is checked against a band around it, never past the cap", () => {
  const plan = planDuration(normal());
  const w = writerSpecFor(plan);
  assert.equal(w.minWords, TIERS[60].minWords);
  assert.equal(w.maxWords, TIERS[60].maxWords);
  assert.equal(w.seconds, "60-second");

  const g = gateSpecFor(plan);
  assert.ok(g.minWords! < w.minWords! && g.maxWords! > w.maxWords!, "the gate is wider than the brief");
  assert.ok(g.maxWords! <= TIERS[90].maxWords, "…but never past the largest script any tier allows");
  assert.equal(g.maxExpectedSeconds, EXPECTED_MAX_SECONDS);
  assert.equal(gateSpecFor(planDuration(sig({ angle: "framework", citedWords: 400, quotes: 5, pages: 4 }))).maxWords, TIERS[90].maxWords);
});

test("a script that needed a little more or less room than planned is accepted; one far off is sent back", () => {
  const plan = planDuration(normal());
  const gate = gateSpecFor(plan);
  assert.equal(checkLength({ beats: beats(8, 22) }, gate), null, "176 words in 8 beats: inside the 60 s tier");
  assert.equal(checkLength({ beats: beats(8, 24) }, gate), null, "192 words: a little over the plan, still what the content needed");
  assert.ok(checkLength({ beats: beats(9, 30) }, gate), "270 words is a different video, not a 60 s one");
  assert.ok(checkLength({ beats: beats(6, 14) }, gate), "84 words is too thin for 60 s");
});

test("a script inside the word range can STILL be refused when its beats push it past the cap", () => {
  const gate = gateSpecFor(planDuration(sig({ angle: "framework", citedWords: 400, quotes: 5, pages: 4 })));
  // 225 words is inside 195–228, but across 12 beats it predicts past the limit.
  const risky = checkLength({ beats: beats(12, 19) }, gate)!;
  assert.ok(risky, "225 words in 12 beats");
  assert.match(risky.problem, /second limit|against the 90/);
  assert.match(risky.brief, /Cut it to about/);
  assert.equal(checkLength({ beats: beats(9, 24) }, gate), null, "216 words in 9 beats predicts about 80 s");
});

test("the tier a finished script ACTUALLY is follows its length, not the plan", () => {
  assert.equal(tierOfScript(120, 6), 45);
  assert.equal(tierOfScript(160, 8), 60);
  assert.equal(tierOfScript(215, 10), 90);
});

test("the hard limit: nothing over 90 s, nothing broken under 30 s, a short one is a note", () => {
  assert.equal(videoSecondsVerdict(90), "ok");
  assert.equal(videoSecondsVerdict(90.01), "fail");
  assert.equal(videoSecondsVerdict(45), "ok");
  assert.equal(videoSecondsVerdict(44.9), "note");
  assert.equal(videoSecondsVerdict(30), "note");
  assert.equal(videoSecondsVerdict(29.9), "fail");
  assert.equal(videoSecondsVerdict(Number.POSITIVE_INFINITY), "fail");
});

test("signals are read from a stored idea row, tolerating bad JSON", () => {
  const row = { angle: "framework", coreIdea: "c", whyItMatters: "w", sourceText: "one two three four five", sourceRefs: JSON.stringify([{ pageIndex: 2, startWord: 0, endWord: 4 }, { pageIndex: 3, startWord: 0, endWord: 4 }]), sourcePages: JSON.stringify([2, 3]) };
  assert.deepEqual(ideaSignals(row), { angle: "framework", coreIdea: "c", whyItMatters: "w", citedWords: 5, quotes: 2, pages: 2 });
  const broken = ideaSignals({ ...row, sourceRefs: "not json", sourcePages: "{" });
  assert.equal(broken.quotes, 1);
  assert.equal(broken.pages, 1);
});

test("the writer's prompt carries the tier, the aim and the 90 s ceiling — and never asks for padding", () => {
  const plan = planDuration(sig({ angle: "emotional-truth", citedWords: 14 }));
  const p = buildSystemPrompt({ hasAuthor: false, length: "long", spec: writerSpecFor(plan) });
  assert.match(p, /^You write 45-second vertical video scripts/);
  assert.match(p, new RegExp(`between ${TIERS[45].minWords} and ${TIERS[45].maxWords} words — aim for about ${TIERS[45].aim}`));
  assert.match(p, /never run past 90 seconds/);
  assert.match(p, /never padded/);
  assert.equal(ENVELOPE.maxWords, TIERS[90].maxWords);
});

test("a dense script the model under-predicted by ~7 s (227 words, 9 beats, finished 90.8 s) is now refused BEFORE it is voiced", () => {
  const gate = gateSpecFor(planDuration(sig({ angle: "framework", citedWords: 400, quotes: 5, pages: 4 })));
  assert.ok(checkLength({ beats: beats(9, 25) }, gate), "225 words is past the largest script any tier allows");
  assert.equal(checkLength({ beats: beats(9, 23) }, gate), null, "207 words in 9 beats is a normal 90 s-tier script");
});

test("a recorded narration over the ceiling comes back as a precise cut, never as a failed episode", () => {
  assert.equal(overrunFix(200, 70, 72.5), null, "a video that fits needs nothing");
  assert.equal(overrunFix(200, 87.5, 90), null, "exactly the ceiling still fits");
  const fix = overrunFix(227, 88.3, 90.8)!;
  assert.ok(fix);
  // 90.8 s → aim for 90 − margin: 5.8 s over at 0.389 s/word ≈ 15 words
  assert.equal(fix.cutWords, Math.ceil((90.8 - (90 - OVERRUN_MARGIN_SECONDS)) / (88.3 / 227)));
  assert.equal(fix.targetWords, 227 - fix.cutWords);
  assert.ok(fix.targetWords * (88.3 / 227) + 2.5 <= 90 - OVERRUN_MARGIN_SECONDS + 0.5, "the target lands inside the margin");
  assert.match(fix.brief, /about \d+ words \(cut at least \d+\)/);
  assert.match(fix.brief, /never add a new claim/);
  assert.equal(overrunFix(Number.NaN, 80, 95), null, "garbage in, no brief out");
});
