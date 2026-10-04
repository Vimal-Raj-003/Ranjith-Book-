import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { cacheControlFor, deriveGrid, parseSize } from "../src/lib/thumbnails/derive";
import { ASPECTS, gridDir, thumbsDir, type ThumbSpec } from "../src/lib/thumbnails/types";
import { canRetitle, normaliseHeadline, pickPoster } from "../src/lib/thumbnails/choose";
import { thumbUrl } from "../src/lib/thumbnails/url";
import { focusFromPlan, loadPosterSource, takeawayFromBeats } from "../src/lib/thumbnails/source";
import { generateThumbnails, parseThumbnails, serializeThumbnails } from "../src/lib/thumbnails";
import { buildThumbHtml } from "../src/lib/thumbnails/render";
import { publicThumbs } from "../src/lib/episode-view";

const EPISODE = "ep-grid-test";

/**
 * A 1080x1920 JPEG poster. `busy` fills it with noise so the file is
 * realistically heavy (a flat colour compresses to a few KB, which would let
 * any size assertion pass whether or not anything had been resized).
 */
async function makeFullPoster(key: string, busy = false): Promise<ThumbSpec> {
  const dir = thumbsDir(EPISODE);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.jpg`);
  await sharp({
    create: {
      width: 1080,
      height: 1920,
      channels: 3,
      background: "#204060",
      ...(busy ? { noise: { type: "gaussian" as const, mean: 128, sigma: 40 } } : {}),
    },
  })
    .jpeg({ quality: 80 })
    .toFile(file);
  return { key, aspect: "9:16", variant: "quote", path: file, width: 1080, height: 1920, rev: 0 };
}

test("parseSize accepts only 'grid' and treats hostile input as absent", () => {
  assert.equal(parseSize("grid"), "grid");
  assert.equal(parseSize(null), null);
  assert.equal(parseSize(""), null);
  assert.equal(parseSize("full"), null);
  // Review Focus 1: hostile values are absent, never a path fragment.
  assert.equal(parseSize("../../etc/passwd"), null);
  assert.equal(parseSize("grid/../.."), null);
  assert.equal(parseSize("GRID"), null);
  assert.equal(parseSize("x".repeat(10_000)), null);
  assert.equal(parseSize(["grid"]), null);
});

test("deriveGrid writes a small webp under the episode's own grid dir", async () => {
  const spec = await makeFullPoster("9x16-quote", true);
  const out = await deriveGrid(spec, EPISODE);
  assert.ok(out, "expected a derived file");
  assert.equal(path.dirname(out!), path.resolve(gridDir(EPISODE)));

  // Read through a Buffer, not by path: on Windows libvips keeps a path-opened
  // file mapped, which makes the cleanup below fail with EBUSY.
  const meta = await sharp(await fs.readFile(out!)).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 324);

  // The derivative must be a fraction of the poster it came from. The fixture
  // is noisy, so the original is large and a derivative that was never resized
  // (or was resized to the wrong width) would be of the same order and fail.
  const original = (await fs.stat(spec.path)).size;
  const derived = (await fs.stat(out!)).size;
  assert.ok(original > 200_000, `the fixture should be a heavy poster, got ${original} bytes`);
  assert.ok(derived * 4 < original, `grid variant (${derived} B) should be under a quarter of its original (${original} B)`);
});

test("deriveGrid is a cache: a second call returns the same path without rewriting", async () => {
  const spec = await makeFullPoster("9x16-bold");
  const first = await deriveGrid(spec, EPISODE);
  const stampBefore = (await fs.stat(first!)).mtimeMs;
  const second = await deriveGrid(spec, EPISODE);
  assert.equal(second, first);
  assert.equal((await fs.stat(second!)).mtimeMs, stampBefore);
});

test("a poster re-rendered under the same key is re-derived, not served stale", async () => {
  // The renderer overwrites `<key>.jpg` in place, so "the original never
  // changes" is not a safe assumption. A derivative older than its original
  // is a derivative of a poster that no longer exists.
  const spec = await makeFullPoster("9x16-redo");
  const first = await deriveGrid(spec, EPISODE);
  const before = await sharp(await fs.readFile(first!)).raw().toBuffer();
  assert.ok(before[0] < 100, "the first poster is dark blue");

  await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#c03020" } })
    .jpeg({ quality: 80 })
    .toFile(spec.path);
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(spec.path, later, later);

  const again = await deriveGrid(spec, EPISODE);
  assert.equal(again, first);
  const after = await sharp(await fs.readFile(again!)).raw().toBuffer();
  assert.ok(after[0] > 150, `the re-rendered poster is red, got R=${after[0]}`);
});

test("simultaneous requests for one poster all get a whole file and leave no temp behind", async () => {
  // The library card and the open inspector can ask for the same poster at once.
  // Several rounds, because on Windows the loser of a rename race fails only
  // some of the time and one clean round proves little.
  for (let round = 0; round < 6; round++) {
    const spec = await makeFullPoster(`9x16-race${round}`);
    const outs = await Promise.all(Array.from({ length: 8 }, () => deriveGrid(spec, EPISODE)));
    assert.ok(outs.every((o) => o && o === outs[0]), `round ${round}: every caller is handed the same path`);
    const meta = await sharp(await fs.readFile(outs[0]!)).metadata();
    assert.equal(meta.width, 324, "the file is complete and decodes");
  }
  const leftovers = (await fs.readdir(gridDir(EPISODE))).filter((n) => n.includes(".part."));
  assert.deepEqual(leftovers, []);
});

test("a degraded grid response is never cached as immutable", async () => {
  // A derivation that fails serves the full JPEG under the `?size=grid` URL.
  // If that were cached for a year the browser would never retry the
  // derivation, and one transient failure would defeat the whole point for
  // that poster.
  const broken = path.join(thumbsDir(EPISODE), "9x16-broken.jpg");
  await fs.mkdir(thumbsDir(EPISODE), { recursive: true });
  await fs.writeFile(broken, "this is not a jpeg");
  const spec: ThumbSpec = { key: "9x16-broken", aspect: "9:16", variant: "quote", path: broken, width: 1080, height: 1920, rev: 0 };
  const derived = await deriveGrid(spec, EPISODE);
  assert.equal(derived, null, "an undecodable original yields no derivative");

  const degraded = cacheControlFor("grid", derived);
  assert.doesNotMatch(degraded, /immutable/);
  assert.match(degraded, /\bno-cache\b/);
  assert.match(degraded, /^private\b/, "still never shared-cacheable");
});

test("a derivative that was made, and a plain full request, are cached for a year", () => {
  for (const header of [cacheControlFor("grid", "/x/9x16-quote.webp"), cacheControlFor(null, null)]) {
    assert.match(header, /^private\b/);
    assert.match(header, /max-age=31536000/);
    assert.match(header, /\bimmutable\b/);
  }
});

test("deriveGrid returns null rather than throwing when the original is gone", async () => {
  // Review Focus 2: a DB row outliving its file must not throw.
  const spec: ThumbSpec = {
    key: "9x16-split", aspect: "9:16", variant: "split",
    path: path.join(thumbsDir(EPISODE), "does-not-exist.jpg"),
    width: 1080, height: 1920, rev: 0,
  };
  assert.equal(await deriveGrid(spec, EPISODE), null);
});

test("a deleted grid cache is re-derived on the next call", async () => {
  const spec = await makeFullPoster("16x9-quote");
  const first = await deriveGrid(spec, EPISODE);
  await fs.rm(gridDir(EPISODE), { recursive: true, force: true });
  const again = await deriveGrid(spec, EPISODE);
  assert.equal(again, first);
  await fs.access(again!);
});

// ------------------------------------------------- choosing and retitling a poster

test("normaliseHeadline rejects empty and whitespace-only overrides", () => {
  // Review Focus 4: an all-spaces edit means "no override", not an empty poster.
  assert.equal(normaliseHeadline(""), null);
  assert.equal(normaliseHeadline("   \n\t "), null);
  assert.equal(normaliseHeadline(null), null);
  assert.equal(normaliseHeadline(42), null);
});

test("normaliseHeadline trims and caps long text", () => {
  assert.equal(normaliseHeadline("  Compounding beats talent  "), "Compounding beats talent");
  const long = normaliseHeadline("x".repeat(500));
  assert.ok(long && long.length <= 120, `expected a cap, got ${long?.length}`);
});

test("normaliseHeadline keeps markup as text, for the template to escape", () => {
  // The value is stored raw and escaped at render by the existing escapeHtml.
  // Stripping here would silently mangle a legitimate ampersand in a title.
  assert.equal(normaliseHeadline("<script>alert(1)</script>"), "<script>alert(1)</script>");
});

test("pickPoster honours the operator's choice", () => {
  const thumbs = [
    { key: "9x16-quote", aspect: "9:16" as const, variant: "quote" as const, width: 1080, height: 1920 },
    { key: "9x16-bold", aspect: "9:16" as const, variant: "bold" as const, width: 1080, height: 1920 },
  ];
  assert.equal(pickPoster(thumbs, "9x16-bold")?.key, "9x16-bold");
});

test("pickPoster falls back to the first 9:16 when the choice is stale or absent", () => {
  // Review Focus 3: a choice naming a key that no longer exists must degrade,
  // not produce a broken image.
  const thumbs = [
    { key: "16x9-quote", aspect: "16:9" as const, variant: "quote" as const, width: 1280, height: 720 },
    { key: "9x16-quote", aspect: "9:16" as const, variant: "quote" as const, width: 1080, height: 1920 },
  ];
  assert.equal(pickPoster(thumbs, "9x16-deleted")?.key, "9x16-quote");
  assert.equal(pickPoster(thumbs, null)?.key, "9x16-quote");
  assert.equal(pickPoster([], "9x16-quote"), null);
});

test("an empty-string choice is no choice at all, exactly like null", () => {
  // A hand-edited row can hold "" where the column's default is NULL. Every
  // reader must agree that the two mean the same thing.
  const thumbs = [
    { key: "16x9-quote", aspect: "16:9", variant: "quote", width: 1280, height: 720 },
    { key: "9x16-bold", aspect: "9:16", variant: "bold", width: 1080, height: 1920 },
  ];
  assert.equal(pickPoster(thumbs, "")?.key, pickPoster(thumbs, null)?.key);
  assert.equal(pickPoster(thumbs, "")?.key, "9x16-bold");
  assert.equal(pickPoster(thumbs, undefined)?.key, "9x16-bold");
});

// ------------------------------------------------------- the cache-busting revision

test("a row stored before posters carried a revision still parses, as revision 0", () => {
  // The 140 episodes already in the library were written without `rev`. They
  // must keep their posters, not lose them to a stricter parse.
  const legacy = JSON.stringify([
    { key: "9x16-quote", aspect: "9:16", variant: "quote", path: "/x/9x16-quote.jpg", width: 1080, height: 1920 },
  ]);
  const [only] = parseThumbnails({ thumbnails: legacy });
  assert.ok(only, "the legacy poster is kept");
  assert.equal(only.rev, 0);
});

test("a stored revision round-trips, and a nonsense one reads as 0 without costing the poster", () => {
  const spec = (key: string, rev: number): ThumbSpec => ({
    key, aspect: "9:16", variant: "quote", path: `/x/${key}.jpg`, width: 1080, height: 1920, rev,
  });
  const back = parseThumbnails({ thumbnails: serializeThumbnails([spec("9x16-quote", 1759571234567)]) });
  assert.equal(back[0].rev, 1759571234567);

  const odd = JSON.stringify([{ ...spec("9x16-bold", 1), rev: "yesterday" }, { ...spec("9x16-split", 1), rev: null }]);
  assert.deepEqual(parseThumbnails({ thumbnails: odd }).map((s) => [s.key, s.rev]), [["9x16-bold", 0], ["9x16-split", 0]]);
});

test("the public view of a poster carries its revision and still never its path", () => {
  const [pub] = publicThumbs([
    { key: "9x16-quote", aspect: "9:16", variant: "quote", path: "/secret/x.jpg", width: 1080, height: 1920, rev: 4242 },
  ]);
  assert.equal(pub.rev, 4242);
  assert.equal("path" in pub, false);
});

test("every poster URL carries its revision, so a redone poster is a new URL", () => {
  // Posters are served `immutable` for a year from a URL that does not change
  // when the file under it is redone. The revision is what makes a retitled
  // poster, and the full-size file an operator uploads to YouTube, fresh.
  const before = { key: "9x16-quote", rev: 1000 };
  const after = { key: "9x16-quote", rev: 2000 };

  assert.equal(thumbUrl("ep1", before), "/api/episodes/ep1/thumbnail/9x16-quote?v=1000");
  assert.equal(thumbUrl("ep1", before, "grid"), "/api/episodes/ep1/thumbnail/9x16-quote?v=1000&size=grid");
  assert.notEqual(thumbUrl("ep1", before), thumbUrl("ep1", after));
  assert.notEqual(thumbUrl("ep1", before, "grid"), thumbUrl("ep1", after, "grid"));
});

// ------------------------------------------------------------ the headline override

const COPY = {
  title: "Deep Work",
  hook: "Most people are busy. Almost nobody is focused.",
  keywords: ["busy"],
  cta: "Follow for one page a day",
};

test("a headline override replaces the big headline, not just the small title tag", () => {
  // The poster's headline is chosen by `headlineText` (hook sentence, then
  // clauses, then beat labels, and only last the title). Overriding the title
  // alone changes the eyebrow and leaves "Most people are busy." as the
  // headline, so the operator's retitle would appear to do nothing.
  const base = buildThumbHtml({ aspect: ASPECTS[0], variant: "bold", copy: COPY, photo: null, focus: null });
  assert.match(base, /Most people are/);

  const html = buildThumbHtml({
    aspect: ASPECTS[0], variant: "bold", copy: { ...COPY, headline: "Compounding beats talent" }, photo: null, focus: null,
  });
  assert.match(html, /Compounding beats talent/);
  assert.doesNotMatch(html, /Most people are/, "the generated headline is gone");
  assert.match(html, /DEEP WORK/, "the eyebrow still names the episode");
});

test("a headline override is escaped like every other piece of book text", () => {
  const html = buildThumbHtml({
    aspect: ASPECTS[1], variant: "quote", copy: { ...COPY, headline: "<script>alert(1)</script> & co" }, photo: null, focus: null,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
});

test("an empty override is the generated headline, not a blank poster", () => {
  const base = buildThumbHtml({ aspect: ASPECTS[0], variant: "bold", copy: COPY, photo: null, focus: null });
  const empty = buildThumbHtml({ aspect: ASPECTS[0], variant: "bold", copy: { ...COPY, headline: "   " }, photo: null, focus: null });
  assert.equal(empty, base);
});

// ------------------------------------------------ rebuilding a poster from the row

const BEATS = [
  { id: "hook", voiceover: "v", onScreen: "Busy is not focused", sourcePage: 2, startWord: 0, endWord: 3 },
  { id: "idea-1", voiceover: "v", onScreen: "Depth is rare", sourcePage: 4, startWord: 0, endWord: 3 },
];
const stroke = (x0: number, y0: number, x1: number, y1: number) => ({ box: { x0, y0, x1, y1 }, start: 0, end: 1 });

test("the focus box is the widest stroke on a page the poster can actually show", () => {
  // Mirrors the pipeline's own choice of crop, rebuilt from what the episode
  // row stored, so a redone poster crops where the original did.
  const plan = { sweeps: [[stroke(10, 10, 100, 30)], [stroke(0, 0, 300, 50), stroke(5, 5, 50, 20)]] };
  const pages = [{ pageIndex: 2 }, { pageIndex: 3 }, { pageIndex: 4 }];
  assert.deepEqual(focusFromPlan(plan, BEATS, pages), { pageIndex: 2, x0: 0, y0: 0, x1: 300, y1: 50 });

  // The widest stroke belongs to a page that is not in the list: skipped, not fatal.
  assert.deepEqual(focusFromPlan(plan, BEATS, [{ pageIndex: 2 }]), { pageIndex: 0, x0: 10, y0: 10, x1: 100, y1: 30 });
});

test("a plan that is missing or malformed yields no focus rather than an error", () => {
  const pages = [{ pageIndex: 2 }];
  for (const plan of [null, undefined, "x", 7, {}, { sweeps: "no" }, { sweeps: [null, [{}], [{ box: "x" }]] }]) {
    assert.equal(focusFromPlan(plan, BEATS, pages), null, JSON.stringify(plan));
  }
});

async function pageRows(dir: string, indices: number[]) {
  await fs.mkdir(dir, { recursive: true });
  const rows = [];
  for (const pageIndex of indices) {
    const derivedPath = path.join(dir, `page-${pageIndex}.jpg`);
    await sharp({ create: { width: 800, height: 1200, channels: 3, background: "#d8cfb8" } }).jpeg().toFile(derivedPath);
    // The row's own dimensions deliberately disagree with the file: the
    // pipeline measures the derived image, and a focus box is in ITS pixels.
    rows.push({ pageIndex, filePath: path.join(dir, `orig-${pageIndex}.jpg`), derivedPath, width: 3000, height: 4000 });
  }
  return rows;
}

const ROW = {
  title: "Deep Work",
  hook: "Most people are busy.",
  cta: "Follow for one page a day",
  script: JSON.stringify(BEATS),
  visualPlan: JSON.stringify({ startPage: 2, endPage: 4, startWord: 0, endWord: 0, sweeps: [[stroke(10, 10, 100, 30)], []] }),
  theme: "spotlight",
};

test("a poster source is rebuilt from the row: package, in-range pages, measured size, focus", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-src-"));
  try {
    const rows = await pageRows(dir, [1, 2, 3, 4, 5]);
    const source = await loadPosterSource(ROW, rows);
    assert.ok(source, "a complete row yields a source");

    assert.deepEqual(source.pages.map((p) => p.src), [2, 3, 4].map((i) => path.join(dir, `page-${i}.jpg`)));
    assert.deepEqual([source.pages[0].width, source.pages[0].height], [800, 1200], "measured from the image, not trusted from the row");
    assert.equal(source.pkg.title, "Deep Work");
    assert.equal(source.pkg.hook, "Most people are busy.");
    assert.equal(source.pkg.cta, "Follow for one page a day");
    assert.equal(source.pkg.beats?.[0].onScreen, "Busy is not focused");
    assert.deepEqual(source.pkg.takeaway, ["Depth is rare"], "the supporting line is rebuilt from the script");
    assert.equal(source.theme, "spotlight");
    assert.deepEqual(source.focus, { pageIndex: 0, x0: 10, y0: 10, x1: 100, y1: 30 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("without its photograph an episode cannot be redone, so no source is offered", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-src-"));
  try {
    const rows = await pageRows(dir, [2, 3, 4]);
    // The work dir was cleaned: the page the poster would be cropped from is gone.
    await fs.rm(rows[0].derivedPath!, { force: true });
    assert.equal(await loadPosterSource(ROW, rows), null);
    // No pages at all is the same absence.
    assert.equal(await loadPosterSource(ROW, []), null);
    // So is a row whose range matches nothing.
    assert.equal(await loadPosterSource(ROW, (await pageRows(dir, [9])).map((r) => ({ ...r }))), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("without its script an episode cannot be redone, so no source is offered", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-src-"));
  try {
    const rows = await pageRows(dir, [2, 3, 4]);
    for (const script of [null, "", "not json", "[]", '{"a":1}']) {
      assert.equal(await loadPosterSource({ ...ROW, script }, rows), null, `script ${JSON.stringify(script)}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a missing or unreadable plan still yields a source, cropped without a marker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-src-"));
  try {
    const rows = await pageRows(dir, [0, 1]);
    for (const visualPlan of [null, "not json", "{}"]) {
      const source = await loadPosterSource({ ...ROW, visualPlan }, rows);
      assert.ok(source, `plan ${JSON.stringify(visualPlan)}`);
      assert.equal(source.focus, null);
      assert.equal(source.pages.length, 2, "no range means every page of the upload");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------ the supporting line, from the script

const labelled = (...pairs: [string, string][]) =>
  pairs.map(([id, onScreen]) => ({ id, voiceover: "v", onScreen, sourcePage: 0, startWord: 0, endWord: 1 }));

test("the supporting line is the beat named 'takeaway' when the script has one", () => {
  const beats = labelled(["hook", "Busy is not focused"], ["takeaway", "Teach once, keep forever"], ["cta", "Follow for more"]);
  assert.equal(takeawayFromBeats(beats, "Follow for more from this book."), "Teach once, keep forever");
  // Not necessarily the last beat: the id is what counts.
  const earlier = labelled(["takeaway", "Teach once"], ["rollback", "Undo any lesson"], ["cta", "Follow for more"]);
  assert.equal(takeawayFromBeats(earlier, "Follow for more"), "Teach once");
});

test("without a 'takeaway' beat it is the last beat that is not a call to action", () => {
  // The id convention is mostly ignored by real scripts: of the 111 in the
  // library, 4 have a 'takeaway' beat. Most use positional ids, and their final
  // beat IS the call to action. Taking merely the last beat would put "Follow
  // for more" on the poster, which is the boilerplate this exists to replace.
  const stem = labelled(["b1", "The snap at the table"], ["b2", "What anger achieves"], ["b3", "Follow for more"]);
  assert.equal(takeawayFromBeats(stem, "Follow for more quiet upgrades to how you move."), "What anger achieves");

  // A CTA label that is not a stem of the CTA sentence, but opens with a CTA verb.
  const verb = labelled(["b1", "The pivot"], ["b2", "Change of subject"], ["b3", "Save it. Use it."]);
  assert.equal(takeawayFromBeats(verb, "Pick one thing you have been dragging."), "Change of subject");

  // A CTA label that opens with no CTA verb, but is a fragment of the sentence.
  const fragment = labelled(["b1", "Temple at dawn"], ["b2", "Try one hour"]);
  assert.equal(takeawayFromBeats(fragment, "Pick a block. Try one hour tonight, then follow for more."), "Temple at dawn");

  // The id said so, whatever the label looks like.
  const tagged = labelled(["b1", "Depth is rare"], ["cta", "One more thing"]);
  assert.equal(takeawayFromBeats(tagged, "Unrelated."), "Depth is rare");
});

test("a script with no call to action ends on its last beat", () => {
  // A photographed-page episode has no CTA beat; its final beat is the point.
  const photo = labelled(["b1", "The mood-check trap"], ["b2", "Own the slot"], ["b3", "Your first three steps"]);
  assert.equal(takeawayFromBeats(photo, "Pick one task, write its three steps today, and follow for more."), "Your first three steps");
});

test("with nothing usable in the script there is no supporting line, and the CTA stands", () => {
  assert.equal(takeawayFromBeats(null, "Follow for more"), null);
  assert.equal(takeawayFromBeats([], "Follow for more"), null);
  assert.equal(takeawayFromBeats([null, 7, "x", { id: "b1" }, { id: "b2", onScreen: "   " }], "x"), null);
  assert.equal(takeawayFromBeats(labelled(["b1", "Follow for more"], ["cta", "Save this"]), "Follow for more."), null);
});

test("a source carries no takeaway when the script has none to offer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-src-"));
  try {
    const rows = await pageRows(dir, [2, 3, 4]);
    const script = JSON.stringify(labelled(["b1", "Follow for more"]));
    const source = await loadPosterSource({ ...ROW, script }, rows);
    assert.ok(source);
    assert.equal(source.pkg.takeaway, undefined, "the renderer then falls back to the CTA, as it always has");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------- when the retitle button is live

test("Retitle is live for a changed headline, and for the same one after a partial redraw", () => {
  assert.equal(canRetitle("Compounding beats talent", "", 0), true, "a new headline");
  assert.equal(canRetitle("", "Compounding beats talent", 0), true, "clearing it, to go back to the generated one");
  assert.equal(canRetitle("Compounding beats talent", "Compounding beats talent", 0), false, "nothing to do");
  assert.equal(canRetitle("  Compounding beats talent ", "Compounding beats talent", 0), false, "whitespace is not a change");
  assert.equal(canRetitle("", "", 0), false);
  // After "2 posters could not be redrawn" the server HAS stored this headline,
  // so the draft equals the saved text. The operator's only way to ask again is
  // to submit it unchanged; a button that disables itself here is a dead end.
  assert.equal(canRetitle("Compounding beats talent", "Compounding beats talent", 2), true);
  assert.equal(canRetitle("", "", 1), true, "a failed reset can be retried too");
});

// ------------------------------------------------------------------ full render

const chromiumAvailable = await chromium
  .launch()
  .then((b) => b.close())
  .then(() => true)
  .catch(() => false);
const needsChromium = { skip: chromiumAvailable ? false : "chromium is not available here" };

test("each poster is stamped with the mtime of the file it was written to", needsChromium, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-rev-"));
  try {
    const specs = await generateThumbnails({
      episodeId: EPISODE,
      pkg: { title: "Deep Work", hook: "Most people are busy.", cta: "Follow", beats: BEATS },
      pages: [],
      outDir,
    });
    assert.equal(specs.length, 6);
    for (const s of specs) {
      assert.equal(s.rev, Math.trunc((await fs.stat(s.path)).mtimeMs), `${s.key} carries its own file's mtime`);
      assert.ok(s.rev > 0);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("a retitle redoes all six posters with the new words, and an empty one restores the originals", needsChromium, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-retitle-"));
  const opts = {
    episodeId: EPISODE,
    pkg: { title: "Deep Work", hook: "Most people are busy.", cta: "Follow", beats: BEATS },
    pages: [],
    outDir,
  };
  const bytes = async (specs: ThumbSpec[]) => Promise.all(specs.map((s) => fs.readFile(s.path)));
  try {
    const first = await generateThumbnails(opts);
    const firstBytes = await bytes(first);

    await new Promise((r) => setTimeout(r, 25)); // distinct mtimes even on a coarse clock
    const retitled = await generateThumbnails({ ...opts, headline: "Compounding beats talent" });
    assert.equal(retitled.length, 6, "every poster is redone, not one variant");
    const retitledBytes = await bytes(retitled);
    retitled.forEach((s, i) => {
      assert.ok(s.rev > first[i].rev, `${s.key} has a newer revision`);
      assert.ok(!retitledBytes[i].equals(firstBytes[i]), `${s.key} shows different words`);
    });

    await new Promise((r) => setTimeout(r, 25));
    const reset = await generateThumbnails({ ...opts, headline: null });
    const resetBytes = await bytes(reset);
    reset.forEach((s, i) => assert.ok(resetBytes[i].equals(firstBytes[i]), `${s.key} is back to the generated headline`));
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await fs.rm(thumbsDir(EPISODE), { recursive: true, force: true });
});
