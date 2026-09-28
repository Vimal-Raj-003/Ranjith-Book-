/**
 * Grounding by lookup, not by trust.
 *
 * The model is asked to back every idea with short verbatim quotes. It is not
 * asked for word indices — counting to word 2,317 of a 3,500-word window is
 * exactly what models are bad at. Instead each quote is searched for here, in
 * the actual page words, and its position becomes the idea's source reference.
 *
 * A quote that cannot be found is the cheapest hallucination detector there
 * is: an idea the book does not contain cannot quote it. Matching tolerates
 * what honest copying does to text (case, punctuation, curly quotes, a dropped
 * or doubled word) and nothing more — see `MIN_MATCH`.
 */
import { normalizeToken } from "../ingest/align";
import type { SourceRef, StructuredPage } from "./types";

/** Share of a quote's words that must appear, in order, in the book. */
export const MIN_MATCH = 0.85;
/** Quotes shorter than this are too generic to prove anything. */
export const MIN_QUOTE_WORDS = 5;

export interface StreamToken {
  pageIndex: number;
  wordIndex: number;
  norm: string;
}

export function tokenStream(pages: StructuredPage[], pageIndices: number[]): StreamToken[] {
  const out: StreamToken[] = [];
  for (const pi of pageIndices) {
    const page = pages[pi];
    if (!page) continue;
    page.words.forEach((w, wordIndex) => {
      const norm = normalizeToken(w);
      if (norm) out.push({ pageIndex: pi, wordIndex, norm });
    });
  }
  return out;
}

export interface LocatedQuote {
  refs: SourceRef[];
  /** The quote as the book prints it, rebuilt from the page words. */
  text: string;
  match: number;
}

/** LCS of `q` against `s`, returning the matched positions in `s`. */
function lcsPositions(q: string[], s: string[]): number[] {
  const n = q.length;
  const m = s.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = q[i] === s[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pos: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (q[i] === s[j]) {
      pos.push(j);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pos;
}

/**
 * Find `quote` in `stream`. Anchors on every place the quote's rarest-looking
 * word occurs, then scores an in-order match in a window around each anchor —
 * so the cost is proportional to the quote, not to the book.
 */
export function locateQuote(
  quote: string,
  stream: StreamToken[],
  pages: StructuredPage[],
  preferPage?: number,
): LocatedQuote | null {
  const q = quote.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (q.length < MIN_QUOTE_WORDS) return null;

  // Anchor candidates: positions of any of the quote's three longest words.
  const anchorWords = new Set([...q].sort((a, b) => b.length - a.length).slice(0, 3));
  const slack = Math.ceil(q.length * 0.3) + 2;
  let best: { positions: number[]; score: number; distance: number } | null = null;
  const tried = new Set<number>();

  for (let k = 0; k < stream.length; k++) {
    if (!anchorWords.has(stream[k].norm)) continue;
    const offset = q.indexOf(stream[k].norm);
    const from = Math.max(0, k - offset - slack);
    if (tried.has(from)) continue;
    tried.add(from);
    const to = Math.min(stream.length, from + q.length + 2 * slack);
    const window = stream.slice(from, to).map((t) => t.norm);
    const pos = lcsPositions(q, window);
    const score = pos.length / q.length;
    if (score < MIN_MATCH) continue;
    // A match must be compact: matched words scattered over twice the quote's
    // length is coincidence, not a quotation.
    const spread = pos[pos.length - 1] - pos[0] + 1;
    if (spread > q.length * 1.3 + 2) continue;
    const positions = pos.map((p) => p + from);
    const distance = preferPage === undefined ? 0 : Math.abs(stream[positions[0]].pageIndex - preferPage);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { positions, score, distance };
    }
  }
  if (!best) return null;

  // One contiguous range per page, first matched word to last — including any
  // punctuation-only tokens in between, which the stream skips.
  const first = best.positions[0];
  const last = best.positions[best.positions.length - 1];
  const refs: SourceRef[] = [];
  for (const t of stream.slice(first, last + 1)) {
    const ref = refs[refs.length - 1];
    if (ref && ref.pageIndex === t.pageIndex) ref.endWord = t.wordIndex;
    else refs.push({ pageIndex: t.pageIndex, startWord: t.wordIndex, endWord: t.wordIndex });
  }
  return { refs, text: refText(refs, pages), match: best.score };
}

/** The words a set of refs points at, as printed. */
export function refText(refs: SourceRef[], pages: StructuredPage[]): string {
  return refs
    .map((r) => pages[r.pageIndex].words.slice(r.startWord, r.endWord + 1).join(" "))
    .join(" ");
}

/** Merge overlapping or touching refs on the same page. */
export function mergeRefs(refs: SourceRef[]): SourceRef[] {
  const sorted = [...refs].sort((a, b) => a.pageIndex - b.pageIndex || a.startWord - b.startWord);
  const out: SourceRef[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.pageIndex === r.pageIndex && r.startWord <= last.endWord + 1) {
      last.endWord = Math.max(last.endWord, r.endWord);
    } else out.push({ ...r });
  }
  return out;
}
