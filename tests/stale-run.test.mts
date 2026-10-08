/**
 * A run that stops existing must always reach a terminal state.
 *
 * THE BUG THESE TESTS WERE WRITTEN FOR. `StepTimer.start` closes the previous
 * `StepRun` DONE *before* it creates the next one, so between any two steps
 * the episode has steps but none RUNNING. `reapStaleRuns` only ever looked for
 * "a step open too long" or "no steps at all", so a process that died in that
 * window matched neither branch and the row stayed RUNNING forever — measured
 * at 17 hours on episode cmuwm1kle000tn6zg2afz71k3, with all eight of its
 * StepRuns DONE. `requestCancel` then honestly answered "nothing to signal"
 * (409 `not_active_here`) and the card showed "Cancelling…" with nothing
 * behind it, because the message's promise — "it will be marked interrupted
 * automatically within a few minutes" — had no mechanism.
 *
 * `reap.ts` branch 3 (`steps: { none: { status: "RUNNING" } }` with a stale
 * `updatedAt`) is that mechanism, and the test named "died BETWEEN steps"
 * below is the one that fails without it.
 *
 * The negative test matters as much as the five: branch 3 is the broadest of
 * the three, and `isEpisodeLive` is the only thing standing between a slow
 * real render and being killed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";
import { WORK_ROOT } from "../src/lib/paths";
import { reapStaleRuns } from "../src/lib/reap";
import { beginCancellable, endCancellable, requestCancel, cancelEpisode } from "../src/lib/cancel";
import { queueState, isEpisodeLive } from "../src/lib/episodes/live";
import { run } from "../src/lib/content/cli";
import { requireIsolation } from "./setup/isolation";

const HANG_SCRIPT = fileURLToPath(new URL("./fixtures/hang-forever.mjs", import.meta.url));

/** What `EpisodeCard.tsx` stops polling on, and what clears its "Cancelling…" flag. */
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

/** Comfortably older than `reap.ts`'s 12-minute cap, without naming it. */
const LONG_AGO = () => new Date(Date.now() - 60 * 60_000);

function isAlive(pid: number): boolean {
  try {
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

async function fixtureEpisode(over: { status?: string; step?: string } = {}) {
  // Fails closed before the first write, for the reason `setup/isolation.ts`
  // gives: a bare `tsx --test` run of this file would create these rows in the
  // operator's real library and reap their real episodes.
  requireIsolation("these tests create and reap episodes, and spawn a child process");
  const book = await prisma.book.create({ data: { title: `Stale run fixture ${randomUUID()}` } });
  const upload = await prisma.upload.create({ data: { bookId: book.id, kind: "pdf", status: "DONE" } });
  const episode = await prisma.episode.create({
    data: {
      bookId: book.id,
      uploadId: upload.id,
      title: "The One Sentence That Decides Your Whole Day",
      ideaKey: `idea-${randomUUID()}`,
      status: over.status ?? "RUNNING",
      step: over.step ?? "Planning the scenes",
      startedAt: LONG_AGO(),
    },
  });
  return { book, upload, episode };
}

/**
 * The eight DONE StepRuns the real stuck row had, then `updatedAt` pushed back
 * past the cutoff. `updatedAt` is `@updatedAt`, so Prisma rewrites it on every
 * `update()` — raw SQL is the only way to stage "this row last moved an hour
 * ago", which is exactly the state a killed process leaves.
 */
async function diedBetweenSteps(episodeId: string, when: Date = LONG_AGO()) {
  const steps = [
    "Reserving the idea",
    "Writing the script",
    "Writing the script",
    "Grounding check",
    "Preparing page assets",
    "Recording the voiceover",
    "Timing the captions",
    "Planning the scenes",
  ];
  await prisma.stepRun.createMany({
    data: steps.map((step, position) => ({
      episodeId,
      step,
      position,
      status: "DONE",
      startedAt: new Date(when.getTime() + position * 1000),
      endedAt: new Date(when.getTime() + position * 1000 + 500),
      durationMs: 500,
    })),
  });
  await prisma.$executeRaw`UPDATE Episode SET updatedAt = ${when} WHERE id = ${episodeId}`;
}

// --- 1. Cancelling a run whose child process is still alive ------------------

test("cancelling a live run signals its controller and really kills the child process", async () => {
  const { book, episode } = await fixtureEpisode();
  const pidFile = path.join(WORK_ROOT, `stale-run-pid-${randomUUID()}.txt`);
  await fs.mkdir(WORK_ROOT, { recursive: true });

  beginCancellable(episode.id);
  try {
    // Exactly how `runEpisode` spawns: the ambient signal from
    // `beginCancellable`, not a parameter threaded through.
    const promise = run(process.execPath, [HANG_SCRIPT, pidFile], { cwd: process.cwd(), timeoutMs: 30_000 });
    const pid = Number(
      await waitFor(async () => {
        if (!existsSync(pidFile)) return null;
        return (await fs.readFile(pidFile, "utf8")).trim() || null;
      }),
    );
    assert.ok(isAlive(pid), "the child is genuinely running before anything cancels it");

    // The route's own decision, not a reimplementation of it.
    const outcome = cancelEpisode(episode.id, "RUNNING");
    assert.deepEqual(outcome, { ok: true, status: "cancelling" }, "a live run is acknowledged as cancelling");

    await assert.rejects(promise);
    await waitFor(() => !isAlive(pid));
    assert.equal(isAlive(pid), false, "the OS process is dead — cancellation is not a database-only status flip");
  } finally {
    endCancellable(episode.id);
    await fs.rm(pidFile, { force: true });
    await prisma.book.delete({ where: { id: book.id } });
  }
});

// --- 2. Cancelling a run whose child is already gone -------------------------

test("cancelling a run this process no longer holds answers 409 not_active_here, and the reaper then keeps that answer's promise", async () => {
  const { book, episode } = await fixtureEpisode();
  try {
    // A restart leaves no controller behind — nothing here to signal.
    assert.equal(requestCancel(episode.id), false, "must never report success for a run it did not signal");

    const outcome = cancelEpisode(episode.id, "RUNNING");
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.equal(outcome.httpStatus, 409);
    assert.equal(outcome.code, "not_active_here");
    assert.match(
      outcome.error,
      /marked interrupted automatically within a few minutes/,
      "the message makes a promise; the rest of this test is that promise being kept",
    );

    // That promise, honoured. This is the between-steps shape, which is the
    // one the message used to lie about.
    await diedBetweenSteps(episode.id);
    await reapStaleRuns();

    const after = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.ok(TERMINAL.has(after.status), `the row reached a terminal state, not ${after.status}`);
    assert.deepEqual([after.status, after.step], ["FAILED", "Interrupted"]);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

// --- 3. The bug: died BETWEEN steps -----------------------------------------

test("a RUNNING episode that died BETWEEN steps — every StepRun DONE, nothing open — is reaped", async () => {
  // THIS IS THE REGRESSION. Against `reap.ts` without its third branch this
  // test fails: the row matches neither "a step open too long" (none is open)
  // nor "no steps at all" (there are eight), so it is never selected and
  // stays RUNNING forever.
  const { book, episode } = await fixtureEpisode();
  try {
    await diedBetweenSteps(episode.id);

    // The precondition, asserted rather than assumed: this is genuinely the
    // between-steps shape, not a run with a step still open.
    const steps = await prisma.stepRun.findMany({ where: { episodeId: episode.id } });
    assert.equal(steps.length, 8);
    assert.ok(
      steps.every((s) => s.status === "DONE"),
      "all StepRuns are DONE — there is nothing for the 'open step' branch to find",
    );
    const before = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.equal(before.status, "RUNNING");
    assert.equal(before.finishedAt, null);
    assert.equal(isEpisodeLive(episode.id), false, "nothing in this process is running it");

    const reaped = await reapStaleRuns();
    assert.ok(reaped >= 1, "the reaper selected it");

    const after = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.deepEqual([after.status, after.step], ["FAILED", "Interrupted"]);
    assert.ok(after.finishedAt, "a terminal row carries a finishedAt, so the library stops timing it");
    assert.match(
      after.error ?? "",
      /stopped responding during "Planning the scenes"/,
      "the message names the step it died on and tells the operator to start it again",
    );
    assert.match(after.error ?? "", /Start it again/);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

// --- 4. Queued and never started (guards the pre-existing branch) ------------

test("a QUEUED episode a restart left behind, with no steps at all, is still reaped", async () => {
  const { book, episode } = await fixtureEpisode({ status: "QUEUED", step: "Queued" });
  try {
    await prisma.$executeRaw`UPDATE Episode SET createdAt = ${LONG_AGO()}, updatedAt = ${LONG_AGO()} WHERE id = ${episode.id}`;
    assert.equal(await prisma.stepRun.count({ where: { episodeId: episode.id } }), 0);

    await reapStaleRuns();

    const after = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.deepEqual([after.status, after.step], ["FAILED", "Interrupted"]);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

// --- 5. The terminal state is what the poll reports --------------------------

test("after reaping, the fields GET /api/episodes/[id] polls report a terminal status, so the card stops saying Cancelling…", async () => {
  const { book, episode } = await fixtureEpisode();
  try {
    await diedBetweenSteps(episode.id);

    // The handler itself cannot be called here — `requireUser()` reads
    // `cookies()`, which throws outside a request scope (the same split
    // `episodes-api.test.mts` and `publish.test.mts` make). So: the reap it
    // performs on every poll, then the exact projection it answers with.
    await reapStaleRuns().catch(() => {});
    const polled = await prisma.episode.findUniqueOrThrow({
      where: { id: episode.id },
      include: { steps: { orderBy: { position: "asc" } } },
    });

    assert.ok(
      TERMINAL.has(polled.status),
      `EpisodeCard's TERMINAL set must contain the polled status; got ${polled.status}`,
    );
    assert.ok(polled.error, "and the card has something to show instead of a spinner");
    assert.ok(
      polled.steps.every((s) => s.status !== "RUNNING"),
      "no step is left reporting itself as running under a finished episode",
    );

    // The poll is where the reap happens — if that call is ever dropped from
    // the route, a stuck row is invisible again however good the reaper is.
    const routeSource = await fs.readFile(
      fileURLToPath(new URL("../src/app/api/episodes/[id]/route.ts", import.meta.url)),
      "utf8",
    );
    assert.match(routeSource, /reapStaleRuns\(\)/, "the episode poll still runs the reaper");
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

// --- Negative: a live run is never reaped, however long it has sat -----------

test("an episode this process is genuinely running is NEVER reaped, even with a long-stale updatedAt and no open step", async () => {
  // The regression that would hurt most: branch 3 is broad enough to match a
  // real render whose current step is slower than the cutoff, and
  // `isEpisodeLive` is the only thing that saves it.
  const { book, episode } = await fixtureEpisode();
  try {
    await diedBetweenSteps(episode.id);

    queueState.current = episode.id;
    try {
      await reapStaleRuns();
    } finally {
      queueState.current = null;
    }
    const running = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.deepEqual([running.status, running.step], ["RUNNING", "Planning the scenes"], "a live run is left alone");
    assert.equal(running.finishedAt, null);

    // Queued in this process counts as live too: an idea episode waiting
    // behind three renders can sit untouched for far longer than the cutoff.
    queueState.waiting.push(episode.id);
    try {
      await reapStaleRuns();
    } finally {
      queueState.waiting.splice(queueState.waiting.indexOf(episode.id), 1);
    }
    assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } })).status, "RUNNING");

    // And the moment it is no longer live, the same row is reaped — proving
    // the two tests above differ only in liveness.
    await reapStaleRuns();
    const reaped = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.deepEqual([reaped.status, reaped.step], ["FAILED", "Interrupted"]);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});
