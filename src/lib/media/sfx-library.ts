/**
 * Real Studio SFX Library Loader, Model-Aware Selector & Selective Mixer (`sfx/`).
 *
 * Loads authentic audio assets from `<workspace>/sfx/` (`.wav`, `.mp3`, `.ogg`, `.m4a`, `.flac`),
 * trims leading/trailing silence with smooth anti-click fades, measures each sample's exact
 * transient/swell anchor (`anchorOffsetSec`) for frame-accurate visual alignment, and places
 * SFX SPARSELY & NATURALLY only on genuine animation/visual-effect moments — rotating files
 * across episodes (`seedKey`) and matching each cue to the active visual model (`sceneModel` / `reelModel`)
 * so videos never repeat the same monotonous effect or spam SFX wall-to-wall.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FFMPEG } from "./ffmpeg";
import { SAMPLE_RATE } from "./music-synth";
import { applyVoiceAwareDucking, type SfxCue, type SfxKind, type SpeechSpan } from "./sfx-synth";
import type { Scene } from "../video/scenes/types";

const execFileAsync = promisify(execFile);

export type SfxRole =
  | "bento-ui"
  | "dossier-stamp"
  | "archival-shutter"
  | "neuro-circuit"
  | "chrono-gear"
  | "paper-slide"
  | "vector-pop"
  | "whip-accent"
  | "cinema-deep";

export interface LoadedSfxSample {
  fileName: string;
  roles: SfxRole[];
  /** Trimmed, peak-normalized (peak = 1.0) 44.1 kHz mono PCM samples with micro-fades. */
  pcm: Float32Array;
  /** Seconds from `pcm[0]` to the acoustic impact/peak (aligned to the visual animation timestamp). */
  anchorOffsetSec: number;
  durationSec: number;
  /** Natural mix gain before voice-aware sidechain ducking (keeps foley subtle & clean under speech). */
  baseGain: number;
}

export interface SelectiveLibrarySfxPlanItem {
  /** Exact composition timeline timestamp (including `audioOffsetSec`) where the visual effect peaks. */
  timeSec: number;
  kind: SfxKind;
  role: SfxRole;
  modelId: string;
  fileName: string;
  gainScale: number;
  sceneIndex: number;
}

/**
 * Verified acoustic profiles of the studio files in `<workspace>/sfx/` so generic filenames
 * like `SFX_01_01.wav`..`SFX_01_09.wav` map to their true sound character:
 *  - SFX_01_01.wav : crisp paper/card slide & snap
 *  - SFX_01_02.wav : mechanical typewriter / case-file stamp
 *  - SFX_01_03.wav : smooth spatial swoosh into soft VisionOS chime
 *  - SFX_01_04.wav : electric / sci-fi lab circuit whoosh-impact
 *  - SFX_01_05.wav : short subtle glass/wood UI pop-ding
 *  - SFX_01_06.wav : archival camera shutter + film advance
 *  - SFX_01_07.wav : metallic latch / camera click
 *  - SFX_01_08.wav : precision chronometer bell + ratcheting gear ticks
 *  - SFX_01_09.wav : clean digital UI bubble / node pop
 */
const KNOWN_FILE_PROFILES: Readonly<
  Record<string, { roles: SfxRole[]; baseGain: number; maxAnchorSec: number }>
> = {
  "14 Quick Swing.wav": { roles: ["cinema-deep", "vector-pop"], baseGain: 0.22, maxAnchorSec: 0.36 },
  "15 Quick A.wav": { roles: ["whip-accent", "bento-ui"], baseGain: 0.2, maxAnchorSec: 0.45 },
  "NGTVST - Whoosh 3.wav": { roles: ["neuro-circuit", "cinema-deep"], baseGain: 0.2, maxAnchorSec: 0.78 },
  "SFX- Swoosh02.mp3": { roles: ["vector-pop", "bento-ui", "whip-accent"], baseGain: 0.22, maxAnchorSec: 0.22 },
  "SFX- Swoosh03.mp3": { roles: ["cinema-deep", "whip-accent"], baseGain: 0.22, maxAnchorSec: 0.65 },
  "SFX- Swoosh11.mp3": { roles: ["bento-ui", "dossier-stamp", "cinema-deep"], baseGain: 0.19, maxAnchorSec: 0.44 },
  "SFX_01_01.wav": { roles: ["paper-slide", "archival-shutter"], baseGain: 0.25, maxAnchorSec: 0.28 },
  "SFX_01_02.wav": { roles: ["dossier-stamp", "paper-slide"], baseGain: 0.21, maxAnchorSec: 0.22 },
  "SFX_01_03.wav": { roles: ["bento-ui", "vector-pop"], baseGain: 0.21, maxAnchorSec: 0.4 },
  "SFX_01_04.wav": { roles: ["neuro-circuit", "cinema-deep"], baseGain: 0.21, maxAnchorSec: 0.38 },
  "SFX_01_05.wav": { roles: ["bento-ui", "vector-pop", "paper-slide"], baseGain: 0.22, maxAnchorSec: 0.06 },
  "SFX_01_06.wav": { roles: ["archival-shutter", "dossier-stamp"], baseGain: 0.22, maxAnchorSec: 0.22 },
  "SFX_01_07.wav": { roles: ["archival-shutter", "dossier-stamp"], baseGain: 0.2, maxAnchorSec: 0.16 },
  "SFX_01_08.wav": { roles: ["chrono-gear", "neuro-circuit"], baseGain: 0.19, maxAnchorSec: 0.42 },
  "SFX_01_09.wav": { roles: ["vector-pop", "bento-ui", "neuro-circuit"], baseGain: 0.22, maxAnchorSec: 0.1 },
  "fast-whoosh-118248.mp3": { roles: ["whip-accent", "neuro-circuit"], baseGain: 0.21, maxAnchorSec: 0.28 },
  "whoosh-cinematic-161021.mp3": { roles: ["cinema-deep", "chrono-gear"], baseGain: 0.21, maxAnchorSec: 0.32 },
  "whoosh-clothes-cape-243486.mp3": { roles: ["paper-slide", "whip-accent"], baseGain: 0.22, maxAnchorSec: 0.2 },
};

/** Model-specific preferred roles so each of the 10 Pro Motion models has its own signature sound design. */
const MODEL_PRIMARY_ROLES: Readonly<Record<string, SfxRole[]>> = {
  "kinetic-emerald": ["chrono-gear", "bento-ui", "vector-pop"],
  "kinetic-cobalt": ["paper-slide", "dossier-stamp", "bento-ui"],
  "kinetic-coral": ["chrono-gear", "archival-shutter", "whip-accent"],
  "kinetic-violet": ["neuro-circuit", "bento-ui", "vector-pop"],
  "paper-collage": ["paper-slide", "dossier-stamp", "archival-shutter"],
  "daylight-orbital": ["bento-ui", "chrono-gear", "paper-slide"],
  "aurora-portal": ["neuro-circuit", "cinema-deep", "bento-ui"],
  "dynamic-island": ["bento-ui", "vector-pop", "neuro-circuit"],
  "crimson-cutout": ["cinema-deep", "whip-accent", "archival-shutter"],
  "violet-roi": ["neuro-circuit", "vector-pop", "bento-ui"],
  "glassmorphism-ui": ["bento-ui", "vector-pop", "chrono-gear"],
  "glass-sapphire": ["bento-ui", "chrono-gear", "neuro-circuit"],
  "glass-emerald": ["bento-ui", "vector-pop", "paper-slide"],
  "glass-amethyst": ["dossier-stamp", "neuro-circuit", "cinema-deep"],
  "vision-bento": ["bento-ui", "vector-pop", "whip-accent"],
  "investigative-dossier": ["dossier-stamp", "archival-shutter", "paper-slide"],
  "neuro-lab": ["neuro-circuit", "chrono-gear", "whip-accent"],
  "trifecta-viral": ["archival-shutter", "whip-accent", "cinema-deep"],
  "dankoe-vector": ["vector-pop", "bento-ui", "cinema-deep"],
  "vox-explainer": ["paper-slide", "dossier-stamp", "bento-ui"],
  "magnates-cinema": ["cinema-deep", "chrono-gear", "whip-accent"],
};

let cachedDirKey: string | null = null;
let cachedLibrary: LoadedSfxSample[] | null = null;

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function inferProfileFromFilename(fileName: string, activeSec: number): {
  roles: SfxRole[];
  baseGain: number;
  maxAnchorSec: number;
} {
  const known = KNOWN_FILE_PROFILES[fileName];
  if (known) return known;
  const lower = fileName.toLowerCase();
  if (/clock|tick|timer|gear|bell/.test(lower)) {
    return { roles: ["chrono-gear", "neuro-circuit"], baseGain: 0.2, maxAnchorSec: 0.3 };
  }
  if (/shutter|camera|snap|flash/.test(lower)) {
    return { roles: ["archival-shutter", "dossier-stamp"], baseGain: 0.21, maxAnchorSec: 0.2 };
  }
  if (/paper|page|book|cloth|cape|rustle/.test(lower)) {
    return { roles: ["paper-slide", "dossier-stamp"], baseGain: 0.22, maxAnchorSec: 0.22 };
  }
  if (/stamp|type|clack|dossier/.test(lower)) {
    return { roles: ["dossier-stamp", "paper-slide"], baseGain: 0.21, maxAnchorSec: 0.2 };
  }
  if (/click|pop|ding|ui|chime|bubble/.test(lower)) {
    return { roles: ["bento-ui", "vector-pop"], baseGain: 0.21, maxAnchorSec: 0.14 };
  }
  if (/glitch|electric|synth|sci|circuit|laser/.test(lower)) {
    return { roles: ["neuro-circuit", "bento-ui"], baseGain: 0.2, maxAnchorSec: 0.34 };
  }
  if (/cinematic|deep|sub|boom|swing/.test(lower)) {
    return { roles: ["cinema-deep", "whip-accent"], baseGain: 0.21, maxAnchorSec: 0.45 };
  }
  if (activeSec <= 0.45) {
    return { roles: ["vector-pop", "bento-ui", "whip-accent"], baseGain: 0.21, maxAnchorSec: 0.2 };
  }
  return { roles: ["whip-accent", "cinema-deep", "bento-ui"], baseGain: 0.2, maxAnchorSec: 0.38 };
}

async function decodeAndTrimSample(fullPath: string, fileName: string): Promise<LoadedSfxSample | null> {
  try {
    const { stdout } = await execFileAsync(
      FFMPEG,
      ["-hide_banner", "-loglevel", "error", "-i", fullPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
      { encoding: "buffer", maxBuffer: 48 * 1024 * 1024, windowsHide: true },
    );
    const rawPcm = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
    if (rawPcm.length < 400) return null;

    let rawPeak = 0;
    for (let i = 0; i < rawPcm.length; i++) {
      const a = Math.abs(rawPcm[i]);
      if (a > rawPeak) rawPeak = a;
    }
    if (rawPeak < 1e-4) return null;

    const threshold = Math.max(0.0035, rawPeak * 0.028);
    let firstIdx = 0;
    while (firstIdx < rawPcm.length && Math.abs(rawPcm[firstIdx]) < threshold) firstIdx++;
    let lastIdx = rawPcm.length - 1;
    while (lastIdx > firstIdx && Math.abs(rawPcm[lastIdx]) < threshold) lastIdx--;

    const preRoll = Math.round(0.024 * SAMPLE_RATE);
    const postRoll = Math.round(0.085 * SAMPLE_RATE);
    const startIdx = Math.max(0, firstIdx - preRoll);
    // Cap overly long tails at 2.15s so one SFX never drags across subsequent narration sentences.
    const maxLenSamples = Math.round(2.15 * SAMPLE_RATE);
    const endIdx = Math.min(rawPcm.length, Math.min(startIdx + maxLenSamples, lastIdx + postRoll));
    const len = endIdx - startIdx;
    if (len < 400) return null;

    const trimmed = new Float32Array(len);
    let localPeak = 0;
    let localPeakIdx = 0;
    for (let i = 0; i < len; i++) {
      const v = rawPcm[startIdx + i];
      trimmed[i] = v;
      const a = Math.abs(v);
      if (a > localPeak) {
        localPeak = a;
        localPeakIdx = i;
      }
    }
    const invPeak = localPeak > 0 ? 1 / localPeak : 1;
    const fadeInLen = Math.min(Math.round(0.008 * SAMPLE_RATE), Math.floor(len / 4));
    const fadeOutLen = Math.min(Math.round(0.045 * SAMPLE_RATE), Math.floor(len / 3));
    for (let i = 0; i < len; i++) {
      let g = invPeak;
      if (i < fadeInLen) g *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeInLen));
      if (i >= len - fadeOutLen) {
        const rem = len - 1 - i;
        g *= 0.5 * (1 - Math.cos((Math.PI * rem) / fadeOutLen));
      }
      trimmed[i] *= g;
    }

    const activeSec = len / SAMPLE_RATE;
    const profile = inferProfileFromFilename(fileName, activeSec);
    const anchorOffsetSec = Math.min(profile.maxAnchorSec, Math.max(0, localPeakIdx / SAMPLE_RATE));

    return {
      fileName,
      roles: profile.roles,
      pcm: trimmed,
      anchorOffsetSec: Math.round(anchorOffsetSec * 1000) / 1000,
      durationSec: Math.round(activeSec * 1000) / 1000,
      baseGain: profile.baseGain,
    };
  } catch {
    return null;
  }
}

export function resolveProjectSfxDir(customDir?: string): string {
  return customDir ? path.resolve(customDir) : path.join(process.cwd(), "sfx");
}

/**
 * Load and cache all real SFX files in `<workspace>/sfx/`.
 * Automatically picks up newly added audio files if directory filenames change.
 */
export async function loadProjectSfxLibrary(customDir?: string): Promise<LoadedSfxSample[]> {
  const dir = resolveProjectSfxDir(customDir);
  if (!fs.existsSync(dir)) return [];

  const entries = (await fsp.readdir(dir))
    .filter((f) => /\.(wav|mp3|ogg|m4a|flac)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
  if (entries.length === 0) return [];

  const dirKey = `${dir}::${entries.join("|")}`;
  if (cachedDirKey === dirKey && cachedLibrary && cachedLibrary.length > 0) {
    return cachedLibrary;
  }

  const loaded: LoadedSfxSample[] = [];
  for (const name of entries) {
    const item = await decodeAndTrimSample(path.join(dir, name), name);
    if (item) loaded.push(item);
  }
  cachedDirKey = dirKey;
  cachedLibrary = loaded;
  return loaded;
}

interface CandidateMoment {
  sceneIndex: number;
  timeSec: number;
  priority: number;
  role: SfxRole;
  kind: SfxKind;
  modelId: string;
  gainScale: number;
}

function effectiveModelForScene(scene: Scene, fallbackModel?: string): string {
  if (scene.sceneModel) return scene.sceneModel;
  if (fallbackModel && fallbackModel !== "omni-7-ultra" && fallbackModel !== "auto") return fallbackModel;
  if (scene.cine?.proModel === "lab-apparatus" || scene.cine?.proModel === "hand-swerve-arc") return "neuro-lab";
  if (scene.cine?.proModel === "crowd-asymmetry" || scene.cine?.proModel === "barcelona-timeline") {
    return "investigative-dossier";
  }
  if (scene.cine?.proModel) return "vision-bento";
  if (scene.cine?.vectorMode) return "dankoe-vector";
  if (scene.kind === "steps" || scene.kind === "timeline") return "vox-explainer";
  if (scene.kind === "quote") return "investigative-dossier";
  if (scene.kind === "book-crop" || scene.kind === "comparison") return "trifecta-viral";
  return "magnates-cinema";
}

function classifySceneMoment(
  scene: Scene,
  sceneIndex: number,
  totalScenes: number,
  audioOffsetSec: number,
  durationSec: number,
  fallbackModel?: string,
): CandidateMoment | null {
  const cutT = sceneIndex === 0 ? 0 : audioOffsetSec + scene.start;
  if (!Number.isFinite(cutT) || cutT >= durationSec - 0.45) return null;

  const modelId = effectiveModelForScene(scene, fallbackModel);
  const isFinale = sceneIndex === totalScenes - 1 && totalScenes >= 3;

  // Scene 0: leave calm atmospheric / plate hooks completely clean of SFX;
  // only accent Scene 0 if an interactive Pro-Model or Vector diagram immediately animates in.
  if (sceneIndex === 0) {
    if (scene.cine?.proModel) {
      const primary = MODEL_PRIMARY_ROLES[modelId]?.[0] ?? "bento-ui";
      return {
        sceneIndex,
        timeSec: Math.min(durationSec - 0.5, 0.28),
        priority: 2,
        role: primary,
        kind: "card-pop",
        modelId,
        gainScale: 0.82,
      };
    }
    return null;
  }

  // Priority 3: High-impact bespoke animations & archival zooms ("எஃபெக்ட் அல்லது அனிமேஷன் காட்டும்போது")
  if (scene.kind === "cinematic" && scene.cine?.proModel) {
    const pm = scene.cine.proModel;
    const role: SfxRole =
      pm === "glass-radial-gauge" || pm === "glass-hourglass-flow"
        ? "chrono-gear"
        : pm === "glass-vault-unlock"
          ? "archival-shutter"
          : pm === "glass-domino-chain" || pm === "barcelona-timeline" || pm === "crowd-asymmetry"
            ? "dossier-stamp"
            : pm === "glass-neural-synapse" || pm === "glass-radar-sonar" || pm === "glass-prism-spectrum" || pm === "lab-apparatus" || pm === "hand-swerve-arc"
              ? "neuro-circuit"
              : pm === "glass-balance-scale" || pm === "glass-iceberg-depth" || pm === "glass-orbit-gravity"
                ? "cinema-deep"
                : pm === "glass-step-staircase" || pm === "glass-funnel-filter"
                  ? "whip-accent"
                  : "bento-ui";
    return {
      sceneIndex,
      timeSec: +(cutT + 0.16).toFixed(3),
      priority: 3,
      role,
      kind: "card-pop",
      modelId,
      gainScale: 0.95,
    };
  }

  if (scene.kind === "cinematic" && scene.cine?.vectorMode) {
    return {
      sceneIndex,
      timeSec: +(cutT + 0.14).toFixed(3),
      priority: 3,
      role: "vector-pop",
      kind: "ui-click",
      modelId,
      gainScale: 0.9,
    };
  }

  if (scene.kind === "book-crop") {
    return {
      sceneIndex,
      timeSec: +(cutT + 0.08).toFixed(3),
      priority: 3,
      role: modelId === "vox-explainer" ? "paper-slide" : "archival-shutter",
      kind: "shutter-snap",
      modelId,
      gainScale: 0.92,
    };
  }

  if (
    scene.kind === "cinematic" &&
    !scene.cine?.plate &&
    (scene.cine?.hero === "clock" || scene.cine?.hero === "hourglass" || scene.cine?.hero === "scales")
  ) {
    return {
      sceneIndex,
      timeSec: +(cutT + 0.12).toFixed(3),
      priority: 3,
      role: "chrono-gear",
      kind: "clock-tick",
      modelId,
      gainScale: 0.9,
    };
  }

  if (isFinale && scene.kind === "cinematic") {
    return {
      sceneIndex,
      timeSec: +(cutT + 0.06).toFixed(3),
      priority: 3,
      role: "cinema-deep",
      kind: "scene-whoosh",
      modelId,
      gainScale: 0.88,
    };
  }

  // Priority 2: Structured visual cards (quote stamp, paper steps, comparison, stat, growth chart)
  if (scene.kind === "quote") {
    return {
      sceneIndex,
      timeSec: +(cutT + 0.1).toFixed(3),
      priority: 2,
      role: modelId === "vox-explainer" ? "paper-slide" : "dossier-stamp",
      kind: "card-pop",
      modelId,
      gainScale: 0.88,
    };
  }

  if (scene.kind === "steps" || scene.kind === "timeline") {
    return {
      sceneIndex,
      timeSec: +(cutT + 0.1).toFixed(3),
      priority: 2,
      role: modelId === "vox-explainer" ? "paper-slide" : (MODEL_PRIMARY_ROLES[modelId]?.[0] ?? "bento-ui"),
      kind: "card-pop",
      modelId,
      gainScale: 0.88,
    };
  }

  if (scene.kind === "comparison" || scene.kind === "stat" || scene.kind === "growth-curve" || scene.kind === "icon-concept") {
    const role: SfxRole =
      scene.kind === "comparison"
        ? "whip-accent"
        : (MODEL_PRIMARY_ROLES[modelId]?.[0] ?? "bento-ui");
    return {
      sceneIndex,
      timeSec: +(cutT + 0.09).toFixed(3),
      priority: 2,
      role,
      kind: "card-pop",
      modelId,
      gainScale: 0.86,
    };
  }

  // Plain `book-page`, `kinetic-text`, or static atmospheric plates stay 100% clean (voice + music only).
  return null;
}

/**
 * Select sparse, natural, model-matched real SFX cues from `library`:
 *  - Enforces a minimum `5.2s` breathing gap between cues so SFX never clutter the narration.
 *  - Caps total cues to ~1 per 8 seconds (`3..7` cues for a typical 30–60s Reel).
 *  - Uses `seedKey` (episodeId / title) to rotate file picks per video and forbids repeating
 *    the same audio file back-to-back (prefers distinct files across the entire video).
 */
export function planSelectiveLibrarySfx(opts: {
  durationSec: number;
  audioOffsetSec: number;
  scenes: Scene[];
  library: LoadedSfxSample[];
  reelModel?: string;
  seedKey?: string;
}): SelectiveLibrarySfxPlanItem[] {
  const { durationSec, audioOffsetSec, scenes, library, reelModel, seedKey = "default-episode" } = opts;
  if (!(durationSec > 1.2) || scenes.length === 0 || library.length === 0) return [];

  const candidates: CandidateMoment[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const c = classifySceneMoment(scenes[i], i, scenes.length, audioOffsetSec, durationSec, reelModel);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) return [];

  const MIN_GAP_SEC = 5.2;
  const maxCues = Math.max(2, Math.min(7, Math.floor(durationSec / 7.8)));

  // Greedy selection by priority first (animation rigs / book-crop / finale first, then cards),
  // subject to the >= 5.2s natural breathing-room constraint.
  const byPriority = [...candidates].sort((a, b) => b.priority - a.priority || a.timeSec - b.timeSec);
  const chosenMoments: CandidateMoment[] = [];
  for (const cand of byPriority) {
    if (chosenMoments.length >= maxCues) break;
    const tooClose = chosenMoments.some((m) => Math.abs(m.timeSec - cand.timeSec) < MIN_GAP_SEC);
    if (!tooClose) {
      chosenMoments.push(cand);
    }
  }
  chosenMoments.sort((a, b) => a.timeSec - b.timeSec);

  const epHash = hashString(`${seedKey}::${reelModel ?? "auto"}`);
  const usedFiles = new Set<string>();
  let lastFile = "";

  return chosenMoments.map((moment, idx) => {
    const modelRoles = MODEL_PRIMARY_ROLES[moment.modelId] ?? ["bento-ui", "whip-accent"];
    // Pool 1: matches exact scene role AND model palette (or exact scene role)
    const exactRolePool = library.filter((s) => s.roles.includes(moment.role));
    // Pool 2: matches any preferred role of this visual model
    const modelPool = library.filter((s) => s.roles.some((r) => modelRoles.includes(r)));
    const basePool = exactRolePool.length > 0 ? exactRolePool : modelPool.length > 0 ? modelPool : library;

    // Prefer files not yet heard in this video; otherwise at least forbid back-to-back repeat.
    const unusedInPool = basePool.filter((s) => !usedFiles.has(s.fileName) && s.fileName !== lastFile);
    const nonRepeatPool = basePool.filter((s) => s.fileName !== lastFile);
    const finalPool =
      unusedInPool.length > 0 ? unusedInPool : nonRepeatPool.length > 0 ? nonRepeatPool : basePool;

    const pickOffset = (epHash + Math.imul(idx + 1, 2654435761) + hashString(moment.modelId)) >>> 0;
    const picked = finalPool[pickOffset % finalPool.length];
    usedFiles.add(picked.fileName);
    lastFile = picked.fileName;

    return {
      timeSec: moment.timeSec,
      kind: moment.kind,
      role: moment.role,
      modelId: moment.modelId,
      fileName: picked.fileName,
      gainScale: moment.gainScale,
      sceneIndex: moment.sceneIndex,
    };
  });
}

export function renderSelectiveLibrarySfxBuffer(opts: {
  durationSec: number;
  plan: SelectiveLibrarySfxPlanItem[];
  library: LoadedSfxSample[];
  speechSpans?: SpeechSpan[];
  audioOffsetSec?: number;
}): Float32Array {
  const totalSamples = Math.max(1, Math.round(opts.durationSec * SAMPLE_RATE));
  const out = new Float32Array(totalSamples);
  const byName = new Map(opts.library.map((s) => [s.fileName, s]));

  for (const item of opts.plan) {
    const sample = byName.get(item.fileName);
    if (!sample) continue;
    const startSec = item.timeSec - sample.anchorOffsetSec;
    const startSample = Math.round(startSec * SAMPLE_RATE);
    const gain = sample.baseGain * item.gainScale;
    const pcm = sample.pcm;

    for (let i = 0; i < pcm.length; i++) {
      const dst = startSample + i;
      if (dst < 0) continue;
      if (dst >= totalSamples) break;
      out[dst] += pcm[i] * gain;
    }
  }

  if (opts.speechSpans && opts.speechSpans.length > 0) {
    applyVoiceAwareDucking(out, opts.speechSpans, opts.audioOffsetSec ?? 0);
  }

  // Broadcast peak limiter (-8.4 dBFS ceiling = 0.38 linear) so SFX never clip or overpower speech.
  const ceiling = 0.38;
  for (let i = 0; i < out.length; i++) {
    const x = out[i];
    if (Math.abs(x) > ceiling) {
      out[i] = Math.tanh(x / ceiling) * ceiling;
    }
  }
  return out;
}

export function planItemsToSfxCues(plan: SelectiveLibrarySfxPlanItem[]): SfxCue[] {
  return plan.map((p) => ({
    timeSec: p.timeSec,
    kind: p.kind,
    fileName: p.fileName,
    modelId: p.modelId,
  }));
}
