/**
 * What a good title, description and hashtag list ARE, written once.
 *
 * Two prompts ask a model for this copy: the script writer (`prompt.ts`), which
 * returns it inside every episode's package, and the Publish Center's
 * Regenerate / auto-generate (`publish/regenerate.ts`), which re-derives one
 * field from an episode that already exists. Before this module the writer was
 * told NOTHING about what a description should contain — only a character cap
 * in the JSON schema — so descriptions were one sentence and titles were plain,
 * while Regenerate had its own, different, shorter idea of the same fields.
 * Stating the standard here means a field written at render time and one
 * regenerated a month later are held to the same one.
 *
 * No imports, so a prompt module and a client-safe module can both take it.
 *
 * THE GROUNDING RULE IS THE POINT. Title, description and hashtags are not what
 * the pipeline's grounding check is built to judge (it reads the voiceover
 * against the page), so these rules have to forbid invention themselves: every
 * claim in them must be traceable to the script. `ground` names what "the
 * script" means in each caller.
 */

/** YouTube's title ceiling, which the JSON schema's `maxLength` and the editor's counter both use. */
export const TITLE_MAX = 100;

/** The most a description may run to. YouTube's own ceiling; also `CONTENT_JSON_SCHEMA.description.maxLength`. */
export const DESCRIPTION_MAX = 5000;

/**
 * How long the description is ASKED to be, and the ceiling the model is told.
 * Below `DESCRIPTION_MAX` on purpose: the purchase link is appended after the
 * model has answered, in code, and must not push a 4,990-character answer past
 * YouTube's 5,000.
 */
export const DESCRIPTION_ASK = { target: "about 900–2,200 characters", ceiling: 4500 } as const;

export const TITLE_RULE = `TITLE — the YouTube title. Make it compelling, accurate and search-friendly, drawn from what this video is actually about, in natural, readable language.
- Exactly ONE relevant emoji at the very start, then a space, then the title text, then a space and ONE OR TWO relevant emojis at the very end. Nothing follows the closing emojis and no emoji sits in the middle.
- Every emoji is chosen for THIS video's subject — the object, the act or the feeling the title is about. Never random, never decorative filler (no sparkles, fire or rocket unless the video is genuinely about them).
- At most ${TITLE_MAX} characters INCLUDING the emojis and the spaces around them — count them, and aim for 60–90 so it never nears the limit.
- Read it aloud: it must be a complete, grammatical phrase, not two clauses run together ("Why Habits Fail Is Underrated" is wrong; "Why Habits Fail" and "Why Habit Failure Is Underrated" are right). No clickbait, no ALL CAPS, no trailing hashtags, and no "<" or ">". Keep the video's meaning: promise nothing the video does not deliver.`;

/**
 * The structured YouTube description.
 *
 * `ground` is the phrase for what the copy must come from — "the beats you are
 * writing and the pages you were given" for the writer, "the script below" for
 * a regenerate. Plain text throughout: YouTube shows asterisks and pound signs
 * literally, so none of this is markdown.
 */
export function descriptionRule(ground: string): string {
  return `DESCRIPTION — the YouTube description: a COMPLETE, structured body, never a single sentence. Everything in it must come from ${ground} and from the Book and Author lines you were given. Invent nothing: no fact, quotation, statistic, study, research finding or claim about the book that is not supported there. Plain text only — no markdown, no asterisks, no # headings. Write these parts in this order, with a blank line between parts:
1. An engaging opening headline line with 1–2 relevant emojis.
2. A relatable question or hook about the idea itself, in the viewer's own terms, as one line — not a made-up scenario or anecdote.
3. A clear explanation of the core idea, exactly as this video presents it (2–4 sentences).
4. The source. If a Book line gives a title, write "Inspired by ideas from" followed by that title as given — without any archive id, file extension or page count in it, and with no dangling punctuation. Add "by" and the author's name ONLY when the Author line names someone; if it says no author is established, name no one and do not stand in for one. Leave this part out if there is no book title. Outside that credit, do not write "by" directly before a Capitalised Word ("with", "using" or "through" instead): a checker reads it as a byline.
5. "What you'll discover:" followed by 4–6 bullet lines, each on its own line, each specific to this video and drawn from what the script actually covers. Use ONE style for the whole list: every bullet leads with its own relevant emoji, or every bullet starts with "• " — never a mix.
6. Only when the script itself gives the viewer something to do: "Try this:" followed by 2–4 numbered lines (1. 2. 3.) using only steps the script gives. If the script gives no steps, leave this part out entirely — do not invent advice.
7. One memorable closing takeaway line, taken from the script's own conclusion.
8. A natural closing line inviting the viewer to follow BookReel for more ideas from books. No link, no @handle.
Do NOT put hashtags in the description — they are a separate field — and put no link or URL of any kind in it: the purchase link is appended afterwards, in code. No angle brackets. Length: ${DESCRIPTION_ASK.target}; never above ${DESCRIPTION_ASK.ceiling.toLocaleString("en-US")}.`;
}

/**
 * The YouTube hashtag list. `min`/`max` are the same band the schema and
 * `LIST_ASK.hashtags` use.
 */
export function hashtagRule(min: number, max: number): string {
  return `HASHTAGS — between ${min} and ${max}, each starting with "#", no spaces inside a tag, no duplicates or near-duplicates. Most are specific to THIS video's subject (the idea, the skill, the situation it speaks to), followed by a few broader category tags a viewer might browse. Include #BookReel. Write a multi-word tag in CamelCase (#DeepWork) so it reads well. Do not reuse a stock list: this video's tags come from this video's own subject. No keyword stuffing — a tag that is not about this video does not belong.`;
}
