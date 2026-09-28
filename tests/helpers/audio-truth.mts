/**
 * Ground truth for word timing that does not come from the recogniser itself:
 * ffmpeg's `silencedetect` on the mastered voice. Silence is physics, not a
 * model's opinion — a word timestamp that says speech is happening inside a
 * measured silence, or that a beat starts well before its sound does, is wrong.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG } from "../../src/lib/media/ffmpeg";
import type { TimedWord } from "../../src/lib/media/word-timing";
import type { BeatAudio } from "../../src/lib/media/tts";

const exec = promisify(execFile);

export interface Interval {
  start: number;
  end: number;
}

/** Silences of at least `minDur` seconds below `noiseDb`. */
export async function silences(file: string, noiseDb = -38, minDur = 0.12): Promise<Interval[]> {
  const { stderr } = await exec(FFMPEG, ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-"], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out: Interval[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Math.max(0, parseFloat(s[1]));
    if (e && start !== null) {
      out.push({ start, end: parseFloat(e[1]) });
      start = null;
    }
  }
  return out;
}

/** A burst of sound shorter than this at a window's edge is a click or breath, not speech. */
const BLIP = 0.12;

/**
 * Where sound actually starts and stops inside a window, given the silences.
 * Skips a sub-BLIP burst at either edge (a click from mastering, a breath) so
 * the measuring stick is not itself wrong.
 */
export function soundSpan(window: Interval, quiet: Interval[]): Interval | null {
  const qs = quiet.filter((q) => q.end > window.start && q.start < window.end).sort((a, b) => a.start - b.start);
  let start = window.start;
  for (const q of qs) {
    if (q.start <= start + BLIP && q.end > start) start = Math.min(q.end, window.end);
  }
  let end = window.end;
  for (const q of [...qs].reverse()) {
    if (q.end >= end - BLIP && q.start < end) end = Math.max(q.start, window.start);
  }
  return end > start ? { start, end } : null;
}

export interface TimingAccuracy {
  beats: number;
  /** |first word start − measured sound start| per beat, seconds. */
  onsetErrors: number[];
  /** |last word end − measured sound end| per beat, seconds. */
  offsetErrors: number[];
  /** Pauses of ≥ 0.25 s inside a beat (between sentences or clauses). */
  internalPauses: number;
  /** How far the word after each internal pause starts from where the pause measurably ends. */
  resumeErrors: number[];
  /** Words whose timing spans the core of a measured pause (the pause minus 60 ms at each edge). */
  straddles: string[];
  /** Words outside the audio, or with end < start. */
  outOfBounds: number;
}

export async function measureTiming(audio: string, totalDuration: number, beats: BeatAudio[], words: TimedWord[]): Promise<TimingAccuracy> {
  const quiet = await silences(audio);
  const acc: TimingAccuracy = {
    beats: beats.length, onsetErrors: [], offsetErrors: [], internalPauses: 0, resumeErrors: [], straddles: [], outOfBounds: 0,
  };
  for (const w of words) if (w.start < 0 || w.end > totalDuration + 1e-3 || w.end < w.start) acc.outOfBounds++;

  for (const b of beats) {
    const bw = words.filter((w) => w.beatIndex === b.index);
    if (!bw.length) continue;
    const sound = soundSpan({ start: b.start, end: b.end }, quiet);
    if (!sound) continue;
    acc.onsetErrors.push(Math.abs(bw[0].start - sound.start));
    acc.offsetErrors.push(Math.abs(bw[bw.length - 1].end - sound.end));

    const inside = quiet.filter((q) => q.start > sound.start + 0.05 && q.end < sound.end - 0.05 && q.end - q.start >= 0.25);
    for (const q of inside) {
      acc.internalPauses++;
      const core = { start: q.start + 0.06, end: q.end - 0.06 };
      for (const w of bw) {
        if (w.start < core.start && w.end > core.end) acc.straddles.push(`${w.word}@${w.start.toFixed(2)}-${w.end.toFixed(2)} over ${q.start.toFixed(2)}-${q.end.toFixed(2)}`);
      }
      const next = bw.find((w) => w.start >= q.start - 0.05);
      if (next) acc.resumeErrors.push(Math.abs(next.start - q.end));
    }
  }
  return acc;
}

export function summarize(xs: number[]): { mean: number; median: number; p90: number; max: number } {
  if (!xs.length) return { mean: 0, median: 0, p90: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}
