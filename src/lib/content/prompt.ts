import type { GenerateInput } from "./schema";

/**
 * Stated once, up front, in its own unmissable block rather than folded into
 * "voice rules" — this is the one rule the whole product depends on, both
 * legally and creatively.
 *
 * Legally: narrating an in-copyright book's own sentences at length is an
 * audiobook of someone else's work, not commentary about it, and both
 * YouTube and Instagram act on exactly that pattern. Creatively: a video that
 * just reads the page aloud is also the less interesting video — the format
 * that performs is the writer's take on why the passage matters, not a
 * recitation of it.
 */
const TRANSFORMATIVE_RULE = `THIS IS COMMENTARY, NOT A READING. THIS IS NOT OPTIONAL.

The viewer sees the real photographed page scrolling behind you, with a
yellow marker sweeping the words you are discussing. Your job is to write
YOUR OWN sentences about what the page says — the idea, the stakes, why it
matters, what it costs to ignore — not to narrate the page's own words back
to the viewer.

You may quote the page directly ONCE across the whole script, for at most 25
words, and only where the author's exact wording is the point (a striking
phrase, a line the whole beat turns on). Every other beat is entirely your
own sentences ABOUT the passage. If you catch yourself stringing together
more than a handful of consecutive words straight from the page outside that
one allowed quote, stop and rewrite it as commentary instead.

This is both a legal requirement — reading an in-copyright book's prose at
length is an unlicensed audiobook, and YouTube and Instagram will act on it —
and the reason the format works at all. Nobody stays for a page being read to
them. They stay for someone explaining why it matters.`;

/**
 * The word-index contract, isolated in its own block because it is the
 * highest-risk part of the output: nothing downstream validates that these
 * indices are correct, only that they are non-negative integers. An
 * ambiguous instruction here is the single likeliest way this task produces
 * a video where the marker highlights the wrong words while the voice talks
 * about something else.
 */
const INDEX_RULE = `EVERY BEAT MUST NAME THE EXACT WORDS IT IS ABOUT.

The user message numbers every word of every page you were given, like
"0:The 1:first 2:sentence.". Those numbers are word indices — zero-based,
counting from the start of that one page's word list, restarting at 0 on
each new page.

For every beat:
- sourcePage is the page number (labelled "PAGE n" in the user message) that
  beat is actually discussing. Do not name a page you are not talking about.
- startWord is the index of the FIRST word on that page your commentary is
  about — read the numbered words around it and pick the real one, never a
  round number or a guess.
- endWord is the index of the LAST such word. It must be greater than or
  equal to startWord — startWord and endWord run forward through the
  passage, never backward.
- Both indices must be numbers that actually appear in the numbered word
  list for that page. Do not invent an index past the last number you were
  shown.
- When two beats in a row discuss the same page, their word ranges should
  themselves move forward (later beats pointing at later words), matching
  the order you actually talk about the passage in.
- A SINGLE BEAT MAY ONLY COVER WORDS ON ONE PAGE. If the idea you are
  discussing continues onto the next page, do NOT write one beat whose
  commentary draws on both — write two consecutive beats instead, split
  exactly at the page boundary: the first beat's sourcePage and word range
  cover only the words on the earlier page, and the second beat's sourcePage
  and word range cover only the words on the next page. Never let a beat's
  voiceover depend on text from a page other than the single page its
  sourcePage and word range name.

- THE LAST BEAT IS THE CALL TO ACTION, and it is the one exception to every
  rule above. It asks the viewer to do something rather than discussing the
  page, so there are no words it is "about" and no range can honestly describe
  it. Point its sourcePage and word range at the passage its ask grows out of
  - normally the same passage the beat before it just covered - and keep it
  in bounds and moving forward like any other. Do not hunt for a better match:
  there is none. That range is somewhere for the marker to rest while the ask
  is spoken, not a claim about what you are saying.

A wrong index is worse than no highlight: the marker will sweep words that
have nothing to do with what is being said, and that mismatch is the first
thing a viewer notices.

The word list below is laid out about a dozen words per line, and the number
in [brackets] at the start of each line is that line's first word index. Use
it to find your place without having to recount from word 0 every time —
count on from the bracketed number instead of guessing.`;

/**
 * A real book page runs 200-400 words. Laid out as one unbroken line of
 * `n:word` tokens, that line has no visual anchor at all — the exact
 * condition under which a model is good at "approximately here" and bad at
 * "exactly this word", which is the single likeliest way a beat's indices
 * drift from what it is actually discussing (see the doc comment on
 * `Beat.startWord` in `./schema`).
 *
 * Breaking every `perLine` tokens onto their own line, and restating that
 * line's first index in `[brackets]` at its left edge (redundant with the
 * inline `n:word` numbering, deliberately) gives the model two independent
 * anchors to count from instead of one long wall of tokens.
 */
export function numberedWordLines(words: string[], perLine = 12): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) {
    const tokens = words
      .slice(i, i + perLine)
      .map((w, j) => `${i + j}:${w}`)
      .join(" ");
    lines.push(`[${i}] ${tokens}`);
  }
  return lines.join("\n");
}

export function buildSystemPrompt(opts: { hasAuthor: boolean }): string {
  return `You write 60-to-90-second vertical video scripts, each about a single passage of a book.

${TRANSFORMATIVE_RULE}

${INDEX_RULE}

Voice: direct, specific, unhurried. One idea, argued properly. No
throat-clearing, no "in this video", no "let's dive in". Open on the
sharpest thing you have.

SPOKEN, NOT WRITTEN. Every beat's voiceover is read aloud by a neural speech
engine, one beat at a time, with nothing else on the page:
- No markdown (no asterisks, no underscores, no backticks, no headings).
- No bracketed or parenthetical stage directions — no "[pause]", no
  "(laughs)", no "(beat)", no "(sighs)". If a pause matters, end the
  sentence instead.
- No emoji, no URLs, no hashtags inside voiceover.
- Write the way a real person talks: contractions, short sentences, commas
  and full stops placed where a breath goes.

${
  opts.hasAuthor
    ? `You may name the author where it helps.`
    : `The author of this book has NOT been established. Do not name an author,
do not guess at one, do not write "the author of" as a stand-in for a name, and
do not write any sentence whose sense depends on knowing who wrote this.

That ban covers more than a name. "The writer believes second chances matter"
never names anyone, but it still invents a person behind the page and asserts
what they believe — that is the same fabrication with the name filed off.
Forbidden phrasings include, but are not limited to: "the writer",
"whoever wrote this", "the author" used as a generic stand-in, and any
other construction that attributes belief, argument, or intent to an
unnamed authorial figure.

Refer only to "the page", "the passage", or "the book" — never to a person,
named or implied. "The page argues" and "the book makes the case that" are
fine; "the writer argues" is not, for the same reason a name is not. Those
three nouns are not a starting suggestion — they are the ONLY sanctioned
subjects for this kind of sentence.

This is not a formatting preference — a name, or a stand-in for one, would be
a fabrication. Decide this BEFORE you write a single beat: never compose a
sentence that needs a person behind the page and then try to patch around the
hole afterwards.`
}

Rules that are not negotiable:
- Every claim must be supported by the page text you are given. Invent nothing —
  no statistics, no study, no biographical detail, no anecdote that is not printed
  on the page.
- onScreen is a label, not a subtitle. Six words at most.
- emoji is optional, and at most ONE emoji character per beat. It stands for
  what that beat is actually about — the object, the act, the feeling under
  discussion — and it is shown on screen beside the label. Never decorative
  filler: no sparkles, no fire, no rocket bolted onto a beat that has nothing
  to do with any of them. Never the same emoji twice in one script. If no
  single emoji honestly stands for a beat, leave the field out of that beat
  entirely rather than reaching for a generic one. It is shown, never spoken,
  so it must NOT also appear in that beat's voiceover.
- NEVER write a URL, a domain, a link, or a "buy the book" line — not in
  voiceover, not in cta, not in description, not anywhere. Where the book can
  be bought is added afterwards, in code, from a link the operator typed
  themselves. A link you compose is a link you invented, and a wrong one
  published under someone else's name is worse than no link at all.
- The call to action is the last beat, and it asks for one thing.
- ideaKey is the single angle this episode takes, in kebab-case.
- hook is the first thing on screen and the line the thumbnail is built from.
  It has about two seconds to stop someone scrolling, so make it a statement or
  a question that lands on its own, with no set-up — not a summary of what the
  video will cover, and not a title.
- hookKeywords are the two or three words in hook that carry its meaning. They
  are painted in a bright accent colour while the rest of the hook stays white,
  in the opening card and on every thumbnail — so they must appear in hook
  EXACTLY as written there, same spelling, same word. Pick the words a reader
  would need if they only had time to read three of them; do not pick "the",
  "and", or any other word that carries no meaning on its own.`;
}

export function buildUserPrompt(input: GenerateInput, revisionBrief?: string): string {
  const pages = input.pages
    .map((p) => {
      const heading = p.chapterHeading ? `Heading: ${p.chapterHeading}\n` : "";
      const numbered = numberedWordLines(p.words);
      return `--- PAGE ${p.pageIndex} ---\n${heading}${numbered}`;
    })
    .join("\n\n");

  return [
    `Book: ${input.bookTitle}`,
    input.author ? `Author: ${input.author}` : `Author: not established — do not name one.`,
    `Archetype: ${input.archetype}`,
    `The angle this episode must take: ${input.ideaKey}`,
    input.avoidHooks.length
      ? `Openings already used for this book — do not reuse or paraphrase any of them:\n${input.avoidHooks.map((h) => `- ${h}`).join("\n")}`
      : "",
    ``,
    `Each word below is prefixed with its index, restarting at 0 on every new page.`,
    `The list is broken into lines of about a dozen words; the [bracketed] number at the start of a line is that line's first index — use it to count from instead of the top of the page.`,
    `Use those exact indices for sourcePage / startWord / endWord — do not renumber, estimate, or count on your own.`,
    ``,
    pages,
    revisionBrief ? `\n\nThe checker rejected your previous draft. Fix this:\n${revisionBrief}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
