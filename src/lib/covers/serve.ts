import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { visibleTo } from "@/lib/episodes/visibility";
import { clearCover, COVERS_ROOT, deriveCover, isWebp } from "./derive";
import { DEFAULT_COVER_SIZE, parseCoverSize } from "./sizes";
import { coverState, locateSource } from "./status";

/**
 * A failure is `no-store`: the browser must not remember "no cover" for a URL
 * that a later request (the page finishing extraction, a Regenerate) can make
 * succeed.
 */
const notFound = (error = "Not found") =>
  Response.json({ error }, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * One upload the signed-in user may see, with the one page its cover is made
 * from. `visibleTo` is the rule the library lists by -- the user's own AND the
 * ones nobody owns -- so a card never has a cover that 404s; and it never
 * reaches another account's upload.
 *
 * `pages` is `take: 1` ordered by `pageIndex`, so "the cover is the first page"
 * does not assume the first page is numbered 0.
 */
async function findUpload(userId: string, uploadId: string) {
  return prisma.upload.findFirst({
    where: { id: uploadId, ...visibleTo(userId) },
    select: {
      id: true,
      book: { select: { id: true, coverPath: true } },
      pages: { orderBy: { pageIndex: "asc" }, take: 1, select: { derivedPath: true, filePath: true } },
    },
  });
}

type Found = NonNullable<Awaited<ReturnType<typeof findUpload>>>;

/** Is `p` one of this app's own, whole, covers? Anything else is only advisory. */
async function isOurCover(p: string): Promise<boolean> {
  const rel = path.relative(COVERS_ROOT, path.resolve(p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return isWebp(path.resolve(p));
}

/**
 * Record where this upload's cover lives on `Book.coverPath`.
 *
 * The column is a RECORD, never a source: serving derives the path from the
 * upload id and never reads this string back, so a stale, foreign or hostile
 * value (a URL, a path to someone else's file) can mislead nothing. That is the
 * lesson of the posters, where `selectThumb` trusted a stored path and had to
 * be changed to derive one.
 *
 * It records `made`, the file this request just produced or served, because
 * covers are made one size at a time and that is the one known to exist. It is
 * written when the stored value is not already one of our whole covers. A book
 * can have several uploads and the column holds one path, so while a valid
 * cover is recorded it is left alone rather than rewritten by whichever upload
 * was asked for last; once that file is gone the value is stale and the next
 * cover derived replaces it. Best effort: the book still has its cover if this
 * write fails.
 */
async function recordCoverPath(upload: Found, made: string): Promise<void> {
  try {
    const stored = upload.book.coverPath;
    if (stored === made) return;
    if (stored && (await isOurCover(stored))) return;
    await prisma.book.update({ where: { id: upload.book.id }, data: { coverPath: made } });
  } catch {
    // The cover is served either way.
  }
}

/**
 * Stream one cover to a signed-in user who may see its upload.
 *
 * Lives outside the route handler for the reason `serveThumbnail` does: the
 * route's other job is `requireUser()`, which reads `cookies()` and cannot run
 * outside a request, so the rules -- the part worth testing -- stay here.
 *
 * `size` is hostile input and is validated against a closed set
 * (`parseCoverSize`); anything else is the default size. It never reaches a
 * path. Neither does `uploadId`: the file is found from the row's own id.
 *
 * Every way a cover can be unavailable -- no such upload, someone else's, no
 * pages, the page gone, an image that will not decode, the database
 * erroring -- is a 404 with a JSON body. Nothing here throws.
 *
 * The caching is the posters' lesson applied from the start. The response is
 * `immutable` for a year, which is only safe because the URL that asks for it
 * carries `v=<coverRev>` (see `coverUrl`): a re-rendered page or a Regenerate
 * changes the revision, so it is a different URL. The ETag is the fallback for a
 * request that bypasses the cache.
 */
export async function serveCover(
  userId: string,
  uploadId: string,
  sizeParam: string | null,
  ifNoneMatch: string | null,
): Promise<Response> {
  try {
    const upload = await findUpload(userId, uploadId);
    if (!upload) return notFound();

    const page = upload.pages[0];
    if (!page) return notFound("This book has no pages yet.");
    const source = await locateSource(page);
    if (!source) return notFound("This book's first page is no longer on disk.");

    const size = parseCoverSize(sizeParam) ?? DEFAULT_COVER_SIZE;
    const file = await deriveCover(upload.id, source.path, size);
    if (!file) return notFound("A cover could not be made from this book's first page.");

    await recordCoverPath(upload, file);

    const stat = await fs.stat(file);
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const cacheControl = "private, max-age=31536000, immutable";
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
    }

    // A cover is a few tens of kilobytes, so it is read whole rather than
    // streamed: no file handle stays open for the length of a slow download,
    // which on Windows would block the Regenerate that replaces it.
    const bytes = await fs.readFile(file);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(bytes.length),
        // `private`: a shared proxy must never hold one operator's photograph
        // of their own book where another could be handed it.
        "Cache-Control": cacheControl,
        ETag: etag,
        "Content-Disposition": `inline; filename="cover-${size}.webp"`,
      },
    });
  } catch {
    return notFound("The cover is unavailable.");
  }
}

/**
 * Throw away an upload's cached covers and make the card's again.
 *
 * The cache is cleared as asked, and the `small` cover (the one the list shows)
 * is re-derived NOW rather than on the next request, so the response can carry
 * the new `coverRev`. That is the point: the old file is `immutable` in the
 * browser at its old URL, and only a new revision reaches it. It also makes the
 * button honest -- the operator learns whether the page can produce a cover
 * (`failed`) instead of seeing nothing happen. The other sizes are made when
 * something asks for them.
 *
 * The page is located FIRST and the cache is cleared only if it is there. With
 * the page gone the cached covers are the last copy of what it looked like, and
 * deleting them would turn "re-derive" into "destroy". So the one thing this
 * deletes is always something that can be derived again.
 *
 * That is what lets it be reachable by `visibleTo`, the same rule as reading,
 * ownerless uploads included. `visibility.ts` warns that destructive writes
 * hand an ownerless record to whoever signs in first; this is not one.
 *
 * Answers 200 whenever the upload is the user's to see, whatever the outcome:
 * the request worked, and `coverStatus` says how the cover fared.
 */
export async function regenerateCover(userId: string, uploadId: string): Promise<Response> {
  try {
    const upload = await findUpload(userId, uploadId);
    if (!upload) return notFound();

    const page = upload.pages[0] ?? null;
    const source = page ? await locateSource(page) : null;
    if (source) {
      await clearCover(upload.id);
      const made = await deriveCover(upload.id, source.path, "small");
      if (made) await recordCoverPath(upload, made);
    }

    const state = await coverState(upload.id, page);
    return Response.json(
      { ok: true, coverStatus: state.status, coverRev: state.rev },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return notFound("The cover could not be regenerated.");
  }
}
