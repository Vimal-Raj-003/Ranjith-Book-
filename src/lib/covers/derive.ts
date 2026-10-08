import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { WORK_ROOT } from "../paths";
import { COVER_MAX_ASPECT, COVER_SIZES, COVER_WIDTH, type CoverSize } from "./sizes";

/**
 * Book covers: page 0 of an upload, downscaled to three sizes and cached. Each
 * size is made the first time it is asked for, not all at once.
 *
 * A cache, not a product. Every file here is reproducible from the page image
 * under `uploads/<id>/pages`, so deleting `covers/` costs one derivation per
 * book and nothing else. It is deliberately outside `public/` for the reason
 * `thumbs/` is: a file under `public/` is served by name with no handler in
 * front of it, and a cover is a photograph of a book someone is reading.
 *
 * This mirrors `thumbnails/derive.ts` -- derive on first request, write beside
 * the destination and rename into place, trust a cached file only while it is
 * no older than its source -- and adds the one thing that module does not need:
 * the bytes are looked at. See `isWebp`.
 */
export const COVERS_ROOT = path.join(WORK_ROOT, "covers");

/**
 * An id that is safe to use as one path segment. Upload ids are cuids, so this
 * is a check that the thing is what it says, not a restriction on real data.
 * Every public function here asks first and answers "no cover" otherwise: the
 * ids that reach it come from rows the caller has already looked up, and this
 * is the line that holds even if one day they do not.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export const isSafeId = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id);

export function coverDir(uploadId: string): string {
  if (!isSafeId(uploadId)) throw new Error("not an upload id");
  return path.join(COVERS_ROOT, uploadId);
}

export function coverFile(uploadId: string, size: CoverSize): string {
  return path.join(coverDir(uploadId), `${size}.webp`);
}

/**
 * Is the file at `file` a whole WebP?
 *
 * The cache never re-derives a hit, so whatever passes this is what every later
 * request serves with a year-long lifetime. Size and mtime are not enough: a
 * process killed mid-write, a full disk, or an antivirus quarantine can leave a
 * file that is the right age and the wrong bytes, and the browser would be told
 * to keep it for good. A WebP is `RIFF <size> WEBP <chunk>`, so the first
 * sixteen bytes are read: the two magic words, a first chunk that is one of
 * the three WebP bitstreams, and a declared length that the file actually
 * reaches. That last check is what catches truncation, which keeps its header.
 *
 * Any failure to look -- missing, unreadable, short -- is "no", never an
 * error: a bad cache entry degrades to making the cover again.
 */
export async function isWebp(file: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    const { size } = await fs.stat(file);
    if (size < 20) return false;
    handle = await fs.open(file, "r");
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < head.length) return false;
    return (
      head.toString("latin1", 0, 4) === "RIFF" &&
      head.toString("latin1", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(head.toString("latin1", 12, 16)) &&
      head.readUInt32LE(4) + 8 <= size
    );
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * A cover is a pure function of its page, so it is valid for as long as it is no
 * older than that page. A re-rendered page (the analysis re-extracts its pages
 * on a retry) has a newer mtime and so is re-derived, not shown stale.
 */
async function isFresh(made: string, sourceMtimeMs: number): Promise<boolean> {
  try {
    const s = await fs.stat(made);
    return s.size > 0 && s.mtimeMs >= sourceMtimeMs && (await isWebp(made));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- the failure marker

const failedMarker = (dir: string) => path.join(dir, "failed");

async function markFailed(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(failedMarker(dir), new Date().toISOString());
  } catch {
    // Best effort. Without the marker the status reads "ready" and the next
    // request tries again, which is the safe direction to be wrong in.
  }
}

/**
 * Did a derivation from THIS version of the page fail?
 *
 * This is how the books list can say `failed` without a column: a derivation
 * that could not be completed leaves a marker in the cover's own directory, and
 * the marker counts only while it is no older than the page, so a page that is
 * re-rendered (or a Regenerate, which clears the directory) gets a fresh
 * chance. A page that is not on disk at all has no marker -- the status reads
 * that straight off the missing file.
 */
export async function coverFailed(uploadId: string, sourcePath: string): Promise<boolean> {
  try {
    if (!isSafeId(uploadId)) return false;
    const [m, s] = await Promise.all([fs.stat(failedMarker(coverDir(uploadId))), fs.stat(sourcePath)]);
    return m.size > 0 && m.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- deriving

/** Names each in-progress write, so concurrent derivations never share a file. */
let partSeq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rename into place, riding out the moment Windows refuses it. A rename onto a
 * name that a reader (or a simultaneous derivation) has just opened can fail
 * with EPERM/EBUSY/EACCES for a few milliseconds; the cause clears on its own.
 */
async function moveInto(part: string, out: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(part, out);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 3 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * One derivation per upload AND size at a time. The books list asks for every
 * card's cover at once and a card can be asked for twice (a list reload while
 * the first request is still running), so two requests for one cover must join
 * the work under way rather than make two copies of it. It also keeps one
 * writer per file, which the rename relies on.
 */
const inflight = new Map<string, Promise<string | null>>();

/**
 * One size of an upload's cover, deriving and caching it if it is not already.
 *
 * Returns the path, or `null` when it could not be made -- a page that is gone,
 * an image sharp cannot decode, a full disk. `null` is not an error: the caller
 * answers 404 and the card shows its initials. A cover is never worth a 500,
 * and this never throws.
 *
 * Only the size asked for is made. The books list is the one place covers are
 * shown and it asks for `small` alone, so making all three up front spent about
 * five sixths of a cold derivation on files nothing requested (about 22 ms for
 * `small` against 130 ms for three, measured on a 1131x1600 page). `medium` and
 * `large` are made the first time something asks for them.
 */
export function deriveCover(uploadId: string, sourcePath: string, size: CoverSize): Promise<string | null> {
  if (!isSafeId(uploadId) || typeof sourcePath !== "string" || sourcePath === "") return Promise.resolve(null);
  if (!COVER_SIZES.includes(size)) return Promise.resolve(null);
  const key = `${uploadId}\0${size}\0${sourcePath}`;
  const running = inflight.get(key);
  if (running) return running;
  const work = derive(uploadId, sourcePath, size)
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

async function derive(uploadId: string, sourcePath: string, size: CoverSize): Promise<string | null> {
  // Before anything is created: a request that cannot succeed must leave no
  // directory behind (the thumbnail tests found `deriveGrid` doing exactly that).
  let sourceMtimeMs: number;
  try {
    sourceMtimeMs = (await fs.stat(sourcePath)).mtimeMs;
  } catch {
    return null;
  }

  const dir = path.resolve(coverDir(uploadId));
  const out = coverFile(uploadId, size);
  if (await isFresh(out, sourceMtimeMs)) return out;

  // Read into memory rather than handing sharp the path. On Windows libvips
  // keeps a path-opened file mapped after it has finished with it, and a mapped
  // page cannot be overwritten by a re-extraction or deleted with its upload.
  let original: Buffer;
  try {
    await fs.mkdir(dir, { recursive: true });
    original = await fs.readFile(sourcePath);
  } catch {
    await markFailed(dir);
    return null;
  }

  // Written beside its destination and renamed into place, so a reader never
  // finds a half-written file at `out` -- it would be served for a year.
  const part = path.join(dir, `${size}.${process.pid}-${partSeq++}.part.webp`);
  try {
    const width = COVER_WIDTH[size];
    await sharp(original)
      // `inside` + both edges: the width binds for any real page, the height
      // cap binds for a strip, and `withoutEnlargement` means a small page is
      // left at its own size rather than stretched.
      .resize({ width, height: width * COVER_MAX_ASPECT, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(part);
    if (!(await isWebp(part))) throw new Error("not a whole WebP");
    await moveInto(part, out);
    await fs.rm(failedMarker(dir), { force: true }).catch(() => {});
    return out;
  } catch {
    await fs.rm(part, { force: true }).catch(() => {});
    // Losing a race is not failing: if a simultaneous derivation has put a
    // whole, fresh file there, that is the answer.
    if (await isFresh(out, sourceMtimeMs)) return out;
    await markFailed(dir);
    return null;
  }
}

/**
 * Forget the cached covers of one upload, so the next derivation starts clean.
 *
 * Quiet about everything: nothing to delete is a success. A file that cannot be
 * deleted (Windows refuses while another process holds it open) is retried
 * briefly and then SURVIVES -- and a survivor is still whole and no older than
 * its page, so `isFresh` keeps it; it is not overwritten. A Regenerate that hits
 * that therefore changes nothing, and reports the unchanged revision. That is
 * rare (this app serves a cover from memory and holds no handle open), and the
 * alternative, forcing the overwrite, is a rename onto a file someone has open.
 */
export async function clearCover(uploadId: string): Promise<void> {
  if (!isSafeId(uploadId)) return;
  await fs.rm(coverDir(uploadId), { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }).catch(() => {});
}
