/**
 * Ground truth for word timing that does not come from the recogniser itself:
 * ffmpeg's `silencedetect` on the mastered voice. Silence is physics, not a
 * model's opinion — a word timestamp that says speech is happening inside a
 * measured silence, or that a beat starts well before its sound does, is wrong.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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

/**
 * Where SPEECH starts, measured a different way from `silences` on purpose.
 * silencedetect is a per-sample peak test, so at -35 dB it hears the TTS's
 * inhale (~-40 dBFS RMS, ~28 dB under the speech) as sound and puts a beat's
 * "start" 0.2-0.8 s before anything is said. A 20 ms RMS reaching -30 dBFS
 * lands on the voiced onset instead (mid-beat, the recogniser's word starts
 * agree with it to ~40 ms median). Reads 16-bit PCM WAV, as the pipeline writes.
 */
const SPEECH_RMS_DB = -30;
export interface Pcm {
  samples: Int16Array;
  rate: number;
  channels: number;
}
export async function readPcm(file: string): Promise<Pcm> {
  const buf = await fs.readFile(file);
  let pos = 12;
  let rate = 44100;
  let channels = 1;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(pos + 10);
      rate = buf.readUInt32LE(pos + 12);
    }
    if (id === "data") {
      const bytes = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
      return { samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.length & ~1))), rate, channels };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}
/** First time in [from, to] at which the 20 ms RMS reaches SPEECH_RMS_DB, or null. */
export function speechOnset(pcm: Pcm, from: number, to: number): number | null {
  const win = Math.round(0.02 * pcm.rate) * pcm.channels;
  for (let t = Math.max(0, from); t < to; t += 0.005) {
    const i = Math.floor(t * pcm.rate) * pcm.channels;
    if (i + win > pcm.samples.length) return null;
    let sum = 0;
    for (let k = 0; k < win; k++) sum += (pcm.samples[i + k] / 32768) ** 2;
    if (10 * Math.log10(sum / win + 1e-12) >= SPEECH_RMS_DB) return t;
  }
  return null;
}

export interface TimingAccuracy {
  beats: number;
  /** |first word start − where the beat's speech starts (see speechOnset)| per beat, seconds. */
  onsetErrors: number[];
  /** |last word end − measured sound end| per beat, seconds. */
  offsetErrors: number[];
  /** Pauses of ≥ 0.25 s inside a beat (between sentences or clauses). */
  internalPauses: number;
  /** How far the word after each internal pause starts from where speech measurably resumes. */
  resumeErrors: number[];
  /** Words whose timing spans the core of a measured pause (the pause minus 60 ms at each edge). */
  straddles: string[];
  /** Words outside the audio, or with end < start. */
  outOfBounds: number;
}

export async function measureTiming(audio: string, totalDuration: number, beats: BeatAudio[], words: TimedWord[]): Promise<TimingAccuracy> {
  const quiet = await silences(audio);
  const pcm = await readPcm(audio);
  const acc: TimingAccuracy = {
    beats: beats.length, onsetErrors: [], offsetErrors: [], internalPauses: 0, resumeErrors: [], straddles: [], outOfBounds: 0,
  };
  for (const w of words) if (w.start < 0 || w.end > totalDuration + 1e-3 || w.end < w.start) acc.outOfBounds++;

  for (const b of beats) {
    const bw = words.filter((w) => w.beatIndex === b.index);
    if (!bw.length) continue;
    const sound = soundSpan({ start: b.start, end: b.end }, quiet);
    if (!sound) continue;
    acc.onsetErrors.push(Math.abs(bw[0].start - (speechOnset(pcm, sound.start - 0.05, sound.end) ?? sound.start)));
    acc.offsetErrors.push(Math.abs(bw[bw.length - 1].end - sound.end));

    const inside = quiet.filter((q) => q.start > sound.start + 0.05 && q.end < sound.end - 0.05 && q.end - q.start >= 0.25);
    for (const q of inside) {
      acc.internalPauses++;
      const core = { start: q.start + 0.06, end: q.end - 0.06 };
      for (const w of bw) {
        if (w.start < core.start && w.end > core.end) acc.straddles.push(`${w.word}@${w.start.toFixed(2)}-${w.end.toFixed(2)} over ${q.start.toFixed(2)}-${q.end.toFixed(2)}`);
      }
      const next = bw.find((w) => w.start >= q.start - 0.05);
      if (next) acc.resumeErrors.push(Math.abs(next.start - (speechOnset(pcm, q.end - 0.05, q.end + 1.5) ?? q.end)));
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
