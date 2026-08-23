import test from "node:test";
import { randomUUID } from "node:crypto";
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

  try {
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
  } finally {
    // Always clean up, even when an assertion above throws — otherwise a
    // failed run leaves this fixture book (and its uploaded files) behind.
    await prisma.book.delete({ where: { id: body.bookId } });
    await fs.rm(uploadDir(body.uploadId), { recursive: true, force: true });
  }
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

test("if cleanup's own count() read fails, the original per-photo error still reaches the caller", async () => {
  // Simulates finding 4(a): a transient database fault inside the cleanup
  // path itself, at the exact read used to decide whether the Book it
  // created is now orphaned. The caller must still see why their upload
  // failed (which photo was bad), never a database error from tidying up.
  const form = new FormData();
  form.set("title", "Count Fails");
  form.append("photos", new Blob([new Uint8Array(Buffer.from("not an image"))], { type: "image/jpeg" }), "bad.jpg");

  const originalCount = prisma.upload.count.bind(prisma.upload);
  // @ts-expect-error -- deliberately swapped in for the duration of this test to simulate a transient DB fault
  prisma.upload.count = async () => {
    throw new Error("simulated transient database fault");
  };

  try {
    try {
      await assert.rejects(
        () => createUpload(form, null),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, "bad_upload");
          assert.ok(
            err.message.includes("bad.jpg"),
            "the original BadUpload survives cleanup's own failure, not the simulated database fault",
          );
          return true;
        },
      );
    } finally {
      prisma.upload.count = originalCount;
    }
  } finally {
    // count() failing means cleanup could not safely tell whether the Book
    // was left orphaned, so it deliberately leaves it rather than guessing —
    // clean it up here so the suite doesn't leak it. This runs even if the
    // assertion above throws, so a failed run can't leave it behind either.
    await prisma.book.deleteMany({ where: { title: "Count Fails" } });
  }
});

test("if upload.create itself fails, a Book created for this call is still cleaned up", async () => {
  // Simulates finding 4(b): the original code ran `upload.create` before
  // the protected region, so a fault here left a freshly-created Book
  // behind with no upload ever attached to it.
  const form = new FormData();
  form.set("title", "Create Fails");
  form.append("photos", await photo(80, 120), "page-1.jpg");

  const originalCreate = prisma.upload.create.bind(prisma.upload);
  // @ts-expect-error -- deliberately swapped in for the duration of this test to simulate a transient DB fault
  prisma.upload.create = async () => {
    throw new Error("simulated transient database fault");
  };

  try {
    try {
      await assert.rejects(() => createUpload(form, null));
    } finally {
      prisma.upload.create = originalCreate;
    }

    const book = await prisma.book.findFirst({ where: { title: "Create Fails" } });
    assert.equal(book, null, "the Book created for this call was cleaned up even though upload.create itself failed");
  } finally {
    // Safety net: if the assertion above ever fails (a regression in the
    // cleanup path being tested), don't let the orphan it caught survive
    // into the next run.
    await prisma.book.deleteMany({ where: { title: "Create Fails" } });
  }
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

/**
 * Uploads are grouped by book title, so the second batch for a book finds an
 * existing row. The link used to be written only on creation, which meant an
 * operator who forgot it on the first upload — or typed the wrong one — could
 * never fix it for that series.
 */
test("a book link supplied on a later upload reaches a book that already exists", async () => {
  const title = `Deep Work ${randomUUID()}`;
  const first = new FormData();
  first.set("title", title);
  first.set("rightsStatus", "in-copyright");
  first.append("photos", await photo(80, 120), "page-1.jpg");
  const a = await createUpload(first, null);

  try {
    const before = await prisma.book.findUniqueOrThrow({ where: { id: a.bookId } });
    assert.equal(before.bookLink, null, "no link was given the first time");

    const second = new FormData();
    second.set("title", title);
    second.set("rightsStatus", "in-copyright");
    second.set("bookLink", "https://example.com/the-book");
    second.append("photos", await photo(80, 120), "page-2.jpg");
    const b = await createUpload(second, null);
    assert.equal(b.bookId, a.bookId, "same title means the same book, not a fork");

    const after = await prisma.book.findUniqueOrThrow({ where: { id: a.bookId } });
    assert.equal(after.bookLink, "https://example.com/the-book");

    // Leaving the field blank later is not a request to erase what is there.
    const third = new FormData();
    third.set("title", title);
    third.set("rightsStatus", "in-copyright");
    third.append("photos", await photo(80, 120), "page-3.jpg");
    await createUpload(third, null);
    const untouched = await prisma.book.findUniqueOrThrow({ where: { id: a.bookId } });
    assert.equal(untouched.bookLink, "https://example.com/the-book", "a blank field must not erase the link");

    // And a hostile value never reaches the row.
    const fourth = new FormData();
    fourth.set("title", title);
    fourth.set("rightsStatus", "in-copyright");
    fourth.set("bookLink", "javascript:alert(1)");
    fourth.append("photos", await photo(80, 120), "page-4.jpg");
    await createUpload(fourth, null);
    const safe = await prisma.book.findUniqueOrThrow({ where: { id: a.bookId } });
    assert.equal(safe.bookLink, "https://example.com/the-book", "a non-http(s) link is discarded, not stored");
  } finally {
    await prisma.book.delete({ where: { id: a.bookId } });
  }
});
