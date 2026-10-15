/**
 * Regenerating one failed episode: `prepareEpisodeRetry`, against the isolated
 * database.
 *
 * What these hold the feature to:
 *   - only a FAILED row is reset, and it is reset on the SAME row (no new episode);
 *   - only its transient run state is reset — never what makes it that episode;
 *   - a second click is refused and changes nothing;
 *   - no other episode is touched, in any state.
 *
 * The route is not called: `requireUser()` reads `cookies()`, which throws outside
 * a request scope (the split `cancel`, `episodes-api` and `publish` tests make).
 * Nothing here enqueues or runs the pipeline — `prepareEpisodeRetry` is DB-only by
 * design, and the test below that reads the route's source holds it to that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";
import { prepareEpisodeRetry } from "../src/lib/episodes/retry";
import { reserveIdea } from "../src/lib/content/idea";
import { StepTimer } from "../src/lib/step-timer";
import { requireIsolatedDatabase } from "./setup/isolation";

const LONG_AGO = () => new Date(Date.now() - 60 * 60_000);

const STEPS = ["Reserving the idea", "Writing the script", "Grounding check"];

/** A book with an upload and one idea, plus however many episodes a test asks for. */
async function fixtureBook() {
  // Fails closed before the first write: a bare `tsx --test` would put these rows
  // in the operator's real library.
  requireIsolatedDatabase("these tests create and reset episodes");
  const book = await prisma.book.create({ data: { title: `Retry fixture ${randomUUID()}` } });
  const upload = await prisma.upload.create({ data: { bookId: book.id, kind: "pdf", status: "DONE" } });
  return { book, upload };
}

type Fixture = Awaited<ReturnType<typeof fixtureBook>>;

/**
 * One idea episode in the given state, with what a real run of that state leaves
 * behind: StepRuns, and (for a state that holds it) the idea's reservation.
 * `hold` defaults to "a run that is not finished holds its reservation".
 */
async function ideaEpisode(
  { book, upload }: Fixture,
  over: {
    status: string;
    step?: string;
    error?: string | null;
    hold?: boolean;
    ideaKey?: string;
    /** Another episode of the SAME idea (as "Generate videos" makes after a failure): reuse its ContentIdea. */
    sameIdeaAs?: { idea: { id: string }; ideaKey: string };
  },
) {
  const ideaKey = over.sameIdeaAs?.ideaKey ?? over.ideaKey ?? `idea-${randomUUID()}`;
  const idea = over.sameIdeaAs?.idea ?? (await prisma.contentIdea.create({
    data: {
      uploadId: upload.id,
      bookId: book.id,
      rank: 1,
      ideaKey,
      title: "The One Sentence That Decides Your Whole Day",
      coreIdea: "c",
      hook: "h",
      whyItMatters: "w",
      angle: "a",
      hookPotential: "high",
      storyPotential: "high",
      practicalValue: "high",
      visualPotential: "high",
      sourcePages: "[0]",
      sourceRefs: "[]",
      sourceText: "words",
      scores: "{}",
      score: 1,
    },
  }));
  const finished = over.status === "FAILED" || over.status === "DONE" || over.status === "CANCELLED";
  const episode = await prisma.episode.create({
    data: {
      bookId: book.id,
      uploadId: upload.id,
      kind: "idea",
      contentIdeaId: idea.id,
      ideaKey,
      title: "The One Sentence That Decides Your Whole Day",
      theme: "spotlight",
      voiceId: "vera",
      voiceProvider: "pocket",
      status: over.status,
      step: over.step ?? (over.status === "QUEUED" ? "Queued" : "Grounding check"),
      error: over.error === undefined ? (over.status === "FAILED" ? "The grounding check rejected the script." : null) : over.error,
      startedAt: LONG_AGO(),
      finishedAt: finished ? new Date() : null,
      totalMs: finished ? 183_000 : null,
    },
  });
  if (over.status !== "QUEUED") {
    // The last step is the one the run was in when it stopped: still open if it is
    // running, FAILED if that is how it ended, closed otherwise.
    const lastStatus = over.status === "RUNNING" ? "RUNNING" : over.status === "FAILED" ? "FAILED" : "DONE";
    await prisma.stepRun.createMany({
      data: STEPS.map((step, position) => ({
        episodeId: episode.id,
        step,
        position,
        status: position === STEPS.length - 1 ? lastStatus : "DONE",
        startedAt: LONG_AGO(),
      })),
    });
  }
  const hold = over.hold ?? (over.status === "RUNNING" || over.status === "QUEUED");
  if (hold) await reserveIdea(book.id, ideaKey);
  return { episode, idea, ideaKey };
}

/** Everything about an episode a test might care did or did not change. */
async function snapshot(episodeId: string, bookId: string, ideaKey: string) {
  return {
    row: await prisma.episode.findUniqueOrThrow({ where: { id: episodeId } }),
    steps: await prisma.stepRun.findMany({ where: { episodeId }, orderBy: { position: "asc" } }),
    reserved: (await prisma.usedIdea.count({ where: { bookId, ideaKey } })) === 1,
  };
}

async function cleanup(...fixtures: Fixture[]) {
  for (const { book } of fixtures) await prisma.book.delete({ where: { id: book.id } });
}

// --- 1. A failed episode is put back, on the same row ------------------------

test("a FAILED episode is reset to QUEUED on the same row: transient state cleared, step history gone, reservation released", async () => {
  const fx = await fixtureBook();
  try {
    const { episode, ideaKey } = await ideaEpisode(fx, { status: "FAILED", hold: true });
    const before = await snapshot(episode.id, fx.book.id, ideaKey);
    assert.equal(before.steps.length, 3, "precondition: the failed attempt left its step history");
    assert.equal(before.reserved, true, "precondition: and the reservation a run that died holds");
    assert.ok(before.row.finishedAt && before.row.totalMs && before.row.error);

    const outcome = await prepareEpisodeRetry(episode.id);
    assert.deepEqual(outcome, { ok: true, status: "QUEUED" });

    const after = await snapshot(episode.id, fx.book.id, ideaKey);
    assert.deepEqual(
      [after.row.status, after.row.step, after.row.error, after.row.finishedAt, after.row.totalMs],
      ["QUEUED", "Queued", null, null, null],
      "exactly the transient run state is reset",
    );
    assert.equal(after.steps.length, 0, "the failed attempt's StepRuns are gone, so the rail starts clean while it waits");
    assert.equal(after.reserved, false, "the idea reservation is released, or the re-run would fail instantly with idea_taken");

    // The same row — not a second one.
    assert.equal(after.row.id, episode.id);
    assert.equal(await prisma.episode.count({ where: { bookId: fx.book.id } }), 1, "no new episode was created");
  } finally {
    await cleanup(fx);
  }
});

test("a regeneration keeps everything that makes the episode that episode: idea, theme, voice, title, upload", async () => {
  const fx = await fixtureBook();
  try {
    const { episode, ideaKey } = await ideaEpisode(fx, { status: "FAILED" });
    await prisma.episode.update({
      where: { id: episode.id },
      data: { hook: "Kept hook", script: "[]", notes: JSON.stringify(["kept note"]), durationSec: 61.5 },
    });
    const before = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });

    assert.equal((await prepareEpisodeRetry(episode.id)).ok, true);

    const after = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    // Every column except the five this resets (and `updatedAt`, which Prisma bumps).
    const strip = <T extends Record<string, unknown>>(r: T) => {
      const rest: Record<string, unknown> = { ...r };
      for (const k of ["status", "step", "error", "finishedAt", "totalMs", "updatedAt"]) delete rest[k];
      return rest;
    };
    assert.deepEqual(strip(after), strip(before), "no other column on the row changed");
    // Spelled out for the ones the spec names, so a failure reads as what it is.
    assert.equal(after.ideaKey, ideaKey);
    assert.equal(after.contentIdeaId, before.contentIdeaId);
    assert.equal(after.theme, "spotlight");
    assert.equal(after.voiceId, "vera");
    assert.equal(after.voiceProvider, "pocket");
    assert.equal(after.uploadId, fx.upload.id);
    assert.equal(await prisma.contentIdea.count({ where: { id: before.contentIdeaId! } }), 1, "the ContentIdea is untouched");
  } finally {
    await cleanup(fx);
  }
});

test("the reservation is what lets the re-run through: reserveIdea is refused before the reset and accepted after it", async () => {
  // This is the check that `runEpisode` -> `generateContent` -> `reserveIdea` makes
  // first. Without the release, a run that died holding its reservation could
  // never be regenerated.
  const fx = await fixtureBook();
  try {
    const { episode, ideaKey } = await ideaEpisode(fx, { status: "FAILED", hold: true });
    // By `code`, not `instanceof`: this runner can load a module twice (see cancel.test.mts).
    await assert.rejects(reserveIdea(fx.book.id, ideaKey), (err) => (err as { code?: string }).code === "idea_taken");

    assert.equal((await prepareEpisodeRetry(episode.id)).ok, true);

    assert.equal(await reserveIdea(fx.book.id, ideaKey), ideaKey, "the re-run can claim its idea again");
  } finally {
    await cleanup(fx);
  }
});

test("a FAILED episode with no ideaKey releases under its own id, the key the pipeline reserves with", async () => {
  const fx = await fixtureBook();
  try {
    const episode = await prisma.episode.create({
      data: { bookId: fx.book.id, uploadId: fx.upload.id, status: "FAILED", step: "Failed", error: "boom", ideaKey: null },
    });
    await reserveIdea(fx.book.id, episode.id);

    assert.equal((await prepareEpisodeRetry(episode.id)).ok, true);

    assert.equal(await prisma.usedIdea.count({ where: { bookId: fx.book.id, ideaKey: episode.id } }), 0);
  } finally {
    await cleanup(fx);
  }
});

// --- 2. Every kind of failure is retryable; the status alone decides ---------

test("grounding rejections, CLI failures, duration failures and interrupted runs are all retryable: FAILED is the only gate", async () => {
  // No error taxonomy exists or is wanted: the stored `error` is shown to the
  // operator as it is, and the one rule is the status. These are the messages the
  // pipeline and the reaper really write.
  const errors = [
    "The grounding check rejected the script after 2 rewrites, so no voiceover was recorded. hook: not in the page | cta: invented",
    "The narration came out 131.2 s long, outside the 60–120 s this video can run. Nothing was rendered; generate it again.",
    "claude CLI exited with code 1: rate limited",
    'The run stopped responding during "Planning the scenes". This usually means the server restarted mid-run. Start it again.',
    "The pages this idea came from (3, 4) have no readable text.",
  ];
  const fx = await fixtureBook();
  try {
    for (const error of errors) {
      const { episode } = await ideaEpisode(fx, { status: "FAILED", error });
      const outcome = await prepareEpisodeRetry(episode.id);
      assert.equal(outcome.ok, true, `retryable regardless of why it failed: ${error.slice(0, 50)}`);
      assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } })).error, null);
    }
  } finally {
    await cleanup(fx);
  }
});

// --- 3. Anything but FAILED is refused, and nothing changes -------------------

for (const status of ["QUEUED", "RUNNING", "DONE", "CANCELLED"]) {
  test(`a ${status} episode is refused with 409 not_failed and left exactly as it was`, async () => {
    const fx = await fixtureBook();
    try {
      const { episode, ideaKey } = await ideaEpisode(fx, { status, hold: true });
      const before = await snapshot(episode.id, fx.book.id, ideaKey);

      const outcome = await prepareEpisodeRetry(episode.id);

      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.equal(outcome.httpStatus, 409);
      assert.equal(outcome.code, "not_failed");
      assert.equal(outcome.error, `This episode is ${status.toLowerCase()}, so there is nothing to regenerate.`);

      const after = await snapshot(episode.id, fx.book.id, ideaKey);
      assert.deepEqual(after.row, before.row, "the row is untouched — `updatedAt` included, so nothing was even written");
      assert.deepEqual(after.steps, before.steps, "its step history is untouched");
      assert.equal(after.reserved, before.reserved, "and so is its idea reservation — a refused retry must not free a live run's claim");
      assert.equal(after.reserved, true);
    } finally {
      await cleanup(fx);
    }
  });
}

test("an episode that does not exist is 404 not_found", async () => {
  requireIsolatedDatabase("this test reads the episode table");
  const outcome = await prepareEpisodeRetry(`no-such-episode-${randomUUID()}`);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.httpStatus, 404);
  assert.equal(outcome.code, "not_found");
});

// --- 3b. A newer video for the same idea: refuse, and never free its claim ------

/**
 * The hazard. A (idea X) fails and releases X. "Generate videos" then makes a NEW
 * episode B for X (a FAILED episode does not count as one), and B reserves X. The
 * reservation is per (book, idea), so releasing it for A would delete B's claim and
 * the re-run would reserve it again: two videos of one idea, which the unique index
 * cannot catch because release and re-reserve are sequential.
 */
for (const siblingStatus of ["DONE", "QUEUED", "RUNNING"]) {
  test(`a FAILED episode with a ${siblingStatus} sibling for the same idea is refused as superseded, and the sibling's claim survives`, async () => {
    const fx = await fixtureBook();
    try {
      const failed = await ideaEpisode(fx, { status: "FAILED", hold: false });
      const sibling = await ideaEpisode(fx, { status: siblingStatus, hold: true, sameIdeaAs: failed });
      assert.equal(sibling.ideaKey, failed.ideaKey, "precondition: one idea, two episodes");
      const failedBefore = await snapshot(failed.episode.id, fx.book.id, failed.ideaKey);
      const siblingBefore = await snapshot(sibling.episode.id, fx.book.id, sibling.ideaKey);
      assert.equal(siblingBefore.reserved, true, "precondition: the sibling holds the (book, idea) reservation");

      const outcome = await prepareEpisodeRetry(failed.episode.id);

      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok);
      assert.deepEqual([outcome.httpStatus, outcome.code], [409, "superseded"]);
      assert.equal(outcome.error, "A newer video for this idea already exists, so regenerate that one instead.");

      // The core regression: the reservation is still there.
      const siblingAfter = await snapshot(sibling.episode.id, fx.book.id, sibling.ideaKey);
      assert.equal(siblingAfter.reserved, true, "the sibling's reservation was NOT released");
      assert.deepEqual(siblingAfter, siblingBefore, "the sibling is untouched");
      assert.deepEqual(await snapshot(failed.episode.id, fx.book.id, failed.ideaKey), failedBefore, "and so is the FAILED row: not reset, not cleaned");
      assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: failed.episode.id } })).status, "FAILED");
    } finally {
      await cleanup(fx);
    }
  });
}

test("a FAILED episode whose same-idea sibling is also FAILED (or CANCELLED) may still be retried: neither is a live or finished video", async () => {
  const fx = await fixtureBook();
  try {
    const a = await ideaEpisode(fx, { status: "FAILED", hold: true });
    await ideaEpisode(fx, { status: "FAILED", hold: false, sameIdeaAs: a });
    await ideaEpisode(fx, { status: "CANCELLED", hold: false, sameIdeaAs: a });

    assert.deepEqual(await prepareEpisodeRetry(a.episode.id), { ok: true, status: "QUEUED" });
    assert.equal(await prisma.usedIdea.count({ where: { bookId: fx.book.id, ideaKey: a.ideaKey } }), 0, "and its release still happens");
  } finally {
    await cleanup(fx);
  }
});

test("a same-ideaKey DONE episode in a DIFFERENT book does not block a retry: the check is scoped to the book", async () => {
  const a = await fixtureBook();
  const b = await fixtureBook();
  try {
    const shared = `shared-${randomUUID()}`;
    const mine = await ideaEpisode(a, { status: "FAILED", hold: true, ideaKey: shared });
    const theirs = await ideaEpisode(b, { status: "DONE", hold: true, ideaKey: shared });
    const before = await snapshot(theirs.episode.id, b.book.id, shared);

    assert.deepEqual(await prepareEpisodeRetry(mine.episode.id), { ok: true, status: "QUEUED" });

    assert.deepEqual(await snapshot(theirs.episode.id, b.book.id, shared), before, "the other book's claim is untouched");
  } finally {
    await cleanup(a, b);
  }
});

test("a FAILED episode with no ideaKey is retried regardless of other no-key episodes: its key is its own id", async () => {
  const fx = await fixtureBook();
  try {
    const mk = (status: string) =>
      prisma.episode.create({ data: { bookId: fx.book.id, uploadId: fx.upload.id, status, step: status, ideaKey: null } });
    const failed = await mk("FAILED");
    const doneNoKey = await mk("DONE");
    const runningNoKey = await mk("RUNNING");
    // Each holds a reservation under ITS OWN id, which another's release cannot reach.
    await reserveIdea(fx.book.id, doneNoKey.id);
    await reserveIdea(fx.book.id, failed.id);

    assert.deepEqual(await prepareEpisodeRetry(failed.id), { ok: true, status: "QUEUED" });

    assert.equal(await prisma.usedIdea.count({ where: { bookId: fx.book.id, ideaKey: failed.id } }), 0);
    assert.equal(await prisma.usedIdea.count({ where: { bookId: fx.book.id, ideaKey: doneNoKey.id } }), 1, "another no-key episode's claim is its own");
    assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: doneNoKey.id } })).status, "DONE");
    assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: runningNoKey.id } })).status, "RUNNING");
  } finally {
    await cleanup(fx);
  }
});

test("the superseded check runs before anything is released or reset, and the atomic reset stays last: the source order", async () => {
  const lib = await fs.readFile(fileURLToPath(new URL("../src/lib/episodes/retry.ts", import.meta.url)), "utf8");
  const at = (needle: string) => lib.indexOf(needle);
  assert.ok(at('code: "superseded"') > 0);
  assert.ok(at("prisma.episode.findFirst") < at("await releaseIdea("), "the sibling check runs before the release");
  assert.ok(at("await releaseIdea(") < at("prisma.stepRun.deleteMany"));
  assert.ok(at("prisma.stepRun.deleteMany") < at("prisma.episode.updateMany"), "and the atomic reset is last");
});

// --- 4. Duplicate clicks ------------------------------------------------------

test("a second click after the first is refused, and does not touch the run the first one started", async () => {
  const fx = await fixtureBook();
  try {
    const { episode, ideaKey } = await ideaEpisode(fx, { status: "FAILED", hold: true });
    assert.equal((await prepareEpisodeRetry(episode.id)).ok, true);

    // The first click's run now starts: it reserves the idea and opens a step, as
    // `generateContent` and `StepTimer` do. A second reset would wipe both.
    await reserveIdea(fx.book.id, ideaKey);
    await prisma.stepRun.create({
      data: { episodeId: episode.id, step: "Reserving the idea", position: 0, status: "RUNNING", startedAt: new Date() },
    });
    const running = await snapshot(episode.id, fx.book.id, ideaKey);

    const second = await prepareEpisodeRetry(episode.id);

    assert.equal(second.ok, false);
    assert.ok(!second.ok);
    assert.deepEqual([second.httpStatus, second.code], [409, "not_failed"]);
    assert.deepEqual(await snapshot(episode.id, fx.book.id, ideaKey), running, "no double reset");
  } finally {
    await cleanup(fx);
  }
});

test("two clicks that arrive together: exactly one resets the row, the other is told it is no longer failed", async () => {
  const fx = await fixtureBook();
  try {
    const { episode } = await ideaEpisode(fx, { status: "FAILED" });

    const results = await Promise.all([prepareEpisodeRetry(episode.id), prepareEpisodeRetry(episode.id)]);

    assert.equal(results.filter((r) => r.ok).length, 1, "only one caller is allowed to enqueue the retry");
    const loser = results.find((r) => !r.ok);
    assert.ok(loser && !loser.ok);
    assert.deepEqual([loser.httpStatus, loser.code], [409, "not_failed"]);
    assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } })).status, "QUEUED");
  } finally {
    await cleanup(fx);
  }
});

// --- 5. Isolation: only the selected failed episode -------------------------

test("retrying one failed episode does not touch its siblings in any state", async () => {
  const fx = await fixtureBook();
  try {
    const target = await ideaEpisode(fx, { status: "FAILED", hold: true });
    const siblings = [
      await ideaEpisode(fx, { status: "FAILED", hold: true, error: "a different failure" }),
      await ideaEpisode(fx, { status: "RUNNING" }),
      await ideaEpisode(fx, { status: "QUEUED" }),
      await ideaEpisode(fx, { status: "DONE", hold: true }),
      await ideaEpisode(fx, { status: "CANCELLED" }),
    ];
    const before = await Promise.all(siblings.map((s) => snapshot(s.episode.id, fx.book.id, s.ideaKey)));
    const episodesBefore = await prisma.episode.count({ where: { bookId: fx.book.id } });

    assert.equal((await prepareEpisodeRetry(target.episode.id)).ok, true);

    const after = await Promise.all(siblings.map((s) => snapshot(s.episode.id, fx.book.id, s.ideaKey)));
    assert.deepEqual(after, before, "status, step, error, StepRuns and reservation of every sibling are unchanged");
    assert.equal(await prisma.episode.count({ where: { bookId: fx.book.id } }), episodesBefore, "no episode was created or deleted");
    assert.equal(await prisma.book.count({ where: { id: fx.book.id } }), 1);
  } finally {
    await cleanup(fx);
  }
});

test("retrying an episode of one book leaves another book's failed episode alone", async () => {
  const a = await fixtureBook();
  const b = await fixtureBook();
  try {
    // Same idea key in both books: the reservation is per (book, idea), so one
    // book's release must not reach the other's.
    const shared = `shared-${randomUUID()}`;
    const mine = await ideaEpisode(a, { status: "FAILED", hold: true, ideaKey: shared });
    const theirs = await ideaEpisode(b, { status: "FAILED", hold: true, ideaKey: shared });
    const before = await snapshot(theirs.episode.id, b.book.id, shared);

    assert.equal((await prepareEpisodeRetry(mine.episode.id)).ok, true);

    assert.deepEqual(await snapshot(theirs.episode.id, b.book.id, shared), before);
  } finally {
    await cleanup(a, b);
  }
});

// --- 6. The pieces the feature relies on, held in place ----------------------

test("the run that follows starts clean: StepTimer.begin leaves a retried row with no timings and no finish", async () => {
  // `prepareEpisodeRetry` clears the rail for the wait; `runEpisode` calls
  // `StepTimer.begin()` first thing when it starts. This is the established
  // fact the feature rests on, pinned: a retry never stacks on the old attempt.
  const fx = await fixtureBook();
  try {
    const { episode } = await ideaEpisode(fx, { status: "FAILED" });
    assert.equal((await prepareEpisodeRetry(episode.id)).ok, true);

    await new StepTimer(episode.id).begin();

    const row = await prisma.episode.findUniqueOrThrow({ where: { id: episode.id } });
    assert.equal(row.finishedAt, null);
    assert.equal(row.totalMs, null);
    assert.ok(row.startedAt && row.startedAt.getTime() > Date.now() - 60_000, "startedAt is this run's, not the failed attempt's");
    assert.equal(await prisma.stepRun.count({ where: { episodeId: episode.id } }), 0);
  } finally {
    await cleanup(fx);
  }
});

test("the lib is DB-only and the route enqueues only after the lib accepted the reset", async () => {
  const lib = await fs.readFile(fileURLToPath(new URL("../src/lib/episodes/retry.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(lib, /from\s+["'][^"']*(pipeline|queue)["']/, "retry.ts must not import the pipeline or the queue: tests call it, and must never start a render");
  assert.doesNotMatch(lib, /\b(enqueueEpisode|runEpisode)\s*\(/, "and never calls either (its comments may name them)");

  const route = await fs.readFile(fileURLToPath(new URL("../src/app/api/episodes/[id]/retry/route.ts", import.meta.url)), "utf8");
  assert.match(route, /requireUser\(\)/, "signed-in users only");
  assert.match(route, /canSee\(episode, user\.id\)/, "the shared visibility rule, not a hand-rolled copy");
  const at = (s: string) => route.search(new RegExp(s));
  assert.ok(at("canSee\\(") < at("prepareEpisodeRetry\\(id\\)"), "visibility is checked before anything is reset");
  assert.ok(at("prepareEpisodeRetry\\(id\\)") < at("if \\(!outcome\\.ok\\)"), "the outcome is checked");
  assert.ok(at("if \\(!outcome\\.ok\\)") < at("enqueueEpisode\\(id\\)"), "and enqueueEpisode only runs after a not-ok outcome has returned");
  assert.equal(route.match(/enqueueEpisode\(/g)?.length, 1, "enqueued exactly once");
});
