import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validatePlan, type EpisodePlan } from "../src/lib/ingest/plan-episodes";
import { reserveIdea, releaseIdea, IdeaTakenError } from "../src/lib/content/idea";
import { prisma } from "../src/lib/db";

const plan = (over: Partial<EpisodePlan>): EpisodePlan => ({
  ideaKey: "k",
  title: "T",
  startPage: 0,
  endPage: 0,
  startWord: 0,
  endWord: 10,
  ...over,
});

// --- The brief's six tests ---------------------------------------------------

test("a well-formed plan passes through untouched", () => {
  const p = [plan({ ideaKey: "a", startPage: 0, endPage: 1 }), plan({ ideaKey: "b", startPage: 2, endPage: 2 })];
  assert.deepEqual(validatePlan(p, 3, [50, 50, 50]), p);
});

test("a page index past the end of the upload is clamped, not trusted", () => {
  const [only] = validatePlan([plan({ startPage: 0, endPage: 9 })], 3, [50, 50, 50]);
  assert.equal(only.endPage, 2);
});

test("a word range past the end of the page is clamped", () => {
  const [only] = validatePlan([plan({ startPage: 1, endPage: 1, startWord: 0, endWord: 999 })], 3, [50, 40, 50]);
  assert.equal(only.endWord, 39);
});

test("two episodes claiming the same idea keep only the first", () => {
  const out = validatePlan([plan({ ideaKey: "same" }), plan({ ideaKey: "same", title: "Dupe" })], 1, [50]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "T");
});

test("an inverted range is dropped rather than silently reversed", () => {
  // The brief's own version of this test asserted `[]` here. Traced through
  // the brief's own reference implementation, though, a plan that arrives
  // with one episode and drops it ends up with `out.length === 0`, which
  // that same reference code treats as "nothing survived" and answers with
  // the whole-upload fallback — not an empty array. `[]` would only come out
  // of a version of validatePlan that distinguishes "the model sent nothing"
  // from "the model sent one episode and all of it was unusable", and
  // nothing else in the brief asks for that distinction. Given the explicit,
  // repeated invariant this task is built on — validatePlan never returns
  // zero episodes, because returning nothing is not an acceptable answer to
  // a slightly malformed plan — this test is corrected to expect the
  // fallback instead of literal emptiness.
  const out = validatePlan([plan({ startWord: 30, endWord: 10 })], 1, [50]);
  assert.equal(out.length, 1, "the invariant holds even when every proposed episode is malformed");
  assert.equal(out[0].ideaKey, "whole-upload");
});

test("an empty plan falls back to one episode covering everything", () => {
  const out = validatePlan([], 3, [50, 40, 30]);
  assert.equal(out.length, 1, "an upload always produces at least one episode");
  assert.equal(out[0].startPage, 0);
  assert.equal(out[0].endPage, 2);
  assert.equal(out[0].endWord, 29, "ending on the last word of the last page");
});

// --- Beyond the brief: what a real model actually returns -------------------

test("a negative startPage is clamped up to the first page, symmetric with clamping an over-large index down", () => {
  // The brief's own repair for an index past the end (`endPage: 9` on a
  // 3-page upload) is to clamp it down to the last valid page, not to drop
  // the episode. A negative index is the mirror case — "before the
  // beginning" instead of "past the end" — and the same `clamp` call already
  // repairs it the same way: `clamp(-1, 0, hi)` lands on 0. Treating one
  // direction as repairable and the other as fatal would be an arbitrary
  // asymmetry, so a negative page/word index is clamped, not dropped.
  const [only] = validatePlan([plan({ startPage: -1, endPage: -1 })], 3, [50, 50, 50]);
  assert.equal(only.startPage, 0);
  assert.equal(only.endPage, 0);
  assert.equal(only.ideaKey, "k", "a clamped-but-otherwise-sound episode survives as itself, not as the fallback");
});

test("a negative startWord is clamped to 0 the same way", () => {
  const [only] = validatePlan([plan({ startWord: -3, endWord: 10 })], 1, [50]);
  assert.equal(only.startWord, 0);
  assert.equal(only.endWord, 10);
});

test("a negative index alongside a valid one: both survive, one of them repaired", () => {
  const out = validatePlan(
    [plan({ ideaKey: "clamped", startPage: -1, endPage: -1 }), plan({ ideaKey: "good", startPage: 0, endPage: 0 })],
    3,
    [50, 50, 50],
  );
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.ideaKey === "clamped")?.startPage, 0);
  assert.ok(out.some((e) => e.ideaKey === "good"));
});

test("non-integer indices (a model's JSON parsed, not type-checked) are dropped, not floored or clamped", () => {
  const out = validatePlan([plan({ startPage: 0.5, endPage: 1 })], 3, [50, 50, 50]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ideaKey, "whole-upload", "1.5 is not a page index, and silently flooring it would hide the defect");
});

test("NaN and Infinity indices are dropped rather than clamped into a plausible-looking value", () => {
  const out1 = validatePlan([plan({ startWord: NaN })], 1, [50]);
  assert.equal(out1[0].ideaKey, "whole-upload");

  const out2 = validatePlan([plan({ endWord: Infinity })], 1, [50]);
  assert.equal(out2[0].ideaKey, "whole-upload");
});

test("an ideaKey that is not kebab-case is dropped", () => {
  const out = validatePlan(
    [plan({ ideaKey: "Not Kebab Case" }), plan({ ideaKey: "has_underscores" }), plan({ ideaKey: "TrailingCaps" })],
    1,
    [50],
  );
  assert.equal(out.length, 1, "none of the malformed keys survive, so the fallback fires");
  assert.equal(out[0].ideaKey, "whole-upload");
});

test("an ideaKey that is empty after trimming is dropped", () => {
  const out = validatePlan([plan({ ideaKey: "   " }), plan({ ideaKey: "" })], 1, [50]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ideaKey, "whole-upload");
});

test("a valid kebab-case ideaKey survives alongside a malformed one", () => {
  const out = validatePlan([plan({ ideaKey: "Bad Key" }), plan({ ideaKey: "good-key-2" })], 1, [50]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ideaKey, "good-key-2");
});

test("heavily overlapping episodes are not validatePlan's business", () => {
  // Two episodes can legitimately cover nearly the same words while arguing
  // two different angles about that passage — that is exactly what the
  // ideaKey/UsedIdea mechanism exists to arbitrate, not index arithmetic.
  // validatePlan only repairs structural validity (do these indices point
  // somewhere real, in order); judging whether two ranges are "too similar"
  // would require a similarity heuristic that cannot distinguish "same
  // passage, same angle" (a real duplicate, already caught by ideaKey) from
  // "same passage, different angle" (legitimate — a page can support more
  // than one video). So two structurally valid, distinctly-keyed episodes
  // that happen to cover almost the same word range both pass through
  // untouched.
  const overlapping = [
    plan({ ideaKey: "angle-one", startPage: 0, endPage: 0, startWord: 0, endWord: 45 }),
    plan({ ideaKey: "angle-two", startPage: 0, endPage: 0, startWord: 2, endWord: 47 }),
  ];
  const out = validatePlan(overlapping, 1, [50]);
  assert.equal(out.length, 2, "both structurally valid episodes survive even though their word ranges nearly coincide");
});

// --- Review findings 1-3: fields and shapes the tests above did not cover --

test("a non-string title does not crash validation for the whole plan (review finding 1)", () => {
  // Previously `raw.title?.trim()` only guarded against null/undefined —
  // a model returning a bare number for `title` threw `raw.title.trim is
  // not a function` and took down every OTHER episode in the same plan too,
  // from a function documented as never crashing on malformed model JSON.
  const out = validatePlan(
    [
      // @ts-expect-error — title is typed as string, but this simulates the
      // model's raw, unvalidated JSON handing back a non-string value.
      plan({ ideaKey: "bad-title", title: 123 }),
      plan({ ideaKey: "good-title", title: "A Real Title" }),
    ],
    1,
    [50],
  );
  assert.equal(out.length, 2, "the non-string title must not abort validation of the rest of the plan");
  const bad = out.find((e) => e.ideaKey === "bad-title");
  assert.equal(bad?.title, "bad-title", "falls back to the ideaKey when title is not a usable string");
  const good = out.find((e) => e.ideaKey === "good-title");
  assert.equal(good?.title, "A Real Title");
});

test("wordsPerPage shorter than pageCount does not leak NaN into the output (review finding 2)", () => {
  // wordsPerPage[2] is undefined here even though pageCount says page 2
  // exists. Math.max(0, undefined - 1) is NaN, and clamp(n, 0, NaN) returns
  // NaN — a silently corrupted, non-crashing episode with no signal that
  // anything went wrong. It must come out clamped to a real number instead.
  const [only] = validatePlan(
    [plan({ startPage: 2, endPage: 2, startWord: 0, endWord: 5 })],
    3,
    [50],
  );
  assert.ok(!Number.isNaN(only.startWord), "startWord must never be NaN");
  assert.ok(!Number.isNaN(only.endWord), "endWord must never be NaN");
  assert.equal(only.startWord, 0);
  assert.equal(only.endWord, 0);
});

test("a NaN element in wordsPerPage does not leak NaN into the output (review finding 6)", () => {
  // `??` only substitutes for null/undefined. A NaN element is neither, so
  // `wordsPerPage[page] ?? 1` returns the NaN itself, and NaN then poisons
  // Math.max and clamp all the way through to the output. The guard has to
  // check "is this actually a usable finite number", not just "is this
  // present".
  const [only] = validatePlan([plan({ startPage: 0, endPage: 0, startWord: 0, endWord: 5 })], 1, [NaN]);
  assert.ok(!Number.isNaN(only.startWord), "startWord must never be NaN");
  assert.ok(!Number.isNaN(only.endWord), "endWord must never be NaN");
  assert.equal(only.startWord, 0);
  assert.equal(only.endWord, 0);
});

test("an Infinity element in wordsPerPage does not leak Infinity into the output (review finding 6)", () => {
  // Infinity is also neither null nor undefined, so `?? 1` alone would let
  // it straight through. It is treated the same as any other unusable word
  // count — as if the page had one word, index 0 — rather than being read
  // as "this page has no upper bound," which would make every endWord
  // requested for it look valid no matter how large.
  const [only] = validatePlan([plan({ startPage: 0, endPage: 0, startWord: 0, endWord: 5 })], 1, [Infinity]);
  assert.ok(Number.isFinite(only.startWord), "startWord must never be Infinity");
  assert.ok(Number.isFinite(only.endWord), "endWord must never be Infinity");
  assert.equal(only.startWord, 0);
  assert.equal(only.endWord, 0, "an unusable word count is treated as 'one word, index 0', not as 'no bound at all'");
});

test("pageCount 0 never produces a negative page index (review finding 3)", () => {
  // pageCount - 1 = -1 as the upper clamp bound, with a lower bound of 0,
  // is an inverted range. The clamp helper must collapse that to 0 rather
  // than returning -1.
  const out = validatePlan([plan({ startPage: 0, endPage: 5 })], 0, []);
  assert.equal(out.length, 1);
  assert.ok(out[0].startPage >= 0, "startPage must never be negative");
  assert.ok(out[0].endPage >= 0, "endPage must never be negative");
  assert.ok(out[0].startWord >= 0, "startWord must never be negative");
  assert.ok(out[0].endWord >= 0, "endWord must never be negative");
});

// --- reserveIdea / releaseIdea round trip -----------------------------------

test("reserveIdea and releaseIdea round-trip, and the unique constraint rejects a real duplicate", async () => {
  const bookId = `test-book-${randomUUID()}`;
  const book = await prisma.book.create({ data: { id: bookId, title: "Idea Roundtrip Test" } });

  try {
    const ideaKey = "the-two-minute-rule";

    // First reservation succeeds.
    const claimed = await reserveIdea(book.id, ideaKey);
    assert.equal(claimed, ideaKey);

    const row = await prisma.usedIdea.findUnique({ where: { bookId_ideaKey: { bookId: book.id, ideaKey } } });
    assert.ok(row, "the reservation is actually persisted before the script is ever written");

    // A second reservation of the same idea, for the same book, is a real
    // duplicate and must be rejected by the unique constraint, surfaced as
    // the named error.
    await assert.rejects(() => reserveIdea(book.id, ideaKey), IdeaTakenError);

    // Releasing frees the idea for reuse.
    await releaseIdea(book.id, ideaKey);
    const afterRelease = await prisma.usedIdea.findUnique({
      where: { bookId_ideaKey: { bookId: book.id, ideaKey } },
    });
    assert.equal(afterRelease, null, "release must actually remove the row, not just report success");

    // And it can be claimed again after release.
    const reclaimed = await reserveIdea(book.id, ideaKey);
    assert.equal(reclaimed, ideaKey);

    // Clean up this second reservation so the finally block's book delete
    // doesn't have to rely on cascade alone for the assertion above.
    await releaseIdea(book.id, ideaKey);
  } finally {
    // Always clean up, even when an assertion above throws — otherwise a
    // failed run leaves this fixture book (and any surviving UsedIdea rows,
    // via cascade) behind.
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("reserveIdea does not relabel a generic database failure as idea_taken (review finding 4)", async () => {
  // Only a real unique-constraint violation on (bookId, ideaKey) should ever
  // surface as IdeaTakenError. Anything else — a dropped connection, a full
  // disk — must propagate as itself, not as a false and specific "this idea
  // is already taken" explanation.
  const original = prisma.usedIdea.create;
  (prisma.usedIdea as unknown as { create: unknown }).create = async () => {
    throw new Error("simulated connection failure");
  };

  try {
    await assert.rejects(
      () => reserveIdea("some-book", "some-idea"),
      (err: unknown) => {
        assert.ok(!(err instanceof IdeaTakenError), "a generic failure must not become IdeaTakenError");
        assert.ok(err instanceof Error && err.message === "simulated connection failure");
        return true;
      },
    );
  } finally {
    (prisma.usedIdea as unknown as { create: unknown }).create = original;
  }
});

test("releaseIdea is safe to call when nothing was ever reserved", async () => {
  const bookId = `test-book-${randomUUID()}`;
  const book = await prisma.book.create({ data: { id: bookId, title: "Release Nothing Test" } });

  try {
    // Never reserved anything for this book — must not throw.
    await releaseIdea(book.id, "never-reserved");
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("releaseIdea is safe to call twice in a row", async () => {
  const bookId = `test-book-${randomUUID()}`;
  const book = await prisma.book.create({ data: { id: bookId, title: "Double Release Test" } });

  try {
    await reserveIdea(book.id, "double-release");
    await releaseIdea(book.id, "double-release");
    // Second call finds nothing left to delete — must still not throw.
    await releaseIdea(book.id, "double-release");

    const row = await prisma.usedIdea.findUnique({
      where: { bookId_ideaKey: { bookId: book.id, ideaKey: "double-release" } },
    });
    assert.equal(row, null);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("the same ideaKey is independently reservable for two different books", async () => {
  // Both creates happen INSIDE the try, and each id is only recorded once its
  // create has actually resolved — otherwise, if bookB's create threw,
  // bookA would already exist with no path back to deleting it (review
  // finding: this exact pattern is what made this suite permanently red
  // once before).
  let bookAId: string | undefined;
  let bookBId: string | undefined;

  try {
    const bookA = await prisma.book.create({ data: { id: `test-book-${randomUUID()}`, title: "Book A" } });
    bookAId = bookA.id;
    const bookB = await prisma.book.create({ data: { id: `test-book-${randomUUID()}`, title: "Book B" } });
    bookBId = bookB.id;

    // The unique index is on (bookId, ideaKey), not ideaKey alone.
    await reserveIdea(bookAId, "shared-angle");
    await reserveIdea(bookBId, "shared-angle");
  } finally {
    if (bookBId) await prisma.book.delete({ where: { id: bookBId } });
    if (bookAId) await prisma.book.delete({ where: { id: bookAId } });
  }
});
