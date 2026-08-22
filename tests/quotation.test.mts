import test from "node:test";
import assert from "node:assert/strict";
import {
  checkQuotationBudget,
  MAX_QUOTE_WORDS,
  MAX_VERBATIM_SHARE,
  RUN_FLOOR,
  SUBFLOOR_RUN,
  MAX_SUBFLOOR_SHARE,
} from "../src/lib/content/quotation";
import { findAuthorMentions } from "../src/lib/content/verify";
import type { ContentPackage } from "../src/lib/content/schema";

const source =
  "Discipline is not the same as motivation. Motivation is a feeling and feelings " +
  "are weather. Discipline is a decision you made once and keep. The page argues " +
  "that starting smaller than feels useful is the only reliable way through the " +
  "first fortnight of any new habit whatsoever.";

// --- The brief's six tests ---------------------------------------------------

test("original commentary passes with room to spare", () => {
  const r = checkQuotationBudget(
    "The page draws a line between wanting to act and deciding to. One is a mood; the other is a standing choice.",
    source,
    "in-copyright",
  );

  assert.equal(r.withinBudget, true);
  assert.ok(r.longestRun < MAX_QUOTE_WORDS);
});

test("one short quote is allowed — that is the point of the budget", () => {
  const r = checkQuotationBudget(
    `The page puts it plainly: "Motivation is a feeling and feelings are weather." That framing is the whole argument, and it is worth sitting with for a moment before moving on to what follows from it.`,
    source,
    "in-copyright",
  );

  assert.equal(r.withinBudget, true);
});

test("reading the page aloud is refused for an in-copyright book", () => {
  const r = checkQuotationBudget(source, source, "in-copyright");

  assert.equal(r.withinBudget, false);
  assert.ok(r.longestRun > MAX_QUOTE_WORDS);
  assert.ok(r.excerpt, "the report names the offending passage so it can be shown");
});

test("the same narration is fine for a public-domain book", () => {
  assert.equal(checkQuotationBudget(source, source, "public-domain").withinBudget, true);
  assert.equal(checkQuotationBudget(source, source, "own-work").withinBudget, true);
});

test("many small lifts add up and are caught by the share, not the longest run", () => {
  const patchwork =
    "Discipline is not the same as motivation. Right. Motivation is a feeling. Right. " +
    "Discipline is a decision you made once. Right. Starting smaller than feels useful. Right.";

  const r = checkQuotationBudget(patchwork, source, "in-copyright");
  assert.equal(r.withinBudget, false, "a collage of short quotes is still a reproduction");
});

test("empty narration does not divide by zero", () => {
  const r = checkQuotationBudget("", source, "in-copyright");
  assert.equal(r.verbatimShare, 0);
  assert.equal(r.withinBudget, true);
});

// --- The author gate ---------------------------------------------------------

const withAuthorIn = (field: string, value: string): ContentPackage => {
  const base = {
    title: "T", hook: "H", ideaKey: "k", cta: "C", description: "D",
    hashtags: ["books"], takeaway: ["x", "y"],
    beats: [
      { id: "hook", voiceover: "V", onScreen: "O", sourcePage: 0, startWord: 0, endWord: 1 },
      { id: "cta", voiceover: "C", onScreen: "O", sourcePage: 0, startWord: 2, endWord: 3 },
    ],
  };
  const override =
    field === "beatVoiceover"
      ? { beats: [
          { id: "hook", voiceover: value, onScreen: "O", sourcePage: 0, startWord: 0, endWord: 1 },
          { id: "cta", voiceover: "C", onScreen: "O", sourcePage: 0, startWord: 2, endWord: 3 },
        ] }
      : { [field]: value };
  return { ...base, ...override };
};

test("a fabricated byline is caught in every field that reaches an output", () => {
  for (const field of ["title", "hook", "cta", "description", "beatVoiceover"]) {
    const pkg = withAuthorIn(field, "A passage by Cal Newport on focus.");
    assert.ok(
      findAuthorMentions(pkg, null).length > 0,
      `an author named in ${field} would reach a real channel unchallenged`,
    );
  }
});

test("a verified author is not flagged", () => {
  const pkg = withAuthorIn("hook", "A passage by Cal Newport on focus.");
  assert.deepEqual(findAuthorMentions(pkg, "Cal Newport"), []);
});

test("ordinary prose is not mistaken for a byline", () => {
  const pkg = withAuthorIn("hook", "Most habits die in the first week, by any measure.");
  assert.deepEqual(findAuthorMentions(pkg, null), [], "a false positive here blocks good runs");
});

// --- Beyond the brief: quotation budget on a false-positive shape -----------

test("original commentary that happens to share common English with the source is not mistaken for quotation", () => {
  // None of this sentence is lifted from `source` — it just uses ordinary,
  // widely-shared English. A budget that penalized shared vocabulary rather
  // than shared SEQUENCES would wrongly trip on this.
  const r = checkQuotationBudget(
    "At the end of the day, it comes down to what you do when nobody is watching, " +
      "and none of that has anything to do with feelings or with weather.",
    source,
    "in-copyright",
  );

  assert.equal(r.withinBudget, true);
  assert.ok(
    r.longestRun < RUN_FLOOR,
    "an incidental word or two in common should never register as a run worth naming",
  );
});

test("RUN_FLOOR keeps ordinary shared phrasing from counting as reproduction", () => {
  // "is a" and "the page" are common shared bigrams/short phrases with the
  // source, but far short of RUN_FLOOR — they must not push verbatimShare up.
  const r = checkQuotationBudget(
    "The page is a good one, and this idea is a useful one to sit with for a while before moving on to the next thing entirely.",
    source,
    "in-copyright",
  );

  assert.equal(r.withinBudget, true);
});

// --- Beyond the brief: rights status genuinely unlimited --------------------

test("public-domain and own-work stay within budget even when the narration is the source doubled", () => {
  const doubled = `${source} ${source}`;
  assert.equal(checkQuotationBudget(doubled, source, "public-domain").withinBudget, true);
  assert.equal(checkQuotationBudget(doubled, source, "own-work").withinBudget, true);
  // Contrast: the identical doubled text is still refused for an in-copyright book.
  assert.equal(checkQuotationBudget(doubled, source, "in-copyright").withinBudget, false);
});

// --- Beyond the brief: personification (decision 2) -------------------------

test("findAuthorMentions catches unnamed personification, not just named bylines", () => {
  const cases = [
    "The writer believes second chances matter more than first ones.",
    "Whoever wrote this argues that quitting early is a kind of honesty.",
    "The author disagrees with the popular wisdom on this exact point.",
    "Whoever wrote it never explains why the second chapter contradicts the first.",
  ];
  for (const text of cases) {
    const pkg = withAuthorIn("hook", text);
    assert.ok(
      findAuthorMentions(pkg, null).length > 0,
      `personification in "${text}" would smuggle an unverified authorial figure onto a real channel`,
    );
  }
});

test("the word 'author' inside 'authority' is not a false positive", () => {
  const pkg = withAuthorIn("hook", "This is a book about authority and who gets to claim it.");
  assert.deepEqual(
    findAuthorMentions(pkg, null),
    [],
    "'authority' must not be mistaken for a mention of 'the author'",
  );
});

test("a verified author is allowed through even alongside personification-shaped phrasing", () => {
  // Once the author is verified, findAuthorMentions is not in the business of
  // policing HOW the name is introduced — only whether one is present when
  // none was ever established.
  const pkg = withAuthorIn("hook", "The author, Cal Newport, argues discipline beats motivation.");
  assert.deepEqual(findAuthorMentions(pkg, "Cal Newport"), []);
});

// --- Review finding 1: a WRONG name is exactly as bad as no name ------------

test("a byline naming someone OTHER than the verified author is a blocker (finding 1)", () => {
  const pkg = withAuthorIn("hook", "A passage by James Clear on building better habits.");
  const mentions = findAuthorMentions(pkg, "Cal Newport");
  assert.ok(
    mentions.length > 0,
    "a book whose author is verified as Cal Newport must not ship a script naming James Clear",
  );
});

test("a byline naming the verified author under a different spelling is still recognized as correct (sameName, not string equality)", () => {
  // "Cal Newport" vs "Cal  Newport" (an OCR/whitespace variant) — normalized
  // by `sameName`, this is the SAME person, not a mismatch.
  const pkg = withAuthorIn("hook", "A passage by Cal Newport on building better habits.");
  assert.deepEqual(findAuthorMentions(pkg, "cal newport"), []);
});

// --- Review finding 2: the share must never hide behind the allowed quote ---

test("a narration that is nothing but one maximal permitted quote reports its true share, not zero (finding 2)", () => {
  // Exactly `source`'s first MAX_QUOTE_WORDS words, verbatim, with NO
  // original commentary at all. Excluding the longest run from the numerator
  // (the pre-fix behavior) would have reported verbatimShare: 0 here — the
  // exact hole the review flagged. It must now read the truth (100%), and —
  // because this is ALSO 100% coverage under the coarser sub-floor signal
  // (finding 6) — it must not pass just for staying at the MAX_QUOTE_WORDS
  // boundary: a quote with no commentary around it at all is exactly the
  // "reading the page aloud" pattern the budget exists to refuse.
  const firstTwentyFive = source
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_QUOTE_WORDS)
    .join(" ");

  const r = checkQuotationBudget(firstTwentyFive, source, "in-copyright");

  assert.equal(r.longestRun, MAX_QUOTE_WORDS);
  assert.equal(r.verbatimShare, 1, "the share must read the truth, not 0, once nothing is exempted");
  assert.equal(r.withinBudget, false);
});

test("a permitted quote plus a separate collage on top of it does not hide behind a shrunken share (finding 2, the stacking attack)", () => {
  // One MAX_QUOTE_WORDS-word quote (on its own, allowed) PLUS two more
  // 5-word lifts from elsewhere on the page, stitched together with
  // unrelated filler so they read as separate runs, not one long one. The
  // pre-fix formula (excluding only the single longest run) would report a
  // deceptively small residual share; this must show a large, honest share
  // and fail.
  const s = source
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const narration = [
    s.slice(0, 25).join(" "),
    "anyway meanwhile",
    s.slice(34, 39).join(" "),
    "look still",
    s.slice(40, 45).join(" "),
    "done now finally today",
  ].join(" ");

  const r = checkQuotationBudget(narration, source, "in-copyright");

  assert.equal(r.withinBudget, false);
  assert.ok(
    r.verbatimShare > 3 * MAX_VERBATIM_SHARE,
    `verbatimShare (${r.verbatimShare}) must reflect the true, larger reproduction, not a shrunken figure`,
  );
});

// --- Review finding 4: the personification pattern needs an attributing verb

test("a bare, unattributed 'the author' does not trip the deterministic gate (finding 4)", () => {
  // A legitimate line about self-determination — no attribution of belief,
  // argument, or intent to anyone behind the page. The pre-fix pattern
  // matched the bare noun and would have blocked this with no actionable
  // reason for the operator to fix.
  const pkg = withAuthorIn("hook", "She is the author of her own life, and she knows it.");
  assert.deepEqual(
    findAuthorMentions(pkg, null),
    [],
    "'the author' with no attributing verb must not be treated as a fabricated byline",
  );
});

test("'the author of this book argues' is still caught — the verb, not the bare noun, is what matters (finding 4)", () => {
  const pkg = withAuthorIn("hook", "The author of this book argues that risk is essential to a good life.");
  assert.ok(
    findAuthorMentions(pkg, null).length > 0,
    "an attributing verb after the noun phrase is still the forbidden construction, even with a short gap",
  );
});

// --- Review finding 6: a coarser signal for a sub-floor collage -------------

test("a collage built entirely from lifts shorter than RUN_FLOOR is invisible to verbatimShare but caught by subfloorShare (finding 6)", () => {
  // Six separate 4-word lifts from `source`, each below RUN_FLOOR (5) so
  // NONE of them register under the primary metric at all — the exact
  // failure mode the review demonstrated (a 61%-verbatim narration reading
  // as 0%).
  const collage =
    "Discipline is not the. Look. Is a feeling and. Still. Is a decision you. Also. " +
    "Starting smaller than feels. Meanwhile. Is the only reliable. Anyway. First fortnight of any.";

  const r = checkQuotationBudget(collage, source, "in-copyright");

  assert.equal(r.longestRun, 4, "every individual lift is below RUN_FLOOR");
  assert.equal(r.verbatimShare, 0, "the primary, RUN_FLOOR-based metric genuinely cannot see this collage");
  assert.ok(
    r.subfloorShare > MAX_SUBFLOOR_SHARE,
    `subfloorShare (${r.subfloorShare}) must catch what verbatimShare cannot`,
  );
  assert.equal(r.withinBudget, false);
});

test("SUBFLOOR_RUN measures original commentary at 0% and a legitimate single quote well under the cap", () => {
  // The exact fixtures used elsewhere in this file, re-measured under the
  // SUBFLOOR_RUN floor to validate MAX_SUBFLOOR_SHARE isn't so tight it
  // would catch ordinary, non-reproducing commentary. See the task report
  // for the full set of measured numbers.
  const original = checkQuotationBudget(
    "The page draws a line between wanting to act and deciding to. One is a mood; the other is a standing choice.",
    source,
    "in-copyright",
  );
  assert.equal(original.subfloorShare, 0);

  const oneQuote = checkQuotationBudget(
    `The page puts it plainly: "Motivation is a feeling and feelings are weather." That framing is the whole argument, and it is worth sitting with for a moment before moving on to what follows from it.`,
    source,
    "in-copyright",
  );
  assert.ok(
    oneQuote.subfloorShare < MAX_SUBFLOOR_SHARE,
    `a single legitimate quote (subfloorShare ${oneQuote.subfloorShare}) must stay clear of the sub-floor cap`,
  );
  assert.equal(oneQuote.withinBudget, true);
});
