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

/** Raised when the grounding check refuses the script, so the pipeline stops
 *  before the voiceover. Carries the report so the operator can read why. */
export class ContentRejectedError extends AppError {
  readonly report: unknown;
  constructor(message: string, report: unknown) {
    super("content_rejected", message, 422);
    this.report = report;
  }
}

/** Turn any thrown value into a JSON body. Never returns an empty object. */
export function errorBody(err: unknown): { error: string; code: string } {
  if (err instanceof AppError) return { error: err.message || "Something failed without saying what.", code: err.code };
  const message = err instanceof Error ? err.message : String(err);
  return { error: message || "Something failed without saying what.", code: "unknown" };
}

export function errorStatus(err: unknown): number {
  return err instanceof AppError ? err.status : 500;
}
