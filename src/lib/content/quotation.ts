export type RightsStatus = "public-domain" | "in-copyright" | "own-work";

export const MAX_QUOTE_WORDS = 25;
export const MAX_VERBATIM_SHARE = 0.08;
/** Runs shorter than this are ordinary shared phrasing, not quotation. */
export const RUN_FLOOR = 5;

export interface QuotationReport {
  longestRun: number;
  /**
   * Fraction of the narration accounted for by qualifying runs (>= RUN_FLOOR
   * words) OTHER THAN the single longest one. The longest run is "the one
   * quote" the writer is allowed — gated on its own by `longestRun <=
   * MAX_QUOTE_WORDS` — so it does not itself count against the share. Any
   * qualifying overlap beyond that one run is exactly the "collage of short
   * lifts" pattern this second limit exists to catch: no single quote is too
   * long, but the page is being reproduced piecemeal anyway.
   */
  verbatimShare: number;
  withinBudget: boolean;
  /** The offending passage, so the operator can be shown what tripped it. */
  excerpt: string | null;
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

  if (n.length === 0) return { longestRun: 0, verbatimShare: 0, withinBudget: true, excerpt: null };

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

  // Pass 2: every DISTINCT qualifying run, found by jumping past a run once
  // it is counted so its interior positions are never recounted as further
  // runs of their own. One legitimate quote is not a violation on its own —
  // see the doc comment on `verbatimShare` — but a scan that only asked
  // "is any word part of a run?" would flag a lone, permitted quote for the
  // same reason it flags an actual collage, which is the bug this two-pass
  // approach avoids.
  const runs: number[] = [];
  for (let i = 0; i < n.length; ) {
    const best = matchLenAt(i);
    if (best >= RUN_FLOOR) {
      runs.push(best);
      i += best;
    } else {
      i += 1;
    }
  }

  const secondaryWords = runs.length ? runs.reduce((a, b) => a + b, 0) - Math.max(...runs) : 0;
  const verbatimShare = secondaryWords / n.length;

  const unlimited = rights !== "in-copyright";
  const withinBudget =
    unlimited || (longestRun <= MAX_QUOTE_WORDS && verbatimShare <= MAX_VERBATIM_SHARE);

  return {
    longestRun,
    verbatimShare,
    withinBudget,
    excerpt: longestRun >= RUN_FLOOR ? n.slice(longestAt, longestAt + longestRun).join(" ") : null,
  };
}
