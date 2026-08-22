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

/**
 * Clamps `n` into `[lo, hi]`. Guards against an inverted range (`hi < lo`) by
 * collapsing to `lo` instead of returning something between the two bounds
 * in the wrong order — that inversion happens for real when `pageCount` is 0
 * and `hi` is computed as `pageCount - 1`, and an unguarded `Math.min`/`Math.max`
 * pair would hand back a negative index, which is exactly the failure this
 * function exists to prevent.
 */
const clamp = (n: number, lo: number, hi: number) => {
  const safeHi = Math.max(lo, hi);
  return Math.min(safeHi, Math.max(lo, n));
};

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

  // The largest valid word index on a given page. Defaults to "one word,
  // index 0" when `wordsPerPage` doesn't cover that page at all (it is
  // shorter than `pageCount`, `pageCount` itself is 0, or the element there
  // is not usable) — mirroring the `?? 1` already used in the whole-upload
  // fallback below, so a caller passing inconsistent arrays gets a defined,
  // non-NaN answer everywhere, not just in the fallback branch. `??` alone
  // only rejects null/undefined — a NaN or Infinity element is neither, and
  // poisons `Math.max`/`clamp` right through to the output, so the guard
  // has to be "is this a finite number", not just "is this present".
  const maxWordIndexOn = (page: number) => {
    const count = wordsPerPage[page];
    return Math.max(0, (Number.isFinite(count) ? count : 1) - 1);
  };

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
    const startWord = clamp(raw.startWord, 0, maxWordIndexOn(startPage));
    const endWord = clamp(raw.endWord, 0, maxWordIndexOn(endPage));

    // An inverted range on a single page is not a typo we can fix — reversing it
    // would narrate the passage backwards. Drop it.
    if (startPage === endPage && endWord < startWord) continue;

    // `title` goes through the same "trust nothing about this JSON" guard as
    // `ideaKey` — a model returning a non-string title (e.g. a bare number)
    // must not crash the whole validation pass over one cosmetic field.
    const title = typeof raw.title === "string" ? raw.title.trim() : "";

    seen.add(key);
    out.push({ ideaKey: key, title: title || key, startPage, endPage, startWord, endWord });
  }

  if (out.length > 0) return out;

  return [
    {
      ideaKey: "whole-upload",
      title: "The whole upload",
      startPage: 0,
      endPage: Math.max(0, pageCount - 1),
      startWord: 0,
      // Same finite-number guard as maxWordIndexOn above, for the same reason:
      // a NaN/Infinity element here must not leak into the one guaranteed episode.
      endWord: maxWordIndexOn(Math.max(0, pageCount - 1)),
    },
  ];
}
