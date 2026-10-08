/**
 * Named errors, so an API handler can always answer with something the client
 * can distinguish from a dropped connection. An empty 500 is indistinguishable
 * from a network failure, and the UI hangs on exactly that.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export class BadUpload extends AppError {
  constructor(message: string) {
    super("bad_upload", message, 400);
  }
}

export class IngestFailed extends AppError {
  constructor(message: string) {
    super("ingest_failed", message, 500);
  }
}

/**
 * Raised by `measurePage` when OCR does not settle within its hard timeout.
 * A distinct name (rather than a generic `IngestFailed`) so a stall is
 * unmistakable in logs and in the note `runIngest` records — OCR failure is
 * designed to be non-fatal (the page falls back to block highlighting), and
 * a hang must never be allowed to look like anything worse than that.
 */
export class OcrTimeoutError extends AppError {
  constructor(message: string) {
    super("ocr_timeout", message, 500);
  }
}

/** Raised when the grounding check refuses the script, so the pipeline stops
 *  before the voiceover. Carries the report so the operator can read why. */
export class ContentRejectedError extends AppError {
  readonly report: unknown;
  constructor(message: string, report: unknown) {
    super("content_rejected", message, 422);
    this.report = report;
  }
}

/**
 * Is this one of ours? Asked by shape, never by `instanceof`.
 *
 * `instanceof` compares against ONE class object, so it answers false for an
 * error that is in every other respect the same class — whenever the module
 * defining it has been evaluated twice. That is not theoretical here: the test
 * suite is `.mts` (ESM) while `src` is `.ts` under a package with no
 * `"type": "module"`, so tsx instantiates this file once per graph and every
 * `err instanceof AppError` across that boundary was quietly false. The same
 * hazard exists in any bundler that splits a build into several graphs.
 *
 * `code` and `status` are set by the constructor and by nothing else, so they
 * identify these errors without depending on which copy of the class built
 * them — the same reasoning the embedder registry uses when it compares by id
 * rather than by identity.
 */
export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    typeof (err as AppError).code === "string" &&
    typeof (err as AppError).status === "number"
  );
}

/**
 * A specific one, by the code its constructor stamps. Declared as a type
 * predicate so a caller that has just asserted this still gets `message`,
 * `code` and `status` narrowed, exactly as `instanceof` used to give them.
 */
export function isErrorCode(err: unknown, code: string): err is AppError {
  return isAppError(err) && err.code === code;
}

/** Turn any thrown value into a JSON body. Never returns an empty object. */
export function errorBody(err: unknown): { error: string; code: string } {
  if (isAppError(err)) return { error: err.message || "Something failed without saying what.", code: err.code };
  const message = err instanceof Error ? err.message : String(err);
  return { error: message || "Something failed without saying what.", code: "unknown" };
}

export function errorStatus(err: unknown): number {
  return isAppError(err) ? err.status : 500;
}
