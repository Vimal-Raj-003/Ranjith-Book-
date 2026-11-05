import type { Beat, GenerateInput } from "./schema";

// Retain the original page-word index even when punctuation splits a token.
function tokens(words: string[]) {
  return words.flatMap((word, index) =>
    (word.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((text) => ({ text, index })));
}

/** Anchor unique verbatim passages (including unpunctuated spoken quotes) to the source. */
export function repairQuotedRanges(beats: Beat[], pages: GenerateInput["pages"]) {
  const source = new Map(pages.map((p) => [p.pageIndex, tokens(p.words)]));
  const matched = new Set<number>();
  const repairs: string[] = [];
  const out = beats.map((b, beatIndex) => {
    const page = source.get(b.sourcePage);
    if (!page) return { ...b };
    const narration = tokens(b.voiceover.split(/\s+/));
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
