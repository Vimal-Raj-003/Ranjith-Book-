/**
 * The scene model: what is on screen, when, and what in the book it came from.
 *
 *   narration + word timings  →  Sentence[]      (plan.ts, from real audio)
 *                             →  SceneSpec[]     (director.ts, one model call)
 *                             →  Scene[]         (validate.ts, grounded + repaired)
 *                             →  composition     (render/, one layer per scene)
 *
 * Every scene carries the beat, the sentence and the page words it came from,
 * so a finished frame can always be traced back to the text that justifies it
 * — the same rule `Beat.sourcePage/startWord/endWord` already holds the script
 * to. Types only; nothing here is emitted.
 */
import type { SourceRef } from "../../analysis/types";

/** One spoken sentence, cut from the 3B word timings. */
export interface Sentence {
  index: number;
  text: string;
  /** Real start/end in the voice track's clock. */
  start: number;
  end: number;
  beatIndex: number;
  /** The beat's cited page and word range — what this sentence is "about". */
  sourcePage: number;
  startWord: number;
  endWord: number;
  /** Word times, for kinetic text. */
  words: { word: string; start: number; end: number }[];
}

/**
 * The visual vocabulary. Every value is a template with its own renderer; the
 * director may only choose from these, and an unknown value is refused rather
 * than guessed at.
 */
export const VISUAL_KINDS = [
  "book-page",
  "book-crop",
  "quote",
  "kinetic-text",
  "icon-concept",
  "comparison",
  "steps",
  "growth-curve",
  "timeline",
  "stat",
] as const;

export type VisualKind = (typeof VISUAL_KINDS)[number];

/**
 * Which templates count as showing the book, for the "the book stays
 * recognisable" floor. A `quote` counts: it is the book's own words with its
 * page cited.
 */
export const BOOK_KINDS: VisualKind[] = ["book-page", "book-crop", "quote"];

/**
 * Which templates actually put the PAGE CARD on screen. A `quote` does not —
 * it renders the book's words on its own layer — so the card is faded out
 * under it, exactly as it is under any other layer.
 */
export const PAGE_KINDS: VisualKind[] = ["book-page", "book-crop"];

/**
 * What the director returns for one scene, before validation. Every field
 * beyond `kind` is optional because each template uses a different few; the
 * validator is what insists on the ones its template actually needs.
 */
export interface SceneSpec {
  fromSentence: number;
  toSentence: number;
  kind: VisualKind;
  /** Why this visual fits this narration — kept for the record, never shown. */
  reason?: string;
  /** The idea in 2–5 words, used to pick icons and as a heading. */
  concept?: string;
  /** `quote`: the book's own words, checked against the page before use. */
  quote?: string;
  /** `stat`: the number as printed, checked against the source text. */
  value?: string;
  /** `stat`, `growth-curve`: what the number or curve is of. */
  label?: string;
  /** `icon-concept`: 1–3 short labels, one per icon. */
  items?: string[];
  /** `comparison`: the two sides. */
  left?: string;
  right?: string;
  /** `steps`, `timeline`: 2–4 ordered entries. */
  steps?: string[];
}

/** A scene's background mood, which drives the backdrop glow. */
export type SceneTone = "neutral" | "warm" | "cool" | "bright" | "deep";

/** One resolved icon: its name and the raw SVG path markup, theme-coloured. */
export interface SceneIcon {
  name: string;
  /** The `<path>` elements from Tabler's 24×24 outline icon. */
  paths: string;
  /** What it was matched against, and how closely (0–1). Kept for the record. */
  query: string;
  score: number;
}

/**
 * A validated scene, ready to render. `kind` is guaranteed to be a template
 * that exists, and every field its template needs is guaranteed present.
 */
export interface Scene {
  index: number;
  kind: VisualKind;
  /** Real seconds in the voice track's clock. Contiguous across scenes. */
  start: number;
  end: number;
  tone: SceneTone;
  /** Sentences this scene covers. */
  sentences: number[];
  /** The beat(s) the sentences belong to. */
  beatIndex: number;
  /** Where in the book this scene is grounded. */
  source: SourceRef;
  /** Why this visual, for the record and for tests. */
  reason: string;
  concept: string;
  /** Set when the validator replaced what the director asked for. */
  fallbackFrom?: VisualKind;

  // --- per-template content, all resolved and checked ---------------------
  /** `quote`: the words as the book prints them, plus the page they are on. */
  quote?: { text: string; page: number };
  /** `book-crop`: the region of the page to fill the card with, in column pixels. */
  crop?: { x0: number; y0: number; x1: number; y1: number };
  /** `kinetic-text`: the words with their real spoken times. */
  words?: { word: string; start: number; end: number }[];
  /** `icon-concept`, `comparison`, `steps`, `timeline`: resolved icons. */
  icons?: SceneIcon[];
  items?: string[];
  left?: string;
  right?: string;
  steps?: string[];
  stat?: { value: string; label: string };
  curve?: { points: number[]; label: string };
}

/** What the validator did, for the episode's notes and for tests. */
export interface ScenePlanReport {
  scenes: Scene[];
  /** One line per repair or refusal, in scene order. */
  notes: string[];
  /** Counts by template, for the repetition rules. */
  used: Record<string, number>;
}
