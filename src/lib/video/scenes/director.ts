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
import { HERO_IDS, heroCatalogue } from "./heroes";

export const DIRECTOR_SCHEMA = {
  type: "object",
  required: ["scenes"],
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      minItems: 5,
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
          hero: { type: "string", enum: [...HERO_IDS] },
          keyword: { type: "string", maxLength: 40 },
          lead: { type: "string", maxLength: 90 },
        },
      },
    },
  },
} as const;

export const DIRECTOR_SYSTEM = `You are the visual director for a 45-90 second vertical video (1080x1920) built from one passage of a book. The script is already written, approved and recorded. Your only job is to decide WHAT IS ON SCREEN while each sentence is spoken.

You are given the narration cut into numbered sentences, and the book's own words that each sentence's beat is about. Group consecutive sentences into scenes and give each scene one visual.

THE CATALOGUE — every scene must use one of these:

- cinematic — a full-frame cinematic scene: ONE 3D object that stands for the idea being spoken, moving and lit like a film shot, with one keyword set in large type. This is the visual the video is built on. Fields: "hero" (one id from THE HEROES below), "keyword" (the one or two words of the narration that carry the idea, COPIED EXACTLY from it), "lead" (optional: up to six narrated words that lead into the keyword, copied exactly), "concept" (a few words on what the picture means).
- book-page — the real photographed/scanned page, with a marker sweeping the words being discussed. Use when the narration points at what the page SAYS.
- book-crop — the same page, zoomed into the exact lines under discussion. Use for a close reading of one sentence of the book.
- quote — the book's own words, large, on their own. Use ONLY when the narration quotes or closely paraphrases a specific line. Put that line in "quote", copied EXACTLY from the page words you were given. It is checked against the book; a quote that is not found is discarded.
- kinetic-text — the narrated sentence itself, appearing word by word in time with the voice. Use only for a sharp claim or punchline that has no picturable idea.
- icon-concept — one to three simple picture-icons with short labels. "items" are the labels (1-3 words each).
- comparison — two sides, left and right. Use ONLY when the narration actually contrasts two things. "left" and "right" are short labels.
- steps — 2 to 4 ordered items, for a process or short list the narration actually gives.
- growth-curve — a rising line, for compounding or improvement over time.
- timeline — 2 to 4 points in order across time.
- stat — one number, large. Use ONLY when the narration says a specific number that is printed on the page. Put it in "value" exactly as said, and what it measures in "label".

THE HEROES (the "hero" of a cinematic scene — choose by what the sentence MEANS, not by a stray word in it):
${heroCatalogue()}

RULES:
1. Return roughly as many scenes as the user message asks for (never fewer than 5). Every sentence must be covered exactly once, in order: the first scene starts at sentence 0, each next scene starts at the sentence after the previous one ends, the last ends at the final sentence.
2. Scene 0 MUST be cinematic: it is the hook, and the first thing a viewer sees. Choose the hero for the idea of the hook, never a book page. Keep scene 0 to the first one or two sentences.
3. At least 40% of the scenes must be cinematic. Every important concept in the narration gets its own cinematic scene with the hero that matches its meaning. Prefer cinematic over kinetic-text, icon-concept and quote.
4. Show the book too: use AT LEAST 3 scenes that show it (book-page, book-crop or quote), spread through the video, but at most two quote scenes and never two book scenes in a row.
5. Never use the same kind more than twice in a row. Never use the same hero twice in a row, and no hero more than twice in the whole video. Use "orb" only when nothing else fits.
6. Use icon-concept at most twice. Use comparison, steps, timeline, growth-curve or stat only when the narration REALLY does that; otherwise choose cinematic.
7. Invent nothing. Every keyword, lead, label, item, side, step and number must come from what the narration or the page actually says.

"concept" is WHAT TO SHOW, not what it means — a phrase that describes a picture. Two to six words, concrete, no abstractions.

"reason" is one short sentence saying why this visual fits this narration.`;

export function buildDirectorPrompt(
  bookTitle: string,
  sentences: Sentence[],
  pageWords: Map<number, string[]>,
  suggestedScenes: number,
  hook?: string,
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
    ...(hook ? [`The hook (what scene 0 is about): ${hook}`] : []),
    ``,
    `THE NARRATION, sentence by sentence:`,
    ...lines,
    ``,
    `THE BOOK'S OWN WORDS that these sentences are about (a "quote" scene must copy from here, exactly):`,
    ...cited,
  ].join("\n");
}
