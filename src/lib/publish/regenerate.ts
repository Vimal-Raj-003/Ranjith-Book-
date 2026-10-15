/**
 * Re-derive ONE metadata field from the book and the script that was actually
 * written.
 *
 * WHY THIS IS NOT `generateContent`. The obvious implementation — call the
 * existing content path and take the field you wanted off its result — would
 * rewrite the whole episode: a fresh script, a fresh grounding check, and a
 * fresh `reserveIdea` against the book's one-video-one-idea ledger. Measured in
 * this codebase, one writer draft alone is 150–400 s (and a logged outlier at
 * 660 s), the grounding check is another call, and a failed run BURNS the idea
 * for every future episode of that book. Paying all of that to retitle a video
 * whose render already exists — and risking that the new script no longer
 * matches the video on disk — is not a regenerate, it is a re-render.
 *
 * So this reuses the content path at the layer below: the same CLI provider
 * (`contentProvider`-equivalent setting), the same `runCliJson` transport, the
 * same lenient JSON extraction, and the same hard rules about what the writer
 * may be told. The GROUND TRUTH it is given is the episode's own stored script,
 * which is what the video says — so a regenerated description describes the
 * video that exists rather than one that might have been made.
 *
 * TWO RULES ARE CARRIED OVER VERBATIM, because breaking either is a real defect
 * this project has already paid for:
 *
 *  1. An unverified author is never named and never stood in for. `author` is
 *     passed only when `authorVerified`, exactly as `pipeline.ts` does it, and
 *     the prompt forbids inventing one.
 *  2. The purchase link is appended IN CODE, never asked of the model
 *     (`appendBookLink`). A model that invents or mistypes a URL publishes a
 *     wrong link under the operator's name.
 */
import { getSetting } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { appendBookLink } from "@/lib/content/book-link";
import { runCliJson } from "@/lib/content/cli-provider";
import type { CliProvider } from "@/lib/content/cli";
import type { Beat } from "@/lib/content/schema";
import { stripEmoji } from "@/lib/content/emoji";
import { DESCRIPTION_MAX, TITLE_MAX, TITLE_RULE, descriptionRule, hashtagRule } from "@/lib/content/metadata-rules";
import { YOUTUBE_TAGS_LIMIT, normaliseHashtags, normaliseTags, tagsLine } from "./limits";
import type { MetadataField } from "./state";

/**
 * The same setting `pipeline.ts` reads, read the same way, so a regenerate and
 * a render cannot end up on different providers.
 *
 * It is duplicated rather than imported because `pipeline.ts` is a 1,200-line
 * module that pulls in ffmpeg, sharp, Playwright and the whole render path;
 * importing it from a route to read one string would drag all of that into the
 * route's module graph. Four lines is the cheaper copy, and there is nothing
 * here to drift: the key and the fallback are the contract.
 */
async function contentProvider(): Promise<CliProvider> {
  const v = await getSetting("cliProvider");
  return v === "codex-cli" ? "codex-cli" : "claude-cli";
}

/**
 * The limits a regenerated value is asked to respect.
 *
 * They match `CONTENT_JSON_SCHEMA` in `content/schema.ts` exactly, so a
 * regenerated field is indistinguishable in shape from one the pipeline wrote —
 * 100 for a title (which is also YouTube's ceiling), 5,000 for a description
 * (also YouTube's: the structured body needs the room, and `metadata-rules`
 * asks for far less), and 3–12 hashtags (inside Instagram's 30).
 */
/** The character ceiling each prose field is asked to respect. */
const PROSE_CAP: Record<"title" | "description" | "igHook" | "igCaption", number> = {
  title: TITLE_MAX, // also YouTube's own title ceiling
  description: DESCRIPTION_MAX, // YouTube's own ceiling; the writer is asked for far less
  igHook: 150, // a punchy opening line, not a paragraph
  igCaption: 800, // Instagram reads shorter than a YouTube description
};

/** The item band each list field is asked to produce. */
const LIST_ASK: Record<"hashtags" | "tags" | "igHashtags", { min: number; max: number }> = {
  hashtags: { min: 3, max: 12 },
  tags: { min: 5, max: 15 }, // YouTube keyword tags lean plentiful
  igHashtags: { min: 5, max: 20 }, // Instagram leans on more tags than YouTube
};

function proseSchema(field: "title" | "description" | "igHook" | "igCaption") {
  return {
    type: "object",
    required: [field],
    additionalProperties: false,
    properties: { [field]: { type: "string", maxLength: PROSE_CAP[field] } },
  };
}

function listSchema(field: "hashtags" | "tags" | "igHashtags") {
  const ask = LIST_ASK[field];
  return {
    type: "object",
    required: [field],
    additionalProperties: false,
    properties: {
      [field]: { type: "array", items: { type: "string" }, minItems: ask.min, maxItems: ask.max },
    },
  };
}

const SCHEMAS: Record<MetadataField, object> = {
  title: proseSchema("title"),
  description: proseSchema("description"),
  igHook: proseSchema("igHook"),
  igCaption: proseSchema("igCaption"),
  hashtags: listSchema("hashtags"),
  tags: listSchema("tags"),
  igHashtags: listSchema("igHashtags"),
};

/**
 * Must NOT begin with "You write": `callKind` in `content/cli-metrics.ts`
 * classifies a system prompt by its opening words, and "You write" is the
 * script writer — which would give this small call the writer's 25-minute
 * ceiling and 8-minute silence allowance, pin it to Opus at high effort, and
 * log it in `model-calls.jsonl` as a writer call that never wrote a script.
 * "You rewrite" falls to kind `other`, which is what this is.
 */
const SYSTEM_HEAD = "You rewrite the posting copy for a short vertical video that has already been made.";

const RULES = [
  "The video already exists and will not be re-made. Describe what the script below actually says — never a different or better video.",
  "Never state a fact, claim, statistic or quotation that is not in the script below.",
  "Never name or imply an author unless one is given to you. If none is given, do not guess, and do not write around it with 'the author' as if you knew who that was.",
  "Never write a URL, a link, a handle, or an @mention of any kind.",
  "Plain text: no markdown, no asterisks, no # headings. Emoji appear only where the brief for that field asks for them (a title, the description's headline and bullets, Instagram copy), always chosen for this video's subject and never as decoration.",
];

/**
 * What each field is asked for.
 *
 * `title`, `description` and `hashtags` take their standard from
 * `content/metadata-rules.ts`, the same text the script writer is given, so a
 * field regenerated here matches one the pipeline wrote. The Instagram and
 * YouTube-tag briefs are this module's own: nothing else writes those.
 */
const FIELD_BRIEF: Record<MetadataField, string> = {
  title: `Write ONE title for this video.
${TITLE_RULE}`,
  description: `Write the description for this video.
${descriptionRule("the script below")}`,
  hashtags: `Write the hashtags for this video.
${hashtagRule(LIST_ASK.hashtags.min, LIST_ASK.hashtags.max)}`,
  tags: `Write between ${LIST_ASK.tags.min} and ${LIST_ASK.tags.max} YouTube SEO keyword tags for this video. These are search keywords, NOT hashtags: plain words or short phrases, lower case (except the book's title and an author's name, which keep their capitals), NO '#', a multi-word phrase is allowed ("deep work"), specific before generic, no duplicates. Include the book's name as one tag — as a reader would search for it, without archive ids, page counts or file extensions — and, only when an Author line names someone, the author's name as another. Every other tag comes from this video's own subject, not from a stock list. The whole list, joined with commas, must stay under ${YOUTUBE_TAGS_LIMIT} characters.`,
  igHook: `Write ONE short Instagram Reel title and opening line for this video: at most ${PROSE_CAP.igHook} characters, punchy and scroll-stopping, written for Instagram — Instagram has no title field, so this line is the Reel's title and the first line of its caption. A natural emoji or two is fine where it fits the topic. Say only what the script says: a sharper way of saying it is fine, a new claim is not. Do NOT copy the YouTube title or description — write it fresh for a Reels audience.`,
  igCaption: `Write an Instagram caption body for this video: at most ${PROSE_CAP.igCaption} characters, one or two short punchy paragraphs written for Instagram (aim for 300–600 characters), NOT the YouTube description reused and not a shortened copy of it. Open with the payoff, keep it conversational, and use a few natural emojis where they suit the topic (Instagram convention) — never as filler. Every claim in it must be something the script says. Do not list hashtags here (they are a separate field) and do not add any link.`,
  igHashtags: `Write between ${LIST_ASK.igHashtags.min} and ${LIST_ASK.igHashtags.max} Instagram hashtags for this video, each starting with '#', lower case, no spaces inside a tag, a mix of specific and reach tags as suits Instagram, drawn from this video's own subject rather than a stock list, no duplicates and no near-duplicates.`,
};

export interface RegenerateSource {
  bookTitle: string;
  /** Null unless `authorVerified` — the pipeline's own rule, carried over. */
  author: string | null;
  archetype: string;
  /** Appended to a regenerated description in code. Never shown to the model. */
  bookLink: string | null;
  title: string | null;
  hook: string | null;
  cta: string | null;
  /** `Episode.script`, a JSON `Beat[]`. The ground truth for everything written. */
  script: string | null;
  voScript: string | null;
  /**
   * The episode's stored YouTube description, when there is one. NEVER shown to
   * the model — a model that sees the description tends to write the Instagram
   * caption as a shortened copy of it — and used only afterwards, to refuse an
   * Instagram caption that turns out to be one anyway.
   */
  description?: string | null;
}

/** The narration, as a numbered list of what the video says, in order. */
function scriptLines(source: RegenerateSource): string[] {
  if (source.script) {
    try {
      const beats = JSON.parse(source.script) as Beat[];
      if (Array.isArray(beats) && beats.length > 0) {
        return beats
          .map((b) => (typeof b?.voiceover === "string" ? b.voiceover.trim() : ""))
          .filter((v) => v !== "");
      }
    } catch {
      // Fall through to the flattened voiceover below, which is written from the
      // same beats and is the better of two imperfect sources.
    }
  }
  if (source.voScript && source.voScript.trim() !== "") return [source.voScript.trim()];
  return [];
}

/** The facts about the video the model is told, the same for one field or four. */
function videoFacts(source: RegenerateSource, withTitle: boolean): string[] {
  return [
    `Book: ${source.bookTitle}`,
    source.author ? `Author: ${source.author}` : "Author: not established — do not name or imply one.",
    `Kind of book: ${source.archetype}`,
    source.hook ? `The video opens with: ${source.hook}` : null,
    source.cta ? `It closes with: ${source.cta}` : null,
    source.title && withTitle ? `Its current title: ${source.title}` : null,
  ].filter((f): f is string => Boolean(f));
}

/** The brief, then the video, then what it says — the user message of every call here. */
function composeUser(brief: string, facts: string[], lines: string[]): string {
  return [
    brief,
    "",
    "THE VIDEO:",
    ...facts.map((f) => `- ${f}`),
    "",
    "WHAT IT SAYS, IN ORDER:",
    ...lines.map((l, i) => `${i + 1}. ${l}`),
  ].join("\n");
}

function buildUser(field: MetadataField, source: RegenerateSource, lines: string[]): string {
  return composeUser(FIELD_BRIEF[field], videoFacts(source, field !== "title"), lines);
}

function systemPrompt(): string {
  return [SYSTEM_HEAD, "", "RULES:", ...RULES.map((r) => `- ${r}`)].join("\n");
}

export interface Regenerated {
  field: MetadataField;
  /** A string for title/description, a string[] for hashtags. */
  value: string | string[];
}

/** Whatever went wrong reaching the writer, reported AS ITSELF — see the comment at the call sites. */
function unreachable(err: unknown): AppError {
  const detail = err instanceof Error ? err.message : String(err);
  return new AppError("regenerate_failed", `The writer could not be reached: ${detail}`, 502);
}

/**
 * "Are these two the same words?", for the two rules this module enforces in
 * code and not only in the prompt: an Instagram hook must not be the YouTube
 * title, and an Instagram caption must not be the YouTube description.
 *
 * Compared as plain lower-case letters and digits with the emoji taken out, so
 * "🧠 Deep Work Beats Hustle 🚀" and "Deep work beats hustle." are one string.
 * A containment counts too, once the shorter side is long enough to be a
 * copy rather than a coincidence: a caption that is the whole description with
 * a line added is still the description.
 */
function squash(text: string): string {
  return stripEmoji(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function copiesText(candidate: string, original: string | null | undefined, floor: number): boolean {
  const a = squash(candidate);
  const b = squash(original ?? "");
  if (a === "" || b === "") return false;
  if (a === b) return true;
  return (a.length >= floor && b.includes(a)) || (b.length >= floor && a.includes(b));
}

/** A hook that is the title, or a caption that is the description, is refused — not repaired. */
function refuseCopies(field: "igHook" | "igCaption", value: string, source: RegenerateSource): void {
  if (field === "igHook" && copiesText(value, source.title, 12)) {
    throw new AppError(
      "regenerate_failed",
      "The writer reused the YouTube title as the Instagram hook. Nothing was changed.",
      502,
    );
  }
  if (field === "igCaption" && copiesText(value, source.description, 40)) {
    throw new AppError(
      "regenerate_failed",
      "The writer reused the YouTube description as the Instagram caption. Nothing was changed.",
      502,
    );
  }
}

/** How many characters `appendBookLink` adds to a description for this link (0 when there is none, or it is not a usable URL). */
function linkRoom(bookLink: string | null): number {
  return [...appendBookLink("a", bookLink)].length - 1;
}

/**
 * One prose reply, checked: present, text, inside its cap. Over the cap is
 * REFUSED, not truncated — a title cut mid-word is not one the operator asked
 * for, and the honest answer is "try again". Shared by the one-field path and
 * the batched one so the two cannot drift on what "too long" means.
 *
 * `<` and `>` are removed from a title or description rather than refused:
 * YouTube rejects an upload containing either, they carry no meaning in this
 * copy, and a Regenerate that failed for a stray angle bracket would cost a
 * model call for nothing.
 */
function proseValue(
  field: "title" | "description" | "igHook" | "igCaption",
  raw: unknown,
  /** The ceiling for THIS value, when it is lower than the field's own (a description that must leave room for the book link). */
  room: number = PROSE_CAP[field],
): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AppError("regenerate_failed", `The writer returned no ${field}, so nothing was changed.`, 502);
  }
  let value = raw.trim();
  if (field === "title" || field === "description") value = value.replace(/[<>]/g, "").replace(/[ \t]{2,}/g, " ").trim();
  const cap = Math.min(PROSE_CAP[field], room);
  if ([...value].length > cap) {
    throw new AppError(
      "regenerate_failed",
      `The writer returned a ${field} of ${[...value].length} characters, over the ${cap} asked for. Nothing was changed.`,
      502,
    );
  }
  return value;
}

/**
 * One field, regenerated. Throws an `AppError` the route can answer with.
 *
 * `deps.call` exists so the tests drive every branch — a refused reply, an
 * empty one, one over the limit, a CLI failure — without spawning a CLI or
 * spending a model call. Production always uses `runCliJson`.
 */
export async function regenerateField(
  field: MetadataField,
  source: RegenerateSource,
  deps: { call?: typeof runCliJson; provider?: CliProvider; model?: string } = {},
): Promise<Regenerated> {
  const lines = scriptLines(source);
  if (lines.length === 0) {
    throw new AppError(
      "no_script",
      "This episode has no stored script, so there is nothing to re-derive its copy from. Re-render it first.",
      409,
    );
  }

  const system = systemPrompt();
  const user = buildUser(field, source, lines);
  const provider = deps.provider ?? (await contentProvider());
  const call = deps.call ?? runCliJson;

  let reply: Record<string, unknown>;
  try {
    reply = await call<Record<string, unknown>>(provider, system, user, SCHEMAS[field], deps.model);
  } catch (err) {
    // Whatever went wrong is reported AS ITSELF rather than as a blank 500. The
    // common case is a CLI that is not installed or not signed in, and `cli.ts`
    // already puts an actionable sentence on that error ("Run `claude` once in
    // a terminal to confirm you are signed in"), so passing the message through
    // is strictly better than classifying it here.
    throw unreachable(err);
  }

  if (field === "hashtags" || field === "igHashtags") {
    const tags = normaliseHashtags(reply[field]);
    const ask = LIST_ASK[field];
    if (tags.length < ask.min) {
      throw new AppError("regenerate_failed", "The writer returned too few hashtags, so nothing was changed.", 502);
    }
    return { field, value: tags.slice(0, ask.max) };
  }

  if (field === "tags") {
    const tags = normaliseTags(reply.tags);
    if (tags.length < LIST_ASK.tags.min) {
      throw new AppError("regenerate_failed", "The writer returned too few tags, so nothing was changed.", 502);
    }
    return { field, value: tags.slice(0, LIST_ASK.tags.max) };
  }

  // A description is checked against what is left of YouTube's 5,000 once the book link
  // is appended after it, so a 4,990-character answer cannot become a 5,060-character one.
  const value = proseValue(field, reply[field], field === "description" ? DESCRIPTION_MAX - linkRoom(source.bookLink) : undefined);
  if (field === "igHook" || field === "igCaption") refuseCopies(field, value, source);

  // The purchase link is composed in code, exactly as the pipeline does it, so
  // a regenerated description ends the same way a generated one does.
  return { field, value: field === "description" ? appendBookLink(value, source.bookLink) : value };
}

// ---------------------------------------------------------------------------
// The four platform fields, in one call
// ---------------------------------------------------------------------------

/**
 * The fields no part of the render wrote until now: YouTube keyword tags and
 * the three Instagram fields. They existed only when an operator pressed
 * Regenerate on each of the four by hand, so a freshly rendered episode opened
 * its Publish panel with the Instagram package empty and the caption silently
 * falling back to the YouTube text.
 */
export interface PlatformMetadata {
  /** YouTube keyword tags: no '#', de-duplicated, the comma-joined line under 500 characters. */
  tags: string[];
  /** The Instagram title / opening line. Never the YouTube title. */
  igHook: string;
  /** The Instagram caption body. Never the YouTube description. */
  igCaption: string;
  igHashtags: string[];
}

const PLATFORM_SCHEMA = {
  type: "object",
  required: ["tags", "igHook", "igCaption", "igHashtags"],
  additionalProperties: false,
  properties: {
    tags: { type: "array", items: { type: "string" }, minItems: LIST_ASK.tags.min, maxItems: LIST_ASK.tags.max },
    igHook: { type: "string", maxLength: PROSE_CAP.igHook },
    igCaption: { type: "string", maxLength: PROSE_CAP.igCaption },
    igHashtags: {
      type: "array",
      items: { type: "string" },
      minItems: LIST_ASK.igHashtags.min,
      maxItems: LIST_ASK.igHashtags.max,
    },
  },
} as const;

/**
 * The four per-field briefs, joined. Not a second statement of what a tag or a
 * caption is: it is `FIELD_BRIEF` itself, so Regenerate on one field and the
 * batched call on all four ask for the same thing.
 */
const PLATFORM_BRIEF = [
  "Write the YouTube keyword tags and the Instagram copy for this video, all four fields in one reply, so that they fit together. Reply with exactly these four keys.",
  "",
  `"tags" — ${FIELD_BRIEF.tags}`,
  "",
  `"igHook" — ${FIELD_BRIEF.igHook}`,
  "",
  `"igCaption" — ${FIELD_BRIEF.igCaption} The caption comes AFTER igHook on the post, so do not repeat the igHook line inside it.`,
  "",
  `"igHashtags" — ${FIELD_BRIEF.igHashtags}`,
].join("\n");

/** A name made fit to be ONE keyword tag: no comma (the line is comma-separated), no # and no angle brackets. */
function asTag(name: string): string {
  return name.replace(/[,#<>]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The book's name as a reader knows it, from the title the operator typed.
 *
 * The title is whatever was typed or derived at upload, and in this library that
 * includes "How to use your mind; a psychology of study; (IA howtouseyourmind00kits)"
 * (an archive id), "gutenberg.org cache epub 10674 pg10674.txt" (a file name) and
 * "How to Live on 24 Hours a Day by Arnold Bennett" (an author credit typed into
 * the TITLE of a book whose author was never verified). So: a parenthetical, a
 * subtitle and a trailing "by First Last" credit are dropped. Naming that author
 * in a tag would break the rule that an unverified author is never named, however
 * innocently it got into the title.
 */
function bookName(title: string): string {
  const main = title
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+by\s+(?:[A-Z][\w.'’-]*\s+){1,3}[A-Z][\w.'’-]*\s*$/, " ")
    .split(/[:;—–]|\s-\s/)[0];
  return asTag(main ?? "");
}

/** Is this fit to be a keyword tag at all: not a file name, a domain or an id? Better no tag than that one. */
function plausibleName(name: string): boolean {
  if (name.length < 3 || name.length > 70) return false;
  if (/\.[a-z]{2,4}(?:\s|$)/i.test(name)) return false;
  if (/\d{4,}/.test(name)) return false;
  return (name.match(/\d/g)?.length ?? 0) <= name.length / 4;
}

const wordsOf = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/**
 * Does one of these tags already name this? A tag covers a name when it contains
 * all of it ("atomic habits book summary" covers "Atomic Habits"), or when it is
 * most of it (the writer dropped "70 Pages" from a title that has them). Judged
 * by words, so the case, punctuation and order of the writer's own tag do not
 * matter and nothing is added twice.
 */
function covers(tags: string[], name: string): boolean {
  const n = wordsOf(name);
  if (n.length === 0) return true;
  const joined = n.join(" ");
  return tags.some((tag) => {
    const w = wordsOf(tag);
    const j = w.join(" ");
    return j.includes(joined) || (w.length >= Math.ceil(n.length * 0.7) && joined.includes(j));
  });
}

/**
 * The tags the model wrote, with the book's name and a VERIFIED author's name
 * guaranteed to be among them.
 *
 * People search YouTube for a book by its name, and the name is a given fact
 * (the operator typed it), not something the model has to be trusted with. The
 * brief asks for it and the model almost always writes it; this makes sure, in
 * code, because a tag list that forgot the one keyword the video is named for is
 * worse than one with a tag too many — and does nothing when the model already
 * did, and nothing at all when the title is not a name worth searching (a file
 * name, an archive id). The author is added only when `source.author` is set: it
 * is null unless the author was verified, the rule every other caller follows.
 *
 * What is added goes FIRST (the most specific tags lead), and a list pushed past
 * its maximum loses its tail, not them.
 */
function withBookTags(tags: string[], source: RegenerateSource): string[] {
  const add: string[] = [];
  const name = bookName(source.bookTitle);
  if (plausibleName(name) && !covers(tags, name)) add.push(name);
  const author = source.author ? asTag(source.author) : "";
  if (author.length >= 2 && !covers(tags, author)) add.push(author);
  return normaliseTags([...add, ...tags]).slice(0, LIST_ASK.tags.max);
}

/**
 * The tags, the Instagram hook, the Instagram caption and the Instagram
 * hashtags for an episode, from ONE model call.
 *
 * WHY ONE CALL AND NOT FOUR `regenerateField`s. Four calls is four times the
 * wait (each is its own CLI process) and four chances for the pieces to
 * contradict each other: a hook that says the opposite of the caption under it.
 * One call also lets the model make the hook and the caption two halves of one
 * post.
 *
 * THE SAME DISCIPLINE AS REGENERATE, because it is the same ground truth and
 * the same risks:
 *   - it writes from the stored script and nothing else, and says so;
 *   - an unverified author is never named (`source.author` is null);
 *   - a reply over a cap is REFUSED, not truncated — prose past its cap, a tag
 *     line past YouTube's 500 characters, too few tags or hashtags — and
 *     nothing is returned, so nothing partial is ever stored;
 *   - a hook that is the YouTube title, or a caption that is the YouTube
 *     description, is refused too (`refuseCopies`).
 * A list that runs past its item maximum is cut to it, the same as Regenerate
 * does: dropping the trailing, most generic tags is not a mangled value.
 *
 * Throws an `AppError`; callers decide what a failure costs (the render step
 * records a note, the panel shows a Generate button).
 */
export async function generatePlatformMetadata(
  source: RegenerateSource,
  deps: { call?: typeof runCliJson; provider?: CliProvider; model?: string } = {},
): Promise<PlatformMetadata> {
  const lines = scriptLines(source);
  if (lines.length === 0) {
    throw new AppError(
      "no_script",
      "This episode has no stored script, so there is nothing to write its copy from. Re-render it first.",
      409,
    );
  }

  const user = composeUser(PLATFORM_BRIEF, videoFacts(source, true), lines);
  const provider = deps.provider ?? (await contentProvider());
  const call = deps.call ?? runCliJson;

  let reply: Record<string, unknown>;
  try {
    reply = await call<Record<string, unknown>>(provider, systemPrompt(), user, PLATFORM_SCHEMA, deps.model);
  } catch (err) {
    throw unreachable(err);
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    throw new AppError("regenerate_failed", "The writer returned nothing usable, so nothing was changed.", 502);
  }

  const tags = normaliseTags(reply.tags);
  if (tags.length < LIST_ASK.tags.min) {
    throw new AppError("regenerate_failed", "The writer returned too few tags, so nothing was changed.", 502);
  }
  const finalTags = withBookTags(tags.slice(0, LIST_ASK.tags.max), source);
  const tagChars = [...tagsLine(finalTags)].length;
  if (tagChars > YOUTUBE_TAGS_LIMIT) {
    throw new AppError(
      "regenerate_failed",
      `The writer returned tags of ${tagChars} characters, over the ${YOUTUBE_TAGS_LIMIT} YouTube allows. Nothing was changed.`,
      502,
    );
  }

  const igHashtags = normaliseHashtags(reply.igHashtags);
  if (igHashtags.length < LIST_ASK.igHashtags.min) {
    throw new AppError("regenerate_failed", "The writer returned too few Instagram hashtags, so nothing was changed.", 502);
  }

  const igHook = proseValue("igHook", reply.igHook);
  const igCaption = proseValue("igCaption", reply.igCaption);
  refuseCopies("igHook", igHook, source);
  refuseCopies("igCaption", igCaption, source);

  return { tags: finalTags, igHook, igCaption, igHashtags: igHashtags.slice(0, LIST_ASK.igHashtags.max) };
}
