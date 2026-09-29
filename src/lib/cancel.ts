/**
 * Cancelling a running episode.
 *
 * One `AbortController` per episode this process is actively running, keyed
 * by episode id — the same `globalThis` pattern `episodes/live.ts` uses for
 * the queue, and for the same reason: route handlers can each get their own
 * copy of this module, and all of them must see the same map.
 *
 * `runEpisode` creates the controller once, at the top of the run, and makes
 * its signal ambient for the rest of that run (`AsyncLocalStorage`, the same
 * trick `content/cli-metrics.ts`'s `callContext` already uses to reach deep
 * into a spawned child process without a `signal` parameter threaded through
 * every function in between: the writer, the CLI spawner, ffmpeg, faster-
 * whisper, the renderer). Diagnostics on this project showed the Claude CLI
 * can hang completely silent for the full 360s timeout — cancellation has to
 * reach and kill that actual child process, not just flip a database column,
 * or "cancel" would leave the real work running in the background regardless
 * of what the UI says.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export class CancelledError extends Error {
  constructor(message = "Cancelled by the operator.") {
    super(message);
    this.name = "CancelledError";
  }
}

// Both on globalThis, for the exact reason `db.ts` keeps Prisma there and
// `episodes/live.ts` keeps the queue there: route handlers (and, in dev, a
// test runner importing this file through more than one relative path) can
// each get their own copy of this module. A second `Map` would just miss
// cancellations signalled through the first; a second `AsyncLocalStorage`
// is worse — `beginCancellable` would enter one instance while a spawn call
// elsewhere reads a different, forever-empty one, so the signal it gets is
// always `undefined` and cancellation silently never reaches the process it
// is supposed to kill. Sharing both here is what makes every importer of
// this module see the same run, however it resolved the import.
const g = globalThis as unknown as {
  bookreelCancelControllers?: Map<string, AbortController>;
  bookreelCancelSignalStore?: AsyncLocalStorage<AbortSignal>;
};
const controllers: Map<string, AbortController> = (g.bookreelCancelControllers ??= new Map());
const signalStore: AsyncLocalStorage<AbortSignal> = (g.bookreelCancelSignalStore ??= new AsyncLocalStorage());

/** Called once, at the top of `runEpisode`, before any step runs. */
export function beginCancellable(episodeId: string): AbortController {
  const controller = new AbortController();
  controllers.set(episodeId, controller);
  signalStore.enterWith(controller.signal);
  return controller;
}

/** Called once `runEpisode` has reached a terminal state, on every path. */
export function endCancellable(episodeId: string): void {
  controllers.delete(episodeId);
}

/** The ambient signal for whichever episode run is currently executing, if any. */
export function currentSignal(): AbortSignal | undefined {
  return signalStore.getStore();
}

/** Throws if the run currently executing has been cancelled. Call between steps. */
export function throwIfCancelled(): void {
  if (signalStore.getStore()?.aborted) throw new CancelledError();
}

/**
 * `{ signal, killSignal }` for a `spawn`/`execFile` call, ready to spread into
 * its options — Node kills the child with `killSignal` the moment the signal
 * aborts and surfaces an `AbortError`, no manual listener needed. Empty when
 * there is no run in progress (e.g. a vision call during PDF ingest), so
 * spreading it is always safe.
 */
export function abortOpts(): { signal?: AbortSignal; killSignal?: NodeJS.Signals } {
  const signal = currentSignal();
  return signal ? { signal, killSignal: "SIGKILL" } : {};
}

/**
 * True if `err` is the direct result of the current run's own cancellation —
 * whether Node's own `AbortError`, or anything else, since once the signal is
 * aborted that is the only reason still in flight work can be failing.
 * Preferred over matching `err.name`/`err.code`, which differ across
 * `spawn`, `execFile` and `fetch` and across platforms.
 */
export function wasCancelled(): boolean {
  return currentSignal()?.aborted === true;
}

/**
 * True if a run for this episode is live IN THIS PROCESS and was just told to
 * stop. False means either it already finished, or it never was running in
 * this process (a server restart leaves nothing here to signal — `reap.ts`'s
 * stale-run check is what eventually closes that case out).
 */
export function requestCancel(episodeId: string): boolean {
  const controller = controllers.get(episodeId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort(new CancelledError());
  return true;
}
