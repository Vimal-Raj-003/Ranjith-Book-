import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import sharp from "sharp";
import { createUpload } from "../src/lib/ingest/create-upload";
import { prisma } from "../src/lib/db";
import { UPLOAD_DIR, uploadDir } from "../src/lib/paths";

async function photo(width: number, height: number): Promise<Blob> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: "#eeeeee" },
  }).jpeg().toBuffer();
  return new Blob([new Uint8Array(buf)], { type: "image/jpeg" });
}

async function listUploadDir(): Promise<string[]> {
  return fs.readdir(UPLOAD_DIR).catch(() => [] as string[]);
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
  await fs.rm(uploadDir(body.uploadId), { recursive: true, force: true });
});

test("a non-image is refused with a named error, not an empty 500, and leaves nothing behind", async () => {
  const before = await listUploadDir();

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

  // Regression guard for the orphan-accumulation bug: a failed createUpload
  // must leave nothing behind — no Book that exists only because this call
  // created it, no Upload row, and no photographs on disk. Book photography
  // fails often, so without this every rejected batch in production would
  // permanently accumulate private files with no garbage collection.
  const book = await prisma.book.findFirst({ where: { title: "Nope" } });
  assert.equal(book, null, "the Book created for this failed upload was cleaned up, not left orphaned");

  const orphanedUploads = await prisma.upload.findMany({ where: { book: { title: "Nope" } } });
  assert.equal(orphanedUploads.length, 0, "no Upload row was left behind for the failed batch");

  const after = await listUploadDir();
  assert.deepEqual(after.sort(), before.sort(), "no upload directory was left behind on disk");
});

test("a corrupt-but-correctly-signed image is refused with the file named, not an unnamed 500", async () => {
  // Valid JPEG magic bytes, garbage body: passes detectImageType's sniff,
  // then fails inside sharp's decoder — a generic Error, not a BadUpload,
  // which is exactly the case decision 4 originally missed.
  const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("not actually jpeg data")]);
  const form = new FormData();
  form.set("title", "Also Nope");
  form.append("photos", new Blob([new Uint8Array(corrupt)], { type: "image/jpeg" }), "blurry.jpg");

  await assert.rejects(
    () => createUpload(form, null),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "bad_upload");
      assert.ok(err.message.includes("blurry.jpg"), "the message names the offending file even for a non-BadUpload failure");
      return true;
    },
  );

  const book = await prisma.book.findFirst({ where: { title: "Also Nope" } });
  assert.equal(book, null, "cleanup runs for this failure path too");
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
