import type { Beat, GenerateInput } from "./schema";

// Retain the original page-word index even when punctuation splits a token.
function tokens(words: string[]) {
  return words.flatMap((word, index) =>
    (word.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((text) => ({ text, index })));
}

const ALIGN_STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "almost", "along", "also", "always",
  "among", "another", "around", "author", "because", "become", "becomes", "before",
  "being", "below", "between", "beyond", "book", "bookreel", "books", "both", "bring",
  "chapter", "classic", "comes", "could", "does", "doing", "down", "during", "each",
  "either", "enough", "even", "every", "everything", "explains", "first", "focus",
  "follow", "found", "from", "further", "given", "gives", "going", "great", "having",
  "here", "holding", "however", "ideas", "instead", "into", "itself", "just", "keep",
  "keeps", "later", "like", "make", "makes", "making", "many", "matter", "means",
  "might", "more", "most", "much", "must", "never", "next", "often", "once", "only",
  "other", "others", "over", "page", "pages", "part", "passage", "point", "points",
  "rather", "really", "right", "same", "says", "second", "seem", "seems", "several",
  "share", "should", "shows", "simple", "simply", "since", "single", "small", "some",
  "something", "sort", "start", "states", "still", "study", "subscribe", "such",
  "suggests", "take", "takes", "that", "their", "them", "then", "there", "these",
  "they", "thing", "things", "think", "this", "those", "though", "through", "thus",
  "today", "together", "toward", "under", "until", "upon", "using", "very", "video",
  "videos", "watch", "well", "were", "what", "when", "where", "which", "while",
  "whole", "with", "within", "without", "word", "words", "work", "works", "would",
  "your",
]);

function stemToken(word: string): string {
  return word.length >= 6 ? word.slice(0, 5) : word;
}

function extractContentTerms(words: string[]): { exact: Set<string>; stems: Set<string> } {
  const exact = new Set<string>();
  const stems = new Set<string>();
  for (const raw of words) {
    const parts = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const part of parts) {
      if (part.length < 4 || ALIGN_STOPWORDS.has(part)) continue;
      exact.add(part);
      stems.add(stemToken(part));
    }
  }
  return { exact, stems };
}

/**
 * True only when a beat is a non-factual closing viewer action ("Follow BookReel...",
 * "Save this video...") with no bundled factual claim about the book.
 */
export function isPureClosingRequest(voiceover: string): boolean {
  const clean = (voiceover ?? "").trim();
  if (!clean) return false;
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount > 16) return false;
  const startsAsRequest =
    /^(?:follow|subscribe|save|share|send|bookmark|repost|like|tap|hit|comment|drop\s+a\s+comment|leave\s+a\s+comment|tag\s+someone|watch\s+part)\b/i.test(
      clean,
    );
  if (!startsAsRequest) return false;
  const hasFactualClaim =
    /\b(?:because|proves?|doubles?|triples?|increases?|reduces?|memoriz\w*|capacity|experiment\w*|psycholog\w*|scientif\w*|argues?|explains?|demonstrates?)\b/i.test(
      clean,
    );
  return !hasFactualClaim;
}

function scorePageWindow(
  narrationTerms: { exact: Set<string>; stems: Set<string> },
  pageWords: string[],
  start: number,
  end: number,
): number {
  if (narrationTerms.stems.size === 0 || start > end) return 0;
  const matchedStems = new Set<string>();
  let score = 0;
  for (let idx = start; idx <= end && idx < pageWords.length; idx++) {
    const parts = pageWords[idx].toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const part of parts) {
      if (part.length < 4 || ALIGN_STOPWORDS.has(part)) continue;
      const stem = stemToken(part);
      if (narrationTerms.exact.has(part)) {
        score += matchedStems.has(stem) ? 0.35 : 2.0;
        matchedStems.add(stem);
      } else if (narrationTerms.stems.has(stem)) {
        score += matchedStems.has(stem) ? 0.25 : 1.5;
        matchedStems.add(stem);
      }
    }
  }
  return score;
}

function snapToSentenceBounds(
  pageWords: string[],
  start: number,
  end: number,
  minWord: number,
  maxWord: number,
): { start: number; end: number } {
  let s = start;
  // Walk back up to 8 words if we started just after a sentence boundary.
  for (let k = s - 1; k >= Math.max(minWord, start - 8); k--) {
    if (/[.!?;:]["')\]]*$/.test(pageWords[k])) {
      s = k + 1;
      break;
    }
    if (k === minWord && minWord === 0) {
      s = 0;
      break;
    }
  }

  let e = end;
  // Extend up to 14 words forward to finish the sentence rather than clipping mid-clause.
  for (let k = Math.max(s, end - 3); k <= Math.min(maxWord, end + 14); k++) {
    if (/[.!?]["')\]]*$/.test(pageWords[k])) {
      e = k;
      break;
    }
  }
  return { start: Math.max(minWord, s), end: Math.min(maxWord, Math.max(s, e)) };
}

/** Anchor unique verbatim passages (including unpunctuated spoken quotes) to the source. */
export function repairQuotedRanges(beats: Beat[], pages: GenerateInput["pages"]) {
  const source = new Map(pages.map((p) => [p.pageIndex, tokens(p.words)]));
  const matched = new Set<number>();
  const repairs: string[] = [];
  const out = beats.map((b, beatIndex) => {
    const page = source.get(b.sourcePage);
    if (!page) return { ...b };
    const narration = tokens((b.voiceover ?? "").split(/\s+/));
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < narration.length; i++) {
      let longest = 0;
      let starts: number[] = [];
      for (let j = 0; j < page.length; j++) {
        let length = 0;
        while (i + length < narration.length && j + length < page.length &&
            narration[i + length].text === page[j + length].text) length++;
        if (length > longest) { longest = length; starts = [j]; }
        else if (length === longest) starts.push(j);
      }
      if (longest < 5) continue;
      // Repeated source wording is ambiguous: leave it for grounding, never guess.
      if (starts.length === 1) spans.push({ start: page[starts[0]].index, end: page[starts[0] + longest - 1].index });
      i += longest - 1;
    }
    if (!spans.length) return { ...b };
    matched.add(beatIndex);
    const start = Math.min(...spans.map((s) => s.start));
    const end = Math.max(...spans.map((s) => s.end));
    // Keep broader, already useful context; extend a partially clipped quote.
    const overlaps = b.startWord <= end && b.endWord >= start;
    const startWord = overlaps ? Math.min(b.startWord, start) : start;
    const endWord = overlaps ? Math.max(b.endWord, end) : end;
    if (startWord !== b.startWord || endWord !== b.endWord) {
      repairs.push(`beats[${beatIndex}] matched source tokens on PAGE ${b.sourcePage}: ${b.startWord}-${b.endWord} corrected to ${startWord}-${endWord}.`);
    }
    return { ...b, startWord, endWord };
  });
  return { beats: out, matched, repairs };
}

/**
 * Expands 1–3 word stub citations (e.g., when a model treats a factual takeaway
 * beat like a resting CTA range such as `145–146` `"second reason"`) and
 * re-aligns completely ungrounded paraphrased ranges to the supporting sentence
 * window within their legal forward bounds on `sourcePage`.
 *
 * Never modifies verbatim-anchored beats (`lockedBeats`), pure closing requests,
 * or synthetic test pages that share no lexical stems with the narration.
 */
export function alignBeatRangesToSource(
  beats: Beat[],
  pages: GenerateInput["pages"],
  lockedBeats: ReadonlySet<number> = new Set(),
): { beats: Beat[]; repairs: string[] } {
  const pageMap = new Map(pages.map((p) => [p.pageIndex, p.words]));
  const out = beats.map((b) => ({ ...b }));
  const repairs: string[] = [];

  for (let i = 0; i < out.length; i++) {
    if (lockedBeats.has(i)) continue;
    const b = out[i];
    const pageWords = pageMap.get(b.sourcePage);
    if (!pageWords || pageWords.length === 0) continue;

    if (isPureClosingRequest(b.voiceover)) {
      if (i === out.length - 1 && i > 0 && out[i - 1].sourcePage === b.sourcePage) {
        const prevEnd = out[i - 1].endWord;
        if (b.startWord < prevEnd) {
          const nextEnd = Math.min(pageWords.length - 1, Math.max(prevEnd, b.endWord));
          repairs.push(
            `beats[${i}] closing request moved to rest at ${prevEnd}-${nextEnd} after beats[${i - 1}] on PAGE ${b.sourcePage}.`,
          );
          b.startWord = prevEnd;
          b.endWord = nextEnd;
        }
      }
      continue;
    }

    const minWord =
      i > 0 && out[i - 1].sourcePage === b.sourcePage
        ? Math.min(pageWords.length - 1, out[i - 1].endWord)
        : 0;

    let maxWord = pageWords.length - 1;
    if (i + 1 < out.length && out[i + 1].sourcePage === b.sourcePage) {
      const nextIsPureCta = i + 1 === out.length - 1 && isPureClosingRequest(out[i + 1].voiceover);
      if (!nextIsPureCta) {
        const nextLimit = lockedBeats.has(i + 1)
          ? out[i + 1].startWord
          : Math.max(out[i + 1].startWord, out[i + 1].endWord - 2);
        if (nextLimit > minWord + 4) {
          maxWord = Math.min(pageWords.length - 1, nextLimit);
        }
      }
    }
    if (maxWord <= minWord) continue;

    const terms = extractContentTerms((b.voiceover ?? "").split(/\s+/));
    if (terms.stems.size === 0) continue;

    const span = b.endWord - b.startWord + 1;
    const currentScore = scorePageWindow(terms, pageWords, b.startWord, b.endWord);
    const isNarrowStub = span <= 5 && currentScore < 2.0;

    // Leave already well-grounded ranges with >= 6 words (or strong lexical match) untouched.
    if (!isNarrowStub && currentScore > 0) continue;

    const windowLen = Math.min(34, Math.max(12, maxWord - minWord + 1));
    let bestStart = -1;
    let bestEnd = -1;
    let bestScore = 0;

    for (let s = minWord; s <= maxWord; s++) {
      const e = Math.min(maxWord, s + windowLen - 1);
      const sc = scorePageWindow(terms, pageWords, s, e);
      // Slight tie-breaker toward windows near `b.startWord` when scores match.
      const proximityBonus = Math.max(0, 0.15 - Math.abs(s - b.startWord) * 0.001);
      const total = sc + (sc > 0 ? proximityBonus : 0);
      if (total > bestScore) {
        bestScore = total;
        bestStart = s;
        bestEnd = e;
      }
      if (e === maxWord) break;
    }

    const minRequiredScore = isNarrowStub ? 1.5 : 3.0;
    if (bestStart >= 0 && bestScore >= minRequiredScore && bestScore > currentScore + 0.5) {
      const snapped = snapToSentenceBounds(pageWords, bestStart, bestEnd, minWord, maxWord);
      if (snapped.end > snapped.start && (snapped.start !== b.startWord || snapped.end !== b.endWord)) {
        repairs.push(
          `beats[${i}] range (${b.startWord}-${b.endWord}) aligned to supporting passage ${snapped.start}-${snapped.end} on PAGE ${b.sourcePage}.`,
        );
        b.startWord = snapped.start;
        b.endWord = snapped.end;
      }
    }
  }

  return { beats: out, repairs };
}
