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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
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
 * Clustering only looks at each word's vertical centre and never at its
 * horizontal position relative to other lines, so a two-column page — where
 * a line in the left column and a line in the right column can sit at the
 * same vertical centre — merges those two columns' words into one "line" if
 * their y-centres fall within tolerance of each other, and the resulting
 * stroke bridges the gutter between them.
 *
 * A gutter-aware horizontal split was attempted and reverted (three rounds:
 * a median-word-width anchor, then a median-gap-plus-block-fraction anchor,
 * then a presence-based drop exemption, then a magnitude-aware one with a
 * sample floor). A parameter sweep across dropped-run length, word width,
 * gap ratio and gutter ratio showed the failure is structural, not a tuning
 * miss: the magnitude-aware exemption's bound on how large a gap N dropped
 * words can plausibly explain grows linearly and unboundedly with N, while
 * a real gutter's width is fixed — so past a small, page-dependent number of
 * consecutively dropped words at the gutter (as few as one, for a gutter
 * only about as wide as a single word), the exemption defeats the very
 * split it was guarding, merging the two columns back into one stroke. No
 * slack constant removes this; it only moves where it happens. On top of
 * that, even a hypothetically perfect gutter split would only fix stroke
 * SHAPE — this function still returns lines sorted by vertical centre alone,
 * so a two-column page comes back interleaved (left row 1, right row 1, left
 * row 2, ...), not in reading order, which is a separate, larger piece of
 * work. Fixing shape on a page whose sequence is still wrong doesn't make
 * the page usable, so the gutter split was not worth carrying. This function
 * does NOT detect columns; a caller feeding it a two-column page gets one
 * left-to-right stroke per shared baseline, spanning the gutter, not two
 * separate per-column strokes, and the lines come back in an order that is
 * not that page's reading order either. See the two-column test and the
 * report for the measurements behind this call.
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

  return groups.map((group) => {
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
