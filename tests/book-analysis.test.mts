import test from "node:test";
import assert from "node:assert/strict";
import { wordsOf } from "../src/lib/ingest/vision";
import {
  detectFurniture,
  linesFromOcr,
  linesFromRaw,
  structurePage,
  structurePages,
  needsOcr,
  type LinedPage,
} from "../src/lib/pdf/page-text";
import { detectSections, isMatterTitle } from "../src/lib/analysis/sections";
import { buildWindows, chunkSections, CHUNK_MAX } from "../src/lib/analysis/chunks";
import { locateQuote, tokenStream, mergeRefs } from "../src/lib/analysis/quotes";
import { groundCandidates, ideasPerWindow } from "../src/lib/analysis/candidates";
import { applyRanking, weightedScore } from "../src/lib/analysis/rank";
import { selectIdeas, ideaKeys } from "../src/lib/analysis/select";
import { lexicalEmbedder, cosine, toBytes, fromBytes } from "../src/lib/analysis/embed";
import type { RawPdfPage, RawWord, ScoredCandidate, StructuredPage, IdeaScores } from "../src/lib/analysis/types";

// --- fixtures ---------------------------------------------------------------

const H = 1600;
const W = 1067;

/** Lay out lines of text as a RawPdfPage, one block per paragraph. */
function rawPage(
  index: number,
  spec: { head?: string; foot?: string; heading?: string; paragraphs: string[][] },
): RawPdfPage {
  const words: RawWord[] = [];
  const lines: RawPdfPage["lines"] = [];
  let block = 0;
  const put = (text: string, y: number, size: number, b: number, ln: number) => {
    let x = 130;
    text.split(" ").forEach((t, i) => {
      const w = t.length * size * 0.9;
      words.push([x, y, x + w, y + size * 2, t, b, ln, i]);
      x += w + 10;
    });
    lines.push({ text, size, bold: false, chars: text.length, box: [130, y, x, y + size * 2] });
  };
  if (spec.head) put(spec.head, 50, 8, block++, 0);
  let y = 150;
  if (spec.heading) {
    put(spec.heading, y, 20, block++, 0);
    y += 80;
  }
  for (const para of spec.paragraphs) {
    para.forEach((line, ln) => {
      put(line, y, 11, block, ln);
      y += 36;
    });
    block++;
    y += 14;
  }
  if (spec.foot) put(spec.foot, 1520, 9, block++, 0);
  return { index, label: String(index + 1), image: "", width: W, height: H, words, lines, imageCount: 0, imageCoverage: 0 };
}

function lined(raw: RawPdfPage): LinedPage {
  return { pageIndex: raw.index, label: raw.label, width: W, height: H, lines: linesFromRaw(raw), source: "text-layer", ocrConfidence: null };
}

function structuredFromText(pages: { heading?: string; text: string }[]): StructuredPage[] {
  return pages.map((p, i) => {
    const text = { pageIndex: i, chapterHeading: p.heading ?? null, paragraphs: p.text.split("\n\n"), legible: true, note: null };
    return {
      pageIndex: i,
      label: String(i + 1),
      text,
      words: wordsOf(text),
      alignment: [],
      alignmentConfidence: 1,
      headings: p.heading ? [{ text: p.heading, scale: 1.8, top: 0.1 }] : [],
      source: "text-layer",
      ocrConfidence: null,
    };
  });
}

const lorem = (n: number, seed = 0) =>
  Array.from({ length: n }, (_, i) => `word${(i + seed) % 97}${i % 5 === 4 ? "." : ""}`).join(" ");

// --- page text ----------------------------------------------------------------

test("running heads and page numbers are stripped, headings lifted out of the body", () => {
  const raws = [0, 1, 2, 3].map((i) =>
    rawPage(i, {
      head: "THE SURPRISING POWER OF TINY GAINS",
      foot: String(i + 11),
      heading: i === 0 ? "The Surprising Power of Tiny Gains" : undefined,
      paragraphs: [["Small habits compound over time", "when repeated every day."]],
    }),
  );
  const pages = structurePages(raws.map(lined), 11);
  for (const p of pages) {
    assert.ok(!p.words.includes("SURPRISING"), "the running head is gone");
    assert.ok(!p.words.some((w) => /^1[0-9]$/.test(w)), "the page number is gone");
    assert.deepEqual(p.words.slice(0, 3), ["Small", "habits", "compound"]);
  }
  assert.equal(pages[0].text.chapterHeading, "The Surprising Power of Tiny Gains");
  assert.equal(pages[0].headings.length, 1);
  assert.equal(pages[1].headings.length, 0);
});

test("a body-size margin line that appears once is not furniture", () => {
  const raws = [rawPage(0, { paragraphs: [["Body text here."]] }), rawPage(1, { paragraphs: [["More body."]] })];
  // A line of body-size text high on the first page, as a first line can be.
  raws[0].words.push([130, 40, 300, 62, "Opening", 99, 0, 0], [310, 40, 400, 62, "words", 99, 0, 1]);
  raws[0].lines.push({ text: "Opening words", size: 11, bold: false, chars: 13, box: [130, 40, 400, 62] });
  const furniture = detectFurniture(raws.map(lined), 11);
  assert.equal(furniture.size, 0);
});

test("a running head seen once is still furniture: small type at the top, or a chapter title", () => {
  const raws = [
    rawPage(0, { heading: "Why Motivation Fails", paragraphs: [["Body."]] }),
    rawPage(1, { head: "Why Motivation Fails", paragraphs: [["More body."]] }),
  ];
  const pages = structurePages(raws.map(lined), 11);
  assert.deepEqual(pages[1].words, ["More", "body."]);
  assert.equal(pages[0].text.chapterHeading, "Why Motivation Fails", "the real heading is kept");
});

test("a hyphenated line break becomes one word, and that word keeps a box", () => {
  const raw = rawPage(0, { paragraphs: [["The habit of concen-", "tration takes practice."]] });
  const page = structurePage(lined(raw), new Set(), 11);
  assert.ok(page.words.includes("concentration"), page.words.join(" "));
  assert.equal(page.words.length, 6);
  const w = page.alignment.find((a) => a.word === "concentration");
  assert.ok(w?.box, "the rejoined word is aligned to the first fragment's box");
  assert.equal(page.alignmentConfidence, 1);
  assert.deepEqual(page.words, wordsOf(page.text), "words are exactly wordsOf(text) — the index space beats use");
});

test("paragraphs follow PDF blocks", () => {
  const raw = rawPage(0, { paragraphs: [["First paragraph line one", "line two."], ["Second paragraph."]] });
  const page = structurePage(lined(raw), new Set(), 11);
  assert.equal(page.text.paragraphs.length, 2);
});

test("OCR words are grouped into lines and paragraphs by position", () => {
  const box = (x: number, y: number) => ({ x0: x, y0: y, x1: x + 50, y1: y + 20 });
  const lines = linesFromOcr([
    { text: "world", confidence: 90, box: box(200, 101) },
    { text: "Hello", confidence: 90, box: box(100, 100) },
    { text: "again", confidence: 90, box: box(100, 130) },
    { text: "New", confidence: 90, box: box(100, 220) },
    { text: "~", confidence: 10, box: box(300, 300) },
  ]);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].words.map((w) => w.text), ["Hello", "world"]);
  assert.equal(lines[0].block, lines[1].block, "adjacent lines share a paragraph");
  assert.notEqual(lines[1].block, lines[2].block, "a gap starts a new paragraph");
});

test("a page with no text layer but an image needs OCR; a text page does not", () => {
  const scan = { ...rawPage(0, { paragraphs: [] }), imageCount: 1, imageCoverage: 1 };
  assert.equal(needsOcr(scan), true);
  assert.equal(needsOcr(rawPage(0, { paragraphs: [[lorem(20)]] })), false);
  assert.equal(needsOcr(rawPage(0, { paragraphs: [] })), false, "a blank page with no image has nothing to OCR");
});

// --- sections -------------------------------------------------------------------

test("the PDF outline defines sections, with front matter before it skipped", () => {
  const pages = structuredFromText(Array.from({ length: 8 }, () => ({ text: lorem(120) })));
  const sections = detectSections(pages, [
    { level: 1, title: "Chapter One", page: 2 },
    { level: 1, title: "Chapter Two", page: 5 },
  ]);
  assert.deepEqual(sections.map((s) => [s.title, s.startPage, s.endPage, s.skip]), [
    ["Front matter", 0, 1, true],
    ["Chapter One", 2, 4, false],
    ["Chapter Two", 5, 7, false],
  ]);
  assert.equal(sections[1].source, "toc");
});

test("an outline with one top-level entry falls through to its chapters", () => {
  const pages = structuredFromText(Array.from({ length: 6 }, () => ({ text: lorem(60) })));
  const sections = detectSections(pages, [
    { level: 1, title: "Part One", page: 0 },
    { level: 2, title: "A", page: 0 },
    { level: 2, title: "B", page: 3 },
  ]);
  assert.deepEqual(sections.map((s) => s.title), ["A", "B"]);
});

test("headings define sections when there is no outline", () => {
  const pages = structuredFromText([
    { heading: "Contents", text: lorem(40) },
    { heading: "Chapter 1: Start", text: lorem(200) },
    { text: lorem(200) },
    { heading: "Chapter 2: Middle", text: lorem(200) },
    { text: lorem(200) },
  ]);
  const sections = detectSections(pages, []);
  assert.deepEqual(sections.map((s) => [s.title, s.source, s.skip]), [
    ["Contents", "heading", true],
    ["Chapter 1: Start", "heading", false],
    ["Chapter 2: Middle", "heading", false],
  ]);
});

test("a book with no outline and no headings is split into 10-page parts", () => {
  const pages = structuredFromText(Array.from({ length: 23 }, () => ({ text: lorem(100) })));
  const sections = detectSections(pages, []);
  assert.deepEqual(sections.map((s) => s.title), ["Pages 1–10", "Pages 11–20", "Pages 21–23"]);
  assert.ok(sections.every((s) => s.source === "fallback"));
});

test("front and back matter titles are recognised", () => {
  for (const t of ["Contents", "Table of Contents", "Acknowledgments", "Index", "Notes", "About the Author", "Copyright"]) {
    assert.ok(isMatterTitle(t), t);
  }
  for (const t of ["The Index Fund Revolution", "Notes on Courage", "Chapter 1"]) assert.ok(!isMatterTitle(t), t);
});

// --- chunks and windows ------------------------------------------------------------

test("chunks cover every body word exactly once and never cross a section", () => {
  const pages = structuredFromText(Array.from({ length: 12 }, (_, i) => ({ text: `${lorem(150, i)}\n\n${lorem(170, i + 3)}` })));
  const sections = detectSections(pages, [
    { level: 1, title: "One", page: 0 },
    { level: 1, title: "Two", page: 5 },
  ]);
  const chunks = chunkSections(pages, sections);
  const seen = new Set<string>();
  for (const c of chunks) {
    const section = sections[c.sectionIndex];
    let text: string[] = [];
    for (const s of c.spans) {
      assert.ok(s.pageIndex >= section.startPage && s.pageIndex <= section.endPage, "span inside its section");
      for (let w = s.startWord; w <= s.endWord; w++) {
        const key = `${s.pageIndex}:${w}`;
        assert.ok(!seen.has(key), `word ${key} in two chunks`);
        seen.add(key);
      }
      text = text.concat(pages[s.pageIndex].words.slice(s.startWord, s.endWord + 1));
    }
    assert.equal(c.text, text.join(" "), "chunk text is exactly the words its spans point at");
    assert.ok(c.wordCount <= CHUNK_MAX + 60, `chunk of ${c.wordCount} words`);
  }
  const total = pages.reduce((s, p) => s + p.words.length, 0);
  assert.equal(seen.size, total);
});

test("skipped sections are not chunked", () => {
  const pages = structuredFromText([{ text: lorem(200) }, { text: lorem(200) }]);
  const chunks = chunkSections(pages, [
    { index: 0, title: "Index", level: 1, startPage: 0, endPage: 0, source: "toc", skip: true, wordCount: 200 },
    { index: 1, title: "Body", level: 1, startPage: 1, endPage: 1, source: "toc", skip: false, wordCount: 200 },
  ]);
  assert.ok(chunks.every((c) => c.sectionIndex === 1));
});

test("windows hold about 3,500 words and fold a tiny tail into the previous one", () => {
  const chunks = Array.from({ length: 50 }, (_, i) => ({
    index: i, sectionIndex: Math.floor(i / 10), spans: [{ pageIndex: i, startWord: 0, endWord: 199 }],
    text: "", wordCount: 200, startPage: i, endPage: i,
  }));
  const windows = buildWindows(chunks);
  assert.equal(windows.flatMap((w) => w.chunkIndices).length, 50, "every chunk in exactly one window");
  for (const w of windows) assert.ok(w.wordCount <= 3500 * 1.15 + 200, `${w.wordCount}`);
  assert.ok(windows.length >= 3 && windows.length <= 5);
});

test("ideas per window keep the pool healthy for short and long books", () => {
  assert.equal(ideasPerWindow(1), 8);
  assert.equal(ideasPerWindow(20), 3);
  assert.equal(ideasPerWindow(6), 8);
});

// --- quotes -------------------------------------------------------------------

const book = structuredFromText([
  { text: "Habits are the compound interest of self-improvement. The same way that money multiplies through compound interest, the effects of your habits multiply as you repeat them." },
  { text: "Getting one percent better every day counts for a lot in the long run. It is easy to overestimate the importance of one defining moment." },
]);
const stream = tokenStream(book, [0, 1]);

test("a verbatim quote is found and pointed at exactly", () => {
  const q = locateQuote("the effects of your habits multiply as you repeat them", stream, book);
  assert.ok(q);
  assert.equal(q.refs.length, 1);
  assert.equal(q.refs[0].pageIndex, 0);
  assert.equal(q.text, "the effects of your habits multiply as you repeat them.");
});

test("case, punctuation and a dropped word are tolerated", () => {
  const q = locateQuote("Getting 1 percent better every day counts for a lot in the long run", stream, book);
  assert.ok(q, "one wrong token out of 14 still matches");
  assert.equal(q.refs[0].pageIndex, 1);
});

test("a quote spanning a page break points at both pages", () => {
  const q = locateQuote("as you repeat them. Getting one percent better every day", stream, book);
  assert.ok(q);
  assert.deepEqual(q.refs.map((r) => r.pageIndex), [0, 1]);
});

test("a paraphrase or invention is not found", () => {
  assert.equal(locateQuote("small changes produce remarkable results if you are patient enough", stream, book), null);
  assert.equal(locateQuote("compound interest", stream, book), null, "too short to prove anything");
});

test("overlapping refs on a page merge", () => {
  assert.deepEqual(mergeRefs([{ pageIndex: 1, startWord: 5, endWord: 9 }, { pageIndex: 1, startWord: 8, endWord: 12 }, { pageIndex: 0, startWord: 0, endWord: 2 }]), [
    { pageIndex: 0, startWord: 0, endWord: 2 },
    { pageIndex: 1, startWord: 5, endWord: 12 },
  ]);
});

test("candidates are kept only when a quote is found, and cite the book's own words", () => {
  const window = { index: 0, chunkIndices: [], sectionIndices: [0], pages: [0, 1], wordCount: 60 };
  const sections = detectSections(book, []);
  const reply = {
    ideas: [
      { title: "Habits compound", coreIdea: "Tiny habits multiply.", hook: "h", whyItMatters: "w", angle: "mental-model",
        hookPotential: "", storyPotential: "", practicalValue: "", visualPotential: "", strength: 8,
        quotes: [{ page: 1, text: "Habits are the compound interest of self-improvement" }, { page: 1, text: "this sentence was never in the book at all" }] },
      { title: "Invented", coreIdea: "Not in the book.", strength: 9, quotes: [{ page: 2, text: "an entirely made up line that is not there" }] },
      { title: "", coreIdea: "no title", quotes: [] },
    ],
  };
  const r = groundCandidates(reply, window, book, sections);
  assert.equal(r.proposed, 3);
  assert.equal(r.ungrounded, 2);
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0].quotes, ["Habits are the compound interest of self-improvement."]);
  assert.equal(r.candidates[0].refs[0].pageIndex, 0);
});

test("overlapping quotes are cited once, and the source text is exactly what the refs point at", () => {
  const window = { index: 0, chunkIndices: [], sectionIndices: [0], pages: [0, 1], wordCount: 60 };
  const r = groundCandidates(
    { ideas: [{ title: "t", coreIdea: "c", strength: 7, quotes: [
      { page: 1, text: "the effects of your habits multiply as you repeat them" },
      { page: 1, text: "Habits are the compound interest of self-improvement" },
      { page: 1, text: "your habits multiply as you repeat them. Getting one percent" },
    ] }] },
    window, book, detectSections(book, []),
  );
  const c = r.candidates[0];
  const cited = c.refs.map((ref) => book[ref.pageIndex].words.slice(ref.startWord, ref.endWord + 1).join(" "));
  assert.deepEqual(c.quotes, cited);
  assert.equal(c.refs.filter((ref) => ref.pageIndex === 0).length, 2, "two separate passages on page 1, the overlap merged");
});

// --- ranking and selection -------------------------------------------------------

const uniform = (n: number): IdeaScores => ({
  viewerUsefulness: n, educationalValue: n, hookPotential: n, storyPotential: n, practicalValue: n,
  emotionalInterest: n, uniqueness: n, youtubeSuitability: n, visualPotential: n,
});

function cand(id: string, score: number, section = 0, dup: string | null = null): ScoredCandidate {
  return {
    id, windowIndex: 0, title: id, coreIdea: id, hook: "", whyItMatters: "", angle: "other",
    hookPotential: "", storyPotential: "", practicalValue: "", visualPotential: "", strength: 5,
    refs: [{ pageIndex: 0, startWord: 0, endWord: 1 }], quotes: [], sectionIndex: section,
    scores: uniform(score), score, duplicateOf: dup,
  };
}

test("the ranker's scores are applied; a skipped candidate keeps its own strength", () => {
  const c = [cand("a", 0), cand("b", 0)].map((s) => ({ ...s, strength: 6 }));
  const { scored, missing } = applyRanking(c, { scores: [{ id: "a", ...uniform(9), duplicateOf: "zzz" }] });
  assert.equal(missing, 1);
  assert.equal(scored[0].score, 9);
  assert.equal(scored[0].duplicateOf, null, "a duplicateOf pointing at no candidate is ignored");
  assert.equal(scored[1].score, 6);
  assert.equal(weightedScore(uniform(7)), 7);
});

test("duplicates go — by the ranker's mark in either direction, and by embedding", () => {
  const unit = (i: number) => {
    const v = new Float32Array(4);
    v[i] = 1;
    return v;
  };
  const cs = [cand("a", 9), cand("b", 8, 0, null), cand("c", 7, 0, null), cand("d", 6)];
  cs[0].duplicateOf = "b"; // marked on the stronger one — the weaker must still go
  const vectors = new Map([["a", unit(0)], ["b", unit(1)], ["c", unit(0)], ["d", unit(2)]]);
  const { selected, duplicates } = selectIdeas(cs, vectors, { min: 1 });
  assert.deepEqual(selected.map((c) => c.id).sort(), ["a", "d"]);
  assert.deepEqual(duplicates.map((d) => [d.id, d.of]).sort(), [["b", "a"], ["c", "a"]]);
});

test("selection returns at most 20, prefers variety, and drops weak ideas only down to 14", () => {
  const cs = Array.from({ length: 30 }, (_, i) => cand(`c${i}`, 9 - i * 0.2, i % 6));
  const vectors = new Map(cs.map((c, i) => {
    const v = new Float32Array(32);
    v[i] = 1;
    return [c.id, v];
  }));
  const { selected } = selectIdeas(cs, vectors);
  assert.equal(selected.length, 20);
  const weak = Array.from({ length: 20 }, (_, i) => cand(`w${i}`, i < 10 ? 8 : 3, i % 5));
  const r = selectIdeas(weak, new Map());
  assert.equal(r.selected.length, 14, "10 strong + 4 weak to reach the minimum");
});

test("dedup runs before the 14–20 cap: near-duplicates never crowd distinct ideas off the list", () => {
  // Ten strong candidates that are all the same idea (identical vectors),
  // then twenty weaker but distinct ones. Capping first would keep the ten
  // copies; deduplicating first keeps one of them plus distinct ideas.
  const same = new Float32Array(64);
  same[0] = 1;
  const cs = [
    ...Array.from({ length: 10 }, (_, i) => cand(`dup${i}`, 9.5 - i * 0.01, i % 5)),
    ...Array.from({ length: 20 }, (_, i) => cand(`d${i}`, 7 - i * 0.05, i % 5)),
  ];
  const vectors = new Map(cs.map((c, i) => {
    if (c.id.startsWith("dup")) return [c.id, same];
    const v = new Float32Array(64);
    v[i] = 1;
    return [c.id, v];
  }));
  const { selected, duplicates } = selectIdeas(cs, vectors);
  assert.equal(selected.filter((c) => c.id.startsWith("dup")).length, 1, "one copy survives");
  assert.equal(duplicates.length, 9);
  assert.equal(selected.length, 20, "the list is refilled with distinct ideas");
  assert.equal(new Set(selected.map((c) => c.id)).size, 20);
});

test("the selection is never more than 20 and never padded past what exists", () => {
  for (const n of [0, 3, 14, 19, 20, 21, 90]) {
    const cs = Array.from({ length: n }, (_, i) => cand(`c${i}`, 8, i % 6));
    const { selected } = selectIdeas(cs, new Map());
    assert.equal(selected.length, Math.min(n, 20), `${n} candidates`);
  }
});

test("no section takes over the list when the book has many sections", () => {
  const cs = [
    ...Array.from({ length: 15 }, (_, i) => cand(`hot${i}`, 9, 0)),
    ...Array.from({ length: 15 }, (_, i) => cand(`s${i}`, 7, 1 + (i % 5))),
  ];
  const { selected } = selectIdeas(cs, new Map());
  assert.ok(selected.filter((c) => c.sectionIndex === 0).length <= 6);
});

test("idea keys are kebab-case and unique", () => {
  assert.deepEqual(ideaKeys(["Why Habits Compound!", "Why habits compound", "Café culture"]), [
    "why-habits-compound", "why-habits-compound-2", "cafe-culture",
  ]);
});

// --- embeddings -------------------------------------------------------------------

test("the lexical fallback embedder ranks related text above unrelated text", async () => {
  const [a, b, c] = await lexicalEmbedder.embed([
    "habits compound over time with daily repetition",
    "daily habits compounding over a long time",
    "the recipe needs two cups of flour",
  ]);
  assert.ok(cosine(a, b) > cosine(a, c));
  assert.deepEqual([...fromBytes(toBytes(a))], [...a], "vectors survive the database round trip");
});
