/**
 * Cutting the narration into sentences, and sentences into scene slots.
 *
 * The cut points are REAL: every sentence starts on the measured start of a
 * spoken word and ends on the measured end of one (Phase 3B), so a scene
 * change lands on speech rather than near it. A sentence is also the natural
 * unit of meaning — one thought, one visual — which is why the director is
 * asked to plan in sentences rather than in seconds.
 *
 * Pure: word timings in, slots out.
 */
import type { Beat } from "../../content/schema";
import type { TimedWord } from "../../media/word-timing";
import type { Sentence } from "./types";

/** A scene shorter than this is a flash, not a shot. */
export const MIN_SCENE_SEC = 2.6;
/** A scene longer than this is where "static and repetitive" comes from. */
export const MAX_SCENE_SEC = 11;
/** The band the finished video should land in. */
export const MIN_SCENES = 8;
export const MAX_SCENES = 15;

/** A word ending a sentence: terminal punctuation, allowing closing quotes. */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/**
 * Split the narration into sentences. A sentence never spans two beats: beats
 * are recorded as separate audio clips with a gap between them, so a "sentence"
 * crossing that boundary would be one visual over two unrelated passages.
 */
export function sentencesOf(beats: Beat[], words: TimedWord[]): Sentence[] {
  const out: Sentence[] = [];
  const byBeat = new Map<number, TimedWord[]>();
  for (const w of words) {
    if (!byBeat.has(w.beatIndex)) byBeat.set(w.beatIndex, []);
    byBeat.get(w.beatIndex)!.push(w);
  }

  for (const [beatIndex, beatWords] of [...byBeat.entries()].sort((a, b) => a[0] - b[0])) {
    const beat = beats[beatIndex];
    if (!beat || beatWords.length === 0) continue;
    let run: TimedWord[] = [];
    const flush = () => {
      if (run.length === 0) return;
      out.push({
        index: out.length,
        text: run.map((w) => w.word).join(" "),
        start: run[0].start,
        end: run[run.length - 1].end,
        beatIndex,
        sourcePage: beat.sourcePage,
        startWord: beat.startWord,
        endWord: beat.endWord,
        words: run.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      });
      run = [];
    };
    for (const w of beatWords) {
      run.push(w);
      if (SENTENCE_END.test(w.word)) flush();
    }
    flush();
  }
  return out;
}

export interface Slot {
  fromSentence: number;
  toSentence: number;
  start: number;
  end: number;
}

/**
 * The fallback grouping, and the shape the director is asked to match: greedy
 * runs of whole sentences, each at least MIN_SCENE_SEC and at most
 * MAX_SCENE_SEC, aiming for `target` slots.
 *
 * Used directly when the director call fails, so a failed model call costs
 * variety of TEMPLATE, never the scene structure itself.
 */
export function slotSentences(sentences: Sentence[], target = 11): Slot[] {
  if (sentences.length === 0) return [];
  const total = sentences[sentences.length - 1].end - sentences[0].start;
  const want = Math.max(MIN_SCENES, Math.min(MAX_SCENES, Math.min(target, sentences.length)));
  const ideal = Math.max(MIN_SCENE_SEC, Math.min(MAX_SCENE_SEC, total / Math.max(1, want)));

  const slots: Slot[] = [];
  let from = 0;
  for (let i = 0; i < sentences.length; i++) {
    const start = sentences[from].start;
    const end = sentences[i].end;
    const span = end - start;
    const isLast = i === sentences.length - 1;
    const remaining = sentences.length - 1 - i;
    // Close when the slot is long enough — or when closing later would leave
    // too few sentences for the slots still owed.
    if (span >= ideal || isLast || (span >= MIN_SCENE_SEC && remaining <= want - slots.length - 1)) {
      slots.push({ fromSentence: from, toSentence: i, start, end });
      from = i + 1;
    }
  }
  // A final slot too short to stand alone is folded into the one before it.
  if (slots.length >= 2) {
    const last = slots[slots.length - 1];
    if (last.end - last.start < MIN_SCENE_SEC) {
      const prev = slots[slots.length - 2];
      prev.toSentence = last.toSentence;
      prev.end = last.end;
      slots.pop();
    }
  }
  return slots;
}

/**
 * Force a set of director-chosen ranges into a legal cover of the sentences:
 * contiguous, in order, starting at 0, ending at the last sentence, with no
 * gaps and no overlaps. A director that drops or repeats a sentence has its
 * ranges corrected rather than its whole plan thrown away.
 */
export function normalizeRanges(
  ranges: { fromSentence: number; toSentence: number }[],
  count: number,
): { fromSentence: number; toSentence: number }[] {
  const out: { fromSentence: number; toSentence: number }[] = [];
  let cursor = 0;
  for (const r of [...ranges].sort((a, b) => a.fromSentence - b.fromSentence)) {
    if (cursor >= count) break;
    const to = Math.min(count - 1, Math.max(cursor, Math.floor(r.toSentence)));
    out.push({ fromSentence: cursor, toSentence: to });
    cursor = to + 1;
  }
  if (out.length === 0) return [{ fromSentence: 0, toSentence: count - 1 }];
  if (cursor < count) out[out.length - 1].toSentence = count - 1;
  return out;
}

/**
 * Merge slots that are too short, and split ones that are too long, so every
 * scene sits inside the duration band. Splitting only happens where there is a
 * sentence boundary to split on — a single long sentence stays one scene.
 */
export function enforceDurations(
  ranges: { fromSentence: number; toSentence: number }[],
  sentences: Sentence[],
): { fromSentence: number; toSentence: number }[] {
  const span = (r: { fromSentence: number; toSentence: number }) =>
    sentences[r.toSentence].end - sentences[r.fromSentence].start;

  const merged: { fromSentence: number; toSentence: number }[] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && span(prev) < MIN_SCENE_SEC) prev.toSentence = r.toSentence;
    else merged.push({ ...r });
  }
  while (merged.length >= 2 && span(merged[merged.length - 1]) < MIN_SCENE_SEC) {
    const last = merged.pop()!;
    merged[merged.length - 1].toSentence = last.toSentence;
  }

  const out: { fromSentence: number; toSentence: number }[] = [];
  for (const r of merged) {
    let from = r.fromSentence;
    while (from <= r.toSentence) {
      let to = from;
      while (
        to < r.toSentence &&
        sentences[to].end - sentences[from].start < MAX_SCENE_SEC &&
        sentences[to + 1].end - sentences[from].start <= MAX_SCENE_SEC
      ) {
        to++;
      }
      out.push({ fromSentence: from, toSentence: to });
      from = to + 1;
    }
  }
  return out;
}
