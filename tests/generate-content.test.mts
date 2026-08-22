import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";
import { generateContent } from "../src/lib/content/index";
import { ContentRejectedError } from "../src/lib/errors";

// A fake `claude` CLI so generateContent's orchestration (release-on-failure,
// the deterministic author/quotation gate, and the split verdict /
// indicesGrounded / authorNamed enforcement) can be exercised end-to-end
// against the real database, with no real subscription or network call. See
// the fixture's own header comment for how it picks a scenario.
process.env.CLAUDE_CLI_BIN = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));

const pages = [
  {
    pageIndex: 0,
    chapterHeading: null,
    words:
      ("Discipline is not the same as motivation. Motivation is a feeling and feelings are weather. " +
        "Discipline is a decision you made once and keep. The page argues that starting smaller than " +
        "feels useful is the only reliable way through the first fortnight of any new habit whatsoever.")
        .split(" "),
  },
];

interface Fixture {
  bookId: string;
}

async function withBook(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const book = await prisma.book.create({
    data: { id: `test-book-${randomUUID()}`, title: "Generate Content Test", rightsStatus: "in-copyright" },
  });
  try {
    await fn({ bookId: book.id });
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
}

async function ideaRowExists(bookId: string, ideaKey: string): Promise<boolean> {
  const row = await prisma.usedIdea.findUnique({ where: { bookId_ideaKey: { bookId, ideaKey } } });
  return !!row;
}

// --- Finding 1: a WRONG author name is rejected even when one IS verified ---

test("a mismatched author name is rejected even though the book's author is verified (finding 1)", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    await assert.rejects(
      () =>
        generateContent({
          bookId,
          bookTitle: "A Book SCENARIO:author-mismatch",
          author: "Cal Newport",
          authorVerified: true,
          archetype: "motivation",
          rightsStatus: "in-copyright",
          ideaKey,
          pages,
          provider: "claude-cli",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ContentRejectedError);
        assert.match(err.message, /named an author/i);
        return true;
      },
    );
    assert.equal(
      await ideaRowExists(bookId, ideaKey),
      false,
      "the deterministic author gate must release the reservation",
    );
  });
});

// --- Finding 3: a failure in the usedHook upsert still releases the idea ---

test("a failure in the usedHook upsert still releases the idea reservation (finding 3)", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    const original = prisma.usedHook.upsert;
    (prisma.usedHook as unknown as { upsert: unknown }).upsert = async () => {
      throw new Error("simulated database failure writing usedHook");
    };
    try {
      await assert.rejects(
        () =>
          generateContent({
            bookId,
            bookTitle: "A Book SCENARIO:usedhook-fail",
            author: null,
            authorVerified: false,
            archetype: "motivation",
            rightsStatus: "in-copyright",
            ideaKey,
            pages,
            provider: "claude-cli",
          }),
        /simulated database failure/,
      );
    } finally {
      (prisma.usedHook as unknown as { upsert: unknown }).upsert = original;
    }
    assert.equal(
      await ideaRowExists(bookId, ideaKey),
      false,
      "a burned idea with no video is exactly the harm decision 3 exists to prevent",
    );
  });
});

// --- Finding 5: the split fields are enforced, not left to `verdict` alone --

test("indicesGrounded: false is not swallowed by a verdict of 'pass' (finding 5)", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    await assert.rejects(
      () =>
        generateContent({
          bookId,
          bookTitle: "A Book SCENARIO:always-revise-flags-indices",
          author: null,
          authorVerified: false,
          archetype: "motivation",
          rightsStatus: "in-copyright",
          ideaKey,
          pages,
          provider: "claude-cli",
        }),
      ContentRejectedError,
    );
    assert.equal(await ideaRowExists(bookId, ideaKey), false);
  });
});

test("authorNamed: true on an unverified book is not swallowed by a verdict of 'pass' (finding 5)", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    await assert.rejects(
      () =>
        generateContent({
          bookId,
          bookTitle: "A Book SCENARIO:always-revise-flags-author",
          author: null,
          authorVerified: false,
          archetype: "motivation",
          rightsStatus: "in-copyright",
          ideaKey,
          pages,
          provider: "claude-cli",
        }),
      ContentRejectedError,
    );
    assert.equal(await ideaRowExists(bookId, ideaKey), false);
  });
});

test("authorNamed: true on a VERIFIED book does not by itself force a rewrite (finding 5 control)", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    const result = await generateContent({
      bookId,
      bookTitle: "A Book SCENARIO:verified-author-ok",
      author: "Cal Newport",
      authorVerified: true,
      archetype: "motivation",
      rightsStatus: "in-copyright",
      ideaKey,
      pages,
      provider: "claude-cli",
    });
    assert.equal(result.revised, false, "a correctly-named verified author must not trigger a rewrite");
    assert.equal(
      await ideaRowExists(bookId, ideaKey),
      true,
      "success keeps the reservation — it now belongs to the produced episode",
    );
    await prisma.usedHook.deleteMany({ where: { bookId } });
  });
});

// --- Every other throw site still releases (dynamic re-verification) -------

test("a hard CLI failure releases the idea reservation", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    await assert.rejects(() =>
      generateContent({
        bookId,
        bookTitle: "A Book SCENARIO:cli-failure",
        author: null,
        authorVerified: false,
        archetype: "motivation",
        rightsStatus: "in-copyright",
        ideaKey,
        pages,
        provider: "claude-cli",
      }),
    );
    assert.equal(await ideaRowExists(bookId, ideaKey), false);
  });
});

// --- The quotation budget joins the revision loop instead of throwing on
//     the first over-budget draft --------------------------------------------

test("an over-budget first draft is rewritten instead of thrown immediately, and the fixed draft is accepted", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    const result = await generateContent({
      bookId,
      bookTitle: "A Book SCENARIO:quotation-budget-recovers",
      author: null,
      authorVerified: false,
      archetype: "motivation",
      rightsStatus: "in-copyright",
      ideaKey,
      pages,
      provider: "claude-cli",
    });
    assert.equal(
      result.revised,
      true,
      "the over-budget first draft must have triggered a rewrite rather than an immediate throw",
    );
    assert.equal(
      await ideaRowExists(bookId, ideaKey),
      true,
      "a run that recovers via rewrite keeps its idea reservation, same as any other successful run",
    );
    await prisma.usedHook.deleteMany({ where: { bookId } });
  });
});

test("an over-budget draft that never recovers still fails with ContentRejectedError once the rewrite ceiling is reached, and releases the idea reservation", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    await assert.rejects(
      () =>
        generateContent({
          bookId,
          bookTitle: "A Book SCENARIO:quotation-budget",
          author: null,
          authorVerified: false,
          archetype: "motivation",
          rightsStatus: "in-copyright",
          ideaKey,
          pages,
          provider: "claude-cli",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ContentRejectedError);
        // The budget must never become advisory: it still fails after the
        // ceiling, and the message must help — how far over it ran, and that
        // the book's rights status is what drives the limit at all.
        assert.match(err.message, /longest run \d+ words/i);
        assert.match(err.message, /rights status is "in-copyright"/i);
        assert.match(err.message, /public-domain or own-work/i);
        return true;
      },
    );
    assert.equal(
      await ideaRowExists(bookId, ideaKey),
      false,
      "the budget ceiling must still release the reservation",
    );
  });
});

test("the happy path keeps the reservation and records a used hook", async () => {
  await withBook(async ({ bookId }) => {
    const ideaKey = `idea-${randomUUID()}`;
    const result = await generateContent({
      bookId,
      bookTitle: "A Book SCENARIO:clean-pass",
      author: null,
      authorVerified: false,
      archetype: "motivation",
      rightsStatus: "in-copyright",
      ideaKey,
      pages,
      provider: "claude-cli",
    });
    assert.equal(result.revised, false);
    assert.equal(await ideaRowExists(bookId, ideaKey), true);
    const hooks = await prisma.usedHook.findMany({ where: { bookId } });
    assert.equal(hooks.length, 1, "a successful run records the hook it used");
    await prisma.usedHook.deleteMany({ where: { bookId } });
  });
});
