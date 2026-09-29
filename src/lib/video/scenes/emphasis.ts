/**
 * Which words in a spoken sentence deserve visual weight, and why.
 *
 * Kinetic text (`render.ts`'s `kineticText`) already puts every word on
 * screen at its own measured spoken time; this decides which of those words
 * get a LARGER, coloured, snappier arrival instead of the plain one every
 * other word gets — "important concepts", not every word, per the visual
 * spec this exists for.
 *
 * Deliberately conservative and purely lexical: no model call, no network,
 * the same word classified the same way on every run (a director call is
 * already the one non-deterministic step in this pipeline, and it is not
 * this file's job to add a second one). A word that matches nothing here is
 * just a word — most of every sentence, which is the point: constant
 * emphasis reads as no emphasis at all.
 */

export type EmphasisCategory = "time" | "money" | "growth" | "problem" | "solution" | "people" | "tech" | "number";

/** One category's own words. Matched whole-word, case-insensitively, against the STEM (see `stem` below). */
const CATEGORY_WORDS: Record<EmphasisCategory, string[]> = {
  time: ["time", "hour", "minute", "day", "week", "year", "moment", "deadline", "schedule", "clock", "calendar", "century", "decade", "season"],
  money: ["money", "dollar", "cost", "price", "wealth", "income", "profit", "cash", "fund", "budget", "expense", "salary", "revenue", "debt", "savings"],
  growth: ["grow", "growth", "increase", "rise", "compound", "improve", "progress", "gain", "scale", "expand", "climb", "build", "momentum", "trend"],
  problem: ["problem", "fail", "failure", "mistake", "struggle", "crisis", "risk", "danger", "obstacle", "trap", "broken", "wrong", "difficult", "hard", "block"],
  solution: ["solution", "solve", "fix", "answer", "key", "secret", "method", "strategy", "trick", "way", "works", "breakthrough", "discover"],
  people: ["people", "person", "friend", "family", "team", "relationship", "community", "others", "everyone", "someone", "together", "connection"],
  tech: ["technology", "computer", "software", "internet", "digital", "ai", "algorithm", "machine", "data", "app", "device", "automation"],
  number: [],
};

/**
 * Strip punctuation and a trailing suffix: "grows" → "grow", "growing" →
 * "grow", "money." → "money" — a word from a real spoken sentence carries
 * its sentence punctuation, and a category match must not miss "money"
 * just because it happened to end that sentence.
 */
function stem(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(ing|edly|edness|ed|es|s)$/, "");
}

/** A bare number, a percentage, or a currency amount — "87", "87%", "$4,000", "3x". */
const NUMBER_PATTERN = /^[$]?\d[\d,]*(\.\d+)?[%x]?$/i;

/** Words too short or too common to ever carry emphasis on their own, however they stem. */
const NEVER_EMPHASIZE = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "in", "on", "at", "it", "its", "and", "or", "but"]);

export interface WordEmphasis {
  category: EmphasisCategory;
  /** A short phrase describing the picture this word calls to mind, in the
   *  same style `director.ts`'s "concept" already uses — reusable as an icon
   *  query by a caller that wants one, never resolved by this module itself. */
  visual: string;
}

const VISUAL_BY_CATEGORY: Record<EmphasisCategory, string> = {
  time: "a clock and calendar",
  money: "coins and a wallet",
  growth: "a rising line chart",
  problem: "a warning sign",
  solution: "a light bulb turning on",
  people: "two people together",
  tech: "a computer chip",
  number: "a bold number",
};

/**
 * Classify one word from a spoken sentence. Returns null for the ordinary
 * case — most words — so a caller can filter with `.filter(Boolean)` rather
 * than checking a boolean field on every one.
 */
export function classifyEmphasis(rawWord: string): WordEmphasis | null {
  const cleaned = rawWord.trim();
  if (!cleaned || NEVER_EMPHASIZE.has(cleaned.toLowerCase())) return null;

  if (NUMBER_PATTERN.test(cleaned)) {
    return { category: "number", visual: VISUAL_BY_CATEGORY.number };
  }

  const s = stem(cleaned);
  if (s.length < 3) return null;

  for (const category of Object.keys(CATEGORY_WORDS) as EmphasisCategory[]) {
    if (category === "number") continue;
    for (const candidate of CATEGORY_WORDS[category]) {
      if (s === candidate || (candidate.length > 3 && s === stem(candidate))) {
        return { category, visual: VISUAL_BY_CATEGORY[category] };
      }
    }
  }
  return null;
}

/**
 * Emphasis for a run of words, capped so a sentence dense with matches still
 * reads as occasional emphasis rather than every third word jumping — the
 * "do not animate every word" rule, enforced here rather than trusted to
 * `classifyEmphasis` callers to apply consistently.
 *
 * At most one emphasis per `MIN_GAP` words, so two matches sitting next to
 * each other ("time and money") do not both light up as one visual event.
 */
const MIN_GAP = 3;

export function emphasizeWords(words: string[]): (WordEmphasis | null)[] {
  const out: (WordEmphasis | null)[] = new Array(words.length).fill(null);
  let sinceLast = MIN_GAP;
  for (let i = 0; i < words.length; i++) {
    sinceLast++;
    if (sinceLast < MIN_GAP) continue;
    const hit = classifyEmphasis(words[i]);
    if (hit) {
      out[i] = hit;
      sinceLast = 0;
    }
  }
  return out;
}
