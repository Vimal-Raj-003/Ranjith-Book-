/**
 * V3 Pro Studio Kinetic 100-Frame Engine (`kinetic-100-engine.ts`).
 *
 * Implements the 3 User-Approved Visual Reference Systems (zero rainbow stripes,
 * zero tacky floating 3D balls, zero slow blur-orb rasterization):
 *   - Style System 1 ("dark-pro-glass"): Dark Pro Studio (`ref-1-glass` / `ultra-pro-1` / `magnates`)
 *     with single-hue soft radial spotlight (Sapphire / Cyber Emerald / Cinema Amber) +
 *     sleek translucent dark Glass UI cards (`1px` glowing rim, telemetry headers, VS cards, step stacks).
 *   - Style System 2 ("scene-mix-master"): Scene-by-Scene 7-in-1 Master Mix (`ultra-master-7-in-1`)
 *     rotating cleanly per beat across Dark Sapphire Glass, Verified Archival Book Passage
 *     Marker Highlight, Warm Vox Editorial Paper (`#F4EDE4` + hard-shadow cards), and Emerald/Amber Glass.
 *   - Style System 3 ("clean-v1-studio"): Clean V1 Studio (`80%` approved base upgraded cleanly)
 *     with crisp white architectural grid, subtle soft corner aura, clean frosted white glass cards,
 *     and high-contrast deep-navy feature cards.
 *
 * Retains 100% of:
 *   - Phrase-level micro-shots (2.0s–3.2s)
 *   - Word-by-word live Type-In + Keyword Pill Sweep + Fast GSAP Whisk-Out
 *   - 100+ unique living motion-graphic frame pool (14 archetypes × 8 variants = 112 frames)
 *   - 4-Layer Studio Engagement SFX
 */
import type { ContentPackage } from "../content/schema";
import type { LoadedSfxSample, SfxRole } from "../media/sfx-library";
import { SAMPLE_RATE } from "../media/music-synth";
import type { SfxKind, SpeechSpan } from "../media/sfx-synth";
import type { TimedWord } from "../media/word-timing";

export type KineticPaletteId =
  | "dark-pro-glass"
  | "scene-mix-master"
  | "clean-v1-studio"
  | "emerald-amber-pro"
  | "editorial-studio-mix"
  // Legacy aliases mapped cleanly
  | "prism-aurora-glass"
  | "sunset-holographic"
  | "cyber-emerald-glass"
  | "royal-velvet-cosmos"
  | "daylight-prism-studio"
  | "studio-cobalt"
  | "obsidian-cyan"
  | "ivory-coral"
  | "daylight-emerald"
  | "midnight-amber";

export type ShotEnvironmentId =
  | "sapphire-glass"
  | "emerald-glass"
  | "amber-spotlight"
  | "vox-warm-paper"
  | "archival-book-dark"
  | "clean-studio-ice"
  | "clean-studio-navy"
  | "clean-studio-indigo";

interface ShotEnvironmentSpec {
  id: ShotEnvironmentId;
  bgCss: string;
  darkGrid: boolean;
  kickerBg: string;
  kickerBorder: string;
  kickerInk: string;
  dotColor: string;
  captionInk: string;
  kwBg: string;
  kwInk: string;
  cardStyle: "dark-glass" | "vox-brutal" | "clean-frosted" | "navy-contrast";
  cardBg: string;
  cardBorder: string;
  cardShadow: string;
  gfxInk: string;
  gfxSub: string;
  gfxAcc: string;
  gfxAcc2: string;
  gfxOnAcc: string;
  gfxMutedBg: string;
}

const ENVS: Record<ShotEnvironmentId, ShotEnvironmentSpec> = {
  "sapphire-glass": {
    id: "sapphire-glass",
    bgCss:
      "radial-gradient(circle at 50% 40%, rgba(37, 99, 235, 0.34) 0%, rgba(14, 26, 64, 0.20) 40%, #050914 78%)",
    darkGrid: true,
    kickerBg: "rgba(15, 25, 50, 0.82)",
    kickerBorder: "rgba(96, 165, 250, 0.38)",
    kickerInk: "#E2E8F0",
    dotColor: "#38BDF8",
    captionInk: "#F8FAFC",
    kwBg: "#38BDF8",
    kwInk: "#041024",
    cardStyle: "dark-glass",
    cardBg: "linear-gradient(180deg, rgba(18, 30, 62, 0.78) 0%, rgba(8, 14, 32, 0.90) 100%)",
    cardBorder: "rgba(96, 165, 250, 0.38)",
    cardShadow: "0 28px 68px rgba(0, 0, 0, 0.60), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
    gfxInk: "#F8FAFC",
    gfxSub: "#94A3B8",
    gfxAcc: "#38BDF8",
    gfxAcc2: "#60A5FA",
    gfxOnAcc: "#041024",
    gfxMutedBg: "rgba(255, 255, 255, 0.05)",
  },
  "emerald-glass": {
    id: "emerald-glass",
    bgCss:
      "radial-gradient(circle at 50% 42%, rgba(16, 185, 129, 0.30) 0%, rgba(6, 78, 59, 0.18) 42%, #040D0B 78%)",
    darkGrid: true,
    kickerBg: "rgba(8, 32, 26, 0.82)",
    kickerBorder: "rgba(52, 211, 153, 0.38)",
    kickerInk: "#D1FAE5",
    dotColor: "#34D399",
    captionInk: "#F8FAFC",
    kwBg: "#34D399",
    kwInk: "#031C14",
    cardStyle: "dark-glass",
    cardBg: "linear-gradient(180deg, rgba(12, 36, 30, 0.78) 0%, rgba(5, 18, 15, 0.90) 100%)",
    cardBorder: "rgba(52, 211, 153, 0.40)",
    cardShadow: "0 28px 68px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.16)",
    gfxInk: "#F0FDF4",
    gfxSub: "#94A3B8",
    gfxAcc: "#34D399",
    gfxAcc2: "#2DD4BF",
    gfxOnAcc: "#031C14",
    gfxMutedBg: "rgba(255, 255, 255, 0.05)",
  },
  "amber-spotlight": {
    id: "amber-spotlight",
    bgCss:
      "radial-gradient(ellipse 68% 56% at 50% 8%, rgba(234, 88, 12, 0.36) 0%, rgba(154, 52, 18, 0.16) 48%, #0D0704 82%)",
    darkGrid: true,
    kickerBg: "rgba(40, 18, 8, 0.84)",
    kickerBorder: "rgba(251, 146, 60, 0.42)",
    kickerInk: "#FFEDD5",
    dotColor: "#FBBF24",
    captionInk: "#FFF7ED",
    kwBg: "#FBBF24",
    kwInk: "#1C0A02",
    cardStyle: "dark-glass",
    cardBg: "linear-gradient(180deg, rgba(36, 18, 10, 0.80) 0%, rgba(16, 8, 4, 0.92) 100%)",
    cardBorder: "rgba(251, 146, 60, 0.40)",
    cardShadow: "0 28px 68px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.16)",
    gfxInk: "#FFF7ED",
    gfxSub: "#D6D3D1",
    gfxAcc: "#FBBF24",
    gfxAcc2: "#FB923C",
    gfxOnAcc: "#1C0A02",
    gfxMutedBg: "rgba(255, 255, 255, 0.05)",
  },
  "vox-warm-paper": {
    id: "vox-warm-paper",
    bgCss:
      "radial-gradient(circle at 50% 44%, rgba(217, 119, 87, 0.25) 0%, #F4EDE4 74%)",
    darkGrid: false,
    kickerBg: "#18181B",
    kickerBorder: "#18181B",
    kickerInk: "#FAFAFA",
    dotColor: "#DC2626",
    captionInk: "#18181B",
    kwBg: "#DC2626",
    kwInk: "#FFFFFF",
    cardStyle: "vox-brutal",
    cardBg: "#FFFDF9",
    cardBorder: "#18181B",
    cardShadow: "10px 10px 0px #18181B",
    gfxInk: "#18181B",
    gfxSub: "#57534E",
    gfxAcc: "#DC2626",
    gfxAcc2: "#D97706",
    gfxOnAcc: "#FFFFFF",
    gfxMutedBg: "rgba(24, 24, 27, 0.05)",
  },
  "archival-book-dark": {
    id: "archival-book-dark",
    bgCss:
      "radial-gradient(circle at 50% 38%, rgba(56, 189, 248, 0.18) 0%, #070C18 76%)",
    darkGrid: true,
    kickerBg: "rgba(15, 25, 50, 0.86)",
    kickerBorder: "rgba(250, 204, 21, 0.45)",
    kickerInk: "#FEF08A",
    dotColor: "#FACC15",
    captionInk: "#FFFFFF",
    kwBg: "#FACC15",
    kwInk: "#111827",
    cardStyle: "dark-glass",
    cardBg: "linear-gradient(180deg, rgba(16, 26, 52, 0.82) 0%, rgba(8, 14, 28, 0.92) 100%)",
    cardBorder: "rgba(56, 189, 248, 0.36)",
    cardShadow: "0 28px 68px rgba(0, 0, 0, 0.65)",
    gfxInk: "#F8FAFC",
    gfxSub: "#94A3B8",
    gfxAcc: "#FACC15",
    gfxAcc2: "#38BDF8",
    gfxOnAcc: "#111827",
    gfxMutedBg: "rgba(255, 255, 255, 0.05)",
  },
  "clean-studio-ice": {
    id: "clean-studio-ice",
    bgCss:
      "radial-gradient(circle at 18% 20%, rgba(59, 130, 246, 0.20) 0%, transparent 48%), " +
      "radial-gradient(circle at 84% 78%, rgba(99, 102, 241, 0.16) 0%, transparent 48%), #FFFFFF",
    darkGrid: false,
    kickerBg: "rgba(255, 255, 255, 0.92)",
    kickerBorder: "rgba(37, 99, 235, 0.22)",
    kickerInk: "#0F172A",
    dotColor: "#2563EB",
    captionInk: "#0F172A",
    kwBg: "#2563EB",
    kwInk: "#FFFFFF",
    cardStyle: "clean-frosted",
    cardBg: "rgba(255, 255, 255, 0.90)",
    cardBorder: "rgba(37, 99, 235, 0.24)",
    cardShadow: "0 24px 56px rgba(37, 99, 235, 0.12), inset 0 1px 0 #FFFFFF",
    gfxInk: "#0F172A",
    gfxSub: "#64748B",
    gfxAcc: "#2563EB",
    gfxAcc2: "#4F46E5",
    gfxOnAcc: "#FFFFFF",
    gfxMutedBg: "rgba(15, 23, 42, 0.05)",
  },
  "clean-studio-navy": {
    id: "clean-studio-navy",
    bgCss:
      "radial-gradient(circle at 82% 22%, rgba(14, 165, 233, 0.20) 0%, transparent 48%), " +
      "radial-gradient(circle at 18% 78%, rgba(37, 99, 235, 0.16) 0%, transparent 48%), #FFFFFF",
    darkGrid: false,
    kickerBg: "rgba(255, 255, 255, 0.92)",
    kickerBorder: "rgba(37, 99, 235, 0.22)",
    kickerInk: "#0F172A",
    dotColor: "#0284C7",
    captionInk: "#0F172A",
    kwBg: "#2563EB",
    kwInk: "#FFFFFF",
    cardStyle: "navy-contrast",
    cardBg: "linear-gradient(180deg, #0F1A36 0%, #091024 100%)",
    cardBorder: "rgba(56, 189, 248, 0.42)",
    cardShadow: "0 28px 60px rgba(15, 23, 42, 0.25)",
    gfxInk: "#F8FAFC",
    gfxSub: "#94A3B8",
    gfxAcc: "#38BDF8",
    gfxAcc2: "#60A5FA",
    gfxOnAcc: "#061226",
    gfxMutedBg: "rgba(255, 255, 255, 0.07)",
  },
  "clean-studio-indigo": {
    id: "clean-studio-indigo",
    bgCss:
      "radial-gradient(circle at 20% 24%, rgba(124, 58, 237, 0.18) 0%, transparent 48%), " +
      "radial-gradient(circle at 82% 76%, rgba(37, 99, 235, 0.18) 0%, transparent 48%), #FFFFFF",
    darkGrid: false,
    kickerBg: "rgba(255, 255, 255, 0.92)",
    kickerBorder: "rgba(79, 70, 229, 0.22)",
    kickerInk: "#0F172A",
    dotColor: "#4F46E5",
    captionInk: "#0F172A",
    kwBg: "#4F46E5",
    kwInk: "#FFFFFF",
    cardStyle: "clean-frosted",
    cardBg: "rgba(255, 255, 255, 0.90)",
    cardBorder: "rgba(99, 102, 241, 0.26)",
    cardShadow: "0 24px 56px rgba(79, 70, 229, 0.12), inset 0 1px 0 #FFFFFF",
    gfxInk: "#0F172A",
    gfxSub: "#64748B",
    gfxAcc: "#4F46E5",
    gfxAcc2: "#2563EB",
    gfxOnAcc: "#FFFFFF",
    gfxMutedBg: "rgba(79, 70, 229, 0.06)",
  },
};

function resolveEnvironmentSequence(paletteId: KineticPaletteId): ShotEnvironmentId[] {
  switch (paletteId) {
    // Option 1: Dark Pro Glass + Soft Spotlight (Sapphire -> Emerald -> Amber Spotlight)
    case "dark-pro-glass":
    case "prism-aurora-glass":
    case "obsidian-cyan":
      return ["sapphire-glass", "emerald-glass", "amber-spotlight", "sapphire-glass", "emerald-glass"];

    // Option 2: Scene-by-Scene 7-in-1 Master Mix (Dark Glass -> Book Passage -> Warm Vox Paper -> Emerald/Amber)
    case "scene-mix-master":
    case "royal-velvet-cosmos":
    case "midnight-amber":
      return ["sapphire-glass", "archival-book-dark", "vox-warm-paper", "emerald-glass", "amber-spotlight"];

    // Option 3: Clean V1 Studio + Subtle Soft Aura & Frosted Glass + Navy Contrast
    case "clean-v1-studio":
    case "daylight-prism-studio":
    case "studio-cobalt":
      return ["clean-studio-ice", "clean-studio-navy", "clean-studio-indigo", "clean-studio-ice", "clean-studio-navy"];

    // Option 1 + 2 Hybrid: Cyber Emerald + Cinema Amber Spotlight + Book Proof
    case "emerald-amber-pro":
    case "cyber-emerald-glass":
    case "daylight-emerald":
      return ["emerald-glass", "amber-spotlight", "archival-book-dark", "emerald-glass", "sapphire-glass"];

    // Option 3 + 2 Hybrid: Clean Studio + Warm Vox Editorial + Sapphire Glass Contrast
    case "editorial-studio-mix":
    case "sunset-holographic":
    case "ivory-coral":
    default:
      return ["clean-studio-ice", "vox-warm-paper", "sapphire-glass", "clean-studio-indigo", "archival-book-dark"];
  }
}

export interface KineticSfxEvent {
  timeSec: number;
  kind: SfxKind | "type-tick" | "whisk-out" | "keyword-pop";
  role: SfxRole;
  preferredFile: string;
  gain: number;
}

export interface MicroShot {
  index: number;
  frameId: number;
  envId: ShotEnvironmentId;
  startSec: number;
  endSec: number;
  whiskAtSec: number;
  whiskDir: "left" | "right" | "up" | "zoom";
  pageLabel: string;
  beatVoiceover: string;
  words: Array<{
    text: string;
    clean: string;
    startSec: number;
    endSec: number;
    isKeyword: boolean;
  }>;
  keywordIndex: number;
  realNumber: number | null;
  tagLeft: string;
  tagRight: string;
  stepPhrases: [string, string, string];
}

export interface Kinetic100BuildInput {
  paletteId: KineticPaletteId;
  pkg: ContentPackage;
  words: TimedWord[];
  totalDuration: number;
  audioOffsetSec?: number;
  outroTailSec?: number;
  fps?: number;
  bookTitle: string;
  author: string | null;
  bookLink?: string | null;
  music: boolean;
  sfx: boolean;
  globalUsedFrames?: Set<number>;
  episodeSeed?: string;
}

export interface Kinetic100BuildOutput {
  html: string;
  durationSec: number;
  shots: MicroShot[];
  usedFrameIds: number[];
  sfxEvents: KineticSfxEvent[];
}

interface GsCmd {
  op:
    | "wordIn"
    | "kwPill"
    | "draw"
    | "rotate"
    | "moveXY"
    | "scaleBar"
    | "pulse"
    | "fadePop";
  sel: string;
  at: number;
  dur: number;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  r0?: number;
  r1?: number;
  s0?: number;
  s1?: number;
  dash?: number;
  axis?: "x" | "y";
  svgOrigin?: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were",
  "from", "have", "has", "had", "not", "but", "what", "when", "where", "which", "who",
  "will", "would", "can", "could", "should", "into", "onto", "over", "under", "they",
  "them", "their", "there", "then", "than", "its", "it's", "just", "very", "more",
  "most", "some", "such", "only", "also", "even", "much", "many", "each", "every",
  "page", "passage", "book", "shows", "reveals", "notes", "states", "about", "how",
  "other", "others", "etc", "etcetera", "here", "both", "same", "next", "like", "make",
  "made", "been", "being", "does", "did", "done", "upon", "while", "instead", "completely",
  "entirely", "actually", "really", "simply", "often", "nearly", "almost", "another",
]);

export function cleanBookTitle(raw: string): string {
  return raw
    .replace(/\s*;\s*\(?IA\s+[^)]+\)?/gi, "")
    .replace(/\s*[\[(](?:IA|OCLC|ISBN)\s+[^\])]+[\])]/gi, "")
    .replace(/[;:]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function cleanAlpha(w: string): string {
  return w.replace(/[^\p{L}\p{N}-]/gu, "");
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function pickKeywordIndices(words: TimedWord[]): Set<number> {
  const scored = words.map((w, idx) => {
    const clean = cleanAlpha(w.word).toLowerCase();
    let score = clean.length;
    if (STOPWORDS.has(clean) || clean.length < 4) score = -10;
    if (/^\d+$/.test(clean)) score += 9;
    if (/[?!]/.test(w.word)) score += 2;
    return { idx, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = new Set<number>();
  if (scored[0] && scored[0].score > 0) picked.add(scored[0].idx);
  if (
    words.length >= 7 &&
    scored[1] &&
    scored[1].score > 4 &&
    Math.abs(scored[1].idx - scored[0].idx) >= 3
  ) {
    picked.add(scored[1].idx);
  }
  if (picked.size === 0 && words.length > 0) {
    const longest = words.reduce((best, w, i) =>
      cleanAlpha(w.word).length > cleanAlpha(words[best].word).length ? i : best,
    0);
    picked.add(longest);
  }
  return picked;
}

export function splitWordsIntoMicroShots(
  words: TimedWord[],
  pkg: ContentPackage,
  audioOffset: number,
  totalDuration: number,
): Array<{
  words: TimedWord[];
  startSec: number;
  endSec: number;
  beatIndex: number;
  pageLabel: string;
  beatVoiceover: string;
}> {
  if (words.length === 0) {
    const synth: TimedWord[] = [];
    const beatDur = totalDuration / Math.max(1, pkg.beats.length);
    pkg.beats.forEach((b, bi) => {
      const toks = b.voiceover.split(/\s+/).filter(Boolean);
      const wDur = beatDur / Math.max(1, toks.length);
      toks.forEach((tok, wi) => {
        synth.push({
          word: tok,
          start: +(bi * beatDur + wi * wDur).toFixed(3),
          end: +(bi * beatDur + (wi + 0.9) * wDur).toFixed(3),
          beatIndex: bi,
          index: wi,
          source: "estimated",
        });
      });
    });
    return splitWordsIntoMicroShots(synth, pkg, audioOffset, totalDuration);
  }

  const rawGroups: TimedWord[][] = [];
  let buf: TimedWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    buf.push(w);

    const endsSentence = /[.!?]["')\]]*$/.test(w.word);
    const endsClause = /[,;:—–]["')\]]*$/.test(w.word);
    const beatChanged = next && next.beatIndex !== w.beatIndex;
    const pauseAfter = next ? next.start - w.end : 1.0;
    const nextLower = next ? cleanAlpha(next.word).toLowerCase() : "";
    const beforeConjunction =
      buf.length >= 5 &&
      (nextLower === "but" ||
        nextLower === "and" ||
        nextLower === "while" ||
        nextLower === "or" ||
        nextLower === "because" ||
        nextLower === "instead" ||
        nextLower === "until");

    const remainingInSentence = (() => {
      let c = 0;
      for (let k = i + 1; k < Math.min(words.length, i + 8); k++) {
        c++;
        if (/[.!?]["')\]]*$/.test(words[k].word) || words[k].beatIndex !== w.beatIndex) break;
      }
      return c;
    })();

    if (beatChanged || endsSentence) {
      rawGroups.push(buf);
      buf = [];
    } else if (buf.length >= 4 && (endsClause || pauseAfter >= 0.24) && remainingInSentence >= 3) {
      rawGroups.push(buf);
      buf = [];
    } else if (beforeConjunction && remainingInSentence >= 3) {
      rawGroups.push(buf);
      buf = [];
    } else if (buf.length >= 8 && remainingInSentence >= 3) {
      rawGroups.push(buf);
      buf = [];
    } else if (buf.length >= 9) {
      rawGroups.push(buf);
      buf = [];
    }
  }
  if (buf.length > 0) rawGroups.push(buf);

  const merged: TimedWord[][] = [];
  for (const g of rawGroups) {
    if (
      merged.length > 0 &&
      g.length <= 2 &&
      merged[merged.length - 1].length <= 6 &&
      merged[merged.length - 1][0].beatIndex === g[0].beatIndex
    ) {
      merged[merged.length - 1].push(...g);
    } else {
      merged.push(g);
    }
  }

  const beatList = Array.isArray(pkg?.beats) ? pkg.beats : [];
  return merged.map((grp, idx) => {
    const first = grp[0];
    const last = grp[grp.length - 1];
    const nextGrp = merged[idx + 1];
    const startSec = idx === 0 ? 0 : +(audioOffset + first.start - 0.04).toFixed(3);
    const rawEnd = nextGrp
      ? +(audioOffset + nextGrp[0].start - 0.04).toFixed(3)
      : +(audioOffset + Math.max(last.end + 0.28, totalDuration)).toFixed(3);
    const endSec = Math.max(startSec + 0.95, rawEnd);
    const beat = beatList[first.beatIndex] ?? beatList[0];
    const pageNum = Math.max(1, (beat?.sourcePage ?? 0) + 1);
    return {
      words: grp,
      startSec,
      endSec,
      beatIndex: first.beatIndex,
      pageLabel: `P. ${pageNum}`,
      beatVoiceover: beat?.voiceover ?? grp.map((w) => w.word).join(" "),
    };
  });
}

// 14 Pro Archetypes × 8 Variants = 112 Unique Living Frames (1..112)
const ARCHETYPE_SPECS: ReadonlyArray<{
  archIdx: number;
  rx: RegExp;
  role: SfxRole;
  sfx: SfxKind;
}> = [
  { archIdx: 0, rx: /\b(calculate|math|number|digit|figure|percent|speed|fast|measure|rate|score)\b/i, role: "chrono-gear", sfx: "counter-tick" },
  { archIdx: 1, rx: /\b(opposite|versus|both|different|compare|split|halves|either|between|contrast)\b/i, role: "bento-ui", sfx: "card-pop" },
  { archIdx: 2, rx: /\b(step|stage|first|second|three|two|four|sequence|process|method|path|rule)\b/i, role: "vector-pop", sfx: "card-pop" },
  { archIdx: 3, rx: /\b(page|book|passage|written|study|experiment|subject|research|psycholog|proves)\b/i, role: "paper-slide", sfx: "page-turn" },
  { archIdx: 4, rx: /\b(not|never|impossible|fail|trap|myth|illusion|ignore|ignored|mistake|stop|wrong)\b/i, role: "whip-accent", sfx: "marker-swish" },
  { archIdx: 5, rx: /\b(capacity|more|most|high|peak|full|load|overload|effort|energy|demand)\b/i, role: "vector-pop", sfx: "counter-tick" },
  { archIdx: 6, rx: /\b(see|sight|visual|eye|watch|look|gaze|observe|observation|focus|attention)\b/i, role: "archival-shutter", sfx: "shutter-snap" },
  { archIdx: 7, rx: /\b(pivot|turn|grow|build|reach|target|drive|driving|trajectory|progress|better)\b/i, role: "vector-pop", sfx: "marker-swish" },
  { archIdx: 8, rx: /\b(balance|weigh|weight|equal|priority|priorities|sense|senses|choice)\b/i, role: "chrono-gear", sfx: "clock-tick" },
  { archIdx: 9, rx: /\b(filter|separate|distinct|prism|color|colors|bright|light|beam|concern)\b/i, role: "neuro-circuit", sfx: "shutter-snap" },
  { archIdx: 10, rx: /\b(brain|mind|voice|hear|hearing|sound|auditory|echo|signal|glitch|wiring)\b/i, role: "neuro-circuit", sfx: "marker-swish" },
  { archIdx: 11, rx: /\b(connect|memory|remember|recall|recalling|fuse|fuses|group|grouping|network)\b/i, role: "neuro-circuit", sfx: "ui-click" },
  { archIdx: 12, rx: /\b(time|hour|minute|second|bounce|rhythm|routine|automatic|habit|constant)\b/i, role: "chrono-gear", sfx: "clock-tick" },
  { archIdx: 13, rx: /\b(bookreel|follow|save|share|excuse|sharp|idea)\b/i, role: "bento-ui", sfx: "card-pop" },
];

function selectFrame100(
  phraseText: string,
  shotIdx: number,
  totalShots: number,
  envId: ShotEnvironmentId,
  seed: number,
  localUsed: Set<number>,
  globalUsed?: Set<number>,
  prevArchIdx?: number,
): { frameId: number; archIdx: number; role: SfxRole; sfx: SfxKind } {
  // Closing CTA shot always uses clean Live Audio / Brand Telemetry or Step Lock
  const isClosingCta = shotIdx === totalShots - 1 && /\b(follow|save|bookreel)\b/i.test(phraseText);

  let bestFrame = 1;
  let bestArch = 0;
  let bestScore = -1e9;

  for (let aIdx = 0; aIdx < ARCHETYPE_SPECS.length; aIdx++) {
    const spec = ARCHETYPE_SPECS[aIdx];
    if (!isClosingCta && aIdx === 13) continue;

    const matches = phraseText.match(new RegExp(spec.rx.source, "gi"));
    let matchBoost = matches ? 5.5 + Math.min(4.0, (matches.length - 1) * 1.6) : 0;

    // If environment is archival-book-dark, strongly boost archival passage card (archIdx === 3)
    if (envId === "archival-book-dark" && aIdx === 3 && prevArchIdx !== 3) {
      matchBoost += 9.5;
    }
    if (envId === "vox-warm-paper" && (aIdx === 2 || aIdx === 4 || aIdx === 1)) {
      matchBoost += 4.5;
    }
    if (isClosingCta && aIdx === 13) {
      matchBoost += 20;
    }

    const sameArchPenalty = prevArchIdx === aIdx ? -16.0 : 0;

    for (let v = 0; v < 8; v++) {
      const fid = aIdx * 8 + v + 1; // 1..112
      if (localUsed.has(fid)) continue;
      const globalPenalty = globalUsed?.has(fid) ? -7.0 : 0;
      const jitter = ((hashStr(`${seed}:s${shotIdx}:f${fid}`) % 1000) / 1000) * 3.2;
      const total = matchBoost + sameArchPenalty + globalPenalty + jitter;
      if (total > bestScore) {
        bestScore = total;
        bestFrame = fid;
        bestArch = aIdx;
      }
    }
  }

  localUsed.add(bestFrame);
  globalUsed?.add(bestFrame);
  const chosen = ARCHETYPE_SPECS[bestArch];
  return {
    frameId: bestFrame,
    archIdx: bestArch,
    role: chosen.role,
    sfx: chosen.sfx,
  };
}

function deriveMeaningfulLabels(
  words: TimedWord[],
  beatVoiceover: string,
  fallbackIdx: number,
): {
  tagLeft: string;
  tagRight: string;
  stepPhrases: [string, string, string];
} {
  const meaningful = words
    .map((w) => cleanAlpha(w.word))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));

  const pairFallbacks: ReadonlyArray<[string, string]> = [
    ["Surface Noise", "Core Signal"],
    ["Passive Drift", "Locked Focus"],
    ["Common Myth", "Verified Fact"],
    ["Split Effort", "Single Channel"],
    ["Raw Stimulus", "Human Priority"],
    ["Blurred Guess", "Sharp Contrast"],
  ];

  let tagLeft = pairFallbacks[fallbackIdx % pairFallbacks.length][0];
  let tagRight = pairFallbacks[fallbackIdx % pairFallbacks.length][1];
  if (meaningful.length >= 2) {
    const a = titleCase(meaningful[0].slice(0, 13));
    const b = titleCase(meaningful[meaningful.length - 1].slice(0, 13));
    if (a.toLowerCase() !== b.toLowerCase()) {
      tagLeft = a;
      tagRight = b;
    }
  }

  // Split beatVoiceover into 3 concise 2–4 word phrases for step/checklist cards
  const clauses = beatVoiceover
    .split(/[,.;:!?—–]+|\b(?:while|but|and|because|instead|when|through)\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length >= 6);

  const trimWords = (s: string, maxW = 4) => {
    const toks = s.split(/\s+/).filter(Boolean).slice(0, maxW);
    const joined = toks.join(" ").replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
    return joined.length >= 4 ? joined.charAt(0).toUpperCase() + joined.slice(1) : null;
  };

  const s1 = trimWords(clauses[0] ?? "") ?? `${tagLeft} input`;
  const s2 = trimWords(clauses[1] ?? "") ?? "Internal processing";
  const s3 = trimWords(clauses[2] ?? meaningful.slice(-2).join(" ")) ?? `${tagRight} lock`;

  return {
    tagLeft,
    tagRight,
    stepPhrases: [s1.slice(0, 28), s2.slice(0, 28), s3.slice(0, 28)],
  };
}

export function buildKinetic100Composition(input: Kinetic100BuildInput): Kinetic100BuildOutput {
  const audioOffset = input.audioOffsetSec ?? 0.45;
  const outroTail = input.outroTailSec ?? 1.8;
  const fps = input.fps ?? 30;
  const durationSec = +(audioOffset + input.totalDuration + outroTail).toFixed(3);
  const envSeq = resolveEnvironmentSequence(input.paletteId);
  const bookClean = cleanBookTitle(input.bookTitle);
  const seed = hashStr(`${input.episodeSeed ?? bookClean}::${input.pkg.title}::${input.paletteId}`);

  const rawMicro = splitWordsIntoMicroShots(input.words, input.pkg, audioOffset, input.totalDuration);
  const localUsed = new Set<number>();
  const usedFrameIds: number[] = [];
  const cmds: GsCmd[] = [];
  const sfxEvents: KineticSfxEvent[] = [];
  const whiskDirs: Array<"left" | "right" | "up" | "zoom"> = ["left", "up", "right", "zoom"];

  const WHOOSH_POOL = [
    "14 Quick Swing.wav",
    "SFX_01_02.wav",
    "SFX_01_04.wav",
    "SFX_01_10.wav",
    "whoosh-cinematic-161021.mp3",
  ];
  const ACTION_POOL = [
    "SFX_01_01.wav",
    "SFX_01_03.wav",
    "SFX_01_05.wav",
    "SFX_01_06.wav",
    "SFX_01_07.wav",
    "SFX_01_08.wav",
    "SFX_01_09.wav",
  ];

  let uidSeq = 1;
  const uid = (p: string) => `${p}${uidSeq++}`;
  let prevArchIdx: number | undefined;

  const shots: MicroShot[] = [];
  const shotBlocksHtml: string[] = [];

  rawMicro.forEach((m, idx) => {
    // Shift environment cleanly by beatIndex (or every 2 shots) so scenes flow naturally
    const envId = envSeq[(m.beatIndex + Math.floor(idx / 2)) % envSeq.length];
    const env = ENVS[envId];

    const phraseStr = m.words.map((w) => w.word).join(" ");
    const sel = selectFrame100(
      phraseStr,
      idx,
      rawMicro.length,
      envId,
      seed,
      localUsed,
      input.globalUsedFrames,
      prevArchIdx,
    );
    prevArchIdx = sel.archIdx;
    usedFrameIds.push(sel.frameId);

    const kwSet = pickKeywordIndices(m.words);
    const firstKw = [...kwSet][0] ?? 0;
    const numToken = m.words.map((w) => cleanAlpha(w.word)).find((t) => /^\d{1,3}$/.test(t));
    const realNumber = numToken ? Number(numToken) : null;
    const { tagLeft, tagRight, stepPhrases } = deriveMeaningfulLabels(m.words, m.beatVoiceover, idx + seed);

    const shotDur = Math.max(0.85, +(m.endSec - m.startSec).toFixed(3));
    const whiskAtSec = +(m.endSec - Math.min(0.20, shotDur * 0.20)).toFixed(3);
    const whiskDir = whiskDirs[(seed + idx) % whiskDirs.length];

    const mappedWords = m.words.map((w, wi) => ({
      text: w.word,
      clean: cleanAlpha(w.word),
      startSec: Math.max(m.startSec + 0.02, +(audioOffset + w.start).toFixed(3)),
      endSec: Math.min(whiskAtSec - 0.02, +(audioOffset + w.end).toFixed(3)),
      isKeyword: kwSet.has(wi),
    }));

    const shot: MicroShot = {
      index: idx,
      frameId: sel.frameId,
      envId,
      startSec: m.startSec,
      endSec: m.endSec,
      whiskAtSec,
      whiskDir,
      pageLabel: m.pageLabel,
      beatVoiceover: m.beatVoiceover,
      words: mappedWords,
      keywordIndex: firstKw,
      realNumber,
      tagLeft,
      tagRight,
      stepPhrases,
    };
    shots.push(shot);

    // --- 4-Layer Studio Engagement SFX ---
    if (idx === 0) {
      sfxEvents.push({
        timeSec: 0.03,
        kind: "hook-hit",
        role: "cinema-deep",
        preferredFile: "whoosh-cinematic-161021.mp3",
        gain: 1.85,
      });
    }
    sfxEvents.push({
      timeSec: +(m.startSec + 0.07).toFixed(3),
      kind: sel.sfx,
      role: sel.role,
      preferredFile: ACTION_POOL[(seed + idx * 3) % ACTION_POOL.length],
      gain: 1.7,
    });

    let lastTickAt = -10;
    mappedWords.forEach((mw) => {
      if (mw.isKeyword) {
        sfxEvents.push({
          timeSec: mw.startSec,
          kind: "keyword-pop",
          role: "bento-ui",
          preferredFile: "SFX_01_05.wav",
          gain: 1.5,
        });
        lastTickAt = mw.startSec;
      } else if (mw.startSec - lastTickAt >= 0.17 && mw.clean.length >= 2) {
        sfxEvents.push({
          timeSec: mw.startSec,
          kind: "type-tick",
          role: "bento-ui",
          preferredFile: "SFX_01_08.wav",
          gain: 0.95,
        });
        lastTickAt = mw.startSec;
      }
    });

    sfxEvents.push({
      timeSec: Math.max(m.startSec + 0.35, +(whiskAtSec - 0.02).toFixed(3)),
      kind: "whisk-out",
      role: "whip-accent",
      preferredFile: WHOOSH_POOL[(seed + idx) % WHOOSH_POOL.length],
      gain: 1.8,
    });

    const visualStageHtml = renderProArchetype({
      frameId: sel.frameId,
      shot,
      shotDur,
      env,
      uid,
      cmds,
    });

    const fontSize = mappedWords.length <= 5 ? 64 : mappedWords.length <= 7 ? 56 : 50;
    const wordSpans = mappedWords
      .map((mw) => {
        const wId = uid("w");
        cmds.push({
          op: "wordIn",
          sel: `#${wId}`,
          at: mw.startSec,
          dur: 0.16,
        });
        if (mw.isKeyword) {
          const bgId = uid("wb");
          cmds.push({
            op: "kwPill",
            sel: `#${bgId}`,
            at: mw.startSec + 0.02,
            dur: 0.22,
          });
          return `<span class="kw kw-em" id="${wId}"><span class="kw-pill" id="${bgId}" style="background:${env.kwBg}"></span><span class="kw-em-txt" style="color:${env.kwInk}">${esc(mw.text)}</span></span>`;
        }
        return `<span class="kw" id="${wId}" style="color:${env.captionInk}">${esc(mw.text)}</span>`;
      })
      .join(" ");

    shotBlocksHtml.push(`
      <div class="k-shot" id="shot-${idx}" style="background:${env.bgCss}">
        <div class="${env.darkGrid ? "bg-grid-dark" : "bg-grid-light"}"></div>
        <div class="k-cam" id="cam-${idx}">
          <div class="k-top-pill" style="background:${env.kickerBg};border:1.5px solid ${env.kickerBorder};color:${env.kickerInk}">
            <span class="k-dot" style="background:${env.dotColor};box-shadow:0 0 10px ${env.dotColor}"></span>
            <span>${esc(m.pageLabel)} · ${esc(bookClean.slice(0, 30).toUpperCase())}</span>
          </div>
          <div class="k-visual-zone">
            ${visualStageHtml}
          </div>
          <div class="k-type-stage" style="font-size:${fontSize}px">
            ${wordSpans}
          </div>
        </div>
      </div>`);
  });

  // Clean Pro Glass Outro Lockup (matching first environment of the video)
  const outroEnv = ENVS[envSeq[0]];
  const outroStart = +(audioOffset + input.totalDuration + 0.25).toFixed(3);
  const safeOutro = Math.min(durationSec - 0.6, outroStart);
  const outroCardId = uid("out");
  cmds.push({ op: "fadePop", sel: `#${outroCardId}`, at: safeOutro, dur: 0.4 });
  sfxEvents.push({
    timeSec: safeOutro,
    kind: "payoff-riser",
    role: "cinema-deep",
    preferredFile: "SFX_01_07.wav",
    gain: 1.7,
  });

  const byline = input.author ? `${bookClean} · ${input.author}` : bookClean;
  shotBlocksHtml.push(`
    <div class="k-shot" id="shot-outro" style="background:${outroEnv.bgCss}">
      <div class="${outroEnv.darkGrid ? "bg-grid-dark" : "bg-grid-light"}"></div>
      <div class="k-cam" id="cam-outro">
        <div id="${outroCardId}" style="position:absolute;left:100px;right:100px;top:50%;transform:translateY(-50%);padding:68px 54px;border-radius:36px;background:${outroEnv.cardBg};border:2px solid ${outroEnv.cardBorder};box-shadow:${outroEnv.cardShadow};text-align:center">
          <div style="font-size:20px;font-weight:800;letter-spacing:0.22em;color:${outroEnv.gfxAcc};margin-bottom:18px">BOOKREEL</div>
          <div style="font-size:46px;font-weight:800;letter-spacing:-0.025em;line-height:1.2;color:${outroEnv.gfxInk}">${esc(input.pkg.cta)}</div>
          <div style="font-size:24px;font-weight:600;color:${outroEnv.gfxSub};margin-top:20px">${esc(byline)}</div>
        </div>
      </div>
    </div>`);

  const windowsJson = [
    ...shots.map((s) => ({
      id: `shot-${s.index}`,
      camId: `cam-${s.index}`,
      start: s.startSec,
      end: s.endSec,
      whiskAt: s.whiskAtSec,
      dir: s.whiskDir,
    })),
    {
      id: "shot-outro",
      camId: "cam-outro",
      start: safeOutro,
      end: durationSec,
      whiskAt: durationSec + 5,
      dir: "zoom",
    },
  ];

  const runtimeJson = JSON.stringify({
    duration: durationSec,
    windows: windowsJson,
    cmds,
  }).replace(/<\//g, "<\\/");

  const musicHtml = input.music
    ? `<audio id="music" src="assets/music.wav" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="10" data-volume="0.13"></audio>`
    : "";
  const sfxHtml = input.sfx
    ? `<audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="15" data-volume="1"></audio>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>${esc(input.pkg.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@500;600;700;800;900&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: 1080px; height: 1920px;
    background: #050914;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .stage {
    position: relative; width: 1080px; height: 1920px; overflow: hidden; isolation: isolate;
  }
  .bg-grid-dark {
    position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(to right, rgba(148, 163, 184, 0.065) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(148, 163, 184, 0.065) 1px, transparent 1px);
    background-size: 64px 64px;
  }
  .bg-grid-light {
    position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(to right, rgba(15, 23, 42, 0.05) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(15, 23, 42, 0.05) 1px, transparent 1px);
    background-size: 64px 64px;
  }
  .k-shot {
    position: absolute; inset: 0; opacity: 0; visibility: hidden; pointer-events: none; isolation: isolate;
  }
  .k-cam {
    position: absolute; inset: 0; transform-origin: 50% 50%;
  }
  .k-top-pill {
    position: absolute; left: 50%; top: 184px; transform: translateX(-50%);
    height: 54px; padding: 0 30px; border-radius: 999px;
    display: inline-flex; align-items: center; gap: 14px;
    font-size: 19px; font-weight: 800; letter-spacing: 0.12em;
    white-space: nowrap; z-index: 5;
  }
  .k-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }

  .k-visual-zone {
    position: absolute; left: 84px; width: 912px; top: 292px; height: 700px;
    display: flex; align-items: center; justify-content: center; z-index: 3;
  }
  .pro-card {
    width: 100%; border-radius: 38px; padding: 44px 46px; position: relative; overflow: hidden;
  }

  .k-type-stage {
    position: absolute; left: 86px; width: 908px; top: 1068px; min-height: 430px;
    display: flex; flex-wrap: wrap; align-content: flex-start; justify-content: center;
    column-gap: 18px; row-gap: 16px; z-index: 5;
    text-align: center; font-weight: 800; letter-spacing: -0.03em; line-height: 1.2;
  }
  .kw {
    display: inline-flex; align-items: center; position: relative;
    padding: 4px 6px; will-change: transform, opacity;
  }
  .kw-em {
    padding: 4px 20px; border-radius: 18px; overflow: hidden;
  }
  .kw-pill {
    position: absolute; inset: 0; border-radius: 18px;
    transform-origin: left center; transform: scaleX(0); z-index: 0;
  }
  .kw-em-txt {
    position: relative; z-index: 1; font-weight: 800;
  }
</style>
</head>
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${durationSec.toFixed(3)}" data-fps="${fps}">
  <div id="scene" style="position:absolute;inset:0" data-start="0" data-duration="${durationSec.toFixed(3)}" data-track-index="0">
    ${shotBlocksHtml.join("\n")}
    <audio id="voice" src="assets/voice.wav" data-start="${audioOffset.toFixed(3)}" data-duration="${input.totalDuration.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    ${sfxHtml}
    ${musicHtml}
  </div>
</div>
<script id="k100-data" type="application/json">${runtimeJson}</script>
<script>
(function () {
  var d = JSON.parse(document.getElementById("k100-data").textContent);
  var tl = gsap.timeline({ paused: true });

  d.windows.forEach(function (w) {
    var sc = document.getElementById(w.id);
    var cam = document.getElementById(w.camId);
    if (!sc || !cam) return;
    gsap.set(sc, { autoAlpha: w.start === 0 ? 1 : 0 });
    if (w.start > 0) tl.set(sc, { autoAlpha: 1 }, w.start);

    var holdDur = Math.max(0.2, Math.min(w.whiskAt, d.duration) - w.start);
    tl.fromTo(
      cam,
      { x: 0, y: 10, scale: 0.985, skewX: 0, autoAlpha: 1 },
      { x: 0, y: -6, scale: 1.012, skewX: 0, autoAlpha: 1, duration: holdDur, ease: "none", immediateRender: false },
      w.start
    );

    if (w.end < d.duration && w.whiskAt < w.end) {
      var wDur = Math.max(0.14, w.end - w.whiskAt);
      var exitProps = { duration: wDur, ease: "expo.in", autoAlpha: 0, immediateRender: false };
      if (w.dir === "left") { exitProps.x = -620; exitProps.skewX = -10; exitProps.scale = 0.92; }
      else if (w.dir === "right") { exitProps.x = 620; exitProps.skewX = 10; exitProps.scale = 0.92; }
      else if (w.dir === "up") { exitProps.y = -440; exitProps.scale = 0.9; }
      else { exitProps.scale = 0.54; }
      tl.to(cam, exitProps, w.whiskAt);
      tl.set(sc, { autoAlpha: 0 }, w.end);
    }
  });

  d.cmds.forEach(function (c) {
    var el = document.querySelector(c.sel);
    if (!el) return;
    if (c.op === "wordIn") {
      gsap.set(el, { autoAlpha: 0 });
      tl.fromTo(
        el,
        { autoAlpha: 0, y: 20, scale: 0.86 },
        { autoAlpha: 1, y: 0, scale: 1, duration: c.dur, ease: "back.out(1.7)", immediateRender: false },
        c.at
      );
    } else if (c.op === "kwPill") {
      gsap.set(el, { scaleX: 0 });
      tl.fromTo(el, { scaleX: 0 }, { scaleX: 1, duration: c.dur, ease: "expo.out", immediateRender: false }, c.at);
    } else if (c.op === "fadePop") {
      gsap.set(el, { autoAlpha: 0 });
      tl.fromTo(
        el,
        { autoAlpha: 0, y: 24, scale: 0.93 },
        { autoAlpha: 1, y: 0, scale: 1, duration: c.dur, ease: "expo.out", immediateRender: false },
        c.at
      );
    } else if (c.op === "draw") {
      gsap.set(el, { strokeDashoffset: c.dash });
      tl.fromTo(el, { strokeDashoffset: c.dash }, { strokeDashoffset: 0, duration: c.dur, ease: "power2.inOut", immediateRender: false }, c.at);
    } else if (c.op === "rotate") {
      var rotPropsFrom = { rotation: c.r0 || 0 };
      var rotPropsTo = { rotation: c.r1 || 180, duration: c.dur, ease: "none", immediateRender: false };
      if (c.svgOrigin) {
        rotPropsFrom.svgOrigin = c.svgOrigin;
        rotPropsTo.svgOrigin = c.svgOrigin;
      } else {
        rotPropsFrom.transformOrigin = "50% 50%";
        rotPropsTo.transformOrigin = "50% 50%";
      }
      gsap.set(el, rotPropsFrom);
      tl.fromTo(el, rotPropsFrom, rotPropsTo, c.at);
    } else if (c.op === "moveXY") {
      gsap.set(el, { x: c.x0 || 0, y: c.y0 || 0 });
      tl.fromTo(el, { x: c.x0 || 0, y: c.y0 || 0 }, { x: c.x1 || 0, y: c.y1 || 0, duration: c.dur, ease: "power2.out", immediateRender: false }, c.at);
    } else if (c.op === "scaleBar") {
      if (c.axis === "x") {
        var sxFrom = { scaleX: c.s0 == null ? 0 : c.s0 };
        var sxTo = { scaleX: c.s1 == null ? 1 : c.s1, duration: c.dur, ease: "expo.out", immediateRender: false };
        if (c.svgOrigin) { sxFrom.svgOrigin = c.svgOrigin; sxTo.svgOrigin = c.svgOrigin; }
        else { sxFrom.transformOrigin = "left center"; sxTo.transformOrigin = "left center"; }
        gsap.set(el, sxFrom);
        tl.fromTo(el, sxFrom, sxTo, c.at);
      } else {
        var syFrom = { scaleY: c.s0 == null ? 0.08 : c.s0 };
        var syTo = { scaleY: c.s1 == null ? 1 : c.s1, duration: c.dur, ease: "expo.out", immediateRender: false };
        if (c.svgOrigin) { syFrom.svgOrigin = c.svgOrigin; syTo.svgOrigin = c.svgOrigin; }
        else { syFrom.transformOrigin = "center bottom"; syTo.transformOrigin = "center bottom"; }
        gsap.set(el, syFrom);
        tl.fromTo(el, syFrom, syTo, c.at);
      }
    } else if (c.op === "pulse") {
      var pFrom = { scale: c.s0 || 0.82, autoAlpha: 0.65, transformOrigin: "50% 50%" };
      var pTo = { scale: c.s1 || 1.1, autoAlpha: 1, transformOrigin: "50% 50%", duration: c.dur, ease: "sine.inOut", immediateRender: false };
      if (c.svgOrigin) { pFrom.svgOrigin = c.svgOrigin; pTo.svgOrigin = c.svgOrigin; }
      gsap.set(el, pFrom);
      tl.fromTo(el, pFrom, pTo, c.at);
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

  return { html, durationSec, shots, usedFrameIds, sfxEvents };
}

function renderProArchetype(ctx: {
  frameId: number;
  shot: MicroShot;
  shotDur: number;
  env: ShotEnvironmentSpec;
  uid: (p: string) => string;
  cmds: GsCmd[];
}): string {
  const { frameId, shot, shotDur, env, uid, cmds } = ctx;
  const arch = Math.floor((frameId - 1) / 8); // 0..13
  const v = (frameId - 1) % 8; // 0..7
  const at = shot.startSec + 0.03;
  const dur = Math.max(0.55, shotDur - 0.22);

  const kwWord = shot.words[shot.keywordIndex]?.clean || shot.tagRight;
  const kwUpper = kwWord.toUpperCase().slice(0, 15);
  const borderWidth = env.cardStyle === "vox-brutal" ? "3.5px" : "2px";
  const cardCss = `background:${env.cardBg};border:${borderWidth} solid ${env.cardBorder};box-shadow:${env.cardShadow}`;

  const wrapId = uid("pc");
  cmds.push({ op: "fadePop", sel: `#${wrapId}`, at: shot.startSec, dur: 0.26 });

  // ARCHETYPE 0: Pro Glass Telemetry Gauge Dial (Option 1 Shot 01 style)
  if (arch === 0) {
    const arcId = uid("da");
    const subLeft = uid("dsl");
    const subRight = uid("dsr");
    cmds.push({ op: "draw", sel: `#${arcId}`, at, dur: dur * 0.78, dash: 720 });
    cmds.push({ op: "fadePop", sel: `#${subLeft}`, at: at + 0.14, dur: 0.28 });
    cmds.push({ op: "fadePop", sel: `#${subRight}`, at: at + 0.26, dur: 0.28 });
    const displayMetric = shot.realNumber !== null ? `${shot.realNumber}` : v % 2 === 0 ? "100%" : "0.18s";
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:18px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">COGNITIVE TELEMETRY</span>
        <span style="padding:8px 22px;border-radius:999px;background:${env.gfxMutedBg};border:1.5px solid ${env.gfxAcc};font-size:16px;font-weight:800;color:${env.gfxAcc}">${esc(kwUpper)}</span>
      </div>
      <svg viewBox="0 0 800 340" width="820" height="340" fill="none">
        <path d="M 175 285 A 225 225 0 0 1 625 285" stroke="${env.gfxSub}" stroke-opacity="0.24" stroke-width="24" stroke-linecap="round"/>
        <path id="${arcId}" d="M 175 285 A 225 225 0 0 1 575 135" stroke="${env.gfxAcc}" stroke-width="24" stroke-linecap="round" stroke-dasharray="720" stroke-dashoffset="720"/>
        <circle cx="575" cy="135" r="16" fill="${env.gfxInk}"/>
        <text x="400" y="232" text-anchor="middle" fill="${env.gfxInk}" font-size="82" font-weight="900">${esc(displayMetric)}</text>
        <text x="400" y="278" text-anchor="middle" fill="${env.gfxSub}" font-size="20" font-weight="700" letter-spacing="3">MEASURED RESPONSE</text>
      </svg>
      <div style="display:flex;gap:22px;margin-top:12px">
        <div id="${subLeft}" style="flex:1;padding:20px 24px;border-radius:22px;background:${env.gfxMutedBg};border:1.5px solid ${env.gfxSub}33">
          <div style="font-size:15px;font-weight:800;letter-spacing:0.1em;color:${env.gfxSub}">BASELINE</div>
          <div style="font-size:25px;font-weight:700;color:${env.gfxInk};margin-top:6px">${esc(shot.tagLeft)}</div>
        </div>
        <div id="${subRight}" style="flex:1;padding:20px 24px;border-radius:22px;background:${env.gfxMutedBg};border:2px solid ${env.gfxAcc}">
          <div style="font-size:15px;font-weight:800;letter-spacing:0.1em;color:${env.gfxAcc}">VERIFIED SIGNAL</div>
          <div style="font-size:25px;font-weight:800;color:${env.gfxInk};margin-top:6px">${esc(shot.tagRight)} ✓</div>
        </div>
      </div>
    </div>`;
  }

  // ARCHETYPE 1: Side-by-Side Bento VS Glass Cards (Option 1 Shot 02 style)
  if (arch === 1) {
    const cL = uid("vsl");
    const cR = uid("vsr");
    const vsB = uid("vsb");
    cmds.push({ op: "moveXY", sel: `#${cL}`, at, dur: 0.36, x0: -45, y0: 0, x1: 0, y1: 0 });
    cmds.push({ op: "fadePop", sel: `#${vsB}`, at: at + 0.12, dur: 0.26 });
    cmds.push({ op: "moveXY", sel: `#${cR}`, at: at + 0.16, dur: 0.38, x0: 45, y0: 0, x1: 0, y1: 0 });
    return `<div id="${wrapId}" style="width:100%;display:flex;align-items:center;gap:24px">
      <div id="${cL}" style="flex:1;height:470px;border-radius:36px;${cardCss};padding:40px 28px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
        <svg width="104" height="104" viewBox="0 0 104 104" fill="none" style="margin-bottom:26px">
          <rect x="8" y="8" width="88" height="88" rx="24" fill="${env.gfxMutedBg}" stroke="${env.gfxSub}" stroke-width="3"/>
          <circle cx="52" cy="52" r="20" stroke="${env.gfxSub}" stroke-width="5"/>
          <line x1="38" y1="66" x2="66" y2="38" stroke="${env.gfxSub}" stroke-width="5" stroke-linecap="round"/>
        </svg>
        <div style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">CHANNEL A</div>
        <div style="font-size:32px;font-weight:800;color:${env.gfxInk};margin-top:12px;line-height:1.2">${esc(shot.tagLeft)}</div>
      </div>
      <div id="${vsB}" style="width:76px;height:76px;border-radius:50%;background:${env.cardBg};border:2.5px solid ${env.gfxAcc};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:${env.gfxAcc};flex-shrink:0">VS</div>
      <div id="${cR}" style="flex:1;height:470px;border-radius:36px;background:${env.cardBg};border:3px solid ${env.gfxAcc};box-shadow:${env.cardShadow};padding:40px 28px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
        <svg width="104" height="104" viewBox="0 0 104 104" fill="none" style="margin-bottom:26px">
          <rect x="8" y="8" width="88" height="88" rx="24" fill="${env.gfxAcc}" fill-opacity="0.18" stroke="${env.gfxAcc}" stroke-width="3.5"/>
          <path d="M 34 54 L 47 67 L 72 39" stroke="${env.gfxAcc}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxAcc}">ACTIVE LOCK</div>
        <div style="font-size:32px;font-weight:800;color:${env.gfxInk};margin-top:12px;line-height:1.2">${esc(shot.tagRight)} ✓</div>
      </div>
    </div>`;
  }

  // ARCHETYPE 2: Stacked Numbered Step Cards (Option 1 Shot 03 & Option 2 Scene C style)
  if (arch === 2) {
    const r1 = uid("sr1");
    const r2 = uid("sr2");
    const r3 = uid("sr3");
    cmds.push({ op: "moveXY", sel: `#${r1}`, at, dur: 0.3, x0: -40, y0: 0, x1: 0, y1: 0 });
    cmds.push({ op: "moveXY", sel: `#${r2}`, at: at + 0.14, dur: 0.3, x0: -40, y0: 0, x1: 0, y1: 0 });
    cmds.push({ op: "moveXY", sel: `#${r3}`, at: at + 0.28, dur: 0.32, x0: -40, y0: 0, x1: 0, y1: 0 });
    const rowStyle = `border-radius:26px;padding:30px 34px;display:flex;align-items:center;gap:26px;${cardCss}`;
    const activeRowStyle =
      env.cardStyle === "vox-brutal"
        ? `border-radius:26px;padding:30px 34px;display:flex;align-items:center;gap:26px;background:#18181B;border:3.5px solid #18181B;box-shadow:10px 10px 0px ${env.gfxAcc}`
        : `border-radius:26px;padding:30px 34px;display:flex;align-items:center;gap:26px;background:${env.cardBg};border:2.5px solid ${env.gfxAcc};box-shadow:${env.cardShadow}`;
    const activeRowInk = env.cardStyle === "vox-brutal" ? "#FFFFFF" : env.gfxInk;

    return `<div id="${wrapId}" style="width:100%;display:flex;flex-direction:column;gap:24px">
      <div style="font-size:18px;font-weight:900;letter-spacing:0.18em;color:${env.gfxAcc};text-align:center;margin-bottom:4px">${esc(shot.pageLabel)} · MECHANISM BREAKDOWN</div>
      <div id="${r1}" style="${rowStyle}">
        <span style="width:58px;height:58px;border-radius:16px;background:${env.gfxAcc};color:${env.gfxOnAcc};font-size:26px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0">1</span>
        <span style="font-size:30px;font-weight:800;color:${env.gfxInk}">${esc(shot.stepPhrases[0])}</span>
      </div>
      <div id="${r2}" style="${rowStyle}">
        <span style="width:58px;height:58px;border-radius:16px;background:${env.gfxAcc};color:${env.gfxOnAcc};font-size:26px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0">2</span>
        <span style="font-size:30px;font-weight:800;color:${env.gfxInk}">${esc(shot.stepPhrases[1])}</span>
      </div>
      <div id="${r3}" style="${activeRowStyle}">
        <span style="width:58px;height:58px;border-radius:16px;background:${env.gfxAcc2};color:#FFFFFF;font-size:26px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0">✓</span>
        <span style="font-size:30px;font-weight:800;color:${activeRowInk}">${esc(shot.stepPhrases[2])}</span>
      </div>
    </div>`;
  }

  // ARCHETYPE 3: Verified Archival Book Passage Marker Highlight (Option 2 Scene B style)
  if (arch === 3) {
    const hlId = uid("bhl");
    cmds.push({ op: "scaleBar", sel: `#${hlId}`, at: at + 0.14, dur: dur * 0.65, axis: "x" });
    const excerpt = shot.beatVoiceover.slice(0, 175);
    return `<div id="${wrapId}" style="width:100%;border-radius:28px;background:#F6F1E3;border:3px solid ${env.gfxAcc};box-shadow:0 32px 72px rgba(0,0,0,0.45);padding:52px 54px;color:#1E293B;font-family:'Instrument Serif',Georgia,serif;position:relative">
      <div style="text-align:center;font-family:'Inter',sans-serif;font-size:17px;font-weight:800;letter-spacing:0.22em;color:#64748B;margin-bottom:28px">— ${esc(shot.pageLabel)} · ARCHIVAL SOURCE —</div>
      <div style="position:relative;font-size:40px;line-height:1.42;color:#0F172A">
        <div id="${hlId}" style="position:absolute;left:-8px;right:-8px;top:6px;height:52px;background:rgba(250,204,21,0.52);border-bottom:4px solid #CA8A04;border-radius:8px;z-index:0"></div>
        <span style="position:relative;z-index:1">“${esc(excerpt)}”</span>
      </div>
      <div style="margin-top:32px;display:flex;justify-content:space-between;align-items:center;font-family:'Inter',sans-serif;font-size:16px;font-weight:800;letter-spacing:0.12em;color:#475569">
        <span>VERIFIED TEXT</span>
        <span style="color:#0284C7">● ${esc(kwUpper)}</span>
      </div>
    </div>`;
  }

  // ARCHETYPE 4: Checklist Strike-Out & Verified Lock (`kinetic-1-doing-less-work` style)
  if (arch === 4) {
    const st1 = uid("sk1");
    const st2 = uid("sk2");
    const okR = uid("okr");
    cmds.push({ op: "scaleBar", sel: `#${st1}`, at: at + 0.12, dur: dur * 0.4, axis: "x" });
    cmds.push({ op: "scaleBar", sel: `#${st2}`, at: at + 0.3, dur: dur * 0.4, axis: "x" });
    cmds.push({ op: "fadePop", sel: `#${okR}`, at: at + 0.44, dur: 0.3 });
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px">
        <span style="font-size:20px;font-weight:800;color:${env.gfxSub}">COGNITIVE FILTER</span>
        <span style="padding:8px 20px;border-radius:999px;background:${env.gfxMutedBg};border:1.5px solid ${env.gfxAcc};font-size:16px;font-weight:800;color:${env.gfxAcc}">CUT NOISE</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:22px">
        <div style="padding:24px 28px;border-radius:20px;background:${env.gfxMutedBg};position:relative;display:flex;align-items:center;gap:20px">
          <span style="width:32px;height:32px;border-radius:8px;border:3px solid ${env.gfxSub}"></span>
          <span style="font-size:28px;font-weight:700;color:${env.gfxSub};position:relative">
            ${esc(shot.stepPhrases[0])}
            <span id="${st1}" style="position:absolute;left:0;right:0;top:50%;height:5px;background:#EF4444;border-radius:4px"></span>
          </span>
        </div>
        <div style="padding:24px 28px;border-radius:20px;background:${env.gfxMutedBg};position:relative;display:flex;align-items:center;gap:20px">
          <span style="width:32px;height:32px;border-radius:8px;border:3px solid ${env.gfxSub}"></span>
          <span style="font-size:28px;font-weight:700;color:${env.gfxSub};position:relative">
            ${esc(shot.stepPhrases[1])}
            <span id="${st2}" style="position:absolute;left:0;right:0;top:50%;height:5px;background:#EF4444;border-radius:4px"></span>
          </span>
        </div>
        <div id="${okR}" style="padding:26px 28px;border-radius:22px;background:${env.gfxAcc};display:flex;align-items:center;gap:20px">
          <span style="width:36px;height:36px;border-radius:10px;background:${env.gfxOnAcc};color:${env.gfxAcc};font-size:22px;font-weight:900;display:flex;align-items:center;justify-content:center">✓</span>
          <span style="font-size:30px;font-weight:800;color:${env.gfxOnAcc}">${esc(shot.stepPhrases[2])}</span>
        </div>
      </div>
    </div>`;
  }

  // ARCHETYPE 5: Dual Capacity Meter (`kinetic-1` 100% Mental Space style)
  if (arch === 5) {
    const fillId = uid("cpf");
    cmds.push({ op: "scaleBar", sel: `#${fillId}`, at: at + 0.14, dur: dur * 0.72, axis: "y" });
    const capVal = shot.realNumber !== null ? `${shot.realNumber}%` : "100%";
    return `<div id="${wrapId}" class="pro-card" style="${cardCss};display:flex;gap:36px;align-items:stretch;height:560px">
      <div style="flex:1;border-radius:28px;border:2px solid ${env.gfxSub}44;padding:24px;display:flex;flex-direction:column;gap:14px;justify-content:center">
        <div style="padding:18px;border-radius:14px;background:${env.gfxMutedBg};text-align:center;font-size:22px;font-weight:700;color:${env.gfxSub}">Scattered Effort</div>
        <div style="padding:18px;border-radius:14px;background:${env.gfxMutedBg};text-align:center;font-size:22px;font-weight:700;color:${env.gfxSub}">Divided Focus</div>
        <div style="padding:18px;border-radius:14px;background:${env.gfxMutedBg};text-align:center;font-size:22px;font-weight:700;color:${env.gfxSub}">Signal Drift</div>
        <div style="text-align:center;font-size:20px;font-weight:800;color:${env.gfxSub};margin-top:8px">${esc(shot.tagLeft)}</div>
      </div>
      <div style="flex:1;border-radius:28px;border:3px solid ${env.gfxAcc};padding:24px;display:flex;flex-direction:column;justify-content:flex-end;position:relative;overflow:hidden">
        <div id="${fillId}" style="width:100%;height:78%;border-radius:20px;background:${env.gfxAcc};display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div style="font-size:66px;font-weight:900;color:${env.gfxOnAcc}">${esc(capVal)}</div>
          <div style="font-size:24px;font-weight:800;color:${env.gfxOnAcc};margin-top:6px">${esc(shot.tagRight)} ✓</div>
        </div>
      </div>
    </div>`;
  }

  // ARCHETYPE 6: Precision Eye / Focus Reticle (`viral-1-dankoe-vector` style)
  if (arch === 6) {
    const ringId = uid("er");
    const irisId = uid("ei");
    cmds.push({ op: "rotate", sel: `#${ringId}`, at, dur, r0: 0, r1: 140 + v * 20, svgOrigin: "400 220" });
    cmds.push({ op: "pulse", sel: `#${irisId}`, at, dur: dur * 0.65, s0: 0.72, s1: 1.08, svgOrigin: "400 220" });
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">ATTENTION LOCK</span>
        <span style="font-size:17px;font-weight:800;color:${env.gfxAcc}">● ${esc(kwUpper)}</span>
      </div>
      <svg viewBox="0 0 800 440" width="820" height="440" fill="none">
        <g id="${ringId}">
          <circle cx="400" cy="220" r="175" stroke="${env.gfxSub}" stroke-opacity="0.35" stroke-width="3" stroke-dasharray="14 10"/>
          <circle cx="400" cy="45" r="9" fill="${env.gfxAcc}"/><circle cx="400" cy="395" r="9" fill="${env.gfxAcc}"/>
        </g>
        <path d="M 185 220 Q 400 75 615 220 Q 400 365 185 220 Z" stroke="${env.gfxInk}" stroke-width="7"/>
        <g id="${irisId}">
          <circle cx="400" cy="220" r="68" stroke="${env.gfxAcc}" stroke-width="7"/>
          <circle cx="400" cy="220" r="28" fill="${env.gfxAcc}"/>
        </g>
      </svg>
    </div>`;
  }

  // ARCHETYPE 7: Adaptive Trajectory Curve (`ultra-pro-1-vision-bento` style)
  if (arch === 7) {
    const cvId = uid("tc");
    const badgeId = uid("tcb");
    cmds.push({ op: "draw", sel: `#${cvId}`, at, dur: dur * 0.78, dash: 900 });
    cmds.push({ op: "fadePop", sel: `#${badgeId}`, at: at + dur * 0.45, dur: 0.3 });
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">ADAPTIVE TRAJECTORY</span>
        <span style="padding:7px 20px;border-radius:999px;background:${env.gfxAcc};color:${env.gfxOnAcc};font-size:15px;font-weight:900">GOAL LOCKED ✓</span>
      </div>
      <svg viewBox="0 0 800 390" width="820" height="390" fill="none">
        <line x1="90" y1="310" x2="710" y2="310" stroke="${env.gfxSub}" stroke-opacity="0.3" stroke-width="3"/>
        <line x1="90" y1="195" x2="710" y2="195" stroke="${env.gfxSub}" stroke-opacity="0.2" stroke-width="2" stroke-dasharray="10 10"/>
        <path id="${cvId}" d="M 110 295 C 280 290, 440 220, 680 95" stroke="${env.gfxAcc}" stroke-width="11" stroke-linecap="round" stroke-dasharray="900" stroke-dashoffset="900"/>
        <circle cx="110" cy="295" r="14" fill="${env.gfxInk}"/>
        <g id="${badgeId}">
          <circle cx="680" cy="95" r="20" fill="${env.gfxAcc}"/>
          <rect x="495" y="128" width="210" height="48" rx="24" fill="${env.gfxInk}"/>
          <text x="600" y="159" text-anchor="middle" fill="${env.cardStyle === "dark-glass" || env.cardStyle === "navy-contrast" ? "#0F172A" : "#FFFFFF"}" font-size="20" font-weight="800">${esc(kwUpper)}</text>
        </g>
        <text x="110" y="352" fill="${env.gfxSub}" font-size="20" font-weight="800">${esc(shot.tagLeft.toUpperCase())}</text>
        <text x="690" y="352" text-anchor="end" fill="${env.gfxAcc}" font-size="20" font-weight="800">${esc(shot.tagRight.toUpperCase())}</text>
      </svg>
    </div>`;
  }

  // ARCHETYPE 8: Equilibrium Balance Scale (`ref-1-glass` & Option 3 Shot 02 style)
  if (arch === 8) {
    const bmId = uid("ebm");
    const tilt = v % 2 === 0 ? -11 : 11;
    cmds.push({ op: "rotate", sel: `#${bmId}`, at, dur, r0: -tilt, r1: tilt, svgOrigin: "400 315" });
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">WEIGHT EQUILIBRIUM</span>
        <span style="font-size:17px;font-weight:800;color:${env.gfxAcc}">${esc(kwUpper)}</span>
      </div>
      <svg viewBox="0 0 800 420" width="820" height="420" fill="none">
        <polygon points="400,315 352,400 448,400" fill="${env.gfxInk}"/>
        <g id="${bmId}">
          <line x1="120" y1="315" x2="680" y2="315" stroke="${env.gfxInk}" stroke-width="9" stroke-linecap="round"/>
          <rect x="70" y="205" width="230" height="84" rx="20" fill="${env.gfxMutedBg}" stroke="${env.gfxSub}" stroke-width="3"/>
          <text x="185" y="256" text-anchor="middle" fill="${env.gfxInk}" font-size="23" font-weight="700">${esc(shot.tagLeft)}</text>
          <rect x="500" y="195" width="235" height="92" rx="22" fill="${env.gfxAcc}"/>
          <text x="617" y="250" text-anchor="middle" fill="${env.gfxOnAcc}" font-size="24" font-weight="900">${esc(shot.tagRight)} ✓</text>
        </g>
        <circle cx="400" cy="315" r="14" fill="${env.gfxAcc}"/>
      </svg>
    </div>`;
  }

  // ARCHETYPE 9: Decision Spectrum Prism (`ref-1-glass` 00:14 style)
  if (arch === 9) {
    const inId = uid("pi");
    const outId = uid("po");
    cmds.push({ op: "draw", sel: `#${inId}`, at, dur: dur * 0.45, dash: 500 });
    cmds.push({ op: "draw", sel: `#${outId}`, at: at + dur * 0.3, dur: dur * 0.58, dash: 600 });
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">SPECTRUM PRISM</span>
        <span style="padding:7px 20px;border-radius:999px;border:1.5px solid ${env.gfxAcc};color:${env.gfxAcc};font-size:15px;font-weight:800">CLARITY</span>
      </div>
      <svg viewBox="0 0 800 410" width="820" height="410" fill="none">
        <line id="${inId}" x1="80" y1="225" x2="330" y2="225" stroke="${env.gfxSub}" stroke-width="6" stroke-dasharray="14 10" stroke-dashoffset="500"/>
        <polygon points="400,95 500,305 300,305" fill="${env.gfxAcc}" fill-opacity="0.16" stroke="${env.gfxAcc}" stroke-width="6" stroke-linejoin="round"/>
        <text x="400" y="268" text-anchor="middle" fill="${env.gfxInk}" font-size="22" font-weight="800">MIND</text>
        <path id="${outId}" d="M 462 195 L 635 135 M 482 255 L 635 285" stroke="${env.gfxAcc}" stroke-width="8" stroke-linecap="round" stroke-dasharray="600" stroke-dashoffset="600"/>
        <rect x="615" y="100" width="165" height="58" rx="16" fill="${env.gfxAcc}"/>
        <text x="697" y="137" text-anchor="middle" fill="${env.gfxOnAcc}" font-size="20" font-weight="900">${esc(kwUpper)} ✓</text>
        <text x="697" y="302" text-anchor="middle" fill="${env.gfxSub}" font-size="19" font-weight="700">${esc(shot.tagLeft)}</text>
      </svg>
    </div>`;
  }

  // ARCHETYPE 10: Neural Signal Oscilloscope
  if (arch === 10) {
    const wId = uid("sw");
    const scId = uid("ssc");
    cmds.push({ op: "draw", sel: `#${wId}`, at, dur, dash: 1500 });
    cmds.push({ op: "moveXY", sel: `#${scId}`, at, dur, x0: 70, y0: 0, x1: 730, y1: 0 });
    const dPath =
      v % 2 === 0
        ? "M 70 215 L 195 215 L 245 105 L 295 335 L 355 75 L 415 355 L 475 135 L 535 275 L 590 215 L 730 215"
        : "M 70 215 C 180 65, 290 365, 400 215 C 510 65, 620 365, 730 215";
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">NEURAL SIGNAL TRACE</span>
        <span style="font-size:17px;font-weight:800;color:${env.gfxAcc}">● ${esc(kwUpper)}</span>
      </div>
      <svg viewBox="0 0 800 410" width="820" height="410" fill="none">
        <line x1="70" y1="215" x2="730" y2="215" stroke="${env.gfxSub}" stroke-opacity="0.35" stroke-width="3" stroke-dasharray="10 10"/>
        <path id="${wId}" d="${dPath}" stroke="${env.gfxAcc}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1500" stroke-dashoffset="1500"/>
        <g id="${scId}"><line x1="0" y1="55" x2="0" y2="375" stroke="${env.gfxInk}" stroke-opacity="0.4" stroke-width="3"/></g>
      </svg>
    </div>`;
  }

  // ARCHETYPE 11: Synapse Network Graph
  if (arch === 11) {
    const webId = uid("snw");
    cmds.push({ op: "draw", sel: `#${webId}`, at, dur, dash: 2000 });
    const pts = [
      { x: 210, y: 115 },
      { x: 590, y: 115 },
      { x: 640, y: 295 },
      { x: 160, y: 295 },
      { x: 400, y: 65 },
    ];
    const lines = pts.map((p) => `M 400 215 L ${p.x} ${p.y}`).join(" ");
    const circles = pts
      .map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="22" fill="${i % 2 === 0 ? env.gfxAcc : env.gfxAcc2}"/>`)
      .join("");
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">ASSOCIATIVE MEMORY WEB</span>
        <span style="font-size:17px;font-weight:800;color:${env.gfxAcc}">${esc(shot.pageLabel)}</span>
      </div>
      <svg viewBox="0 0 800 410" width="820" height="410" fill="none">
        <path id="${webId}" d="${lines}" stroke="${env.gfxInk}" stroke-opacity="0.55" stroke-width="5" stroke-dasharray="2000" stroke-dashoffset="2000"/>
        ${circles}
        <circle cx="400" cy="215" r="64" fill="${env.gfxAcc}"/>
        <text x="400" y="223" text-anchor="middle" fill="${env.gfxOnAcc}" font-size="22" font-weight="900">${esc(kwUpper.slice(0, 9))}</text>
      </svg>
    </div>`;
  }

  // ARCHETYPE 12: Precision Chronometer (`ref-1-glass` 00:31 style)
  if (arch === 12) {
    const h1 = uid("ch1");
    const h2 = uid("ch2");
    cmds.push({ op: "rotate", sel: `#${h1}`, at, dur, r0: -45, r1: 165 + v * 25, svgOrigin: "400 215" });
    cmds.push({ op: "rotate", sel: `#${h2}`, at, dur, r0: 0, r1: 55, svgOrigin: "400 215" });
    const ticks = Array.from({ length: 24 }, (_, i) => {
      const a = (i * 15 * Math.PI) / 180;
      const r1 = i % 3 === 0 ? 148 : 158;
      return `<line x1="${(400 + r1 * Math.cos(a)).toFixed(1)}" y1="${(215 + r1 * Math.sin(a)).toFixed(1)}" x2="${(400 + 172 * Math.cos(a)).toFixed(1)}" y2="${(215 + 172 * Math.sin(a)).toFixed(1)}" stroke="${env.gfxInk}" stroke-opacity="${i % 3 === 0 ? 0.85 : 0.35}" stroke-width="${i % 3 === 0 ? 4 : 2}"/>`;
    }).join("");
    return `<div id="${wrapId}" class="pro-card" style="${cardCss}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:17px;font-weight:800;letter-spacing:0.14em;color:${env.gfxSub}">TEMPORAL CADENCE</span>
        <span style="font-size:17px;font-weight:800;color:${env.gfxAcc}">${esc(kwUpper)}</span>
      </div>
      <svg viewBox="0 0 800 420" width="820" height="420" fill="none">
        <circle cx="400" cy="215" r="182" stroke="${env.gfxAcc}" stroke-width="6"/>
        ${ticks}
        <g id="${h2}"><line x1="400" y1="215" x2="400" y2="115" stroke="${env.gfxSub}" stroke-width="7" stroke-linecap="round"/></g>
        <g id="${h1}"><line x1="400" y1="235" x2="400" y2="72" stroke="${env.gfxAcc}" stroke-width="8" stroke-linecap="round"/></g>
        <circle cx="400" cy="215" r="12" fill="${env.gfxInk}"/>
      </svg>
    </div>`;
  }

  // ARCHETYPE 13: Clean Connected Step Flow / Brand Audio Telemetry (Option 3 Shot 03 style)
  const b1 = uid("fb1");
  const b2 = uid("fb2");
  const b3 = uid("fb3");
  const ln = uid("fbl");
  cmds.push({ op: "fadePop", sel: `#${b1}`, at, dur: 0.26 });
  cmds.push({ op: "draw", sel: `#${ln}`, at: at + 0.1, dur: dur * 0.65, dash: 560 });
  cmds.push({ op: "fadePop", sel: `#${b2}`, at: at + 0.2, dur: 0.26 });
  cmds.push({ op: "fadePop", sel: `#${b3}`, at: at + 0.34, dur: 0.28 });
  return `<div id="${wrapId}" class="pro-card" style="${cardCss};padding:58px 46px">
    <div style="text-align:center;font-size:17px;font-weight:800;letter-spacing:0.16em;color:${env.gfxSub};margin-bottom:36px">KEY TAKEAWAY LOCK</div>
    <svg viewBox="0 0 800 260" width="820" height="260" fill="none">
      <line id="${ln}" x1="160" y1="130" x2="640" y2="130" stroke="${env.gfxAcc}" stroke-width="7" stroke-dasharray="560" stroke-dashoffset="560"/>
      <g id="${b1}">
        <rect x="65" y="55" width="180" height="150" rx="32" fill="${env.cardBg}" stroke="${env.gfxInk}" stroke-width="4"/>
        <text x="155" y="144" text-anchor="middle" fill="${env.gfxInk}" font-size="44" font-weight="800">01</text>
      </g>
      <g id="${b2}">
        <rect x="310" y="55" width="180" height="150" rx="32" fill="${env.cardBg}" stroke="${env.gfxAcc}" stroke-width="4"/>
        <text x="400" y="144" text-anchor="middle" fill="${env.gfxAcc}" font-size="44" font-weight="800">02</text>
      </g>
      <g id="${b3}">
        <rect x="555" y="45" width="195" height="170" rx="36" fill="${env.gfxAcc}"/>
        <text x="652" y="146" text-anchor="middle" fill="${env.gfxOnAcc}" font-size="46" font-weight="900">03 ✓</text>
      </g>
    </svg>
  </div>`;
}

export function renderKinetic100SfxBuffer(opts: {
  durationSec: number;
  events: KineticSfxEvent[];
  library: LoadedSfxSample[];
  speechSpans?: SpeechSpan[];
  audioOffsetSec?: number;
}): Float32Array {
  const total = Math.max(1, Math.round(opts.durationSec * SAMPLE_RATE));
  const out = new Float32Array(total);
  const byName = new Map(opts.library.map((s) => [s.fileName, s]));

  const sorted = [...opts.events].sort((a, b) => a.timeSec - b.timeSec);
  let prevAt = -1;

  sorted.forEach((ev, idx) => {
    if (ev.timeSec < 0.01 || ev.timeSec > opts.durationSec - 0.08) return;
    if (ev.kind === "type-tick" && ev.timeSec - prevAt < 0.12) return;
    prevAt = ev.timeSec;
    const s0 = Math.round(ev.timeSec * SAMPLE_RATE);

    if (ev.kind === "type-tick") {
      const len = Math.round(0.028 * SAMPLE_RATE);
      const pitch = 920 + ((idx * 137) % 280);
      for (let i = 0; i < len && s0 + i < total; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 145);
        const click =
          Math.sin(2 * Math.PI * pitch * t) * 0.55 +
          Math.sin(2 * Math.PI * (pitch * 2.1) * t) * 0.25;
        out[s0 + i] += click * env * 0.16 * ev.gain;
      }
      return;
    }

    if (ev.kind === "keyword-pop") {
      const len = Math.round(0.058 * SAMPLE_RATE);
      for (let i = 0; i < len && s0 + i < total; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 78);
        const freq = 520 + 480 * Math.exp(-t * 45);
        out[s0 + i] += Math.sin(2 * Math.PI * freq * t) * env * 0.22 * ev.gain;
      }
      return;
    }

    const sample = byName.get(ev.preferredFile) ?? opts.library.find((s) => s.roles.includes(ev.role));
    if (sample) {
      const startSample = Math.round((ev.timeSec - sample.anchorOffsetSec) * SAMPLE_RATE);
      const maxLen =
        ev.kind === "whisk-out"
          ? Math.min(sample.pcm.length, Math.round(0.42 * SAMPLE_RATE))
          : sample.pcm.length;
      const g = sample.baseGain * ev.gain;
      for (let i = 0; i < maxLen; i++) {
        const dst = startSample + i;
        if (dst < 0) continue;
        if (dst >= total) break;
        const fadeOut = i > maxLen - 1800 ? (maxLen - i) / 1800 : 1;
        out[dst] += sample.pcm[i] * g * fadeOut;
      }
    }

    if (ev.kind === "whisk-out") {
      const len = Math.round(0.19 * SAMPLE_RATE);
      let lp = 0;
      let seed = (idx * 2654435761 + 12345) >>> 0;
      for (let i = 0; i < len && s0 + i < total; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.sin((Math.PI * i) / len) * Math.exp(-t * 9.5);
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const white = (seed / 0x100000000) * 2 - 1;
        const alpha = 0.16 + 0.45 * (i / len);
        lp += alpha * (white - lp);
        out[s0 + i] += lp * env * 0.28 * ev.gain;
      }
    } else {
      const len = Math.round(0.065 * SAMPLE_RATE);
      for (let i = 0; i < len && s0 + i < total; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 68);
        out[s0 + i] += Math.sin(2 * Math.PI * (340 + 260 * Math.exp(-t * 40)) * t) * env * 0.2 * ev.gain;
      }
    }
  });

  if (opts.speechSpans && opts.speechSpans.length > 0) {
    const off = opts.audioOffsetSec ?? 0;
    const gate = new Uint8Array(total);
    for (const sp of opts.speechSpans) {
      const a = Math.max(0, Math.round((off + sp.start) * SAMPLE_RATE));
      const b = Math.min(total, Math.round((off + sp.end) * SAMPLE_RATE));
      for (let i = a; i < b; i++) gate[i] = 1;
    }
    let g = 1.0;
    for (let i = 0; i < total; i++) {
      const target = gate[i] ? 0.80 : 1.0;
      g += 0.002 * (target - g);
      out[i] *= g;
    }
  }

  const ceiling = 0.56;
  for (let i = 0; i < total; i++) {
    const x = out[i];
    if (Math.abs(x) > ceiling) out[i] = Math.tanh(x / ceiling) * ceiling;
  }
  return out;
}
