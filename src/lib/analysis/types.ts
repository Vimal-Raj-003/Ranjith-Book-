/**
 * The data a book PDF becomes on its way to a shortlist of video ideas.
 *
 *   PDF → RawPdfPage[] → StructuredPage[] → SectionPlan[] → ChunkPlan[]
 *       → AnalysisWindow[] → Candidate[] → ScoredCandidate[] → SelectedIdea[]
 *
 * The one invariant every stage keeps: a word is always addressable as
 * (pageIndex, wordIndex) where wordIndex indexes `wordsOf(page.text)`. That is
 * the coordinate system `Beat.sourcePage/startWord/endWord` already uses, so an
 * idea found here can be handed to the existing script writer, grounding check
 * and highlighter without translation.
 *
 * Types only — nothing here is emitted.
 */
import type { PageText } from "../ingest/vision";
import type { AlignedWord } from "../ingest/align";

/** A run of words on one page: `wordsOf(page)[startWord..endWord]`, inclusive. */
export interface SourceRef {
  pageIndex: number;
  startWord: number;
  endWord: number;
}

// --- Extraction -------------------------------------------------------------

/** [x0, y0, x1, y1, text, block, line, wordNo], pixel space of the page image. */
export type RawWord = [number, number, number, number, string, number, number, number];

export interface RawLine {
  text: string;
  size: number;
  bold: boolean;
  chars: number;
  box: [number, number, number, number];
}

/** One page exactly as `extract.py` wrote it. */
export interface RawPdfPage {
  index: number;
  label: string;
  image: string;
  width: number;
  height: number;
  words: RawWord[];
  lines: RawLine[];
  imageCount: number;
  imageCoverage: number;
}

export interface TocEntry {
  level: number;
  title: string;
  /** 0-based page index; -1 when the outline entry points nowhere. */
  page: number;
}

export interface RawPdfManifest {
  pageCount: number;
  toc: TocEntry[];
  metadata: { title: string | null; author: string | null };
}

export type TextSource = "text-layer" | "ocr" | "vision" | "none";

/** A heading found on a page, from font size or a "Chapter N" pattern. */
export interface PageHeading {
  text: string;
  /** Font size relative to the book's body size; 1 when unknown (OCR). */
  scale: number;
  /** Top of the heading as a share of page height, 0 = top edge. */
  top: number;
}

/** A page after cleanup: running heads stripped, headings lifted out. */
export interface StructuredPage {
  pageIndex: number;
  label: string | null;
  text: PageText;
  /** `wordsOf(text)`, cached — every index in the pipeline points into this. */
  words: string[];
  alignment: AlignedWord[];
  alignmentConfidence: number;
  headings: PageHeading[];
  source: TextSource;
  ocrConfidence: number | null;
}

// --- Structure --------------------------------------------------------------

export interface SectionPlan {
  index: number;
  title: string;
  level: number;
  startPage: number;
  endPage: number;
  source: "toc" | "heading" | "fallback";
  /** Front or back matter — never mined for ideas. */
  skip: boolean;
  wordCount: number;
}

export interface ChunkPlan {
  index: number;
  sectionIndex: number;
  spans: SourceRef[];
  text: string;
  wordCount: number;
  startPage: number;
  endPage: number;
}

/** A few thousand words handed to the model in one call. */
export interface AnalysisWindow {
  index: number;
  chunkIndices: number[];
  sectionIndices: number[];
  pages: number[];
  wordCount: number;
}

// --- Ideas ------------------------------------------------------------------

/** How strongly an idea scores on each thing a good video needs, 1–10. */
export interface IdeaScores {
  viewerUsefulness: number;
  educationalValue: number;
  hookPotential: number;
  storyPotential: number;
  practicalValue: number;
  emotionalInterest: number;
  uniqueness: number;
  youtubeSuitability: number;
  visualPotential: number;
}

export const SCORE_KEYS: (keyof IdeaScores)[] = [
  "viewerUsefulness",
  "educationalValue",
  "hookPotential",
  "storyPotential",
  "practicalValue",
  "emotionalInterest",
  "uniqueness",
  "youtubeSuitability",
  "visualPotential",
];

/** A proposed idea whose quotes were found in the book. */
export interface Candidate {
  id: string;
  windowIndex: number;
  title: string;
  coreIdea: string;
  hook: string;
  whyItMatters: string;
  angle: string;
  hookPotential: string;
  storyPotential: string;
  practicalValue: string;
  visualPotential: string;
  /** The model's own 1–10 read of this idea, used only if ranking fails. */
  strength: number;
  refs: SourceRef[];
  /** The cited words as they appear in the book — never the model's copy. */
  quotes: string[];
  sectionIndex: number;
}

export interface ScoredCandidate extends Candidate {
  scores: IdeaScores;
  score: number;
  /** The id of a candidate the ranker judged to be the same idea, if any. */
  duplicateOf: string | null;
}

export interface SelectedIdea extends ScoredCandidate {
  rank: number;
  ideaKey: string;
  relatedPages: number[];
}

export interface AnalysisStats {
  pages: number;
  ocrPages: number;
  visionPages: number;
  sections: number;
  chunks: number;
  windows: number;
  windowsFailed: number;
  proposed: number;
  ungrounded: number;
  duplicates: number;
  selected: number;
  embeddings: boolean;
}
