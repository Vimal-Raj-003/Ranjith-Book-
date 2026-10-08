import type { Readable } from "node:stream";

/**
 * A Web `ReadableStream` over a Node `Readable`, for serving a file as a
 * `Response` body -- and, unlike `Readable.toWeb`, safe to walk away from.
 *
 * Why this exists. `Readable.toWeb(fs.createReadStream(file))` throws
 * `ERR_INVALID_STATE: Controller is already closed` OUTSIDE any request
 * promise, so nothing in the route can catch it, on completely ordinary
 * behaviour: a `<video>` asks for `bytes=0-`, stops draining while it plays,
 * then drops the connection when the user seeks or navigates. Measured on
 * Node 22.22 with Next's own `pipeToNodeResponse` and a raw socket that
 * `pause()`s and is then destroyed, the stack is
 *
 *     ReadableStreamDefaultController.enqueue
 *     ReadStream.onData            (node:internal/webstreams/adapters)
 *     ReadStream.emit
 *     Readable.read  <-  flow  <-  resume_  <-  processTicksAndRejections
 *
 * The adapter's `pull()` calls `source.resume()`, which only SCHEDULES the
 * flow on a later tick. The consumer cancels in between (`pipeTo` cancels its
 * source the moment the response's socket closes); `cancel()` destroys the
 * Node stream, but the scheduled flow still finds a buffered chunk and emits
 * `data` once more, and the adapter's `onData` enqueues it onto a controller
 * that is already closed. The adapter guards `controller.close()` after a cancel
 * (`wasCanceled`) and does not guard `enqueue()`.
 *
 * Nothing here is push-driven, so that race has no room to exist. Chunks are
 * pulled one at a time through the Node stream's own async iterator, which
 * already honours back-pressure (it reads only when asked) and never emits to a
 * stream that has been destroyed. What is left to get right is bookkeeping,
 * and it is all one flag:
 *
 *  - `settled` is true once the Web stream has been closed, errored, cancelled
 *    or aborted. Every path that would touch the controller checks it first, so
 *    `close()`, `error()` and `enqueue()` each run at most once and never after
 *    the stream is finished.
 *  - `cancel()` (the consumer walked away) destroys the Node stream, which
 *    closes the file descriptor; on Windows an open handle blocks the next
 *    re-render of the same file.
 *  - `signal` (the request's `AbortSignal`) does the same when it fires, even if
 *    the consumer is not reading -- a client that is back-pressured and gone
 *    must not keep a descriptor open for as long as the socket takes to time
 *    out. The Web stream then errors with an `AbortError`, which is the one
 *    error Next's response writer treats as "the client left" rather than as a
 *    failure to log.
 *
 * Back-pressure is preserved. Nothing is buffered beyond what the Node stream
 * holds itself (its `highWaterMark`, 64 KiB for `fs`) plus one chunk in the Web
 * queue, so a 38 MB video costs the same memory as a 38 KB one.
 *
 * Contract:
 *  - `source` must be a byte stream: no `objectMode`, no `setEncoding` (chunks
 *    must be `Buffer`/`Uint8Array`). Anything else errors the Web stream with a
 *    `TypeError` and destroys `source`.
 *  - This takes ownership of `source`. Do not read from it elsewhere.
 *  - A source error reaches the consumer, in order, after the chunks that
 *    preceded it.
 *  - Never throws synchronously, never rejects unhandled, never leaves `source`
 *    open once the returned stream is done, cancelled or aborted.
 */
export function nodeToWebStream(source: Readable, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<unknown> = source[Symbol.asyncIterator]();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;

  // The iterator reports errors to whoever is pulling. `fs.createReadStream`
  // opens its file on a later tick, so an ENOENT can land before the first
  // pull has attached anything -- and an `error` event with no listener is an
  // uncaught exception. This listener is only the backstop; the error itself is
  // delivered through `pull()`.
  source.on("error", () => {});

  /** Claim the right to finish the Web stream. False if something already did. */
  function settle(): boolean {
    if (settled) return false;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    return true;
  }

  function onAbort(): void {
    if (!settle()) return;
    source.destroy();
    // The DOM typings know only `(message, name)`; the second argument can also
    // be `{ name, cause }`, but the cause is set by hand to stay type-correct.
    const aborted = new DOMException("The request was aborted.", "AbortError");
    Object.defineProperty(aborted, "cause", { value: signal?.reason, configurable: true, writable: true });
    controller.error(aborted);
  }

  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        if (!signal) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },

      async pull(c) {
        let chunk: Uint8Array | null = null; // null: the source has ended
        try {
          const step = await iterator.next();
          if (!settled && !step.done) chunk = toBytes(step.value);
        } catch (err) {
          // Cancelling destroys the stream under a pending read, which rejects
          // it with "premature close". That is the cancel's doing, not a
          // failure, and there is no one left to tell.
          if (!settle()) return;
          source.destroy();
          throw err; // errors the Web stream, once
        }
        // Cancelled or aborted while the read was in flight: drop the chunk.
        if (settled) return;
        if (chunk) c.enqueue(chunk);
        else if (settle()) c.close();
      },

      cancel() {
        if (!settle()) return;
        source.destroy();
        // Let the iterator run its own cleanup. A read still pending settles
        // because the stream is destroyed, so this cannot hang.
        void iterator.return?.().catch(() => {});
      },
    },
    // Same strategy `Readable.toWeb` uses: one source-sized chunk of queue.
    new ByteLengthQueuingStrategy({ highWaterMark: source.readableHighWaterMark }),
  );
}

/**
 * A chunk as a standalone `Uint8Array`. A `Buffer` is copied, as
 * `Readable.toWeb` does, so a consumer never holds a view onto Node's shared
 * allocation pool.
 */
function toBytes(chunk: unknown): Uint8Array {
  if (Buffer.isBuffer(chunk)) return new Uint8Array(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError("nodeToWebStream: the source must be a byte stream (no objectMode, no encoding).");
}
