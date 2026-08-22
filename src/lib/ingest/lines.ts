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
 * their y-centres fall within tolerance of each other. This function does
 * NOT detect columns; a caller feeding it a two-column page gets one
 * left-to-right stroke per shared baseline, spanning the gutter, not two
 * separate per-column strokes. See the report for how real this risk is on
 * a typical novel page.
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
 * Give an unboxed word the vertical extent of the line its neighbours sit on, so
 * a single OCR miss does not punch a hole in the middle of a stroke. The
 * horizontal extent is interpolated between the neighbours, never invented
 * beyond them: a word at the very start or end of a line with no boxed
 * neighbour on one side keeps `null` rather than a guessed geometry.
 *
 * The `lines` passed in are only consulted for which line (and its vertical
 * extent) an unboxed word belongs to — they are not mutated, and their
 * `wordBoxes` do not gain entries for the words this function boxes. A
 * caller that wants line runs whose `wordBoxes` include these inherited
 * boxes (so `runsForRange` can hull them too) must re-run
 * `clusterLineRuns` on this function's output. See the report for why that
 * recompute is safe: an inherited box's vertical centre is the line's own
 * centre, which re-clusters onto the same line under the same tolerance.
 */
export function inheritBoxes(aligned: AlignedWord[], lines: LineRun[]): AlignedWord[] {
  return aligned.map((word, i) => {
    if (word.box) return word;

    const line = lines.find((l) => {
      const first = l.wordIndices[0];
      const last = l.wordIndices[l.wordIndices.length - 1];
      return i > first && i < last;
    });
    if (!line) return word;

    const before = aligned.slice(0, i).reverse().find((w) => w.box);
    const after = aligned.slice(i + 1).find((w) => w.box);
    if (!before?.box || !after?.box) return word;

    return {
      ...word,
      box: { x0: before.box.x1, y0: line.box.y0, x1: after.box.x0, y1: line.box.y1 },
    };
  });
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
