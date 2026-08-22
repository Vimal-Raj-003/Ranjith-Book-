export interface EpisodePlan {
  /** Kebab-case, stable, unique per book. The one-video-one-idea guarantee. */
  ideaKey: string;
  title: string;
  startPage: number;
  endPage: number;
  /** Word index within `startPage` / `endPage`, into that page's vision words. */
  startWord: number;
  endWord: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * A model's JSON is parsed, not type-checked: `startPage` can arrive as -1,
 * 3.7, or a string coerced by `Number()` upstream. `Number.isInteger` fails
 * closed for anything that is not a clean integer (NaN, floats, -Infinity),
 * and the caller decides what to do with a bad index rather than clamping
 * garbage into an accidental 0.
 */
function isCleanInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/** kebab-case: lowercase letters/digits, single hyphens, no leading/trailing hyphen. */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A model proposing a split is proposing indices into arrays it never saw the
 * length of. Repair what is repairable, drop what is not, and never end an
 * upload with zero episodes — the operator uploaded pages to get a video.
 */
export function validatePlan(
  plan: EpisodePlan[],
  pageCount: number,
  wordsPerPage: number[],
): EpisodePlan[] {
  const seen = new Set<string>();
  const out: EpisodePlan[] = [];

  for (const raw of plan) {
    const key = typeof raw.ideaKey === "string" ? raw.ideaKey.trim() : "";
    if (!key || !KEBAB.test(key) || seen.has(key)) continue;

    // Indices that are not clean integers (NaN, floats, a model hallucinating
    // -3) are not a rounding problem to paper over — they mean the model's
    // output cannot be trusted for this episode at all. Drop it rather than
    // clamping garbage into a plausible-looking 0.
    if (
      !isCleanInt(raw.startPage) ||
      !isCleanInt(raw.endPage) ||
      !isCleanInt(raw.startWord) ||
      !isCleanInt(raw.endWord)
    ) {
      continue;
    }

    const startPage = clamp(raw.startPage, 0, pageCount - 1);
    const endPage = clamp(raw.endPage, startPage, pageCount - 1);
    const startWord = clamp(raw.startWord, 0, Math.max(0, wordsPerPage[startPage] - 1));
    const endWord = clamp(raw.endWord, 0, Math.max(0, wordsPerPage[endPage] - 1));

    // An inverted range on a single page is not a typo we can fix — reversing it
    // would narrate the passage backwards. Drop it.
    if (startPage === endPage && endWord < startWord) continue;

    seen.add(key);
    out.push({ ideaKey: key, title: raw.title?.trim() || key, startPage, endPage, startWord, endWord });
  }

  if (out.length > 0) return out;

  return [
    {
      ideaKey: "whole-upload",
      title: "The whole upload",
      startPage: 0,
      endPage: Math.max(0, pageCount - 1),
      startWord: 0,
      endWord: Math.max(0, (wordsPerPage[pageCount - 1] ?? 1) - 1),
    },
  ];
}
