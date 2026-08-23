import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { listEpisodes } from "../src/lib/episodes/list";
import { prisma } from "../src/lib/db";

/**
 * `listEpisodes` is tested rather than the route handler: the route's only
 * other job is `requireUser()`, which reads `cookies()` and throws outside a
 * request scope, so calling `GET()` here could only ever assert on that throw.
 * This is the same split `uploads-api.test.mts` uses against `createUpload`.
 */
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

    const episodes = await listEpisodes(`viewer-${randomUUID()}`);

    // The listing returns the 100 most recent episodes visible to the viewer,
    // so other rows (from this test's own past runs, other test files, or
    // real dev data) may be present. Scope to the two rows this test created
    // rather than asserting on absolute positions in that shared listing.
    const ownIds = new Set([olderEpisode.id, newerEpisode.id]);
    const own = episodes.filter((e) => ownIds.has(e.id));

    assert.equal(own.length, 2, "both of this test's own episodes are present in the listing");
    assert.equal(own[0].title, "Newer", "newest first");
    assert.equal(own[0].createdAt.toISOString(), newer.toISOString());
    assert.equal(own[0].bookTitle, bookTitle);
    assert.equal(own[1].title, "Older");
    assert.equal(own[1].createdAt.toISOString(), older.toISOString());
    assert.equal(own[1].bookTitle, bookTitle);
  } finally {
    // Always clean up, even when an assertion above throws — otherwise a
    // failed run leaves this fixture book behind to corrupt the next one.
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("the library never shows one account's episodes to another", async () => {
  const bookTitle = `Private ${randomUUID()}`;
  const book = await prisma.book.create({ data: { title: bookTitle, rightsStatus: "in-copyright" } });
  const owner = await prisma.user.create({ data: { email: `owner-${randomUUID()}@example.test` } });
  const stranger = await prisma.user.create({ data: { email: `stranger-${randomUUID()}@example.test` } });

  try {
    const upload = await prisma.upload.create({ data: { bookId: book.id } });
    const mine = await prisma.episode.create({
      data: { bookId: book.id, uploadId: upload.id, title: "Owned", userId: owner.id },
    });
    const unowned = await prisma.episode.create({
      data: { bookId: book.id, uploadId: upload.id, title: "Legacy", userId: null },
    });

    const asOwner = (await listEpisodes(owner.id)).map((e) => e.id);
    const asStranger = (await listEpisodes(stranger.id)).map((e) => e.id);

    assert.ok(asOwner.includes(mine.id), "the owner sees their own episode");
    assert.ok(
      !asStranger.includes(mine.id),
      "another account must never see it — this route had no auth at all before, and listed every episode in the database to anyone",
    );

    // Episodes predating sign-in carry no userId. Both accounts see them, and
    // that is deliberate: `GET /api/episodes/[id]` allows exactly the same
    // rows, and a list that disagrees with the detail route is what produced
    // rows that 404'd when opened.
    assert.ok(asOwner.includes(unowned.id) && asStranger.includes(unowned.id),
      "an unowned legacy episode stays visible, matching the detail route");
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
  }
});
