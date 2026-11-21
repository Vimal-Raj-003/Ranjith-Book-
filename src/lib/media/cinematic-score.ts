/**
 * Warm Cinematic Score Engine for Viral Shorts/Reels (`Between Pages`).
 *
 * Replaces dry 3-sine organ tones during episode renders with a rich, emotional
 * documentary underscore: chorused warm cello/viola strings, gentle felt-piano
 * chord voicings, subtle heartbeat bass pulse, and a smooth multi-tap Schroeder
 * hall reverb, sidechain-ducked cleanly beneath the studio voiceover.
 *
 * Kept separate from `music-synth.ts` so existing unit tests (`music-moods.test.mts`,
 * `audio-mix.test.mts`) that pin `renderPad` byte-for-byte remain untouched.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { SAMPLE_RATE, semitone, toWav, type MusicMood } from "./music-synth";
import { MOODS } from "./moods";
import { ffmpeg } from "./ffmpeg";

function seededNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  };
}

function ramp(pos: number, len: number): number {
  if (len <= 0) return 1;
  return Math.min(1, Math.max(0, pos / len));
}

/** Rich warm string wave: fundamental + soft octave + gentle fifth warmth (zero harsh buzz). */
function warmStringSample(phase: number, phaseDetuneA: number, phaseDetuneB: number): number {
  const core = (Math.sin(phase) + Math.sin(phaseDetuneA) * 0.72 + Math.sin(phaseDetuneB) * 0.72) / 2.44;
  const body = Math.sin(phase * 2) * 0.22 + Math.sin(phase * 3) * 0.06;
  return core * 0.82 + body;
}

/** Soft felt-piano note: warm fundamental + quick-decaying upper bell overtones. */
function feltPianoSample(phase: number, t: number): number {
  const f1 = Math.sin(phase) * Math.exp(-t / 1.65);
  const f2 = Math.sin(phase * 2) * 0.28 * Math.exp(-t / 0.65);
  const f3 = Math.sin(phase * 3) * 0.09 * Math.exp(-t / 0.28);
  const hammer = Math.sin(phase * 4.02) * 0.05 * Math.exp(-t / 0.035);
  return f1 + f2 + f3 + hammer;
}

/** Smooth 4-comb + 2-allpass Schroeder hall reverb for lush cinematic space. */
function applyWarmHallReverb(dry: Float32Array, wetMix = 0.34): Float32Array {
  const n = dry.length;
  const combDelays = [1327, 1637, 1933, 2269];
  const combGains = [0.76, 0.74, 0.71, 0.68];
  const wet = new Float32Array(n);

  for (let c = 0; c < combDelays.length; c++) {
    const delay = combDelays[c];
    const g = combGains[c];
    const line = new Float32Array(delay);
    let ptr = 0;
    let damp = 0;
    for (let i = 0; i < n; i++) {
      const out = line[ptr];
      damp = out * 0.68 + damp * 0.32; // warm high-frequency damping inside tank
      line[ptr] = dry[i] + damp * g;
      ptr = (ptr + 1) % delay;
      wet[i] += out * 0.25;
    }
  }

  // Two cascaded allpass diffusers so echoes melt into a smooth velvet tail.
  for (const apDelay of [347, 113]) {
    const apLine = new Float32Array(apDelay);
    let ptr = 0;
    const g = 0.5;
    for (let i = 0; i < n; i++) {
      const x = wet[i];
      const d = apLine[ptr];
      const y = -g * x + d;
      apLine[ptr] = x + g * y;
      ptr = (ptr + 1) % apDelay;
      wet[i] = y;
    }
  }

  const out = new Float32Array(n);
  const dryMix = 1 - wetMix * 0.45;
  for (let i = 0; i < n; i++) {
    out[i] = dry[i] * dryMix + wet[i] * wetMix;
  }
  return out;
}

export function renderCinematicScore(durationSec: number, mood: MusicMood): Float32Array {
  const n = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const buf = new Float32Array(n);
  const chordLen = Math.max(3.2, mood.chordSeconds);
  const overlap = 1.6;
  const slots = Math.ceil(durationSec / chordLen);

  // 1. Warm chorused cello & viola pad + sub-bass anchor + felt piano voicings
  for (let slot = 0; slot < slots; slot++) {
    const at = slot * chordLen;
    const len = Math.min(chordLen + overlap, durationSec - at);
    if (len <= 0.35) break;

    const chord = mood.progression[slot % mood.progression.length];
    const rise = Math.min(1.5, len * 0.42);
    const fall = Math.min(1.8, len * 0.48);
    const start = Math.round(at * SAMPLE_RATE);
    const count = Math.round(len * SAMPLE_RATE);

    // Warm string voices
    chord.forEach((step, voiceIdx) => {
      const hz = semitone(mood.root, step);
      const level = voiceIdx === 0 ? 0.34 : voiceIdx === 1 ? 0.24 : 0.18;
      const w0 = (2 * Math.PI * hz) / SAMPLE_RATE;
      const wA = (2 * Math.PI * hz * 1.0022) / SAMPLE_RATE; // +3.8 cents chorus
      const wB = (2 * Math.PI * hz * 0.9978) / SAMPLE_RATE; // -3.8 cents chorus
      for (let i = 0; i < count; i++) {
        const idx = start + i;
        if (idx >= n) break;
        const t = i / SAMPLE_RATE;
        const env = ramp(t, rise) * ramp(len - t, fall);
        buf[idx] += warmStringSample(w0 * i, wA * i, wB * i) * level * env;
      }
    });

    // Deep warm cello/bass root an octave below
    const bassHz = semitone(mood.root, chord[0]) * 0.5;
    const wBass = (2 * Math.PI * bassHz) / SAMPLE_RATE;
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SAMPLE_RATE;
      const env = ramp(t, Math.min(0.6, rise)) * ramp(len - t, Math.min(1.1, fall));
      buf[idx] += (Math.sin(wBass * i) * 0.7 + Math.sin(2 * wBass * i) * 0.3) * 0.22 * env;
    }

    // Delicate felt-piano arpeggio notes (4 gentle notes per chord, octave above pad, clear of voice mids)
    const pianoSteps = [0, 2, 1, 2];
    const noteSpacing = chordLen / pianoSteps.length;
    pianoSteps.forEach((pIdx, k) => {
      const noteAt = at + k * noteSpacing;
      if (noteAt >= durationSec - 0.3) return;
      const semi = chord[pIdx % chord.length] + 12;
      const pHz = semitone(mood.root, semi);
      const wp = (2 * Math.PI * pHz) / SAMPLE_RATE;
      const pStart = Math.round(noteAt * SAMPLE_RATE);
      const pDur = Math.min(2.4, durationSec - noteAt);
      const pCount = Math.round(pDur * SAMPLE_RATE);
      const vel = k === 0 ? 0.19 : 0.13;
      for (let i = 0; i < pCount; i++) {
        const idx = pStart + i;
        if (idx >= n) break;
        const t = i / SAMPLE_RATE;
        const env = ramp(t, 0.012) * ramp(pDur - t, 0.18);
        buf[idx] += feltPianoSample(wp * i, t) * vel * env;
      }
    });

    // Soft heartbeat pulse at the start of each chord (subtle warm cinema tension)
    const hbDur = 0.38;
    const hbCount = Math.round(hbDur * SAMPLE_RATE);
    for (let i = 0; i < hbCount; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SAMPLE_RATE;
      const phase = 2 * Math.PI * (46 * t + 48 * 0.035 * (1 - Math.exp(-t / 0.035)));
      buf[idx] += (Math.sin(phase) + 0.35 * Math.sin(2 * phase)) * Math.exp(-t / 0.11) * ramp(t, 0.006) * 0.16;
    }
  }

  // Subtle warm vinyl/room air so silence between notes feels alive
  const noise = seededNoise(42);
  const lpCut = 1 - Math.exp((-2 * Math.PI * 480) / SAMPLE_RATE);
  let air = 0;
  for (let i = 0; i < n; i++) {
    air += lpCut * (noise() * 0.02 - air);
    buf[i] += air * 0.25;
  }

  // Warm low-pass roll-off around 1.6 kHz so the score never clashes with 2–4 kHz speech intelligibility
  const warmCut = 1 - Math.exp((-2 * Math.PI * 1650) / SAMPLE_RATE);
  let warmState = 0;
  for (let i = 0; i < n; i++) {
    warmState += warmCut * (buf[i] - warmState);
    buf[i] = warmState;
  }

  return applyWarmHallReverb(buf, 0.36);
}

export async function generateCinematicScoreWav(
  durationSec: number,
  outPath: string,
  opts: {
    style?: string;
    voicePath?: string;
    voiceOffsetSec?: number;
    targetMeanDb?: number;
  } = {},
): Promise<void> {
  const d = Math.max(1, +durationSec.toFixed(3));
  const mood = MOODS[opts.style ?? "spotlight"] ?? MOODS.spotlight;
  const targetDb = opts.targetMeanDb ?? -19.5;

  const rawBuf = renderCinematicScore(d, mood);

  // Level RMS to targetDb with smooth fade-in (0.35s — immediate Shorts energy!) and clean outro fade-out.
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < rawBuf.length; i++) {
    sum += rawBuf[i] * rawBuf[i];
    const a = Math.abs(rawBuf[i]);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, rawBuf.length));
  let gain = rms > 1e-9 ? Math.pow(10, targetDb / 20) / rms : 0;
  if (peak * gain > 0.92) gain = 0.92 / peak;

  const inN = Math.round(0.35 * SAMPLE_RATE);
  const outN = Math.round(Math.min(2.2, d * 0.12) * SAMPLE_RATE);
  for (let i = 0; i < rawBuf.length; i++) rawBuf[i] *= gain;
  for (let i = 0; i < Math.min(inN, rawBuf.length); i++) rawBuf[i] *= i / inN;
  for (let i = 0; i < Math.min(outN, rawBuf.length); i++) {
    rawBuf[rawBuf.length - 1 - i] *= i / outN;
  }

  const rawPath = `${outPath}.score.raw.wav`;
  await fsp.writeFile(rawPath, toWav(rawBuf, SAMPLE_RATE));

  if (!opts.voicePath || !fs.existsSync(opts.voicePath)) {
    await fsp.rename(rawPath, outPath);
    return;
  }

  const offsetMs = Math.round((opts.voiceOffsetSec ?? 0) * 1000);
  await ffmpeg([
    "-i", rawPath,
    "-i", opts.voicePath,
    "-filter_complex",
    `[1]adelay=${offsetMs}|${offsetMs},apad[key];` +
      `[0][key]sidechaincompress=threshold=0.045:ratio=4.5:attack=35:release=680:makeup=1[ducked]`,
    "-map", "[ducked]",
    "-ar", "44100", "-ac", "1",
    "-t", String(d),
    outPath,
  ]);
  await fsp.rm(rawPath, { force: true }).catch(() => {});
}
