import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { prisma } from "../src/lib/db";
import { WORK_ROOT, uploadDir } from "../src/lib/paths";
import { COVER_SIZES, COVER_WIDTH, coverUrl, parseCoverSize, type CoverSize } from "../src/lib/covers/sizes";
import {
  clearCover,
  coverDir,
  coverFailed,
  coverFile,
  deriveCover,
  isWebp,
} from "../src/lib/covers/derive";
import { coverState, locateSource } from "../src/lib/covers/status";
import { regenerateCover, serveCover } from "../src/lib/covers/serve";
import { BookCover } from "../src/components/BookCover";
import type { AnalysisSummary } from "../src/components/types";
import { strings } from "../src/lib/strings";
import { requireIsolation } from "./setup/isolation";

/**
 * Book covers: page 0 of an upload, downscaled to three sizes and cached under
 * `WORK_ROOT/covers/<uploadId>/<size>.webp`.
 *
 * `serveCover` and `regenerateCover` are tested rather than the route handlers,
 * for the reason `thumbnail-serve.test.mts` gives: the route's other job is
 * `requireUser()`, which reads `cookies()` and cannot run outside a request.
 *
 * Every test here writes under the work root and most create Book / Upload /
 * Page / User rows, so the whole file fails closed unless `npm test` has given
 * this process its own database and work root (see `tests/setup/isolation.ts`).
 */
test.before(() => {
  requireIsolation("these tests create books, uploads and pages, and write covers under the work root");
});

const FIXTURES = path.join(WORK_ROOT, "covers-test-src");

const drain = async (res: Response) => Buffer.from(await res.arrayBuffer());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real JPEG. `busy` adds noise so the file is as heavy as a scanned page, not a flat colour. */
async function jpeg(file: string, width: number, height: number, color = "#204060", busy = false): Promise<string> {
  requireIsolation("these tests write fixture page images under the work root");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
      ...(busy ? { noise: { type: "gaussian" as const, mean: 128, sigma: 40 } } : {}),
    },
  })
    .jpeg({ quality: 85 })
    .toFile(file);
  return file;
}

/**
 * Read by BYTES, never by path: on Windows libvips keeps a path-opened file
 * mapped, and a mapped file cannot be deleted (EBUSY) by the cleanup that
 * follows. `derive.ts` reads into memory for the same reason.
 */
const bytesOf = async (input: string | Buffer) => (typeof input === "string" ? fs.readFile(input) : input);

async function dims(fileOrBuffer: string | Buffer) {
  const m = await sharp(await bytesOf(fileOrBuffer)).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0, format: m.format };
}

/** The average colour of an image, to tell WHICH page a cover was made from. */
async function dominant(input: Buffer | string): Promise<{ r: number; g: number; b: number }> {
  const { dominant } = await sharp(await bytesOf(input)).stats();
  return dominant;
}

/**
 * Every size, one at a time, as the three sizes of one cover. `deriveCover` makes
 * only the size it is asked for (see its doc); tests about the shape of a whole
 * cover ask for all three.
 */
async function deriveAll(id: string, source: string): Promise<Record<CoverSize, string | null>> {
  const out = { small: null, medium: null, large: null } as Record<CoverSize, string | null>;
  for (const size of COVER_SIZES) out[size] = await deriveCover(id, source, size);
  return out;
}

let seq = 0;
const freshId = (tag: string) => `cover-${tag}-${process.pid}-${seq++}`;

async function cleanIds(...ids: string[]) {
  for (const id of ids) await fs.rm(coverDir(id), { recursive: true, force: true });
}

test.after(async () => {
  await fs.rm(FIXTURES, { recursive: true, force: true });
});

// --------------------------------------------------------------------- sizes

test("parseCoverSize accepts exactly three literals and treats everything else as absent", () => {
  for (const size of COVER_SIZES) assert.equal(parseCoverSize(size), size);
  assert.deepEqual([...COVER_SIZES], ["small", "medium", "large"]);

  for (const hostile of [null, undefined, "", " small", "SMALL", "Small", "full", "grid", "small ", "../../etc/passwd", "small/../large", "medium\0", ["small"], ["small", "large"], 160, {}]) {
    assert.equal(parseCoverSize(hostile), null, `${JSON.stringify(hostile)} is not a size`);
  }

  // Things that only LOOK like a literal once something coerces them. An
  // implementation that stringified its input (`String(raw)`, `` `${raw}` ``,
  // `==`) would accept every one of these, and a value that is merely
  // string-like is exactly what must never reach a path join.
  const lookalikes: unknown[] = [
    new String("small"),
    { toString: () => "small" },
    { valueOf: () => "large" },
    [["medium"]],
    Object.assign(Object.create(null), { toString: () => "small" }),
  ];
  for (const raw of lookalikes) assert.equal(parseCoverSize(raw), null, "a string-like object is not a size");
});

test("the three widths are 160, 360 and 720", () => {
  assert.deepEqual(COVER_WIDTH, { small: 160, medium: 360, large: 720 });
});

test("a cover URL names the upload, the size and the revision that busts the cache", () => {
  assert.equal(coverUrl("abc123", "small", 1700000000000), "/api/uploads/abc123/cover?size=small&v=1700000000000");
  assert.notEqual(coverUrl("abc123", "small", 1), coverUrl("abc123", "small", 2), "a new revision is a new URL");
  assert.match(coverUrl("a/b", "large", 1), /^\/api\/uploads\/a%2Fb\/cover/, "an id is encoded, never trusted as a path");
  assert.match(coverUrl("abc", "small", Number.NaN), /v=0$/, "a revision that is not a number reads as 0");
  assert.match(coverUrl("abc", "small", -5), /v=0$/);
});

test("the client-safe size module has no imports of its own", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../src/lib/covers/sizes.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(
    source,
    /^\s*(import|export\s[^;]*\sfrom)\s/m,
    "sizes.ts must stay free of imports: BookCover loads it in the browser, and a path to sharp or Prisma there 500s every route",
  );
});

// -------------------------------------------------------------------- isWebp

test("isWebp accepts a real WebP and rejects everything that is merely RIFF-shaped", async () => {
  const dir = path.join(FIXTURES, "iswebp");
  await fs.mkdir(dir, { recursive: true });
  const good = path.join(dir, "good.webp");
  await sharp({ create: { width: 40, height: 60, channels: 3, background: "#aa5500" } }).webp().toFile(good);
  assert.equal(await isWebp(good), true);

  const bytes = await fs.readFile(good);
  const put = async (name: string, data: Buffer | string) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, data);
    return p;
  };

  assert.equal(await isWebp(await put("empty.webp", "")), false, "empty");
  assert.equal(await isWebp(await put("text.webp", "this is not an image at all, just words")), false, "text");
  assert.equal(await isWebp(await put("truncated.webp", bytes.subarray(0, Math.floor(bytes.length / 2)))), false, "a half-written file keeps its header and loses its tail");
  assert.equal(await isWebp(await put("header-only.webp", bytes.subarray(0, 12))), false, "twelve bytes is a header, not an image");

  const wave = Buffer.alloc(bytes.length);
  wave.write("RIFF", 0, "ascii");
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVE", 8, "ascii");
  assert.equal(await isWebp(await put("wave.webp", wave)), false, "a WAV is RIFF too");

  const jpg = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  assert.equal(await isWebp(await put("jpeg.webp", jpg)), false, "a JPEG with the wrong extension");

  assert.equal(await isWebp(path.join(dir, "absent.webp")), false, "a missing file is 'no', not an error");
});

// ------------------------------------------------------------------- derive

test("a cover is derived at three widths into the upload's own directory", async () => {
  const id = freshId("sizes");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 1067, 1600, "#204060", true);
  try {
    const out = await deriveAll(id, src);
    for (const size of COVER_SIZES) {
      assert.equal(out[size], coverFile(id, size), `${size} is at the documented path`);
      assert.equal(out[size], path.join(WORK_ROOT, "covers", id, `${size}.webp`));
      const d = await dims(out[size]!);
      assert.equal(d.format, "webp");
      assert.equal(d.width, COVER_WIDTH[size], `${size} is ${COVER_WIDTH[size]}px wide`);
      // Aspect preserved: 1067x1600 is 0.6669; allow a pixel of rounding.
      assert.ok(Math.abs(d.height - COVER_WIDTH[size] * (1600 / 1067)) <= 1.5, `${size} keeps the page's aspect (${d.width}x${d.height})`);
      assert.equal(await isWebp(out[size]!), true);
    }
  } finally {
    await cleanIds(id);
  }
});

test("a cover is never enlarged, and a very tall page is capped on its long edge", async () => {
  const idSmall = freshId("tiny");
  const idStrip = freshId("strip");
  const tiny = await jpeg(path.join(FIXTURES, idSmall, "page.jpg"), 100, 150);
  const strip = await jpeg(path.join(FIXTURES, idStrip, "page.jpg"), 400, 4000);
  try {
    const small = await deriveAll(idSmall, tiny);
    for (const size of COVER_SIZES) {
      assert.deepEqual(await dims(small[size]!), { width: 100, height: 150, format: "webp" }, `${size}: a 100px page is not stretched to fill the box`);
    }

    const tall = await deriveAll(idStrip, strip);
    for (const size of COVER_SIZES) {
      const d = await dims(tall[size]!);
      assert.ok(d.height <= COVER_WIDTH[size] * 2, `${size}: the long edge is capped at twice the nominal width (got ${d.height})`);
      assert.ok(Math.abs(d.width / d.height - 400 / 4000) < 0.01, `${size}: the aspect survives the cap`);
    }
  } finally {
    await cleanIds(idSmall, idStrip);
  }
});

test("a derived cover is a small fraction of the page it came from", async () => {
  const id = freshId("weight");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 1131, 1600, "#204060", true);
  try {
    const out = await deriveAll(id, src);
    const source = (await fs.stat(src)).size;
    const small = (await fs.stat(out.small!)).size;
    const medium = (await fs.stat(out.medium!)).size;
    const large = (await fs.stat(out.large!)).size;
    assert.ok(small < medium && medium < large, `sizes grow: ${small} < ${medium} < ${large}`);
    assert.ok(small < source / 5, `the card cover (${small} B) is a fraction of the page (${source} B)`);
  } finally {
    await cleanIds(id);
  }
});

test("a cover is derived once: a second call reuses the files and rewrites nothing", async () => {
  const id = freshId("cache");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 800, 1200);
  try {
    const first = await deriveAll(id, src);
    const before = await Promise.all(COVER_SIZES.map(async (s) => (await fs.stat(first[s]!)).mtimeMs));
    await sleep(25);
    const second = await deriveAll(id, src);
    const after = await Promise.all(COVER_SIZES.map(async (s) => (await fs.stat(second[s]!)).mtimeMs));
    assert.deepEqual(after, before, "no file was rewritten");
    assert.deepEqual(second, first);
  } finally {
    await cleanIds(id);
  }
});

test("a page that is re-rendered (newer than its cover) is re-derived, not served stale", async () => {
  const id = freshId("stale");
  const file = path.join(FIXTURES, id, "page.jpg");
  await jpeg(file, 800, 1200, "#ff0000");
  try {
    const first = await deriveAll(id, file);
    const red = await dominant(first.small!);
    assert.ok(red.r > 200 && red.b < 80, "the first cover is red");

    await sleep(30);
    await jpeg(file, 400, 600, "#0000ff");
    const second = await deriveAll(id, file);
    const blue = await dominant(second.small!);
    assert.ok(blue.b > 200 && blue.r < 80, "the cover now shows the new page");
    assert.deepEqual(await dims(second.small!), { width: 160, height: 240, format: "webp" });
  } finally {
    await cleanIds(id);
  }
});

test("a corrupt, truncated or empty cached cover heals itself on the next request", async () => {
  const id = freshId("heal");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 800, 1200);
  try {
    const first = await deriveAll(id, src);
    const good = await fs.readFile(first.medium!);

    for (const [label, damage] of [
      ["garbage", Buffer.from("definitely not an image, but long enough to pass a size check ".repeat(40))],
      ["truncated", good.subarray(0, Math.floor(good.length / 2))],
      ["empty", Buffer.alloc(0)],
    ] as const) {
      // Written AFTER the source, so mtime alone says it is fresh: only
      // looking at the bytes can catch it.
      await sleep(15);
      await fs.writeFile(first.medium!, damage);
      assert.equal(await isWebp(first.medium!), false, `${label} setup`);
      const healed = await deriveAll(id, src);
      assert.equal(healed.medium, first.medium, `${label}: the path is the same`);
      assert.equal(await isWebp(healed.medium!), true, `${label}: it is whole again`);
      assert.equal((await dims(healed.medium!)).width, 360, `${label}: and is a real medium cover`);
    }
  } finally {
    await cleanIds(id);
  }
});

test("a missing page gives no cover, no throw, and leaves nothing on disk", async () => {
  const id = freshId("missing");
  const out = await deriveAll(id, path.join(FIXTURES, id, "gone.jpg"));
  assert.deepEqual(out, { small: null, medium: null, large: null });
  await assert.rejects(fs.access(coverDir(id)), "a request that could not succeed created no directory");
  assert.equal(await coverFailed(id, path.join(FIXTURES, id, "gone.jpg")), false, "there is no marker either: the status derives 'failed' from the missing file");
});

test("an unreadable image gives no cover, leaves no temp file, and is remembered as failed until the page changes", async () => {
  const id = freshId("corrupt");
  const file = path.join(FIXTURES, id, "page.jpg");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "this is a text file wearing a .jpg extension");
  try {
    const out = await deriveAll(id, file);
    assert.deepEqual(out, { small: null, medium: null, large: null });
    const left = (await fs.readdir(coverDir(id)).catch(() => [])).filter((n) => n.includes(".part"));
    assert.deepEqual(left, [], "no half-written file was left beside the covers");
    assert.equal(await coverFailed(id, file), true);

    await sleep(30);
    await jpeg(file, 600, 900);
    assert.equal(await coverFailed(id, file), false, "a replaced page is a fresh chance");
    const again = await deriveAll(id, file);
    assert.equal(await isWebp(again.small!), true);
    assert.equal(await coverFailed(id, file), false, "and success clears the marker");
  } finally {
    await cleanIds(id);
  }
});

test("simultaneous requests all get whole files, and no temp file survives", async () => {
  const id = freshId("race");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 1131, 1600, "#204060", true);
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => deriveAll(id, src)));
    for (const r of results) {
      for (const size of COVER_SIZES) assert.equal(r[size], coverFile(id, size));
    }
    for (const size of COVER_SIZES) assert.equal(await isWebp(coverFile(id, size)), true, `${size} is whole`);
    const left = (await fs.readdir(coverDir(id))).filter((n) => n.includes(".part"));
    assert.deepEqual(left, []);
  } finally {
    await cleanIds(id);
  }
});

test("only the size asked for is made, and asking for another leaves the first alone", async () => {
  const id = freshId("demand");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 1131, 1600, "#204060", true);
  try {
    const small = await deriveCover(id, src, "small");
    assert.equal(small, coverFile(id, "small"));
    assert.deepEqual(await fs.readdir(coverDir(id)), ["small.webp"], "no medium, no large: nothing asked for them");

    const made = (await fs.stat(small!)).mtimeMs;
    await sleep(25);
    const large = await deriveCover(id, src, "large");
    assert.equal(large, coverFile(id, "large"));
    assert.deepEqual((await fs.readdir(coverDir(id))).sort(), ["large.webp", "small.webp"]);
    assert.equal((await fs.stat(small!)).mtimeMs, made, "and the one that was already there was not rewritten");

    // A size that is not one of the three is refused outright, whatever the type says.
    assert.equal(await deriveCover(id, src, "../../x" as CoverSize), null);
    assert.equal(await deriveCover(id, src, "huge" as CoverSize), null);
  } finally {
    await cleanIds(id);
  }
});

test("clearCover removes the cached files so the next call derives them again", async () => {
  const id = freshId("clear");
  const src = await jpeg(path.join(FIXTURES, id, "page.jpg"), 800, 1200);
  try {
    const first = await deriveAll(id, src);
    const born = (await fs.stat(first.small!)).mtimeMs;
    await clearCover(id);
    await assert.rejects(fs.access(coverFile(id, "small")), "the cache is gone");

    await sleep(25);
    const second = await deriveAll(id, src);
    assert.ok((await fs.stat(second.small!)).mtimeMs > born, "it was derived afresh");

    await clearCover(freshId("never-existed"));
  } finally {
    await cleanIds(id);
  }
});

test("an id that is not a plain id never reaches the filesystem", async () => {
  const src = await jpeg(path.join(FIXTURES, "unsafe", "page.jpg"), 300, 400);
  const sentinel = path.join(WORK_ROOT, "covers-sentinel.txt");
  await fs.writeFile(sentinel, "keep me");
  try {
    for (const bad of ["..", "../x", "a/b", "a\\b", "", "x\0y"]) {
      assert.deepEqual(await deriveAll(bad, src), { small: null, medium: null, large: null }, `derive refuses ${JSON.stringify(bad)}`);
      await clearCover(bad); // must not throw and must not delete anything
    }
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep me");
    await assert.rejects(fs.access(path.join(WORK_ROOT, "x")), "nothing was made outside the covers directory");
  } finally {
    await fs.rm(sentinel, { force: true });
  }
});

// ------------------------------------------------------------ DB-backed state

interface Seeded {
  owner: { id: string };
  other: { id: string };
  bookId: string;
  /** Make an upload (kind pdf) with the given pages; each page's image is written under its own upload dir. */
  upload: (
    userId: string | null,
    pages: { pageIndex: number; color?: string; derived?: "same" | "missing" | "none"; width?: number; height?: number }[],
  ) => Promise<{ id: string; pageFile: (pageIndex: number) => string }>;
  cleanup: () => Promise<void>;
}

async function seed(): Promise<Seeded> {
  requireIsolation("these tests create books, uploads and pages, and write covers under the work root");
  const owner = await prisma.user.create({ data: { email: `owner-${randomUUID()}@example.test` } });
  const other = await prisma.user.create({ data: { email: `other-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({ data: { title: `Cover ${randomUUID()}`, rightsStatus: "in-copyright" } });
  const made: string[] = [];

  return {
    owner,
    other,
    bookId: book.id,
    upload: async (userId, pages) => {
      const up = await prisma.upload.create({ data: { bookId: book.id, userId, kind: "pdf", status: "DONE", pageCount: pages.length } });
      made.push(up.id);
      const pageFile = (i: number) => path.join(uploadDir(up.id), "pages", `page-${String(i).padStart(4, "0")}.jpg`);
      for (const p of pages) {
        const w = p.width ?? 800;
        const h = p.height ?? 1200;
        const file = await jpeg(pageFile(p.pageIndex), w, h, p.color ?? "#204060");
        const derivedPath =
          p.derived === "none" ? null : p.derived === "missing" ? path.join(uploadDir(up.id), "pages", "no-such-file.jpg") : file;
        await prisma.page.create({ data: { uploadId: up.id, pageIndex: p.pageIndex, filePath: file, derivedPath, width: w, height: h } });
      }
      return { id: up.id, pageFile };
    },
    cleanup: async () => {
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
      for (const id of made) {
        await fs.rm(coverDir(id), { recursive: true, force: true });
        await fs.rm(uploadDir(id), { recursive: true, force: true });
      }
    },
  };
}

async function pageOf(uploadId: string) {
  return prisma.page.findFirst({ where: { uploadId }, orderBy: { pageIndex: "asc" }, select: { derivedPath: true, filePath: true } });
}

test("an upload with no pages yet is pending, and a missing cover cannot throw", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, []);
    assert.deepEqual(await coverState(up.id, null), { status: "pending", rev: 0 });
    assert.deepEqual(await coverState(up.id, undefined), { status: "pending", rev: 0 });
  } finally {
    await f.cleanup();
  }
});

test("an upload with pages is ready before anything is derived, and deriving does not change that", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }, { pageIndex: 1 }]);
    const page = await pageOf(up.id);
    const before = await coverState(up.id, page);
    assert.equal(before.status, "ready", "lazy derivation: a cover that has not been requested yet is still available");
    assert.ok(before.rev > 0, "the revision is a real timestamp");
    await assert.rejects(fs.access(coverDir(up.id)), "asking for the status derived nothing");

    const res = await serveCover(f.owner.id, up.id, "small", null);
    assert.equal(res.status, 200);
    await drain(res);
    const after = await coverState(up.id, page);
    assert.equal(after.status, "ready");
    assert.equal(after.rev, (await coverState(up.id, page)).rev, "the revision is stable between calls");
  } finally {
    await f.cleanup();
  }
});

test("a page whose file is gone is failed, so the card shows fallback art", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await fs.rm(up.pageFile(0));
    assert.equal((await coverState(up.id, await pageOf(up.id))).status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("a page that will not decode becomes failed after one attempt, and ready again once it is replaced", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await fs.writeFile(up.pageFile(0), "not a jpeg");
    const page = await pageOf(up.id);
    assert.equal((await coverState(up.id, page)).status, "ready", "nothing has tried yet");

    const res = await serveCover(f.owner.id, up.id, "small", null);
    assert.equal(res.status, 404, "the request degrades to a 404");
    await drain(res);
    assert.equal((await coverState(up.id, page)).status, "failed");

    await sleep(30);
    await jpeg(up.pageFile(0), 800, 1200);
    assert.equal((await coverState(up.id, page)).status, "ready", "a re-rendered page is a fresh chance");
  } finally {
    await f.cleanup();
  }
});

test("a request makes only its own size, and the revision follows the small cover the list shows", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    const page = await pageOf(up.id);
    const fresh = await coverState(up.id, page);

    await drain(await serveCover(f.owner.id, up.id, "large", null));
    assert.deepEqual(await fs.readdir(coverDir(up.id)), ["large.webp"], "a large request did not also make small and medium");
    assert.equal((await coverState(up.id, page)).rev, fresh.rev, "a size the list does not show cannot move the list's revision");

    await sleep(30);
    await drain(await serveCover(f.owner.id, up.id, "small", null));
    const after = await coverState(up.id, page);
    assert.equal(after.rev, Math.trunc((await fs.stat(coverFile(up.id, "small"))).mtimeMs), "the revision is the small cover's mtime once it exists");
    assert.ok(after.rev > fresh.rev);
  } finally {
    await f.cleanup();
  }
});

test("the revision moves when the page is re-rendered", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    const page = await pageOf(up.id);
    await drain(await serveCover(f.owner.id, up.id, "small", null));
    const a = await coverState(up.id, page);
    await sleep(30);
    await jpeg(up.pageFile(0), 800, 1200, "#ff8800");
    const b = await coverState(up.id, page);
    assert.ok(b.rev > a.rev, `a redone page is a new URL (${a.rev} -> ${b.rev})`);
  } finally {
    await f.cleanup();
  }
});

test("the source is the page with the lowest index, and its derived copy is preferred over the original", async () => {
  const f = await seed();
  try {
    // Inserted out of order and starting at 3: "page 0" is not assumed to exist.
    const up = await f.upload(f.owner.id, [
      { pageIndex: 9, color: "#00ff00" },
      { pageIndex: 3, color: "#ff0000" },
      { pageIndex: 5, color: "#0000ff" },
    ]);
    const res = await serveCover(f.owner.id, up.id, "small", null);
    assert.equal(res.status, 200);
    const c = await dominant(await drain(res));
    assert.ok(c.r > 200 && c.g < 80 && c.b < 80, `the cover is page 3 (red); got rgb(${c.r},${c.g},${c.b})`);

    const located = await locateSource({ derivedPath: path.join(FIXTURES, "d.jpg"), filePath: path.join(FIXTURES, "f.jpg") });
    assert.equal(located, null, "neither file exists");

    await jpeg(path.join(FIXTURES, "f.jpg"), 50, 50);
    const fallback = await locateSource({ derivedPath: path.join(FIXTURES, "d.jpg"), filePath: path.join(FIXTURES, "f.jpg") });
    assert.equal(fallback?.path, path.join(FIXTURES, "f.jpg"), "a derived path that is not on disk falls back to the original");

    await jpeg(path.join(FIXTURES, "d.jpg"), 50, 50);
    const preferred = await locateSource({ derivedPath: path.join(FIXTURES, "d.jpg"), filePath: path.join(FIXTURES, "f.jpg") });
    assert.equal(preferred?.path, path.join(FIXTURES, "d.jpg"), "and when both exist the downscaled one wins");

    const none = await locateSource({ derivedPath: null, filePath: path.join(FIXTURES, "f.jpg") });
    assert.equal(none?.path, path.join(FIXTURES, "f.jpg"), "a page with no derived copy uses the original");
  } finally {
    await f.cleanup();
  }
});

test("a page whose derived path is gone still gets a cover from its original", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0, derived: "missing" }]);
    const res = await serveCover(f.owner.id, up.id, "small", null);
    assert.equal(res.status, 200);
    assert.equal((await dims(await drain(res))).width, 160);
  } finally {
    await f.cleanup();
  }
});

// -------------------------------------------------------------------- serving

test("the owner's cover is served, immutable, with an ETag, in the requested size", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0, width: 1067, height: 1600 }]);
    for (const size of COVER_SIZES) {
      const res = await serveCover(f.owner.id, up.id, size, null);
      assert.equal(res.status, 200, size);
      assert.equal(res.headers.get("content-type"), "image/webp");
      assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.match(res.headers.get("etag") ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);
      const body = await drain(res);
      assert.equal(res.headers.get("content-length"), String(body.length));
      assert.equal((await dims(body)).width, COVER_WIDTH[size]);
    }
  } finally {
    await f.cleanup();
  }
});

test("an ownerless upload is served to a signed-in user; another account's is a quiet 404 that does no work", async () => {
  const f = await seed();
  try {
    const ownerless = await f.upload(null, [{ pageIndex: 0 }]);
    const foreign = await f.upload(f.other.id, [{ pageIndex: 0 }]);

    for (const viewer of [f.owner.id, f.other.id]) {
      const res = await serveCover(viewer, ownerless.id, "small", null);
      assert.equal(res.status, 200, "uploads made before sign-in existed are listed, so their covers must load");
      await drain(res);
    }

    const res = await serveCover(f.owner.id, foreign.id, "small", null);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" }, "and says nothing about it");
    await assert.rejects(fs.access(coverDir(foreign.id)), "a refused request derived nothing");
  } finally {
    await f.cleanup();
  }
});

test("a repeat request with the matching ETag is a 304, and a different one is a 200", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    const first = await serveCover(f.owner.id, up.id, "small", null);
    const etag = first.headers.get("etag")!;
    await drain(first);

    const again = await serveCover(f.owner.id, up.id, "small", etag);
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("etag"), etag);
    assert.equal(again.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal((await drain(again)).length, 0);

    const other = await serveCover(f.owner.id, up.id, "small", '"0-0"');
    assert.equal(other.status, 200);
    await drain(other);
  } finally {
    await f.cleanup();
  }
});

test("a size that is not one of the three is the same as no size, and never reaches a path", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0, width: 1067, height: 1600 }]);
    for (const hostile of [null, "", "full", "SMALL", "../../etc/passwd", "small/../../x"]) {
      const res = await serveCover(f.owner.id, up.id, hostile, null);
      assert.equal(res.status, 200, JSON.stringify(hostile));
      assert.equal((await dims(await drain(res))).width, COVER_WIDTH.medium, `${JSON.stringify(hostile)} serves the default size`);
    }
    assert.deepEqual(await fs.readdir(coverDir(up.id)), ["medium.webp"], "junk made the default size and nothing named after the input");
    for (const size of ["small", "large"]) await drain(await serveCover(f.owner.id, up.id, size, null));
    assert.deepEqual((await fs.readdir(coverDir(up.id))).sort(), ["large.webp", "medium.webp", "small.webp"], "only the three known files ever exist");
  } finally {
    await f.cleanup();
  }
});

test("every way a cover can be unavailable is a 404 JSON body, never a throw or a 500", async () => {
  const f = await seed();
  try {
    const noPages = await f.upload(f.owner.id, []);
    const gone = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await fs.rm(gone.pageFile(0));
    const corrupt = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await fs.writeFile(corrupt.pageFile(0), "not an image");

    for (const [label, id] of [
      ["no pages", noPages.id],
      ["page deleted", gone.id],
      ["page corrupt", corrupt.id],
      ["no such upload", "no-such-upload"],
      ["hostile id", "../../etc/passwd"],
    ] as const) {
      const res = await serveCover(f.owner.id, id, "small", null);
      assert.equal(res.status, 404, label);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, label);
      assert.equal(res.headers.get("cache-control"), "no-store", `${label}: a failure is never remembered by the browser`);
      const body = (await res.json()) as { error: string };
      assert.equal(typeof body.error, "string", label);
      assert.ok(body.error.length > 0);
    }
  } finally {
    await f.cleanup();
  }
});

test("when the database itself rejects the lookup, the cover is a 404 and not an exception", async () => {
  // A real failure, not a mock: Prisma throws on an id that is not a string.
  for (const hostile of [{ contains: "x" }, 42, ["a"]]) {
    const res = await serveCover("someone", hostile as unknown as string, "small", null).catch((e) => e);
    assert.ok(res instanceof Response, "a Response came back rather than a throw");
    assert.equal((res as Response).status, 404);
    const again = await regenerateCover("someone", hostile as unknown as string).catch((e) => e);
    assert.ok(again instanceof Response && again.status === 404, "and so does the regenerate action");
  }
});

// ---------------------------------------------------------------- coverPath

test("the first derivation records the cover's path on the book; it is derived, not read back", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    assert.equal((await prisma.book.findUnique({ where: { id: f.bookId } }))?.coverPath, null, "NULL before anything is requested");
    await drain(await serveCover(f.owner.id, up.id, "small", null));
    const book = await prisma.book.findUnique({ where: { id: f.bookId } });
    assert.equal(book?.coverPath, coverFile(up.id, "small"), "the absolute path of the file that was made: covers are made one size at a time");
    await fs.access(book!.coverPath!);
  } finally {
    await f.cleanup();
  }
});

test("a stale, foreign or hostile stored coverPath is never trusted for serving, and is replaced", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0, color: "#ff0000" }]);
    // A real file that is NOT this upload's cover: serving by the stored string
    // would hand back a blue image.
    const decoy = await jpeg(path.join(FIXTURES, "decoy.jpg"), 300, 300, "#0000ff");

    for (const stored of [decoy, "C:/gone/old-cover.webp", "https://covers.openlibrary.org/b/id/1-L.jpg", "../../../etc/passwd"]) {
      await prisma.book.update({ where: { id: f.bookId }, data: { coverPath: stored } });
      await fs.rm(coverDir(up.id), { recursive: true, force: true });
      const res = await serveCover(f.owner.id, up.id, "medium", null);
      assert.equal(res.status, 200, stored);
      const c = await dominant(await drain(res));
      assert.ok(c.r > 200 && c.b < 80, `${stored}: the cover is the upload's own page (red), not what the column named`);
      assert.equal(
        (await prisma.book.findUnique({ where: { id: f.bookId } }))?.coverPath,
        coverFile(up.id, "medium"),
        `${stored}: a value that is not one of this app's covers is advisory, and is overwritten`,
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("two uploads of one book do not take turns overwriting its coverPath", async () => {
  const f = await seed();
  try {
    const first = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    const second = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await drain(await serveCover(f.owner.id, first.id, "small", null));
    await drain(await serveCover(f.owner.id, second.id, "small", null));
    await drain(await serveCover(f.owner.id, first.id, "small", null));
    assert.equal(
      (await prisma.book.findUnique({ where: { id: f.bookId } }))?.coverPath,
      coverFile(first.id, "small"),
      "the first cover derived stays recorded while its file exists",
    );

    // ...but once that cover is gone the column is stale, and the next one repairs it.
    await clearCover(first.id);
    await drain(await serveCover(f.owner.id, second.id, "small", null));
    assert.equal((await prisma.book.findUnique({ where: { id: f.bookId } }))?.coverPath, coverFile(second.id, "small"));
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------- regenerate

test("regenerating clears the cache and re-derives the card's cover under a new revision", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await drain(await serveCover(f.owner.id, up.id, "small", null));
    await drain(await serveCover(f.owner.id, up.id, "large", null));
    const before = await coverState(up.id, await pageOf(up.id));
    const born = (await fs.stat(coverFile(up.id, "small"))).mtimeMs;

    // Something stale is lying in the cache: regenerating must replace it.
    await fs.writeFile(path.join(coverDir(up.id), "extra.webp"), "leftover");
    await sleep(30);

    const res = await regenerateCover(f.owner.id, up.id);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; coverStatus: string; coverRev: number };
    assert.equal(body.ok, true);
    assert.equal(body.coverStatus, "ready");
    assert.ok(body.coverRev > before.rev, `the new revision busts the browser's immutable copy (${before.rev} -> ${body.coverRev})`);
    assert.ok((await fs.stat(coverFile(up.id, "small"))).mtimeMs > born, "the card's cover was remade");
    assert.equal(await isWebp(coverFile(up.id, "small")), true);
    await assert.rejects(fs.access(path.join(coverDir(up.id), "extra.webp")), "the directory was emptied first");
    await assert.rejects(fs.access(coverFile(up.id, "large")), "the sizes nothing is showing are left to be made when asked for");
    assert.equal((await coverState(up.id, await pageOf(up.id))).rev, body.coverRev, "and the list will report the same revision");

    await drain(await serveCover(f.owner.id, up.id, "large", null));
    assert.equal(await isWebp(coverFile(up.id, "large")), true, "and asking for one makes it");
  } finally {
    await f.cleanup();
  }
});

test("regenerating never deletes the cache when the page it would be rebuilt from is gone", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await drain(await serveCover(f.owner.id, up.id, "small", null));
    await drain(await serveCover(f.owner.id, up.id, "medium", null));
    const smallBefore = await fs.readFile(coverFile(up.id, "small"));
    await fs.rm(up.pageFile(0));

    const res = await regenerateCover(f.owner.id, up.id);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { coverStatus: string }).coverStatus, "failed", "the page is gone, and the status says so");
    assert.deepEqual(await fs.readFile(coverFile(up.id, "small")), smallBefore, "but the last copy of what it looked like is still there");
    assert.equal(await isWebp(coverFile(up.id, "medium")), true);
  } finally {
    await f.cleanup();
  }
});

test("regenerating is a retry for a failed cover, and reports failed when it still cannot be made", async () => {
  const f = await seed();
  try {
    const up = await f.upload(f.owner.id, [{ pageIndex: 0 }]);
    await fs.writeFile(up.pageFile(0), "not a jpeg");
    await drain(await serveCover(f.owner.id, up.id, "small", null));
    assert.equal((await coverState(up.id, await pageOf(up.id))).status, "failed");

    const still = await regenerateCover(f.owner.id, up.id);
    assert.equal(still.status, 200, "the action itself worked");
    assert.equal(((await still.json()) as { coverStatus: string }).coverStatus, "failed");

    await jpeg(up.pageFile(0), 800, 1200);
    const fixed = await regenerateCover(f.owner.id, up.id);
    assert.equal(((await fixed.json()) as { coverStatus: string }).coverStatus, "ready");
  } finally {
    await f.cleanup();
  }
});

test("another account's cover cannot be regenerated, and an upload with no pages says pending", async () => {
  const f = await seed();
  try {
    const foreign = await f.upload(f.other.id, [{ pageIndex: 0 }]);
    await drain(await serveCover(f.other.id, foreign.id, "small", null));
    const before = (await fs.stat(coverFile(foreign.id, "small"))).mtimeMs;

    const res = await regenerateCover(f.owner.id, foreign.id);
    assert.equal(res.status, 404);
    assert.equal((await fs.stat(coverFile(foreign.id, "small"))).mtimeMs, before, "the cache was not touched");

    const empty = await f.upload(f.owner.id, []);
    const pending = await regenerateCover(f.owner.id, empty.id);
    assert.equal(pending.status, 200);
    assert.equal(((await pending.json()) as { coverStatus: string }).coverStatus, "pending");

    assert.equal((await regenerateCover(f.owner.id, "no-such-upload")).status, 404);
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------------------ UI

const summary = (over: Partial<AnalysisSummary> = {}): AnalysisSummary => ({
  id: "up1",
  bookTitle: "Atomic Habits",
  status: "DONE",
  step: "Done",
  pageCount: 12,
  ideaCount: 3,
  createdAt: "2026-10-05T00:00:00.000Z",
  ...over,
});

test("AnalysisSummary still accepts a row with none of the cover fields", () => {
  // Compiles only while every new field is optional; `npm run typecheck` is the
  // enforcement. The runtime assertion keeps the test from being a no-op.
  const legacy: AnalysisSummary = {
    id: "a",
    bookTitle: "B",
    status: "DONE",
    step: "Done",
    pageCount: null,
    ideaCount: 0,
    createdAt: "x",
  };
  assert.equal(legacy.coverStatus, undefined);
  assert.equal(legacy.coverRev, undefined);
});

test("a ready cover renders a lazy image at the small size, versioned by its revision", () => {
  const html = renderToStaticMarkup(React.createElement(BookCover, { book: summary({ coverStatus: "ready", coverRev: 1700000000123 }) }));
  assert.match(html, /<img /);
  assert.match(html, /src="\/api\/uploads\/up1\/cover\?size=small&amp;v=1700000000123"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /alt=""/, "decorative: the card's own label names the book");
});

test("pending, failed and unreported covers all show the initials, never a broken image", () => {
  for (const over of [{ coverStatus: "pending" as const }, { coverStatus: "failed" as const, coverRev: 5 }, {}]) {
    const html = renderToStaticMarkup(React.createElement(BookCover, { book: summary(over) }));
    assert.doesNotMatch(html, /<img/, JSON.stringify(over));
    assert.match(html, />AH</, `${JSON.stringify(over)}: the book's initials`);
    assert.match(html, /aria-hidden/);
  }
  assert.match(renderToStaticMarkup(React.createElement(BookCover, { book: summary({ bookTitle: "   " }) })), />BR</, "a blank title still has a placeholder");
});

test("the Regenerate button never uses `disabled`, and tracks each book separately", async () => {
  // BooksView cannot be rendered here (it fetches in an effect), so this reads
  // the source, as the voice-preview button's test in client-ui.test.mts does.
  const source = await fs.readFile(fileURLToPath(new URL("../src/components/BooksView.tsx", import.meta.url)), "utf8");
  const button = source.slice(source.indexOf('className="book-cover-action"'), source.indexOf("</button>", source.indexOf('className="book-cover-action"')));
  assert.ok(button.length > 0, "found the Regenerate button");
  // aria-disabled, never disabled: a button that disables itself while it waits
  // drops keyboard focus.
  assert.doesNotMatch(button, /\sdisabled=/, "a self-disabling button drops keyboard focus");
  assert.match(button, /aria-disabled=\{regenerating\.has\(b\.id\)\}/);
  // One slot for "the book being regenerated" lets A's finish clear B's flag.
  assert.match(source, /useState<ReadonlySet<string>>/, "in-flight regenerations are a set of ids");
  assert.match(source, /inflight\.current\.delete\(id\)/, "a finish removes only its own id");
});

test("the cover route compiles against what is committed, not the working tree", async () => {
  // `isAppError` exists only in the operator's uncommitted errors.ts hunk. The
  // route must depend on the exports HEAD has, or the staged set fails `next build`.
  const source = await fs.readFile(fileURLToPath(new URL("../src/app/api/uploads/[id]/cover/route.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /import\s*\{[^}]*isAppError[^}]*\}/, "not imported");
  assert.doesNotMatch(source, /isAppError\(/, "not called");
  assert.match(source, /errorStatus\(err\) === 401/);
});

test("the Regenerate copy is in the strings module", () => {
  assert.equal(strings.books.coverRegenerate, "Regenerate cover");
  assert.equal(typeof strings.books.coverRegenerating, "string");
  assert.equal(typeof strings.books.coverRegenerateError, "string");
  assert.equal(typeof strings.books.coverRegenerateFor("X"), "string");
});
