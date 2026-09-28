/**
 * Cutting a book into passages, at two grains:
 *
 *   - chunks (~200 words): the unit of embedding and retrieval. Small enough
 *     that one embedding means one thing — the embedding model reads at most
 *     256 tokens, so a longer chunk would be silently truncated anyway.
 *   - windows (~3,500 words): the unit of one model call when looking for
 *     ideas. Large enough to hold a whole argument or anecdote, small enough
 *     that a 200-page book is ~20 focused calls instead of one giant prompt
 *     that no model reads carefully end to end.
 *
 * Both break only at paragraph ends where they can, and never cross a section
 * boundary (a chunk) or split a chunk (a window). Every chunk records exactly
 * which words of which pages it holds, so any idea found in it can cite them.
 */
import { wordsOf } from "../ingest/vision";
import type { AnalysisWindow, ChunkPlan, SectionPlan, SourceRef, StructuredPage } from "./types";

export const CHUNK_TARGET = 180;
export const CHUNK_MAX = 240;
export const WINDOW_TARGET = 3500;

/** Where each paragraph ends, as word counts into `page.words`. */
function paragraphEnds(page: StructuredPage): number[] {
  const ends: number[] = [];
  let n = 0;
  for (const p of page.text.paragraphs) {
    n += wordsOf({ ...page.text, paragraphs: [p] }).length;
    ends.push(n);
  }
  return ends;
}

interface Token {
  pageIndex: number;
  wordIndex: number;
  word: string;
  /** A paragraph ends after this word. */
  paraEnd: boolean;
}

function tokensOf(pages: StructuredPage[], section: SectionPlan): Token[] {
  const tokens: Token[] = [];
  for (let pi = section.startPage; pi <= section.endPage && pi < pages.length; pi++) {
    const page = pages[pi];
    const ends = new Set(paragraphEnds(page).map((e) => e - 1));
    page.words.forEach((word, wordIndex) => {
      tokens.push({ pageIndex: page.pageIndex, wordIndex, word, paraEnd: ends.has(wordIndex) });
    });
  }
  return tokens;
}

/** Collapse a run of tokens into per-page spans. */
export function spansOf(tokens: { pageIndex: number; wordIndex: number }[]): SourceRef[] {
  const spans: SourceRef[] = [];
  for (const t of tokens) {
    const last = spans[spans.length - 1];
    if (last && last.pageIndex === t.pageIndex && last.endWord === t.wordIndex - 1) last.endWord = t.wordIndex;
    else spans.push({ pageIndex: t.pageIndex, startWord: t.wordIndex, endWord: t.wordIndex });
  }
  return spans;
}

const SENTENCE_END = /[.!?]["'”’)\]]*$/;

export function chunkSections(pages: StructuredPage[], sections: SectionPlan[]): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];

  for (const section of sections) {
    if (section.skip) continue;
    const tokens = tokensOf(pages, section);
    let start = 0;

    while (start < tokens.length) {
      // Prefer the last paragraph end between TARGET and MAX; then the last
      // sentence end; then a hard cut at MAX. A tail too short to stand alone
      // is folded into this chunk instead of becoming a scrap of its own.
      let end = Math.min(tokens.length, start + CHUNK_MAX);
      if (tokens.length - start > CHUNK_MAX) {
        let cut = -1;
        for (let i = start + CHUNK_TARGET - 1; i < start + CHUNK_MAX; i++) if (tokens[i].paraEnd) cut = i;
        if (cut < 0) for (let i = start + CHUNK_TARGET - 1; i < start + CHUNK_MAX; i++) if (SENTENCE_END.test(tokens[i].word)) cut = i;
        if (cut >= 0) end = cut + 1;
        if (tokens.length - end < CHUNK_TARGET / 3) end = tokens.length;
      }

      const run = tokens.slice(start, end);
      chunks.push({
        index: chunks.length,
        sectionIndex: section.index,
        spans: spansOf(run),
        text: run.map((t) => t.word).join(" "),
        wordCount: run.length,
        startPage: run[0].pageIndex,
        endPage: run[run.length - 1].pageIndex,
      });
      start = end;
    }
  }
  return chunks;
}

/**
 * Pack consecutive chunks into windows of about `target` words. A window
 * closes early at a section boundary once it is at least half full, so a
 * chapter's argument is read together rather than split across two calls.
 */
export function buildWindows(chunks: ChunkPlan[], target = WINDOW_TARGET): AnalysisWindow[] {
  const windows: AnalysisWindow[] = [];
  let current: ChunkPlan[] = [];
  const flush = () => {
    if (!current.length) return;
    windows.push({
      index: windows.length,
      chunkIndices: current.map((c) => c.index),
      sectionIndices: [...new Set(current.map((c) => c.sectionIndex))],
      pages: [...new Set(current.flatMap((c) => c.spans.map((s) => s.pageIndex)))].sort((a, b) => a - b),
      wordCount: current.reduce((s, c) => s + c.wordCount, 0),
    });
    current = [];
  };

  for (const chunk of chunks) {
    const words = current.reduce((s, c) => s + c.wordCount, 0);
    const prev = current[current.length - 1];
    const newSection = prev && prev.sectionIndex !== chunk.sectionIndex;
    if (words + chunk.wordCount > target * 1.15 || (newSection && words >= target / 2)) flush();
    current.push(chunk);
  }
  flush();

  // A last window of a few hundred words is folded into the one before it.
  if (windows.length >= 2 && windows[windows.length - 1].wordCount < target / 4) {
    const tail = windows.pop()!;
    const prev = windows[windows.length - 1];
    prev.chunkIndices.push(...tail.chunkIndices);
    prev.sectionIndices = [...new Set([...prev.sectionIndices, ...tail.sectionIndices])];
    prev.pages = [...new Set([...prev.pages, ...tail.pages])].sort((a, b) => a - b);
    prev.wordCount += tail.wordCount;
  }
  return windows;
}
