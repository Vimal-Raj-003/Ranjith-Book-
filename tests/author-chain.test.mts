import test from "node:test";
import assert from "node:assert/strict";
import { normalizePersonName, sameName } from "../src/lib/ingest/names";
import { resolveAuthor, lookupBook } from "../src/lib/ingest/identity";

// --- The brief's eight tests -------------------------------------------------

test("initials, case, punctuation and accents do not make two names different", () => {
  assert.equal(normalizePersonName("J. R. R. Tolkien"), normalizePersonName("J.R.R. Tolkien"));
  assert.ok(sameName("Gabriel García Márquez", "Gabriel Garcia Marquez"));
  assert.ok(sameName("cal newport", "Cal  Newport"));
  assert.ok(!sameName("Cal Newport", "Carl Newport"));
});

test("every link holding is the only way an author is revealed", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }],
    modelGuess: "cal newport",
    adversarialConfirmed: true,
  });

  assert.equal(r.verified, true);
  assert.equal(r.author, "Cal Newport", "the canonical spelling wins, not the model's casing");
  assert.equal(r.reason, null);
});

test("two candidate works means the author is absent, not the first one", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }, { authors: ["Someone Else"] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: true,
  });

  assert.equal(r.author, null);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "multiple-works");
});

test("an anthology with two authors is absent, not joined with an ampersand", () => {
  const r = resolveAuthor({
    works: [{ authors: ["A Writer", "Another Writer"] }],
    modelGuess: "A Writer",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "multiple-authors");
});

test("the model disagreeing with the catalogue breaks the chain", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }],
    modelGuess: "James Clear",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "model-disagreed");
});

test("the adversarial pass declining breaks the chain even when everything else agrees", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: false,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "adversarial-declined");
});

test("no catalogue match at all is survivable and named", () => {
  const r = resolveAuthor({ works: [], modelGuess: "Someone", adversarialConfirmed: true });
  assert.equal(r.author, null);
  assert.equal(r.reason, "no-catalogue-match");
});

test("there is no partial-confidence state", () => {
  const cases = [
    { works: [], modelGuess: null, adversarialConfirmed: false },
    { works: [{ authors: [] }], modelGuess: "X", adversarialConfirmed: true },
    { works: [{ authors: ["X"] }], modelGuess: null, adversarialConfirmed: true },
  ];

  for (const c of cases) {
    const r = resolveAuthor(c);
    assert.equal(r.verified, false);
    assert.equal(r.author, null, "unverified means absent — never a placeholder or a maybe");
    assert.ok(r.reason, "and the broken link is always named");
  }
});

// --- Beyond the brief: the ways a real catalogue actually misleads ----------

test("the same work returned twice as separate editions with one shared author is still absent", () => {
  // Two docs, identical single author on both -- exactly what Open Library
  // returns for a hardback and a paperback of the same book. There is no
  // structural way to tell that apart from two different books that happen to
  // share a title, so this stays "multiple-works", not "verified".
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }, { authors: ["Cal Newport"] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "multiple-works");
});

test("'Various' is a catalogue convention, not an author, even if everything else lines up", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Various"] }],
    modelGuess: "Various",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "non-person-author");
});

test("'Anonymous', 'Editor' and a publisher imprint are all refused as non-person authors", () => {
  for (const notAPerson of ["Anonymous", "anonymous ", "Editor", "Editors", "Penguin Random House", "HarperCollins Publishers"]) {
    const r = resolveAuthor({
      works: [{ authors: [notAPerson] }],
      modelGuess: notAPerson,
      adversarialConfirmed: true,
    });
    assert.equal(r.author, null, `"${notAPerson}" should never be revealed as an author`);
    assert.equal(r.reason, "non-person-author");
  }
});

test("real authors whose name happens to end in a word an organisation-heuristic would flag are never refused", () => {
  // A previous version of isNonPersonAuthor rejected any two-or-more-word
  // name ending in a bare organisational word ("house", "press", "media",
  // "group", ...). That is exactly the shape of an ordinary "First Last"
  // name, and it silently blocked real, working authors -- Silas House
  // (Kentucky Poet Laureate 2017-18) and Christian House among them. The
  // check is now a full-string denylist only, so every one of these resolves
  // normally when the rest of the chain agrees.
  for (const realAuthor of ["Silas House", "Christian House", "House"]) {
    const r = resolveAuthor({
      works: [{ authors: [realAuthor] }],
      modelGuess: realAuthor,
      adversarialConfirmed: true,
    });
    assert.equal(r.reason, null, `"${realAuthor}" should verify cleanly`);
    assert.equal(r.verified, true, `"${realAuthor}" should verify cleanly`);
    assert.equal(r.author, realAuthor);
  }
});

test("leading/trailing whitespace and empty-string authors in the array are cleaned before counting", () => {
  const r = resolveAuthor({
    works: [{ authors: ["  Cal Newport  ", "", "   "] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: true,
  });
  assert.equal(r.verified, true);
  assert.equal(r.author, "Cal Newport", "the survivor is trimmed, not just the blanks removed — a rendered byline must not carry padding");
});

test("an author string that is only whitespace is treated as no catalogue author", () => {
  const r = resolveAuthor({
    works: [{ authors: ["   ", ""] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "no-catalogue-author");
});

test("a catalogue title that differs only by case or trailing whitespace still counts as an exact match", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        docs: [
          { key: "/works/OL1W", title: "Deep Work  ", author_name: ["Cal Newport"], first_publish_year: 2016, subject: ["Self-help"] },
          { key: "/works/OL2W", title: "DEEP WORK", author_name: ["Someone Else"] },
          { key: "/works/OL3W", title: "Deep Work: Rules for Focused Success", author_name: ["Cal Newport"] },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;

  try {
    const result = await lookupBook("deep work");
    // The subtitled edition is a different title and must not count as a
    // candidate; the two case/whitespace variants of the exact title do.
    assert.equal(result.works.length, 2);
    assert.equal(result.openLibraryId, "/works/OL1W");
  } finally {
    globalThis.fetch = original;
  }
});

test("lookupBook survives being called against the real network without throwing", async () => {
  // No mocking here: this exercises that lookupBook returns the same shape
  // and never throws, even in a sandbox with no outbound network access.
  const result = await lookupBook("A Title That Almost Certainly Does Not Exist In Any Catalogue 9x7z");
  assert.equal(typeof result, "object");
  assert.ok(Array.isArray(result.works));
  assert.ok(Array.isArray(result.subjects));
});

test("lookupBook never throws out of the pipeline when the transport itself fails", async () => {
  // Simulate a dropped connection / DNS blip at the fetch layer; the failure
  // must be swallowed inside lookupBook, never thrown into the caller.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;

  try {
    const result = await lookupBook("Anything");
    assert.deepEqual(result, { openLibraryId: null, year: null, subjects: [], works: [] });
  } finally {
    globalThis.fetch = original;
  }
});

test("a redirect toward a private address is refused, and the failure is still non-fatal", async () => {
  // Open Library's own response redirects to a private/loopback address --
  // this is exactly the case the manual redirect loop exists for: the guard
  // must re-check the Location header before following it, refuse, and
  // lookupBook must swallow that refusal like any other catalogue failure.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:9999/search.json?title=deep+work" },
    });
  }) as typeof fetch;

  try {
    const result = await lookupBook("Deep Work");
    assert.deepEqual(result, { openLibraryId: null, year: null, subjects: [], works: [] });
    assert.equal(calls, 1, "the redirect target must be checked and refused before a second fetch is ever made");
  } finally {
    globalThis.fetch = original;
  }
});

test("the redirect chain shares one deadline across every hop, not a fresh one per hop", async () => {
  // Regression for a per-hop AbortSignal.timeout: with MAX_REDIRECTS = 5, a
  // fresh timer per hop could let a slow, redirecting server burn roughly
  // 6x the intended budget (original request plus five redirects) before
  // failing -- longer than ingest's entire 35s-for-six-pages budget, on one
  // catalogue lookup. Captured signals across three hops must all be the
  // exact same object, proving one deadline covers the whole chain.
  const original = globalThis.fetch;
  const seenSignals: (AbortSignal | null | undefined)[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    seenSignals.push(init?.signal);
    if (calls < 3) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://openlibrary.org/search.json?hop=${calls}` },
      });
    }
    return new Response(JSON.stringify({ docs: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    await lookupBook("Deep Work");
    assert.equal(calls, 3, "expected exactly two redirects followed by a final response");
    assert.ok(seenSignals[0], "a signal must be attached to every fetch call");
    assert.equal(seenSignals[0], seenSignals[1], "hop 2 must reuse hop 1's deadline");
    assert.equal(seenSignals[1], seenSignals[2], "hop 3 must reuse the same deadline too");
  } finally {
    globalThis.fetch = original;
  }
});

test("lookupBook returns the empty shape when the catalogue responds with an error status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as typeof fetch;

  try {
    const result = await lookupBook("Deep Work");
    assert.deepEqual(result, { openLibraryId: null, year: null, subjects: [], works: [] });
  } finally {
    globalThis.fetch = original;
  }
});

test("lookupBook returns the empty shape when the catalogue responds with unparseable JSON", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>not json</html>", { status: 200 })) as typeof fetch;

  try {
    const result = await lookupBook("Deep Work");
    assert.deepEqual(result, { openLibraryId: null, year: null, subjects: [], works: [] });
  } finally {
    globalThis.fetch = original;
  }
});
