export type RightsStatus = "public-domain" | "in-copyright" | "own-work";

export const MAX_QUOTE_WORDS = 25;
export const MAX_VERBATIM_SHARE = 0.08;
/** Runs shorter than this are ordinary shared phrasing, not quotation. */
export const RUN_FLOOR = 5;

/**
 * A second, coarser floor purely for `subfloorShare` (see below). RUN_FLOOR
 * itself cannot be lowered to catch this — RUN_FLOOR exists precisely so
 * that "one of the most" doesn't count as reproduction — but a narration
 * built entirely from lifts just BELOW RUN_FLOOR (four-word chunks, say)
 * reports zero coverage under RUN_FLOOR alone, real reproduction going
 * completely unmeasured. `SUBFLOOR_RUN` gives that pattern a run length
 * short enough to catch it, and `MAX_SUBFLOOR_SHARE` is deliberately loose
 * (validated against original-commentary fixtures at 0% and a legitimate
 * single-quote fixture at 22%, both far under the 35% cap — see
 * `tests/quotation.test.mts` and the task report for the measured numbers).
 */
export const SUBFLOOR_RUN = 3;
export const MAX_SUBFLOOR_SHARE = 0.35;

export interface QuotationReport {
  longestRun: number;
  /**
   * True fraction of the narration covered by qualifying runs (>= RUN_FLOOR
   * words), INCLUDING the single longest one. This used to exclude the
   * longest run on the theory that "the one permitted quote" shouldn't count
   * against a share limit — but that made the share read 0 for a narration
   * that is nothing BUT a maximal verbatim quote, and let a long quote plus
   * a below-threshold collage report a misleadingly small number. The share
   * reported here is simply the truth; the ALLOWANCE for the one permitted
   * quote is handled separately, in `withinBudget`, as a word-count budget
   * rather than by hiding words from the numerator.
   */
  verbatimShare: number;
  /**
   * Coverage by the coarser `SUBFLOOR_RUN`-word floor — see the doc comment
   * on `SUBFLOOR_RUN`. A second, independent signal for a collage built from
   * lifts too short for `verbatimShare` to ever see.
   */
  subfloorShare: number;
  withinBudget: boolean;
  /** The offending passage, so the operator can be shown what tripped it. */
  excerpt: string | null;
  /**
   * EVERY qualifying run, longest first — not just the single longest.
   *
   * A share breach is almost never one long lift; it is a scatter of five- and
   * six-word echoes that the writer never registered as quoting at all. Naming
   * only the longest one tells a rewrite to fix the passage least likely to be
   * the problem, which is how a rewrite comes back over budget in a different
   * place. The whole list is what makes the feedback actionable.
   */
  excerpts: string[];
}

const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Two limits, because there are two ways to reproduce a page: one long lift, or
 * a collage of short ones. A single-metric check catches only one of them.
 */
export function checkQuotationBudget(
  narration: string,
  source: string,
  rights: RightsStatus,
): QuotationReport {
  const n = tokens(narration);
  const s = tokens(source);

  if (n.length === 0) {
    return {
      longestRun: 0,
      verbatimShare: 0,
      subfloorShare: 0,
      withinBudget: true,
      excerpt: null,
      excerpts: [],
    };
  }

  const positions = new Map<string, number[]>();
  s.forEach((tok, i) => {
    const list = positions.get(tok);
    if (list) list.push(i);
    else positions.set(tok, [i]);
  });

  /** Longest run of the source matched starting exactly at narration index i. */
  const matchLenAt = (i: number): number => {
    let best = 0;
    for (const start of positions.get(n[i]) ?? []) {
      let len = 0;
      while (i + len < n.length && start + len < s.length && n[i + len] === s[start + len]) len++;
      if (len > best) best = len;
    }
    return best;
  };

  // Pass 1: the single longest run anywhere in the narration — "the one
  // quote" the transformative-commentary rule allows, at most MAX_QUOTE_WORDS.
  let longestRun = 0;
  let longestAt = 0;
  for (let i = 0; i < n.length; i++) {
    const best = matchLenAt(i);
    if (best > longestRun) {
      longestRun = best;
      longestAt = i;
    }
  }

  /**
   * Total words covered by DISTINCT qualifying runs at a given floor, found
   * by jumping past a run once it's counted so its interior positions are
   * never recounted as further runs of their own.
   */
  const qualifyingRuns = (floor: number): { total: number; runs: string[] } => {
    let total = 0;
    const runs: string[] = [];
    for (let i = 0; i < n.length; ) {
      const best = matchLenAt(i);
      if (best >= floor) {
        total += best;
        runs.push(n.slice(i, i + best).join(" "));
        i += best;
      } else {
        i += 1;
      }
    }
    return { total, runs };
  };

  const qualifyingTotal = (floor: number): number => qualifyingRuns(floor).total;

  const atFloor = qualifyingRuns(RUN_FLOOR);
  const totalAtFloor = atFloor.total;
  const verbatimShare = totalAtFloor / n.length;
  const subfloorShare = qualifyingTotal(SUBFLOOR_RUN) / n.length;

  // The one permitted quote is folded into the SAME word-count budget as
  // everything else, rather than exempted from the numerator: a narration
  // may carry qualifying coverage up to whichever is larger — the ordinary
  // share cap scaled to this narration's length, or the size of the single
  // legitimate quote actually present here (itself already bounded by
  // MAX_QUOTE_WORDS via the check below). That lets one short quote in a
  // short narration through without ALSO letting a long quote plus a
  // trailing collage hide behind the same allowance — the two do not stack,
  // because the allowance is sized to whichever single quote is really
  // there, not the constant ceiling regardless of what's actually present.
  const quoteAllowance = Math.min(longestRun, MAX_QUOTE_WORDS);
  const wordAllowance = Math.max(MAX_VERBATIM_SHARE * n.length, quoteAllowance);

  const unlimited = rights !== "in-copyright";
  const withinBudget =
    unlimited ||
    (longestRun <= MAX_QUOTE_WORDS &&
      totalAtFloor <= wordAllowance &&
      subfloorShare <= MAX_SUBFLOOR_SHARE);

  return {
    longestRun,
    verbatimShare,
    subfloorShare,
    withinBudget,
    excerpt: longestRun >= RUN_FLOOR ? n.slice(longestAt, longestAt + longestRun).join(" ") : null,
    excerpts: [...atFloor.runs].sort((a, b) => b.length - a.length),
  };
}
