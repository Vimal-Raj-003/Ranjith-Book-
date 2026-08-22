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
  "Building the composition",
  "Checking the composition",
  "Rendering the video",
] as const;

export const STEPS = [...INGEST_STEPS, ...EPISODE_STEPS];
