import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  buildThumbHtml,
  escapeHtml,
  generateThumbnails,
  isThumbKey,
  normaliseFocus,
  paintKeywords,
  parseThumbnails,
  selectThumb,
  serializeThumbnails,
  thumbsDir,
  trimWords,
  type ThumbSpec,
} from "../src/lib/thumbnails";
import { ASPECTS } from "../src/lib/thumbnails/types";
import type { ContentPackage } from "../src/lib/content/schema";

const EPISODE = "ep-thumb-test";

function spec(key: string, over: Partial<ThumbSpec> = {}): ThumbSpec {
  return {
    key,
    aspect: "9:16",
    variant: "quote",
    path: path.join(thumbsDir(EPISODE), `${key}.jpg`),
    width: 1080,
    height: 1920,
    ...over,
  };
}

const pkg = (over: Partial<ContentPackage> = {}): ContentPackage => ({
  title: "Deep Work",
  hook: "Most people are busy. Almost nobody is focused.",
  hookKeywords: ["busy"],
  ideaKey: "busy-vs-focused",
  beats: [
    { id: "hook", voiceover: "x", onScreen: "Busy is not focused", sourcePage: 0, startWord: 0, endWord: 3 },
  ],
  cta: "Follow for one page a day",
  description: "",
  hashtags: [],
  takeaway: [],
  ...over,
});

// ---------------------------------------------------------------- key safety

test("a thumbnail key is a bare filename stem — traversal never survives it", () => {
  for (const bad of [
    "../../etc/passwd",
    "..",
    "../9x16-quote",
    "9x16-quote/../../../etc/passwd",
    "/etc/passwd",
    "/Users/someone/.ssh/id_rsa",
    "..\\..\\windows\\system32",
    "9x16-quote\0.jpg",
    ".hidden",
    "",
    "a".repeat(200),
  ]) {
    assert.equal(isThumbKey(bad), false, `${JSON.stringify(bad)} must not be accepted as a key`);
  }
  assert.equal(isThumbKey("9x16-quote"), true);
  assert.equal(isThumbKey("16x9-bold"), true);
});

test("selectThumb only ever answers with a key the episode already recorded", () => {
  const stored = [spec("9x16-quote"), spec("16x9-bold", { aspect: "16:9", variant: "bold" })];

  // The happy path.
  assert.equal(selectThumb(stored, "9x16-quote", EPISODE)?.key, "9x16-quote");

  // Traversal: rejected before the filesystem is consulted at all.
  for (const bad of ["../../etc/passwd", "/etc/passwd", "9x16-quote/../../x", "..", "9x16-quote/"]) {
    assert.equal(selectThumb(stored, bad, EPISODE), null, `${bad} must not resolve`);
  }

  // A well-formed key that this episode simply does not have.
  assert.equal(selectThumb(stored, "9x16-split", EPISODE), null);
  assert.equal(selectThumb([], "9x16-quote", EPISODE), null);

  // Not a string at all.
  assert.equal(selectThumb(stored, undefined, EPISODE), null);
  assert.equal(selectThumb(stored, 7, EPISODE), null);

  // Another episode's key must not be readable through this episode's id.
  assert.equal(selectThumb(stored, "9x16-quote", "some-other-episode"), null);
});

test("a poisoned record cannot point the route outside the episode's own directory", () => {
  const escapes = [
    spec("9x16-quote", { path: "/etc/passwd" }),
    spec("16x9-bold", { path: path.join(thumbsDir(EPISODE), "..", "16x9-bold.jpg") }),
    // Right directory, wrong file: the basename must match the key.
    spec("9x16-split", { path: path.join(thumbsDir(EPISODE), "9x16-quote.jpg") }),
  ];
  for (const s of escapes) {
    assert.equal(selectThumb([s], s.key, EPISODE), null, `${s.path} must not resolve`);
  }
});

test("the stored column round-trips, and anything malformed reads as no thumbnails", () => {
  const specs = [spec("9x16-quote")];
  assert.deepEqual(parseThumbnails({ thumbnails: serializeThumbnails(specs) }), specs);

  for (const raw of [null, undefined, "", "   ", "not json", "{}", '"a string"', "[1,2,3]", '[{"key":"x"}]']) {
    assert.deepEqual(parseThumbnails({ thumbnails: raw }), [], `${String(raw)} reads as none`);
  }
  // A row from before the column existed.
  assert.deepEqual(parseThumbnails({}), []);
  assert.deepEqual(parseThumbnails(null), []);
  // One bad entry never discards the good ones.
  assert.deepEqual(parseThumbnails({ thumbnails: JSON.stringify([spec("9x16-quote"), { key: 1 }]) }), specs);
});

// ------------------------------------------------------------------ escaping

test("book text is escaped before it reaches the page", () => {
  assert.equal(escapeHtml(`</script><img src=x onerror="boom">`), "&lt;/script&gt;&lt;img src=x onerror=&quot;boom&quot;&gt;");
  assert.equal(escapeHtml("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
  assert.equal(escapeHtml(null), "");
});

test("a hostile hook cannot inject markup into a thumbnail", () => {
  const hostile = `</style><script>alert(1)</script>`;
  const html = buildThumbHtml({
    aspect: ASPECTS[0],
    variant: "bold",
    copy: { title: hostile, hook: hostile, keywords: ["<script>"], cta: hostile },
    photo: null,
    focus: null,
  });
  assert.ok(!html.toLowerCase().includes("<script"), "no script tag survives");
  assert.equal(
    html.split("</style>").length - 1,
    1,
    "exactly the document's own style block closes — book text cannot close it early",
  );
  assert.ok(html.includes("&lt;/style&gt;"), "the text is present, escaped");
  assert.ok(html.includes("&lt;/script&gt;"));
});

// ------------------------------------------------------------------ keywords

test("keywords are painted in accent, and their absence is never an error", () => {
  const painted = paintKeywords("Most people are busy", ["busy"]);
  assert.equal(painted, `Most people are <em class="kw">busy</em>`);

  // Case- and punctuation-insensitive, and multi-word phrases match.
  assert.equal(paintKeywords("Busy, always.", ["busy"]), `<em class="kw">Busy,</em> always.`);
  assert.equal(
    paintKeywords("Do deep work daily", ["deep work"]),
    `Do <em class="kw">deep</em> <em class="kw">work</em> daily`,
  );

  // Absent, empty, blank and non-matching keyword lists all render plain ink.
  for (const keywords of [undefined, null, [], [""], ["   "], ["nowhere"], ["", "  "]]) {
    assert.equal(paintKeywords("Most people are busy", keywords), "Most people are busy");
  }
  // And an empty hook is empty, not a crash.
  assert.equal(paintKeywords("", ["busy"]), "");
});

test("headlines are cut to a feed-readable word count", () => {
  // The first sentence when it fits, with the terminal punctuation dropped —
  // a full stop is dead weight on a poster.
  assert.equal(trimWords("Most people are busy. Almost nobody is focused.", 7), "Most people are busy");
  assert.equal(trimWords("one two three four five six seven eight nine", 4), "one two three four…");
  assert.equal(trimWords("   ", 7), "");
});

// --------------------------------------------------------------- focus boxes

test("a focus box that is inverted, out of bounds or nonsense never throws", () => {
  const page = { width: 1200, height: 1600 };

  const ok = normaliseFocus({ pageIndex: 0, x0: 100, y0: 200, x1: 900, y1: 260 }, page);
  assert.deepEqual(ok, { x0: 100, y0: 200, x1: 900, y1: 260 });

  // Inverted: swapped, not rejected.
  assert.deepEqual(normaliseFocus({ pageIndex: 0, x0: 900, y0: 260, x1: 100, y1: 200 }, page), ok);

  // Out of bounds: clamped to the image.
  assert.deepEqual(normaliseFocus({ pageIndex: 0, x0: -500, y0: -50, x1: 99999, y1: 300 }, page), {
    x0: 0,
    y0: 0,
    x1: 1200,
    y1: 300,
  });

  // Degenerate or unusable: null, and the crop simply loses its marker.
  assert.equal(normaliseFocus(null, page), null);
  assert.equal(normaliseFocus(undefined, page), null);
  assert.equal(normaliseFocus({ pageIndex: 0, x0: 10, y0: 10, x1: 11, y1: 11 }, page), null);
  assert.equal(normaliseFocus({ pageIndex: 0, x0: NaN, y0: 0, x1: 100, y1: 100 }, page), null);
  assert.equal(normaliseFocus({ pageIndex: 0, x0: 5000, y0: 10, x1: 6000, y1: 200 }, page), null);
  assert.equal(normaliseFocus({ pageIndex: 0, x0: 0, y0: 0, x1: 100, y1: 100 }, { width: 0, height: 0 }), null);
});

// ------------------------------------------------------------ full render

// Chromium is cached on a developer machine and in the render image, but the
// suite must stay green somewhere it is not — the pipeline's own contract is
// that a missing browser costs the thumbnails, not the run.
const chromiumAvailable = await chromium
  .launch()
  .then((b) => b.close())
  .then(() => true)
  .catch(() => false);
const needsChromium = { skip: chromiumAvailable ? false : "chromium is not available here" };

test("a missing page image degrades to type-only thumbnails rather than failing", needsChromium, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-thumbs-"));
  try {
    const specs = await generateThumbnails({
      episodeId: EPISODE,
      pkg: pkg(),
      pages: [{ src: path.join(outDir, "does-not-exist.jpg"), width: 1200, height: 1600 }],
      focus: { pageIndex: 0, x0: 100, y0: 200, x1: 900, y1: 260 },
      outDir,
    });

    assert.equal(specs.length, 6, "all six still render without a photograph");
    for (const s of specs) {
      const stat = await fs.stat(s.path);
      assert.ok(stat.size > 4096, `${s.key} is a real image (${stat.size} bytes)`);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("no pages, no hook and no keywords still produces thumbnails, not an exception", needsChromium, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-thumbs-"));
  try {
    const specs = await generateThumbnails({
      episodeId: EPISODE,
      pkg: pkg({ hook: "", hookKeywords: [], cta: "" }),
      pages: [],
      focus: { pageIndex: 9, x0: 0, y0: 0, x1: 10, y1: 10 },
      outDir,
    });
    assert.equal(specs.length, 6);
    assert.deepEqual(
      specs.map((s) => s.key),
      ["9x16-quote", "9x16-bold", "9x16-split", "16x9-quote", "16x9-bold", "16x9-split"],
    );
    assert.deepEqual(
      specs.map((s) => `${s.width}x${s.height}`),
      ["1080x1920", "1080x1920", "1080x1920", "1280x720", "1280x720", "1280x720"],
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

/**
 * The regression test for the empty thumbnail panel.
 *
 * `parseThumbnails` takes the episode ROW, reading `.thumbnails` off it. When
 * its parameter was typed `unknown`, both API routes passed the COLUMN instead
 * — `parseThumbnails(episode.thumbnails)` — which typechecked, returned an
 * empty array every time, and left the library and the inspector showing
 * nothing while six rendered images sat on disk. The signature now names a row
 * type so that call cannot compile, and this pins the behaviour either way.
 */
test("parseThumbnails reads the row, and a bare column yields nothing", () => {
  const specs = [
    { key: "9x16-quote", aspect: "9:16", variant: "quote", path: "/w/thumbs/e1/9x16-quote.jpg", width: 1080, height: 1920 },
  ];
  const column = JSON.stringify(specs);

  assert.equal(parseThumbnails({ thumbnails: column }).length, 1, "a row with the column parses");
  assert.equal(parseThumbnails({} as never).length, 0, "a row without the column is simply empty");
  assert.equal(parseThumbnails(null).length, 0);
  assert.equal(parseThumbnails(undefined).length, 0);
  // The exact mistake that shipped: passing the column string itself. It has no
  // `.thumbnails`, so it can only ever be empty — which is why it was silent.
  assert.equal(
    parseThumbnails(column as never).length,
    0,
    "passing the column instead of the row yields nothing — the bug this test exists for",
  );
});
