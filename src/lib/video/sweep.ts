import type { Box } from "../ingest/ocr";
import type { LineRun } from "../ingest/lines";
import { runsForRange } from "../ingest/lines";

export interface SweepStep {
  box: Box;
  start: number;
  end: number;
}

/**
 * Split a beat's measured speech window across the strokes it covers.
 *
 * Proportional to word count rather than evenly, because a line holding seven
 * words takes longer to say than one holding three — and a marker that finishes
 * a line while the voice is still reading it is the single most obvious way this
 * effect looks fake.
 *
 * `lines` and the word range are implicitly scoped to ONE photographed page:
 * `LineRun.wordIndices` come from vision-model word indices that reset to 0 on
 * every page (see `align.ts`/`vision.ts`), and `LineRun` itself carries no page
 * identifier. So a beat whose narrated passage runs across two photographed
 * pages cannot be expressed as a single call here — there is no `(startWord,
 * endWord)` pair that means "word 40 of page 3 through word 2 of page 4",
 * because "word 2" is ambiguous without knowing which page's index space it
 * lives in. A caller that needs to handle that ordinary case must detect the
 * page boundary itself, split the beat into one sub-range per page (each with
 * that page's own local indices) and a proportional slice of `speechStart` /
 * `speechEnd` — the same word-count proportionality this function applies
 * internally between strokes — then call `sweepForBeat` once per page and
 * concatenate the results. This function has no way to do that split itself:
 * given only one page's `lines`, it cannot see how many words of the beat live
 * on a page it was never handed.
 */
export function sweepForBeat(
  lines: LineRun[],
  startWord: number,
  endWord: number,
  speechStart: number,
  speechEnd: number,
): SweepStep[] {
  const runs = runsForRange(lines, startWord, endWord);
  if (runs.length === 0) return [];

  const totalWords = runs.reduce((sum, r) => sum + r.wordIndices.length, 0);
  if (totalWords === 0) return [];

  // A non-finite window (NaN or +/-Infinity) has no honest timing at all. This
  // is not contrived: `durationOf()` in tts.ts returning NaN for a corrupted or
  // zero-byte TTS render feeds straight into `speechEnd`'s `Math.max(x, NaN)`,
  // which is itself NaN. A beat whose audio could not be measured gets no
  // stroke at all, rather than NaN timestamps propagating into every step and
  // then into every camera key downstream.
  if (!Number.isFinite(speechStart) || !Number.isFinite(speechEnd)) return [];

  // An inverted window (speechEnd < speechStart) cannot reach this function
  // through today's only producer — tts.ts guarantees speechEnd is at least
  // 0.2s after speechStart — but this is a pure function with its own
  // contract, not one that trusts its caller. Collapse it to a zero-length
  // window anchored at speechStart instead of letting the "last step ends
  // exactly on speechEnd" rule below hand back a step with a negative
  // duration (start > end).
  const sane = speechEnd >= speechStart;
  const windowEnd = sane ? speechEnd : speechStart;
  const span = sane ? speechEnd - speechStart : 0;

  const steps: SweepStep[] = [];
  let t = speechStart;

  for (let i = 0; i < runs.length; i++) {
    // The last step ends exactly on windowEnd rather than on an accumulated
    // sum, so floating-point drift cannot leave the marker moving after the
    // voice stops.
    const end = i === runs.length - 1 ? windowEnd : t + (runs[i].wordIndices.length / totalWords) * span;
    steps.push({ box: runs[i].box, start: t, end });
    t = end;
  }

  return steps;
}

/** Where the top of the viewport sits, in page pixels, over time. */
export interface CameraKey {
  t: number;
  y: number;
}

const MIDDLE = 0.5;

/**
 * The camera follows the MARKER, not the beat text.
 *
 * The ancestor project learned that steering a scroll to whichever passage a
 * beat mentioned was worse than a straight top-to-bottom pass: it jumped
 * between sections and skipped parts of the page. That failure cannot occur
 * here, because the marker advances monotonically through the document —
 * every line is visited, in order, by construction (see `sweepForBeat`). But
 * the camera has to follow it or the marker leaves frame.
 *
 * The active stroke lands in the middle third of the frame UNLESS doing so
 * would require scrolling past the top of the page (nothing above y=0 to
 * bring into view) or past the bottom (nothing below `pageHeight -
 * frameHeight`) — in which case the camera clamps to that limit instead, and
 * the stroke sits wherever on screen that leaves it.
 */
export function cameraTrack(
  steps: SweepStep[],
  frameHeight: number,
  pageHeight: number,
): CameraKey[] {
  // Guards its own contract rather than trusting `sweepForBeat` to have
  // already filtered non-finite input: `cameraTrack` is exported and callable
  // on its own, so a NaN frame/page height (or a step smuggled in with a NaN
  // box/timestamp) must not turn into a NaN camera position with no error.
  if (!Number.isFinite(frameHeight) || !Number.isFinite(pageHeight)) return [];

  const maxY = Math.max(0, pageHeight - frameHeight);
  const clamp = (y: number) => Math.min(maxY, Math.max(0, y));

  const keys: CameraKey[] = [];
  for (const step of steps) {
    const centre = (step.box.y0 + step.box.y1) / 2;
    if (!Number.isFinite(centre) || !Number.isFinite(step.start) || !Number.isFinite(step.end)) continue;
    const y = clamp(centre - frameHeight * MIDDLE);
    // Two keys per stroke: in place when it starts, in place when it ends. The
    // easing between strokes is the timeline's job, not this function's.
    keys.push({ t: step.start, y });
    keys.push({ t: step.end, y });
  }

  return keys;
}
