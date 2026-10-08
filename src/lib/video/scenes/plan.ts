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
/** The band the finished video should land in (a 45 s video carries ~8, a 90 s one ~16). */
export const MIN_SCENES = 6;
export const MAX_SCENES = 16;
/** About how long one visual idea holds: the references cut every 3-6 s. */
export const SCENE_SECONDS = 5.6;
/**
 * The opening scene is the hook, and a hook that outstays its welcome is the
 * retention failure it exists to prevent. It is cut at the first sentence
 * boundary after HOOK_MIN_SEC when it would run past HOOK_MAX_SEC.
 */
export const HOOK_MIN_SEC = 3.0;
export const HOOK_MAX_SEC = 5.8;

/** A word ending a sentence: terminal punctuation, allowing closing quotes. */
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/**
 * Where a long sentence may be broken: punctuation the author wrote that the
 * voice pauses on anyway. Deliberately not a space — a scene must never cut
 * through the middle of a phrase.
 */
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

/**
 * How long a run has to get before a clause boundary is taken as a split.
 * Comfortably clear of MIN_SCENE_SEC so neither half can come out too short to
 * be a scene, and below MAX_SCENE_SEC so the split happens BEFORE the run
 * becomes unsplittable rather than after.
 */
const CLAUSE_SPLIT_SEC = 7.5;

/**
 * Below this a piece has no usable time on screen at all and must be merged
 * whatever that costs; above it, a short scene is merely short, and keeping it
 * short beats building an over-long one to avoid it.
 */
const NO_TIME_SEC = 0.3;

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
      if (SENTENCE_END.test(w.word)) {
        flush();
        continue;
      }
      // A sentence can outrun what a single scene may hold, and `enforceDurations`
      // cannot help: it splits between sentences, so one long sentence becomes one
      // over-long scene. Measured in a real episode, that produced a 13.9s scene —
      // a single photographed page holding 41% of a 65s video.
      //
      // So a run that has already grown past what a scene may hold is broken at
      // the next CLAUSE boundary: a comma, semicolon, colon or dash the author
      // actually wrote. That is a place the voice pauses anyway, never a cut
      // through the middle of a phrase, and the pieces are still whole runs of
      // words with their own timings — so grounding (which keys off the beat, not
      // the sentence) and the word-level highlights are untouched.
      if (CLAUSE_END.test(w.word) && w.end - run[0].start >= CLAUSE_SPLIT_SEC) flush();
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
 * Cut the first range short when it is more than HOOK_MAX_SEC, at the first
 * sentence boundary at or after HOOK_MIN_SEC. A single long sentence stays one
 * scene: there is no boundary to cut on.
 */
export function capOpening(
  ranges: { fromSentence: number; toSentence: number }[],
  sentences: Sentence[],
): { fromSentence: number; toSentence: number }[] {
  const first = ranges[0];
  if (!first || first.toSentence <= first.fromSentence) return ranges;
  const t0 = sentences[first.fromSentence].start;
  if (sentences[first.toSentence].end - t0 <= HOOK_MAX_SEC) return ranges;
  let cut = first.toSentence;
  for (let i = first.fromSentence; i < first.toSentence; i++) {
    if (sentences[i].end - t0 >= HOOK_MIN_SEC) {
      cut = i;
      break;
    }
  }
  if (cut >= first.toSentence) return ranges;
  return [{ fromSentence: first.fromSentence, toSentence: cut }, { fromSentence: cut + 1, toSentence: first.toSentence }, ...ranges.slice(1)];
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

  // The split above can hand back a piece that is shorter than the merge pass
  // would ever have allowed, because it only ever looks FORWARD: the inner loop
  // refuses to take the next sentence when that would break MAX_SCENE_SEC, and
  // then emits whatever it has — even when that is a single sentence of no
  // duration at all. Measured in a real episode: a sentence whose words had all
  // collapsed onto one instant was merged into its neighbour correctly here,
  // and this loop promptly split it back out into a scene with start === end,
  // leaving the following sentence alone as a 13.9s block.
  //
  // The word timings that caused that are fixed at source (media/word-timing.ts),
  // but a scene with no time is wrong whatever produced it, so the band is
  // closed here rather than assumed. Merging FORWARD, not backward, is
  // deliberate: a range keeps the spec of the sentence it begins on, so folding
  // a too-short piece into the one after it preserves the director's choice for
  // the earlier sentence instead of discarding it.
  // Merging has to be weighed against the ceiling, not applied blindly. A piece
  // with effectively NO time cannot be a scene at all, so it is always folded
  // forward. A piece that is merely a little short is folded only when that does
  // not push the result past MAX_SCENE_SEC: a 2.2s scene reads perfectly well,
  // whereas forcing it into its neighbour to satisfy the floor can build the
  // very 15s block this function exists to prevent.
  const banded: { fromSentence: number; toSentence: number }[] = [];
  for (const r of out) {
    const prev = banded[banded.length - 1];
    if (prev) {
      const prevSpan = span(prev);
      const joined = sentences[r.toSentence].end - sentences[prev.fromSentence].start;
      if (prevSpan < NO_TIME_SEC || (prevSpan < MIN_SCENE_SEC && joined <= MAX_SCENE_SEC)) {
        prev.toSentence = r.toSentence;
        continue;
      }
    }
    banded.push({ ...r });
  }
  while (banded.length >= 2) {
    const last = banded[banded.length - 1];
    const lastSpan = span(last);
    if (lastSpan >= MIN_SCENE_SEC) break;
    const prev = banded[banded.length - 2];
    const joined = sentences[last.toSentence].end - sentences[prev.fromSentence].start;
    // Same trade at the tail: a short final scene is acceptable, a timeless one
    // is not, and neither is a merge that blows the ceiling.
    if (lastSpan >= NO_TIME_SEC && joined > MAX_SCENE_SEC) break;
    banded.pop();
    prev.toSentence = last.toSentence;
  }
  return banded;
}
