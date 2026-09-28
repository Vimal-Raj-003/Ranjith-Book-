/**
 * Which recognised word is which script word, and when each script word was
 * actually spoken.
 *
 * faster-whisper hears the mastered narration and returns words with
 * timestamps — but not exactly the script's words: it drops a word, splits
 * one ("every day" for "everyday"), writes "1900" for "nineteen hundred", or
 * hears a breath as "uh". So the recognised words are never used directly.
 * Instead they are aligned to the approved script by longest common
 * subsequence (the same approach `ingest/align.ts` takes for OCR), and every
 * script word gets a time:
 *
 *   - "audio": matched to a recognised word; its timestamps are that word's.
 *   - "interpolated": not recognised, but lying between two words that were;
 *     it is placed in the real gap between them, so it can never drift away
 *     from the speech around it.
 *   - "estimated": nothing in the beat could be matched at all (or no
 *     recogniser was available). The caller must say so; this is not
 *     audio-derived timing and is never presented as if it were.
 *
 * Pure — tested without a recogniser.
 */
import { normalizeToken } from "../ingest/align";

export interface AsrWord {
  word: string;
  start: number;
  end: number;
  /** The recogniser's confidence, 0–1. */
  p?: number;
}

export type TimingSource = "audio" | "interpolated" | "estimated";

export interface TimedWord {
  /** The script word, as written. */
  word: string;
  start: number;
  end: number;
  beatIndex: number;
  /** Position within its beat's voiceover words. */
  index: number;
  source: TimingSource;
}

export interface Window {
  start: number;
  end: number;
}

/** The shortest time any word is given, so no word is zero-length. */
const MIN_WORD = 0.04;

/** A beat's voiceover split the way captions and timings count words. */
export function scriptWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Two tokens are the same word: identical, or one edit apart in a long word. */
function same(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // One substitution, insertion or deletion.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const restA = a.slice(i + (a.length >= b.length ? 1 : 0));
  const restB = b.slice(i + (b.length >= a.length ? 1 : 0));
  return restA === restB;
}

/** LCS alignment: for each script word, the index of its recognised word, or null. */
export function alignTokens(script: string[], heard: string[]): (number | null)[] {
  const a = script.map(normalizeToken);
  const b = heard.map(normalizeToken);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: (number | null)[] = new Array(n).fill(null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
      out[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

export interface BeatTiming {
  words: TimedWord[];
  /** Script words matched to a recognised word. */
  matched: number;
  total: number;
}

/**
 * Time every script word of one beat from what the recogniser heard in that
 * beat's window. Unmatched words share the real gap between their matched
 * neighbours equally; words before the first match (or after the last) share
 * the gap back to the window's edge. With no match at all, the whole beat is
 * spread evenly across the window and marked "estimated".
 */
export function timeBeat(
  beatIndex: number,
  text: string,
  heard: AsrWord[],
  window: Window,
): BeatTiming {
  const script = scriptWords(text);
  const cleanHeard = heard
    .filter((h) => Number.isFinite(h.start) && Number.isFinite(h.end) && normalizeToken(h.word))
    .map((h) => ({
      ...h,
      start: Math.min(Math.max(h.start, window.start), window.end),
      end: Math.min(Math.max(h.end, window.start), window.end),
    }));
  const map = alignTokens(script, cleanHeard.map((h) => h.word));
  const matched = map.filter((x) => x !== null).length;

  const words: TimedWord[] = script.map((word, index) => ({
    word,
    index,
    beatIndex,
    start: NaN,
    end: NaN,
    source: "estimated" as TimingSource,
  }));

  if (matched === 0) {
    const span = Math.max(0, window.end - window.start);
    words.forEach((w, i) => {
      w.start = window.start + (span * i) / script.length;
      w.end = window.start + (span * (i + 1)) / script.length;
    });
    return { words, matched, total: script.length };
  }

  // Matched words take the recogniser's own times, kept in order.
  let floor = window.start;
  script.forEach((_, i) => {
    const j = map[i];
    if (j === null) return;
    const h = cleanHeard[j];
    const start = Math.max(h.start, floor);
    const end = Math.max(h.end, start + MIN_WORD);
    words[i].start = start;
    words[i].end = Math.min(end, window.end);
    words[i].source = "audio";
    floor = words[i].end;
  });

  // Unmatched runs fill the real gap between the times around them.
  let i = 0;
  while (i < words.length) {
    if (words[i].source === "audio") {
      i++;
      continue;
    }
    let k = i;
    while (k < words.length && words[k].source !== "audio") k++;
    const from = i > 0 ? words[i - 1].end : window.start;
    const to = k < words.length ? words[k].start : window.end;
    const gap = Math.max(0, to - from);
    const count = k - i;
    for (let r = 0; r < count; r++) {
      words[i + r].start = from + (gap * r) / count;
      words[i + r].end = from + (gap * (r + 1)) / count;
      words[i + r].source = "interpolated";
    }
    i = k;
  }

  return { words, matched, total: script.length };
}

export interface Silence {
  start: number;
  end: number;
}

/** How far fitToSound may move a beat's first or last word edge, seconds. */
const MAX_EDGE_CORRECTION = 1.5;

/** A burst of sound shorter than this at a beat's edge is a click or a breath, not speech. */
const BLIP = 0.12;

/**
 * Where sound starts and stops inside a beat's window, from measured
 * silences — skipping a sub-BLIP burst at either edge. Every beat sits
 * between real pauses (the TTS lead-in, tail and the gap between beats, half
 * a second and more), so these edges are measured reliably.
 */
export function soundBounds(window: Window, quiet: Silence[]): Window | null {
  const qs = quiet.filter((q) => q.end > window.start && q.start < window.end).sort((a, b) => a.start - b.start);
  let start = window.start;
  for (const q of qs) if (q.start <= start + BLIP && q.end > start) start = Math.min(q.end, window.end);
  let end = window.end;
  for (const q of [...qs].reverse()) if (q.end >= end - BLIP && q.start < end) end = Math.max(q.start, window.start);
  return end - start > 0.1 ? { start, end } : null;
}

/**
 * Put a beat's first and last word edges on its measured sound.
 *
 * Measured on real Pocket TTS narration (scripts/e2e-word-timing.mjs):
 * faster-whisper's timing INSIDE a beat is good — the word after a mid-beat
 * pause starts ~0.1 s from where the pause measurably ends — but its EDGES are
 * not: the first word is pinned 0.1–0.7 s before the voice starts, and the
 * last word ends 0.1–0.6 s before the voice stops. Stretching the whole beat
 * to fit was tried and measured worse inside the beat (0.27 s vs 0.11 s), so
 * only the two edges move: the first word starts where sound starts, the last
 * ends where it stops. Everything between keeps the recogniser's own times.
 */
export function fitToSound(words: TimedWord[], bounds: Window | null): TimedWord[] {
  if (!bounds || words.length === 0) return words;
  const out = words.map((w) => ({ ...w }));
  const first = out[0];
  const last = out[out.length - 1];
  // Only a correction, never a relocation: an edge further than this from the
  // measured sound means the bounds or the recognition are wrong. 1.5 s, not
  // less: a beat's lead-in (TTS silence + padding) is often ~1 s, and the
  // recogniser pins the first word to the very start of it.
  if (Math.abs(first.start - bounds.start) <= MAX_EDGE_CORRECTION) {
    first.start = bounds.start;
    if (first.end <= first.start) first.end = Math.min(first.start + 0.15, out[1]?.start ?? bounds.end);
  }
  if (Math.abs(last.end - bounds.end) <= MAX_EDGE_CORRECTION) {
    last.end = bounds.end;
    if (last.start >= last.end) last.start = Math.max(last.end - 0.15, out[out.length - 2]?.end ?? bounds.start);
  }
  return out;
}

/**
 * Pull word edges out of measured silence.
 *
 * Whisper's word timestamps are least accurate at the edges of speech: the
 * first word of a window is typically pinned to the window's start and
 * stretched ("A" given 0.8 s, from well before the sound), and the last word
 * of a sentence runs on into the pause after it. Those are exactly the edges a
 * viewer sees — a subtitle appearing before anyone speaks.
 *
 * The silences are measured on the same recording (ffmpeg `silencedetect`),
 * so they are evidence of where speech is NOT. A word that starts inside a
 * silence is moved to the silence's end; one that ends inside a silence is
 * moved to its start. A word lying wholly inside a silence is left alone —
 * there is no sound to move it to, and inventing one would be a guess.
 * Order is preserved: no word is moved past its neighbour.
 */
export function snapToSound(words: TimedWord[], quiet: Silence[]): TimedWord[] {
  const out = words.map((w) => ({ ...w }));
  const inside = (t: number) => quiet.find((q) => t > q.start + 1e-3 && t < q.end - 1e-3);
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const qs = inside(w.start);
    if (qs && qs.end < w.end) w.start = qs.end;
    const qe = inside(w.end);
    if (qe && qe.start > w.start) w.end = qe.start;
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) out[i].start = Math.min(out[i - 1].end, out[i].end);
  }
  return out;
}

/** Where speech actually starts and stops in a beat: its first and last words. */
export function speechSpan(words: TimedWord[]): Window | null {
  if (!words.length) return null;
  return { start: words[0].start, end: words[words.length - 1].end };
}
