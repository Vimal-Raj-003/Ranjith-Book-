import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { prisma } from "../src/lib/db";
import { WORK_ROOT } from "../src/lib/paths";
import { editPoster } from "../src/lib/episodes/poster";
import { listEpisodes } from "../src/lib/episodes/list";
import { posterFields } from "../src/lib/episode-view";
import { generateThumbnails, parseThumbnails, serializeThumbnails, thumbsDir, type ThumbSpec } from "../src/lib/thumbnails";
import { gridDir, THUMB_KEYS } from "../src/lib/thumbnails/types";

/**
 * `editPoster` is tested rather than the route handler, for the reason
 * `episodes-api.test.mts` gives: the route's other job is establishing who is
 * asking, which reads `cookies()` and cannot run outside a request.
 */

const chromiumAvailable = await chromium
  .launch()
  .then((b) => b.close())
  .then(() => true)
  .catch(() => false);
const needsChromium = { skip: chromiumAvailable ? false : "chromium is not available here" };

const BEATS = [
  { id: "hook", voiceover: "v", onScreen: "Busy is not focused", sourcePage: 0, startWord: 0, endWord: 3 },
  { id: "idea-1", voiceover: "v", onScreen: "Depth is rare", sourcePage: 1, startWord: 0, endWord: 3 },
];

interface Seed {
  userId: string;
  episodeId: string;
  cleanup: () => Promise<void>;
}

/**
 * A finished episode: a book, an upload with real page images on disk, the
 * script and plan the pipeline stores, and six posters recorded on the row.
 * `withPages: false` is an old episode whose work directory was cleaned up.
 */
async function seed(opts: { withPages?: boolean; real?: boolean; row?: Record<string, unknown> } = {}): Promise<Seed> {
  const { withPages = true, real = false, row = {} } = opts;
  const user = await prisma.user.create({ data: { email: `poster-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({ data: { title: `Poster ${randomUUID()}`, rightsStatus: "in-copyright" } });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  const pagesDir = path.join(WORK_ROOT, "poster-edit-test", randomUUID());
  await fs.mkdir(pagesDir, { recursive: true });
  for (const pageIndex of [0, 1]) {
    const file = path.join(pagesDir, `page-${pageIndex}.jpg`);
    if (withPages) await sharp({ create: { width: 800, height: 1200, channels: 3, background: "#d8cfb8" } }).jpeg().toFile(file);
    await prisma.page.create({
      data: { uploadId: upload.id, pageIndex, filePath: file, derivedPath: file, width: 800, height: 1200 },
    });
  }

  const episode = await prisma.episode.create({
    data: {
      bookId: book.id,
      uploadId: upload.id,
      userId: user.id,
      status: "DONE",
      theme: "marginalia",
      title: "Deep Work",
      hook: "Most people are busy. Almost nobody is focused.",
      cta: "Follow for one page a day",
      script: JSON.stringify(BEATS),
      visualPlan: JSON.stringify({
        startPage: 0,
        endPage: 1,
        startWord: 0,
        endWord: 0,
        sweeps: [[{ box: { x0: 40, y0: 100, x1: 700, y1: 160 }, start: 0, end: 1 }], []],
        camera: [],
      }),
      ...row,
    },
  });

  // Six posters on the row. Fake files by default (the choice paths never read
  // them); real ones when the test is about what a redo does to them.
  const dir = thumbsDir(episode.id);
  await fs.mkdir(dir, { recursive: true });
  let specs: ThumbSpec[];
  if (real) {
    // Built from the same inputs a redo reassembles from the row (same
    // photograph, same focus, same theme, no keywords or takeaway), so that a
    // redo with no override reproduces these bytes exactly.
    specs = await generateThumbnails({
      episodeId: episode.id,
      pkg: { title: "Deep Work", hook: "Most people are busy. Almost nobody is focused.", cta: "Follow for one page a day", beats: BEATS },
      pages: [0, 1].map((i) => ({ src: path.join(pagesDir, `page-${i}.jpg`), width: 800, height: 1200 })),
      focus: { pageIndex: 0, x0: 40, y0: 100, x1: 700, y1: 160 },
      theme: "marginalia",
      outDir: dir,
    });
    assert.equal(specs.length, 6, "the fixture renders all six posters");
  } else {
    specs = THUMB_KEYS.map((key) => ({
      key,
      aspect: key.startsWith("9x16") ? ("9:16" as const) : ("16:9" as const),
      variant: key.split("-")[1] as ThumbSpec["variant"],
      path: path.join(dir, `${key}.jpg`),
      width: key.startsWith("9x16") ? 1080 : 1280,
      height: key.startsWith("9x16") ? 1920 : 720,
      rev: 111,
    }));
    for (const s of specs) await fs.writeFile(s.path, "old poster");
  }
  await prisma.episode.update({ where: { id: episode.id }, data: { thumbnails: serializeThumbnails(specs) } });

  return {
    userId: user.id,
    episodeId: episode.id,
    cleanup: async () => {
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(pagesDir, { recursive: true, force: true });
    },
  };
}

const row = (id: string) => prisma.episode.findUniqueOrThrow({ where: { id } });

test("choosing a poster records the choice and renders nothing", async () => {
  const s = await seed();
  try {
    const before = await row(s.episodeId);
    const res = await editPoster(s.userId, s.episodeId, { choice: "16x9-bold" });
    assert.equal(res.status, 200);
    assert.equal(res.body.thumbChoice, "16x9-bold");

    const after = await row(s.episodeId);
    assert.equal(after.thumbChoice, "16x9-bold");
    assert.equal(after.thumbnails, before.thumbnails, "no poster was touched");
    assert.equal(after.thumbHeadline, null);
    assert.equal(await fs.readFile(path.join(thumbsDir(s.episodeId), "9x16-quote.jpg"), "utf8"), "old poster");
  } finally {
    await s.cleanup();
  }
});

test("a choice that is not a poster on this episode is refused and nothing is written", async () => {
  const s = await seed();
  try {
    for (const choice of ["9x16-deleted", "../../etc/passwd", "", 42, null, ["9x16-quote"]]) {
      const res = await editPoster(s.userId, s.episodeId, { choice });
      assert.equal(res.status, 400, JSON.stringify(choice));
      assert.equal(res.body.code, "bad_choice");
    }
    assert.equal((await row(s.episodeId)).thumbChoice, null);
  } finally {
    await s.cleanup();
  }
});

test("a request that is not a JSON object is refused", async () => {
  const s = await seed();
  try {
    for (const body of [null, undefined, "x", 5, [], true]) {
      const res = await editPoster(s.userId, s.episodeId, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, "bad_body");
    }
  } finally {
    await s.cleanup();
  }
});

test("another account's episode is a 404, and nothing is written", async () => {
  const s = await seed();
  const stranger = await prisma.user.create({ data: { email: `stranger-${randomUUID()}@example.test` } });
  try {
    const res = await editPoster(stranger.id, s.episodeId, { choice: "9x16-bold" });
    assert.equal(res.status, 404);
    assert.equal((await row(s.episodeId)).thumbChoice, null);
    assert.equal((await editPoster(s.userId, "no-such-episode", { choice: "9x16-bold" })).status, 404);
  } finally {
    await prisma.user.delete({ where: { id: stranger.id } });
    await s.cleanup();
  }
});

test("a bad choice alongside a headline refuses the whole request, not half of it", async () => {
  const s = await seed();
  let renders = 0;
  try {
    const res = await editPoster(
      s.userId,
      s.episodeId,
      { choice: "9x16-deleted", headline: "Compounding beats talent" },
      {
        render: async () => {
          renders++;
          return [];
        },
      },
    );
    assert.equal(res.status, 400);
    assert.equal(renders, 0, "nothing was rendered for a request that was going to be refused");
    assert.equal((await row(s.episodeId)).thumbHeadline, null);
  } finally {
    await s.cleanup();
  }
});

test("an episode whose page images are gone cannot be retitled, and is left exactly as it was", async () => {
  const s = await seed({ withPages: false });
  let renders = 0;
  try {
    const before = await row(s.episodeId);
    const res = await editPoster(
      s.userId,
      s.episodeId,
      { headline: "Compounding beats talent" },
      {
        render: async () => {
          renders++;
          return [];
        },
      },
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "no_source");
    assert.equal(renders, 0, "no poster is drawn without its photograph");

    const after = await row(s.episodeId);
    assert.equal(after.thumbnails, before.thumbnails);
    assert.equal(after.thumbHeadline, null);
  } finally {
    await s.cleanup();
  }
});

test("an episode with no script cannot be retitled either", async () => {
  const s = await seed({ row: { script: null } });
  try {
    const res = await editPoster(s.userId, s.episodeId, { headline: "Compounding beats talent" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "no_source");
  } finally {
    await s.cleanup();
  }
});

test("a render that produces nothing is an error and changes nothing", async () => {
  const s = await seed();
  try {
    const before = await row(s.episodeId);
    for (const render of [async () => [], async () => Promise.reject(new Error("boom"))]) {
      const res = await editPoster(s.userId, s.episodeId, { headline: "Compounding beats talent" }, { render });
      assert.equal(res.status, 500);
      assert.equal(res.body.code, "render_failed");
    }
    const after = await row(s.episodeId);
    assert.equal(after.thumbnails, before.thumbnails);
    assert.equal(after.thumbHeadline, null);
  } finally {
    await s.cleanup();
  }
});

test("a partial render keeps only posters that carry the new headline", async () => {
  // Episode.thumbHeadline is one value. A poster left over from before the
  // retitle would contradict it, so it is dropped rather than kept stale.
  const s = await seed();
  try {
    const res = await editPoster(
      s.userId,
      s.episodeId,
      { headline: "Compounding beats talent" },
      {
        render: async ({ outDir }) =>
          THUMB_KEYS.slice(0, 4).map((key) => ({
            key,
            aspect: key.startsWith("9x16") ? ("9:16" as const) : ("16:9" as const),
            variant: key.split("-")[1] as ThumbSpec["variant"],
            path: path.join(outDir, `${key}.jpg`),
            width: 1080,
            height: 1920,
            rev: 222,
          })),
      },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.failed, 2);
    const stored = parseThumbnails(await row(s.episodeId));
    assert.deepEqual(stored.map((t) => t.key), THUMB_KEYS.slice(0, 4));
    assert.ok(stored.every((t) => t.rev === 222));
    assert.equal((await row(s.episodeId)).thumbHeadline, "Compounding beats talent");
  } finally {
    await s.cleanup();
  }
});

test("a retitle redraws all six posters, busts the grid cache, and a reset restores the originals", needsChromium, async () => {
  const s = await seed({ real: true });
  try {
    const original = parseThumbnails(await row(s.episodeId));
    const originalBytes = await Promise.all(original.map((t) => fs.readFile(t.path)));

    // A stale grid derivative for a poster that is about to be redone.
    await fs.mkdir(gridDir(s.episodeId), { recursive: true });
    await fs.writeFile(path.join(gridDir(s.episodeId), "9x16-quote.webp"), "stale derivative");

    await new Promise((r) => setTimeout(r, 25)); // distinct mtimes even on a coarse clock
    const res = await editPoster(s.userId, s.episodeId, { choice: "9x16-bold", headline: "  Compounding beats talent  " });
    assert.equal(res.status, 200);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.thumbHeadline, "Compounding beats talent", "stored trimmed");
    assert.equal(res.body.thumbChoice, "9x16-bold");

    const redone = parseThumbnails(await row(s.episodeId));
    assert.deepEqual(redone.map((t) => t.key), original.map((t) => t.key), "all six, in the same order");
    const redoneBytes = await Promise.all(redone.map((t) => fs.readFile(t.path)));
    redone.forEach((t, i) => {
      assert.ok(t.rev > original[i].rev, `${t.key} has a newer revision, so a new URL`);
      assert.ok(!redoneBytes[i].equals(originalBytes[i]), `${t.key} was redrawn`);
    });
    await assert.rejects(fs.access(path.join(gridDir(s.episodeId), "9x16-quote.webp")), "the stale derivative is gone");

    // The public answer carries the revisions the browser will build URLs from.
    const wire = res.body.thumbnails as { key: string; rev: number }[];
    assert.deepEqual(wire.map((t) => [t.key, t.rev]), redone.map((t) => [t.key, t.rev]));

    // Reset: an empty headline means "the generated one", and says so.
    await new Promise((r) => setTimeout(r, 25));
    const reset = await editPoster(s.userId, s.episodeId, { headline: "   " });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.thumbHeadline, null);
    assert.equal((await row(s.episodeId)).thumbHeadline, null);
    const resetSpecs = parseThumbnails(await row(s.episodeId));
    const resetBytes = await Promise.all(resetSpecs.map((t) => fs.readFile(t.path)));
    resetSpecs.forEach((t, i) => assert.ok(resetBytes[i].equals(originalBytes[i]), `${t.key} is back to the generated headline`));
  } finally {
    await s.cleanup();
  }
});

test("an empty string in either column reads as no value, exactly like null", async () => {
  // Hand-edited rows and older writers can leave "" where NULL is the default.
  assert.deepEqual(posterFields({ thumbChoice: "", thumbHeadline: "" }), { thumbChoice: null, thumbHeadline: null });
  assert.deepEqual(posterFields({ thumbChoice: null, thumbHeadline: undefined }), { thumbChoice: null, thumbHeadline: null });
  assert.deepEqual(posterFields({ thumbChoice: "9x16-bold", thumbHeadline: "Hi" }), { thumbChoice: "9x16-bold", thumbHeadline: "Hi" });

  const s = await seed({ row: { thumbChoice: "", thumbHeadline: "" } });
  try {
    const mine = (await listEpisodes(s.userId)).find((e) => e.id === s.episodeId);
    assert.ok(mine);
    assert.equal(mine.thumbChoice, null);
    assert.equal(mine.thumbHeadline, null);
    assert.equal(mine.thumbnails.length, 6);
    assert.ok(mine.thumbnails.every((t) => t.rev === 111), "the listing carries each poster's revision");

    const noop = await editPoster(s.userId, s.episodeId, {});
    assert.equal(noop.status, 200);
    assert.equal(noop.body.thumbChoice, null);
    assert.equal(noop.body.thumbHeadline, null);
  } finally {
    await s.cleanup();
  }
});
