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
export const WORK_ROOT = path.join(process.cwd(), ".bookreel");

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
 * anything already gitignored. Pointing it at `WORK_ROOT` keeps it beside the
 * other working files this app already excludes from version control, and
 * means the ~5MB download happens once per machine, not once per process.
 */
export const OCR_CACHE_DIR = path.join(WORK_ROOT, "ocr-cache");

export function uploadDir(uploadId: string): string {
  return path.join(UPLOAD_DIR, uploadId);
}
