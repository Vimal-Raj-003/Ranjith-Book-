import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginCancellable,
  endCancellable,
  requestCancel,
  currentSignal,
  throwIfCancelled,
  wasCancelled,
  abortOpts,
  CancelledError,
} from "../src/lib/cancel";
import { run } from "../src/lib/content/cli";

const HANG_SCRIPT = fileURLToPath(new URL("./fixtures/hang-forever.mjs", import.meta.url));

function isAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing — it only checks whether the process exists and
    // is ours to signal, which is exactly what "still running" means here.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// `cli.ts` constructs its own `CancelledError` from its own import of
// `../cancel` — under this test runner that can resolve to a different
// loaded instance of the module than this file's own import, so `instanceof`
// alone is not reliable across that boundary (the same reason the pre-
// existing `CliError` checks elsewhere in this suite fail this same way).
// `.name` survives it: it is a plain string, not a class reference.
function isCancelledError(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === "CancelledError");
}

// --- The registry: signalling, and being honest when there is nothing to signal ---

test("requestCancel aborts the registered controller's signal, and reports false once it already has", () => {
  const id = `test-ep-${randomUUID()}`;
  const controller = beginCancellable(id);
  try {
    assert.equal(controller.signal.aborted, false);
    assert.equal(requestCancel(id), true, "a live, un-cancelled run is signalled");
    assert.equal(controller.signal.aborted, true);
    assert.equal(requestCancel(id), false, "signalling an already-cancelled run reports nothing new happened");
  } finally {
    endCancellable(id);
  }
});

test("requestCancel on an id nothing registered for does nothing and says so — never fakes success", () => {
  assert.equal(requestCancel(`no-such-episode-${randomUUID()}`), false);
});

test("endCancellable removes the run, so a cancel request afterwards is honestly reported as not live", () => {
  const id = `test-ep-${randomUUID()}`;
  beginCancellable(id);
  endCancellable(id);
  assert.equal(requestCancel(id), false, "must not report success for a run this process is no longer tracking");
});

// --- The ambient signal: reaches deep code with no `signal` parameter ---

test("the cancellation signal is ambient — a nested call sees it with nothing passed to it", async () => {
  const id = `test-ep-${randomUUID()}`;
  beginCancellable(id);
  try {
    async function deeplyNested(): Promise<AbortSignal | undefined> {
      return currentSignal();
    }
    const signal = await deeplyNested();
    assert.ok(signal, "the signal reached a function it was never explicitly handed");
    assert.equal(wasCancelled(), false);
    requestCancel(id);
    assert.equal(wasCancelled(), true, "the SAME ambient signal reflects the cancellation everywhere it is read");
  } finally {
    endCancellable(id);
  }
});

test("throwIfCancelled is a no-op before cancellation and throws CancelledError after", () => {
  const id = `test-ep-${randomUUID()}`;
  beginCancellable(id);
  try {
    assert.doesNotThrow(() => throwIfCancelled());
    requestCancel(id);
    assert.throws(() => throwIfCancelled(), CancelledError);
  } finally {
    endCancellable(id);
  }
});

test("abortOpts is empty with no run in progress, and carries a real kill-capable signal once one has started", () => {
  assert.deepEqual(abortOpts(), {}, "nothing to spread when nothing is cancellable, so every spawn call site stays inert");
  const id = `test-ep-${randomUUID()}`;
  beginCancellable(id);
  try {
    const opts = abortOpts();
    assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(opts.killSignal, "SIGKILL");
  } finally {
    endCancellable(id);
  }
});

// --- The actual point of this feature: a real child process really dies ---

test("cancelling mid-run kills the real child process, not just the promise waiting on it", async () => {
  const id = `test-ep-${randomUUID()}`;
  const pidFile = path.join(process.cwd(), `.test-pid-${randomUUID()}.txt`);
  beginCancellable(id);
  try {
    // Mirrors exactly how `runEpisode` uses `run()`: the ambient signal from
    // `beginCancellable` above, not a parameter passed to this call.
    const promise = run(process.execPath, [HANG_SCRIPT, pidFile], { cwd: process.cwd(), timeoutMs: 30_000 });

    const pid = Number(
      await waitFor(async () => {
        if (!existsSync(pidFile)) return null;
        const text = (await fs.readFile(pidFile, "utf8")).trim();
        return text || null;
      }),
    );
    assert.ok(isAlive(pid), "the fixture process is genuinely running before anything cancels it");

    assert.equal(requestCancel(id), true);
    await assert.rejects(promise, isCancelledError);

    await waitFor(() => !isAlive(pid));
    assert.equal(isAlive(pid), false, "the OS process itself is dead — cancellation is not a database-only status flip");
  } finally {
    endCancellable(id);
    await fs.rm(pidFile, { force: true });
  }
});

test("run() refuses to even spawn a new child once the run was already cancelled", async () => {
  const id = `test-ep-${randomUUID()}`;
  beginCancellable(id);
  try {
    requestCancel(id);
    await assert.rejects(run(process.execPath, ["-e", "0"], { cwd: process.cwd(), timeoutMs: 5000 }), isCancelledError);
  } finally {
    endCancellable(id);
  }
});

test("a run that finishes normally is unaffected by cancellation machinery it never triggers", async () => {
  const id = `test-ep-${randomUUID()}`;
  beginCancellable(id);
  try {
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write('ok')"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    assert.equal(stdout, "ok");
  } finally {
    endCancellable(id);
  }
});
