import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { uploadDir } from "../paths";
import { checkPhotoBatch, MAX_PHOTOS } from "./validate";
import { normalizePhoto, deriveForComposition } from "./normalize";
import { BadUpload } from "../errors";

const RIGHTS = new Set(["public-domain", "in-copyright", "own-work"]);

export interface CreateUploadPage {
  id: string;
  pageIndex: number;
  width: number;
  height: number;
}

export interface CreateUploadResult {
  uploadId: string;
  bookId: string;
  pages: CreateUploadPage[];
}

/**
 * Any failure processing one photo — an unrecognised container from
 * `normalizePhoto`, or sharp choking while decoding a correctly-signed but
 * corrupt/truncated body — is the same "which file?" problem: the file's
 * own signature carries no name, so a 20-photo batch needs the name
 * attached at the call site regardless of which stage or error type raised
 * it. Always renamed as a `BadUpload`: whatever broke, the fix is the
 * operator retaking that one photo.
 */
function namedPhotoError(name: string, err: unknown): BadUpload {
  const message = err instanceof Error ? err.message : String(err);
  return new BadUpload(`${name}: ${message}`);
}

/**
 * All the logic behind `POST /api/uploads`, kept separate from the route so a
 * unit test can call it with no cookie jar: the route's only job is to
 * establish a session and hand off, exactly per "logic in pure functions, I/O
 * at the edges."
 */
export async function createUpload(form: FormData, userId: string | null): Promise<CreateUploadResult> {
  const title = String(form.get("title") ?? "").trim();
  if (!title) throw new BadUpload("Give the book a title so its episodes can be grouped.");

  const rightsStatus = String(form.get("rightsStatus") ?? "in-copyright");
  if (!RIGHTS.has(rightsStatus)) throw new BadUpload(`"${rightsStatus}" is not a rights status.`);

  const entries = form.getAll("photos").filter((v): v is File => v instanceof File);

  // MAX_PHOTOS is enforced from the entry count alone, before a single byte
  // is read: a batch of 10,000 files must be refused up front, not after
  // reading 10,000 buffers into memory first.
  if (entries.length > MAX_PHOTOS) {
    throw new BadUpload(`That is ${entries.length} photographs; at most ${MAX_PHOTOS} can go in one upload.`);
  }

  // Real received bytes, never the client-declared `File.size` — a lying
  // client can claim any size it likes, so the caps only hold if they are
  // computed from what actually arrived.
  const buffers = await Promise.all(entries.map(async (f) => Buffer.from(await f.arrayBuffer())));
  checkPhotoBatch(entries.map((f, i) => ({ name: f.name, bytes: buffers[i].length })));

  // Looked up by title so a second upload of the same book adds to it rather
  // than forking a parallel series with its own used-idea history. Tracked
  // separately so a failure below knows whether it is safe to remove the
  // book too, or whether the book pre-dates this call and has other uploads
  // riding on it.
  let book = await prisma.book.findFirst({ where: { title } });
  const bookCreatedHere = !book;
  if (!book) {
    book = await prisma.book.create({ data: { title, rightsStatus } });
  }

  // `upload` starts null and is set the moment `prisma.upload.create`
  // resolves. `upload.create` itself is INSIDE the protected region: if it
  // throws (a transient DB fault), the catch below still sees
  // `bookCreatedHere` and can clean up the Book — the same leak the review
  // originally found, just through a narrower door when the row was never
  // created at all.
  let upload: { id: string } | null = null;

  try {
    upload = await prisma.upload.create({ data: { bookId: book.id, userId: userId ?? undefined } });
    const dir = uploadDir(upload.id);

    const pages: CreateUploadPage[] = [];
    for (let i = 0; i < entries.length; i++) {
      const stem = `page-${String(i).padStart(2, "0")}`;
      const filePath = path.join(dir, `${stem}.jpg`);
      const derivedPath = path.join(dir, `${stem}-derived.jpg`);

      let width: number;
      let height: number;
      try {
        ({ width, height } = await normalizePhoto(buffers[i], filePath));
      } catch (err) {
        throw namedPhotoError(entries[i].name, err);
      }

      // Derived from the normalised original (already EXIF-stripped and
      // rotated), never from the raw upload buffer, so the derivative and the
      // original agree on orientation.
      try {
        await deriveForComposition(filePath, derivedPath);
      } catch (err) {
        throw namedPhotoError(entries[i].name, err);
      }

      const page = await prisma.page.create({
        data: {
          uploadId: upload.id,
          pageIndex: i,
          filePath,
          derivedPath,
          // The ORIGINAL's dimensions, not the derivative's: they describe the
          // source photo. The derivative's own size is recoverable from its file.
          width,
          height,
        },
      });
      pages.push({ id: page.id, pageIndex: page.pageIndex, width: page.width, height: page.height });
    }

    return { uploadId: upload.id, bookId: book.id, pages };
  } catch (err) {
    // A failed batch must leave nothing behind: no orphaned Upload/Page rows,
    // no orphaned photographs on disk under WORK_ROOT, and no Book that
    // exists only because this failed call created it. Book photography
    // fails often (a blurred page, a thumb over the text) — without this,
    // every rejected batch in production would permanently accumulate
    // private photographs with no garbage collection.
    //
    // Every step here is independently guarded with `.catch()` so that a
    // cleanup failure — the row already gone, a transient DB fault reading
    // the remaining count — can never replace or mask `err`, the actual
    // reason the upload failed. The caller must always see `err`, never a
    // database error from tidying up after it.
    if (upload) {
      const uploadId = upload.id;
      await prisma.upload.delete({ where: { id: uploadId } }).catch(() => {});
      await fs.rm(uploadDir(uploadId), { recursive: true, force: true }).catch(() => {});
    }

    if (bookCreatedHere) {
      // If the count itself can't be read, do nothing rather than guess:
      // deleting the book on a guess could remove one that in fact gained
      // another upload concurrently. Leaving one orphaned book behind on a
      // database fault is a far smaller cost than losing `err` to a cleanup
      // exception.
      const remaining = await prisma.upload.count({ where: { bookId: book.id } }).catch(() => null);
      if (remaining === 0) {
        await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      }
    }

    throw err;
  }
}
