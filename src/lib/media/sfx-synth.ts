/**
 * Organic Trailer-Grade Sound Effects (SFX) Engine for vertical book Shorts/Reels.
 *
 * Synthesizes sample-accurate, 100% deterministic 44.1 kHz PCM WAV cues in Node
 * with warm multi-tap room reverb so transitions, hook impacts, and card reveals
 * sound like natural film sound design (deep taiko/sub boom, organic cloth/air
 * swish, damped wood/shutter thock, warm string/air swell) rather than dry synth beeps.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SAMPLE_RATE, toWav } from "./music-synth";
import type { Scene } from "../video/scenes/types";

export type SfxKind = "hook-hit" | "scene-whoosh" | "card-pop" | "payoff-riser";

export interface SfxCue {
  timeSec: number;
  kind: SfxKind;
}

export interface GenerateSfxOptions {
  durationSec: number;
  audioOffsetSec: number;
  scenes: Scene[];
  outPath: string;
}

const MOTION_POP_KINDS = new Set<Scene["kind"]>([
  "comparison",
  "steps",
  "timeline",
  "stat",
  "growth-curve",
  "icon-concept",
  "book-crop",
]);

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

/**
 * Plan frame-accurate SFX cues from the episode's actual scene boundaries.
 */
export function planSfxCues(opts: {
  durationSec: number;
  audioOffsetSec: number;
  scenes: Scene[];
}): SfxCue[] {
  const { durationSec, audioOffsetSec, scenes } = opts;
  if (!(durationSec > 0.6)) return [];

  const raw: SfxCue[] = [];

  // 1. Scroll-stopping deep cinema boom right as the hook opens.
  raw.push({ timeSec: 0.03, kind: "hook-hit" });

  // 2. Organic transition swishes & damped tactile card thocks.
  let lastTransitionT = 0.03;
  for (let i = 1; i < scenes.length; i++) {
    const s = scenes[i];
    const cutT = audioOffsetSec + s.start;
    if (!Number.isFinite(cutT) || cutT <= 0.45 || cutT >= durationSec - 0.35) continue;

    if (cutT - lastTransitionT >= 1.8) {
      const whooshStart = Math.max(0.25, cutT - 0.14);
      raw.push({ timeSec: Math.round(whooshStart * 1000) / 1000, kind: "scene-whoosh" });
      lastTransitionT = cutT;
    }

    if (MOTION_POP_KINDS.has(s.kind)) {
      const popT = Math.min(durationSec - 0.2, cutT + 0.09);
      raw.push({ timeSec: Math.round(popT * 1000) / 1000, kind: "card-pop" });
    }
  }

  // 3. Warm cinematic swell leading into the final scene.
  if (scenes.length >= 3) {
    const finalScene = scenes[scenes.length - 1];
    const finalCut = audioOffsetSec + finalScene.start;
    const riserStart = finalCut - 1.05;
    if (riserStart > 1.4 && riserStart + 1.1 < durationSec - 0.15) {
      raw.push({ timeSec: Math.round(riserStart * 1000) / 1000, kind: "payoff-riser" });
    }
  }

  return raw.sort((a, b) => a.timeSec - b.timeSec);
}

/** Deep cinema trailer sub-boom + warm taiko chest thump (zero high-pitched beep). */
function addHookHit(buf: Float32Array, atSec: number): void {
  const lenSec = 0.85;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(101);
  const lpCut = 1 - Math.exp((-2 * Math.PI * 420) / SAMPLE_RATE);
  let lp = 0;

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    // Deep sub glide 74 Hz -> 31 Hz + chest body 138 Hz -> 52 Hz
    const subPhase = 2 * Math.PI * (31 * t + 43 * 0.065 * (1 - Math.exp(-t / 0.065)));
    const bodyPhase = 2 * Math.PI * (52 * t + 86 * 0.028 * (1 - Math.exp(-t / 0.028)));
    lp += lpCut * (noise() - lp);

    const sub = Math.tanh(Math.sin(subPhase) * 1.35) * Math.exp(-t / 0.28) * 0.68;
    const chest = Math.sin(bodyPhase) * Math.exp(-t / 0.085) * 0.34;
    const mallet = lp * Math.exp(-t / 0.032) * 0.24;
    const env = ramp(t, 0.005) * ramp(lenSec - t, 0.12);
    buf[idx] += (sub + chest + mallet) * 0.32 * env;
  }
}

/** Warm organic cloth/air cinema swish (dual-pole low-mid filtered air + subtle sub weight). */
function addSceneWhoosh(buf: Float32Array, atSec: number, seedOffset: number): void {
  const lenSec = 0.34;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(307 + seedOffset * 37);
  let lp1 = 0;
  let lp2 = 0;
  let hpState = 0;
  let prevIn = 0;
  const hpAlpha = Math.exp((-2 * Math.PI * 110) / SAMPLE_RATE);

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const u = t / lenSec;
    const bell = Math.sin(Math.PI * u);
    // Warm organic cutoff 180 Hz -> 780 Hz -> 200 Hz (never harsh static hiss!)
    const cutoff = 180 + 600 * bell * bell;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
    const raw = noise();
    hpState = hpAlpha * (hpState + raw - prevIn);
    prevIn = raw;
    lp1 += a * (hpState - lp1);
    lp2 += a * (lp1 - lp2);

    // Subtle low-end air movement (85 Hz -> 52 Hz) so the cut is felt physically
    const airSub = Math.sin(2 * Math.PI * (52 + 33 * bell) * t) * 0.18 * bell;
    const env = Math.pow(bell, 1.45);
    buf[idx] += (lp2 * 0.28 + airSub * 0.12) * env;
  }
}

/** Warm damped wooden/shutter tactile thock when a visual card arrives. */
function addCardPop(buf: Float32Array, atSec: number): void {
  const lenSec = 0.075;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(509);
  const clickLp = 1 - Math.exp((-2 * Math.PI * 1600) / SAMPLE_RATE);
  let lp = 0;

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    // Damped low-wood thock: 320 Hz -> 135 Hz in 12ms
    const phase = 2 * Math.PI * (135 * t + 185 * 0.012 * (1 - Math.exp(-t / 0.012)));
    lp += clickLp * (noise() - lp);
    const wood = Math.sin(phase) * Math.exp(-t / 0.019) * 0.75;
    const felt = lp * Math.exp(-t / 0.006) * 0.25;
    const env = ramp(t, 0.002) * ramp(lenSec - t, 0.012);
    buf[idx] += (wood + felt) * 0.16 * env;
  }
}

/** Warm cinematic fifth swell + filtered air crescendo into the final takeaway. */
function addPayoffRiser(buf: Float32Array, atSec: number): void {
  const lenSec = 1.05;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(911);
  let lp1 = 0;
  let lp2 = 0;
  let phaseA = 0;
  let phaseB = 0;

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const u = t / lenSec;
    const hzA = 146.83 * Math.pow(2, (u * 3) / 12); // D3 warm rise
    const hzB = hzA * 1.5; // A3 fifth
    phaseA += (2 * Math.PI * hzA) / SAMPLE_RATE;
    phaseB += (2 * Math.PI * hzB) / SAMPLE_RATE;

    const a = 1 - Math.exp((-2 * Math.PI * (220 + 620 * u * u)) / SAMPLE_RATE);
    lp1 += a * (noise() - lp1);
    lp2 += a * (lp1 - lp2);

    const swell = u * u * ramp(lenSec - t, 0.11);
    const tone = Math.sin(phaseA) * 0.48 + Math.sin(phaseB) * 0.28 + lp2 * 0.35;
    buf[idx] += tone * 0.13 * swell;
  }
}

/** Gentle room reverb tail so every SFX cue sits inside the same acoustic space as the music score. */
function applyRoomGlue(dry: Float32Array): Float32Array {
  const n = dry.length;
  const out = new Float32Array(n);
  const delays = [997, 1361, 1777];
  const gains = [0.46, 0.42, 0.38];
  for (let c = 0; c < delays.length; c++) {
    const d = delays[c];
    const g = gains[c];
    const line = new Float32Array(d);
    let ptr = 0;
    let damp = 0;
    for (let i = 0; i < n; i++) {
      const y = line[ptr];
      damp = y * 0.62 + damp * 0.38;
      line[ptr] = dry[i] + damp * g;
      ptr = (ptr + 1) % d;
      out[i] += y * 0.11;
    }
  }
  for (let i = 0; i < n; i++) out[i] += dry[i] * 0.92;
  return out;
}

export function renderSfxBuffer(durationSec: number, cues: SfxCue[]): Float32Array {
  const samples = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
  const dry = new Float32Array(samples);

  cues.forEach((cue, idx) => {
    switch (cue.kind) {
      case "hook-hit":
        addHookHit(dry, cue.timeSec);
        break;
      case "scene-whoosh":
        addSceneWhoosh(dry, cue.timeSec, idx);
        break;
      case "card-pop":
        addCardPop(dry, cue.timeSec);
        break;
      case "payoff-riser":
        addPayoffRiser(dry, cue.timeSec);
        break;
    }
  });

  const buf = applyRoomGlue(dry);
  const ceiling = 0.41;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    if (Math.abs(x) > ceiling) {
      buf[i] = Math.tanh(x / ceiling) * ceiling;
    }
  }
  return buf;
}

export async function generateSfxTrack(opts: GenerateSfxOptions): Promise<{ cues: SfxCue[] }> {
  const cues = planSfxCues(opts);
  const buf = renderSfxBuffer(opts.durationSec, cues);
  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.writeFile(opts.outPath, toWav(buf, SAMPLE_RATE));
  return { cues };
}
