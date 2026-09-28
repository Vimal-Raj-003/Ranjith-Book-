/**
 * The word-range rules, checked in code before a draft reaches the grounding
 * checker.
 *
 * Measured on real runs (8 drafts, two ideas): the checker's blockers were
 * overwhelmingly mechanical — a beat whose range starts before the previous
 * beat's range ends on the same page, and the closing call to action reusing
 * the previous beat's range, which the writer's own prompt had suggested. Each
 * cost a 40–120 s checker call and a ~3 minute rewrite. The rule is exact, so
 * it is enforced exactly, here:
 *
 *   - Every range is in bounds: 0 ≤ startWord ≤ endWord < the page's length.
 *   - On the same page, a beat starts at or after the previous beat's endWord
 *     (sharing that one boundary word is fine; going back is not), and a
 *     content beat covers at least one word past it.
 *
 * Repairs, which never widen a range and never move it onto words the writer
 * did not choose:
 *   - The LAST beat (the call to action) is not about any words — its range is
 *     "somewhere for the marker to rest" (see INDEX_RULE) — so one that runs
 *     backwards is moved to rest where the previous beat ended.
 *   - A content beat that only OVERLAPS the one before it (it runs on past
 *     where that one ended) is trimmed to start where that one ended: its
 *     range shrinks to the part only it covers. The grounding checker still
 *     reads every range against its beat afterwards and remains the judge.
 *
 * Everything else — out of bounds, a beat wholly behind the previous one — is
 * a problem the writer must fix, returned as an exact brief without spending
 * a checker call on a draft that cannot pass.
 */
import type { Beat } from "./schema";

export interface RangeCheck {
  beats: Beat[];
  /** What was repaired, for the episode's notes. */
  repairs: string[];
  /** What the writer must fix. Empty when the ranges are valid. */
  problems: string[];
}

export function checkRanges(
  beats: Beat[],
  pageLengths: Map<number, number>,
): RangeCheck {
  const out = beats.map((b) => ({ ...b }));
  const repairs: string[] = [];
  const problems: string[] = [];

  out.forEach((b, i) => {
    const n = pageLengths.get(b.sourcePage);
    const label = `beats[${i}]`;
    if (n === undefined) {
      problems.push(`${label} names PAGE ${b.sourcePage}, which is not one of the pages you were given.`);
      return;
    }
    if (!Number.isInteger(b.startWord) || !Number.isInteger(b.endWord) || b.startWord < 0 || b.endWord >= n || b.startWord > b.endWord) {
      problems.push(`${label} has range ${b.startWord}–${b.endWord} on PAGE ${b.sourcePage}, which runs 0–${n - 1}; startWord must be ≤ endWord and both inside the page.`);
    }
  });
  if (problems.length) return { beats: out, repairs, problems };

  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const b = out[i];
    const isCta = i === out.length - 1;
    if (b.sourcePage !== prev.sourcePage) continue;
    // A content beat whose whole range is the one word the previous beat
    // ended on points at nothing of its own (measured: the checker blocks it).
    if (!isCta && b.startWord === prev.endWord && b.endWord === prev.endWord) {
      problems.push(
        `beats[${i}] (words ${b.startWord}–${b.endWord}) covers only the last word of the previous beat's range on PAGE ${b.sourcePage}. Point it at the later words it is actually about.`,
      );
      continue;
    }
    if (b.startWord >= prev.endWord) continue;
    if (isCta) {
      const n = pageLengths.get(b.sourcePage)!;
      const from = [b.startWord, b.endWord];
      b.startWord = prev.endWord;
      b.endWord = Math.min(n - 1, Math.max(b.endWord, prev.endWord));
      repairs.push(`The call to action's range (${from[0]}–${from[1]}) ran back over the previous beat's; it now rests at ${b.startWord}–${b.endWord}, where that beat ended.`);
    } else if (b.endWord > prev.endWord) {
      const from = b.startWord;
      b.startWord = prev.endWord;
      repairs.push(`beats[${i}] started at word ${from}, inside the previous beat's range; trimmed to start at ${b.startWord}, where that one ended.`);
    } else {
      problems.push(
        `beats[${i}] (words ${b.startWord}–${b.endWord}) lies wholly at or before the previous beat's range (${prev.startWord}–${prev.endWord}) on PAGE ${b.sourcePage}. Beats on the same page must move forward: each starts at or after the previous beat's endWord. Point it at the later words it is actually about, or reorder the beats to follow the passage.`,
      );
    }
  }
  return { beats: out, repairs, problems };
}
