/**
 * Which browser publishes THIS process is running, who holds each platform's
 * window, and which windows were left open for a person.
 *
 * No imports beyond a type, so the reaper can ask "is this job alive?" without
 * pulling Playwright or the publish stack in behind it -- the same reason
 * `episodes/live.ts` is import-free.
 *
 * On `globalThis` for the reason `db.ts` keeps Prisma there and `cancel.ts` keeps
 * its controllers there: route handlers (and a dev server's hot reloads) can each
 * get their own copy of a module, and every one of them must see ONE set of live
 * jobs and ONE lock per platform. A second copy of the lock would let two
 * windows open on the same Chromium profile.
 *
 * LIVENESS IS WHAT MAKES A RESTART DETECTABLE. A job row says `PREPARING` whether
 * its process is still working or died ten minutes ago; only a running process
 * can tell the difference, and a restart empties this set. So "in flight in the
 * database, absent here" is exactly "a restart (or a crash) interrupted it" --
 * see `recover.ts`, which turns that into AWAITING_HUMAN rather than a re-run.
 */
import type { PlatformId } from "../limits";

interface WindowHandle {
  close(): Promise<void>;
}

interface BrowserPublishState {
  /** `${platform}:${episodeId}` of every job this process is working on right now. */
  live: Set<string>;
  /** Per-platform tail of the queue: a job runs when the one ahead of it has released. */
  locks: Map<PlatformId, Promise<void>>;
  /** A window left open for a person on a platform, closed before that platform's next job. */
  windows: Map<PlatformId, WindowHandle>;
}

const g = globalThis as unknown as { bookreelBrowserPublish?: BrowserPublishState };
const state: BrowserPublishState = (g.bookreelBrowserPublish ??= {
  live: new Set(),
  locks: new Map(),
  windows: new Map(),
});

export const liveKey = (platform: PlatformId, episodeId: string): string => `${platform}:${episodeId}`;

/**
 * Register a job as running in this process, or report that one already is.
 *
 * Done BEFORE the job's row is written, so a reaper never sees a row with no
 * owner. The check and the set happen in one synchronous step, so of two callers
 * racing for the same job exactly one gets `true` -- and only that one may go on
 * to claim the row and, later, call `unmarkLive`. A loser that unmarked would
 * erase the winner's entry and make a live job look dead.
 */
export function markLive(platform: PlatformId, episodeId: string): boolean {
  const key = liveKey(platform, episodeId);
  if (state.live.has(key)) return false;
  state.live.add(key);
  return true;
}

/** The job has settled. Done AFTER its final row write, for the same reason in reverse. */
export function unmarkLive(platform: PlatformId, episodeId: string): void {
  state.live.delete(liveKey(platform, episodeId));
}

/** Is this job running (or queued behind another) in THIS process? */
export function isBrowserJobLive(platform: PlatformId, episodeId: string): boolean {
  return state.live.has(liveKey(platform, episodeId));
}

/**
 * Take the platform's single window.
 *
 * ONE BROWSER JOB PER PLATFORM AT A TIME. Two jobs on one platform would need two
 * Chromium instances on one profile directory, which Chromium refuses (it locks
 * the profile), and would put two windows in front of the person who has to sign
 * in. So the second waits for the first, in order, and different platforms never
 * wait for each other.
 *
 * Resolves to a release function; calling it twice is harmless. The caller MUST
 * release in a `finally`.
 */
export async function acquirePlatformLock(platform: PlatformId): Promise<() => void> {
  const ahead = state.locks.get(platform) ?? Promise.resolve();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const tail = ahead.then(() => gate);
  state.locks.set(platform, tail);
  await ahead;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
    // Only the last one in line clears the entry, or a later waiter's tail would be dropped.
    if (state.locks.get(platform) === tail) state.locks.delete(platform);
  };
}

/** Is a job holding (or queued for) this platform's window right now? */
export function isPlatformBusy(platform: PlatformId): boolean {
  return state.locks.has(platform);
}

/**
 * Remember a window that was deliberately left open for a person (a sign-in or a
 * challenge on screen). It stays up until the next job on this platform needs the
 * profile, at which point `closeLeftOpenWindow` closes it.
 */
export function leaveWindowOpen(platform: PlatformId, handle: WindowHandle): void {
  state.windows.set(platform, handle);
}

/** The window is gone (the person closed it, or it was closed here). */
export function forgetWindow(platform: PlatformId, handle?: WindowHandle): void {
  if (!handle || state.windows.get(platform) === handle) state.windows.delete(platform);
}

/** Is a window left open for this platform? */
export function hasLeftOpenWindow(platform: PlatformId): boolean {
  return state.windows.has(platform);
}

/**
 * Close the window a previous job left open, so the profile is free for this one.
 * Never throws: a window the person already closed is simply gone.
 */
export async function closeLeftOpenWindow(platform: PlatformId): Promise<void> {
  const handle = state.windows.get(platform);
  if (!handle) return;
  state.windows.delete(platform);
  await handle.close().catch(() => {});
}
