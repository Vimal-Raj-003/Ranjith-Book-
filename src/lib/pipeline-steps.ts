/**
 * The full, ordered set of stage names each pipeline runs through.
 *
 * This module has NO imports and touches NOTHING server-only (no sharp, no
 * tesseract, no child_process, no Prisma). It exists so that `PipelineRail.tsx`
 * — a `"use client"` component — can import the real step names without
 * dragging the entire server pipeline (`./pipeline.ts`, which imports sharp,
 * the CLI spawner, ffmpeg, etc.) into the browser bundle. `pipeline.ts`
 * re-exports these so server code keeps a single source of truth too.
 */
export const INGEST_STEPS = [
  "Reading the pages",
  "Measuring the pages",
  "Aligning text to geometry",
  "Identifying the book",
  "Planning the episodes",
] as const;

export const EPISODE_STEPS = [
  "Reserving the idea",
  "Writing the script",
  "Grounding check",
  "Preparing page assets",
  "Recording the voiceover",
  "Timing the captions",
  "Planning the scenes",
  "Building the composition",
  "Checking the composition",
  "Rendering the video",
] as const;

export const STEPS = [...INGEST_STEPS, ...EPISODE_STEPS];

/**
 * A book PDF's run, from upload to a shortlist of video ideas. Separate from
 * `STEPS` on purpose: a PDF analysis ends in ideas, not in an episode, so its
 * rail is its own five stages rather than a prefix of the fourteen above.
 */
export const ANALYSIS_STEPS = [
  "Extracting the PDF",
  "Running OCR",
  "Analyzing the book",
  "Finding content ideas",
  "Ranking the ideas",
] as const;
