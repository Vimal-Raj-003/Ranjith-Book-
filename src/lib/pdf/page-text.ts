/**
 * Turns raw PDF (or OCR) words into the same shape a photographed page has
 * after ingest: a `PageText`, its `wordsOf` token stream, and an alignment
 * giving every token a pixel box.
 *
 * Pure — no I/O — so every heuristic here is unit tested against fixtures.
 *
 * The two things a book page carries that are not the book's words:
 *   - furniture: running heads and page numbers, repeated in the margins of
 *     page after page. Left in, "CHAPTER THREE 47" lands mid-sentence in every
 *     passage and in every quote an idea is grounded on.
 *   - headings: kept out of `paragraphs` (exactly as the vision reader keeps
 *     them in `chapterHeading`), because a beat's word indices address body
 *     text, and because they are the best signal for where chapters start.
 */
import { wordsOf, type PageText } from "../ingest/vision";
import { alignWords, normalizeToken } from "../ingest/align";
import { buildLineRuns } from "../ingest/lines";
import type { Box, OcrWord } from "../ingest/ocr";
import type { PageHeading, RawLine, RawPdfPage, StructuredPage, TextSource } from "../analysis/types";

export interface LineWord {
  text: string;
  box: Box;
}

/** One printed line. `block` groups lines into paragraphs. */
export interface PageLine {
  words: LineWord[];
  block: number;
  top: number;
  bottom: number;
  /** Largest font size on the line; 0 when unknown (OCR). */
  size: number;
}

export interface LinedPage {
  pageIndex: number;
  label: string | null;
  width: number;
  height: number;
  lines: PageLine[];
  source: TextSource;
  ocrConfidence: number | null;
}

/** Share of page height at the top and bottom where running heads live. */
const MARGIN_BAND = 0.09;
/** A line this much larger than body text is a heading. */
const HEADING_SCALE = 1.25;

const CHAPTER_RE =
  /^(chapter|part|book|lesson|section)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;

function lineText(line: PageLine): string {
  return line.words.map((w) => w.text).join(" ");
}

function unionBox(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/** Group PyMuPDF words into lines by their (block, line) numbers. */
export function linesFromRaw(page: RawPdfPage): PageLine[] {
  const byKey = new Map<string, { block: number; words: LineWord[] }>();
  const order: string[] = [];
  for (const [x0, y0, x1, y1, text, block, line] of page.words) {
    if (!text.trim()) continue;
    const key = `${block}:${line}`;
    if (!byKey.has(key)) {
      byKey.set(key, { block, words: [] });
      order.push(key);
    }
    byKey.get(key)!.words.push({ text: text.normalize("NFKC"), box: { x0, y0, x1, y1 } });
  }

  return order.map((key) => {
    const { block, words } = byKey.get(key)!;
    const box = unionBox(words.map((w) => w.box));
    return { words, block, top: box.y0, bottom: box.y1, size: sizeOfLine(box, page.lines) };
  });
}

/** Font size of the `dict` line that overlaps this word line the most. */
function sizeOfLine(box: Box, lines: RawLine[]): number {
  let best = 0;
  let bestOverlap = 0;
  for (const l of lines) {
    const [x0, y0, x1, y1] = l.box;
    const ox = Math.max(0, Math.min(x1, box.x1) - Math.max(x0, box.x0));
    const oy = Math.max(0, Math.min(y1, box.y1) - Math.max(y0, box.y0));
    const overlap = ox * oy;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = l.size;
    }
  }
  return best;
}

/**
 * Group OCR words (a flat list with boxes, no structure) into lines by their
 * vertical centres, and lines into paragraphs by the gaps between them.
 */
export function linesFromOcr(words: OcrWord[]): PageLine[] {
  const usable = words.filter((w) => /[\p{L}\p{N}]/u.test(w.text));
  if (usable.length === 0) return [];

  const heights = usable.map((w) => w.box.y1 - w.box.y0).sort((a, b) => a - b);
  const lineHeight = Math.max(1, heights[Math.floor(heights.length / 2)]);
  const centre = (b: Box) => (b.y0 + b.y1) / 2;

  const sorted = [...usable].sort((a, b) => centre(a.box) - centre(b.box) || a.box.x0 - b.box.x0);
  const rows: OcrWord[][] = [];
  for (const w of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(centre(w.box) - centre(row[0].box)) < lineHeight * 0.6) row.push(w);
    else rows.push([w]);
  }

  let block = 0;
  let prevBottom: number | null = null;
  return rows.map((row) => {
    row.sort((a, b) => a.box.x0 - b.box.x0);
    const box = unionBox(row.map((w) => w.box));
    if (prevBottom !== null && box.y0 - prevBottom > lineHeight * 0.9) block++;
    prevBottom = box.y1;
    return {
      words: row.map((w) => ({ text: w.text.normalize("NFKC"), box: w.box })),
      block,
      top: box.y0,
      bottom: box.y1,
      size: 0,
    };
  });
}

// --- Furniture ------------------------------------------------------------

const PAGE_NUMBER_RE = /^(page\s+)?([0-9]{1,4}|[ivxlcdm]{1,7})(\s+of\s+[0-9]{1,4})?$/i;

/** A margin line's identity across pages: its letters, with numbers dropped. */
function furnitureKey(text: string): string {
  return normalizeToken(text.replace(/[0-9]+/g, " "));
}

function inMargin(line: PageLine, height: number): boolean {
  return line.bottom <= height * MARGIN_BAND || line.top >= height * (1 - MARGIN_BAND);
}

/**
 * Which margin lines are furniture, per page. A line qualifies when it sits in
 * the top or bottom band AND any of:
 *   - it is a bare page number;
 *   - it recurs (numbers aside) on several pages;
 *   - it repeats a heading from elsewhere in the book — the chapter title as
 *     a running head, which in a book of short chapters may appear only once
 *     or twice and so never reaches the repeat count;
 *   - it sits in the top band in type smaller than the body text, the way
 *     running heads are set (a heading high on a page is larger, not smaller).
 */
export function detectFurniture(pages: LinedPage[], bodySize = 0): Set<PageLine> {
  const repeatThreshold = pages.length <= 3 ? 2 : 3;
  const counts = new Map<string, number>();
  const headingKeys = new Set<string>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const line of page.lines) {
      if (bodySize > 0 && line.size >= bodySize * HEADING_SCALE) {
        const key = furnitureKey(lineText(line));
        if (key) headingKeys.add(key);
      }
      if (!inMargin(line, page.height)) continue;
      const key = furnitureKey(lineText(line));
      if (key && !seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  const furniture = new Set<PageLine>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (!inMargin(line, page.height)) continue;
      const text = lineText(line).trim();
      const key = furnitureKey(text);
      const smallTop =
        bodySize > 0 && line.size > 0 && line.size < bodySize * 0.92 &&
        line.bottom <= page.height * MARGIN_BAND && text.split(/\s+/).length <= 14;
      if (
        PAGE_NUMBER_RE.test(text) ||
        (key && (counts.get(key) ?? 0) >= repeatThreshold) ||
        (key && headingKeys.has(key) && line.size < bodySize * HEADING_SCALE) ||
        smallTop
      ) {
        furniture.add(line);
      }
    }
  }
  return furniture;
}

// --- Headings -------------------------------------------------------------

/** Body text size: the character-weighted median line size across the book. */
export function bodyFontSize(pages: RawPdfPage[]): number {
  const samples: { size: number; chars: number }[] = [];
  for (const p of pages) for (const l of p.lines) if (l.size > 0) samples.push(l);
  if (samples.length === 0) return 0;
  samples.sort((a, b) => a.size - b.size);
  const total = samples.reduce((s, l) => s + l.chars, 0);
  let acc = 0;
  for (const l of samples) {
    acc += l.chars;
    if (acc >= total / 2) return l.size;
  }
  return samples[samples.length - 1].size;
}

function isHeadingLine(line: PageLine, bodySize: number, height: number): boolean {
  const text = lineText(line).trim();
  if (!/\p{L}/u.test(text) || text.length > 120) return false;
  if (bodySize > 0 && line.size >= bodySize * HEADING_SCALE) return true;
  // "Chapter 3" at body size or larger, near the top: a chapter opener set in
  // a font that is not much bigger than the text (and the only signal an OCR'd
  // page has at all, since OCR reports no font sizes).
  return CHAPTER_RE.test(text) && text.split(/\s+/).length <= 12 && line.top < height * 0.5 &&
    (line.size === 0 || bodySize === 0 || line.size >= bodySize * 0.95);
}

/**
 * Heading lines that sit together ("Chapter 1" over "The Power of Tiny Gains")
 * are one heading, joined with a colon.
 */
function groupHeadings(lines: PageLine[], bodySize: number, height: number): PageHeading[] {
  const headings: PageHeading[] = [];
  let prev: PageLine | null = null;
  for (const line of lines) {
    const lh = line.bottom - line.top;
    const text = lineText(line).trim();
    const scale = bodySize > 0 && line.size > 0 ? line.size / bodySize : 1;
    const last = headings[headings.length - 1];
    if (last && prev && line.top - prev.bottom < lh * 2.5) {
      last.text = `${last.text}: ${text}`;
      last.scale = Math.max(last.scale, scale);
    } else {
      headings.push({ text, scale, top: line.top / height });
    }
    prev = line;
  }
  return headings;
}

// --- The page -------------------------------------------------------------

/**
 * Build one page's `PageText`, token stream and word boxes from its lines,
 * with furniture removed and headings lifted into `chapterHeading`.
 *
 * Hyphenated line breaks: a line ending "con-" followed by a line starting
 * "tration" is written into the paragraph as "con-\ntration", exactly the
 * form the vision reader is told to produce, so `wordsOf` rejoins it into
 * "contration" by the same rule. The box list is merged the same way before
 * alignment, so the rejoined word still gets a box (its first half's).
 */
export function structurePage(
  page: LinedPage,
  furniture: Set<PageLine>,
  bodySize: number,
): StructuredPage {
  const body: PageLine[] = [];
  const headingLines: PageLine[] = [];
  for (const line of page.lines) {
    if (furniture.has(line)) continue;
    if (isHeadingLine(line, bodySize, page.height)) headingLines.push(line);
    else body.push(line);
  }

  const headings = groupHeadings(headingLines, bodySize, page.height);

  const paragraphs: string[] = [];
  const layer: OcrWord[] = [];
  // Body lines whose first word was already merged into the line above.
  const firstWordTaken = new Set<number>();
  let current: string[] = [];
  let currentBlock: number | null = null;

  for (let li = 0; li < body.length; li++) {
    const line = body[li];
    if (currentBlock !== null && line.block !== currentBlock && current.length) {
      paragraphs.push(current.join("\n"));
      current = [];
    }
    currentBlock = line.block;
    current.push(line.words.map((w) => w.text).join(" "));

    for (let wi = 0; wi < line.words.length; wi++) {
      if (wi === 0 && firstWordTaken.has(li)) continue;
      const w = line.words[wi];
      const next = body[li + 1];
      const lastOnLine = wi === line.words.length - 1;
      if (lastOnLine && /\p{L}-$/u.test(w.text) && next && next.block === line.block && next.words.length) {
        layer.push({ text: w.text.slice(0, -1) + next.words[0].text, confidence: 100, box: w.box });
        firstWordTaken.add(li + 1);
        continue;
      }
      layer.push({ text: w.text, confidence: 100, box: w.box });
    }
  }
  if (current.length) paragraphs.push(current.join("\n"));

  const text: PageText = {
    pageIndex: page.pageIndex,
    chapterHeading: headings.length ? headings.map((h) => h.text).join(" — ") : null,
    paragraphs,
    legible: paragraphs.length > 0 || headings.length > 0,
    note: paragraphs.length ? null : "No body text on this page.",
  };
  const words = wordsOf(text);
  const { aligned, confidence } = alignWords(words, layer);
  const { words: alignment } = buildLineRuns(aligned);

  return {
    pageIndex: page.pageIndex,
    label: page.label,
    text,
    words,
    alignment,
    alignmentConfidence: confidence,
    headings,
    source: words.length ? page.source : "none",
    ocrConfidence: page.ocrConfidence,
  };
}

/** Structure every page of a book at once — furniture is a whole-book fact. */
export function structurePages(pages: LinedPage[], bodySize: number): StructuredPage[] {
  const furniture = detectFurniture(pages, bodySize);
  return pages.map((p) => structurePage(p, furniture, bodySize));
}

/**
 * A page needs OCR when its text layer is (nearly) empty. Image coverage is
 * not required: a scan wrapped with a white border, or a page of line art,
 * reads the same way — no words means no words, whatever the pixels show.
 */
export function needsOcr(page: RawPdfPage): boolean {
  const chars = page.words.reduce((s, w) => s + w[4].trim().length, 0);
  return chars < 25 && (page.imageCount > 0 || page.imageCoverage > 0);
}
