import type { StepTiming } from "./PipelineRail";

/**
 * The shapes the client binds to. Types only — nothing here is emitted, so it
 * is safe to import from `"use client"` components.
 *
 * Fields marked optional are ones the API does not return *yet* (the thumbnail
 * work and the caption fields are landing separately). Every consumer must
 * render something sensible when they are absent rather than assuming them.
 */

/** One rendered thumbnail. `GET /api/episodes/[id]/thumbnail/[key]` serves it. */
export interface ThumbnailRef {
  key: string;
  aspect: string;
  variant: string;
  width: number;
  height: number;
}

/** `GET /api/episodes/[id]` — polled while a run is live. */
export interface EpisodeState {
  id: string;
  bookTitle: string;
  title: string | null;
  status: string;
  step: string;
  error: string | null;
  notes: string[];
  partNumber: number;
  seriesTotal: number;
  hasVideo: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalMs: number | null;
  /** Per-step timings from `GET /api/episodes/[id]`. Absent on the list
   *  endpoint, which does not carry them. */
  steps?: StepTiming[];
  durationSec?: number | null;
  /** Added by the thumbnail workstream; absent until then. */
  thumbnails?: ThumbnailRef[];
  /** Caption copy, once the route returns it. */
  hook?: string | null;
  description?: string | null;
  hashtags?: string[];
  cta?: string | null;
}

/** `GET /api/episodes` — the library list. */
export interface EpisodeSummary {
  id: string;
  title: string | null;
  status: string;
  step: string;
  theme: string;
  partNumber: number;
  seriesTotal: number;
  durationSec: number | null;
  createdAt: string;
  bookTitle: string;
  thumbnails?: ThumbnailRef[];
}

export type View = "studio" | "library" | "free-books" | "queue";
