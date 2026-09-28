import type { Box } from "../ingest/ocr";
import type { LineRun } from "../ingest/lines";
import { runsForRange } from "../ingest/lines";
import { normalizeToken } from "../ingest/align";

export interface SweepStep {
  box: Box;
  start: number;
  end: number;
}

/**
 * Split a beat's measured speech window across the strokes it covers.
 *
 * Proportional to word count rather than evenly, because a line holding seven
 * words takes longer to say than one holding three — and a marker that finishes
 * a line while the voice is still reading it is the single most obvious way this
 * effect looks fake.
 *
 * `lines` and the word range are implicitly scoped to ONE photographed page:
 * `LineRun.wordIndices` come from vision-model word indices that reset to 0 on
 * every page (see `align.ts`/`vision.ts`), and `LineRun` itself carries no page
 * identifier. So a beat whose narrated passage runs across two photographed
 * pages cannot be expressed as a single call here — there is no `(startWord,
 * endWord)` pair that means "word 40 of page 3 through word 2 of page 4",
 * because "word 2" is ambiguous without knowing which page's index space it
 * lives in. A caller that needs to handle that ordinary case must detect the
 * page boundary itself, split the beat into one sub-range per page (each with
 * that page's own local indices) and a proportional slice of `speechStart` /
 * `speechEnd` — the same word-count proportionality this function applies
 * internally between strokes — then call `sweepForBeat` once per page and
 * concatenate the results. This function has no way to do that split itself:
 * given only one page's `lines`, it cannot see how many words of the beat live
 * on a page it was never handed.
 */
export function sweepForBeat(
  lines: LineRun[],
  startWord: number,
  endWord: number,
  speechStart: number,
  speechEnd: number,
): SweepStep[] {
  const runs = runsForRange(lines, startWord, endWord);
  if (runs.length === 0) return [];

  const totalWords = runs.reduce((sum, r) => sum + r.wordIndices.length, 0);
  if (totalWords === 0) return [];

  // A non-finite window (NaN or +/-Infinity) has no honest timing at all. This
  // is not contrived: `durationOf()` in tts.ts returning NaN for a corrupted or
  // zero-byte TTS render feeds straight into `speechEnd`'s `Math.max(x, NaN)`,
  // which is itself NaN. A beat whose audio could not be measured gets no
  // stroke at all, rather than NaN timestamps propagating into every step and
  // then into every camera key downstream.
  if (!Number.isFinite(speechStart) || !Number.isFinite(speechEnd)) return [];

  // An inverted window (speechEnd < speechStart) cannot reach this function
  // through today's only producer — tts.ts guarantees speechEnd is at least
  // 0.2s after speechStart — but this is a pure function with its own
  // contract, not one that trusts its caller. Collapse it to a zero-length
  // window anchored at speechStart instead of letting the "last step ends
  // exactly on speechEnd" rule below hand back a step with a negative
  // duration (start > end).
  const sane = speechEnd >= speechStart;
  const windowEnd = sane ? speechEnd : speechStart;
  const span = sane ? speechEnd - speechStart : 0;

  const steps: SweepStep[] = [];
  let t = speechStart;

  for (let i = 0; i < runs.length; i++) {
    // The last step ends exactly on windowEnd rather than on an accumulated
    // sum, so floating-point drift cannot leave the marker moving after the
    // voice stops.
    const end = i === runs.length - 1 ? windowEnd : t + (runs[i].wordIndices.length / totalWords) * span;
    steps.push({ box: runs[i].box, start: t, end });
    t = end;
  }

  return steps;
}

/** A spoken word with its real time in the voice track (see `media/word-timing.ts`). */
export interface SpokenWord {
  word: string;
  start: number;
  end: number;
}

/** A run of spoken words matching the page at least this long is the page being read aloud. */
export const QUOTE_RUN = 3;

/**
 * Page words the narration reads aloud, with when each is spoken: LCS of the
 * spoken words against the cited page words, keeping only runs of QUOTE_RUN
 * or more consecutive matches — a shared "the" or "and" is not a quotation.
 */
export function quotedAnchors(
  spoken: SpokenWord[],
  pageWords: string[],
  startWord: number,
  endWord: number,
): Map<number, { start: number; end: number }> {
  const s = spoken.map((w) => normalizeToken(w.word));
  const pageIdx: number[] = [];
  for (let i = startWord; i <= endWord && i < pageWords.length; i++) pageIdx.push(i);
  const p = pageIdx.map((i) => normalizeToken(pageWords[i]));

  const n = s.length;
  const m = p.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = s[i] && s[i] === p[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (s[i] && s[i] === p[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }

  const anchors = new Map<number, { start: number; end: number }>();
  let k = 0;
  while (k < pairs.length) {
    let e = k;
    while (e + 1 < pairs.length && pairs[e + 1][0] === pairs[e][0] + 1 && pairs[e + 1][1] === pairs[e][1] + 1) e++;
    if (e - k + 1 >= QUOTE_RUN) {
      for (let r = k; r <= e; r++) {
        const [si, pj] = pairs[r];
        anchors.set(pageIdx[pj], { start: spoken[si].start, end: spoken[si].end });
      }
    }
    k = e + 1;
  }
  return anchors;
}

/**
 * The marker, timed from the real audio. Every stroke starts and ends on a
 * spoken word's actual start or end — never on a fraction of the beat.
 *
 *   - Lines holding words the narration reads aloud (see `quotedAnchors`) are
 *     swept exactly while those words are spoken.
 *   - The other cited lines are commentary's context, not speech: nothing on
 *     them is said, so there is no word to wait for. They are swept in
 *     reading order across the spoken words between the anchored lines around
 *     them (or across the whole beat, when nothing is quoted), one stroke per
 *     line, each boundary snapped to a real word boundary.
 *
 * `spoken` is this beat's words; `pageWords` is the cited page's word list.
 */
export function timedSweepForBeat(
  lines: LineRun[],
  startWord: number,
  endWord: number,
  spoken: SpokenWord[],
  pageWords: string[],
): SweepStep[] {
  const runs = runsForRange(lines, startWord, endWord);
  const words = spoken.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  if (runs.length === 0 || words.length === 0) return [];

  const anchors = quotedAnchors(words, pageWords, startWord, endWord);
  const anchored = runs.map((r) => {
    const times = r.wordIndices.map((i) => anchors.get(i)).filter((t): t is { start: number; end: number } => !!t);
    return times.length ? { start: Math.min(...times.map((t) => t.start)), end: Math.max(...times.map((t) => t.end)) } : null;
  });

  const steps: SweepStep[] = [];
  let r = 0;
  let cursor = words[0].start;
  while (r < runs.length) {
    const a = anchored[r];
    if (a) {
      const start = Math.max(a.start, cursor);
      steps.push({ box: runs[r].box, start, end: Math.max(a.end, start) });
      cursor = Math.max(a.end, start);
      r++;
      continue;
    }
    // A stretch of unanchored lines, up to the next anchored one (or the end).
    let k = r;
    while (k < runs.length && !anchored[k]) k++;
    const limit = k < runs.length ? anchored[k]!.start : words[words.length - 1].end;
    const pool = words.filter((w) => w.start >= cursor - 1e-6 && w.end <= limit + 1e-6);
    const count = k - r;
    if (pool.length === 0) {
      // No spoken word falls in this stretch: the lines share the real gap.
      const span = Math.max(0, limit - cursor);
      for (let q = 0; q < count; q++) {
        steps.push({ box: runs[r + q].box, start: cursor + (span * q) / count, end: cursor + (span * (q + 1)) / count });
      }
    } else {
      // Word boundaries: stroke q runs from word b[q] to the end of word b[q+1]-1.
      // Never backwards: with fewer words than lines, two lines can land on
      // the same word, and the later one must not start before the earlier ends.
      let last = cursor;
      for (let q = 0; q < count; q++) {
        const from = Math.floor((pool.length * q) / count);
        const to = Math.max(from, Math.floor((pool.length * (q + 1)) / count) - 1);
        const start = Math.max(last, q === 0 ? cursor : pool[from].start);
        const end = Math.max(start, q === count - 1 ? limit : pool[Math.min(to, pool.length - 1)].end);
        steps.push({ box: runs[r + q].box, start, end });
        last = end;
      }
    }
    cursor = limit;
    r = k;
  }
  return steps;
}

/** Where the top of the viewport sits, in page pixels, over time. */
export interface CameraKey {
  t: number;
  y: number;
}

const MIDDLE = 0.5;

/**
 * The camera follows the MARKER, not the beat text.
 *
 * The ancestor project learned that steering a scroll to whichever passage a
 * beat mentioned was worse than a straight top-to-bottom pass: it jumped
 * between sections and skipped parts of the page. That failure cannot occur
 * here, because the marker advances monotonically through the document —
 * every line is visited, in order, by construction (see `sweepForBeat`). But
 * the camera has to follow it or the marker leaves frame.
 *
 * The active stroke lands in the middle third of the frame UNLESS doing so
 * would require scrolling past the top of the page (nothing above y=0 to
 * bring into view) or past the bottom (nothing below `pageHeight -
 * frameHeight`) — in which case the camera clamps to that limit instead, and
 * the stroke sits wherever on screen that leaves it.
 */
export function cameraTrack(
  steps: SweepStep[],
  frameHeight: number,
  pageHeight: number,
): CameraKey[] {
  // Guards its own contract rather than trusting `sweepForBeat` to have
  // already filtered non-finite input: `cameraTrack` is exported and callable
  // on its own, so a NaN frame/page height (or a step smuggled in with a NaN
  // box/timestamp) must not turn into a NaN camera position with no error.
  if (!Number.isFinite(frameHeight) || !Number.isFinite(pageHeight)) return [];

  const maxY = Math.max(0, pageHeight - frameHeight);
  const clamp = (y: number) => Math.min(maxY, Math.max(0, y));

  const keys: CameraKey[] = [];
  for (const step of steps) {
    const centre = (step.box.y0 + step.box.y1) / 2;
    if (!Number.isFinite(centre) || !Number.isFinite(step.start) || !Number.isFinite(step.end)) continue;
    const y = clamp(centre - frameHeight * MIDDLE);
    // Two keys per stroke: in place when it starts, in place when it ends. The
    // easing between strokes is the timeline's job, not this function's.
    keys.push({ t: step.start, y });
    keys.push({ t: step.end, y });
  }

  return keys;
}
