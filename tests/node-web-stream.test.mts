import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { getEventListeners, once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { pipeToNodeResponse } from "next/dist/server/pipe-readable";
import { prisma } from "../src/lib/db";
import { nodeToWebStream } from "../src/lib/node-web-stream";
import { serveThumbnail } from "../src/lib/thumbnails/serve";
import { serializeThumbnails, thumbsDir, type ThumbSpec } from "../src/lib/thumbnails";
import { requireIsolation } from "./setup/isolation";

/**
 * `nodeToWebStream` replaces `Readable.toWeb` in the video and poster routes.
 *
 * The bug it holds shut: `Readable.toWeb(fs.createReadStream(...))` throws
 * `ERR_INVALID_STATE: Controller is already closed` from `ReadableStreamDefault
 * Controller.enqueue` -- on a later tick, outside any promise a route owns -- when
 * the response's consumer abandons it mid-body. A `<video>` does exactly that:
 * it asks for `bytes=0-`, buffers ahead, stops draining, then drops the
 * connection on a seek or a navigation.
 *
 * What these tests do and do not drive:
 *
 *  - The helper is tested directly, including the abandon-mid-pipe sequence that
 *    reproduces the bug at stream level (`pipeTo` into a slow sink, then abort --
 *    the very sequence Next's response writer performs when the socket closes).
 *    Run against `Readable.toWeb`, that sequence threw in 12 of 12 attempts.
 *  - The last tests put it behind Next's own `pipeToNodeResponse` and a raw `net`
 *    socket that stops reading and is then destroyed -- the reproduction from the
 *    bug report -- through `serveThumbnail`, the real poster route's body.
 *  - NOT driven: a live `next dev` server. The video route's `currentUser()`
 *    reads `cookies()` and cannot run outside a request, and a test must not
 *    start a server on the operator's ports or sign in as one of its users.
 *
 * Nothing here may escape as an uncaught exception, so every test that streams
 * records `uncaughtException` and `unhandledRejection` and asserts the list is
 * empty. (`node --test` would also fail the file on one; this makes the
 * assertion say what went wrong instead of reporting a bare crash.)
 */

function watchProcessErrors() {
  const seen: unknown[] = [];
  const record = (e: unknown) => void seen.push(e);
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  return {
    seen,
    stop() {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    },
  };
}

/** Run `body`, then give any late-scheduled throw a chance to land, then assert none did. */
async function expectNoEscapes(body: () => Promise<void>) {
  const watch = watchProcessErrors();
  try {
    await body();
    await sleep(300);
  } finally {
    watch.stop();
  }
  assert.deepEqual(
    watch.seen.map((e) => (e instanceof Error ? `${(e as NodeJS.ErrnoException).code ?? e.name}: ${e.message}` : String(e))),
    [],
    "nothing escapes as an uncaught exception or an unhandled rejection",
  );
}

const closed = (s: Readable) => (s.closed ? Promise.resolve() : once(s, "close"));

/** An endless byte source that records how often it was asked for more. */
function endless(chunkBytes = 65536) {
  const state = { reads: 0 };
  const source = new Readable({
    highWaterMark: 65536,
    read() {
      state.reads++;
      this.push(Buffer.alloc(chunkBytes, 1));
    },
  });
  return { source, state };
}

let dir: string;
let bigFile: string;
const BIG = 32 * 1024 * 1024;

test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "node-web-stream-"));
  bigFile = path.join(dir, "big.bin");
  await fsp.writeFile(bigFile, Buffer.alloc(BIG, 7));
});
test.after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test("every byte of a file arrives, in order, as Uint8Arrays", async () => {
  const file = path.join(dir, "random.bin");
  const bytes = randomBytes(300_000 + 17);
  await fsp.writeFile(file, bytes);

  const source = fs.createReadStream(file);
  const reader = nodeToWebStream(source).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    assert.ok(value instanceof Uint8Array);
    chunks.push(value);
  }
  assert.ok(chunks.length > 1, "a 300 KB file is more than one chunk");
  assert.ok(Buffer.concat(chunks).equals(bytes));
  await closed(source);
  assert.equal(source.destroyed, true, "the descriptor is released once the body has been read");
});

test("a byte range is served as exactly that range, as the video route asks for it", async () => {
  const source = fs.createReadStream(bigFile, { start: 1000, end: 1999 });
  const reader = nodeToWebStream(source).getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  assert.equal(total, 1000);
});

test("an empty file is an empty body, not an error", async () => {
  const file = path.join(dir, "empty.bin");
  await fsp.writeFile(file, "");
  const reader = nodeToWebStream(fs.createReadStream(file)).getReader();
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
});

test("back-pressure: a consumer that is not reading is not read ahead of", async () => {
  const { source, state } = endless();
  const web = nodeToWebStream(source);
  await sleep(100);
  const idle = state.reads;
  assert.ok(idle <= 4, `an unread stream pulled ${idle} chunks from its source; it must stay within a couple of chunks`);

  const reader = web.getReader();
  for (let i = 0; i < 3; i++) await reader.read();
  await sleep(100);
  assert.ok(state.reads <= idle + 3 + 4, `after 3 reads the source had been read ${state.reads} times`);

  await reader.cancel();
});

test("cancel() destroys the Node stream and asks it for nothing more", async () => {
  await expectNoEscapes(async () => {
    const { source, state } = endless();
    const reader = nodeToWebStream(source).getReader();
    await reader.read();
    await reader.cancel();
    await closed(source);
    assert.equal(source.destroyed, true);
    const after = state.reads;
    await sleep(100);
    assert.equal(state.reads, after, "no read is issued once the consumer has left");
  });
});

test("cancel() while a read is pending leaves nothing hanging or thrown", async () => {
  await expectNoEscapes(async () => {
    // A source that never produces: the pull inside the helper is parked on it.
    const source = new Readable({ read() {} });
    const reader = nodeToWebStream(source).getReader();
    const pending = reader.read();
    await sleep(20);
    await reader.cancel();
    assert.deepEqual(await pending, { value: undefined, done: true });
    await closed(source);
    assert.equal(source.destroyed, true);
  });
});

test("the response writer abandoning the body mid-pipe is silent (the reproduction at stream level)", async () => {
  // `pipeTo` into a sink that is slower than the file, aborted from outside: what
  // Next's writer does when the socket closes. 12 of 12 runs threw through
  // `Readable.toWeb`; none may through the helper.
  for (let run = 0; run < 6; run++) {
    await expectNoEscapes(async () => {
      const source = fs.createReadStream(bigFile);
      const abort = new AbortController();
      const sink = new WritableStream({ write: () => sleep(5) });
      const piped = nodeToWebStream(source).pipeTo(sink, { signal: abort.signal }).catch(() => {});
      await sleep(60);
      abort.abort();
      await piped;
      await closed(source);
      assert.equal(source.destroyed, true, "and the file is closed");
    });
  }
});

test("the request's AbortSignal destroys the source even if nobody is reading", async () => {
  await expectNoEscapes(async () => {
    const { source } = endless();
    const abort = new AbortController();
    const web = nodeToWebStream(source, abort.signal);
    await sleep(20);
    assert.equal(source.destroyed, false);

    abort.abort();
    await closed(source);
    assert.equal(source.destroyed, true, "a back-pressured client that is gone does not hold a descriptor open");

    await assert.rejects(web.getReader().read(), (e: Error) => e.name === "AbortError");
  });
});

test("an abort with a read in flight errors the reader with an AbortError and nothing else", async () => {
  await expectNoEscapes(async () => {
    const source = new Readable({ read() {} });
    const abort = new AbortController();
    const reader = nodeToWebStream(source, abort.signal).getReader();
    const pending = reader.read();
    await sleep(20);
    abort.abort(new Error("socket closed"));
    await assert.rejects(pending, (e: Error) => e.name === "AbortError" && (e.cause as Error).message === "socket closed");
    await closed(source);
  });
});

test("a signal that is already aborted yields a destroyed source and an errored stream", async () => {
  await expectNoEscapes(async () => {
    const { source } = endless();
    const web = nodeToWebStream(source, AbortSignal.abort());
    await assert.rejects(web.getReader().read(), (e: Error) => e.name === "AbortError");
    await closed(source);
    assert.equal(source.destroyed, true);
  });
});

test("the abort listener is removed once the stream is done, whichever way it ends", async () => {
  const live = new AbortController();
  const source = new Readable({ read() {} });
  const reader = nodeToWebStream(source, live.signal).getReader();
  assert.equal(getEventListeners(live.signal, "abort").length, 1, "attached while the stream is live");
  await reader.cancel();
  assert.equal(getEventListeners(live.signal, "abort").length, 0, "removed on cancel");

  const file = path.join(dir, "tiny.bin");
  await fsp.writeFile(file, "x");
  const finished = new AbortController();
  const r2 = nodeToWebStream(fs.createReadStream(file), finished.signal).getReader();
  while (!(await r2.read()).done);
  assert.equal(getEventListeners(finished.signal, "abort").length, 0, "removed on completion");
});

test("a source error reaches the reader after the chunks already delivered, and is thrown nowhere else", async () => {
  await expectNoEscapes(async () => {
    let n = 0;
    const source = new Readable({
      highWaterMark: 4,
      read() {
        n++;
        if (n <= 2) this.push(Buffer.from("abcd"));
        else this.destroy(new Error("disk went away"));
      },
    });
    const reader = nodeToWebStream(source).getReader();
    assert.equal((await reader.read()).value?.byteLength, 4);
    assert.equal((await reader.read()).value?.byteLength, 4);
    await assert.rejects(reader.read(), /disk went away/);
    assert.equal(source.destroyed, true);
  });
});

test("a file that vanished before it was opened is a rejected read, not an uncaught ENOENT", async () => {
  await expectNoEscapes(async () => {
    const source = fs.createReadStream(path.join(dir, "no-such-file.bin"));
    const reader = nodeToWebStream(source).getReader();
    await assert.rejects(reader.read(), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
  });
});

test("an object-mode source is refused with a TypeError and destroyed", async () => {
  await expectNoEscapes(async () => {
    const source = Readable.from([{ not: "bytes" }]);
    const reader = nodeToWebStream(source).getReader();
    await assert.rejects(reader.read(), TypeError);
    await closed(source);
    assert.equal(source.destroyed, true);
  });
});

test("no route serves a file through Readable.toWeb", async () => {
  // The helper's own doc comment names it; code must not call it.
  const offenders: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await fsp.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith("node-web-stream.ts")) {
        if (/\bReadable\.toWeb\s*\(/.test(await fsp.readFile(full, "utf8"))) offenders.push(path.relative(process.cwd(), full));
      }
    }
  };
  await walk(path.join(process.cwd(), "src"));
  assert.deepEqual(offenders, [], "use nodeToWebStream: Readable.toWeb throws an uncatchable ERR_INVALID_STATE when its consumer leaves");
});

// --- the reproduction from the bug report, through the real poster body ---

const KEY = "9x16-quote";

async function seedPoster() {
  requireIsolation("these tests create an episode and write a poster");
  const user = await prisma.user.create({ data: { email: `stream-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({ data: { title: `Stream ${randomUUID()}`, rightsStatus: "in-copyright" } });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });
  const episode = await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, userId: user.id, title: "Stream", status: "DONE" },
  });
  // A poster far larger than the socket buffers on either side, so a client
  // that stops reading really does back-pressure the server.
  const posterDir = thumbsDir(episode.id);
  await fsp.mkdir(posterDir, { recursive: true });
  const file = path.join(posterDir, `${KEY}.jpg`);
  await fsp.copyFile(bigFile, file);
  const spec: ThumbSpec = { key: KEY, aspect: "9:16", variant: "quote", path: file, width: 540, height: 960, rev: 1 };
  await prisma.episode.update({ where: { id: episode.id }, data: { thumbnails: serializeThumbnails([spec]) } });
  return {
    userId: user.id,
    episodeId: episode.id,
    cleanup: async () => {
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: user.id } });
      await fsp.rm(posterDir, { recursive: true, force: true });
    },
  };
}

/**
 * The route's body with Next's own response writer in front of it: the same
 * `pipeToNodeResponse` the framework uses, and the same "abort when the response
 * closes unfinished" signal it hands every route handler as `req.signal`.
 */
function serve(userId: string, episodeId: string, opts: { passSignal: boolean }) {
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const response = await serveThumbnail(userId, episodeId, KEY, null, null, opts.passSignal ? abort.signal : undefined);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    await pipeToNodeResponse(response.body as ReadableStream<Uint8Array>, res).catch(() => {});
  });
}

const listening = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
};

for (const passSignal of [true, false]) {
  test(`a client that stops reading and then drops the connection is silent (signal ${passSignal ? "passed" : "not passed"})`, async () => {
    const fx = await seedPoster();
    const server = serve(fx.userId, fx.episodeId, { passSignal });
    try {
      const port = await listening(server);
      await expectNoEscapes(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const socket = net.connect(port, "127.0.0.1");
          await once(socket, "connect");
          socket.write("GET /poster HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\nConnection: close\r\n\r\n");
          socket.pause(); // never drain: this is the back-pressure
          await sleep(1000);
          socket.destroy();
          await sleep(200);
        }
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fx.cleanup();
    }
  });
}

test("the poster body still arrives whole, with its headers, through the same writer", async () => {
  const fx = await seedPoster();
  const server = serve(fx.userId, fx.episodeId, { passSignal: true });
  try {
    const port = await listening(server);
    await expectNoEscapes(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/poster`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/jpeg");
      assert.equal(res.headers.get("content-length"), String(BIG));
      assert.match(res.headers.get("etag") ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);
      assert.match(res.headers.get("content-disposition") ?? "", /^inline; filename="9x16-quote\.jpg"$/);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, BIG);
      assert.ok(body.equals(Buffer.alloc(BIG, 7)));
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fx.cleanup();
  }
});
