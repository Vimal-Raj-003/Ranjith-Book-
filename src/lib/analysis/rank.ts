/**
 * Step two of finding ideas: one model call sees every grounded candidate from
 * the whole book at once and scores them on the same scale.
 *
 * Why a second pass instead of trusting each window's own `strength`: twenty
 * windows are twenty separate judges, each grading only what was in front of
 * it. A 7 from one is not a 7 from another. Only a reader who sees all the
 * candidates side by side can say which are strongest, and which are the same
 * idea surfacing in two chapters.
 */
import { SCORE_KEYS, type Candidate, type IdeaScores, type ScoredCandidate } from "./types";

/** How much each dimension counts toward the overall viral & retention score. */
export const WEIGHTS: IdeaScores = {
  viewerUsefulness: 1.2,
  educationalValue: 0.9,
  hookPotential: 1.6,
  storyPotential: 1.0,
  practicalValue: 1.1,
  emotionalInterest: 1.3,
  uniqueness: 1.3,
  youtubeSuitability: 1.5,
  visualPotential: 1.0,
};

export const RANK_SCHEMA = {
  type: "object",
  required: ["scores"],
  additionalProperties: false,
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        required: ["id", ...SCORE_KEYS, "duplicateOf"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          ...Object.fromEntries(SCORE_KEYS.map((k) => [k, { type: "integer", minimum: 1, maximum: 10 }])),
          duplicateOf: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export const RANK_SYSTEM = `You are the commissioning editor for a high-reach channel of 60-120 second vertical videos (YouTube Shorts & Instagram Reels), each built on one sharp idea from a single book.

You are given every candidate idea found in the book. Score EACH candidate ruthlessly from 1 to 10 on:
- viewerUsefulness: does a viewer walk away with a clear shift in how they act or think today?
- educationalValue: does it teach a real mechanism or insight rather than an empty platitude?
- hookPotential: would the opening hook stop a cold stranger scrolling within 2 seconds?
- storyPotential: is there a concrete example, tension arc, or human stakes to hold attention past the midpoint?
- practicalValue: can a viewer immediately test or apply it in real life?
- emotionalInterest: does it hit a real nerve — relief, recognition ("that's me"), urgency, or surprise?
- uniqueness: is it a counter-intuitive angle or hidden truth, rather than generic self-help advice every channel repeats?
- youtubeSuitability: does it build naturally in 60-120 seconds AND trigger a strong Save ("I need to remember this") or Share ("my friend needs to hear this") impulse?
- visualPotential: can its contrast, steps, or payoff be SHOWN crisply on kinetic motion cards?

Calibration rules:
- Use the full 1-10 scale and compare candidates head-to-head.
- Reserve 8-10 strictly for scroll-stopping, counter-intuitive, highly shareable/saveable topics in plain modern English.
- Cap dry textbook definitions, broad chapter summaries, or obvious clichés ("work hard", "sleep enough", "stay focused" with no fresh mechanism) at 5 or below.

duplicateOf: if a candidate makes essentially the same point as another candidate, set duplicateOf to the id of the STRONGER, punchier one (and leave the stronger one's duplicateOf null). Ideas that are related but make genuinely different points are not duplicates. Otherwise null.

Score every id you are given, exactly once.`;

export function rankPrompt(bookTitle: string, candidates: Candidate[], sectionTitles: Map<number, string>): string {
  const lines = candidates.map((c) =>
    [
      `id: ${c.id}`,
      `section: ${sectionTitles.get(c.sectionIndex) ?? "?"}`,
      `title: ${c.title}`,
      `idea: ${c.coreIdea}`,
      `hook: ${c.hook}`,
      `angle: ${c.angle}`,
    ].join("\n"),
  );
  return `Book: ${bookTitle}\n\n${candidates.length} candidates:\n\n${lines.join("\n\n")}`;
}

export function weightedScore(scores: IdeaScores): number {
  let sum = 0;
  let weight = 0;
  for (const k of SCORE_KEYS) {
    sum += scores[k] * WEIGHTS[k];
    weight += WEIGHTS[k];
  }
  return Math.round((sum / weight) * 100) / 100;
}

function clampScore(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null;
}

/** Scores from a candidate's own `strength`, when the ranking call is unavailable. */
export function fallbackScores(c: Candidate): IdeaScores {
  return Object.fromEntries(SCORE_KEYS.map((k) => [k, c.strength])) as unknown as IdeaScores;
}

/**
 * Attach the ranker's scores to each candidate. A candidate the ranker skipped
 * or garbled keeps its own `strength` on every dimension rather than being
 * dropped — being missed by the ranker is not evidence of being weak. The
 * count of such candidates is returned so the run can record it.
 */
export function applyRanking(
  candidates: Candidate[],
  reply: unknown,
): { scored: ScoredCandidate[]; missing: number } {
  const rows: Record<string, unknown>[] =
    reply && typeof reply === "object" && Array.isArray((reply as { scores?: unknown }).scores)
      ? (reply as { scores: Record<string, unknown>[] }).scores
      : [];
  const byId = new Map(rows.filter((r) => typeof r?.id === "string").map((r) => [r.id as string, r]));
  const ids = new Set(candidates.map((c) => c.id));
  let missing = 0;

  const scored = candidates.map((c) => {
    const row = byId.get(c.id);
    let scores: IdeaScores;
    if (row && SCORE_KEYS.every((k) => clampScore(row[k]) !== null)) {
      scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, clampScore(row[k])!])) as unknown as IdeaScores;
    } else {
      missing++;
      scores = fallbackScores(c);
    }
    const dup = typeof row?.duplicateOf === "string" && row.duplicateOf !== c.id && ids.has(row.duplicateOf)
      ? row.duplicateOf
      : null;
    return { ...c, scores, score: weightedScore(scores), duplicateOf: dup };
  });
  return { scored, missing };
}
