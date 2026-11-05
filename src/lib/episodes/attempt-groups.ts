/** Presentation identity only. Never infer identity from a title or status. */
export interface AttemptIdentity {
  id: string;
  bookId?: string;
  contentIdeaId?: string | null;
  ideaKey?: string | null;
  kind?: string;
  status?: string;
  createdAt?: string | Date;
  startedAt?: string | Date | null;
  updatedAt?: string | Date;
}

export function videoIdentity(attempt: AttemptIdentity): string {
  if (attempt.bookId && attempt.contentIdeaId) return JSON.stringify([attempt.bookId, "idea", attempt.contentIdeaId]);
  if (attempt.bookId && attempt.kind === "idea" && attempt.ideaKey) return JSON.stringify([attempt.bookId, "key", attempt.ideaKey]);
  return JSON.stringify(["episode", attempt.id]);
}

function time(value: string | Date | null | undefined): number {
  const n = value ? new Date(value).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

export function compareAttempts(a: AttemptIdentity, b: AttemptIdentity): number {
  const at = (e: AttemptIdentity) => Math.max(time(e.createdAt), time(e.startedAt), e.status === "QUEUED" ? time(e.updatedAt) : 0);
  return at(b) - at(a) || time(b.createdAt) - time(a.createdAt) || b.id.localeCompare(a.id);
}

export function groupVideoAttempts<T extends AttemptIdentity>(attempts: readonly T[]) {
  const groups = new Map<string, Map<string, T>>();
  for (const attempt of attempts) {
    const key = videoIdentity(attempt);
    const group = groups.get(key) ?? new Map<string, T>();
    const existing = group.get(attempt.id);
    // A slower list refresh must not overwrite the newer live card snapshot.
    if (!existing || time(attempt.updatedAt) >= time(existing.updatedAt)) group.set(attempt.id, attempt);
    groups.set(key, group);
  }
  return [...groups].map(([key, rows]) => {
    const attempts = [...rows.values()].sort(compareAttempts);
    return { key, latest: attempts[0], attempts, previous: attempts.slice(1) };
  });
}

/** A book's idea relation is already an authoritative group, including legacy rows. */
export function latestIdeaAttempt<T extends AttemptIdentity>(attempts: readonly T[]): T | null {
  return [...attempts].sort(compareAttempts)[0] ?? null;
}

export interface AttemptHistoryItem {
  key: string;
  episodeId: string;
  status: string;
  step: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  hasVideo: boolean;
  archived: boolean;
  steps: { step: string; status: string; durationMs: number | null }[];
}
