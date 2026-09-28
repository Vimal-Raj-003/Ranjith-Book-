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
  /** photo | idea. Absent from rows served before idea episodes existed. */
  kind?: string;
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

export type View = "studio" | "books" | "library" | "free-books" | "queue";

// --- Book PDFs -------------------------------------------------------------
// Built by `src/lib/analysis/view.ts` for `GET /api/books` and `/api/books/[id]`.

export interface IdeaSourcePage {
  /** 1-based position in the PDF. */
  number: number;
  /** The number printed on the page, when it differs from `number`. */
  label: string | null;
  pageId: string | null;
}

export interface IdeaView {
  id: string;
  rank: number;
  title: string;
  hook: string;
  coreIdea: string;
  whyItMatters: string;
  angle: string;
  hookPotential: string;
  storyPotential: string;
  practicalValue: string;
  visualPotential: string;
  sectionTitle: string | null;
  sourcePages: IdeaSourcePage[];
  relatedPages: number[];
  sourceText: string;
  selected: boolean;
  /** The idea's latest video, if one has been generated. Polled for detail via
   *  `GET /api/episodes/[id]`. */
  episode: { id: string; status: string } | null;
}

export interface AnalysisView {
  id: string;
  bookTitle: string;
  status: string;
  step: string;
  error: string | null;
  progress: { label: string; done: number; total: number } | null;
  notes: string[];
  pageCount: number | null;
  stats: Record<string, number | boolean> | null;
  ideas: IdeaView[];
  createdAt: string;
}

export interface AnalysisSummary {
  id: string;
  bookTitle: string;
  status: string;
  step: string;
  pageCount: number | null;
  ideaCount: number;
  createdAt: string;
}
