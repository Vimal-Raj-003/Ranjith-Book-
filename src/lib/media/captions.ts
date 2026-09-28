import type { BeatAudio } from "./tts";
import type { TimedWord } from "./word-timing";

export interface CaptionWord {
  word: string;
  start: number;
  end: number;
}

export interface CaptionLine {
  text: string;
  start: number;
  end: number;
  beatIndex: number;
  words: CaptionWord[];
}

/** A silence at least this long between two words is a place to break a line. */
export const PAUSE_BREAK = 0.28;
/** A line stays up across a pause shorter than this, rather than flickering off. */
const BRIDGE = 0.7;
/** How long a line lingers after its last word when nothing follows closely. */
const LINGER = 0.3;

/**
 * Subtitle lines from words timed against the real audio (`word-timing.ts`).
 *
 * 2–4 words a line. A line ends early — at two or three words — where the
 * speaker actually pauses (a measured silence of PAUSE_BREAK or more) or a
 * sentence or clause ends, so a line never straddles a breath. A line of one
 * word is only made when a beat is a single word; otherwise a lone trailing
 * word joins the line before it (or takes that line's last word with it).
 *
 * Each line starts on its first word's real start. It ends at the next
 * line's start when that is within BRIDGE seconds (so a short pause does not
 * blink the caption off), otherwise LINGER after its last word. Words keep
 * their real timings, for a highlight of the word being spoken.
 */
export function buildCaptionsFromWords(words: TimedWord[], maxWords = 4): CaptionLine[] {
  const lines: CaptionLine[] = [];
  const byBeat = new Map<number, TimedWord[]>();
  for (const w of words) {
    if (!byBeat.has(w.beatIndex)) byBeat.set(w.beatIndex, []);
    byBeat.get(w.beatIndex)!.push(w);
  }

  for (const [beatIndex, beatWords] of [...byBeat.entries()].sort((a, b) => a[0] - b[0])) {
    const groups: TimedWord[][] = [];
    let cur: TimedWord[] = [];
    beatWords.forEach((w, i) => {
      cur.push(w);
      const next = beatWords[i + 1];
      if (!next) return;
      const pause = next.start - w.end;
      const clauseEnd = /[.!?;:—–]["'”’)]*$|,["'”’)]*$/.test(w.word);
      // A measured pause always ends a line, even after one word: a line must
      // never be on screen across a silence, showing words not yet spoken.
      // (A lone word that the speech does NOT isolate is merged back below.)
      if (cur.length >= maxWords || pause >= PAUSE_BREAK || (cur.length >= 2 && clauseEnd)) {
        groups.push(cur);
        cur = [];
      }
    });
    if (cur.length) groups.push(cur);

    // No lone word — unless it stands alone in the speech too: a short
    // sentence after a real pause ("…who you are." [pause] "Work.") reads
    // better as its own line than glued across the silence to the one before.
    for (let g = groups.length - 1; g > 0; g--) {
      if (groups[g].length !== 1) continue;
      const prev = groups[g - 1];
      const prevLast = prev[prev.length - 1];
      const isolated = groups[g][0].start - prevLast.end >= PAUSE_BREAK || /[.!?]["'”’)]*$/.test(prevLast.word);
      if (isolated) continue;
      if (prev.length < maxWords) {
        prev.push(...groups[g]);
        groups.splice(g, 1);
      } else {
        groups[g].unshift(prev.pop()!);
      }
    }

    groups.forEach((g) => {
      lines.push({
        text: g.map((w) => w.word).join(" "),
        start: g[0].start,
        end: g[g.length - 1].end,
        beatIndex,
        words: g.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      });
    });
  }

  // Bridge short pauses to the next line of the same beat; linger otherwise.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const lastWordEnd = lines[i].words[lines[i].words.length - 1].end;
    if (next && next.beatIndex === lines[i].beatIndex && next.start - lastWordEnd <= BRIDGE) {
      lines[i].end = next.start;
    } else {
      lines[i].end = next ? Math.min(lastWordEnd + LINGER, next.start) : lastWordEnd + LINGER;
    }
  }
  return lines;
}

/**
 * ESTIMATED timing — the fallback when word timing from the audio is not
 * available (`narration-timing.ts` records which one a video used).
 *
 * Distribute word timings inside each beat's measured audio window.
 * Weight each word by its character length plus a small fixed cost per word,
 * which tracks real speech pacing far better than an even split.
 */
export function buildCaptions(beats: BeatAudio[], wordsPerLine = 4): CaptionLine[] {
  const lines: CaptionLine[] = [];

  for (const beat of beats) {
    const words = beat.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    // Weight by length, and give trailing punctuation extra time — a comma or
    // full stop is a real pause in the audio, not a zero-width character.
    const weights = words.map((w) => {
      const letters = w.replace(/[^\w']/g, "").length;
      const pause = /[.!?]$/.test(w) ? 3.2 : /[,;:—]$/.test(w) ? 1.6 : 0;
      return letters + 2.2 + pause;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const span = Math.max(0.2, beat.speechEnd - beat.speechStart);

    const timed: CaptionWord[] = [];
    let cursor = beat.speechStart;
    words.forEach((w, i) => {
      const dur = (weights[i] / total) * span;
      timed.push({ word: w, start: cursor, end: cursor + dur });
      cursor += dur;
    });

    for (let i = 0; i < timed.length; i += wordsPerLine) {
      const chunk = timed.slice(i, i + wordsPerLine);
      lines.push({
        text: chunk.map((c) => c.word).join(" "),
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        beatIndex: beat.index,
        words: chunk,
      });
    }
  }

  return lines;
}

function srtTime(t: number) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msr = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(msr, 3)}`;
}

/**
 * `offset` is where the voice track starts inside the finished video
 * (`AUDIO_OFFSET`). Caption times are in the voice track's clock; an SRT is
 * uploaded beside the MP4, so it must be in the video's clock — without the
 * offset every subtitle would appear that much early.
 */
export function toSrt(lines: CaptionLine[], offset = 0): string {
  return lines
    .map((l, i) => `${i + 1}\n${srtTime(offset + l.start)} --> ${srtTime(offset + l.end)}\n${l.text}\n`)
    .join("\n");
}
