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
  // than forking a parallel series with its own used-idea history.
  const book =
    (await prisma.book.findFirst({ where: { title } })) ??
    (await prisma.book.create({ data: { title, rightsStatus } }));

  const upload = await prisma.upload.create({ data: { bookId: book.id, userId: userId ?? undefined } });
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
      // normalizePhoto's own signature carries no filename, so the error is
      // rethrown here with the file's name attached — in a 20-photo batch,
      // "a file was not an image" is useless without saying which one.
      if (err instanceof BadUpload) throw new BadUpload(`${entries[i].name}: ${err.message}`);
      throw err;
    }

    // Derived from the normalised original (already EXIF-stripped and
    // rotated), never from the raw upload buffer, so the derivative and the
    // original agree on orientation.
    await deriveForComposition(filePath, derivedPath);

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
}
