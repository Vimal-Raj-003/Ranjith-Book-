/**
 * How long a video should be — chosen from the CONTENT, never stretched to fit.
 *
 * Three lengths are allowed: about 45 s for simple content, about 60 s for
 * normal content, up to 90 s for complex, multi-concept content. 90 s is a
 * HARD limit: nothing longer is ever generated.
 *
 * Two stages, both here:
 *
 *  1. BEFORE writing, `planDuration` scores the idea (how much evidence the book
 *     gives, how many concepts the idea holds, what kind of idea it is) and picks
 *     a tier. The writer is told that tier's word budget.
 *  2. AFTER writing, `checkLength` (index.ts) accepts any script that fits a
 *     widened band around the tier, and `tierOfScript` reports the tier the
 *     script actually IS. A script that needed more room than planned is not cut
 *     back, and one that needed less is not padded: what the content needs wins,
 *     up to the cap.
 *
 * Seconds are predicted from words and beats rather than guessed: across 30 real
 * finished videos (79–104 s) `3.9 + 0.468·beats + 0.333·words` was within 2.4 s
 * RMS and never more than 5 s off. The budgets below keep the PREDICTION at or
 * under EXPECTED_MAX_SECONDS, so even that worst-case error stays under the cap.
 */
import type { LengthSpec } from "./schema";

/** Never exceeded. A render of a longer video is refused. */
export const VIDEO_MAX_SECONDS = 90;
/** The shortest a video is aimed to be. */
export const VIDEO_MIN_TARGET_SECONDS = 45;
/** Below this something is broken (an empty narration), not "short content". */
export const VIDEO_MIN_HARD_SECONDS = 30;
/**
 * What a script may PREDICT to: headroom below the cap for the model's own error.
 * The fit's worst miss was 5 s on its 30 first videos, and 9.6 s on a dense Stoic
 * passage with many short sentences (227 words, 9 beats: predicted 84, finished
 * 90.8) — so the prediction stops well short of the cap, and a draft whose recorded
 * voice still runs over is sent back to be cut (`overrunFix`), never rendered.
 */
export const EXPECTED_MAX_SECONDS = 82;

/** Finished seconds = fixed + beat·beats + word·words (0.7 s lead-in and 1.8 s tail are in `fixed`). */
export const PACE = { fixed: 3.9, beat: 0.468, word: 0.333 } as const;

export function expectedSeconds(words: number, beats: number): number {
  return PACE.fixed + PACE.beat * beats + PACE.word * words;
}

/** The most words a script of `beats` beats may have and still predict to `seconds`. */
export function maxWordsFor(seconds: number, beats: number): number {
  return Math.max(0, Math.floor((seconds - PACE.fixed - PACE.beat * beats) / PACE.word));
}

export type DurationTier = 45 | 60 | 90;

interface TierBudget {
  minWords: number;
  maxWords: number;
  aim: number;
  minBeats: number;
  maxBeats: number;
}

export const TIERS: Record<DurationTier, TierBudget> = {
  45: { minWords: 112, maxWords: 138, aim: 124, minBeats: 5, maxBeats: 7 },
  60: { minWords: 145, maxWords: 178, aim: 160, minBeats: 6, maxBeats: 9 },
  90: { minWords: 195, maxWords: 218, aim: 205, minBeats: 8, maxBeats: 11 },
};

/** Every number a plan is made from — all known before a word is written. */
export interface IdeaSignals {
  angle: string;
  coreIdea: string;
  whyItMatters: string;
  /** Words in the passages the idea cites. */
  citedWords: number;
  /** How many separate quotes the idea cites. */
  quotes: number;
  /** How many distinct pages those quotes sit on. */
  pages: number;
}

/** What kind of idea needs how much room: a framework has parts to walk through, a surprising fact does not. */
const ANGLE_POINTS: Record<string, number> = {
  framework: 1.5,
  "practical-technique": 0.75,
  "mental-model": 0.5,
  story: 0.5,
  "common-mistake": 0.25,
  "counterintuitive-insight": 0,
  other: 0,
  "surprising-fact": -0.5,
  "emotional-truth": -0.5,
};

const NUMBER_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|\\d+";
const ENUMERATION = new RegExp(`\\b(${NUMBER_WORD})\\s+(?:steps?|ways?|rules?|stages?|principles?|reasons?|habits?|types?|things?|questions?|parts?|lessons?|mistakes?|laws?)\\b`, "i");
const ENUM_VALUE: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export interface DurationPlan {
  tier: DurationTier;
  /** What the writer is told the video runs, e.g. "60-second". */
  label: string;
  minWords: number;
  maxWords: number;
  aimWords: number;
  minBeats: number;
  maxBeats: number;
  /** The predicted length of a script at the aim, in seconds. */
  expectedSeconds: number;
  score: number;
  /** Why this tier, one short clause each, for the episode's notes. */
  reasons: string[];
}

/** The score of an idea, and the reasons behind it. Pure and deterministic. */
export function scoreIdea(s: IdeaSignals): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (pts: number, why: string) => {
    score += pts;
    if (pts !== 0) reasons.push(`${why} (${pts > 0 ? "+" : ""}${pts})`);
  };

  add(s.citedWords < 25 ? 0 : s.citedWords < 60 ? 0.5 : s.citedWords < 120 ? 1 : s.citedWords < 250 ? 1.5 : 2, `${s.citedWords} cited words`);
  add(s.quotes <= 1 ? 0 : s.quotes === 2 ? 0.5 : 1, `${s.quotes} quote${s.quotes === 1 ? "" : "s"}`);
  add(s.pages <= 1 ? 0 : s.pages === 2 ? 0.5 : 1, `${s.pages} page${s.pages === 1 ? "" : "s"}`);

  const text = `${s.coreIdea} ${s.whyItMatters}`;
  const sentences = (text.match(/[.!?](\s|$)/g) ?? []).length;
  add(sentences <= 2 ? 0 : sentences === 3 ? 0.5 : 1, `${sentences} sentences of idea`);
  const en = ENUMERATION.exec(text);
  if (en) {
    const n = ENUM_VALUE[en[1].toLowerCase()] ?? Number(en[1]);
    add(n >= 3 ? 1 : n === 2 ? 0.5 : 0, `an enumerated set (${en[0].toLowerCase()})`);
  }
  add(ANGLE_POINTS[s.angle] ?? 0, `a ${s.angle} idea`);
  return { score, reasons };
}

/**
 * Tier thresholds on the idea score. Placed on the scores of 122 real ideas
 * (0 to 4, median 1.5): about a third land below SIMPLE_BELOW (45 s), a tenth at
 * or above COMPLEX_FROM (up to 90 s), the rest in between (60 s).
 */
export const SIMPLE_BELOW = 1.25;
export const COMPLEX_FROM = 2.5;

export function planDuration(signals: IdeaSignals): DurationPlan {
  const { score, reasons } = scoreIdea(signals);
  const tier: DurationTier = score < SIMPLE_BELOW ? 45 : score < COMPLEX_FROM ? 60 : 90;
  const t = TIERS[tier];
  const beats = Math.round((t.minBeats + t.maxBeats) / 2);
  return {
    tier,
    label: `${tier}-second`,
    minWords: t.minWords,
    maxWords: t.maxWords,
    aimWords: t.aim,
    minBeats: t.minBeats,
    maxBeats: t.maxBeats,
    expectedSeconds: Math.round(expectedSeconds(t.aim, beats) * 10) / 10,
    score,
    reasons,
  };
}

/** The idea's signals from a stored ContentIdea row. */
export function ideaSignals(idea: {
  angle: string;
  coreIdea: string;
  whyItMatters: string;
  sourceText: string;
  sourceRefs: string;
  sourcePages: string;
}): IdeaSignals {
  const list = (s: string): unknown[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const refs = list(idea.sourceRefs);
  const pages = new Set(list(idea.sourcePages).map(Number));
  for (const r of refs) {
    const p = (r as { pageIndex?: unknown })?.pageIndex;
    if (typeof p === "number") pages.add(p);
  }
  return {
    angle: idea.angle,
    coreIdea: idea.coreIdea,
    whyItMatters: idea.whyItMatters,
    citedWords: idea.sourceText.split(/\s+/).filter(Boolean).length,
    quotes: Math.max(1, refs.length),
    pages: Math.max(1, pages.size),
  };
}

/** The spec the WRITER is given: this tier, exactly. */
export function writerSpecFor(plan: DurationPlan): LengthSpec {
  return { minBeats: plan.minBeats, maxBeats: plan.maxBeats, minWords: plan.minWords, maxWords: plan.maxWords, seconds: plan.label, aimWords: plan.aimWords };
}

/**
 * The spec a draft is CHECKED against: the tier widened a little each way, never
 * past the cap. A script a few words either side of the plan is what the content
 * needed, not a reason to spend a rewrite.
 */
export function gateSpecFor(plan: DurationPlan): LengthSpec {
  const t = TIERS[plan.tier];
  return {
    minBeats: Math.max(4, plan.minBeats - 1),
    maxBeats: Math.min(12, plan.maxBeats + 1),
    minWords: Math.floor(t.minWords * 0.93),
    maxWords: Math.min(TIERS[90].maxWords, Math.ceil(t.maxWords * 1.1)),
    seconds: plan.label,
    aimWords: plan.aimWords,
    maxExpectedSeconds: EXPECTED_MAX_SECONDS,
  };
}

/** The envelope of every tier: what a script may be when no plan was made. */
export const ENVELOPE: LengthSpec = {
  minBeats: 4,
  maxBeats: 12,
  minWords: Math.floor(TIERS[45].minWords * 0.93),
  maxWords: TIERS[90].maxWords,
  seconds: "45-to-90-second",
  aimWords: TIERS[60].aim,
  maxExpectedSeconds: EXPECTED_MAX_SECONDS,
};

/**
 * A recorded narration that would make the video run past VIDEO_MAX_SECONDS: how far
 * to cut. Aims for the cap minus a margin, since a rewrite rarely lands on an exact
 * word count. Returns null when the video already fits.
 */
export const OVERRUN_MARGIN_SECONDS = 5;
export function overrunFix(
  words: number,
  voiceSeconds: number,
  videoSeconds: number,
): { cutWords: number; targetWords: number; brief: string; problem: string } | null {
  if (![words, voiceSeconds, videoSeconds].every(Number.isFinite) || videoSeconds <= VIDEO_MAX_SECONDS || words <= 0 || voiceSeconds <= 0) return null;
  const perWord = voiceSeconds / words;
  const cutWords = Math.ceil((videoSeconds - (VIDEO_MAX_SECONDS - OVERRUN_MARGIN_SECONDS)) / perWord);
  const targetWords = Math.max(TIERS[45].minWords, words - cutWords);
  const problem = `The recorded narration would make the video ${videoSeconds.toFixed(1)} s long, past the ${VIDEO_MAX_SECONDS}-second limit`;
  return {
    cutWords,
    targetWords,
    problem,
    brief:
      `${problem}. This script is ${words} words and it must be about ${targetWords} words (cut at least ${cutWords}). ` +
      `Tighten every beat, merge short sentences (each full stop adds a pause), and drop anything that restates an earlier point — ` +
      `never add a new claim, and keep every word range and quotation rule as it was. Every other rule still applies.`,
  };
}

/** The tier a finished script actually is, by its predicted length. */
export function tierOfScript(words: number, beats: number): DurationTier {
  const s = expectedSeconds(words, beats);
  return s <= 52.5 ? 45 : s <= 72 ? 60 : 90;
}

/**
 * The verdict on a finished narration's real length. "fail" is the hard limit:
 * anything past VIDEO_MAX_SECONDS is refused, and so is a video so short that
 * something has gone wrong. "note" is a length outside the 45–90 s target.
 */
export function videoSecondsVerdict(seconds: number): "ok" | "note" | "fail" {
  if (!Number.isFinite(seconds) || seconds > VIDEO_MAX_SECONDS || seconds < VIDEO_MIN_HARD_SECONDS) return "fail";
  if (seconds < VIDEO_MIN_TARGET_SECONDS) return "note";
  return "ok";
}
