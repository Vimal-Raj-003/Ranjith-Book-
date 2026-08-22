import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";

test("a book holds an upload holds pages, and an episode belongs to both", async () => {
  const book = await prisma.book.create({
    data: { title: "Test Title", rightsStatus: "in-copyright", archetype: "motivation" },
  });

  assert.equal(book.author, null, "author starts absent, never placeholdered");
  assert.equal(book.authorVerified, false, "author starts unverified");

  const upload = await prisma.upload.create({ data: { bookId: book.id } });
  await prisma.page.create({
    data: { uploadId: upload.id, pageIndex: 0, filePath: "/tmp/a.jpg", width: 100, height: 200 },
  });

  const episode = await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, partNumber: 1, seriesTotal: 1, theme: "marginalia" },
  });

  const loaded = await prisma.upload.findUniqueOrThrow({
    where: { id: upload.id },
    include: { pages: true, episodes: true },
  });
  assert.equal(loaded.pages.length, 1);
  assert.equal(loaded.episodes[0].id, episode.id);

  await prisma.book.delete({ where: { id: book.id } });
  const orphans = await prisma.page.count({ where: { uploadId: upload.id } });
  assert.equal(orphans, 0, "deleting a book cascades to its pages");
});

test("an idea can only be claimed once per book", async () => {
  const book = await prisma.book.create({ data: { title: "Once", rightsStatus: "own-work" } });
  await prisma.usedIdea.create({ data: { bookId: book.id, ideaKey: "discipline-beats-motivation" } });

  await assert.rejects(
    () => prisma.usedIdea.create({ data: { bookId: book.id, ideaKey: "discipline-beats-motivation" } }),
    /Unique constraint/i,
    "the same angle must not be claimable twice for one book",
  );

  await prisma.book.delete({ where: { id: book.id } });
});
