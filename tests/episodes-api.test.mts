import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GET } from "../src/app/api/episodes/route";
import { prisma } from "../src/lib/db";

test("the library lists episodes newest first, with the book title attached", async () => {
  // Unique per run so two concurrent or successive runs (including a prior
  // failed run that didn't get to clean up) can never be mistaken for one
  // another — the assertions below key off this book's own rows, not a
  // fixed title.
  const bookTitle = `Deep Work ${randomUUID()}`;
  const book = await prisma.book.create({ data: { title: bookTitle, rightsStatus: "in-copyright" } });

  try {
    const upload = await prisma.upload.create({ data: { bookId: book.id } });

    // Stamp explicit, distinct createdAt values rather than relying on
    // insertion order: two `create()` calls in the same test can land in the
    // same millisecond on a fast machine, which would make "newest first"
    // flaky. These only need to be distinct from each other *within this
    // book* — the assertions below scope to this book's own episodes, so
    // they no longer need to be unique across the whole table.
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-01-02T00:00:00.000Z");

    const olderEpisode = await prisma.episode.create({
      data: { bookId: book.id, uploadId: upload.id, title: "Older", partNumber: 1, createdAt: older },
    });
    const newerEpisode = await prisma.episode.create({
      data: { bookId: book.id, uploadId: upload.id, title: "Newer", partNumber: 2, createdAt: newer },
    });

    const res = await GET();
    const body = await res.json();

    assert.equal(res.status, 200);

    // GET /api/episodes returns the 100 most recent episodes across ALL
    // books, so other rows (from this test's own past runs, other test
    // files, or real dev data) may be present. Scope to the two rows this
    // test created rather than asserting on absolute positions in that
    // shared listing.
    const ownIds = new Set([olderEpisode.id, newerEpisode.id]);
    const own = body.episodes.filter((e: { id: string }) => ownIds.has(e.id));

    assert.equal(own.length, 2, "both of this test's own episodes are present in the listing");
    assert.equal(own[0].title, "Newer", "newest first");
    assert.equal(own[0].createdAt, newer.toISOString());
    assert.equal(own[0].bookTitle, bookTitle);
    assert.equal(own[1].title, "Older");
    assert.equal(own[1].createdAt, older.toISOString());
    assert.equal(own[1].bookTitle, bookTitle);
  } finally {
    // Always clean up, even when an assertion above throws — otherwise a
    // failed run leaves this fixture book behind to corrupt the next one.
    await prisma.book.delete({ where: { id: book.id } });
  }
});
