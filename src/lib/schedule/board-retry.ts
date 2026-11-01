/** Shared by the worker and schedule UI; importing it never opens a database. */
export const STALE_MS = 30 * 60_000;
const ERROR_PREVIEW_CHARS = 140;
export const IN_PROGRESS_STATUSES = ["PUBLISHING", "UPLOADING", "SCHEDULING"];

interface RetryState {
  status: string;
  nativeSchedule: boolean;
  publishAt: string | Date | null;
  platformPublishAt?: string | Date | null;
  lastAttemptAt?: string | Date | null;
  startedAt?: string | Date | null;
  updatedAt?: string | Date | null;
  preUpload?: boolean;
}

export function scheduleRetryCandidate(job: RetryState, now = new Date()): boolean {
  if (job.preUpload === false) return false;
  if (!job.nativeSchedule || job.platformPublishAt || !job.publishAt || new Date(job.publishAt).getTime() <= now.getTime()) return false;
  if (!Number.isFinite(new Date(job.publishAt).getTime())) return false;
  if (job.status === "FAILED") return true;
  if ((job.status === "CANCELLED" || job.status === "AWAITING_HUMAN") && job.preUpload === true) return true;
  if (!IN_PROGRESS_STATUSES.includes(job.status)) return false;
  const last = job.lastAttemptAt ?? job.startedAt;
  return !!last && new Date(last).getTime() < now.getTime() - STALE_MS &&
    (!job.updatedAt || new Date(job.updatedAt).getTime() < now.getTime() - STALE_MS);
}


export function errorPreview(error: string | null | undefined, max: number = ERROR_PREVIEW_CHARS): string {
  const lines = (error ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const flat = (lines[0] ?? "").replace(/\s+/g, " ").trim();
  if (flat.length > max) return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
  // A one-line error is shown as it is; an ellipsis on a short first line says there is more below it.
  return lines.length > 1 ? `${flat}\u2026` : flat;
}
