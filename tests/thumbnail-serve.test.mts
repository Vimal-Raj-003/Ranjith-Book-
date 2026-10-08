import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../src/lib/db";
import { listEpisodes } from "../src/lib/episodes/list";
import { canSee, visibleTo } from "../src/lib/episodes/visibility";
import { serveThumbnail } from "../src/lib/thumbnails/serve";
import { serializeThumbnails, thumbsDir, type ThumbSpec } from "../src/lib/thumbnails";
import { gridDir } from "../src/lib/thumbnails/types";
import { requireIsolation } from "./setup/isolation";

/**
 * `serveThumbnail` is tested rather than the route handler, for the reason
 * `poster-edit.test.mts` gives: the route's other job is establishing who is
 * asking, which reads `cookies()` and cannot run outside a request.
 *
 * The bug these tests hold shut: the library LISTS an episode that has no owner
 * (`userId: null`), and its video is served, but the poster route looked the
 * episode up by `userId` alone, which never matches NULL -- so the card was
 * there and its poster answered 404. Measured on the operator's real library,
 * 8 of the 100 listed episodes (six of them on the first screen) showed an
 * initials tile for exactly that reason.
 */

const KEY = "9x16-quote";

interface Fixture {
  owner: { id: string };
  other: { id: string };
  owned: string;
  ownerless: string;
  foreign: string;
  cleanup: () => Promise<void>;
}

/** A 9:16 JPEG at the path `selectThumb` will accept, recorded on the episode row. */
async function poster(episodeId: string, opts: { garbage?: boolean } = {}): Promise<ThumbSpec> {
  // Fails closed: this writes a poster under the work root, and `seed` creates
  // User/Book/Upload/Episode rows. A bare `tsx --test` of this file does both
  // in the operator's live install (see `tests/setup/isolation.mts`).
  requireIsolation("these tests create episodes and write posters");
  const dir = thumbsDir(episodeId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${KEY}.jpg`);
  if (opts.garbage) await fs.writeFile(file, "this is not an image");
  else await sharp({ create: { width: 540, height: 960, channels: 3, background: "#204060" } }).jpeg().toFile(file);
  return { key: KEY, aspect: "9:16", variant: "quote", path: file, width: 540, height: 960, rev: 1 };
}

async function seed(): Promise<Fixture> {
  requireIsolation("these tests create episodes and write posters");
  const owner = await prisma.user.create({ data: { email: `owner-${randomUUID()}@example.test` } });
  const other = await prisma.user.create({ data: { email: `other-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({ data: { title: `Serve ${randomUUID()}`, rightsStatus: "in-copyright" } });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  const make = async (userId: string | null, title: string) => {
    const ep = await prisma.episode.create({ data: { bookId: book.id, uploadId: upload.id, userId, title, status: "DONE" } });
    await prisma.episode.update({ where: { id: ep.id }, data: { thumbnails: serializeThumbnails([await poster(ep.id)]) } });
    return ep.id;
  };
  const owned = await make(owner.id, "Owned");
  const ownerless = await make(null, "Ownerless");
  const foreign = await make(other.id, "Someone else's");

  return {
    owner,
    other,
    owned,
    ownerless,
    foreign,
    cleanup: async () => {
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
      for (const id of [owned, ownerless, foreign]) await fs.rm(thumbsDir(id), { recursive: true, force: true });
    },
  };
}

/** Read the body so the file handle is released (Windows will not delete an open file). */
const drain = async (res: Response) => Buffer.from(await res.arrayBuffer());

test("an episode with no owner has its poster served to a signed-in user", async () => {
  const f = await seed();
  try {
    for (const viewer of [f.owner.id, f.other.id]) {
      const full = await serveThumbnail(viewer, f.ownerless, KEY, null, null);
      assert.equal(full.status, 200, "the full-resolution poster, as the library's download link asks for it");
      assert.equal(full.headers.get("content-type"), "image/jpeg");
      assert.ok((await drain(full)).length > 0);

      const grid = await serveThumbnail(viewer, f.ownerless, KEY, "grid", null);
      assert.equal(grid.status, 200, "and the grid copy the library card paints");
      assert.equal(grid.headers.get("content-type"), "image/webp");
      assert.ok((await drain(grid)).length > 0);
    }
  } finally {
    await f.cleanup();
  }
});

test("a user's own episode is served, and another account's is still a 404", async () => {
  const f = await seed();
  try {
    const mine = await serveThumbnail(f.owner.id, f.owned, KEY, "grid", null);
    assert.equal(mine.status, 200);
    await drain(mine);

    // The half that must never regress: loosening the lookup to admit ownerless
    // episodes must not admit anyone else's.
    for (const size of [null, "grid"]) {
      const res = await serveThumbnail(f.owner.id, f.foreign, KEY, size, null);
      assert.equal(res.status, 404, `another account's poster (size=${size}) is not served`);
      assert.deepEqual(await res.json(), { error: "Not found" }, "and says nothing about it");
    }
    // ...and a refused request does no work: nothing was derived for it.
    await assert.rejects(fs.access(gridDir(f.foreign)), "no grid copy was made for an episode the viewer cannot see");

    // The same refusal from the other side.
    const theirs = await serveThumbnail(f.other.id, f.foreign, KEY, null, null);
    assert.equal(theirs.status, 200, "its own owner still gets it");
    await drain(theirs);
    assert.equal((await serveThumbnail(f.other.id, f.owned, KEY, null, null)).status, 404);
  } finally {
    await f.cleanup();
  }
});

test("a poster whose stored path is another install's is still served from this one", async () => {
  // 50 of this library's 115 postered episodes carry a `G:\YT-Book\...` path
  // from the copy of the app that wrote them, with all six files sitting in the
  // local thumbs directory. `selectThumb` derives the path, so the row's string
  // cannot refuse them -- and a hostile one cannot redirect them either.
  const f = await seed();
  try {
    for (const foreignPath of [
      "G:\\YT-Book\\.bookreel\\thumbs\\cmtelsewhere\\9x16-quote.jpg",
      "/etc/passwd",
      path.join(thumbsDir(f.owned), "..", `${KEY}.jpg`),
    ]) {
      await prisma.episode.update({
        where: { id: f.owned },
        data: {
          thumbnails: serializeThumbnails([
            { key: KEY, aspect: "9:16", variant: "quote", path: foreignPath, width: 540, height: 960, rev: 1 },
          ]),
        },
      });
      const res = await serveThumbnail(f.owner.id, f.owned, KEY, null, null);
      assert.equal(res.status, 200, `stored path ${foreignPath} must not stop the local poster being served`);
      assert.equal(res.headers.get("content-type"), "image/jpeg");
      assert.ok((await drain(res)).length > 0);
    }

    // A key the row does not list is still refused, derivable path or not.
    assert.equal((await serveThumbnail(f.owner.id, f.owned, "16x9-bold", null, null)).status, 404);
  } finally {
    await f.cleanup();
  }
});

test("a missing episode and a hostile key are both a 404", async () => {
  const f = await seed();
  try {
    assert.equal((await serveThumbnail(f.owner.id, "no-such-episode", KEY, null, null)).status, 404);
    for (const key of ["../../etc/passwd", "9x16-quote.jpg", "..%2F..%2Fx", "", "nope"]) {
      assert.equal((await serveThumbnail(f.owner.id, f.owned, key, null, null)).status, 404, `key ${JSON.stringify(key)}`);
    }
  } finally {
    await f.cleanup();
  }
});

test("the library never lists a poster that the poster route refuses", async () => {
  // The two routes drifted once, and the symptom was a card with no picture.
  // This ties them together for every viewer: whatever `listEpisodes` shows,
  // `serveThumbnail` serves, and what it does not show it does not serve.
  const f = await seed();
  try {
    for (const viewer of [f.owner.id, f.other.id]) {
      const listed = new Set((await listEpisodes(viewer)).filter((e) => e.thumbnails.length > 0).map((e) => e.id));
      for (const id of [f.owned, f.ownerless, f.foreign]) {
        const res = await serveThumbnail(viewer, id, KEY, "grid", null);
        await drain(res);
        assert.equal(res.status === 200, listed.has(id), `viewer ${viewer.slice(-4)}, episode ${id.slice(-4)}: listed=${listed.has(id)} served=${res.status}`);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("visibleTo is the viewer's own episodes and the ones nobody owns, never another account's", async () => {
  assert.deepEqual(visibleTo("u1"), { OR: [{ userId: "u1" }, { userId: null }] });
  const f = await seed();
  try {
    const seen = async (viewer: string) => (await prisma.episode.findMany({ where: visibleTo(viewer), select: { id: true } })).map((e) => e.id).sort();
    assert.deepEqual(await seen(f.owner.id), [f.owned, f.ownerless].sort());
    assert.deepEqual(await seen(f.other.id), [f.foreign, f.ownerless].sort());
  } finally {
    await f.cleanup();
  }
});

test("canSee answers for a fetched row exactly as visibleTo answers for a query", async () => {
  // The four routes that could not use `visibleTo` (they need `findUnique`, so
  // that "no such episode" and "not yours" are not the same answer) hand-rolled
  // `episode.userId && episode.userId !== user.id` instead. Four copies of a
  // rule is how the poster bug happened, so this holds the predicate and the
  // query together on the same rows.
  assert.equal(canSee({ userId: "u1" }, "u1"), true, "the viewer's own");
  assert.equal(canSee({ userId: null }, "u1"), true, "nobody's");
  assert.equal(canSee({ userId: "u2" }, "u1"), false, "someone else's");
  // Null is "may not see it", so `canSee(await findUnique(...), id)` is safe.
  assert.equal(canSee(null, "u1"), false);
  assert.equal(canSee(undefined, "u1"), false);

  const f = await seed();
  try {
    for (const viewer of [f.owner.id, f.other.id]) {
      const queried = new Set(
        (await prisma.episode.findMany({ where: visibleTo(viewer), select: { id: true } })).map((e) => e.id),
      );
      for (const id of [f.owned, f.ownerless, f.foreign]) {
        const row = await prisma.episode.findUnique({ where: { id }, select: { userId: true } });
        assert.equal(canSee(row, viewer), queried.has(id), `viewer ${viewer.slice(-4)}, episode ${id.slice(-4)}`);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("the headers the browser's cache depends on survive the move out of the route", async () => {
  const f = await seed();
  try {
    for (const [size, type] of [["grid", "image/webp"], [null, "image/jpeg"]] as const) {
      const res = await serveThumbnail(f.owner.id, f.owned, KEY, size, null);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), type);
      assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(res.headers.get("content-disposition"), `inline; filename="${KEY}.${size ? "webp" : "jpg"}"`);
      const etag = res.headers.get("etag");
      assert.match(etag ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);
      assert.equal(res.headers.get("content-length"), String((await drain(res)).length));

      const again = await serveThumbnail(f.owner.id, f.owned, KEY, size, etag);
      assert.equal(again.status, 304, "an unchanged poster is revalidated without its body");
      assert.equal((await drain(again)).length, 0);
      assert.equal(again.headers.get("etag"), etag);
    }
  } finally {
    await f.cleanup();
  }
});

test("a grid request whose derivation fails serves the original, and is not cached as final", async () => {
  // Acceptance criterion 9, at the layer that decides it: sharp cannot read the
  // file, so there is no grid copy -- and the answer is the poster as it is,
  // not an error and not a broken image. It must be allowed to try again.
  const f = await seed();
  try {
    await poster(f.owned, { garbage: true });
    const res = await serveThumbnail(f.owner.id, f.owned, KEY, "grid", null);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("cache-control"), "private, no-cache");
    assert.equal((await drain(res)).toString(), "this is not an image");
  } finally {
    await f.cleanup();
  }
});
