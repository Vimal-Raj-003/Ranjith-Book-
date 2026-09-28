/**
 * Step one of finding ideas: each window of the book (a few thousand words)
 * is read by the model on its own and asked for the ideas in it that could
 * carry a 1–2 minute video. The windows are independent, so they run in
 * parallel and a failure costs one window, not the book.
 *
 * The prompt asks for ideas, not a summary: a chapter summary is the one thing
 * a viewer will not stop scrolling for. Every idea must quote the passage, and
 * the quotes are then found in the page words by `locateQuote` — see there for
 * why that is the grounding check rather than a formality.
 */
import { locateQuote, mergeRefs, refText, tokenStream, MIN_QUOTE_WORDS } from "./quotes";
import { sectionOfPage } from "./sections";
import type { AnalysisWindow, Candidate, ChunkPlan, SectionPlan, StructuredPage } from "./types";

export const CANDIDATE_SCHEMA = {
  type: "object",
  required: ["ideas"],
  additionalProperties: false,
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        required: [
          "title", "coreIdea", "hook", "whyItMatters", "angle",
          "hookPotential", "storyPotential", "practicalValue", "visualPotential",
          "strength", "quotes",
        ],
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          coreIdea: { type: "string" },
          hook: { type: "string" },
          whyItMatters: { type: "string" },
          angle: {
            type: "string",
            enum: [
              "counterintuitive-insight", "practical-technique", "story", "surprising-fact",
              "mental-model", "common-mistake", "framework", "emotional-truth", "other",
            ],
          },
          hookPotential: { type: "string" },
          storyPotential: { type: "string" },
          practicalValue: { type: "string" },
          visualPotential: { type: "string" },
          strength: { type: "integer", minimum: 1, maximum: 10 },
          quotes: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              required: ["page", "text"],
              additionalProperties: false,
              properties: { page: { type: "integer" }, text: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

export const CANDIDATE_SYSTEM = `You are a senior editor who turns non-fiction books into short educational videos for YouTube Shorts and Reels (60 to 120 seconds each).

You are given ONE passage of a book, split into pages marked "=== PAGE n ===". Find the ideas in THIS passage that could each carry a standalone, engaging 1-2 minute video.

What makes a good idea:
- A viewer learns something useful, surprising or moving in under two minutes.
- It has a hook: a claim, question, tension or story that makes someone stop scrolling.
- It stands on its own, without having read the rest of the book.
- It is specific: one insight, technique, story, finding or mental model — not a theme.

Do NOT:
- Summarise the passage or a chapter. "Chapter 3 explains habits" is not an idea.
- Invent anything. Every idea must be stated or clearly shown in THIS passage.
- Propose two ideas that are really the same point in different words.
- Pick tables of contents, acknowledgements, indexes, or bibliographies.
- Name or guess the author. Refer to "the book" instead.

For each idea give:
- title: a short, honest video title (max 70 characters). Intriguing, never clickbait the passage cannot back up.
- coreIdea: the idea itself in one or two plain sentences.
- hook: the opening line a narrator would say, max 20 words.
- whyItMatters: one sentence on why a viewer should care.
- angle: which kind of idea this is.
- hookPotential, storyPotential, practicalValue, visualPotential: one short sentence each. For visualPotential, say what could be SHOWN on screen (a diagram, a process, a comparison, a scene).
- strength: 1-10, how good a standalone video this would be.
- quotes: 1 to 3 passages copied EXACTLY, word for word, from the pages, each 8 to 40 words, with the PAGE number it appears on. Copy the text as printed; do not paraphrase, shorten with ellipses, or fix wording. These quotes are checked against the book, and an idea whose quotes are not found is discarded.

If the passage contains nothing video-worthy (front matter, a list of references, pure transition), return {"ideas": []}. Quality matters more than quantity.`;

export function windowPrompt(
  window: AnalysisWindow,
  chunks: ChunkPlan[],
  pages: StructuredPage[],
  sections: SectionPlan[],
  bookTitle: string,
  maxIdeas: number,
): string {
  // Rebuild the passage page by page from the chunks' spans, so the model sees
  // exactly the words that quotes are later searched in.
  const byPage = new Map<number, { start: number; end: number }>();
  for (const ci of window.chunkIndices) {
    for (const s of chunks[ci].spans) {
      const cur = byPage.get(s.pageIndex);
      if (cur) {
        cur.start = Math.min(cur.start, s.startWord);
        cur.end = Math.max(cur.end, s.endWord);
      } else byPage.set(s.pageIndex, { start: s.startWord, end: s.endWord });
    }
  }

  let lastSection = -1;
  const parts: string[] = [];
  for (const [pageIndex, { start, end }] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const section = sectionOfPage(sections, pageIndex);
    if (section && section.index !== lastSection) {
      parts.push(`\n### Section: ${section.title}`);
      lastSection = section.index;
    }
    parts.push(`=== PAGE ${pageIndex + 1} ===\n${pages[pageIndex].words.slice(start, end + 1).join(" ")}`);
  }

  return `Book: ${bookTitle}

Return at most ${maxIdeas} ideas from this passage — fewer if fewer are genuinely good.

${parts.join("\n\n")}`;
}

/** How many ideas to ask each window for, so the whole book yields a healthy pool. */
export function ideasPerWindow(windowCount: number): number {
  return Math.max(3, Math.min(8, Math.ceil(48 / Math.max(1, windowCount))));
}

interface RawIdea {
  title?: unknown;
  coreIdea?: unknown;
  hook?: unknown;
  whyItMatters?: unknown;
  angle?: unknown;
  hookPotential?: unknown;
  storyPotential?: unknown;
  practicalValue?: unknown;
  visualPotential?: unknown;
  strength?: unknown;
  quotes?: unknown;
}

const str = (v: unknown, max = 600): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export interface GroundResult {
  candidates: Candidate[];
  proposed: number;
  ungrounded: number;
}

/**
 * Validate a window's reply and ground each idea in the book. An idea is kept
 * only if it has a title and a core idea and at least one of its quotes is
 * found in this window's pages. Quotes that are not found are dropped from an
 * idea that is otherwise grounded, never "repaired".
 */
export function groundCandidates(
  reply: unknown,
  window: AnalysisWindow,
  pages: StructuredPage[],
  sections: SectionPlan[],
): GroundResult {
  const ideas: RawIdea[] =
    reply && typeof reply === "object" && Array.isArray((reply as { ideas?: unknown }).ideas)
      ? ((reply as { ideas: RawIdea[] }).ideas)
      : Array.isArray(reply)
        ? (reply as RawIdea[])
        : [];

  const stream = tokenStream(pages, window.pages);
  const candidates: Candidate[] = [];
  let ungrounded = 0;

  ideas.forEach((idea, i) => {
    const title = str(idea?.title, 120);
    const coreIdea = str(idea?.coreIdea);
    if (!title || !coreIdea) {
      ungrounded++;
      return;
    }
    const quotes = Array.isArray(idea.quotes) ? idea.quotes : [];
    const found = quotes
      .map((q) => {
        const text = str((q as { text?: unknown })?.text, 1200);
        const page = Number((q as { page?: unknown })?.page);
        if (text.split(/\s+/).length < MIN_QUOTE_WORDS) return null;
        return locateQuote(text, stream, pages, Number.isFinite(page) ? page - 1 : undefined);
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);

    if (found.length === 0) {
      ungrounded++;
      return;
    }

    const refs = mergeRefs(found.flatMap((q) => q.refs));
    const section = sectionOfPage(sections, refs[0].pageIndex);
    const strength = Number(idea.strength);
    candidates.push({
      id: `w${window.index}-${i}`,
      windowIndex: window.index,
      title,
      coreIdea,
      hook: str(idea.hook, 240),
      whyItMatters: str(idea.whyItMatters),
      angle: str(idea.angle, 40) || "other",
      hookPotential: str(idea.hookPotential),
      storyPotential: str(idea.storyPotential),
      practicalValue: str(idea.practicalValue),
      visualPotential: str(idea.visualPotential),
      strength: Number.isFinite(strength) ? Math.max(1, Math.min(10, Math.round(strength))) : 5,
      refs,
      // One passage per merged ref, so overlapping or adjacent quotes read
      // once, in book order — and `sourceText` always equals what `refs` cite.
      quotes: refs.map((r) => refText([r], pages)),
      sectionIndex: section?.index ?? 0,
    });
  });

  return { candidates, proposed: ideas.length, ungrounded };
}
