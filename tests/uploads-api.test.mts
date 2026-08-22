import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createUpload } from "../src/lib/ingest/create-upload";
import { prisma } from "../src/lib/db";

async function photo(width: number, height: number): Promise<Blob> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: "#eeeeee" },
  }).jpeg().toBuffer();
  return new Blob([new Uint8Array(buf)], { type: "image/jpeg" });
}

test("an upload creates a book, an upload and one page per photo, in order", async () => {
  const form = new FormData();
  form.set("title", "Atomic Habits");
  form.set("rightsStatus", "in-copyright");
  form.append("photos", await photo(80, 120), "page-1.jpg");
  form.append("photos", await photo(80, 120), "page-2.jpg");

  const body = await createUpload(form, null);

  assert.equal(body.pages.length, 2);
  assert.deepEqual(body.pages.map((p) => p.pageIndex), [0, 1],
    "page order is the order they were sent — it is the reading order");

  const book = await prisma.book.findUniqueOrThrow({ where: { id: body.bookId } });
  assert.equal(book.author, null, "an upload never sets an author");
  assert.equal(book.authorVerified, false);

  const pages = await prisma.page.findMany({ where: { uploadId: body.uploadId }, orderBy: { pageIndex: "asc" } });
  for (const page of pages) {
    assert.ok(page.derivedPath, "derivedPath is populated at upload time, not deferred to ingest");
    assert.equal(page.width, 80, "width/height describe the ORIGINAL, not the derived image");
    assert.equal(page.height, 120);
  }

  await prisma.book.delete({ where: { id: body.bookId } });
});

test("a non-image is refused with a named error, not an empty 500", async () => {
  const form = new FormData();
  form.set("title", "Nope");
  form.append("photos", new Blob([new Uint8Array(Buffer.from("not an image"))], { type: "image/jpeg" }), "evil.jpg");

  await assert.rejects(
    () => createUpload(form, null),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "bad_upload");
      assert.ok(err.message.includes("evil.jpg"), "the message names the offending file");
      return true;
    },
  );
});

test("a batch bigger than MAX_PHOTOS is refused before any bytes are read", async () => {
  const form = new FormData();
  form.set("title", "Too Many");
  for (let i = 0; i < 21; i++) {
    form.append("photos", new Blob([new Uint8Array(Buffer.from("x"))], { type: "image/jpeg" }), `p${i}.jpg`);
  }

  await assert.rejects(
    () => createUpload(form, null),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "bad_upload");
      assert.match(err.message, /at most/i);
      return true;
    },
  );
});
