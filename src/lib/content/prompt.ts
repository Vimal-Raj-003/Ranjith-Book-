import { LENGTHS, type GenerateInput, type IdeaBrief, type LengthSpec, type ScriptLength } from "./schema";
import { maxWordsFor, VIDEO_MAX_SECONDS } from "./duration";
import { TITLE_RULE, descriptionRule, hashtagRule } from "./metadata-rules";

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
own sentences ABOUT the passage.

Your draft is measured against a mechanical rule, so here it is exactly:
ANY run of FIVE OR MORE consecutive words matching the page counts as
quotation — wherever it appears, whether or not you meant it as a quote —
and every such run added together must stay under 8% of your total narration.
One deliberate quote is not what breaks this. What breaks it is a dozen
five- and six-word echoes of the page's own phrasing, dropped in without
noticing, each one harmless-looking and adding up past the limit.

So after every sentence you write, check it against the page: if five of
your words in a row also appear in that order on the page, rephrase them.
Change the shape of the sentence rather than swapping one word in the middle
— a run survives a synonym. Say the same idea the way you would say it to
someone who has not read the page.

This is both a legal requirement — reading an in-copyright book's prose at
length is an unlicensed audiobook, and YouTube and Instagram will act on it —
and the reason the format works at all. Nobody stays for a page being read to
them. They stay for someone explaining why it matters.`;

/**
 * What the three posting fields of the package — title, description, hashtags —
 * must contain. Before this block the writer was given a character cap for each
 * in the JSON schema and nothing else, so descriptions came back one sentence
 * long and titles plain. The standard itself lives in `./metadata-rules`, shared
 * with the Publish Center's Regenerate so that a field written at render time
 * and one regenerated later are held to the same rules.
 *
 * It is its own block, after the script rules, because it is a different job:
 * the script is spoken and checked line by line against the page, while this
 * copy is read by someone deciding whether to press play. The grounding check
 * is built to judge the voiceover, so the rule against invention has to be in
 * the prompt itself.
 */
export const PUBLISHING_COPY_RULES = `THE POSTING COPY. Three fields of your reply are published with the video on YouTube: title, description and hashtags. People read them before deciding to watch, so they are written to the same standard as the script — drawn only from the beats you are writing and the pages you were given, never from anything else. A fact, statistic, quotation, study or claim about the book that is not on the page does not go in any of them.

${TITLE_RULE}

${descriptionRule("the beats you are writing and the pages you were given")}

${hashtagRule(3, 12)}`;

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
- When two beats in a row discuss the same page, the later beat's startWord
  must be AT OR AFTER the earlier beat's endWord — never before it, and never
  overlapping it. Sharing the one boundary word is fine; going back is not —
  and every beat except the call to action must also cover at least one word
  past that boundary. Order your beats to follow the passage so this holds.
- A SINGLE BEAT MAY ONLY COVER WORDS ON ONE PAGE. If the idea you are
  discussing continues onto the next page, do NOT write one beat whose
  commentary draws on both — write two consecutive beats instead, split
  exactly at the page boundary: the first beat's sourcePage and word range
  cover only the words on the earlier page, and the second beat's sourcePage
  and word range cover only the words on the next page. Never let a beat's
  voiceover depend on text from a page other than the single page its
  sourcePage and word range name.

- THE LAST BEAT IS THE CALL TO ACTION, and it is the one exception to every
  rule above ONLY when it is a pure viewer request (such as "Follow BookReel
  for more ideas from books.") with ZERO factual or takeaway claims about the
  book. Put any takeaway summarizing the book's argument in the beat BEFORE
  the last beat, and give that takeaway beat the full sentence range
  (startWord..endWord) on sourcePage that supports it — never a 1- or 2-word
  stub. For the pure request-only last beat, point its sourcePage at the page
  the beat before it covered, and start its range AT that beat's endWord (for
  example, if the beat before it ended at word 175, use startWord 175 and
  endWord 175) — never at an earlier word, and never bundle book claims into
  the call-to-action beat.

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

/**
 * The rule most rewrites were spent enforcing. Measured on real runs, the
 * grounding checker's rejections were overwhelmingly one thing: a concrete
 * detail the page does not contain — a phone in a book from 1910, "walking the
 * dog" where the page says "chaining up the St. Bernard", an office door, a
 * colleague, an age. "Invent nothing" did not stop them, because an
 * illustration does not feel like a claim to the writer; to the checker it is
 * one. Saying so up front is the same rule the checker enforces, stated where
 * it can prevent a rewrite instead of causing one.
 */
export const CONCRETE_DETAIL_RULE = `The same goes for DETAIL. Every concrete scene, object, example, setting,
  number or date you describe must be on the page you cite. Do not add
  illustrative everyday examples, modern touches (phones, apps, offices,
  commutes), or specifics the page does not give — however natural they feel,
  the checker rejects them and the whole script is rewritten. If a point needs
  an example, use the book's own; if the page gives none, state the point
  plainly.`;

/**
 * Only for `length: "long"`. Appended after everything else, so a short
 * (photo-episode) prompt is byte-for-byte what it was before long scripts
 * existed.
 */
function longRules(spec: LengthSpec = LENGTHS.long): string {
  const aim = spec.aimWords ?? Math.round((spec.minWords! + spec.maxWords!) / 2);
  // Seconds depend on beats as well as words, so the cap is stated both ways.
  const hardWords = maxWordsFor(VIDEO_MAX_SECONDS - 5, spec.maxBeats);
  return `

THIS IS A ${spec.seconds.replace(/-/g, " ").toUpperCase()} VIDEO. The finished video must never run past ${VIDEO_MAX_SECONDS} seconds, and it is never padded: say what this idea needs in the room it has, and stop.
- Write between ${spec.minBeats} and ${spec.maxBeats} beats.
- The voiceover of all beats together must be between ${spec.minWords} and ${spec.maxWords} words — aim for about ${aim}. Count them. A script outside that range is sent back, and no script may ever exceed ${Math.min(spec.maxWords!, hardWords)} words.
- Shape: open on a 0–2s scroll-stopping hook, raise the personal stakes, hit a sharp mid-video twist/re-hook around the middle beat so viewers never drop off at 50%, prove the ONE idea using the book's own example or mechanism in plain modern English, land an unforgettable takeaway in the second-to-last beat, then close on a crisp Save/Share/Comment/Follow call to action. Every beat escalates tension or clarity; zero beats restate the beat before it.
- The idea you were given is the spine of the episode. Stay locked on it — do not drift into side topics from the same pages.`;
}

const VIRAL_RETENTION_RULES = `VIRAL RETENTION & CADENCE RULES (HOW TO HOLD VIEWERS FROM 0s TO 100%):
1. SCROLL-STOPPER OPENING (Beat 0 — first 2 seconds, max 12 words):
   Never warm up, introduce the topic, or summarise. Open Beat 0 immediately using ONE of these 5 viral hook formulas backed by the page:
   - Contrarian Myth-Buster: flip a common belief ("Working longer isn't why top performers win — cutting half the list is.")
   - Pain-Mirror: call out a mistake the viewer just made ("You reread the same page three times and still blank out.")
   - Sharp Contrast: pit two ideas head-to-head ("Busy looks productive. Focused actually changes your life.")
   - Hidden Trap: expose how a good intention backfires ("Rewarding yourself right after effort quietly kills the habit.")
   - 2-Second Self-Test: make the viewer check themselves right now ("Notice what your mind reaches for the second work gets boring.")
   - STRICT FORWARD PAGE ORDER EVEN ON HOOKS: Your Beat 0 hook MUST cite the EARLIEST sentence of your chosen passage on that page (framing the sharp tension around how that passage begins), so Beat 1, Beat 2, and every following beat on the same page move strictly forward (startWord >= previous beat's endWord). NEVER point Beat 0 at words near the middle or bottom of a page (e.g. words 180–220) and then jump backward to earlier words (e.g. words 20–80) in Beat 1!

2. MICRO-PUNCHLINE CADENCE ("Not X — it's Y."):
   - Keep sentences crisp (5 to 11 words on average), conversational, and rhythmic.
   - Use clean binary contrasts ("Clarity isn't a nice-to-have — it's leverage.", "Stop managing time. Start guarding attention.").
   - NEVER open beats with dry book-report filler ("The page reveals that...", "The book explains...", "Furthermore, this passage shows..."). Speak the truth directly to "you".

3. MID-VIDEO PATTERN INTERRUPT / RE-HOOK (around the middle beat):
   - Halfway through the script, use a brief rhetorical turn ("Here is the detail almost everyone misses.", "Look closely at what happens next.", "And here is why that matters.") before stating the next grounded point from the page — never invent a new factual claim or consequence that is not printed on the page.

4. PLAIN-ENGLISH TRANSLATION (ZERO ACADEMIC JARGON):
   - Even if the book is old, formal, or technical, translate its concepts into vivid, everyday modern spoken English a 20-year-old scrolling Reels understands on the first listen — while keeping 100% factual fidelity to what is printed on the page (never inventing modern objects, scenes, examples, or physical metaphors like "gears", "batteries", or "wires" unless the page itself uses them; use plain direct verbs like "switching", "pausing", or "losing focus" instead).`;

export function buildSystemPrompt(opts: { hasAuthor: boolean; length?: ScriptLength; spec?: LengthSpec }): string {
  const length = opts.length ?? "short";
  const spec = length === "long" ? (opts.spec ?? LENGTHS.long) : LENGTHS[length];
  return `You write ${spec.seconds} vertical video scripts, each about a single passage of a book.

${TRANSFORMATIVE_RULE}

${INDEX_RULE}

Voice: sharp, human, punchy, magnetic. One idea, argued with real tension and stakes. No
throat-clearing, no "in this video", no "let's dive in", no textbook essay tone ("Making
healthy habits is important..."). Open on the sharpest contradiction, painful mistake, or
counter-intuitive truth on the page — spoken directly to "you" in under 12 words so a
viewer scrolling past stops on word three.

${VIRAL_RETENTION_RULES}

SPOKEN, NOT WRITTEN. Every beat's voiceover is read aloud by a neural speech
engine, one beat at a time, with nothing else on the page:
- No markdown (no asterisks, no underscores, no backticks, no headings).
- No bracketed or parenthetical stage directions — no "[pause]", no
  "(laughs)", no "(beat)", no "(sighs)". If a pause matters, end the
  sentence instead.
- No emoji, no URLs, no hashtags inside voiceover.
- Write the way a captivating creator talks to one person across a table:
  contractions, crisp 5–11 word micro-sentences, active verbs, sharp contrasts
  ("not X — it's Y"), and commas/full stops placed exactly where a breath lands.

${
  opts.hasAuthor
    ? `You may name the author once where it sharpens the point; otherwise speak the idea directly to the viewer ("you").`
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

State the passage's facts and contrasts DIRECTLY to "you" in natural spoken
English ("Grabbing a sweet treat right after a workout undoes the habit") rather
than chanting robotic meta-phrases like "The page suggests" or "The passage
states" on every beat. When you do refer to the source text — at most once or
twice in the whole script — refer ONLY to "the page", "the passage", or "the
book", never to a person, named or implied. Those three nouns are the ONLY
sanctioned subjects when referring to the source.

This is not a formatting preference — a name, or a stand-in for one, would be
a fabrication. Decide this BEFORE you write a single beat: never compose a
sentence that needs a person behind the page and then try to patch around the
hole afterwards.`
}

Rules that are not negotiable:
- Every claim must be supported by the page text you are given. Invent nothing —
  no statistics, no study, no biographical detail, no anecdote that is not printed
  on the page.
- ${CONCRETE_DETAIL_RULE}
- onScreen is a label, not a subtitle. Six words at most — write it as a bold 2 to 5 word kinetic motion-card headline (e.g. "Busy vs Focused", "The Reward Trap", "Cut Half The List") that hits visually on screen.
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
- The call to action is the last beat, and it asks for one high-signal viewer
  action in 4 to 9 words — pick the natural algorithm trigger that best fits this
  topic: a Save trigger ("Save this before your next excuse."), a Share trigger
  ("Send this to someone drowning in busywork."), a Comment trigger ("Comment the
  one habit you're cutting today."), or a Follow trigger ("Follow BookReel for
  the next sharp idea.") — always a pure viewer request with zero book facts
  bundled in, so the outro lands fast and satisfies the last-beat index rule.
- ideaKey is the single angle this episode takes, in kebab-case.
- hook is the first thing on screen and the line the thumbnail is built from.
  It has under two seconds to stop someone scrolling, so make it a sharp
  second-person ("You...") contradiction, painful everyday mistake, or bold
  question in 6 to 12 words that lands immediately with zero set-up — never a
  textbook summary and never a title.
- hookKeywords are the two or three words in hook that carry its meaning. They
  are painted in a bright accent colour while the rest of the hook stays white,
  in the opening card and on every thumbnail — so they must appear in hook
  EXACTLY as written there, same spelling, same word. Pick the words a reader
  would need if they only had time to read three of them; do not pick "the",
  "and", or any other word that carries no meaning on its own.

${PUBLISHING_COPY_RULES}${length === "long" ? longRules(spec) : ""}`;
}

/**
 * The idea book analysis found, stated before the pages. Its quotes are named
 * by page and word range so the writer can cite them as beats — but they are
 * where to look, not what to say: every rule about commentary and quotation
 * applies exactly as it does to any other script.
 */
export function ideaBriefBlock(brief: IdeaBrief): string {
  const sortedQuotes = [...brief.quotes].sort(
    (a, b) => a.pageIndex - b.pageIndex || a.startWord - b.startWord || a.endWord - b.endWord,
  );
  const quotes = sortedQuotes
    .map((q) => `- PAGE ${q.pageIndex}, words ${q.startWord}–${q.endWord}: "${q.text}"`)
    .join("\n");
  return [
    `THE IDEA THIS EPISODE IS ABOUT (found in the book by an editor; build the whole script around it):`,
    `Idea: ${brief.coreIdea}`,
    quotes ? `Where the book says it:\n${quotes}` : "",
    `The editor's working title and suggested opening are below. They are LABELS, not evidence: the`,
    `editor may have added background knowledge that is NOT on these pages (a date, an age, a name, a`,
    `number, a claim about the book's history or fame). Use them only for the angle. Never repeat any`,
    `fact from them unless the pages themselves state it — the grounding check rejects anything that`,
    `is not printed on the page, however well known it is.`,
    `Working title: ${brief.title}`,
    brief.hook ? `Suggested opening: ${brief.hook}` : "",
    brief.whyItMatters ? `Why it matters: ${brief.whyItMatters}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
    input.brief ? ideaBriefBlock(input.brief) : "",
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
