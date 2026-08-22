import fs from "node:fs/promises";
import { createWorker, type Worker } from "tesseract.js";
import { IngestFailed, AppError } from "../errors";
import { OCR_CACHE_DIR } from "../paths";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  box: Box;
}

/**
 * Kept behind an interface on purpose, and the interface is deliberately
 * shaped around what a caller needs (measure a page, clean up), not around
 * what `tesseract.js` happens to expose. `tesseract.js` is chosen because it
 * needs no system install, which keeps setup to one `npm install` — but it is
 * WASM and therefore slower than a native binary. If the performance harness
 * shows ingest over budget, a native `tesseract` engine implements this same
 * interface and gets wired in via `setOcrEngine` — no call site that uses
 * `measurePage` has to change.
 */
export interface OcrEngine {
  measure(imagePath: string): Promise<OcrWord[]>;
  dispose(): Promise<void>;
}

/**
 * Wraps one shared `tesseract.js` worker. Spinning a worker up per page —
 * each one launches its own WASM instance and loads language data —
 * dominates the ingest budget, so a single worker is created lazily on first
 * use and reused for the process lifetime.
 */
class TesseractEngine implements OcrEngine {
  private worker: Promise<Worker> | null = null;

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      // tesseract.js writes its downloaded language data to `cachePath` with
      // a plain `fs.writeFile` (verified against the installed v6.0.1
      // source) — it never creates the directory itself, and a failed write
      // is only logged, never thrown. Without this `mkdir`, the cache
      // directory never comes into existence, the write silently no-ops
      // every time, and the ~5MB language data is re-downloaded from the
      // jsdelivr CDN on every process start instead of once per machine.
      this.worker = fs
        .mkdir(OCR_CACHE_DIR, { recursive: true })
        .then(() => createWorker("eng", undefined, { cachePath: OCR_CACHE_DIR }));
    }
    return this.worker;
  }

  async measure(imagePath: string): Promise<OcrWord[]> {
    const w = await this.getWorker();
    // `{ blocks: true }` is the output-format flag that makes tesseract.js
    // populate `data.blocks`; verified empirically against the installed
    // v6.0.1 (the documented shape and the real one agree here) — without it
    // `data.blocks` comes back null and every word is unreachable.
    const { data } = await w.recognize(imagePath, {}, { blocks: true });

    const words: OcrWord[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const word of line.words ?? []) {
            const text = word.text?.trim();
            if (!text) continue;
            words.push({
              text,
              confidence: word.confidence ?? 0,
              box: { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 },
            });
          }
        }
      }
    }
    return words;
  }

  async dispose(): Promise<void> {
    if (!this.worker) return;
    const w = await this.worker;
    this.worker = null;
    await w.terminate();
  }
}

let engine: OcrEngine | null = null;

function getEngine(): OcrEngine {
  if (!engine) engine = new TesseractEngine();
  return engine;
}

/**
 * Lets a future call site (the pipeline, at startup) swap in a different
 * `OcrEngine` — a native `tesseract` binary, say — without any code that
 * calls `measurePage` changing. Exists for exactly the escape hatch described
 * on `OcrEngine` above.
 */
export function setOcrEngine(e: OcrEngine): void {
  engine = e;
}

/**
 * Measures where each word sits on a page photograph. This is a measuring
 * instrument, not a reader: the *text* it returns is never trusted — the
 * vision model supplies that, because OCR reads phone photographs of books
 * badly. OCR supplies the boxes, because vision models are unreliable at
 * coordinates. Nothing downstream should treat `OcrWord.text` as the
 * transcription; it exists only so the alignment step has something to match
 * against the vision model's words.
 *
 * `imagePath` is expected to be the same 1600px `derivedPath` the video
 * composition renders — not the full-resolution original — so the boxes this
 * returns already live in the composition's coordinate space and never need
 * scaling. `measurePage` itself does not care which file it is handed; this
 * is a note for the pipeline call site, not a constraint enforced here.
 */
export async function measurePage(imagePath: string): Promise<OcrWord[]> {
  try {
    return await getEngine().measure(imagePath);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new IngestFailed(`OCR failed to measure ${imagePath}: ${message}`);
  }
}

/**
 * Terminates the shared worker. A live `tesseract.js` worker holds the Node
 * event loop open, so the pipeline (Task 18) must call this on shutdown, and
 * any test that imports this module must call it in an `after` hook or
 * `npm test` will hang.
 */
export async function disposeOcr(): Promise<void> {
  if (!engine) return;
  const e = engine;
  engine = null;
  await e.dispose();
}
