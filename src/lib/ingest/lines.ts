import type { Box } from "./ocr";
import type { AlignedWord } from "./align";

export interface LineRun {
  box: Box;
  /** Vision indices, ascending. */
  wordIndices: number[];
  /**
   * The real OCR box of each word, parallel to `wordIndices` — element `i`
   * here is the box of the word named by element `i` of `wordIndices`.
   *
   * This exists so a stroke that starts or ends mid-line can be built from
   * the actual geometry of the words in range, rather than from an assumed
   * uniform word width. Real type is proportional — "the" and
   * "extraordinarily" do not occupy equal width — so interpolating equal
   * shares of the line's total width misplaces the start of every stroke
   * that begins mid-line. See `runsForRange`.
   */
  wordBoxes: Box[];
}

const centreY = (b: Box) => (b.y0 + b.y1) / 2;
const heightOf = (b: Box) => b.y1 - b.y0;
const widthOf = (b: Box) => b.x1 - b.x0;

/**
 * Signal 1 of the gutter split: a gap must exceed this multiple of the
 * page's median inter-word gap. Chosen from evidence measured across the
 * four validation fixtures (justified text, dialogue with an em-dash, a
 * modest gutter, a wide gutter — see the report for the full table):
 * ordinary justified stretch measured 4x the page's typical gap, a
 * dialogue-line em-dash measured 7.5x, a modest one-word-wide gutter
 * measured 8x, and a wide gutter measured 32x. 5x sits just above justified
 * stretch, but — importantly — BELOW both the em-dash (7.5x) and the modest
 * gutter (8x): this signal alone cannot tell those two apart. That is
 * exactly why signal 2 exists; the two together are what separates them.
 *
 * Anchored to median GAP, not median word WIDTH: word width shrinks on a
 * dialogue-heavy or short-word page while the space between words does not,
 * so a width-anchored threshold shrinks right along with the words and
 * false-splits an ordinary line at an ordinary em-dash. The gap itself
 * doesn't have that problem.
 */
const GAP_MULTIPLIER = 5;

/**
 * Signal 2 of the gutter split: a gap must also be at least this fraction of
 * the whole text block's width (`max(x1) - min(x0)` across every boxed word
 * on the page). A real gutter is a structural feature of the page and
 * occupies a real share of it; an em-dash or a justified line's stretch
 * never does, however short the surrounding words are.
 *
 * Chosen from the same four fixtures: the em-dash dialogue line measured
 * ~6.0% of its block (the case signal 1 alone gets wrong), the modest gutter
 * measured ~10.3% of its block, and — the case signal 2 alone gets wrong —
 * the justified line's stretched gap measured ~10.5% of ITS (much narrower)
 * block, which is why signal 1 has to be the one vetoing that case. 8% sits
 * between the two gutter-adjacent cases (6.0% and 10.3%) with roughly equal
 * margin on each side. See the report for the full table and for how this
 * also protects a single missing/inherited word's inflated neighbour-gap,
 * given a realistically wide page.
 */
const BLOCK_FRACTION = 0.08;

/**
 * Below this many measured gaps on the page, the median gap is not trusted
 * at all — signal 1 is disabled (never split on it) rather than computed
 * from too few samples. With very few gaps, the gutter gap itself can BE
 * the median (a 3-word single line with gaps [8, 300] medians to 300, the
 * gutter, inflating the "typical gap" threshold to the point that the
 * gutter it's measuring can never exceed it) — not a boundary case, total
 * contamination. 5 is chosen because it sits below every "must split"
 * validation fixture's sample count (the modest-gutter class has 7 gap
 * samples, the wide-gutter class has 6) so real gutter detection is
 * unaffected, and above the degenerate 2-gap fixture that exposed this.
 */
const MIN_GAP_SAMPLES = 5;

/**
 * Slack multiplier on the drop-exemption's magnitude check (see
 * `isGapExplainedByDrops`) — the plausible width of N missing words is
 * allowed to run up to this much over the page's own largest observed word
 * width, to tolerate ordinary variation in how wide a specific dropped word
 * might have been. Kept modest deliberately: a large slack would let a
 * gutter "hide" behind a run of only two or three stray drops (this is
 * exactly the regression the exemption introduced — see the report).
 */
const DROP_MAGNITUDE_SLACK = 1.15;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Whether a gap between two boxed neighbours is plausibly explained by
 * words `aligned` already says were dropped between them, rather than being
 * a structural feature of the page.
 *
 * This is PRESENCE *and* MAGNITUDE aware, deliberately: presence alone (is
 * every intervening vision-index slot unboxed?) is not enough — a single
 * stray unboxed token landing between a genuine two-column gutter's
 * flanking words would otherwise exempt an arbitrarily large gutter gap
 * just because something, anything, was technically "missing" there. A gap
 * is only treated as explained by drops if its size is also roughly
 * consistent with the number of words actually missing: at most
 * `DROP_MAGNITUDE_SLACK` times what that many words, each up to the page's
 * own largest observed word width, plus their ordinary in-between gaps,
 * could plausibly occupy. A 300px gap "explained by" one or three dropped
 * tokens on a page of 70px words is not explained at all, and this rejects
 * it — falling through to the ordinary two-signal gutter test instead of
 * exempting it.
 *
 * If ANY intervening slot instead carries a real box (a word that exists
 * and was placed elsewhere — a different line, a different column), the
 * gap is not explained by drops regardless of magnitude, and must go
 * through the ordinary gutter test. An empty range (adjacent vision
 * indices, or no gap at all) is not "explained by drops" either — there is
 * nothing to attribute the gap to.
 */
function isGapExplainedByDrops(
  aligned: AlignedWord[],
  loIndex: number,
  hiIndex: number,
  gap: number,
  maxWordWidth: number,
  medianGap: number,
): boolean {
  let droppedCount = 0;
  for (const word of aligned) {
    if (word.visionIndex > loIndex && word.visionIndex < hiIndex) {
      if (word.box) return false;
      droppedCount++;
    }
  }
  if (droppedCount === 0) return false;

  const plausibleMax =
    DROP_MAGNITUDE_SLACK * (droppedCount * maxWordWidth + (droppedCount + 1) * medianGap);
  return gap <= plausibleMax;
}

function hull(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * Group boxed words into one stroke per line.
 *
 * Clustering is on the vertical centre with a tolerance derived from the median
 * word height, rather than a fixed pixel figure: a photograph taken closer to
 * the page has taller words and proportionally larger baseline jitter, and a
 * fixed tolerance splits one line into two on exactly those photographs.
 *
 * Within a baseline cluster, words are further split wherever the horizontal
 * gap to the next word (left to right) crosses a gutter threshold — this
 * stops a two-column page's left- and right-column rows (which commonly sit
 * at the very same baseline) from being hulled into one stroke that bridges
 * the gutter. Splitting requires BOTH of two independent signals to agree
 * (see `GAP_MULTIPLIER` and `BLOCK_FRACTION`), because either alone is
 * defeatable: a gap large relative to the page's typical gap can still be
 * ordinary justified stretch or an em-dash, and a gap large relative to the
 * page's overall width could in principle be a coincidence on a very narrow
 * page. Neither threshold is a fixed pixel figure, for the same reason the
 * height tolerance above is not one: both gap size and page scale vary with
 * how close the photo was taken and how much text is on it.
 *
 * Before either signal is even consulted, a gap is exempted from the gutter
 * split entirely if it is explained — in both PRESENCE and MAGNITUDE — by
 * words `aligned` already says were dropped (see `isGapExplainedByDrops`):
 * every vision-index slot between two boxed neighbours must be present in
 * `aligned` but unboxed (never some other, elsewhere-positioned boxed
 * word), AND the gap's size must be plausible for that many missing words,
 * not just any size. Presence alone is not enough — a single stray unboxed
 * token landing between a genuine gutter's flanking words must not exempt
 * an arbitrarily large gutter just because something was technically
 * missing there. This is what actually closes the repeatedly-measured risk
 * that a run of consecutively dropped words reads as a gutter on a page
 * whose lines are realistically short, without opening the reverse hole of
 * an actual gutter hiding behind one stray drop — seeing `aligned`'s null
 * entries directly, sized against the page's own word-width and gap
 * evidence, is strictly better than either guessing from pixels alone or
 * trusting presence alone. It does not reintroduce column-major ordering:
 * it never assumes anything about words that DO have a box elsewhere in the
 * vision stream (e.g. the rest of a real two-column page's left column, in
 * a vision model's natural column-major reading order) — those still go
 * through the two-signal test exactly as before.
 *
 * This split only stops a stroke from bridging the gutter — it does NOT
 * reorder lines into column-major reading order. Lines still come out sorted
 * purely by vertical centre, so a two-column page comes back interleaved by
 * row (left row 1, right row 1, left row 2, ...), not with the whole left
 * column followed by the whole right column. Column-major reordering is a
 * separate, larger piece of work and is deliberately out of scope here — see
 * the two-column test and the report for what remains unfixed.
 */
export function clusterLineRuns(aligned: AlignedWord[]): LineRun[] {
  const boxed = aligned.filter((w): w is AlignedWord & { box: Box } => w.box !== null);
  if (boxed.length === 0) return [];

  const tolerance = median(boxed.map((w) => heightOf(w.box))) * 0.6;

  const sorted = [...boxed].sort((a, b) => centreY(a.box) - centreY(b.box));
  const groups: (AlignedWord & { box: Box })[][] = [];

  for (const word of sorted) {
    const last = groups[groups.length - 1];
    const sameLine =
      last && Math.abs(centreY(word.box) - centreY(last[last.length - 1].box)) <= tolerance;
    if (sameLine) last.push(word);
    else groups.push([word]);
  }

  // Sort each baseline group left-to-right up front — needed both to walk
  // for the gutter split below and to measure the page's typical gap.
  const byXGroups = groups.map((group) => [...group].sort((a, b) => a.box.x0 - b.box.x0));

  const pageGaps: number[] = [];
  for (const line of byXGroups) {
    for (let i = 0; i < line.length - 1; i++) {
      const gap = line[i + 1].box.x0 - line[i].box.x1;
      if (gap > 0) pageGaps.push(gap);
    }
  }
  // The raw median, used as a "typical gap" estimate for the drop-magnitude
  // check below regardless of sample count (0 when there is no data at all
  // — a neutral value, since that check falls back to word width alone).
  const medianGap = pageGaps.length > 0 ? median(pageGaps) : 0;
  // Signal 1's actual threshold additionally requires enough samples for
  // the median to be trustworthy at all — see `MIN_GAP_SAMPLES`. Below it,
  // never split on this signal rather than trust a handful of gaps that may
  // themselves include the very gutter being measured.
  const gapThreshold = pageGaps.length >= MIN_GAP_SAMPLES ? medianGap * GAP_MULTIPLIER : Infinity;
  const blockThreshold =
    (Math.max(...boxed.map((w) => w.box.x1)) - Math.min(...boxed.map((w) => w.box.x0))) *
    BLOCK_FRACTION;
  const maxWordWidth = Math.max(...boxed.map((w) => widthOf(w.box)));

  const finalGroups: (AlignedWord & { box: Box })[][] = [];
  for (const line of byXGroups) {
    let current: (AlignedWord & { box: Box })[] = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1];
      const curr = line[i];
      const gap = curr.box.x0 - prev.box.x1;
      const isGutter =
        !isGapExplainedByDrops(aligned, prev.visionIndex, curr.visionIndex, gap, maxWordWidth, medianGap) &&
        gap > gapThreshold &&
        gap > blockThreshold;
      if (isGutter) {
        finalGroups.push(current);
        current = [curr];
      } else {
        current.push(curr);
      }
    }
    finalGroups.push(current);
  }

  return finalGroups.map((group) => {
    // Sorted by vision index (reading order), not by x0: wordIndices must be
    // ascending so `runsForRange`'s range filter works, and wordBoxes must
    // line up with it element-for-element.
    const byIndex = [...group].sort((a, b) => a.visionIndex - b.visionIndex);
    return {
      box: hull(byIndex.map((w) => w.box)),
      wordIndices: byIndex.map((w) => w.visionIndex),
      wordBoxes: byIndex.map((w) => w.box),
    };
  });
}

/**
 * Give unboxed words the vertical extent of the line their neighbours sit on,
 * so a single OCR miss (or a short run of them) does not punch a hole in the
 * middle of a stroke. The horizontal extent is interpolated between the
 * boxed neighbours on either side, never invented beyond them: a word at the
 * very start or end of a line with no boxed neighbour on one side keeps
 * `null` rather than a guessed geometry.
 *
 * A RUN of consecutive unboxed words is filled as one unit, not word by
 * word: the gap between the two boxed neighbours bracketing the run is
 * divided across the run proportional to each word's character count (a
 * better proxy for a word's real printed width than an even split — "a" and
 * "extraordinarily" plainly do not take the same space), producing
 * contiguous, non-overlapping slices that tile the gap exactly. Treating
 * each unboxed word independently — finding "the nearest boxed word" on
 * either side by skipping over other unboxed words — is what produces
 * corrupted geometry: two adjacent unboxed words both resolve to the same
 * pair of outer neighbours and so both claim the identical full gap as their
 * box, rather than each claiming a slice of it.
 *
 * The `lines` passed in are only consulted for which line (and its vertical
 * extent) a run of unboxed words belongs to — they are not mutated, and
 * their `wordBoxes` do not gain entries for the words this function boxes.
 * A caller that wants line runs whose `wordBoxes` include these inherited
 * boxes (so `runsForRange` can hull them too) must re-run `clusterLineRuns`
 * on this function's output — or just call `buildLineRuns`, which does
 * exactly that and is the recommended entry point.
 */
export function inheritBoxes(aligned: AlignedWord[], lines: LineRun[]): AlignedWord[] {
  const result: AlignedWord[] = [...aligned];

  let i = 0;
  while (i < result.length) {
    if (result[i].box) {
      i++;
      continue;
    }

    // Extend to the full maximal run of consecutive unboxed words starting
    // here — filled (or not) once, as a unit.
    let end = i;
    while (end + 1 < result.length && !result[end + 1].box) end++;

    const before = i > 0 ? result[i - 1] : undefined;
    const after = end + 1 < result.length ? result[end + 1] : undefined;

    // A line whose first word index is strictly before the run and whose
    // last word index is strictly after it — i.e. the run sits entirely
    // inside a single line with a boxed neighbour on each side.
    const line = lines.find((l) => {
      const first = l.wordIndices[0];
      const last = l.wordIndices[l.wordIndices.length - 1];
      return first < i && end < last;
    });

    if (line && before?.box && after?.box) {
      const run = result.slice(i, end + 1);
      const totalChars = run.reduce((sum, w) => sum + Math.max(1, w.word.length), 0);
      const gap = after.box.x0 - before.box.x1;

      let cursor = before.box.x1;
      for (let k = 0; k < run.length; k++) {
        const share = (Math.max(1, run[k].word.length) / totalChars) * gap;
        const x1 = cursor + share;
        result[i + k] = {
          ...run[k],
          box: { x0: cursor, y0: line.box.y0, x1, y1: line.box.y1 },
        };
        cursor = x1;
      }
    }

    i = end + 1;
  }

  return result;
}

/**
 * The recommended entry point: cluster, fill in inheritable gaps, then
 * re-cluster so the final `LineRun`s' `wordBoxes` include the inherited
 * words too.
 *
 * This exists because the two-step alternative — cluster once, call
 * `inheritBoxes`, and reuse the first-pass `lines` — is a very natural
 * sequence to write and fails silently in two different ways: a range that
 * lands exactly on an inherited word returns no stroke at all (indistinguishable
 * from "out of range"), and a wider range that happens to still look right
 * visually can have a `wordIndices` that silently omits the inherited word,
 * corrupting anything downstream that counts per-word entries. Both are
 * exercised in the tests. The three underlying functions stay exported so
 * they can still be exercised individually.
 */
export function buildLineRuns(aligned: AlignedWord[]): { words: AlignedWord[]; lines: LineRun[] } {
  const firstPass = clusterLineRuns(aligned);
  const words = inheritBoxes(aligned, firstPass);
  const lines = clusterLineRuns(words);
  return { words, lines };
}

/**
 * The strokes covering a word range, each clipped to the words actually in
 * range — a beat that starts mid-line must not paint the words before it.
 *
 * Each stroke's box is the geometric hull of the *real* boxes of the words
 * in range (via `wordBoxes`), not an interpolation across the line's total
 * width divided evenly by word count. Real type is proportional, so equal
 * division misplaces the start/end of a stroke that begins or ends mid-line.
 */
export function runsForRange(lines: LineRun[], startWord: number, endWord: number): LineRun[] {
  const out: LineRun[] = [];

  for (const line of lines) {
    const inRangeIndices: number[] = [];
    const inRangeBoxes: Box[] = [];

    for (let k = 0; k < line.wordIndices.length; k++) {
      const idx = line.wordIndices[k];
      if (idx >= startWord && idx <= endWord) {
        inRangeIndices.push(idx);
        inRangeBoxes.push(line.wordBoxes[k]);
      }
    }
    if (inRangeIndices.length === 0) continue;

    out.push({
      wordIndices: inRangeIndices,
      wordBoxes: inRangeBoxes,
      box: hull(inRangeBoxes),
    });
  }

  return out;
}
