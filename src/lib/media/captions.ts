import type { BeatAudio } from "./tts";

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

/**
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

export function toSrt(lines: CaptionLine[]): string {
  return lines
    .map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`)
    .join("\n");
}
