import path from "node:path";

/**
 * Where the app keeps its working files.
 *
 * These live in their own module with no imports of their own, because the
 * modules that need them form a cycle otherwise: the pipeline posts a finished
 * run, the publish engine reads the render it produced, and the browser engine
 * keeps its profiles next to the work directory. With the constants defined in
 * `pipeline.ts`, that cycle left `WORK_ROOT` uninitialised at module-evaluation
 * time and every publish route answered 500.
 */
const DEFAULT_ROOT = path.join(process.cwd(), ".bookreel");

/**
 * Downloaded caches: the OCR language data, the embedding and speech models,
 * the alignment environment, the Gutenberg catalogue. Machine-level, shared by
 * every process, and NEVER redirected — they cost hundreds of megabytes and
 * minutes to fetch, so a test process that pointed them somewhere fresh would
 * re-download all of it (and find no alignment environment, silently
 * downgrading its own timing check to the estimated fallback).
 */
export const CACHE_ROOT = DEFAULT_ROOT;

/**
 * Where this process keeps the files it PRODUCES: uploads, renders, audio,
 * projects, thumbnails, logs.
 *
 * `BOOKREEL_WORK_ROOT` redirects it. The test suite sets that per process
 * (`tests/setup/isolated-db.mjs`), for the same reason each test file gets its
 * own database: several test files create and clean up uploads at once, and a
 * test that asserts "this failed upload left nothing behind" was reading a
 * directory another file had just legitimately created. Shared scratch space
 * is shared state, and it fails the same way a shared database does.
 */
export const WORK_ROOT = process.env.BOOKREEL_WORK_ROOT?.trim() || DEFAULT_ROOT;

/**
 * Deliberately outside `public/`. Anything under `public/` is served by filename
 * with no handler in front of it, so a finished video would be readable by any
 * signed-in user who knew a run id. Delivery goes through
 * `/api/creations/[id]/video`, which checks ownership first.
 */
export const RENDER_DIR = path.join(WORK_ROOT, "renders");

/** Photographs live beside the renders, outside `public/`, for the same reason. */
export const UPLOAD_DIR = path.join(WORK_ROOT, "uploads");

/**
 * Where `tesseract.js` caches its downloaded language data. Left at its
 * default, that download lands as `./eng.traineddata` in whatever the process
 * cwd happens to be — the repo root, in dev — which is both messy and outside
 * anything already gitignored. Pointing it at `CACHE_ROOT` keeps it beside the
 * other working files this app already excludes from version control, and
 * means the ~5MB download happens once per machine, not once per process.
 */
export const OCR_CACHE_DIR = path.join(CACHE_ROOT, "ocr-cache");

export function uploadDir(uploadId: string): string {
  return path.join(UPLOAD_DIR, uploadId);
}
