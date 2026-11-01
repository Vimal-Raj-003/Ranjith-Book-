/** Error/log contract used by the platform controls adapted from RepoReel. */
export type PublishLog = (message: string) => void;
export class PublishError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = "PublishError";
    this.retryable = opts.retryable ?? false;
  }
}
export class UnknownOutcomeError extends PublishError {
  readonly unknownOutcome = true;
  constructor(message: string) { super(message, { retryable: false }); }
}
export function isPublishError(error: unknown): error is PublishError {
  const value = error as { name?: string; retryable?: boolean } | null;
  return error instanceof PublishError || (!!value && value.name === "PublishError" && typeof value.retryable === "boolean");
}
