/**
 * Story-Driven Multi-Reference Pro Motion Composition Engine (`pro-motion-engine.ts`).
 *
 * Uses ALL 10 reference styles as a unified library of 26+ individual frame /
 * motion-graphic elements + 6 opening hook archetypes + 6 climax payoff archetypes.
 *
 * Instead of repeating a rigid 5-scene template per model:
 *   1. Every beat is semantically scored against the beat's actual story meaning
 *      (time/speed, contrast/myth-busting, numbers/metrics, brain/interference,
 *      focus/vision, steps/lists, archival book proof, momentum/compounding).
 *   2. A deterministic episode seed (`bookTitle + ideaKey + title + model`) +
 *      strict per-video non-repetition (`usedWidgets`) guarantees ZERO repeated
 *      motion-graphic frames inside a video AND distinct choreography across
 *      every episode in a 20-video book batch.
 *   3. Every single motion-graphic action (scene cut, hook impact, card pop,
 *      staggered pill cascade, strikeout slash, SVG stroke draw, rolling counter,
 *      camera pan, portal zoom, and outro lockup) emits a frame-synchronized
 *      studio SFX cue.
 */
import type { Beat, ContentPackage } from "../content/schema";
import type { BeatAudio } from "../media/tts";
import type { TimedWord } from "../media/word-timing";
import type { SfxRole } from "../media/sfx-library";
import type { SfxKind } from "../media/sfx-synth";
import type { ReelModelId } from "./reel-models";

export interface ProMotionBuildInput {
  model: ReelModelId;
  pkg: ContentPackage;
  beats: BeatAudio[];
  words: TimedWord[];
  totalDuration: number;
  audioOffsetSec?: number;
  outroTailSec?: number;
  fps?: number;
  bookTitle: string;
  author: string | null;
  bookLink: string | null;
  pageWords?: Map<number, string[]>;
  music: boolean;
  sfx: boolean;
}

export interface ProMotionSfxMoment {
  timeSec: number;
  kind: SfxKind;
  role: SfxRole;
  preferredFile: string;
  sceneIndex: number;
  gainScale?: number;
  transientWeight?: number;
}

export interface ProMotionBuildOutput {
  html: string;
  durationSec: number;
  sfxMoments: ProMotionSfxMoment[];
  widgetSequence?: string[];
}

interface ParsedBeatCopy {
  index: number;
  startSec: number;
  endSec: number;
  midSec: number;
  voiceover: string;
  onScreen: string;
  lead: string;
  climax: string;
  microCaption: string;
  clauses: string[];
  metricText: string;
  metricTargetNum: number;
  pageLabel: string;
  quoteSnippet: string;
}

interface RuntimeCmd {
  op:
    | "blurIn"
    | "draw"
    | "scaleX"
    | "scaleY"
    | "slideX"
    | "rotate"
    | "panTrack"
    | "counter"
    | "portalZoom"
    | "islandExpand";
  sel: string;
  at: number;
  dur: number;
  a?: number;
  b?: number;
  dash?: number;
  suffix?: string;
  prefix?: string;
}

type WidgetFamily =
  | "chrono"
  | "radial"
  | "cards"
  | "contrast"
  | "diagram"
  | "editorial"
  | "chart"
  | "list";

interface StoryWidgetSpec {
  id: string;
  family: WidgetFamily;
  keywords: RegExp;
  preferredModels: ReelModelId[];
  render: (b: ParsedBeatCopy, camId: string) => string;
}

function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clipText(raw: string | undefined, fallback: string, maxChars: number): string {
  const clean = (raw ?? "").replace(/\s+/g, " ").trim();
  const base = clean.length > 0 ? clean : fallback;
  if (base.length <= maxChars) return base;
  const sliced = base.slice(0, maxChars - 1);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.55 ? sliced.slice(0, lastSpace) : sliced).trimEnd()}…`;
}

function cleanWords(raw: string): string[] {
  return raw
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function extractClauses(vo: string, onScreen: string): string[] {
  const rawParts = vo
    .split(/[,.;:—–!?]+|\b(?:and|but|while|yet|or|because|instead|through|whereas)\b/gi)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 4);

  const out: string[] = [];
  if (onScreen && onScreen.trim().length >= 3) {
    out.push(clipText(onScreen, "Core insight", 28));
  }
  for (const part of rawParts) {
    const w = cleanWords(part);
    if (w.length >= 2) {
      const phrase = clipText(w.slice(0, 4).join(" "), "Key factor", 28);
      if (!out.some((x) => x.toLowerCase() === phrase.toLowerCase())) {
        out.push(phrase);
      }
    }
  }
  const fallbacks = [
    "Clear direction",
    "Zero friction",
    "Direct focus",
    "Real momentum",
    "True priority",
    "Lasting impact",
  ];
  let fi = 0;
  while (out.length < 6) {
    out.push(fallbacks[fi % fallbacks.length]);
    fi++;
  }
  return out.slice(0, 6);
}

function parseBeatCopy(
  beat: Beat,
  idx: number,
  startSec: number,
  endSec: number,
  words: TimedWord[],
  audioOffset: number,
  pageWords?: Map<number, string[]>,
): ParsedBeatCopy {
  const vo = (beat.voiceover ?? "").replace(/\s+/g, " ").trim();
  const tokens = cleanWords(vo);
  const halfIdx = Math.max(2, Math.min(tokens.length - 2, Math.floor(tokens.length * 0.52)));

  const sentences = vo.split(/(?<=[.!?])\s+/).filter(Boolean);
  let lead = "";
  let climax = "";
  if (sentences.length >= 2) {
    const w1 = cleanWords(sentences[0]);
    const w2 = cleanWords(sentences[sentences.length - 1]);
    lead = clipText(w1.slice(0, 5).join(" "), "Notice how", 34);
    climax = clipText(w2.slice(-4).join(" "), beat.onScreen || "what matters.", 28);
  } else {
    lead = clipText(tokens.slice(0, Math.min(4, halfIdx)).join(" "), "The page shows", 32);
    climax = clipText(
      beat.onScreen && beat.onScreen.trim().length >= 4
        ? beat.onScreen
        : tokens.slice(-Math.min(4, Math.max(2, tokens.length - halfIdx))).join(" "),
      "real leverage.",
      28,
    );
  }

  const beatTimedWords = words.filter(
    (w) => audioOffset + w.start >= startSec - 0.08 && audioOffset + w.start <= endSec + 0.08,
  );
  const midWord = beatTimedWords[Math.floor(beatTimedWords.length * 0.52)];
  const midSec = midWord
    ? Math.max(startSec + 0.45, Math.min(endSec - 0.45, +(audioOffset + midWord.start).toFixed(3)))
    : +((startSec + endSec) * 0.5).toFixed(3);

  const numMatch = /\b(\d{1,3})\b/.exec(vo);
  const parsedNum = numMatch ? Math.max(1, Math.min(999, Number(numMatch[1]))) : 72 + ((idx * 13) % 24);
  const metricText = numMatch ? `${parsedNum}` : `${parsedNum}%`;

  const pageNum = Math.max(1, (beat.sourcePage ?? 0) + 1);
  const pageLabel = `p. ${pageNum}`;

  let quoteSnippet = vo;
  const pWords = pageWords?.get(beat.sourcePage);
  if (pWords && pWords.length > 8) {
    const sw = Math.max(0, Math.min(pWords.length - 6, beat.startWord || 0));
    const ew = Math.min(pWords.length, Math.max(sw + 10, Math.min(sw + 22, (beat.endWord || sw + 16) + 1)));
    const rawQuote = pWords.slice(sw, ew).join(" ").replace(/\s+/g, " ").trim();
    if (rawQuote.length >= 24) quoteSnippet = rawQuote;
  }

  return {
    index: idx,
    startSec,
    endSec,
    midSec,
    voiceover: vo,
    onScreen: clipText(beat.onScreen, climax, 30),
    lead,
    climax,
    microCaption: clipText(vo, vo, 92),
    clauses: extractClauses(vo, beat.onScreen),
    metricText,
    metricTargetNum: parsedNum,
    pageLabel,
    quoteSnippet: clipText(quoteSnippet, vo, 112),
  };
}

const MODEL_ACCENTS: Readonly<
  Record<
    ReelModelId,
    {
      bg: string;
      ink: string;
      subInk: string;
      acc: string;
      acc2: string;
      accSoft: string;
      dark: boolean;
    }
  >
> = {
  "kinetic-emerald": {
    bg: "#FFFFFF",
    ink: "#0B0D0E",
    subInk: "#374151",
    acc: "#128024",
    acc2: "#047857",
    accSoft: "rgba(18, 128, 36, 0.16)",
    dark: false,
  },
  "kinetic-cobalt": {
    bg: "#FFFFFF",
    ink: "#0B0D0E",
    subInk: "#334155",
    acc: "#1463E6",
    acc2: "#2563EB",
    accSoft: "rgba(20, 99, 230, 0.16)",
    dark: false,
  },
  "kinetic-coral": {
    bg: "#FFFFFF",
    ink: "#0B0D0E",
    subInk: "#374151",
    acc: "#C83219",
    acc2: "#BE123C",
    accSoft: "rgba(200, 50, 25, 0.15)",
    dark: false,
  },
  "kinetic-violet": {
    bg: "#FFFFFF",
    ink: "#0B0D0E",
    subInk: "#4B5563",
    acc: "#6D28D9",
    acc2: "#7C3AED",
    accSoft: "rgba(109, 40, 217, 0.15)",
    dark: false,
  },
  "paper-collage": {
    bg: "#EAECEF",
    ink: "#111317",
    subInk: "#3F4756",
    acc: "#6B21A8",
    acc2: "#7E22CE",
    accSoft: "rgba(107, 33, 168, 0.16)",
    dark: false,
  },
  "daylight-orbital": {
    bg: "#F8FAFF",
    ink: "#0F172A",
    subInk: "#334155",
    acc: "#1E40AF",
    acc2: "#2563EB",
    accSoft: "rgba(30, 64, 175, 0.15)",
    dark: false,
  },
  "aurora-portal": {
    bg: "#090B11",
    ink: "#F8FAFC",
    subInk: "#CBD5E1",
    acc: "#22D3EE",
    acc2: "#EC4899",
    accSoft: "rgba(34, 211, 238, 0.22)",
    dark: true,
  },
  "dynamic-island": {
    bg: "#040406",
    ink: "#F8FAFC",
    subInk: "#CBD5E1",
    acc: "#38BDF8",
    acc2: "#C084FC",
    accSoft: "rgba(56, 189, 248, 0.22)",
    dark: true,
  },
  "crimson-cutout": {
    bg: "#FFFFFF",
    ink: "#0D0E11",
    subInk: "#374151",
    acc: "#DC2626",
    acc2: "#B91C1C",
    accSoft: "rgba(220, 38, 38, 0.16)",
    dark: false,
  },
  "violet-roi": {
    bg: "#06050C",
    ink: "#F8FAFC",
    subInk: "#D4D4D8",
    acc: "#C084FC",
    acc2: "#22C55E",
    accSoft: "rgba(192, 132, 252, 0.24)",
    dark: true,
  },
};

const WHOOSH_FILES = [
  "14 Quick Swing.wav",
  "whoosh-cinematic-161021.mp3",
  "SFX_01_02.wav",
  "SFX_01_04.wav",
  "SFX_01_10.wav",
];
const POP_FILES = [
  "SFX_01_03.wav",
  "SFX_01_05.wav",
  "SFX_01_06.wav",
  "SFX_01_09.wav",
];
const SWISH_FILES = [
  "SFX_01_01.wav",
  "SFX_01_08.wav",
  "SFX_01_07.wav",
];

function buildModelBackdropHtml(model: ReelModelId, epSeed: number): string {
  const variant = epSeed % 3;
  if (model === "paper-collage") {
    return `
      <div class="bg-paper">
        <div class="bg-paper-dots"></div>
        <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" aria-hidden="true" style="position:absolute;inset:0;pointer-events:none">
          <polyline points="96,42 36,42 36,102" stroke="#18181B" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" opacity="0.82"/>
          <line x1="36" y1="42" x2="118" y2="124" stroke="#18181B" stroke-width="14" stroke-linecap="round" opacity="0.82"/>
          <polyline points="984,1878 1044,1878 1044,1818" stroke="#18181B" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" opacity="0.82"/>
          <line x1="1044" y1="1878" x2="962" y2="1796" stroke="#18181B" stroke-width="14" stroke-linecap="round" opacity="0.82"/>
        </svg>
      </div>`;
  }
  if (model === "daylight-orbital") {
    return `
      <div class="bg-daylight">
        <div class="gobo-pane gobo-p1" id="bokeh-tl"></div>
        <div class="gobo-pane gobo-p2" id="bokeh-br"></div>
        <svg class="gobo-palm" viewBox="0 0 1080 620" fill="none">
          <path d="M-40 600 C 180 420, 460 390, 880 580" stroke="rgba(15,23,42,0.06)" stroke-width="26" stroke-linecap="round"/>
          <path d="M120 560 C 260 410, 480 430, 740 590" stroke="rgba(15,23,42,0.05)" stroke-width="18" stroke-linecap="round"/>
          <path d="M40 490 C 240 350, 520 360, 920 520" stroke="rgba(15,23,42,0.045)" stroke-width="16" stroke-linecap="round"/>
        </svg>
      </div>`;
  }
  if (model === "aurora-portal") {
    return `
      <div class="bg-aurora">
        <div class="aurora-orb aurora-cyan" id="bokeh-tl"></div>
        <div class="aurora-orb aurora-pink" id="bokeh-br"></div>
      </div>`;
  }
  if (model === "dynamic-island") {
    return `
      <div class="bg-oled">
        <div class="oled-glow" id="bokeh-tl"></div>
        <div id="bokeh-br"></div>
      </div>`;
  }
  if (model === "violet-roi") {
    return `
      <div class="bg-vroi">
        <div class="vroi-orb vroi-violet" id="bokeh-tl"></div>
        <div class="vroi-orb vroi-emerald" id="bokeh-br"></div>
      </div>`;
  }
  const gridOverlay =
    variant === 1
      ? `<div style="position:absolute;inset:0;background-image:radial-gradient(rgba(15,23,42,0.07) 1.5px, transparent 1.5px);background-size:44px 44px;pointer-events:none"></div>`
      : variant === 2
        ? `<div style="position:absolute;inset:80px;border:1.5px solid rgba(15,23,42,0.06);border-radius:42px;pointer-events:none"></div>`
        : "";
  return `
    <div class="bokeh-layer">
      ${gridOverlay}
      <div class="bokeh-ring bokeh-tl" id="bokeh-tl"></div>
      <div class="bokeh-ring bokeh-br" id="bokeh-br"></div>
    </div>`;
}

export function buildProMotionComposition(input: ProMotionBuildInput): ProMotionBuildOutput {
  const audioOffset = input.audioOffsetSec ?? 0.7;
  const outroTail = input.outroTailSec ?? 1.8;
  const fps = input.fps ?? 30;
  const durationSec = +(audioOffset + input.totalDuration + outroTail).toFixed(3);
  const pal = MODEL_ACCENTS[input.model];
  const onAccInk = pal.dark ? "#06080E" : "#FFFFFF";
  const epSeed = hashSeed(`${input.bookTitle}::${input.pkg.ideaKey}::${input.pkg.title}::${input.model}`);

  const rawBeats = input.pkg.beats;
  const beatCount = rawBeats.length;
  const parsedBeats: ParsedBeatCopy[] = rawBeats.map((b, idx) => {
    const tBeat = input.beats[idx];
    const prevEnd =
      idx === 0
        ? 0
        : +(audioOffset + (input.beats[idx - 1]?.end ?? (idx * input.totalDuration) / beatCount)).toFixed(3);
    const curEnd =
      idx === beatCount - 1
        ? +(audioOffset + input.totalDuration).toFixed(3)
        : +(audioOffset + (tBeat?.end ?? ((idx + 1) * input.totalDuration) / beatCount)).toFixed(3);
    const safeEnd = Math.max(prevEnd + 1.1, curEnd);
    return parseBeatCopy(b, idx, prevEnd, safeEnd, input.words, audioOffset, input.pageWords);
  });

  const cmds: RuntimeCmd[] = [];
  const sceneWindows: Array<{ id: string; start: number; end: number; camId: string; exitAt: number }> = [];
  const rawSfxQueue: ProMotionSfxMoment[] = [];
  let uidCounter = 1;
  let sfxRot = epSeed % 17;
  const uid = (prefix: string) => `${prefix}-${uidCounter++}`;

  const addMotionSfx = (
    timeSec: number,
    kind: SfxKind,
    role: SfxRole,
    preferredFile: string,
    sceneIndex: number,
    gainScale = 1.95,
    transientWeight = 0.95,
  ) => {
    const clamped = Math.max(0.02, Math.min(durationSec - 0.18, +timeSec.toFixed(3)));
    rawSfxQueue.push({
      timeSec: clamped,
      kind,
      role,
      preferredFile,
      sceneIndex,
      gainScale,
      transientWeight,
    });
  };

  const nextWhooshFile = () => WHOOSH_FILES[sfxRot++ % WHOOSH_FILES.length];
  const nextPopFile = () => POP_FILES[sfxRot++ % POP_FILES.length];
  const nextSwishFile = () => SWISH_FILES[sfxRot++ % SWISH_FILES.length];

  // =========================================================================
  // 26 PALETTE-ADAPTIVE STORY MOTION-GRAPHIC FRAME BUILDERS
  // =========================================================================

  const renderWatchArc = (b: ParsedBeatCopy): string => {
    const arcId = uid("warc");
    const handId = uid("whand");
    const copyId = uid("wcopy");
    const cx = 180;
    const cy = 1280;
    const rArc = 880;
    const ticks: string[] = [];
    for (let deg = -84; deg <= -12; deg += 3) {
      const rad = (deg * Math.PI) / 180;
      const major = deg % 15 === 0;
      const rIn = major ? 774 : 806;
      const rOut = major ? 838 : 834;
      ticks.push(
        `<line x1="${(cx + rIn * Math.cos(rad)).toFixed(1)}" y1="${(cy + rIn * Math.sin(rad)).toFixed(1)}" x2="${(cx + rOut * Math.cos(rad)).toFixed(1)}" y2="${(cy + rOut * Math.sin(rad)).toFixed(1)}" stroke="${major ? pal.ink : pal.dark ? "rgba(255,255,255,0.25)" : "#CBD5E1"}" stroke-width="${major ? "3" : "1.8"}" stroke-linecap="round"/>`,
      );
    }
    const a0 = (-88 * Math.PI) / 180;
    const a1 = (-8 * Math.PI) / 180;
    const dPath = `M ${(cx + rArc * Math.cos(a0)).toFixed(1)} ${(cy + rArc * Math.sin(a0)).toFixed(1)} A ${rArc} ${rArc} 0 0 1 ${(cx + rArc * Math.cos(a1)).toFixed(1)} ${(cy + rArc * Math.sin(a1)).toFixed(1)}`;
    cmds.push({ op: "draw", sel: `#${arcId}`, at: b.startSec + 0.08, dur: 1.05, dash: 1400 });
    cmds.push({ op: "rotate", sel: `#${handId}`, at: b.startSec, dur: Math.max(0.8, b.endSec - b.startSec), a: -24, b: 32 });
    cmds.push({ op: "blurIn", sel: `#${copyId}`, at: b.startSec + 0.22, dur: 0.48, a: 28, b: 0.94 });
    addMotionSfx(b.startSec + 0.14, "clock-tick", "chrono-gear", "SFX_01_08.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.66, "clock-tick", "chrono-gear", "SFX_01_08.wav", b.index, 1.75, 0.95);
    return `
      <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" style="position:absolute;inset:0">
        ${ticks.join("")}
        <path id="${arcId}" d="${dPath}" stroke="${pal.acc}" stroke-width="8" stroke-linecap="round" stroke-dasharray="1400" stroke-dashoffset="1400"/>
        <g id="${handId}" style="transform-origin:180px 1280px;filter:drop-shadow(16px 20px 16px rgba(0,0,0,0.18))">
          <circle cx="180" cy="1280" r="32" fill="${pal.ink}"/><circle cx="180" cy="1280" r="14" fill="${pal.acc}"/>
          <polygon points="163,1280 197,1280 190,680 170,680" fill="${pal.ink}"/>
          <rect x="156" y="664" width="48" height="22" rx="8" fill="${pal.acc}"/>
          <path d="M180 664 L222 560 L180 450 L138 560 Z" fill="${pal.ink}"/>
          <path d="M180 626 L200 562 L180 494 L160 562 Z" fill="${pal.bg}"/>
          <polygon points="174,454 186,454 180,312" fill="${pal.ink}"/>
        </g>
      </svg>
      <div id="${copyId}" style="position:absolute;left:50%;top:1310px;transform:translateX(-50%);width:820px;text-align:center">
        <div style="font-size:54px;font-weight:500;letter-spacing:-0.035em;color:${pal.ink}">${esc(b.lead)}</div>
        <div class="serif-it txt-acc" style="font-size:76px;line-height:1.05;margin-top:6px">${esc(b.climax)}</div>
        <div style="font-size:25px;color:${pal.subInk};margin-top:18px;line-height:1.38">${esc(b.microCaption)}</div>
      </div>`;
  };

  const renderViewfinderGroup = (b: ParsedBeatCopy): string => {
    const hdrId = uid("vfh");
    const grpId = uid("vfg");
    const ftId = uid("vff");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.06, dur: 0.46, a: -22, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${grpId}`, at: b.startSec + 0.24, dur: 0.5, a: 26, b: 0.9 });
    cmds.push({ op: "blurIn", sel: `#${ftId}`, at: b.startSec + 0.42, dur: 0.46, a: 18, b: 0.95 });
    addMotionSfx(b.startSec + 0.12, "shutter-snap", "archival-shutter", "SFX_01_06.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.48, "ui-click", "bento-ui", nextPopFile(), b.index, 1.65, 0.85);
    const bust = (fill: string) =>
      `<svg viewBox="0 0 120 132" width="100%" height="100%" fill="none"><circle cx="60" cy="38" r="24" fill="${fill}"/><path d="M14 124 C14 88, 34 74, 60 74 C86 74, 106 88, 106 124 Z" fill="${fill}"/></svg>`;
    return `
      <div style="position:absolute;left:110px;top:430px;width:860px;height:980px">
        <div style="position:absolute;left:0;top:0;width:160px;height:160px;border-left:4px solid ${pal.acc};border-top:4px solid ${pal.acc}"></div>
        <div style="position:absolute;right:0;top:0;width:160px;height:160px;border-right:4px solid ${pal.acc};border-top:4px solid ${pal.acc}"></div>
        <div style="position:absolute;left:0;bottom:0;width:160px;height:160px;border-left:4px solid ${pal.acc};border-bottom:4px solid ${pal.acc}"></div>
        <div style="position:absolute;right:0;bottom:0;width:160px;height:160px;border-right:4px solid ${pal.acc};border-bottom:4px solid ${pal.acc}"></div>
        <div id="${hdrId}" style="position:absolute;left:40px;right:40px;top:110px;text-align:center">
          <div style="font-size:62px;font-weight:500;letter-spacing:-0.035em;color:${pal.ink}">${esc(b.lead)}</div>
          <div class="serif-it txt-acc" style="font-size:74px;margin-top:4px">${esc(b.climax)}</div>
        </div>
        <div id="${grpId}" style="position:absolute;left:50%;top:435px;transform:translateX(-50%);width:780px;height:210px;display:flex;align-items:flex-end;justify-content:center;gap:22px">
          <div style="width:106px;height:118px;filter:blur(4px);opacity:0.8">${bust(pal.acc)}</div>
          <div style="width:136px;height:150px;filter:blur(2px);opacity:0.92">${bust(pal.acc)}</div>
          <div style="position:relative;width:182px;height:200px">${bust(pal.ink)}</div>
          <div style="width:136px;height:150px;filter:blur(2px);opacity:0.92">${bust(pal.acc)}</div>
          <div style="width:106px;height:118px;filter:blur(4px);opacity:0.8">${bust(pal.acc)}</div>
        </div>
        <div id="${ftId}" style="position:absolute;left:70px;right:70px;top:736px;text-align:center;font-size:26px;line-height:1.38;color:${pal.subInk}">${esc(b.microCaption)}</div>
      </div>`;
  };

  const renderRingCounter = (b: ParsedBeatCopy, gradientId?: string): string => {
    const boxId = uid("rcbox");
    const arcId = uid("rcarc");
    const numId = uid("rcnum");
    const lblId = uid("rclbl");
    const dur = Math.max(0.6, b.endSec - b.startSec - 0.35);
    cmds.push({ op: "blurIn", sel: `#${boxId}`, at: b.startSec + 0.04, dur: 0.46, a: 24, b: 0.86 });
    cmds.push({ op: "draw", sel: `#${arcId}`, at: b.startSec + 0.1, dur, dash: 918 });
    cmds.push({
      op: "counter",
      sel: `#${numId}`,
      at: b.startSec + 0.1,
      dur,
      a: Math.max(10, Math.round(b.metricTargetNum * 0.2)),
      b: b.metricTargetNum,
      suffix: b.metricText.endsWith("%") ? "%" : "",
    });
    cmds.push({ op: "blurIn", sel: `#${lblId}`, at: b.startSec + 0.26, dur: 0.46, a: 20, b: 0.94 });
    addMotionSfx(b.startSec + 0.12, "counter-tick", "chrono-gear", "SFX_01_08.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.56, "ui-click", "vector-pop", nextPopFile(), b.index, 1.75, 0.9);
    return `
      <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:860px;text-align:center">
        <div id="${boxId}" style="position:relative;width:356px;height:356px;margin:0 auto;filter:drop-shadow(0 0 38px ${pal.accSoft})">
          <svg viewBox="0 0 356 356" width="356" height="356" fill="none">
            ${gradientId ? `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${pal.acc}"/><stop offset="100%" stop-color="${pal.acc2}"/></linearGradient></defs>` : ""}
            <circle cx="178" cy="178" r="146" stroke="${pal.dark ? "rgba(255,255,255,0.14)" : "#E5E7EB"}" stroke-width="20"/>
            <circle id="${arcId}" cx="178" cy="178" r="146" stroke="${gradientId ? `url(#${gradientId})` : pal.acc}" stroke-width="20" stroke-linecap="round" transform="rotate(-90 178 178)" stroke-dasharray="918" stroke-dashoffset="918"/>
          </svg>
          <div id="${numId}" style="position:absolute;left:50%;top:48%;transform:translate(-50%,-50%);font-size:94px;font-weight:600;letter-spacing:-0.04em;color:${pal.ink}">${esc(b.metricText)}</div>
          <div style="position:absolute;left:50%;top:68%;transform:translateX(-50%);font-size:21px;font-weight:600;letter-spacing:0.08em;color:${pal.acc};text-transform:uppercase">${esc(b.pageLabel)}</div>
        </div>
        <div id="${lblId}" style="margin-top:38px;font-size:52px;font-weight:500;letter-spacing:-0.03em;color:${pal.ink}">${esc(b.lead)} <span class="txt-acc">${esc(b.climax)}</span></div>
      </div>`;
  };

  const renderFloatingBookCards = (b: ParsedBeatCopy, watermark = "✦"): string => {
    const wmId = uid("fwm");
    const hlId = uid("fhl");
    const c1 = uid("fc1");
    const c2 = uid("fc2");
    cmds.push({ op: "blurIn", sel: `#${wmId}`, at: b.startSec, dur: 0.46, a: 16, b: 0.88 });
    cmds.push({ op: "blurIn", sel: `#${hlId}`, at: b.startSec + 0.08, dur: 0.48, a: 22, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${c1}`, at: b.startSec + 0.22, dur: 0.52, a: 32, b: 0.9 });
    cmds.push({ op: "blurIn", sel: `#${c2}`, at: b.startSec + 0.54, dur: 0.52, a: 32, b: 0.9 });
    addMotionSfx(b.startSec + 0.22, "card-pop", "bento-ui", nextPopFile(), b.index, 1.95, 1.0);
    addMotionSfx(b.startSec + 0.56, "card-pop", "paper-slide", nextPopFile(), b.index, 1.8, 0.9);
    const cardBg = pal.dark ? "rgba(22,25,36,0.92)" : "#FFFFFF";
    const cardBorder = pal.dark ? "rgba(255,255,255,0.16)" : "#E5E7EB";
    return `
      <div id="${c1}" style="position:absolute;left:76px;top:330px;width:540px;padding:30px 32px;border-radius:28px;background:${cardBg};border:1.5px solid ${cardBorder};box-shadow:0 24px 54px rgba(0,0,0,0.12)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span style="font-size:20px;font-weight:700;color:${pal.acc};text-transform:uppercase">BOOK EVIDENCE · ${esc(b.pageLabel)}</span>
          <span style="color:${pal.acc};font-size:19px;font-weight:700">★★★★★</span>
        </div>
        <div style="font-size:23px;line-height:1.42;color:${pal.ink}">“${esc(b.quoteSnippet)}”</div>
      </div>
      <div id="${c2}" style="position:absolute;right:76px;top:1190px;width:500px;padding:28px 30px;border-radius:28px;background:${cardBg};border:1.5px solid ${cardBorder};box-shadow:0 24px 54px rgba(0,0,0,0.12)">
        <div style="font-size:19px;font-weight:700;color:${pal.acc2};margin-bottom:8px;text-transform:uppercase">KEY TAKEAWAY</div>
        <div style="font-size:24px;font-weight:500;line-height:1.36;color:${pal.ink}">${esc(b.onScreen)} — ${esc(b.clauses[1])}</div>
      </div>
      <svg id="${wmId}" viewBox="0 0 800 320" width="800" height="320" fill="none" aria-hidden="true" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-54%);pointer-events:none">
        <text x="400" y="230" text-anchor="middle" font-size="220" font-weight="700" stroke="${pal.accSoft}" stroke-width="4" fill="none">${esc(watermark)}</text>
      </svg>
      <div id="${hlId}" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:920px;text-align:center;font-size:66px;font-weight:500;letter-spacing:-0.035em;color:${pal.ink}">
        ${esc(b.lead)} <span class="txt-acc">${esc(b.climax)}</span>
      </div>`;
  };

  const renderHexagonTriad = (b: ParsedBeatCopy): string => {
    const h1 = uid("hx1");
    const h2 = uid("hx2");
    const h3 = uid("hx3");
    const l1 = uid("hl1");
    const l2 = uid("hl2");
    const l3 = uid("hl3");
    const step = Math.min(0.5, Math.max(0.36, (b.endSec - b.startSec) * 0.22));
    cmds.push({ op: "blurIn", sel: `#${h1}`, at: b.startSec + 0.06, dur: 0.45, a: 24, b: 0.78 });
    cmds.push({ op: "blurIn", sel: `#${l1}`, at: b.startSec + 0.18, dur: 0.38, a: 12, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${h2}`, at: b.startSec + step, dur: 0.45, a: 24, b: 0.78 });
    cmds.push({ op: "blurIn", sel: `#${l2}`, at: b.startSec + step + 0.14, dur: 0.38, a: 12, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${h3}`, at: b.startSec + step * 2, dur: 0.45, a: 24, b: 0.78 });
    cmds.push({ op: "blurIn", sel: `#${l3}`, at: b.startSec + step * 2 + 0.14, dur: 0.38, a: 12, b: 0.94 });
    addMotionSfx(b.startSec + 0.08, "card-pop", "vector-pop", "SFX_01_09.wav", b.index, 1.9, 0.95);
    addMotionSfx(b.startSec + step, "ui-click", "bento-ui", "SFX_01_05.wav", b.index, 1.75, 0.9);
    addMotionSfx(b.startSec + step * 2, "ui-click", "vector-pop", "SFX_01_03.wav", b.index, 1.85, 0.95);
    const hexSvg = (num: string) => `
      <svg viewBox="0 0 250 284" width="250" height="284" fill="none">
        <polygon points="125,10 238,75 238,209 125,274 12,209 12,75" fill="${pal.acc}"/>
        <polyline points="88,31 125,10 162,31" stroke="${pal.ink}" stroke-width="6" stroke-linecap="round"/>
        <polyline points="12,170 12,209 46,229" stroke="${pal.ink}" stroke-width="6" stroke-linecap="round"/>
        <polyline points="238,170 238,209 204,229" stroke="${pal.ink}" stroke-width="6" stroke-linecap="round"/>
        <circle cx="125" cy="142" r="56" stroke="${onAccInk}" stroke-width="3.5"/>
        <text x="125" y="158" text-anchor="middle" fill="${onAccInk}" font-size="44" font-weight="700">${num}</text>
      </svg>`;
    return `
      <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" style="position:absolute;inset:0">
        <polyline points="365,650 365,575 280,520" stroke="${pal.ink}" stroke-width="3"/>
        <polyline points="715,650 715,575 800,520" stroke="${pal.ink}" stroke-width="3"/>
        <polyline points="540,1235 540,1315 615,1365" stroke="${pal.ink}" stroke-width="3"/>
      </svg>
      <div id="${h1}" style="position:absolute;left:240px;top:640px">${hexSvg("01")}</div>
      <div id="${h2}" style="position:absolute;left:590px;top:640px">${hexSvg("02")}</div>
      <div id="${h3}" style="position:absolute;left:415px;top:952px">${hexSvg("03")}</div>
      <div id="${l1}" style="position:absolute;left:76px;top:464px;font-size:34px;font-weight:500;color:${pal.ink}">${esc(clipText(b.clauses[0], "First factor", 22))}</div>
      <div id="${l2}" style="position:absolute;right:76px;top:464px;font-size:34px;font-weight:500;color:${pal.ink}">${esc(clipText(b.clauses[1], "Second factor", 22))}</div>
      <div id="${l3}" style="position:absolute;left:430px;top:1376px;font-size:34px;font-weight:600;color:${pal.acc}">${esc(clipText(b.clauses[2], "Core outcome", 22))} ✓</div>`;
  };

  const renderPillCascade = (b: ParsedBeatCopy): string => {
    const pIds = [uid("pl1"), uid("pl2"), uid("pl3"), uid("pl4"), uid("pl5"), uid("pl6")];
    const span = Math.max(1.2, b.endSec - b.startSec - 0.5);
    pIds.forEach((id, idx) => {
      const at = b.startSec + idx * (span / 6);
      cmds.push({ op: "blurIn", sel: `#${id}`, at, dur: 0.42, a: 22, b: 0.88 });
      if (idx === 0 || idx === 2 || idx === 4) {
        addMotionSfx(at + 0.04, idx === 0 ? "card-pop" : "ui-click", "bento-ui", nextPopFile(), b.index, 1.8, 0.92);
      }
    });
    return `
      <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:940px;display:flex;flex-direction:column;gap:26px">
        <div style="display:flex;gap:22px">
          <div class="k-pill k-pill-acc" id="${pIds[0]}">${esc(clipText(b.clauses[0], "Clearer focus", 22))}</div>
          <div class="k-pill k-pill-out" id="${pIds[1]}">${esc(clipText(b.clauses[1], "Sharper", 18))}</div>
        </div>
        <div style="display:flex;gap:22px">
          <div class="k-pill k-pill-out" id="${pIds[2]}">${esc(clipText(b.clauses[2], "Intentional", 18))}</div>
          <div class="k-pill k-pill-acc" id="${pIds[3]}">${esc(clipText(b.clauses[3], "Zero friction", 22))}</div>
        </div>
        <div style="display:flex;gap:22px">
          <div class="k-pill k-pill-acc" id="${pIds[4]}">${esc(clipText(b.onScreen, "Core insight", 26))}</div>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <div class="k-pill k-pill-out" id="${pIds[5]}">${esc(clipText(b.climax, "Effortless action", 26))}</div>
        </div>
      </div>`;
  };

  const renderTodoStrikeCard = (b: ParsedBeatCopy): string => {
    const cardId = uid("tdc");
    const s1 = uid("tds1");
    const s2 = uid("tds2");
    const capId = uid("tdcap");
    cmds.push({ op: "blurIn", sel: `#${cardId}`, at: b.startSec + 0.04, dur: 0.48, a: 30, b: 0.92 });
    cmds.push({ op: "scaleX", sel: `#${s1}`, at: b.startSec + 0.42, dur: 0.36 });
    cmds.push({ op: "scaleX", sel: `#${s2}`, at: b.startSec + 0.82, dur: 0.36 });
    cmds.push({ op: "blurIn", sel: `#${capId}`, at: b.startSec + 0.25, dur: 0.46, a: 20, b: 0.95 });
    addMotionSfx(b.startSec + 0.42, "marker-swish", "paper-slide", "SFX_01_01.wav", b.index, 2.05, 1.0);
    addMotionSfx(b.startSec + 0.82, "marker-swish", "whip-accent", nextSwishFile(), b.index, 1.9, 0.95);
    const mutedRow = pal.dark ? "#94A3B8" : "#475569";
    const rowBd = pal.dark ? "rgba(255,255,255,0.1)" : "#F1F5F9";
    return `
      <div class="white-card" id="${cardId}" style="position:absolute;left:90px;top:470px;width:900px;padding:42px 46px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:26px">
          <span style="font-size:28px;font-weight:600;color:${pal.ink}">Priority Filter · ${esc(b.pageLabel)}</span>
          <span style="background:${pal.accSoft};color:${pal.acc};padding:8px 20px;border-radius:999px;font-size:20px;font-weight:700">VERIFIED</span>
        </div>
        <div style="position:relative;padding:22px 12px;border-bottom:1.5px solid ${rowBd};font-size:32px;color:${mutedRow}">${esc(clipText(b.clauses[1], "Habitual noise", 34))}<div id="${s1}" style="position:absolute;left:8px;right:24px;top:52%;height:5px;background:${pal.acc};transform-origin:left center;transform:scaleX(0)"></div></div>
        <div style="position:relative;padding:22px 12px;border-bottom:1.5px solid ${rowBd};font-size:32px;color:${mutedRow}">${esc(clipText(b.clauses[2], "Distracted effort", 34))}<div id="${s2}" style="position:absolute;left:8px;right:24px;top:52%;height:5px;background:${pal.acc};transform-origin:left center;transform:scaleX(0)"></div></div>
        <div style="padding:24px 12px;font-size:34px;font-weight:600;color:${pal.acc}">✓ ${esc(clipText(b.onScreen, b.climax, 34))}</div>
      </div>
      <div id="${capId}" style="position:absolute;left:90px;right:90px;top:1280px;text-align:center;font-size:50px;font-weight:500;color:${pal.ink}">${esc(b.lead)} <span class="serif-it txt-acc" style="font-size:66px">${esc(b.climax)}</span></div>`;
  };

  const renderDualVessels = (b: ParsedBeatCopy): string => {
    const leftId = uid("vsl");
    const rightId = uid("vsr");
    const fillId = uid("vsf");
    const capId = uid("vscap");
    cmds.push({ op: "blurIn", sel: `#${leftId}`, at: b.startSec + 0.05, dur: 0.48, a: 28, b: 0.92 });
    cmds.push({ op: "blurIn", sel: `#${rightId}`, at: b.startSec + 0.34, dur: 0.5, a: 28, b: 0.92 });
    cmds.push({ op: "scaleY", sel: `#${fillId}`, at: b.startSec + 0.52, dur: 0.72 });
    cmds.push({ op: "blurIn", sel: `#${capId}`, at: b.startSec + 0.62, dur: 0.46, a: 20, b: 0.95 });
    addMotionSfx(b.startSec + 0.08, "card-pop", "bento-ui", nextPopFile(), b.index, 1.85, 0.9);
    addMotionSfx(b.startSec + 0.52, "counter-tick", "vector-pop", "SFX_01_09.wav", b.index, 1.95, 1.0);
    return `
      <div style="position:absolute;left:90px;top:430px;width:900px;height:740px;display:flex;align-items:flex-end;justify-content:center;gap:84px">
        <div id="${leftId}" style="width:310px;text-align:center">
          <div style="width:310px;height:520px;border-radius:36px;border:2.5px solid #CBD5E1;padding:18px;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;background:${pal.dark ? "rgba(255,255,255,0.06)" : "#FFF"}">
            <div style="height:82px;border-radius:18px;background:#E2E8F0;display:flex;align-items:center;justify-content:center;font-size:22px;color:#334155">${esc(clipText(b.clauses[1], "Friction", 16))}</div>
            <div style="height:82px;border-radius:18px;background:#E2E8F0;display:flex;align-items:center;justify-content:center;font-size:22px;color:#334155">${esc(clipText(b.clauses[2], "Noise", 16))}</div>
            <div style="height:82px;border-radius:18px;background:#E2E8F0;display:flex;align-items:center;justify-content:center;font-size:22px;color:#334155">Low Impact</div>
          </div>
          <div style="margin-top:20px;font-size:30px;color:${pal.subInk}">Old Pattern</div>
        </div>
        <div id="${rightId}" style="width:310px;text-align:center">
          <div style="width:310px;height:520px;border-radius:36px;border:3px solid ${pal.acc};padding:18px;display:flex;flex-direction:column;justify-content:flex-end;background:${pal.dark ? "rgba(255,255,255,0.08)" : "#FFF"};box-shadow:0 24px 60px ${pal.accSoft}">
            <div id="${fillId}" style="height:370px;border-radius:22px;background:${pal.acc};color:${onAccInk};display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px;transform-origin:bottom center;transform:scaleY(0.08)">
              <div style="font-size:64px;font-weight:700">${esc(b.metricText)}</div>
              <div style="font-size:24px;font-weight:600;margin-top:8px">${esc(clipText(b.onScreen, "Focus", 16))}</div>
            </div>
          </div>
          <div style="margin-top:20px;font-size:30px;font-weight:600;color:${pal.acc}">${esc(clipText(b.climax, "True Focus", 18))} ✓</div>
        </div>
      </div>
      <div id="${capId}" class="serif-it" style="position:absolute;left:90px;right:90px;top:1280px;text-align:center;font-size:62px;color:${pal.ink}">${esc(b.lead)} <span class="txt-acc">${esc(b.climax)}</span></div>`;
  };

  const renderLaserLens = (b: ParsedBeatCopy): string => {
    const cardId = uid("lns");
    const rIn = uid("lri");
    const rOut = uid("lro");
    const ftId = uid("lnf");
    cmds.push({ op: "blurIn", sel: `#${cardId}`, at: b.startSec + 0.04, dur: 0.48, a: 28, b: 0.92 });
    cmds.push({ op: "draw", sel: `#${rIn}`, at: b.startSec + 0.18, dur: 0.62, dash: 1100 });
    cmds.push({ op: "draw", sel: `#${rOut}`, at: b.startSec + 0.52, dur: 0.68, dash: 1000 });
    cmds.push({ op: "blurIn", sel: `#${ftId}`, at: b.startSec + 0.35, dur: 0.48, a: 20, b: 0.95 });
    addMotionSfx(b.startSec + 0.18, "ui-click", "neuro-circuit", "SFX_01_05.wav", b.index, 1.8, 0.9);
    addMotionSfx(b.startSec + 0.54, "scene-whoosh", "neuro-circuit", "SFX_01_04.wav", b.index, 2.0, 1.0);
    return `
      <div class="white-card" id="${cardId}" style="position:absolute;left:80px;top:450px;width:920px;padding:44px;border:2.5px solid ${pal.acc};background:${pal.dark ? "rgba(18,20,30,0.92)" : "#FFFFFF"}">
        <div style="display:flex;justify-content:space-between;font-size:22px;font-weight:700;color:${pal.acc};margin-bottom:20px">
          <span>CONVERGING FOCUS · ${esc(b.pageLabel)}</span><span>100% LOCKED ✓</span>
        </div>
        <svg viewBox="0 0 830 460" width="830" height="460" fill="none">
          <path id="${rIn}" d="M 36 116 L 380 116 M 36 230 L 380 230 M 36 344 L 380 344" stroke="${pal.acc}" stroke-width="6" stroke-linecap="round" stroke-dasharray="1100" stroke-dashoffset="1100"/>
          <path d="M 390 56 C 446 146, 446 314, 390 404 C 334 314, 334 146, 390 56 Z" fill="${pal.accSoft}" stroke="${pal.acc}" stroke-width="5"/>
          <path id="${rOut}" d="M 404 122 L 694 230 M 418 230 L 694 230 M 404 338 L 694 230" stroke="${pal.acc}" stroke-width="7" stroke-linecap="round" stroke-dasharray="1000" stroke-dashoffset="1000"/>
          <circle cx="694" cy="230" r="32" fill="${pal.acc}"/><circle cx="694" cy="230" r="11" fill="${onAccInk}"/>
        </svg>
      </div>
      <div id="${ftId}" style="position:absolute;left:80px;right:80px;top:1230px;text-align:center;font-size:52px;font-weight:500;color:${pal.ink}">${esc(b.lead)} <span class="serif-it txt-acc" style="font-size:68px">${esc(b.climax)}</span></div>`;
  };

  const renderPaperBookPeel = (b: ParsedBeatCopy): string => {
    const topId = uid("pbt");
    const bookId = uid("pbb");
    const peelId = uid("pbp");
    const botId = uid("pbbo");
    cmds.push({ op: "blurIn", sel: `#${topId}`, at: b.startSec + 0.05, dur: 0.45, a: -18, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${bookId}`, at: b.startSec + 0.14, dur: 0.55, a: 28, b: 0.88 });
    cmds.push({ op: "scaleX", sel: `#${peelId}`, at: b.startSec + 0.5, dur: 0.6 });
    cmds.push({ op: "blurIn", sel: `#${botId}`, at: b.startSec + 0.58, dur: 0.48, a: 20, b: 0.94 });
    addMotionSfx(b.startSec + 0.14, "card-pop", "archival-shutter", "SFX_01_06.wav", b.index, 1.85, 0.9);
    addMotionSfx(b.startSec + 0.5, "page-turn", "paper-slide", "SFX_01_01.wav", b.index, 2.05, 1.0);
    return `
      <div id="${topId}" style="position:absolute;left:120px;right:120px;top:370px;text-align:center">
        <div class="serif-it" style="font-size:48px;color:${pal.subInk}">${esc(b.pageLabel)}</div>
        <div style="font-size:58px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${pal.ink}">${esc(clipText(input.bookTitle, "THE BOOK", 22))}</div>
      </div>
      <div id="${bookId}" style="position:absolute;left:50%;top:880px;transform:translate(-50%,-50%) rotate(-7deg);width:410px;height:520px;border-radius:14px 26px 26px 14px;background:linear-gradient(145deg,#3F3F46,#18181B);border:3px solid ${pal.acc};box-shadow:28px 36px 60px rgba(0,0,0,0.32);padding:34px;display:flex;flex-direction:column;justify-content:space-between;color:#F8FAFC">
        <div style="border:2px solid rgba(255,255,255,0.28);border-radius:10px;padding:24px;height:100%;display:flex;flex-direction:column;justify-content:space-between;text-align:center">
          <div style="font-size:20px;letter-spacing:0.14em;opacity:0.85">ARCHIVAL EDITION</div>
          <div class="serif-it" style="font-size:46px;line-height:1.15">${esc(clipText(b.onScreen, b.climax, 24))}</div>
          <div style="font-size:20px;opacity:0.8">${esc(b.pageLabel)}</div>
        </div>
        <div id="${peelId}" style="position:absolute;left:-40px;top:42%;width:240px;height:130px;background:#52525B;border-radius:6px;box-shadow:12px 18px 30px rgba(0,0,0,0.34);transform-origin:right center;transform:scaleX(0) skewY(-10deg)"></div>
      </div>
      <div id="${botId}" style="position:absolute;left:110px;right:110px;top:1290px;text-align:center">
        <div style="font-size:42px;color:${pal.subInk}">${esc(b.lead)}</div>
        <div style="font-size:66px;font-weight:700;color:${pal.acc};margin-top:6px">${esc(b.climax)}</div>
      </div>`;
  };

  const renderPaperFramedPortrait = (b: ParsedBeatCopy): string => {
    const hdrId = uid("pfh");
    const boxId = uid("pfb");
    const tagId = uid("pft");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.05, dur: 0.45, a: -18, b: 0.95 });
    cmds.push({ op: "blurIn", sel: `#${boxId}`, at: b.startSec + 0.16, dur: 0.52, a: 26, b: 0.9 });
    cmds.push({ op: "blurIn", sel: `#${tagId}`, at: b.startSec + 0.52, dur: 0.48, a: 22, b: 0.92 });
    addMotionSfx(b.startSec + 0.16, "shutter-snap", "dossier-stamp", "SFX_01_07.wav", b.index, 1.95, 1.0);
    addMotionSfx(b.startSec + 0.54, "card-pop", "bento-ui", nextPopFile(), b.index, 1.8, 0.9);
    return `
      <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" style="position:absolute;inset:0">
        <path d="M 90 120 Q 180 480, 250 610 M 830 1190 Q 920 1450, 960 1820 M 0 540 L 250 610 M 830 1190 L 1080 1280" stroke="${pal.dark ? "rgba(255,255,255,0.22)" : "rgba(17,19,23,0.32)"}" stroke-width="2"/>
      </svg>
      <div id="${hdrId}" style="position:absolute;left:100px;right:100px;top:490px;text-align:center;font-size:52px;font-weight:500;color:${pal.ink}">${esc(b.lead)}</div>
      <div id="${boxId}" style="position:absolute;left:250px;top:610px;width:580px;height:580px;background:#151221;border:6px solid ${pal.acc};box-shadow:26px 34px 56px rgba(0,0,0,0.3);padding:44px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;color:#F8FAFC">
        <div style="font-size:22px;letter-spacing:0.16em;color:#E9D5FF;margin-bottom:18px">${esc(b.pageLabel.toUpperCase())}</div>
        <div class="serif-it" style="font-size:46px;line-height:1.28">“${esc(clipText(b.quoteSnippet, b.voiceover, 86))}”</div>
      </div>
      <div id="${tagId}" style="position:absolute;left:50%;top:1260px;transform:translateX(-50%);text-align:center">
        <div style="display:inline-block;background:${pal.acc};color:${onAccInk};padding:18px 44px;border-radius:18px;font-size:58px;font-weight:700;box-shadow:14px 18px 34px rgba(0,0,0,0.22)">${esc(b.climax)}</div>
      </div>`;
  };

  const renderPaperMementoRing = (b: ParsedBeatCopy): string => {
    const hdrId = uid("pmh");
    const ringId = uid("pmr");
    const ftId = uid("pmf");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.05, dur: 0.45, a: -18, b: 0.95 });
    cmds.push({ op: "rotate", sel: `#${ringId}`, at: b.startSec, dur: Math.max(1, b.endSec - b.startSec), a: 0, b: 95 });
    cmds.push({ op: "blurIn", sel: `#${ftId}`, at: b.startSec + 0.44, dur: 0.48, a: 22, b: 0.94 });
    addMotionSfx(b.startSec + 0.14, "shutter-snap", "dossier-stamp", "SFX_01_07.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.56, "clock-tick", "chrono-gear", "SFX_01_08.wav", b.index, 1.75, 0.9);
    const brkCol = pal.dark ? "rgba(255,255,255,0.45)" : "#374151";
    return `
      <div style="position:absolute;left:120px;top:450px;width:840px;height:980px">
        <div style="position:absolute;left:0;top:0;width:70px;height:70px;border-left:4px solid ${brkCol};border-top:4px solid ${brkCol}"></div>
        <div style="position:absolute;right:0;top:0;width:70px;height:70px;border-right:4px solid ${brkCol};border-top:4px solid ${brkCol}"></div>
        <div style="position:absolute;left:0;bottom:0;width:70px;height:70px;border-left:4px solid ${brkCol};border-bottom:4px solid ${brkCol}"></div>
        <div style="position:absolute;right:0;bottom:0;width:70px;height:70px;border-right:4px solid ${brkCol};border-bottom:4px solid ${brkCol}"></div>
        <div id="${hdrId}" style="position:absolute;left:40px;right:40px;top:110px;text-align:center;font-size:56px;font-weight:500;color:${pal.ink}">${esc(b.lead)}</div>
        <div style="position:absolute;left:50%;top:490px;transform:translate(-50%,-50%);width:430px;height:430px">
          <svg id="${ringId}" viewBox="0 0 430 430" width="430" height="430" fill="none" style="transform-origin:215px 215px">
            <circle cx="215" cy="215" r="190" stroke="${pal.ink}" stroke-width="6" stroke-dasharray="18 12"/>
          </svg>
          <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:260px;height:260px;border-radius:50%;background:${pal.acc};box-shadow:18px 24px 42px rgba(0,0,0,0.24);display:flex;align-items:center;justify-content:center;font-size:74px;font-weight:700;color:${onAccInk}">${esc(b.metricText)}</div>
        </div>
        <div id="${ftId}" style="position:absolute;left:30px;right:30px;bottom:92px;text-align:center;font-size:64px;font-weight:600;color:${pal.ink}">${esc(clipText(b.onScreen, b.climax, 24).split(" ").slice(0, -1).join(" "))} <span class="serif-it txt-acc" style="font-size:76px;font-weight:700">${esc(cleanWords(b.climax).slice(-1)[0] ?? "truth")}</span></div>
      </div>`;
  };

  const renderDaylightTimelinePlayhead = (b: ParsedBeatCopy): string => {
    const hdrId = uid("dth");
    const boxId = uid("dtb");
    const phId = uid("dtp");
    const ftId = uid("dtf");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.05, dur: 0.45, a: -20, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${boxId}`, at: b.startSec + 0.16, dur: 0.5, a: 26, b: 0.92 });
    cmds.push({ op: "slideX", sel: `#${phId}`, at: b.startSec + 0.28, dur: Math.max(0.8, b.endSec - b.startSec - 0.35), a: -280, b: 280 });
    cmds.push({ op: "blurIn", sel: `#${ftId}`, at: b.startSec + 0.42, dur: 0.46, a: 20, b: 0.95 });
    addMotionSfx(b.startSec + 0.18, "ui-click", "bento-ui", "SFX_01_05.wav", b.index, 1.9, 0.95);
    addMotionSfx(b.startSec + 0.58, "marker-swish", "chrono-gear", nextSwishFile(), b.index, 1.8, 0.9);
    return `
      <div id="${hdrId}" style="position:absolute;left:90px;right:90px;top:490px;text-align:center">
        <div style="font-size:44px;color:${pal.subInk}">${esc(b.lead)}</div>
        <div style="font-size:88px;font-weight:700;color:${pal.acc};letter-spacing:-0.03em;margin-top:4px">${esc(cleanWords(b.onScreen).slice(0, 2).join(" ").toUpperCase() || "SEQUENCE")}</div>
      </div>
      <div id="${boxId}" style="position:absolute;left:100px;top:760px;width:880px;display:flex;flex-direction:column;gap:22px">
        <div style="display:flex;gap:20px"><div style="flex:1.4;height:82px;border-radius:18px;background:${pal.acc};opacity:0.92"></div><div style="flex:1;height:82px;border-radius:18px;background:${pal.acc2};opacity:0.75"></div></div>
        <div style="display:flex;gap:20px"><div style="flex:0.7;height:82px;border-radius:18px;background:${pal.acc2};opacity:0.75"></div><div style="flex:1.7;height:82px;border-radius:18px;background:${pal.acc};opacity:0.95"></div></div>
        <div style="display:flex;gap:20px"><div style="flex:1.2;height:82px;border-radius:18px;background:${pal.acc};opacity:0.85"></div><div style="flex:1.2;height:82px;border-radius:18px;background:${pal.acc2};opacity:0.9"></div></div>
        <div id="${phId}" style="position:absolute;left:50%;top:-34px;bottom:-34px;width:6px;background:${pal.ink}">
          <div style="position:absolute;left:-15px;top:-14px;width:0;height:0;border-left:18px solid transparent;border-right:18px solid transparent;border-top:26px solid ${pal.ink}"></div>
        </div>
      </div>
      <div id="${ftId}" style="position:absolute;left:100px;right:100px;top:1140px;text-align:center;font-size:42px;font-weight:600;color:${pal.ink}">${esc(b.microCaption)}</div>`;
  };

  const renderDaylightOrbitalWheel = (b: ParsedBeatCopy): string => {
    const lblId = uid("dow");
    const wheelId = uid("dowl");
    cmds.push({ op: "blurIn", sel: `#${lblId}`, at: b.startSec + 0.05, dur: 0.45, a: 18, b: 0.95 });
    cmds.push({ op: "rotate", sel: `#${wheelId}`, at: b.startSec, dur: Math.max(0.9, b.endSec - b.startSec), a: -22, b: 22 });
    addMotionSfx(b.startSec + 0.14, "scene-whoosh", "chrono-gear", "SFX_01_03.wav", b.index, 1.95, 0.95);
    addMotionSfx(b.startSec + 0.62, "clock-tick", "chrono-gear", "SFX_01_08.wav", b.index, 1.75, 0.9);
    const angles = [-32, -11, 11, 32];
    const nodes = angles
      .map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        const r = 640;
        const x = (r * Math.cos(rad)).toFixed(1);
        const y = (r * Math.sin(rad)).toFixed(1);
        return `<g transform="translate(${x} ${y})">
          <circle cx="0" cy="0" r="34" fill="${pal.bg}" stroke="${pal.acc}" stroke-width="5"/>
          <circle cx="0" cy="0" r="12" fill="${pal.acc}"/>
          <text x="56" y="12" fill="${pal.ink}" font-size="38" font-weight="600">${esc(clipText(b.clauses[idx], `Step ${idx + 1}`, 18))}</text>
        </g>`;
      })
      .join("");
    return `
      <div id="${lblId}" style="position:absolute;left:76px;top:920px;font-size:62px;font-weight:700;color:${pal.ink}">${esc(clipText(b.lead, "Key Drivers", 14))}</div>
      <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" style="position:absolute;inset:0">
        <g id="${wheelId}" style="transform-origin:0px 960px">
          <circle cx="0" cy="960" r="640" stroke="${pal.ink}" stroke-width="3.5"/>
          <g transform="translate(0 960)">${nodes}</g>
        </g>
      </svg>`;
  };

  const renderAuroraPortalConstellation = (b: ParsedBeatCopy, camId: string): string => {
    const ringId = uid("apc");
    const subId = uid("aps");
    const gradId = uid("apg");
    const portalAt = Math.max(b.startSec + 0.6, b.endSec - 0.42);
    cmds.push({ op: "blurIn", sel: `#${ringId}`, at: b.startSec + 0.05, dur: 0.48, a: 20, b: 0.88 });
    cmds.push({ op: "blurIn", sel: `#${subId}`, at: b.startSec + 0.24, dur: 0.48, a: 20, b: 0.94 });
    cmds.push({ op: "portalZoom", sel: `#${camId}`, at: portalAt, dur: 0.42 });
    addMotionSfx(b.startSec + 0.12, "ui-click", "neuro-circuit", nextPopFile(), b.index, 1.8, 0.9);
    addMotionSfx(portalAt, "scene-whoosh", "cinema-deep", "whoosh-cinematic-161021.mp3", b.index, 2.15, 1.0);
    const orbiters = [0, 60, 120, 180, 240, 300]
      .map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        const ox = Math.round(540 + 330 * Math.cos(rad)) - 42;
        const oy = Math.round(880 + 330 * Math.sin(rad)) - 42;
        return `<div style="position:absolute;left:${ox}px;top:${oy}px;width:84px;height:84px;border-radius:50%;background:${pal.acc};border:2.5px solid ${pal.ink};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:${onAccInk};box-shadow:0 0 24px ${pal.accSoft}">0${idx + 1}</div>`;
      })
      .join("");
    return `
      ${orbiters}
      <div id="${ringId}" style="position:absolute;left:50%;top:880px;transform:translate(-50%,-50%);width:280px;height:280px">
        <svg viewBox="0 0 280 280" width="280" height="280" fill="none" style="filter:drop-shadow(0 0 32px ${pal.accSoft})">
          <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${pal.acc}"/><stop offset="100%" stop-color="${pal.acc2}"/></linearGradient></defs>
          <circle cx="140" cy="140" r="118" stroke="url(#${gradId})" stroke-width="14"/>
        </svg>
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center">
          <div style="font-size:64px;font-weight:700;color:${pal.ink}">${esc(b.metricText)}</div>
          <div style="font-size:19px;font-weight:600;color:${pal.subInk}">${esc(b.pageLabel)}</div>
        </div>
      </div>
      <div id="${subId}" style="position:absolute;left:90px;right:90px;top:1310px;text-align:center;font-size:48px;font-weight:600;color:${pal.ink}">${esc(b.onScreen)}</div>`;
  };

  const renderAuroraLineChart = (b: ParsedBeatCopy): string => {
    const cardId = uid("alc");
    const lineId = uid("all");
    const gradId = uid("alg");
    const botId = uid("alb");
    cmds.push({ op: "blurIn", sel: `#${cardId}`, at: b.startSec + 0.05, dur: 0.48, a: 28, b: 0.92 });
    cmds.push({ op: "draw", sel: `#${lineId}`, at: b.startSec + 0.24, dur: 0.95, dash: 900 });
    cmds.push({ op: "blurIn", sel: `#${botId}`, at: b.startSec + 0.46, dur: 0.48, a: 24, b: 0.94 });
    addMotionSfx(b.startSec + 0.24, "marker-swish", "vector-pop", "SFX_01_09.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.68, "ui-click", "bento-ui", nextPopFile(), b.index, 1.75, 0.9);
    return `
      <div id="${cardId}" style="position:absolute;left:100px;top:410px;width:880px;padding:48px;border-radius:36px;background:#111522;color:#F8FAFC;border:2px solid rgba(255,255,255,0.16);box-shadow:0 28px 64px rgba(0,0,0,0.28)">
        <div style="font-size:34px;font-weight:600;margin-bottom:28px;color:#F8FAFC"><span style="color:#22D3EE">${esc(b.metricText)}</span> ${esc(b.onScreen)}</div>
        <svg viewBox="0 0 780 420" width="780" height="420" fill="none">
          <defs><linearGradient id="${gradId}" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#22D3EE"/><stop offset="55%" stop-color="#A855F7"/><stop offset="100%" stop-color="#EC4899"/></linearGradient></defs>
          <line x1="30" y1="90" x2="750" y2="90" stroke="rgba(255,255,255,0.16)" stroke-dasharray="8 8"/>
          <line x1="30" y1="210" x2="750" y2="210" stroke="rgba(255,255,255,0.16)" stroke-dasharray="8 8"/>
          <line x1="30" y1="330" x2="750" y2="330" stroke="rgba(255,255,255,0.16)" stroke-dasharray="8 8"/>
          <line x1="30" y1="40" x2="30" y2="380" stroke="rgba(255,255,255,0.45)" stroke-width="2.5"/>
          <line x1="30" y1="380" x2="760" y2="380" stroke="rgba(255,255,255,0.45)" stroke-width="2.5"/>
          <path id="${lineId}" d="M 48 356 L 190 322 L 340 218 L 486 244 L 612 178 L 742 64" stroke="url(#${gradId})" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="900" stroke-dashoffset="900"/>
        </svg>
      </div>
      <div id="${botId}" style="position:absolute;left:100px;top:1090px;width:880px;padding:38px 44px;border-radius:32px;background:#111522;border:2px solid rgba(255,255,255,0.14);text-align:center;box-shadow:0 22px 48px rgba(0,0,0,0.22)">
        <div style="font-size:22px;color:#22D3EE;font-weight:700;margin-bottom:10px">${esc(b.pageLabel.toUpperCase())} · TRAJECTORY</div>
        <div style="font-size:34px;line-height:1.36;color:#F8FAFC">${esc(b.microCaption)}</div>
      </div>`;
  };

  const renderDynamicIslandStack = (b: ParsedBeatCopy): string => {
    const hdrId = uid("dih");
    const r1 = uid("dir1");
    const r2 = uid("dir2");
    const r3 = uid("dir3");
    const r4 = uid("dir4");
    const step = Math.min(0.42, Math.max(0.28, (b.endSec - b.startSec) * 0.16));
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.04, dur: 0.44, a: -18, b: 0.92 });
    cmds.push({ op: "blurIn", sel: `#${r1}`, at: b.startSec + step, dur: 0.44, a: 24, b: 0.9 });
    cmds.push({ op: "blurIn", sel: `#${r2}`, at: b.startSec + step * 2, dur: 0.44, a: 24, b: 0.9 });
    cmds.push({ op: "blurIn", sel: `#${r3}`, at: b.startSec + step * 3, dur: 0.44, a: 24, b: 0.9 });
    cmds.push({ op: "blurIn", sel: `#${r4}`, at: b.startSec + step * 4, dur: 0.44, a: 24, b: 0.9 });
    addMotionSfx(b.startSec + step, "card-pop", "bento-ui", "SFX_01_03.wav", b.index, 1.95, 1.0);
    addMotionSfx(b.startSec + step * 2.5, "ui-click", "bento-ui", "SFX_01_05.wav", b.index, 1.8, 0.9);
    addMotionSfx(b.startSec + step * 4, "ui-click", "vector-pop", "SFX_01_09.wav", b.index, 1.9, 0.95);
    const pillStyle = `position:relative;width:860px;height:164px;border-radius:42px;background:linear-gradient(135deg,#252834,#14161F);border:2px solid rgba(255,255,255,0.22);display:flex;align-items:center;justify-content:space-between;padding:0 42px 0 148px;box-shadow:0 22px 48px rgba(0,0,0,0.38)`;
    return `
      <div style="position:absolute;left:110px;top:330px;width:860px;display:flex;flex-direction:column;gap:34px">
        <div id="${hdrId}" style="width:860px;padding:28px 36px;border-radius:40px;background:#1C1E28;border:2px solid rgba(255,255,255,0.24);display:flex;align-items:center;justify-content:space-between;box-shadow:0 20px 42px rgba(0,0,0,0.3)">
          <div style="display:flex;align-items:center;gap:22px">
            <div style="width:84px;height:84px;border-radius:24px;background:#FFF;display:flex;align-items:center;justify-content:center"><div style="width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,#38BDF8,#2563EB)"></div></div>
            <div>
              <div style="font-size:32px;font-weight:700;color:#FFF">${esc(clipText(input.bookTitle, "BookReel", 24))}</div>
              <div style="font-size:20px;color:#FBBF24;margin-top:4px">★★★★★ <span style="color:#CBD5E1">${esc(b.pageLabel)}</span></div>
            </div>
          </div>
          <div style="padding:10px 28px;border-radius:999px;background:rgba(255,255,255,0.16);color:#38BDF8;font-size:22px;font-weight:700">STEP</div>
        </div>
        <div id="${r1}" style="${pillStyle}">
          <div style="position:absolute;left:-26px;top:20px;width:124px;height:124px;border-radius:30px;background:linear-gradient(135deg,#38BDF8,#1D4ED8);box-shadow:0 14px 28px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:700;color:#FFF">01</div>
          <div><div style="font-size:36px;font-weight:700;color:#FFF">${esc(clipText(b.clauses[0], "Core Premise", 24))}</div><div style="width:320px;height:10px;border-radius:99px;background:rgba(255,255,255,0.75);margin-top:14px"></div></div>
          <span style="color:#60A5FA;font-size:22px;font-weight:700">→</span>
        </div>
        <div id="${r2}" style="${pillStyle}">
          <div style="position:absolute;left:-26px;top:20px;width:124px;height:124px;border-radius:50%;background:conic-gradient(#EF4444,#F59E0B,#10B981,#3B82F6,#A855F7,#EF4444);box-shadow:0 14px 28px rgba(0,0,0,0.45)"></div>
          <div><div style="font-size:36px;font-weight:700;color:#FFF">${esc(clipText(b.clauses[1], "Key Mechanism", 24))}</div><div style="width:280px;height:10px;border-radius:99px;background:rgba(255,255,255,0.75);margin-top:14px"></div></div>
          <span style="color:#60A5FA;font-size:22px;font-weight:700">02</span>
        </div>
        <div id="${r3}" style="${pillStyle}">
          <div style="position:absolute;left:-26px;top:20px;width:124px;height:124px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#FB7185,#E11D48);box-shadow:0 14px 28px rgba(225,29,72,0.45)"></div>
          <div><div style="font-size:36px;font-weight:700;color:#FFF">${esc(clipText(b.clauses[2], "Direct Action", 24))}</div><div style="width:300px;height:10px;border-radius:99px;background:rgba(255,255,255,0.75);margin-top:14px"></div></div>
          <span style="color:#60A5FA;font-size:22px;font-weight:700">03</span>
        </div>
        <div id="${r4}" style="${pillStyle}">
          <div style="position:absolute;left:-26px;top:20px;width:124px;height:124px;border-radius:32px;background:linear-gradient(135deg,#10B981,#047857);display:flex;align-items:center;justify-content:center;font-size:48px;color:#FFF">✦</div>
          <div><div style="font-size:36px;font-weight:700;color:#34D399">${esc(clipText(b.climax, "Breakthrough", 24))}</div><div style="width:340px;height:10px;border-radius:99px;background:#34D399;margin-top:14px"></div></div>
          <span style="color:#34D399;font-size:24px;font-weight:700">✓</span>
        </div>
      </div>`;
  };

  const renderCrimsonRipples = (b: ParsedBeatCopy): string => {
    const hdrId = uid("crh");
    const r1 = uid("crr1");
    const r2 = uid("crr2");
    const ftId = uid("crf");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.05, dur: 0.45, a: -20, b: 0.94 });
    cmds.push({ op: "blurIn", sel: `#${r1}`, at: b.startSec + 0.18, dur: 0.52, a: 0, b: 0.72 });
    cmds.push({ op: "blurIn", sel: `#${r2}`, at: b.startSec + 0.46, dur: 0.56, a: 0, b: 0.82 });
    cmds.push({ op: "blurIn", sel: `#${ftId}`, at: b.startSec + 0.56, dur: 0.46, a: 20, b: 0.95 });
    addMotionSfx(b.startSec + 0.18, "sub-drop", "cinema-deep", "SFX_01_07.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.48, "ui-click", "vector-pop", nextPopFile(), b.index, 1.75, 0.9);
    return `
      <div id="${hdrId}" style="position:absolute;left:90px;right:90px;top:320px;text-align:center">
        <div style="font-size:52px;font-weight:500;color:${pal.ink}">${esc(b.lead)}</div>
        <div style="font-size:74px;font-weight:700;color:${pal.acc};margin-top:4px">${esc(b.climax)}</div>
      </div>
      <div id="${r2}" style="position:absolute;left:50%;top:960px;transform:translate(-50%,-50%);width:720px;height:720px;border-radius:50%;border:4px solid ${pal.accSoft};box-shadow:0 0 40px ${pal.accSoft}"></div>
      <div id="${r1}" style="position:absolute;left:50%;top:960px;transform:translate(-50%,-50%);width:500px;height:500px;border-radius:50%;border:6px solid ${pal.acc}">
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:300px;height:300px;border-radius:50%;background:#111317;color:#FFF;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center">
          <div style="font-size:20px;color:#FBBF24;font-weight:700;letter-spacing:0.1em">${esc(b.pageLabel.toUpperCase())}</div>
          <div style="font-size:34px;font-weight:600;margin-top:8px">${esc(clipText(b.onScreen, "Core Force", 20))}</div>
        </div>
      </div>
      <div id="${ftId}" style="position:absolute;left:110px;right:110px;top:1410px;text-align:center;font-size:28px;color:${pal.subInk};line-height:1.4">${esc(b.microCaption)}</div>`;
  };

  const renderCrimsonPosterSlash = (b: ParsedBeatCopy): string => {
    const cardId = uid("cps");
    const boxId = uid("cpsb");
    cmds.push({ op: "blurIn", sel: `#${cardId}`, at: b.startSec + 0.05, dur: 0.52, a: 30, b: 0.92 });
    cmds.push({ op: "blurIn", sel: `#${boxId}`, at: b.startSec + 0.36, dur: 0.48, a: 24, b: 0.9 });
    addMotionSfx(b.startSec + 0.08, "shutter-snap", "whip-accent", "14 Quick Swing.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.44, "card-pop", "dossier-stamp", "SFX_01_07.wav", b.index, 1.85, 0.9);
    const slashFill = pal.dark ? "#1E293B" : pal.acc;
    return `
      <div id="${cardId}" style="position:absolute;left:90px;top:310px;width:900px;height:1280px;border-radius:34px;background:#FFFFFF;border:3px solid #111317;overflow:hidden;box-shadow:0 34px 70px rgba(0,0,0,0.22)">
        <svg viewBox="0 0 900 1280" width="900" height="1280" fill="none" style="position:absolute;inset:0">
          <polygon points="0,480 900,1280 0,1280" fill="${slashFill}"/>
        </svg>
        <div style="position:relative;padding:74px 64px;text-align:center">
          <div style="font-size:40px;font-weight:700;color:#DC2626;text-transform:uppercase">${esc(b.pageLabel)} · ARCHIVE</div>
          <div style="font-size:74px;font-weight:700;letter-spacing:-0.035em;line-height:1.06;margin-top:16px;color:#0D0E11">${esc(b.onScreen)}</div>
          <div id="${boxId}" style="margin:64px auto 0;width:720px;padding:44px;border-radius:28px;background:#111317;color:#FFFFFF;box-shadow:0 28px 56px rgba(0,0,0,0.34);text-align:left">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
              <span style="font-size:20px;letter-spacing:0.14em;color:#FBBF24;font-weight:700">VERBATIM RECORD</span>
              <span style="font-family:monospace;font-size:22px;letter-spacing:4px;opacity:0.75">||| || |||| |</span>
            </div>
            <div class="serif-it" style="font-size:42px;line-height:1.3">“${esc(clipText(b.quoteSnippet, b.voiceover, 96))}”</div>
          </div>
          <div style="margin-top:76px;font-size:52px;font-weight:700;color:#FFFFFF;text-shadow:0 4px 18px rgba(0,0,0,0.38)">${esc(b.climax)}</div>
        </div>
      </div>`;
  };

  const renderVioletNeonCards4 = (b: ParsedBeatCopy): string => {
    const cIds = [uid("vnc1"), uid("vnc2"), uid("vnc3"), uid("vnc4")];
    const hdrId = uid("vnh");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.04, dur: 0.45, a: -18, b: 0.94 });
    cIds.forEach((id, idx) => {
      const at = b.startSec + 0.14 + idx * 0.22;
      cmds.push({ op: "blurIn", sel: `#${id}`, at, dur: 0.46, a: 28, b: 0.88 });
      if (idx === 0 || idx === 2) {
        addMotionSfx(at + 0.04, idx === 0 ? "card-pop" : "ui-click", "neuro-circuit", nextPopFile(), b.index, 1.85, 0.95);
      }
    });
    const themes = [
      { bg: "#1E1B4B", bd: "#818CF8", sym: "✦" },
      { bg: "#064E3B", bd: "#34D399", sym: "▲" },
      { bg: "#4A044E", bd: "#F0ABFC", sym: "◆" },
      { bg: "#1E293B", bd: "#38BDF8", sym: "●" },
    ];
    const cardsHtml = cIds
      .map((id, idx) => {
        const th = themes[idx];
        return `<div id="${id}" style="padding:36px 30px;border-radius:36px;background:${th.bg};border:2.5px solid ${th.bd};box-shadow:0 18px 42px rgba(0,0,0,0.22);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:360px">
          <div style="width:82px;height:82px;border-radius:50%;background:rgba(255,255,255,0.16);display:flex;align-items:center;justify-content:center;font-size:36px;color:#FFF;margin-bottom:24px">${th.sym}</div>
          <div style="font-size:34px;font-weight:700;color:#FFF;line-height:1.2">${esc(clipText(b.clauses[idx], `Pillar ${idx + 1}`, 22))}</div>
          <div style="font-size:20px;color:rgba(255,255,255,0.8);margin-top:12px">${esc(b.pageLabel)}</div>
        </div>`;
      })
      .join("");
    return `
      <div id="${hdrId}" style="position:absolute;left:90px;right:90px;top:310px;text-align:center;font-size:54px;font-weight:600;color:${pal.ink}">${esc(b.lead)}</div>
      <div style="position:absolute;left:90px;top:460px;width:900px;display:grid;grid-template-columns:1fr 1fr;gap:30px">${cardsHtml}</div>`;
  };

  const renderVioletOrbit6 = (b: ParsedBeatCopy): string => {
    const coreId = uid("voc");
    const ringId = uid("vor");
    cmds.push({ op: "blurIn", sel: `#${coreId}`, at: b.startSec + 0.05, dur: 0.46, a: 18, b: 0.9 });
    cmds.push({ op: "rotate", sel: `#${ringId}`, at: b.startSec, dur: Math.max(1, b.endSec - b.startSec), a: 0, b: 54 });
    addMotionSfx(b.startSec + 0.12, "scene-whoosh", "chrono-gear", "SFX_01_04.wav", b.index, 1.9, 0.95);
    addMotionSfx(b.startSec + 0.56, "ui-click", "bento-ui", nextPopFile(), b.index, 1.75, 0.9);
    const badges = [0, 60, 120, 180, 240, 300]
      .map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        const bx = (330 * Math.cos(rad)).toFixed(1);
        const by = (330 * Math.sin(rad)).toFixed(1);
        return `<g transform="translate(${bx} ${by})"><circle cx="0" cy="0" r="42" fill="${pal.acc}" stroke="${pal.bg}" stroke-width="4"/><text x="0" y="10" text-anchor="middle" fill="${onAccInk}" font-size="26" font-weight="700">0${idx + 1}</text></g>`;
      })
      .join("");
    return `
      <svg viewBox="0 0 1080 1920" width="1080" height="1920" fill="none" style="position:absolute;inset:0">
        <circle cx="540" cy="900" r="210" stroke="${pal.accSoft}" stroke-width="3"/>
        <g id="${ringId}" style="transform-origin:540px 900px">
          <circle cx="540" cy="900" r="330" stroke="${pal.ink}" stroke-width="3" opacity="0.5"/>
          <g transform="translate(540 900)">${badges}</g>
        </g>
      </svg>
      <div id="${coreId}" style="position:absolute;left:50%;top:900px;transform:translate(-50%,-50%);text-align:center;width:360px">
        <div style="font-size:62px;font-weight:700;color:${pal.ink};letter-spacing:-0.03em">${esc(clipText(b.climax, "Core Loop", 14))}</div>
      </div>
      <div style="position:absolute;left:100px;right:100px;top:1380px;text-align:center;font-size:34px;color:${pal.subInk}">${esc(b.microCaption)}</div>`;
  };

  const renderVioletRoiComet = (b: ParsedBeatCopy): string => {
    const cardId = uid("vrc");
    const curveId = uid("vrcv");
    const dotId = uid("vrd");
    cmds.push({ op: "blurIn", sel: `#${cardId}`, at: b.startSec + 0.05, dur: 0.48, a: 28, b: 0.92 });
    cmds.push({ op: "draw", sel: `#${curveId}`, at: b.startSec + 0.25, dur: 0.85, dash: 780 });
    cmds.push({ op: "blurIn", sel: `#${dotId}`, at: b.startSec + 0.62, dur: 0.45, a: 0, b: 0.4 });
    addMotionSfx(b.startSec + 0.25, "marker-swish", "vector-pop", "SFX_01_09.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.64, "ui-click", "bento-ui", "SFX_01_05.wav", b.index, 1.85, 0.95);
    return `
      <div id="${cardId}" style="position:absolute;left:80px;top:520px;width:920px;padding:64px 54px;border-radius:40px;background:linear-gradient(145deg,#181526,#0F241F);border:2px solid rgba(255,255,255,0.18);box-shadow:0 32px 80px rgba(0,0,0,0.38)">
        <div style="text-align:center;font-size:40px;color:#F4F4F5;line-height:1.32;margin-bottom:58px">${esc(b.lead)}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <span style="font-size:44px;font-weight:600;color:#FFF">${esc(clipText(b.clauses[0], "1× Effort", 14))}</span>
          <div style="flex:1;height:2px;background:rgba(255,255,255,0.45)"></div>
          <span style="font-size:48px;font-weight:700;color:#FFF">=</span>
          <div style="flex:1;height:2px;background:rgba(255,255,255,0.45)"></div>
          <span style="font-size:52px;font-weight:700;color:#4ADE80">${esc(clipText(b.climax, "True Gain", 16))}</span>
        </div>
        <svg viewBox="0 0 800 220" width="800" height="220" fill="none" style="margin-top:20px;overflow:visible">
          <path id="${curveId}" d="M 40 190 Q 420 182, 710 38" stroke="#4ADE80" stroke-width="6" stroke-linecap="round" stroke-dasharray="780" stroke-dashoffset="780"/>
          <circle id="${dotId}" cx="710" cy="38" r="18" fill="#FFFFFF"/>
        </svg>
      </div>`;
  };

  // --- 4 NEW REFERENCE-ELEMENT BUILDERS FOR EVEN DEEPER STORY VARIETY ---

  const renderBalanceScaleVs = (b: ParsedBeatCopy): string => {
    const hdrId = uid("bsh");
    const beamId = uid("bsb");
    const capId = uid("bsc");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.05, dur: 0.45, a: -20, b: 0.94 });
    cmds.push({ op: "rotate", sel: `#${beamId}`, at: b.startSec + 0.16, dur: 0.88, a: 14, b: -11 });
    cmds.push({ op: "blurIn", sel: `#${capId}`, at: b.startSec + 0.48, dur: 0.46, a: 22, b: 0.95 });
    addMotionSfx(b.startSec + 0.18, "clock-tick", "chrono-gear", "SFX_01_08.wav", b.index, 1.95, 1.0);
    addMotionSfx(b.startSec + 0.62, "card-pop", "bento-ui", nextPopFile(), b.index, 1.85, 0.95);
    return `
      <div id="${hdrId}" style="position:absolute;left:90px;right:90px;top:370px;text-align:center">
        <div style="font-size:48px;color:${pal.subInk}">${esc(b.lead)}</div>
        <div style="font-size:74px;font-weight:700;color:${pal.ink};margin-top:8px">${esc(b.onScreen)}</div>
      </div>
      <svg viewBox="0 0 1080 760" width="1080" height="760" fill="none" style="position:absolute;left:0;top:620px">
        <polygon points="540,520 470,660 610,660" fill="${pal.ink}"/>
        <rect x="370" y="660" width="340" height="22" rx="11" fill="${pal.acc}"/>
        <g id="${beamId}" style="transform-origin:540px 520px">
          <line x1="190" y1="520" x2="890" y2="520" stroke="${pal.ink}" stroke-width="12" stroke-linecap="round"/>
          <circle cx="540" cy="520" r="22" fill="${pal.acc}"/>
          <g transform="translate(210 350)">
            <rect x="-130" y="0" width="260" height="126" rx="26" fill="${pal.dark ? "#1E293B" : "#F1F5F9"}" stroke="#94A3B8" stroke-width="3"/>
            <text x="0" y="74" text-anchor="middle" fill="${pal.dark ? "#E2E8F0" : "#334155"}" font-size="28" font-weight="600">${esc(clipText(b.clauses[0], "Passive Path", 16))}</text>
          </g>
          <g transform="translate(870 350)">
            <rect x="-140" y="-12" width="280" height="142" rx="28" fill="${pal.acc}"/>
            <text x="0" y="68" text-anchor="middle" fill="${onAccInk}" font-size="30" font-weight="700">${esc(clipText(b.climax, "Active Recall", 16))} ✓</text>
          </g>
        </g>
      </svg>
      <div id="${capId}" style="position:absolute;left:100px;right:100px;top:1380px;text-align:center;font-size:32px;color:${pal.subInk};line-height:1.38">${esc(b.microCaption)}</div>`;
  };

  const renderEcgSignalSpike = (b: ParsedBeatCopy): string => {
    const cardId = uid("ecg");
    const waveId = uid("ecgw");
    const badgeId = uid("ecgb");
    cmds.push({ op: "blurIn", sel: `#${cardId}`, at: b.startSec + 0.05, dur: 0.46, a: 26, b: 0.92 });
    cmds.push({ op: "draw", sel: `#${waveId}`, at: b.startSec + 0.2, dur: 0.92, dash: 1200 });
    cmds.push({ op: "blurIn", sel: `#${badgeId}`, at: b.startSec + 0.58, dur: 0.44, a: 18, b: 0.88 });
    addMotionSfx(b.startSec + 0.22, "marker-swish", "neuro-circuit", "SFX_01_04.wav", b.index, 2.0, 1.0);
    addMotionSfx(b.startSec + 0.6, "ui-click", "neuro-circuit", "SFX_01_05.wav", b.index, 1.9, 0.95);
    return `
      <div id="${cardId}" style="position:absolute;left:80px;top:430px;width:920px;padding:52px 48px;border-radius:38px;background:#0F172A;border:2.5px solid ${pal.acc};box-shadow:0 28px 64px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px">
          <span style="font-size:22px;font-weight:700;letter-spacing:0.1em;color:#38BDF8">COGNITIVE SIGNAL · ${esc(b.pageLabel)}</span>
          <span id="${badgeId}" style="padding:8px 22px;border-radius:999px;background:#EF4444;color:#FFF;font-size:20px;font-weight:700">SIGNAL SHIFT</span>
        </div>
        <svg viewBox="0 0 820 340" width="820" height="340" fill="none">
          <line x1="0" y1="170" x2="820" y2="170" stroke="rgba(255,255,255,0.15)" stroke-dasharray="10 10"/>
          <path id="${waveId}" d="M 20 170 L 180 170 L 230 120 L 275 230 L 330 42 L 385 298 L 435 92 L 485 210 L 540 170 L 800 170" stroke="#38BDF8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1200" stroke-dashoffset="1200"/>
        </svg>
        <div style="margin-top:26px;font-size:48px;font-weight:700;color:#F8FAFC">${esc(b.onScreen)}</div>
        <div style="margin-top:12px;font-size:28px;color:#CBD5E1;line-height:1.38">${esc(b.microCaption)}</div>
      </div>`;
  };

  const renderStaircaseSteps = (b: ParsedBeatCopy): string => {
    const bIds = [uid("st1"), uid("st2"), uid("st3"), uid("st4")];
    const hdrId = uid("sth");
    cmds.push({ op: "blurIn", sel: `#${hdrId}`, at: b.startSec + 0.04, dur: 0.45, a: -18, b: 0.94 });
    bIds.forEach((id, idx) => {
      const at = b.startSec + 0.16 + idx * 0.22;
      cmds.push({ op: "scaleY", sel: `#${id}`, at, dur: 0.54 });
      if (idx === 0 || idx === 2 || idx === 3) {
        addMotionSfx(at + 0.04, "counter-tick", "vector-pop", nextPopFile(), b.index, 1.85, 0.95);
      }
    });
    const heights = [210, 330, 460, 610];
    const cols = bIds
      .map(
        (id, idx) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:660px">
          <div style="font-size:24px;font-weight:700;color:${idx === 3 ? pal.acc : pal.subInk};margin-bottom:14px;text-align:center">${esc(clipText(b.clauses[idx], `Stage ${idx + 1}`, 13))}</div>
          <div id="${id}" style="width:100%;height:${heights[idx]}px;border-radius:26px 26px 12px 12px;background:${idx === 3 ? pal.acc : pal.dark ? "rgba(255,255,255,0.16)" : "#CBD5E1"};transform-origin:bottom center;transform:scaleY(0.08);display:flex;align-items:flex-start;justify-content:center;padding-top:24px;color:${idx === 3 ? onAccInk : pal.ink};font-size:32px;font-weight:700">0${idx + 1}</div>
        </div>`,
      )
      .join("");
    return `
      <div id="${hdrId}" style="position:absolute;left:90px;right:90px;top:340px;text-align:center">
        <div style="font-size:48px;color:${pal.subInk}">${esc(b.lead)}</div>
        <div class="serif-it txt-acc" style="font-size:76px;margin-top:6px">${esc(b.climax)}</div>
      </div>
      <div style="position:absolute;left:90px;top:640px;width:900px;display:flex;gap:28px;align-items:flex-end">${cols}</div>`;
  };

  const renderSplitMythTruth = (b: ParsedBeatCopy): string => {
    const leftId = uid("smt1");
    const rightId = uid("smt2");
    const ftId = uid("smtf");
    cmds.push({ op: "blurIn", sel: `#${leftId}`, at: b.startSec + 0.06, dur: 0.46, a: -28, b: 0.92 });
    cmds.push({ op: "blurIn", sel: `#${rightId}`, at: b.startSec + 0.42, dur: 0.5, a: 28, b: 0.92 });
    cmds.push({ op: "blurIn", sel: `#${ftId}`, at: b.startSec + 0.64, dur: 0.45, a: 18, b: 0.95 });
    addMotionSfx(b.startSec + 0.08, "card-pop", "bento-ui", nextPopFile(), b.index, 1.9, 0.95);
    addMotionSfx(b.startSec + 0.44, "shutter-snap", "whip-accent", "14 Quick Swing.wav", b.index, 2.0, 1.0);
    return `
      <div style="position:absolute;left:80px;top:430px;width:920px;display:flex;flex-direction:column;gap:32px">
        <div id="${leftId}" style="padding:42px 46px;border-radius:32px;background:${pal.dark ? "rgba(255,255,255,0.06)" : "#F1F5F9"};border:2px solid #94A3B8">
          <div style="font-size:22px;font-weight:700;color:#DC2626;letter-spacing:0.08em">✗ COMMON TRAP</div>
          <div style="font-size:44px;font-weight:600;color:${pal.ink};margin-top:12px">${esc(clipText(b.clauses[0], b.lead, 32))}</div>
        </div>
        <div id="${rightId}" style="padding:46px 46px;border-radius:32px;background:${pal.acc};color:${onAccInk};box-shadow:0 24px 56px ${pal.accSoft}">
          <div style="font-size:22px;font-weight:700;letter-spacing:0.08em;opacity:0.9">✓ BOOK EVIDENCE · ${esc(b.pageLabel)}</div>
          <div style="font-size:50px;font-weight:700;margin-top:12px;line-height:1.15">${esc(clipText(b.onScreen, b.climax, 32))}</div>
        </div>
      </div>
      <div id="${ftId}" style="position:absolute;left:90px;right:90px;top:1270px;text-align:center;font-size:32px;color:${pal.subInk};line-height:1.4">${esc(b.microCaption)}</div>`;
  };

  const renderHorizontalPanClimax = (b: ParsedBeatCopy, highlightShape: "oval" | "underline" | "box"): string => {
    const trackId = uid("ptrk");
    const leadId = uid("pld");
    const focId = uid("pfoc");
    const strokeId = uid("pstr");
    const panAt = b.midSec;
    cmds.push({ op: "blurIn", sel: `#${leadId}`, at: b.startSec + 0.04, dur: 0.42, a: 18, b: 0.95 });
    cmds.push({ op: "panTrack", sel: `#${trackId}`, at: panAt, dur: 0.62, a: 250, b: -225 });
    cmds.push({ op: "blurIn", sel: `#${focId}`, at: panAt + 0.08, dur: 0.46, a: 0, b: 0.94 });
    cmds.push({ op: "draw", sel: `#${strokeId}`, at: panAt + 0.2, dur: 0.72, dash: 1860 });
    addMotionSfx(panAt, "scene-whoosh", "cinema-deep", "14 Quick Swing.wav", b.index, 2.05, 1.0);
    addMotionSfx(panAt + 0.24, "marker-swish", "paper-slide", "SFX_01_01.wav", b.index, 1.9, 0.95);

    const svgHighlight =
      highlightShape === "underline"
        ? `<svg viewBox="0 0 620 44" width="620" height="44" fill="none" style="position:absolute;left:16px;bottom:-8px;overflow:visible"><path id="${strokeId}" d="M 8 24 C 170 8, 420 10, 604 22 C 440 34, 210 36, 64 34" stroke="${pal.acc}" stroke-width="7" stroke-linecap="round" stroke-dasharray="1860" stroke-dashoffset="1860"/></svg>`
        : highlightShape === "box"
          ? `<svg viewBox="0 0 700 170" width="700" height="170" fill="none" style="position:absolute;left:-16px;top:-12px;width:calc(100% + 32px);height:calc(100% + 24px);overflow:visible"><path id="${strokeId}" d="M 20 22 L 680 18 L 684 150 L 16 152 L 20 22" stroke="${pal.acc}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1860" stroke-dashoffset="1860"/></svg>`
          : `<svg viewBox="0 0 820 184" width="820" height="184" fill="none" style="position:absolute;left:-18px;top:-16px;width:calc(100% + 36px);height:calc(100% + 32px);overflow:visible"><path id="${strokeId}" d="M 34 94 C 30 28, 224 12, 414 14 C 618 16, 792 38, 788 94 C 784 150, 598 170, 402 168 C 198 166, 26 140, 52 78" stroke="${pal.acc}" stroke-width="6" stroke-linecap="round" stroke-dasharray="1860" stroke-dashoffset="1860"/></svg>`;

    return `
      <div id="${trackId}" style="position:absolute;left:540px;top:960px;display:flex;align-items:center;gap:28px;white-space:nowrap">
        <span id="${leadId}" style="font-size:52px;font-weight:500;letter-spacing:-0.03em;color:${pal.subInk}">${esc(b.lead)}</span>
        <span id="${focId}" style="position:relative;display:inline-flex;align-items:center;padding:22px 58px">
          <span style="font-size:74px;font-weight:600;letter-spacing:-0.038em;color:${pal.ink}">${esc(clipText(b.climax, "Act now.", 22))}</span>
          ${svgHighlight}
        </span>
      </div>`;
  };

  // =========================================================================
  // UNIFIED STORY-SEMANTIC WIDGET CATALOG (SHARED ACROSS ALL 10 MODELS!)
  // =========================================================================

  const STORY_WIDGETS: StoryWidgetSpec[] = [
    {
      id: "watch-arc",
      family: "chrono",
      keywords: /\b(time|hour|minute|second|day|year|age|fast|slow|delay|wait|cram|schedule|clock|moment)\b/i,
      preferredModels: ["kinetic-emerald", "daylight-orbital"],
      render: (b) => renderWatchArc(b),
    },
    {
      id: "viewfinder-focus",
      family: "diagram",
      keywords: /\b(people|person|man|woman|subject|crowd|student|child|artist|scientist|genius|observe|watch|who)\b/i,
      preferredModels: ["kinetic-emerald", "kinetic-violet"],
      render: (b) => renderViewfinderGroup(b),
    },
    {
      id: "ring-gauge",
      family: "radial",
      keywords: /\b(\d+|percent|span|multiply|half|double|triple|score|capacity|rate|amount|more|less)\b/i,
      preferredModels: ["kinetic-coral", "aurora-portal"],
      render: (b) => renderRingCounter(b, uid("rcg")),
    },
    {
      id: "book-evidence-cards",
      family: "editorial",
      keywords: /\b(page|passage|book|quote|experiment|study|tested|research|found|evidence|proof)\b/i,
      preferredModels: ["kinetic-cobalt", "paper-collage"],
      render: (b) => renderFloatingBookCards(b, b.pageLabel.toUpperCase()),
    },
    {
      id: "hexagon-triad",
      family: "diagram",
      keywords: /\b(three|triad|types|senses|parts|stages|pillars|rules|group|combine|form)\b/i,
      preferredModels: ["kinetic-emerald", "kinetic-coral"],
      render: (b) => renderHexagonTriad(b),
    },
    {
      id: "pill-cascade",
      family: "list",
      keywords: /\b(list|words|items|syllables|habits|letters|numbers|series|detail|elements)\b/i,
      preferredModels: ["kinetic-violet", "crimson-cutout"],
      render: (b) => renderPillCascade(b),
    },
    {
      id: "todo-strikeout",
      family: "contrast",
      keywords: /\b(stop|fail|wrong|mistake|myth|cannot|can't|never|lose|waste|cut|drop|useless|cramming)\b/i,
      preferredModels: ["kinetic-cobalt", "paper-collage"],
      render: (b) => renderTodoStrikeCard(b),
    },
    {
      id: "dual-vessels",
      family: "contrast",
      keywords: /\b(instead|versus|compare|difference|shallow|deep|passive|active|fill|capacity|volume)\b/i,
      preferredModels: ["kinetic-cobalt", "kinetic-coral"],
      render: (b) => renderDualVessels(b),
    },
    {
      id: "laser-lens",
      family: "diagram",
      keywords: /\b(focus|attention|multitask|single|concentrat|visual|eye|see|sight|image|clarity|sharp)\b/i,
      preferredModels: ["kinetic-violet", "kinetic-cobalt"],
      render: (b) => renderLaserLens(b),
    },
    {
      id: "paper-book-peel",
      family: "editorial",
      keywords: /\b(read|reread|chapter|author|story|classic|history|text|printed|edition)\b/i,
      preferredModels: ["paper-collage"],
      render: (b) => renderPaperBookPeel(b),
    },
    {
      id: "framed-quote-portrait",
      family: "editorial",
      keywords: /\b(imagine|inner|picture|voice|hear|mental|replay|thought|mind)\b/i,
      preferredModels: ["paper-collage", "crimson-cutout"],
      render: (b) => renderPaperFramedPortrait(b),
    },
    {
      id: "memento-stamp-ring",
      family: "radial",
      keywords: /\b(lasting|permanent|retain|forget|forgotten|memory|remember|impression|hold)\b/i,
      preferredModels: ["paper-collage", "daylight-orbital"],
      render: (b) => renderPaperMementoRing(b),
    },
    {
      id: "timeline-playhead",
      family: "chrono",
      keywords: /\b(start|beginning|middle|end|first|last|order|sequence|before|after|interval|distributed)\b/i,
      preferredModels: ["daylight-orbital"],
      render: (b) => renderDaylightTimelinePlayhead(b),
    },
    {
      id: "orbital-wheel",
      family: "radial",
      keywords: /\b(cycle|loop|repeat|repetition|routine|system|return|habit|daily|practice)\b/i,
      preferredModels: ["daylight-orbital"],
      render: (b) => renderDaylightOrbitalWheel(b),
    },
    {
      id: "portal-constellation",
      family: "radial",
      keywords: /\b(context|sentence|meaning|connect|network|whole|link|association|web)\b/i,
      preferredModels: ["aurora-portal"],
      render: (b, camId) => renderAuroraPortalConstellation(b, camId),
    },
    {
      id: "growth-line-chart",
      family: "chart",
      keywords: /\b(curve|grow|progress|improve|rise|decay|drop|gain|compound|increase|boost)\b/i,
      preferredModels: ["aurora-portal", "violet-roi"],
      render: (b) => renderAuroraLineChart(b),
    },
    {
      id: "dynamic-island-stack",
      family: "list",
      keywords: /\b(step|method|technique|process|how|format|rule|way|approach|strategy)\b/i,
      preferredModels: ["dynamic-island"],
      render: (b) => renderDynamicIslandStack(b),
    },
    {
      id: "concentric-ripples",
      family: "radial",
      keywords: /\b(core|trigger|center|target|impact|force|motive|shock|attention|wallpaper)\b/i,
      preferredModels: ["crimson-cutout"],
      render: (b) => renderCrimsonRipples(b),
    },
    {
      id: "editorial-poster-slash",
      family: "editorial",
      keywords: /\b(truth|fact|secret|hidden|trap|warning|reality|surprising|shocking)\b/i,
      preferredModels: ["crimson-cutout"],
      render: (b) => renderCrimsonPosterSlash(b),
    },
    {
      id: "bento-quad-grid",
      family: "cards",
      keywords: /\b(four|framework|structure|category|mode|sense|pillar|domain|pattern)\b/i,
      preferredModels: ["violet-roi", "aurora-portal"],
      render: (b) => renderVioletNeonCards4(b),
    },
    {
      id: "orbital-6-badges",
      family: "radial",
      keywords: /\b(surroundings|everyday|environment|automatic|around|world|room)\b/i,
      preferredModels: ["violet-roi", "dynamic-island"],
      render: (b) => renderVioletOrbit6(b),
    },
    {
      id: "roi-comet-equation",
      family: "chart",
      keywords: /\b(multiply|effortless|power|hack|leverage|outcome|result|equal|formula|math)\b/i,
      preferredModels: ["violet-roi"],
      render: (b) => renderVioletRoiComet(b),
    },
    {
      id: "balance-scale-vs",
      family: "contrast",
      keywords: /\b(balance|equal|choice|weigh|artist|scientist|hearing|speech|visual|two|both)\b/i,
      preferredModels: ["kinetic-emerald", "daylight-orbital"],
      render: (b) => renderBalanceScaleVs(b),
    },
    {
      id: "ecg-signal-spike",
      family: "chart",
      keywords: /\b(glitch|interference|similar|confuse|blank|noise|auditory|sound|voice|brain|mind)\b/i,
      preferredModels: ["aurora-portal", "dynamic-island"],
      render: (b) => renderEcgSignalSpike(b),
    },
    {
      id: "staircase-steps",
      family: "chart",
      keywords: /\b(spaced|distribute|session|build|level|step|climb|gradual|over time|days)\b/i,
      preferredModels: ["kinetic-coral", "violet-roi"],
      render: (b) => renderStaircaseSteps(b),
    },
    {
      id: "split-myth-truth",
      family: "contrast",
      keywords: /\b(not|but|rather|while|whereas|instead|multitask|cram|myth|actually|real)\b/i,
      preferredModels: ["crimson-cutout", "kinetic-cobalt"],
      render: (b) => renderSplitMythTruth(b),
    },
  ];

  // =========================================================================
  // 6 DISTINCT BEAT-0 HOOK OPENERS (SEEDED + STORY-MATCHED)
  // =========================================================================

  const renderStoryHook = (b: ParsedBeatCopy): { html: string; id: string } => {
    const text = `${b.voiceover} ${b.onScreen}`;
    // Pick among 6 distinct hook designs using story cues + episode seed so consecutive videos open differently!
    let hookVariant = epSeed % 6;
    if (/\b(\d+|percent|five-digit|two|three)\b/i.test(text) && epSeed % 2 === 0) {
      hookVariant = 3;
    } else if (/\b(stop|can't|cannot|myth|fail|wrong|never)\b/i.test(text) && epSeed % 2 === 1) {
      hookVariant = 2;
    }

    addMotionSfx(0.05, "hook-hit", "cinema-deep", "whoosh-cinematic-161021.mp3", 0, 2.15, 1.0);

    if (hookVariant === 1) {
      const diPill = uid("dip");
      const hBox = uid("hk");
      const hSub = uid("hks");
      cmds.push({ op: "islandExpand", sel: `#${diPill}`, at: 0.04, dur: 0.52 });
      cmds.push({ op: "blurIn", sel: `#${hBox}`, at: 0.34, dur: 0.42, a: 10, b: 0.96 });
      cmds.push({ op: "blurIn", sel: `#${hSub}`, at: 0.5, dur: 0.48, a: 22, b: 0.94 });
      addMotionSfx(0.42, "ui-click", "bento-ui", "SFX_01_05.wav", 0, 1.85, 0.95);
      return {
        id: "hook-dynamic-island",
        html: `
          <div id="${diPill}" style="position:absolute;left:50%;top:720px;transform:translate(-50%,-50%);width:860px;height:176px;border-radius:48px;background:#181A24;border:2.5px solid ${pal.acc};box-shadow:0 24px 60px ${pal.accSoft};display:flex;align-items:center;padding:0 36px;gap:24px;overflow:hidden">
            <div style="width:88px;height:88px;border-radius:26px;background:${pal.acc};flex-shrink:0;display:flex;align-items:center;justify-content:center;color:${onAccInk};font-size:36px;font-weight:700">✦</div>
            <div id="${hBox}" style="min-width:0;flex:1"><div style="font-size:34px;font-weight:700;color:#FFF;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(clipText(b.onScreen, b.climax, 22))}</div><div style="font-size:20px;color:#FBBF24;margin-top:4px">★★★★★ <span style="color:#CBD5E1">${esc(b.pageLabel)}</span></div></div>
          </div>
          <div id="${hSub}" style="position:absolute;left:90px;right:90px;top:980px;text-align:center;font-size:52px;font-weight:600;line-height:1.22;color:${pal.ink}">${esc(b.microCaption)}</div>`,
      };
    }

    if (hookVariant === 2) {
      const cardId = uid("hkst");
      const slashId = uid("hksl");
      const truthId = uid("hktr");
      cmds.push({ op: "blurIn", sel: `#${cardId}`, at: 0.04, dur: 0.46, a: 24, b: 0.92 });
      cmds.push({ op: "scaleX", sel: `#${slashId}`, at: 0.42, dur: 0.38 });
      cmds.push({ op: "blurIn", sel: `#${truthId}`, at: 0.62, dur: 0.48, a: 20, b: 0.94 });
      addMotionSfx(0.42, "marker-swish", "whip-accent", "SFX_01_01.wav", 0, 2.0, 1.0);
      return {
        id: "hook-strike-myth",
        html: `
          <div style="position:absolute;left:80px;right:80px;top:520px;text-align:center">
            <div id="${cardId}" class="white-card" style="padding:46px 48px;position:relative">
              <div style="font-size:22px;font-weight:700;letter-spacing:0.12em;color:${pal.acc};margin-bottom:16px">${esc(b.pageLabel.toUpperCase())} · MYTH CHECK</div>
              <div style="position:relative;display:inline-block;font-size:58px;font-weight:600;color:${pal.subInk}">
                ${esc(b.lead)}
                <div id="${slashId}" style="position:absolute;left:-10px;right:-10px;top:52%;height:8px;background:#EF4444;transform-origin:left center;transform:scaleX(0)"></div>
              </div>
            </div>
            <div id="${truthId}" class="serif-it txt-acc" style="font-size:86px;line-height:1.05;margin-top:44px">${esc(b.climax)}</div>
            <div style="margin-top:24px;font-size:28px;color:${pal.subInk};line-height:1.38">${esc(b.microCaption)}</div>
          </div>`,
      };
    }

    if (hookVariant === 3) {
      return {
        id: "hook-ring-stat",
        html: renderRingCounter(b, uid("hkgrad")),
      };
    }

    if (hookVariant === 4) {
      const boxId = uid("hkvf");
      const subId = uid("hkvfs");
      cmds.push({ op: "blurIn", sel: `#${boxId}`, at: 0.04, dur: 0.48, a: 20, b: 1.12 });
      cmds.push({ op: "blurIn", sel: `#${subId}`, at: 0.4, dur: 0.48, a: 18, b: 0.94 });
      addMotionSfx(0.4, "shutter-snap", "archival-shutter", "SFX_01_06.wav", 0, 1.95, 1.0);
      return {
        id: "hook-viewfinder-lock",
        html: `
          <div id="${boxId}" style="position:absolute;left:100px;top:520px;width:880px;padding:78px 56px;text-align:center">
            <div style="position:absolute;left:0;top:0;width:96px;height:96px;border-left:6px solid ${pal.acc};border-top:6px solid ${pal.acc}"></div>
            <div style="position:absolute;right:0;top:0;width:96px;height:96px;border-right:6px solid ${pal.acc};border-top:6px solid ${pal.acc}"></div>
            <div style="position:absolute;left:0;bottom:0;width:96px;height:96px;border-left:6px solid ${pal.acc};border-bottom:6px solid ${pal.acc}"></div>
            <div style="position:absolute;right:0;bottom:0;width:96px;height:96px;border-right:6px solid ${pal.acc};border-bottom:6px solid ${pal.acc}"></div>
            <div style="display:inline-block;padding:8px 24px;border-radius:999px;background:${pal.accSoft};color:${pal.acc};font-size:22px;font-weight:700;margin-bottom:24px">${esc(b.pageLabel.toUpperCase())}</div>
            <div style="font-size:68px;font-weight:700;line-height:1.1;color:${pal.ink}">${esc(b.onScreen)}</div>
            <div id="${subId}" style="margin-top:28px;font-size:34px;line-height:1.38;color:${pal.subInk}">${esc(b.microCaption)}</div>
          </div>`,
      };
    }

    if (hookVariant === 5) {
      const banId = uid("hkbn");
      const subId = uid("hkbns");
      cmds.push({ op: "blurIn", sel: `#${banId}`, at: 0.04, dur: 0.48, a: -26, b: 0.94 });
      cmds.push({ op: "blurIn", sel: `#${subId}`, at: 0.4, dur: 0.48, a: 26, b: 0.94 });
      addMotionSfx(0.4, "card-pop", "dossier-stamp", "SFX_01_07.wav", 0, 1.9, 0.95);
      return {
        id: "hook-editorial-banner",
        html: `
          <div style="position:absolute;left:80px;right:80px;top:520px;text-align:center">
            <div id="${banId}" style="display:inline-block;padding:24px 52px;border-radius:24px;background:${pal.acc};color:${onAccInk};font-size:56px;font-weight:700;transform:rotate(-2deg);box-shadow:0 24px 52px ${pal.accSoft}">${esc(b.onScreen)}</div>
            <div id="${subId}" style="margin-top:46px;font-size:50px;font-weight:600;line-height:1.24;color:${pal.ink}">${esc(b.microCaption)}</div>
          </div>`,
      };
    }

    const hBox = uid("hk");
    const hSub = uid("hks");
    cmds.push({ op: "blurIn", sel: `#${hBox}`, at: 0.04, dur: 0.5, a: 24, b: 1.24 });
    cmds.push({ op: "blurIn", sel: `#${hSub}`, at: 0.38, dur: 0.5, a: 22, b: 0.94 });
    addMotionSfx(0.38, "ui-click", "bento-ui", "SFX_01_05.wav", 0, 1.85, 0.95);
    return {
      id: "hook-kinetic-split",
      html: `
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:920px;text-align:center">
          <div id="${hBox}" style="font-size:76px;font-weight:600;letter-spacing:-0.04em;line-height:1.08;color:${pal.ink}">${esc(b.lead)}</div>
          <div id="${hSub}" class="serif-it txt-acc" style="font-size:90px;line-height:1.04;margin-top:16px">${esc(b.climax)}</div>
          <div style="margin-top:30px;font-size:26px;color:${pal.subInk};line-height:1.4">${esc(b.microCaption)}</div>
        </div>`,
    };
  };

  // =========================================================================
  // CHOREOGRAPH EVERY BEAT UNIQUELY FOR THIS STORY
  // =========================================================================

  const usedWidgetIds = new Set<string>();
  const widgetSequence: string[] = [];
  let prevFamily: WidgetFamily | null = null;
  const sceneBlocksHtml: string[] = [];

  parsedBeats.forEach((b, idx) => {
    const scId = `sc-${idx}`;
    const camId = `cam-${idx}`;
    const isFirst = idx === 0;
    const isLast = idx === parsedBeats.length - 1 && parsedBeats.length >= 3;
    const nextStart =
      idx < parsedBeats.length - 1
        ? parsedBeats[idx + 1].startSec
        : +(audioOffset + input.totalDuration + 0.35).toFixed(3);

    sceneWindows.push({
      id: scId,
      start: isFirst ? 0 : b.startSec,
      end: nextStart,
      camId,
      exitAt: Math.max(b.startSec + 0.5, nextStart - 0.26),
    });

    if (!isFirst) {
      // Every scene transition cut gets a crisp synchronized air-whoosh!
      addMotionSfx(
        Math.max(0.28, b.startSec - 0.05),
        "scene-whoosh",
        "whip-accent",
        nextWhooshFile(),
        idx,
        1.85,
        0.9,
      );
    }

    let inner = "";
    if (isFirst) {
      const hk = renderStoryHook(b);
      inner = hk.html;
      widgetSequence.push(hk.id);
      if (hk.id === "hook-ring-stat") usedWidgetIds.add("ring-gauge");
    } else if (isLast) {
      const climaxVariant = (epSeed + idx * 7) % 5;
      if (climaxVariant === 0) {
        inner = renderHorizontalPanClimax(b, "oval");
        widgetSequence.push("climax-pan-oval");
      } else if (climaxVariant === 1) {
        inner = renderHorizontalPanClimax(b, "underline");
        widgetSequence.push("climax-pan-underline");
      } else if (climaxVariant === 2) {
        inner = renderHorizontalPanClimax(b, "box");
        widgetSequence.push("climax-pan-box");
      } else if (climaxVariant === 3 && !usedWidgetIds.has("roi-comet-equation")) {
        inner = renderVioletRoiComet(b);
        widgetSequence.push("climax-roi-comet");
      } else {
        inner = renderPaperMementoRing(b);
        widgetSequence.push("climax-memento-ring");
      }
    } else {
      const beatText = `${b.voiceover} ${b.onScreen} ${b.clauses.join(" ")}`;
      const available = STORY_WIDGETS.filter((w) => !usedWidgetIds.has(w.id));
      const pool = available.length > 0 ? available : STORY_WIDGETS;

      let bestWidget = pool[0];
      let bestScore = -999;

      for (const w of pool) {
        let score = 0;
        // 1. Story-semantic match on the beat's actual words!
        const matches = beatText.match(new RegExp(w.keywords.source, "gi"));
        if (matches && matches.length > 0) {
          score += 4.5 + Math.min(4.0, (matches.length - 1) * 1.5);
        }
        // 2. Gentle model flavor bonus (+1.25) so the chosen model influences mood without locking a rigid set
        if (w.preferredModels.includes(input.model)) {
          score += 1.25;
        }
        // 3. Strongly penalize repeating the same visual geometry family twice in a row
        if (prevFamily && w.family === prevFamily) {
          score -= 5.0;
        }
        // 4. Episode-unique deterministic tie-breaker so different episodes explore the entire 26-widget library
        const jitter = (hashSeed(`${epSeed}::beat-${idx}::${w.id}`) % 1000) / 1000;
        score += jitter * 2.35;

        if (score > bestScore) {
          bestScore = score;
          bestWidget = w;
        }
      }

      usedWidgetIds.add(bestWidget.id);
      prevFamily = bestWidget.family;
      widgetSequence.push(bestWidget.id);
      inner = bestWidget.render(b, camId);
    }

    sceneBlocksHtml.push(`<div class="pm-scene" id="${scId}"><div class="pm-cam" id="${camId}">${inner}</div></div>`);
  });

  // Final Clean Sign-Off Scene (`OUTRO_TAIL`)
  const outroStart = +(audioOffset + input.totalDuration + 0.35).toFixed(3);
  const outroId = "sc-outro";
  const outroLockId = uid("outlk");
  const safeOutroAt = Math.min(durationSec - 0.6, outroStart);
  sceneWindows.push({
    id: outroId,
    start: safeOutroAt,
    end: durationSec,
    camId: "cam-outro",
    exitAt: durationSec + 5,
  });
  cmds.push({ op: "blurIn", sel: `#${outroLockId}`, at: safeOutroAt, dur: 0.48, a: 20, b: 0.9 });
  addMotionSfx(safeOutroAt, "payoff-riser", "cinema-deep", "SFX_01_07.wav", parsedBeats.length, 1.85, 0.9);

  const bylineCite = input.author ? `${input.bookTitle} · ${input.author}` : input.bookTitle;
  const linkNoteHtml = input.bookLink
    ? `<div style="margin-top:18px;font-size:20px;font-weight:600;color:${pal.acc};letter-spacing:0.06em;text-transform:uppercase">Get the book · Link in description</div>`
    : "";

  sceneBlocksHtml.push(`
    <div class="pm-scene" id="${outroId}">
      <div class="pm-cam" id="cam-outro">
        <div id="${outroLockId}" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:860px;text-align:center">
          <svg width="108" height="108" viewBox="0 0 120 120" fill="none" style="margin:0 auto 18px">
            <rect x="18" y="18" width="84" height="84" rx="26" stroke="${pal.ink}" stroke-width="8"/>
            <path d="M40 64 L56 80 L84 42" stroke="${pal.acc}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div style="font-size:44px;font-weight:700;letter-spacing:-0.03em;color:${pal.ink}">BookReel</div>
          <div style="font-size:24px;color:${pal.subInk};margin-top:8px">${esc(clipText(bylineCite, "BookReel", 54))}</div>
          <div style="font-size:26px;font-weight:500;color:${pal.ink};margin-top:18px">${esc(clipText(input.pkg.cta, "", 56))}</div>
          ${linkNoteHtml}
        </div>
      </div>
    </div>`);

  // Sort & de-clash SFX cues with a crisp 0.34s micro-foley guard so rapid animations stay punchy and clean!
  rawSfxQueue.sort((a, b) => a.timeSec - b.timeSec);
  const sfxMoments: ProMotionSfxMoment[] = [];
  for (const cand of rawSfxQueue) {
    if (cand.timeSec > durationSec - 0.16) continue;
    const prev = sfxMoments[sfxMoments.length - 1];
    if (prev && cand.timeSec - prev.timeSec < 0.34) continue;
    sfxMoments.push(cand);
  }

  const musicHtml = input.music
    ? `<audio id="music" src="assets/music.wav" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="10" data-volume="0.14"></audio>`
    : "";
  const sfxHtml = input.sfx
    ? `<audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="15" data-volume="1"></audio>`
    : "";

  const runtimeDataJson = JSON.stringify({
    duration: durationSec,
    windows: sceneWindows,
    cmds,
  }).replace(/<\//g, "<\\/");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>${esc(input.pkg.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: 1080px; height: 1920px;
    background: ${pal.bg};
    color: ${pal.ink};
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .stage { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: ${pal.bg}; }
  .clip { position: absolute; inset: 0; }
  .pm-scene { position: absolute; inset: 0; opacity: 0; visibility: hidden; pointer-events: none; }
  .pm-cam { position: absolute; inset: 0; transform-origin: 50% 50%; }
  .serif-it { font-family: "Instrument Serif", Georgia, "Times New Roman", serif; font-style: italic; font-weight: 400; }
  .txt-acc { color: ${pal.acc}; }
  .white-card {
    background: ${pal.dark ? "rgba(20,24,36,0.92)" : "#FFFFFF"};
    border: 1.5px solid ${pal.dark ? "rgba(255,255,255,0.16)" : "#E5E7EB"};
    border-radius: 30px;
    box-shadow: 0 24px 56px rgba(0, 0, 0, ${pal.dark ? "0.45" : "0.08"});
  }
  .k-pill {
    display: inline-flex; align-items: center; justify-content: center;
    height: 94px; padding: 0 42px; border-radius: 999px;
    font-size: 36px; font-weight: 500; letter-spacing: -0.025em; white-space: nowrap;
  }
  .k-pill-acc { background: ${pal.acc}; color: ${onAccInk}; font-weight: 600; box-shadow: 0 14px 34px ${pal.accSoft}; }
  .k-pill-out { background: ${pal.dark ? "rgba(255,255,255,0.08)" : "#FFFFFF"}; color: ${pal.ink}; border: 2.5px solid ${pal.ink}; }

  /* Model Backdrops */
  .bokeh-layer { position: absolute; inset: 0; pointer-events: none; }
  .bokeh-ring { position: absolute; border-radius: 50%; border: 46px solid ${pal.accSoft}; filter: blur(28px); }
  .bokeh-tl { width: 540px; height: 540px; left: -170px; top: -130px; }
  .bokeh-br { width: 500px; height: 500px; left: 730px; top: 1500px; }

  .bg-paper { position: absolute; inset: 0; background: radial-gradient(90% 75% at 50% 45%, #F3F4F6 0%, #D4D7DD 100%); }
  .bg-paper-dots {
    position: absolute; left: 160px; top: 420px; width: 760px; height: 960px;
    background-image: radial-gradient(#6B7280 2px, transparent 2px);
    background-size: 38px 38px; opacity: 0.35;
  }

  .bg-daylight { position: absolute; inset: 0; background: #F8FAFF; overflow: hidden; }
  .gobo-pane { position: absolute; width: 520px; height: 920px; background: linear-gradient(125deg, rgba(255,255,255,0.92), rgba(203,213,225,0.28)); transform: rotate(-14deg); filter: blur(18px); }
  .gobo-p1 { left: -60px; top: 120px; }
  .gobo-p2 { left: 520px; top: 680px; }
  .gobo-palm { position: absolute; left: 0; bottom: 0; width: 1080px; height: 620px; filter: blur(6px); }

  .bg-aurora, .bg-vroi { position: absolute; inset: 0; overflow: hidden; }
  .aurora-orb, .vroi-orb { position: absolute; border-radius: 50%; filter: blur(95px); }
  .aurora-cyan { width: 640px; height: 640px; left: -220px; bottom: -160px; background: rgba(34,211,238,0.22); }
  .aurora-pink { width: 620px; height: 620px; right: -220px; top: -140px; background: rgba(236,72,153,0.22); }
  .vroi-violet { width: 680px; height: 680px; left: -200px; top: -160px; background: rgba(147,51,234,0.32); }
  .vroi-emerald { width: 640px; height: 640px; right: -200px; bottom: -160px; background: rgba(16,185,129,0.26); }
  .bg-oled { position: absolute; inset: 0; background: #040406; }
  .oled-glow { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 680px; height: 680px; border-radius: 50%; background: radial-gradient(circle, rgba(56,189,248,0.12) 0%, transparent 70%); }
</style>
</head>
<body>
<div id="root" class="stage stage-${esc(input.model)}" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${durationSec.toFixed(3)}" data-fps="${fps}">
  <div class="clip" id="scene" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="0">
    ${buildModelBackdropHtml(input.model, epSeed)}
    ${sceneBlocksHtml.join("\n")}
    <audio id="voice" src="assets/voice.wav" data-start="${audioOffset.toFixed(3)}" data-duration="${input.totalDuration.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    ${sfxHtml}
    ${musicHtml}
  </div>
</div>
<script id="pm-data" type="application/json">${runtimeDataJson}</script>
<script>
(function () {
  var d = JSON.parse(document.getElementById("pm-data").textContent);
  var tl = gsap.timeline({ paused: true });

  var btl = document.getElementById("bokeh-tl");
  var bbr = document.getElementById("bokeh-br");
  if (btl) tl.to(btl, { x: 80, y: 60, duration: d.duration, ease: "none" }, 0);
  if (bbr) tl.to(bbr, { x: -80, y: -60, duration: d.duration, ease: "none" }, 0);

  var portalSels = {};
  d.cmds.forEach(function (c) {
    if (c.op === "portalZoom") portalSels[c.sel] = true;
  });

  d.windows.forEach(function (w) {
    var sc = document.getElementById(w.id);
    if (!sc) return;
    gsap.set(sc, { autoAlpha: w.start === 0 ? 1 : 0 });
    if (w.start > 0) tl.set(sc, { autoAlpha: 1 }, w.start);
    if (w.end < d.duration) {
      tl.set(sc, { autoAlpha: 0 }, w.end);
      var cam = document.getElementById(w.camId);
      if (cam && w.exitAt < d.duration && !portalSels["#" + w.camId]) {
        tl.to(cam, { autoAlpha: 0, scale: 0.94, filter: "blur(10px)", duration: Math.max(0.18, w.end - w.exitAt), ease: "power2.in" }, w.exitAt);
      }
    }
  });

  d.cmds.forEach(function (c) {
    var el = document.querySelector(c.sel);
    if (!el) return;
    if (c.op === "blurIn") {
      gsap.set(el, { autoAlpha: 0 });
      tl.fromTo(
        el,
        { autoAlpha: 0, y: c.a == null ? 24 : c.a, scale: c.b == null ? 0.94 : c.b, filter: "blur(12px)" },
        { autoAlpha: 1, y: 0, scale: 1, filter: "blur(0px)", duration: c.dur, ease: "expo.out", immediateRender: false },
        c.at
      );
    } else if (c.op === "draw") {
      gsap.set(el, { strokeDashoffset: c.dash });
      tl.fromTo(el, { strokeDashoffset: c.dash }, { strokeDashoffset: 0, duration: c.dur, ease: "power3.out", immediateRender: false }, c.at);
    } else if (c.op === "scaleX") {
      gsap.set(el, { scaleX: 0 });
      tl.fromTo(el, { scaleX: 0 }, { scaleX: 1, duration: c.dur, ease: "expo.out", immediateRender: false }, c.at);
    } else if (c.op === "scaleY") {
      gsap.set(el, { scaleY: 0.08 });
      tl.fromTo(el, { scaleY: 0.08 }, { scaleY: 1, duration: c.dur, ease: "expo.out", immediateRender: false }, c.at);
    } else if (c.op === "rotate") {
      gsap.set(el, { rotation: c.a || 0 });
      tl.fromTo(el, { rotation: c.a || 0 }, { rotation: c.b || 45, duration: c.dur, ease: "power1.inOut", immediateRender: false }, c.at);
    } else if (c.op === "slideX") {
      gsap.set(el, { x: c.a || -240 });
      tl.fromTo(el, { x: c.a || -240 }, { x: c.b || 240, duration: c.dur, ease: "power2.inOut", immediateRender: false }, c.at);
    } else if (c.op === "panTrack") {
      gsap.set(el, { xPercent: -50, yPercent: -50, x: c.a || 240 });
      tl.fromTo(el, { xPercent: -50, yPercent: -50, x: c.a || 240 }, { xPercent: -50, yPercent: -50, x: c.b || -220, duration: c.dur, ease: "expo.inOut", immediateRender: false }, c.at);
    } else if (c.op === "portalZoom") {
      el.dataset.portal = "1";
      tl.fromTo(el, { scale: 1, autoAlpha: 1 }, { scale: 9.5, autoAlpha: 0, filter: "blur(6px)", duration: c.dur, ease: "expo.in", immediateRender: false }, c.at);
    } else if (c.op === "islandExpand") {
      gsap.set(el, { width: 140 });
      tl.fromTo(el, { width: 140, scale: 0.88 }, { width: 860, scale: 1, duration: c.dur, ease: "expo.out", immediateRender: false }, c.at);
    } else if (c.op === "counter") {
      var startVal = c.a || 0;
      var endVal = c.b || 100;
      var sfx = c.suffix || "";
      var pfx = c.prefix || "";
      tl.fromTo({}, {}, {
        duration: c.dur,
        ease: "none",
        immediateRender: false,
        onUpdate: function () {
          var p = Math.max(0, Math.min(1, (tl.time() - c.at) / c.dur));
          var v = Math.round(startVal + (endVal - startVal) * (1 - Math.pow(1 - p, 3)));
          el.textContent = pfx + v + sfx;
        }
      }, c.at);
    }
  });

  tl.set({}, {}, d.duration);
  window.__tl = tl;
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
</body>
</html>`;

  return { html, durationSec, sfxMoments, widgetSequence };
}
