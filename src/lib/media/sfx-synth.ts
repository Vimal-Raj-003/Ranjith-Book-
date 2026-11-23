/**
 * Earshot-Grade Procedural Foley & Audio-Visual Sync Engine for BookReel Shorts/Reels.
 *
 * Synthesizes sample-accurate, 100% deterministic 44.1 kHz PCM WAV foley cues in Node
 * (deep taiko/sub boom, organic cloth/air swish, damped wood thock, paper page-turn,
 * felt marker highlight swish, mechanical stat/step counter ticks, warm sub-drop,
 * and cinematic fifth swell), applies voice-aware speech-envelope sidechain ducking
 * so foley never masks spoken syllables, and verifies frame-accurate cut-sync & headroom.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SAMPLE_RATE, toWav } from "./music-synth";
import type { Scene } from "../video/scenes/types";

export type SfxKind =
  | "hook-hit"
  | "scene-whoosh"
  | "card-pop"
  | "payoff-riser"
  | "page-turn"
  | "marker-swish"
  | "counter-tick"
  | "sub-drop"
  | "ui-click"
  | "shutter-snap"
  | "clock-tick";

export interface SfxCue {
  timeSec: number;
  kind: SfxKind;
}

export interface SpeechSpan {
  start: number;
  end: number;
}

export interface EarshotSyncReport {
  ok: boolean;
  cuesTotal: number;
  syncedCues: number;
  maxDriftMs: number;
  peakDb: number;
  voiceDucked: boolean;
}

export interface GenerateSfxOptions {
  durationSec: number;
  audioOffsetSec: number;
  scenes: Scene[];
  outPath: string;
  /** Optional book-page marker sweep spans (in voice clock seconds) for subtle felt-tip swishes. */
  strokes?: SpeechSpan[];
  /** Optional spoken word spans (in voice clock seconds) for voice-aware sidechain ducking. */
  speechSpans?: SpeechSpan[];
}

const MOTION_POP_KINDS = new Set<Scene["kind"]>([
  "comparison",
  "steps",
  "timeline",
  "stat",
  "growth-curve",
  "icon-concept",
]);

const PAGE_SCENE_KINDS = new Set<Scene["kind"]>(["book-page", "book-crop"]);

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
 * Plan frame-accurate Earshot foley cues from scene boundaries, book-page arrivals,
 * marker highlight strokes, and stat/step counters.
 */
export function planSfxCues(opts: {
  durationSec: number;
  audioOffsetSec: number;
  scenes: Scene[];
  strokes?: SpeechSpan[];
}): SfxCue[] {
  const { durationSec, audioOffsetSec, scenes, strokes = [] } = opts;
  if (!(durationSec > 0.6)) return [];

  const raw: SfxCue[] = [];

  // 1. Scroll-stopping deep cinema boom right as the hook opens.
  raw.push({ timeSec: 0.03, kind: "hook-hit" });

  // 2. Scene-specific Earshot foley: page-turns, air whooshes, card thocks, sub-drops & counter ticks.
  let lastTransitionT = 0.03;
  for (let i = 1; i < scenes.length; i++) {
    const s = scenes[i];
    const cutT = audioOffsetSec + s.start;
    if (!Number.isFinite(cutT) || cutT <= 0.45 || cutT >= durationSec - 0.35) continue;

    if (PAGE_SCENE_KINDS.has(s.kind)) {
      const pageT = Math.max(0.25, cutT - 0.08);
      raw.push({ timeSec: Math.round(pageT * 1000) / 1000, kind: "page-turn" });
      if (s.kind === "book-crop" && cutT + 0.06 < durationSec - 0.3) {
        raw.push({ timeSec: Math.round((cutT + 0.06) * 1000) / 1000, kind: "shutter-snap" });
      }
      lastTransitionT = cutT;
    } else if (cutT - lastTransitionT >= 1.8) {
      const whooshStart = Math.max(0.25, cutT - 0.14);
      raw.push({ timeSec: Math.round(whooshStart * 1000) / 1000, kind: "scene-whoosh" });
      lastTransitionT = cutT;
    }

    if (s.kind === "cinematic" && s.cine?.proModel) {
      const popT = Math.min(durationSec - 0.25, cutT + 0.1);
      raw.push({ timeSec: Math.round(popT * 1000) / 1000, kind: "card-pop" });
      if (cutT + 0.48 < durationSec - 0.3) {
        raw.push({ timeSec: Math.round((cutT + 0.48) * 1000) / 1000, kind: "ui-click" });
      }
    } else if (s.kind === "cinematic" && s.cine?.vectorMode) {
      const clickT = Math.min(durationSec - 0.25, cutT + 0.16);
      raw.push({ timeSec: Math.round(clickT * 1000) / 1000, kind: "ui-click" });
    } else if (
      s.kind === "cinematic" &&
      (s.cine?.hero === "scales" || s.cine?.hero === "clock" || s.cine?.hero === "hourglass")
    ) {
      for (let ti = 0; ti < 2; ti++) {
        const tickT = cutT + 0.28 + ti * 0.52;
        if (tickT < durationSec - 0.3) {
          raw.push({ timeSec: Math.round(tickT * 1000) / 1000, kind: "clock-tick" });
        }
      }
    } else if (s.kind === "kinetic-text") {
      const clickT = Math.min(durationSec - 0.25, cutT + 0.12);
      raw.push({ timeSec: Math.round(clickT * 1000) / 1000, kind: "ui-click" });
    }

    if (s.kind === "quote") {
      const dropT = Math.min(durationSec - 0.3, cutT + 0.04);
      raw.push({ timeSec: Math.round(dropT * 1000) / 1000, kind: "sub-drop" });
    }

    if (MOTION_POP_KINDS.has(s.kind)) {
      const popT = Math.min(durationSec - 0.2, cutT + 0.09);
      raw.push({ timeSec: Math.round(popT * 1000) / 1000, kind: "card-pop" });
    }

    if (s.kind === "stat" || s.kind === "steps" || s.kind === "timeline") {
      const tickCount = s.kind === "stat" ? 3 : Math.min(3, s.steps?.length ?? 2);
      for (let ti = 0; ti < tickCount; ti++) {
        const tickT = cutT + 0.22 + ti * 0.18;
        if (tickT < durationSec - 0.25) {
          raw.push({ timeSec: Math.round(tickT * 1000) / 1000, kind: "counter-tick" });
        }
      }
    }
  }

  // 3. Subtle felt-tip highlighter swish on spaced book-page strokes (at least 3.2s apart so it stays tasteful).
  let lastMarkerT = -10;
  for (const st of strokes) {
    const t = audioOffsetSec + st.start;
    if (!Number.isFinite(t) || t < 0.8 || t >= durationSec - 0.5) continue;
    if (t - lastMarkerT >= 3.2) {
      raw.push({ timeSec: Math.round(t * 1000) / 1000, kind: "marker-swish" });
      lastMarkerT = t;
    }
  }

  // 4. Warm cinematic swell leading into the final scene.
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

/** Warm organic cloth/air cinema swish. */
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
    const cutoff = 180 + 600 * bell * bell;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
    const raw = noise();
    hpState = hpAlpha * (hpState + raw - prevIn);
    prevIn = raw;
    lp1 += a * (hpState - lp1);
    lp2 += a * (lp1 - lp2);

    const airSub = Math.sin(2 * Math.PI * (52 + 33 * bell) * t) * 0.18 * bell;
    const env = Math.pow(bell, 1.45);
    buf[idx] += (lp2 * 0.28 + airSub * 0.12) * env;
  }
}

/** Crisp archival book paper page-turn foley (band-passed paper fiber rustle + soft spine thump). */
function addPageTurn(buf: Float32Array, atSec: number, seedOffset: number): void {
  const lenSec = 0.28;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(613 + seedOffset * 29);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  const hpA = Math.exp((-2 * Math.PI * 650) / SAMPLE_RATE);

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const u = t / lenSec;
    const arch = Math.sin(Math.PI * Math.pow(u, 0.8));
    const lpCut = 1 - Math.exp((-2 * Math.PI * (1200 + 1900 * arch)) / SAMPLE_RATE);
    const n = noise();
    hp = hpA * (hp + n - prev);
    prev = n;
    lp += lpCut * (hp - lp);

    const spineSettle = Math.sin(2 * Math.PI * 118 * t) * Math.exp(-Math.pow((t - 0.19) / 0.035, 2)) * 0.09;
    buf[idx] += (lp * 0.16 * arch + spineSettle) * ramp(t, 0.008) * ramp(lenSec - t, 0.04);
  }
}

/** Soft felt-tip marker highlight brush across warm paper. */
function addMarkerSwish(buf: Float32Array, atSec: number, seedOffset: number): void {
  const lenSec = 0.19;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(733 + seedOffset * 19);
  let bp = 0;
  let hp = 0;
  let prev = 0;
  const hpA = Math.exp((-2 * Math.PI * 900) / SAMPLE_RATE);

  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const u = t / lenSec;
    const env = Math.sin(Math.PI * u);
    const lpA = 1 - Math.exp((-2 * Math.PI * (1500 + 800 * u)) / SAMPLE_RATE);
    const n = noise();
    hp = hpA * (hp + n - prev);
    prev = n;
    bp += lpA * (hp - bp);
    buf[idx] += bp * 0.085 * env;
  }
}

/** Crisp mechanical watch/counter tick for stat numbers and step reveals. */
function addCounterTick(buf: Float32Array, atSec: number): void {
  const lenSec = 0.032;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const click = Math.sin(2 * Math.PI * 980 * t) * Math.exp(-t / 0.0045) * 0.55;
    const body = Math.sin(2 * Math.PI * 290 * t) * Math.exp(-t / 0.009) * 0.45;
    buf[idx] += (click + body) * 0.11 * ramp(t, 0.001);
  }
}

/** Warm sub-drop accent for dramatic quote arrivals. */
function addSubDrop(buf: Float32Array, atSec: number): void {
  const lenSec = 0.52;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const phase = 2 * Math.PI * (29 * t + 26 * 0.08 * (1 - Math.exp(-t / 0.08)));
    const env = ramp(t, 0.006) * Math.exp(-t / 0.22);
    buf[idx] += Math.tanh(Math.sin(phase) * 1.2) * 0.19 * env;
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
    const hzA = 146.83 * Math.pow(2, (u * 3) / 12);
    const hzB = hzA * 1.5;
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

/** Crisp tactile Apple-style UI lock click for vector diagrams & kinetic emphasis. */
function addUiClick(buf: Float32Array, atSec: number): void {
  const lenSec = 0.028;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const snap = Math.sin(2 * Math.PI * 1420 * t) * Math.exp(-t / 0.0032) * 0.58;
    const thock = Math.sin(2 * Math.PI * 340 * t) * Math.exp(-t / 0.0075) * 0.42;
    buf[idx] += (snap + thock) * 0.12 * ramp(t, 0.0008);
  }
}

/** Mechanical archival camera shutter snap on tight book-crop evidence cuts. */
function addShutterSnap(buf: Float32Array, atSec: number, seedOffset: number): void {
  const lenSec = 0.068;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  const noise = seededNoise(823 + seedOffset * 17);
  const lpA = 1 - Math.exp((-2 * Math.PI * 2400) / SAMPLE_RATE);
  let lp = 0;
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    lp += lpA * (noise() - lp);
    const blade1 = lp * Math.exp(-t / 0.0055) * 0.65;
    const blade2 =
      t >= 0.024 ? lp * Math.exp(-(t - 0.024) / 0.0065) * 0.48 : 0;
    const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.014) * 0.35;
    buf[idx] += (blade1 + blade2 + body) * 0.14 * ramp(t, 0.001);
  }
}

/** Precision brass horological escapement tick for oscillating scales, clocks & hourglasses. */
function addClockTick(buf: Float32Array, atSec: number): void {
  const lenSec = 0.036;
  const start = Math.max(0, Math.round(atSec * SAMPLE_RATE));
  const count = Math.round(lenSec * SAMPLE_RATE);
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SAMPLE_RATE;
    const chime = Math.sin(2 * Math.PI * 1680 * t) * Math.exp(-t / 0.004) * 0.48;
    const brass = Math.sin(2 * Math.PI * 620 * t) * Math.exp(-t / 0.0085) * 0.52;
    buf[idx] += (chime + brass) * 0.11 * ramp(t, 0.0008);
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

/**
 * Earshot voice-aware sidechain ducking: attenuates SFX smoothly during active spoken
 * words (-4.2 dB -> 0.62x gain with 18ms attack / 120ms release) while letting foley
 * bloom at full 1.0x gain across breath pauses and visual transitions.
 */
export function applyVoiceAwareDucking(
  buf: Float32Array,
  speechSpans: SpeechSpan[],
  audioOffsetSec: number,
): boolean {
  if (!speechSpans || speechSpans.length === 0) return false;
  const gate = new Uint8Array(buf.length);
  for (const sp of speechSpans) {
    const sIdx = Math.max(0, Math.round((audioOffsetSec + sp.start) * SAMPLE_RATE));
    const eIdx = Math.min(buf.length, Math.round((audioOffsetSec + sp.end) * SAMPLE_RATE));
    for (let i = sIdx; i < eIdx; i++) gate[i] = 1;
  }
  const attackCoeff = 1 - Math.exp(-1 / (0.018 * SAMPLE_RATE));
  const releaseCoeff = 1 - Math.exp(-1 / (0.12 * SAMPLE_RATE));
  let gain = 1.0;
  for (let i = 0; i < buf.length; i++) {
    const target = gate[i] ? 0.62 : 1.0;
    const coeff = target < gain ? attackCoeff : releaseCoeff;
    gain += coeff * (target - gain);
    buf[i] *= gain;
  }
  return true;
}

/**
 * Earshot acoustic cut-sync & headroom verification over the rendered PCM buffer.
 */
export function verifyEarshotSync(
  buf: Float32Array,
  cues: SfxCue[],
  voiceDucked = false,
): EarshotSyncReport {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const peakDb = peak > 1e-9 ? Math.round(20 * Math.log10(peak) * 100) / 100 : -96;

  let syncedCues = 0;
  let maxDriftMs = 0;
  for (const cue of cues) {
    const anchor = Math.round(cue.timeSec * SAMPLE_RATE);
    // Riser swells peak near their end; impulsive foley cues onset within [0, +120ms].
    const winStart = Math.max(0, anchor - Math.round(0.01 * SAMPLE_RATE));
    const winEnd = Math.min(
      buf.length,
      anchor + Math.round((cue.kind === "payoff-riser" ? 1.05 : 0.22) * SAMPLE_RATE),
    );
    let localPeak = 0;
    let firstOnset = -1;
    for (let i = winStart; i < winEnd; i++) {
      const a = Math.abs(buf[i]);
      if (a > localPeak) localPeak = a;
      if (firstOnset < 0 && a > 0.004) firstOnset = i;
    }
    if (localPeak > 0.004) {
      syncedCues += 1;
      const driftMs = Math.abs(((firstOnset >= 0 ? firstOnset : anchor) - anchor) * 1000) / SAMPLE_RATE;
      if (cue.kind !== "payoff-riser" && driftMs > maxDriftMs) {
        maxDriftMs = Math.round(driftMs * 10) / 10;
      }
    }
  }

  return {
    ok: peak <= 0.5 && (cues.length === 0 || syncedCues === cues.length),
    cuesTotal: cues.length,
    syncedCues,
    maxDriftMs,
    peakDb,
    voiceDucked,
  };
}

export function renderSfxBuffer(
  durationSec: number,
  cues: SfxCue[],
  opts?: { speechSpans?: SpeechSpan[]; audioOffsetSec?: number },
): Float32Array {
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
      case "page-turn":
        addPageTurn(dry, cue.timeSec, idx);
        break;
      case "marker-swish":
        addMarkerSwish(dry, cue.timeSec, idx);
        break;
      case "counter-tick":
        addCounterTick(dry, cue.timeSec);
        break;
      case "sub-drop":
        addSubDrop(dry, cue.timeSec);
        break;
      case "card-pop":
        addCardPop(dry, cue.timeSec);
        break;
      case "payoff-riser":
        addPayoffRiser(dry, cue.timeSec);
        break;
      case "ui-click":
        addUiClick(dry, cue.timeSec);
        break;
      case "shutter-snap":
        addShutterSnap(dry, cue.timeSec, idx);
        break;
      case "clock-tick":
        addClockTick(dry, cue.timeSec);
        break;
    }
  });

  const buf = applyRoomGlue(dry);
  if (opts?.speechSpans && opts.speechSpans.length > 0) {
    applyVoiceAwareDucking(buf, opts.speechSpans, opts.audioOffsetSec ?? 0);
  }
  const ceiling = 0.41;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    if (Math.abs(x) > ceiling) {
      buf[i] = Math.tanh(x / ceiling) * ceiling;
    }
  }
  return buf;
}

export async function generateSfxTrack(
  opts: GenerateSfxOptions,
): Promise<{ cues: SfxCue[]; syncReport: EarshotSyncReport }> {
  const cues = planSfxCues(opts);
  const buf = renderSfxBuffer(opts.durationSec, cues, {
    speechSpans: opts.speechSpans,
    audioOffsetSec: opts.audioOffsetSec,
  });
  const voiceDucked = Boolean(opts.speechSpans && opts.speechSpans.length > 0);
  const syncReport = verifyEarshotSync(buf, cues, voiceDucked);
  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.writeFile(opts.outPath, toWav(buf, SAMPLE_RATE));
  return { cues, syncReport };
}
