/**
 * One model call: which visual carries each stretch of the narration.
 *
 * The director sees the approved script cut into sentences, and the page words
 * each sentence's beat cites. It returns one scene per run of sentences, each
 * naming a template from the catalogue and the content that template needs.
 *
 * It is asked for two different things and the distinction is the whole point:
 * `concept` is what should be SHOWN ("a barrier blocking a path"), not what the
 * narration MEANS ("the obstacle is the way"). Icons are matched by embedding
 * that phrase against Tabler's tag text, so an abstract phrase finds nothing
 * and a visual one finds the right picture — measured, not assumed.
 *
 * Nothing it returns is trusted: `validate.ts` checks every quote against the
 * page, every number against the source text, and replaces anything that fails
 * with a template that cannot be wrong about meaning.
 */
import { VISUAL_KINDS } from "./types";
import type { Sentence } from "./types";

export const DIRECTOR_SCHEMA = {
  type: "object",
  required: ["scenes"],
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      minItems: 6,
      maxItems: 18,
      items: {
        type: "object",
        required: ["fromSentence", "toSentence", "kind", "concept", "reason"],
        additionalProperties: false,
        properties: {
          fromSentence: { type: "integer", minimum: 0 },
          toSentence: { type: "integer", minimum: 0 },
          kind: { type: "string", enum: [...VISUAL_KINDS] },
          concept: { type: "string", maxLength: 80 },
          reason: { type: "string", maxLength: 200 },
          quote: { type: "string", maxLength: 300 },
          value: { type: "string", maxLength: 24 },
          label: { type: "string", maxLength: 60 },
          items: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 40 } },
          left: { type: "string", maxLength: 40 },
          right: { type: "string", maxLength: 40 },
          steps: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", maxLength: 48 } },
        },
      },
    },
  },
} as const;

export const DIRECTOR_SYSTEM = `You are the visual director for a 1-2 minute vertical video (1080x1920) built from one passage of a book. The script is already written, approved and recorded. Your only job is to decide WHAT IS ON SCREEN while each sentence is spoken.

You are given the narration cut into numbered sentences, and the book's own words that each sentence's beat is about. Group consecutive sentences into scenes and give each scene one visual.

THE CATALOGUE — every scene must use one of these:

- book-page — the real photographed/scanned page, scrolling, with a marker sweeping the words being discussed. Use when the narration points at what the page SAYS.
- book-crop — the same page, zoomed into the exact lines under discussion. Use for a close reading of one sentence of the book.
- quote — the book's own words, large, on their own. Use ONLY when the narration quotes or closely paraphrases a specific line. Put that line in "quote", copied EXACTLY from the page words you were given. It is checked against the book; a quote that is not found is discarded.
- kinetic-text — the narrated sentence itself, appearing word by word in time with the voice. Use for a sharp claim, a turn, a punchline. Always safe.
- icon-concept — one to three simple picture-icons with short labels. Use for a concrete idea that can be pictured. "items" are the labels (1-3 words each).
- comparison — two sides, left and right. Use ONLY when the narration actually contrasts two things. "left" and "right" are short labels.
- steps — 2 to 4 ordered items. Use for a process, a sequence, or a short list the narration actually gives.
- growth-curve — a rising line. Use for compounding, accumulation, improvement over time.
- timeline — 2 to 4 points in order across time. Use for before/after or a progression through time.
- stat — one number, large. Use ONLY when the narration says a specific number that is printed on the page. Put it in "value" exactly as said, and what it measures in "label".

RULES:
1. Return between 8 and 15 scenes. Every sentence must be covered exactly once, in order: the first scene starts at sentence 0, each next scene starts at the sentence after the previous one ends, the last ends at the final sentence.
2. Use AT LEAST 3 scenes that show the book (book-page, book-crop or quote), spread through the video — this is a video about a book and it must stay recognisable.
3. Never use the same kind more than twice in a row. Vary deliberately.
4. Only use comparison, steps, timeline, growth-curve or stat when the narration REALLY does that. A "steps" scene over narration that lists nothing is worse than kinetic-text. If in doubt, choose kinetic-text or a book scene.
5. Invent nothing. Every label, item, side, step and number must come from what the narration or the page actually says.

"concept" is WHAT TO SHOW, not what it means — a phrase that describes a picture, because it is used to find an icon. Write "a barrier blocking a path", "a clock and calendar", "a growing line chart", "stairs going up" — not "the obstacle is the way" or "compounding returns". Two to six words, concrete, no abstractions.

"reason" is one short sentence saying why this visual fits this narration.`;

export function buildDirectorPrompt(
  bookTitle: string,
  sentences: Sentence[],
  pageWords: Map<number, string[]>,
  suggestedScenes: number,
): string {
  const lines = sentences.map((s) => {
    const secs = `${s.start.toFixed(1)}-${s.end.toFixed(1)}s`;
    return `[${s.index}] (${secs}, beat ${s.beatIndex + 1}, page ${s.sourcePage + 1}) ${s.text}`;
  });

  // The cited words of each page, once — what a `quote` scene must copy from.
  const cited: string[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    const key = `${s.sourcePage}:${s.startWord}:${s.endWord}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const words = pageWords.get(s.sourcePage);
    if (!words) continue;
    const text = words.slice(s.startWord, s.endWord + 1).join(" ");
    if (text.trim()) cited.push(`PAGE ${s.sourcePage + 1}, words ${s.startWord}-${s.endWord}:\n"${text}"`);
  }

  return [
    `Book: ${bookTitle}`,
    `Aim for about ${suggestedScenes} scenes.`,
    ``,
    `THE NARRATION, sentence by sentence:`,
    ...lines,
    ``,
    `THE BOOK'S OWN WORDS that these sentences are about (a "quote" scene must copy from here, exactly):`,
    ...cited,
  ].join("\n");
}
