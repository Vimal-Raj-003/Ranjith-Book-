import fs from "node:fs/promises";
import { createWorker, type Worker } from "tesseract.js";
import { IngestFailed, OcrTimeoutError, AppError } from "../errors";
import { OCR_CACHE_DIR } from "../paths";

/**
 * Hard ceiling on one page's OCR pass. `tesseract.js` spawning a worker that
 * never resolves and never rejects is a real, reproduced failure mode (a
 * bundler breaking the worker's path resolution turns `createWorker()` into
 * a silent hang, with zero CPU, forever) — and OCR failure is designed to be
 * NON-FATAL in this pipeline (a page with no boxes falls back to paragraph-
 * block highlighting). Without this timeout, a hang anywhere in the OCR path
 * converts that designed-for, recoverable failure into a dead run that never
 * reaches `DONE` — strictly worse than the failure it would otherwise be
 * hiding. 60s is generous for a single page against a warm, cached worker;
 * it exists to bound a stall, not to tune normal-case latency.
 */
const OCR_TIMEOUT_MS = 60_000;

/**
 * Races `promise` against a timer. On timeout, rejects with a named
 * `OcrTimeoutError` — the caller must be able to tell "OCR took too long"
 * apart from any other failure. Does NOT cancel or otherwise touch the
 * underlying `promise`: `TesseractEngine.measure` has already registered it
 * in `inFlight` by the time this wraps it, and `dispose()` still needs to
 * wait for that real completion (successful or not) before it can safely
 * terminate the worker — see the doc comment on `inFlight` for why
 * terminating underneath an in-flight call crashes the whole process. This
 * timeout only stops the *caller* from waiting on it any longer.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, imagePath: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new OcrTimeoutError(
          `OCR timed out after ${ms}ms measuring ${imagePath} — this page highlights by block instead of by word.`,
        ),
      );
    }, ms);
    // Never let this bookkeeping timer hold the process open on its own —
    // a live tesseract.js worker already does that deliberately (see
    // `disposeOcr`'s doc comment); this timer is not meant to add to it.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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

  /**
   * Every `measure()` call's outer promise, tracked so `dispose()` can wait
   * for all of them to settle before touching the worker. This exists
   * because of a real crash, reproduced against the installed tesseract.js
   * v6.0.1: `worker.terminate()` nulls tesseract.js's *internal* worker
   * reference, but a `recognize()` already in flight later calls an
   * un-awaited internal `send()` against that same worker — which throws
   * `TypeError: Cannot read properties of null (reading 'postMessage')` as
   * an unhandled rejection, entirely outside the promise `measure()` is
   * awaiting. Node's default behaviour on an unhandled rejection is to kill
   * the process, so a `dispose()` that races an in-flight `measure()` does
   * not fail that one call — it takes down the whole process. Waiting here
   * means `terminate()` is only ever called once nothing is still using the
   * worker.
   */
  private inFlight = new Set<Promise<unknown>>();

  /**
   * Set once `dispose()` has been called on *this* instance. Reachable only
   * if something holds a direct reference to a disposed engine and calls
   * `measure()` on it again — the module-level singleton below never does
   * this, since it drops its reference to an instance before disposing it,
   * so a fresh `measurePage()` call always gets a brand-new instance and
   * worker instead. Kept as a named-error guard rather than silently
   * resurrecting a terminated worker.
   */
  private disposed = false;

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
    if (this.disposed) {
      throw new IngestFailed(
        `OCR engine was already disposed; cannot measure ${imagePath}. Call measurePage() again to get a fresh engine.`,
      );
    }
    // Registered in `inFlight` before the first `await` inside `_recognize`
    // runs, so there is no window where `dispose()` could observe an
    // in-flight call as absent.
    const job = this._recognize(imagePath);
    this.inFlight.add(job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(job);
    }
  }

  private async _recognize(imagePath: string): Promise<OcrWord[]> {
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
    this.disposed = true;
    if (!this.worker) return;
    // Let every measure() call already running finish (successfully or not)
    // before the worker is touched — see the comment on `inFlight` above for
    // why terminating underneath one of them crashes the process instead of
    // just failing that call.
    await Promise.allSettled([...this.inFlight]);
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
 *
 * If a page was already measured before this is called, the outgoing engine
 * is holding a live worker; dropping the reference without disposing it
 * would leak that worker (and, for `TesseractEngine`, its process). The
 * outgoing engine's own `dispose()` is what makes that safe to do while a
 * measurement might still be in flight on it — see `TesseractEngine.dispose`.
 * Disposal happens in the background rather than being awaited here so this
 * stays a synchronous swap; a failure tearing down the *old* engine is not
 * a reason to fail the swap to the new one.
 */
export function setOcrEngine(e: OcrEngine): void {
  const outgoing = engine;
  engine = e;
  if (outgoing && outgoing !== e) {
    void outgoing.dispose().catch(() => {
      // Best-effort cleanup of the engine being retired; the caller asked to
      // replace it, not to be told how that replacement's teardown went.
    });
  }
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
 *
 * Bounded by a hard timeout (`timeoutMs`, defaulting to `OCR_TIMEOUT_MS`):
 * on expiry this rejects with a named `OcrTimeoutError` rather than leaving
 * the caller waiting forever. The parameter exists so a test can exercise
 * that path in milliseconds instead of `OCR_TIMEOUT_MS`; no real call site
 * should need to override the default.
 */
export async function measurePage(
  imagePath: string,
  timeoutMs: number = OCR_TIMEOUT_MS,
): Promise<OcrWord[]> {
  try {
    return await withTimeout(getEngine().measure(imagePath), timeoutMs, imagePath);
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
