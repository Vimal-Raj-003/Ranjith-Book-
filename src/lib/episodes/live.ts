/**
 * Which episodes this process is running or has queued. No imports, so the
 * reaper can ask without pulling the whole pipeline in behind it.
 *
 * On `globalThis` for the reason `db.ts` keeps Prisma there: route handlers
 * may each get their own copy of a module, and all of them must see one queue.
 */
export interface QueueState {
  waiting: string[];
  current: string | null;
  draining: boolean;
}

const g = globalThis as unknown as { bookreelEpisodeQueue?: QueueState };
export const queueState: QueueState = (g.bookreelEpisodeQueue ??= { waiting: [], current: null, draining: false });

/** Queued or running in THIS process — what the reaper must leave alone. */
export function isEpisodeLive(id: string): boolean {
  return queueState.current === id || queueState.waiting.includes(id);
}
