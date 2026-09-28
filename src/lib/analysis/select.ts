/**
 * From scored candidates to the shortlist the operator sees.
 *
 *   1. Duplicates go: anything the ranker marked as the same idea as a
 *      stronger one, and anything whose embedding is nearly identical to a
 *      stronger candidate's (two windows that found the same point, phrased
 *      differently, which the ranker can miss in a long list).
 *   2. Maximal marginal relevance picks the rest: each pick is the best score
 *      after a penalty for resembling what is already picked. A book with one
 *      brilliant chapter still yields a list that covers the book, instead of
 *      twenty variations on that chapter.
 *   3. A soft cap per section keeps any one chapter from taking over, lifted
 *      when the book has too few sections for it to be fair.
 *
 * Pure: vectors in, decisions out.
 */
import { cosine } from "./embed";
import type { ScoredCandidate } from "./types";

export const TARGET_MAX = 20;
export const TARGET_MIN = 14;
/** Cosine similarity above which two ideas are the same idea. */
export const DUPLICATE_SIMILARITY = 0.8;
/** How strongly resemblance to already-picked ideas is penalised, 0–1. */
export const DIVERSITY = 0.35;
/** Below this weighted score an idea is only kept to reach TARGET_MIN. */
export const QUALITY_FLOOR = 5;

export interface SelectOptions {
  max?: number;
  min?: number;
  duplicateSimilarity?: number;
  diversity?: number;
}

export interface SelectResult {
  selected: ScoredCandidate[];
  duplicates: { id: string; of: string; similarity: number | null }[];
}

export function selectIdeas(
  candidates: ScoredCandidate[],
  vectors: Map<string, Float32Array>,
  opts: SelectOptions = {},
): SelectResult {
  const max = opts.max ?? TARGET_MAX;
  const min = opts.min ?? TARGET_MIN;
  const dupSim = opts.duplicateSimilarity ?? DUPLICATE_SIMILARITY;
  const lambda = opts.diversity ?? DIVERSITY;

  const byScore = [...candidates].sort((a, b) => b.score - a.score || b.strength - a.strength);
  const duplicates: SelectResult["duplicates"] = [];
  const kept: ScoredCandidate[] = [];

  // The ranker's marks, as undirected pairs: whichever of the two is weaker
  // goes, whichever way round the ranker happened to write it. Walking in
  // score order means the stronger one is always already kept.
  const pairs = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!c.duplicateOf || c.duplicateOf === c.id) continue;
    for (const [a, b] of [[c.id, c.duplicateOf], [c.duplicateOf, c.id]]) {
      if (!pairs.has(a)) pairs.set(a, new Set());
      pairs.get(a)!.add(b);
    }
  }

  for (const c of byScore) {
    const marked = kept.find((k) => pairs.get(c.id)?.has(k.id));
    if (marked) {
      duplicates.push({ id: c.id, of: marked.id, similarity: null });
      continue;
    }
    const v = vectors.get(c.id);
    const twin = v ? kept.find((k) => vectors.has(k.id) && cosine(v, vectors.get(k.id)!) >= dupSim) : undefined;
    if (twin) {
      duplicates.push({ id: c.id, of: twin.id, similarity: cosine(v!, vectors.get(twin.id)!) });
      continue;
    }
    kept.push(c);
  }

  const sections = new Set(kept.map((c) => c.sectionIndex));
  const sectionCap = sections.size >= 4 ? Math.max(3, Math.ceil(max * 0.3)) : Infinity;
  const hi = Math.max(...kept.map((c) => c.score), 1);
  const lo = Math.min(...kept.map((c) => c.score), 0);
  const norm = (s: number) => (hi === lo ? 1 : (s - lo) / (hi - lo));

  const selected: ScoredCandidate[] = [];
  const perSection = new Map<number, number>();
  const pool = [...kept];

  while (selected.length < max && pool.length) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if ((perSection.get(c.sectionIndex) ?? 0) >= sectionCap) continue;
      const v = vectors.get(c.id);
      const resemblance = v
        ? Math.max(0, ...selected.filter((s) => vectors.has(s.id)).map((s) => cosine(v, vectors.get(s.id)!)))
        : 0;
      const val = (1 - lambda) * norm(c.score) - lambda * resemblance;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    // Every remaining candidate is in a capped section: lift the cap rather
    // than return a short list while good ideas are left over.
    if (bestIdx < 0) {
      perSection.clear();
      continue;
    }
    const [pick] = pool.splice(bestIdx, 1);
    selected.push(pick);
    perSection.set(pick.sectionIndex, (perSection.get(pick.sectionIndex) ?? 0) + 1);
  }

  // Weak ideas are dropped, but only down to the minimum.
  const strong = selected.filter((c) => c.score >= QUALITY_FLOOR);
  const final =
    strong.length >= min
      ? strong
      : selected.filter((c) => c.score >= QUALITY_FLOOR || selected.indexOf(c) < min);

  return { selected: final.sort((a, b) => b.score - a.score), duplicates };
}

/** A stable, unique, kebab-case key for each idea, derived from its title. */
export function ideaKeys(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map((t) => {
    const base =
      t
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .slice(0, 8)
        .join("-") || "idea";
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    return key;
  });
}
