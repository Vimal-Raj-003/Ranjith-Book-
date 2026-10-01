import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import {
  ideaEpisodeSource,
  ideaVideoDuration,
  createIdeaEpisodes,
  MAX_IDEA_PAGES,
} from "../src/lib/episodes/idea-episode";
import { queueState } from "../src/lib/episodes/live";
import { reapStaleRuns } from "../src/lib/reap";
import { checkLength } from "../src/lib/content/index";
import { reserveIdea, IdeaTakenError } from "../src/lib/content/idea";
import { LENGTHS, CONTENT_JSON_SCHEMA, contentJsonSchema, spokenWordCount } from "../src/lib/content/schema";
import { buildSystemPrompt, buildUserPrompt } from "../src/lib/content/prompt";

const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`);

function idea(over: Partial<Record<string, string | null>> = {}) {
  return {
    title: "The obstacle is the way",
    coreIdea: "What stands in the way becomes the way.",
    hook: "Your biggest obstacle is your next move.",
    whyItMatters: "It turns setbacks into material.",
    sourcePages: JSON.stringify([5]),
    sourceRefs: JSON.stringify([{ pageIndex: 5, startWord: 2, endWord: 4 }]),
    relatedPages: JSON.stringify([9, 1, 2, 3, 4, 6, 7, 8, 10]),
    ...over,
  };
}

// --- which pages, and the brief ---------------------------------------------

test("an idea's source pages come first, related pages fill up to the cap, empty pages are skipped", () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ pageIndex: i, words: i === 9 ? [] : words(50, `p${i}-`) }));
  const src = ideaEpisodeSource(idea(), pages);
  assert.ok(src.pageIndices.includes(5), "the source page is always included");
  assert.ok(!src.pageIndices.includes(9), "a page with no text is skipped");
  assert.equal(src.pageIndices.length, MAX_IDEA_PAGES);
  assert.deepEqual(src.pageIndices, [...src.pageIndices].sort((a, b) => a - b), "pages in book order");
  assert.deepEqual(src.pageIndices, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("the brief carries the idea and its located quote, taken from the page words", () => {
  const pages = [{ pageIndex: 5, words: ["The", "impediment", "to", "action", "advances", "action."] }];
  const src = ideaEpisodeSource(idea({ relatedPages: null }), pages);
  assert.deepEqual(src.pageIndices, [5]);
  assert.equal(src.brief.title, "The obstacle is the way");
  assert.deepEqual(src.brief.quotes, [{ pageIndex: 5, startWord: 2, endWord: 4, text: "to action advances" }]);
});

test("an idea whose source pages have no text is refused with a sentence", () => {
  assert.throws(
    () => ideaEpisodeSource(idea(), [{ pageIndex: 5, words: [] }, { pageIndex: 9, words: words(20) }]),
    /pages this idea came from \(6\) have no readable text/,
  );
});

// --- length -----------------------------------------------------------------

const beats = (n: number, wordsEach: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, voiceover: words(wordsEach).join(" "), onScreen: "", sourcePage: 0, startWord: 0, endWord: 0,
  }));

test("the length gate: a long script fits the 45–90 s envelope (4–12 beats, 104–228 words); short scripts are never gated", () => {
  assert.equal(checkLength({ beats: beats(3, 10) }, LENGTHS.short), null, "short has no length gate");
  assert.equal(checkLength({ beats: beats(9, 20) }, LENGTHS.long), null, "180 words in 9 beats fits");
  assert.equal(checkLength({ beats: beats(7, 25) }, LENGTHS.long), null, "175 words in 7 beats fits");
  assert.equal(checkLength({ beats: beats(8, 13) }, LENGTHS.long), null, "104 words is the shortest a script may be");

  const tooShort = checkLength({ beats: beats(8, 10) }, LENGTHS.long)!;
  assert.equal(tooShort.words, 80);
  assert.match(tooShort.brief, /Develop it to about 160 words/);

  const tooLong = checkLength({ beats: beats(10, 26) }, LENGTHS.long)!;
  assert.match(tooLong.brief, /Cut it to about 160 words/);

  const tooManyBeats = checkLength({ beats: beats(14, 12) }, LENGTHS.long)!;
  assert.match(tooManyBeats.problem, /14 beats, outside the 4–12/);
  assert.equal(spokenWordCount({ beats: beats(4, 10) }), 40);
});

test("the long schema asks for 4–12 beats; the short schema is unchanged", () => {
  assert.equal(contentJsonSchema("long").properties.beats.minItems, 4);
  assert.equal(contentJsonSchema("long").properties.beats.maxItems, 12);
  assert.equal(contentJsonSchema("short").properties.beats.minItems, CONTENT_JSON_SCHEMA.properties.beats.minItems);
  assert.equal(CONTENT_JSON_SCHEMA.properties.beats.maxItems, 8, "the photo schema still allows 4–8 beats");
});

test("a short prompt is unchanged; a long prompt states the length and the idea", () => {
  const short = buildSystemPrompt({ hasAuthor: false });
  assert.equal(short, buildSystemPrompt({ hasAuthor: false, length: "short" }));
  assert.match(short, /^You write 60-to-90-second vertical video scripts/);
  assert.ok(!/LONG EPISODE/.test(short));

  const long = buildSystemPrompt({ hasAuthor: false, length: "long" });
  assert.match(long, /^You write 45-to-90-second vertical video scripts/);
  assert.match(long, /between 4 and 12 beats/);
  assert.match(long, /between 104 and 218 words/);
  assert.match(long, /never run past 90 seconds/);

  const input = {
    bookTitle: "Meditations", author: null, archetype: "philosophy" as const, rightsStatus: "public-domain" as const,
    ideaKey: "obstacle", pages: [{ pageIndex: 5, chapterHeading: null, words: ["a", "b"] }], avoidHooks: [],
  };
  assert.ok(!/THE IDEA THIS EPISODE IS ABOUT/.test(buildUserPrompt(input)));
  const withBrief = buildUserPrompt({
    ...input,
    brief: { title: "T", coreIdea: "C", hook: "H", whyItMatters: "W", quotes: [{ pageIndex: 5, startWord: 0, endWord: 1, text: "a b" }] },
  });
  assert.match(withBrief, /THE IDEA THIS EPISODE IS ABOUT/);
  assert.match(withBrief, /PAGE 5, words 0–1: "a b"/);
});

test("finished-video duration: 45–90 s is fine, a short one is a note, past 90 s or a broken one fails", () => {
  assert.equal(ideaVideoDuration(90), "ok", "90 s is allowed; it is the ceiling");
  assert.equal(ideaVideoDuration(60), "ok");
  assert.equal(ideaVideoDuration(45), "ok");
  assert.equal(ideaVideoDuration(38), "note");
  assert.equal(ideaVideoDuration(90.5), "fail", "one half-second over the ceiling is refused");
  assert.equal(ideaVideoDuration(120), "fail");
  assert.equal(ideaVideoDuration(20), "fail");
  assert.equal(ideaVideoDuration(Number.NaN), "fail");
});

// --- episodes (isolated test database) ------------------------------------------

async function fixtureBook() {
  const book = await prisma.book.create({ data: { title: `Idea episode fixture ${Date.now()}` } });
  const upload = await prisma.upload.create({ data: { bookId: book.id, kind: "pdf", status: "DONE" } });
  const mk = (key: string, rank: number) =>
    prisma.contentIdea.create({
      data: {
        uploadId: upload.id, bookId: book.id, rank, ideaKey: key, title: key, coreIdea: "c", hook: "h",
        whyItMatters: "w", angle: "other", hookPotential: "", storyPotential: "", practicalValue: "",
        visualPotential: "", sourcePages: "[0]", sourceRefs: "[]", sourceText: "x", scores: "{}", score: 7,
      },
    });
  return { book, upload, a: await mk("idea-a", 1), b: await mk("idea-b", 2) };
}

test("generating makes one queued idea episode per idea, and never a second while one is live or done", async () => {
  const { book, upload, a, b } = await fixtureBook();
  try {
    const first = await createIdeaEpisodes(upload.id, [a.id, b.id, "not-an-idea"], null);
    assert.equal(first.length, 2, "an id that is not this book's idea is ignored");
    assert.ok(first.every((e) => e.created));
    const ep = await prisma.episode.findUniqueOrThrow({ where: { id: first[0].episodeId } });
    assert.deepEqual([ep.kind, ep.format, ep.contentIdeaId, ep.ideaKey, ep.status], ["idea", "9:16", a.id, "idea-a", "QUEUED"]);

    const again = await createIdeaEpisodes(upload.id, [a.id], null);
    assert.deepEqual(again, [{ ideaId: a.id, episodeId: first[0].episodeId, created: false, status: "QUEUED" }]);

    await prisma.episode.update({ where: { id: first[0].episodeId }, data: { status: "FAILED" } });
    const retry = await createIdeaEpisodes(upload.id, [a.id], null);
    assert.equal(retry[0].created, true, "after a failure, generating again starts a fresh run");
    assert.notEqual(retry[0].episodeId, first[0].episodeId);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("the reaper leaves an episode this process is still holding, and reaps it once it is not", async () => {
  const { book, upload, a } = await fixtureBook();
  try {
    const [{ episodeId }] = await createIdeaEpisodes(upload.id, [a.id], null);
    // Waiting in the queue longer than the reaper's cutoff, with no steps yet.
    await prisma.$executeRaw`UPDATE Episode SET createdAt = ${new Date(Date.now() - 60 * 60_000)} WHERE id = ${episodeId}`;

    queueState.waiting.push(episodeId);
    await reapStaleRuns();
    assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: episodeId } })).status, "QUEUED");

    queueState.waiting.splice(queueState.waiting.indexOf(episodeId), 1);
    await reapStaleRuns();
    const reaped = await prisma.episode.findUniqueOrThrow({ where: { id: episodeId } });
    assert.deepEqual([reaped.status, reaped.step], ["FAILED", "Interrupted"]);
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("reaping an interrupted run gives its idea back, so the 'Start it again' the reaper tells the operator to do actually works", async () => {
  // A server restart mid-run used to leave the episode FAILED/"Interrupted"
  // but the idea's reservation in place forever — generating that idea again
  // then failed instantly with "This book already has an episode about …".
  const { book, upload, a } = await fixtureBook();
  try {
    const [{ episodeId }] = await createIdeaEpisodes(upload.id, [a.id], null);
    // What runEpisode does before writing the script: claim the angle.
    await reserveIdea(book.id, "idea-a");
    await prisma.$executeRaw`UPDATE Episode SET status = 'RUNNING', createdAt = ${new Date(Date.now() - 60 * 60_000)} WHERE id = ${episodeId}`;
    await assert.rejects(reserveIdea(book.id, "idea-a"), IdeaTakenError, "the claim is really held before the reap");

    // Nothing in this process is running it: exactly what a restart leaves.
    await reapStaleRuns();
    const reaped = await prisma.episode.findUniqueOrThrow({ where: { id: episodeId } });
    assert.deepEqual([reaped.status, reaped.step], ["FAILED", "Interrupted"]);

    assert.equal(await prisma.usedIdea.count({ where: { bookId: book.id, ideaKey: "idea-a" } }), 0, "the reservation was released");
    const retry = await createIdeaEpisodes(upload.id, [a.id], null);
    assert.equal(retry[0].created, true, "and the idea can be generated again");
    await reserveIdea(book.id, "idea-a"); // would throw IdeaTakenError if the claim had been left behind
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});

test("reaping leaves a live run's reservation alone", async () => {
  const { book, upload, a } = await fixtureBook();
  try {
    const [{ episodeId }] = await createIdeaEpisodes(upload.id, [a.id], null);
    await reserveIdea(book.id, "idea-a");
    await prisma.$executeRaw`UPDATE Episode SET status = 'RUNNING', createdAt = ${new Date(Date.now() - 60 * 60_000)} WHERE id = ${episodeId}`;
    queueState.current = episodeId; // this process is still running it
    try {
      await reapStaleRuns();
    } finally {
      queueState.current = null;
    }
    assert.equal((await prisma.episode.findUniqueOrThrow({ where: { id: episodeId } })).status, "RUNNING");
    assert.equal(await prisma.usedIdea.count({ where: { bookId: book.id, ideaKey: "idea-a" } }), 1, "a live run keeps its claim");
  } finally {
    await prisma.book.delete({ where: { id: book.id } });
  }
});
