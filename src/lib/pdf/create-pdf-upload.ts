import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { uploadDir } from "../paths";
import { BadUpload } from "../errors";
import { normalizeBookLink } from "../content/book-link";

/** A 200-page scanned book at 300dpi is ~150MB; anything past this is not a book. */
export const MAX_PDF_BYTES = 300 * 1024 * 1024;

const RIGHTS = new Set(["public-domain", "in-copyright", "own-work"]);

export interface PdfUploadInput {
  title: string;
  rightsStatus?: string | null;
  bookLink?: string | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface PdfUploadResult {
  uploadId: string;
  bookId: string;
}

export function pdfPath(uploadId: string): string {
  return path.join(uploadDir(uploadId), "source.pdf");
}

/**
 * Stream a request body to disk, refusing it the moment it passes the cap —
 * a PDF is written as it arrives rather than buffered, so a 200MB book never
 * sits in the server's memory, and an oversized one is cut off at the cap
 * rather than read to the end first.
 */
async function streamToFile(body: ReadableStream<Uint8Array>, file: string): Promise<number> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  const reader = body.getReader();
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PDF_BYTES) {
        throw new BadUpload(`That PDF is over ${MAX_PDF_BYTES / 1024 / 1024}MB, which is larger than any book this can read.`);
      }
      if (head.length < 1024) head = Buffer.concat([head, Buffer.from(value.subarray(0, 1024 - head.length))]);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
    reader.releaseLock();
  }
  if (bytes === 0) throw new BadUpload("The PDF was empty.");
  // The PDF signature may follow a little leading junk; readers allow 1KB.
  if (!head.includes(Buffer.from("%PDF-"))) throw new BadUpload("That file is not a PDF.");
  return bytes;
}

/**
 * Create a Book (found by title, exactly as a photo upload is, so a PDF of a
 * book already photographed joins its series) and an Upload of kind "pdf",
 * then write the PDF under the upload's directory. A failure leaves nothing
 * behind, for the same reasons given in `createUpload`.
 */
export async function createPdfUpload(input: PdfUploadInput, userId: string | null): Promise<PdfUploadResult> {
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new BadUpload("Give the book a title so its ideas can be grouped.");
  const rightsStatus = input.rightsStatus || "in-copyright";
  if (!RIGHTS.has(rightsStatus)) throw new BadUpload(`"${rightsStatus}" is not a rights status.`);
  if (!input.body) throw new BadUpload("No PDF was sent.");
  const bookLink = normalizeBookLink(input.bookLink ?? null);

  let book = await prisma.book.findFirst({ where: { title } });
  const bookCreatedHere = !book;
  if (!book) {
    book = await prisma.book.create({ data: { title, rightsStatus, ...(bookLink ? { bookLink } : {}) } });
  } else if (bookLink && bookLink !== book.bookLink) {
    book = await prisma.book.update({ where: { id: book.id }, data: { bookLink } });
  }

  let uploadId: string | null = null;
  try {
    const upload = await prisma.upload.create({
      data: { bookId: book.id, userId: userId ?? undefined, kind: "pdf" },
    });
    uploadId = upload.id;
    const file = pdfPath(upload.id);
    await streamToFile(input.body, file);
    await prisma.upload.update({ where: { id: upload.id }, data: { sourcePath: file } });
    return { uploadId: upload.id, bookId: book.id };
  } catch (err) {
    if (uploadId) {
      const id = uploadId;
      await prisma.upload.delete({ where: { id } }).catch(() => {});
      await fsp.rm(uploadDir(id), { recursive: true, force: true }).catch(() => {});
    }
    if (bookCreatedHere) {
      const remaining = await prisma.upload.count({ where: { bookId: book.id } }).catch(() => null);
      if (remaining === 0) await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
    }
    throw err;
  }
}
