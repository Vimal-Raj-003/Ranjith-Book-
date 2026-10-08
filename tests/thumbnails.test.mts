import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright-core";
import {
  buildThumbHtml,
  computeCrop,
  contrast,
  escapeHtml,
  generateThumbnails,
  headlineText,
  isThumbKey,
  normaliseFocus,
  paintKeywords,
  parseThumbnails,
  selectThumb,
  serializeThumbnails,
  thumbsDir,
  trimWords,
  type ThumbSpec,
  thumbPalette,
} from "../src/lib/thumbnails";
import { FIT_SCRIPT, type Box } from "../src/lib/thumbnails/render";
import { ASPECTS, VARIANTS } from "../src/lib/thumbnails/types";
import {
  BOOK_THEMES,
  BOOK_THEME_IDS,
  DEFAULT_BOOK_THEME_ID,
} from "../src/lib/video/composition/themes";
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
    rev: 0,
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

  // The resolved file is always in the directory of the episode it was asked
  // for -- never another one's, whatever the row says.
  assert.equal(
    selectThumb(stored, "9x16-quote", "some-other-episode")?.path,
    path.join(thumbsDir("some-other-episode"), "9x16-quote.jpg"),
  );

  // An episode id that is not one directory directly under the root resolves
  // to nothing. (Ids come from the database, so this is defence in depth.)
  for (const bad of ["..", "../..", "a/b", "", "/etc", "..\\..\\windows"]) {
    assert.equal(selectThumb(stored, "9x16-quote", bad), null, `episode id ${JSON.stringify(bad)} must not resolve`);
  }
});

test("the stored path contributes nothing: it is derived, so a foreign row still serves", () => {
  // The 50-episode case. These rows were written by a `G:\YT-Book\` copy of the
  // app that shared the library; all six files are in the local thumbs
  // directory, and only the string beside them points elsewhere. The old
  // comparison refused every one of them, which read as "the posters are
  // missing" and was diagnosed as needing a re-render. Nothing needed
  // re-rendering.
  const foreign = [
    spec("9x16-quote", { path: "G:\\YT-Book\\.bookreel\\thumbs\\cmtold0001\\9x16-quote.jpg" }),
    spec("16x9-bold", { aspect: "16:9", variant: "bold", path: "/etc/passwd" }),
    spec("9x16-split", { variant: "split", path: path.join(thumbsDir(EPISODE), "..", "9x16-split.jpg") }),
    // Right directory, wrong file: the row cannot make the route open another name.
    spec("9x16-bold", { variant: "bold", path: path.join(thumbsDir(EPISODE), "9x16-quote.jpg") }),
  ];
  for (const s of foreign) {
    const got = selectThumb(foreign, s.key, EPISODE);
    assert.equal(got?.path, path.join(thumbsDir(EPISODE), `${s.key}.jpg`), `${s.path} must resolve to the derived path`);
    assert.equal(got?.key, s.key);
    // Everything else on the record is the row's; only `path` is replaced.
    assert.equal(got?.aspect, s.aspect);
    assert.equal(got?.variant, s.variant);
  }

  // And a key the episode never recorded still resolves to nothing, even
  // though deriving its path would be trivial and a file may well be there.
  assert.equal(selectThumb(foreign, "16x9-split", EPISODE), null);
  assert.equal(selectThumb(foreign, "../../etc/passwd", EPISODE), null);
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

// ------------------------------------------------------------------ headline

test("a headline is a whole thought, not the hook with an ellipsis on it", () => {
  const base = { title: "The Quiet Operator", keywords: ["busy"], onScreen: [] as string[] };

  // A hook whose first sentence already fits is used as it stands, full stop
  // dropped — a poster does not need punctuation to end.
  assert.equal(
    headlineText({ ...base, hook: "Most people are busy. Almost nobody is focused." }, 8),
    "Most people are busy",
  );

  // The regression this function exists for. The operator's own hook is ten
  // words, so the old rule cut it to "Busy can be a performance you put…" — a
  // fragment. The writer's own on-screen label for the hook beat says the same
  // thing in four words and is used instead.
  assert.equal(
    headlineText(
      {
        ...base,
        hook: "Busy can be a performance you put on for yourself.",
        onScreen: ["Busy is a performance", "Real work is less dramatic"],
      },
      8,
    ),
    "Busy is a performance",
  );

  // A hinged hook gives up the clause carrying the keyword, and only that one:
  // "You are not behind" also fits, and is rejected for saying nothing the
  // keyword marked as the point.
  assert.equal(
    headlineText(
      { ...base, keywords: ["exhausted"], hook: "You are not behind, you are exhausted" },
      6,
    ),
    "you are exhausted",
  );

  // The title is tried before truncation is: a book's own name is a whole
  // thought, and an overlong hook cut to four words is not.
  assert.equal(
    headlineText({ ...base, hook: "one two three four five six seven eight nine ten" }, 4),
    "The Quiet Operator",
  );

  // Nothing whole fits anywhere — no beat lines, no title short enough. Only
  // now is a cut headline the lesser evil, and it still says so with an
  // ellipsis rather than stopping mid-air.
  assert.equal(
    headlineText({ title: "", keywords: [], hook: "one two three four five six seven eight nine ten" }, 4),
    "one two three four…",
  );

  // Empty in every field is empty, not a throw.
  assert.equal(headlineText({ title: "", hook: "", keywords: [] }, 7), "");
  assert.equal(headlineText({ title: "Deep Work", hook: "", keywords: [] }, 7), "Deep Work");
});

// -------------------------------------------------------------------- themes

test("a poster is painted in the theme the video is actually rendered in", () => {
  const copy = { title: "Deep Work", hook: "Busy is a performance", keywords: ["performance"], cta: "Follow" };
  const html = (theme?: string | null) =>
    buildThumbHtml({ aspect: ASPECTS[0], variant: "bold", copy, photo: null, focus: null, theme });

  // The bug this replaced: every poster carried a hardcoded copy of
  // Marginalia's palette, so a Spotlight video was advertised in cream and
  // yellow. Each theme's own ground and accent must reach the markup.
  const spotlight = html("spotlight");
  const blueprint = html("blueprint");
  assert.notEqual(spotlight, blueprint, "two themes must not render the same document");

  for (const [id, role] of [
    ["spotlight", BOOK_THEMES.spotlight.palette.backdropDeep],
    ["blueprint", BOOK_THEMES.blueprint.palette.backdropDeep],
    ["terminal", BOOK_THEMES.terminal.palette.backdropDeep],
    ["editorial", BOOK_THEMES.editorial.palette.backdropDeep],
  ] as const) {
    assert.ok(html(id).includes(role), `${id} paints its own backdropDeep (${role})`);
  }
  // And Marginalia's yellow must NOT be in a Spotlight poster.
  assert.ok(
    !spotlight.includes(BOOK_THEMES.marginalia.palette.marker),
    "a Spotlight poster carries none of Marginalia's marker yellow",
  );

  // An id from a row written before the picker existed, an id that has since
  // been renamed, and a hostile one all fall back to the default theme rather
  // than throwing — the same guarantee the video renderer makes.
  const fallback = html(DEFAULT_BOOK_THEME_ID);
  for (const bad of [undefined, null, "", "nope", "toString", "__proto__"]) {
    assert.equal(html(bad), fallback, `${String(bad)} renders the default theme`);
  }
});

test("every theme's headline, accent and slab actually read against its own ground", () => {
  for (const id of BOOK_THEME_IDS) {
    const p = thumbPalette(id);
    assert.ok(contrast(p.ink, p.groundMid) >= 4.5, `${id}: headline ink on ground (${contrast(p.ink, p.groundMid).toFixed(1)}:1)`);
    assert.ok(contrast(p.onSlab, p.slab) >= 4.5, `${id}: keyword on its slab`);
    // 3.5 rather than 4.5 for the accent field alone, because this is the
    // PALETTE: `thumbPalette()` reports the theme's own accent, and Marginalia's
    // burnt orange cannot carry 4.5:1 against any colour in its own palette
    // (4.15:1 with the best of them). That is still true here and this bound is
    // unchanged. It is no longer what a poster is painted with: `buildThumbHtml`
    // nudges the accent with `lift()` (render.ts) until its type reaches 4.7:1,
    // and the render-level tests below hold the drawn poster to 4.5:1. The
    // earlier decision not to move the accent off the theme was reversed there,
    // for a tenth of the way to white.
    assert.ok(contrast(p.onAccent, p.accent) >= 3.5, `${id}: type on the accent field`);
    // The slab is a highlight: if it does not separate from the ground it is
    // not highlighting anything. Editorial is the case that forced this — its
    // marker is a pale wash on an ecru ground.
    assert.ok(contrast(p.slab, p.groundMid) >= 1.7, `${id}: the slab separates from the ground`);
  }

  // Garbage in, default theme out — never a throw and never an empty role.
  for (const bad of [undefined, null, "", "nope", 7 as never, {} as never]) {
    const p = thumbPalette(bad as never);
    assert.equal(p.id, DEFAULT_BOOK_THEME_ID);
    for (const [role, value] of Object.entries(p)) {
      if (role === "dark") continue;
      assert.ok(value !== "" && value !== undefined && value !== null, `${role} is filled`);
    }
  }
});

test("a theme reaches the rendered posters, and an unknown one does not sink them", needsChromium, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-thumbs-"));
  try {
    const specs = await generateThumbnails({
      episodeId: EPISODE,
      pkg: pkg(),
      pages: [],
      focus: null,
      theme: "not-a-theme-id",
      outDir,
    });
    assert.equal(specs.length, 6, "an unrecognised theme costs nothing");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("the same episode renders the same bytes twice", needsChromium, async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-thumbs-a-"));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-thumbs-b-"));
  try {
    const opts = {
      episodeId: EPISODE,
      pkg: pkg(),
      pages: [],
      focus: { pageIndex: 0, x0: 100, y0: 200, x1: 900, y1: 260 },
      theme: "spotlight",
    };
    const one = await generateThumbnails({ ...opts, outDir: a });
    const two = await generateThumbnails({ ...opts, outDir: b });
    assert.equal(one.length, 6);
    assert.equal(two.length, 6);
    for (const spec of one) {
      const [x, y] = await Promise.all([
        fs.readFile(spec.path),
        fs.readFile(path.join(b, `${spec.key}.jpg`)),
      ]);
      assert.ok(x.equals(y), `${spec.key} is byte-identical across runs`);
    }
  } finally {
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  }
});

// ------------------------------------------------- legible where it is actually read

/**
 * The library grid paints a poster 164 CSS pixels wide, and that is the only
 * place the operator ever judges one. A headline that is magnificent at 1080
 * and mush at 164 has failed at the one job it has, so the floor is stated in
 * the units it is read in: how tall the type is once the poster is shrunk to
 * the grid, not how tall it is in the file.
 *
 * 10px is a judgement, made by looking at the renders at that size: below it a
 * 900-weight x-height is under 5px and the lowercase starts to close up. It is
 * measured against the real library, too -- the layouts as they were put 9 of
 * 118 real 16:9 quote headlines under it, the smallest at 8.2px, and the fit's
 * own minimum (54px on a 1080-wide poster, 20px on a 1280-wide one) is 8px and
 * 2.6px at the grid, so it was never going to catch that.
 */
const GRID_CSS_PX = 164;
const LEGIBLE_AT_GRID = 10;
/** WCAG's bar for body text. The headline is display type and would pass a lower one; it is held to this so a light theme cannot hide behind that. The same bar is held for the eyebrow, supporting line and chip: they are smaller than the headline, which is a reason for a bar no lower than its. */
const WANT_CONTRAST = 4.5;

/**
 * A stand-in for a photographed page: warm paper, ruled with dark word-sized
 * bars, one yellow-highlighted line. A demanding backdrop for type -- near-white
 * where a light headline has to read, near-black bars where a dark one does --
 * though a flat, even one: a photograph with a desk edge in it would be harsher.
 * It is built from arithmetic, not from the operator's own files, so the
 * assertion cannot drift with their library.
 */
async function paperPhoto(): Promise<{ photo: { dataUri: string; width: number; height: number }; focus: Box }> {
  const W = 1131;
  const H = 1600;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = 238;
    px[i + 1] = 233;
    px[i + 2] = 221;
  }
  const fill = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = y0; y < Math.min(H, y0 + h); y++) {
      for (let x = x0; x < Math.min(W, x0 + w); x++) {
        const o = (y * W + x) * 3;
        px[o] = rgb[0];
        px[o + 1] = rgb[1];
        px[o + 2] = rgb[2];
      }
    }
  };
  const focus: Box = { x0: 157, y0: 1019, x1: 975, y1: 1045 };
  fill(focus.x0, focus.y0, focus.x1 - focus.x0, focus.y1 - focus.y0, [250, 226, 92]);
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let y = 56; y < H - 56; y += 26) {
    for (let x = 157; x < 960; ) {
      const w = 18 + Math.floor(next() * 72);
      fill(x, y + 6, Math.min(w, 975 - x), 13, [46, 44, 42]);
      x += w + 9;
    }
  }
  const jpeg = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  return { photo: { dataUri: `data:image/jpeg;base64,${jpeg.toString("base64")}`, width: W, height: H }, focus };
}

/** What the browser says about one rendered poster. */
interface Measured {
  fontPx: number;
  /** Every element holding text whose content is bigger than its box. */
  overflowing: string[];
  /** One entry per run of text: what it is, its colour, and where its glyphs sit. */
  runs: { role: string; color: [number, number, number, number]; rect: { x: number; y: number; w: number; h: number } }[];
}

const MEASURE = `(() => {
  const fit = document.querySelector(".fit");
  const frame = document.querySelector(".frame").getBoundingClientRect();
  const overflowing = [];
  for (const el of document.querySelectorAll(".fit,.etext,.sub,.chip")) {
    const r = el.getBoundingClientRect();
    const cell = el.classList.contains("fit") ? el.parentElement : el;
    const spills = el.scrollWidth > cell.clientWidth + 1 || el.scrollHeight > cell.clientHeight + 1;
    const off = r.left < frame.left - 1 || r.top < frame.top - 1 || r.right > frame.right + 1 || r.bottom > frame.bottom + 1;
    if (spills || off) overflowing.push(el.className + " " + JSON.stringify(el.textContent).slice(0, 40));
  }
  const rgba = (c) => {
    const n = (c.match(/[\\d.]+/g) || []).map(Number);
    return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
  };
  const runs = [];
  for (const root of document.querySelectorAll(".fit,.etext,.sub,.chip")) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const color = rgba(getComputedStyle(n.parentElement).color);
      const role = n.parentElement.classList.contains("kw") ? "keyword" : root.classList.contains("fit") ? "headline" : root.className;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const q of range.getClientRects()) {
        if (q.width < 2 || q.height < 2) continue;
        runs.push({ role, color, rect: { x: q.left, y: q.top, w: q.width, h: q.height } });
      }
    }
  }
  return { fontPx: parseFloat(getComputedStyle(fit).fontSize), overflowing, runs };
})()`;

/** The same poster with its type made invisible, so what is left is what the type sits ON. */
const ERASE_TYPE = `(() => {
  const s = document.createElement("style");
  s.textContent = ".fit,.fit *,.etext,.sub,.chip{color:transparent !important;text-shadow:none !important}";
  document.head.appendChild(s);
})()`;

const lumTable = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const lum = (r: number, g: number, b: number) => 0.2126 * lumTable[Math.round(r)] + 0.7152 * lumTable[Math.round(g)] + 0.0722 * lumTable[Math.round(b)];
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * How well a run of type reads against what is behind it: the contrast that
 * 95% of the backdrop pixels reach or beat.
 *
 * A percentile, not the minimum, because one anti-aliased pixel on the edge of a
 * highlight is not a legibility failure -- but a fifth of the backdrop being too
 * close to the ink is. Sampled over the band the letters actually occupy (not
 * the whole line box, whose top and bottom hold whatever the font's metrics say)
 * so an inverted keyword slab is judged against the slab, not the ground around it.
 * Translucent ink is composited onto each pixel first: `rgba(.., .66)` over a
 * ground is not the colour its channels name.
 */
function backdropContrast(
  backdrop: { data: Buffer; width: number; height: number },
  run: Measured["runs"][number],
): number {
  const { x, y, w, h } = run.rect;
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(backdrop.width, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y + h * 0.3));
  const y1 = Math.min(backdrop.height, Math.ceil(y + h * 0.75));
  const [cr, cg, cb, ca] = run.color;
  const seen: number[] = [];
  for (let yy = y0; yy < y1; yy += 2) {
    for (let xx = x0; xx < x1; xx += 2) {
      const o = (yy * backdrop.width + xx) * 3;
      const r = backdrop.data[o];
      const g = backdrop.data[o + 1];
      const b = backdrop.data[o + 2];
      seen.push(ratio(lum(cr * ca + r * (1 - ca), cg * ca + g * (1 - ca), cb * ca + b * (1 - ca)), lum(r, g, b)));
    }
  }
  if (seen.length === 0) return 0;
  seen.sort((a, b) => a - b);
  return seen[Math.floor(seen.length * 0.05)];
}

/** Open one poster in the browser exactly as `generateThumbnails` does, and measure it. */
async function openPoster(page: import("playwright-core").Page, html: string, aspect: (typeof ASPECTS)[number]) {
  await page.setViewportSize({ width: aspect.width, height: aspect.height });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(FIT_SCRIPT);
  return (await page.evaluate(MEASURE)) as Measured;
}

// The headlines each layout has the LEAST room for -- not the longest by
// character count, which is a different thing: the fit is bound by whichever of
// width and height runs out first. Measured on 2026-10-04 by running the real fit
// over all 118 episodes' headlines in all six layouts, the smallest type in each
// layout belonged to one of these two, and they are pinned as strings so that
// the test keeps guarding the same case after the library changes:
//
//   TIGHTEST_LINE  16:9 quote (83px, 10.6px at the grid) and 9:16 quote -- eight
//                  words, 51 characters, the longest line the quote budget allows;
//                  and, through its beat label, 16:9 bold and split (100 and 99px).
//   TIGHTEST_WORD  9:16 bold (86px) and 9:16 split -- a 16-letter word that cannot
//                  be broken, which sets the size by width alone.
//
// With the type floor no longer enforced at runtime, this test is the only thing
// standing between a layout change and real headlines landing back under the
// floor, so it has to sit on the true worst case: a fixture with room to spare
// lets a regression through that the library would feel.
const TIGHTEST_LINE = {
  title: "Deep Work",
  hook: "Readers who chase everything end up knowing nothing",
  keywords: ["nothing"],
  cta: "Follow for one page a day",
  onScreen: ["A doctor's verdict after twenty-four years"],
  takeaway: ["Real work is quieter than it looks"],
};
const TIGHTEST_WORD = {
  title: "Deep Work",
  hook: "The counterintuitive cure",
  keywords: ["counterintuitive"],
  cta: "Follow for one page a day",
  onScreen: ["The counterintuitive cure"],
  takeaway: ["Real work is quieter than it looks"],
};

test("every poster in every theme reads at the 164px the grid paints it at", needsChromium, async () => {
  const { photo, focus } = await paperPhoto();
  const browser = await chromium.launch();
  const failures: string[] = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [name, copy] of [["line", TIGHTEST_LINE], ["word", TIGHTEST_WORD]] as const) {
      for (const theme of BOOK_THEME_IDS) {
        for (const aspect of ASPECTS) {
          for (const variant of VARIANTS) {
            const label = `${name} ${theme} ${aspect.tag}-${variant}`;
            const m = await openPoster(page, buildThumbHtml({ aspect, variant, copy, photo, focus, theme }), aspect);

            const floor = (LEGIBLE_AT_GRID * aspect.width) / GRID_CSS_PX;
            if (m.fontPx < floor) {
              failures.push(
                `${label}: headline is ${m.fontPx}px, ${((m.fontPx * GRID_CSS_PX) / aspect.width).toFixed(1)}px at the grid (floor ${floor.toFixed(0)}px)`,
              );
            }
            for (const o of m.overflowing) failures.push(`${label}: text overflows its box: ${o}`);

            await page.evaluate(ERASE_TYPE);
            const raw = await sharp(await page.screenshot({ type: "png" })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            for (const run of m.runs) {
              const got = backdropContrast({ data: raw.data, width: raw.info.width, height: raw.info.height }, run);
              if (got < WANT_CONTRAST) {
                failures.push(`${label}: ${run.role} ink rgba(${run.color}) reaches ${got.toFixed(2)}:1 on its backdrop (want ${WANT_CONTRAST}:1)`);
              }
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
});

test("an operator's overlong headline is shrunk, never cut, and still does not overflow", needsChromium, async () => {
  // 118 characters: what `normaliseHeadline` allows (it stops at 120), and far
  // more than any generated headline. Nothing can make it legible at the grid,
  // and the answer to that is a smaller headline -- not fewer words, which are
  // the operator's own -- so it goes below the floor the others are held to.
  const headline =
    "Compounding beats talent when talent stops showing up for the boring daily work that nobody else wants to do";
  const copy = { ...TIGHTEST_LINE, headline };
  const browser = await chromium.launch();
  const failures: string[] = [];
  let belowFloor = 0;
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const aspect of ASPECTS) {
      for (const variant of VARIANTS) {
        const label = `${aspect.tag}-${variant}`;
        const m = await openPoster(page, buildThumbHtml({ aspect, variant, copy, photo: null, focus: null }), aspect);
        const shown = (await page.evaluate(() => document.querySelector(".fit")!.textContent)) as string;
        if (shown !== headline) failures.push(`${label}: the headline was cut to ${JSON.stringify(shown)}`);
        // Breaking a word in half is the last resort, for a single word wider than
        // the box. Twenty short words are not that, and they must be smaller instead.
        const wrap = (await page.evaluate(() => getComputedStyle(document.querySelector(".fit")!).overflowWrap)) as string;
        if (wrap !== "normal") failures.push(`${label}: words were broken mid-way to fit`);
        if (m.fontPx < (LEGIBLE_AT_GRID * aspect.width) / GRID_CSS_PX) belowFloor++;
        // Not zero: the absolute floor still holds, so it is a small headline and
        // not an invisible one.
        if (m.fontPx < 18) failures.push(`${label}: shrunk to ${m.fontPx}px`);
        for (const o of m.overflowing) failures.push(`${label}: text overflows its box: ${o}`);
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  // Without this the test passes if the floor were simply raised until nothing
  // needed the fallback, and says nothing about the path it exists to cover.
  assert.ok(belowFloor > 0, "at least one layout had to go below the legibility floor to fit it");
});

// ----------------------------------------------------------------- the crop

test("a crop never leaves the photograph, and the highlighted line stays in it", () => {
  const W = 1131;
  const H = 1600;
  // Every window the layouts use: the portrait quote photo, the full-bleed bold,
  // the landscape quote strip and the split band, in both aspects.
  const windows: [number, number, number][] = [
    [1080, 960, 13],
    [1080, 1920, 32],
    [1280, 288, 5],
    [1280, 720, 20],
    [1080, 653, 7],
    [1280, 245, 4],
  ];
  // The highlight in the middle, hard against each edge and corner, a sliver, a
  // whole-page box, and none at all.
  const boxes: (Box | null)[] = [
    { x0: 157, y0: 1019, x1: 975, y1: 1045 },
    { x0: 0, y0: 0, x1: 120, y1: 26 },
    { x0: W - 120, y0: 0, x1: W, y1: 26 },
    { x0: 0, y0: H - 26, x1: 120, y1: H },
    { x0: W - 120, y0: H - 26, x1: W, y1: H },
    { x0: 500, y0: 0, x1: 640, y1: 30 },
    { x0: 500, y0: H - 30, x1: 640, y1: H },
    { x0: 400, y0: 700, x1: 420, y1: 705 },
    { x0: 0, y0: 0, x1: W, y1: H },
    null,
  ];
  for (const [bw, bh, lines] of windows) {
    for (const focus of boxes) {
      const c = computeCrop(W, H, bw, bh, focus, lines);
      const where = `${bw}x${bh} lines=${lines} focus=${JSON.stringify(focus)}`;
      // The photograph, as laid out, covers the whole window: no bare edge shows.
      assert.ok(c.left <= 0.01 && c.top <= 0.01, `${where}: starts inside the window`);
      assert.ok(c.left + c.imgW >= bw - 0.01, `${where}: reaches the right edge`);
      assert.ok(c.top + c.imgH >= bh - 0.01, `${where}: reaches the bottom edge`);
      if (!focus) {
        assert.equal(c.mark, null);
        continue;
      }
      // And the line the poster is about is in the window, however close to the
      // edge of the page it sits.
      assert.ok(c.mark, `${where}: has a mark`);
      const cx = c.mark!.left + c.mark!.width / 2;
      const cy = c.mark!.top + c.mark!.height / 2;
      assert.ok(cx >= 0 && cx <= bw && cy >= 0 && cy <= bh, `${where}: the highlight (${cx}, ${cy}) is inside the window`);
    }
  }

  // Away from every edge the crop is CENTRED ON THE HIGHLIGHT, not on the page:
  // the marked line sits at 44% of the window, a little above the middle, and
  // the page's own centre (1600 / 2 = 800) is nowhere near it.
  const c = computeCrop(W, H, 1080, 960, { x0: 157, y0: 1019, x1: 975, y1: 1045 }, 13);
  assert.ok(Math.abs((c.mark!.top + c.mark!.height / 2) / 960 - 0.44) < 0.02, "the highlight sits at about 44% of the window");
});

// -------------------------------------------------------------- the contrast floor

test("a theme whose accent already carries its type is not recoloured, one that does not is", () => {
  const html = (theme: string) =>
    buildThumbHtml({ aspect: ASPECTS[0], variant: "split", copy: TIGHTEST_LINE, photo: null, focus: null, theme });
  // Terminal, Spotlight, Blueprint and Editorial clear 4.5:1 on their own accent.
  for (const id of ["terminal", "spotlight", "blueprint", "editorial"]) {
    const p = thumbPalette(id);
    assert.ok(contrast(p.onAccent, p.accent) >= 4.7, `${id}'s accent already carries its type`);
    assert.ok(html(id).includes(p.accent), `${id}'s own accent reaches the poster`);
  }
  // Marginalia's burnt orange manages 4.1:1 with the best ink it owns.
  const m = thumbPalette("marginalia");
  assert.ok(contrast(m.onAccent, m.accent) < 4.5, "the premise: Marginalia's accent is short of the bar");
  assert.ok(!html("marginalia").includes(m.accent), "so its field is a nudged colour, not the original");
});

test("a palette with an unreadable colour still renders a poster", () => {
  // The floor reads colours back to measure them. A colour it cannot parse must
  // cost the nudge, not the poster -- the contract `generateThumbnails` makes.
  const palette = { ...thumbPalette("marginalia"), accent: "not-a-colour", onAccent: "nor-this", ink: "nope" };
  for (const variant of VARIANTS) {
    const html = buildThumbHtml({ aspect: ASPECTS[0], variant, copy: TIGHTEST_LINE, photo: null, focus: null, palette });
    assert.ok(html.includes("<!doctype html>"), `${variant} renders`);
  }
});
