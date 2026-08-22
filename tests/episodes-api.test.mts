import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../src/app/api/episodes/route";
import { prisma } from "../src/lib/db";

test("the library lists episodes newest first, with the book title attached", async () => {
  const book = await prisma.book.create({ data: { title: "Deep Work", rightsStatus: "in-copyright" } });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  // Stamp explicit, distinct createdAt values rather than relying on insertion
  // order: two `create()` calls in the same test can land in the same
  // millisecond on a fast machine, which would make "newest first" flaky.
  const older = new Date("2026-01-01T00:00:00.000Z");
  const newer = new Date("2026-01-02T00:00:00.000Z");

  await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, title: "Older", partNumber: 1, createdAt: older },
  });
  await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, title: "Newer", partNumber: 2, createdAt: newer },
  });

  const res = await GET();
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.episodes[0].title, "Newer", "newest first");
  assert.equal(body.episodes[0].createdAt, newer.toISOString());
  assert.equal(body.episodes[1].title, "Older");
  assert.equal(body.episodes[1].createdAt, older.toISOString());
  assert.equal(body.episodes[0].bookTitle, "Deep Work");

  await prisma.book.delete({ where: { id: book.id } });
});
