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
import { normaliseHashtags, normaliseTags } from "./limits";
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
 * 100 for a title (which is also YouTube's ceiling), 1,200 for a description
 * (far inside YouTube's 5,000), and 3–12 hashtags (inside Instagram's 30).
 */
/** The character ceiling each prose field is asked to respect. */
const PROSE_CAP: Record<"title" | "description" | "igHook" | "igCaption", number> = {
  title: 100, // also YouTube's own title ceiling
  description: 1200, // far inside YouTube's 5,000
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
  "Plain prose. No markdown, no headings, no bullet characters, no emoji in a title.",
];

const FIELD_BRIEF: Record<MetadataField, string> = {
  title: `Write ONE title for this video: at most ${PROSE_CAP.title} characters, specific to this idea, no clickbait question, no ALL CAPS, no trailing hashtags.`,
  description: `Write the description for this video: ${PROSE_CAP.description} characters at most, two or three short paragraphs. Open with what the viewer gets from it, then name the book it came from. Do not list hashtags here and do not add any link — a purchase link is appended separately, in code.`,
  hashtags: `Write between ${LIST_ASK.hashtags.min} and ${LIST_ASK.hashtags.max} hashtags for this video, each starting with '#', lowercase, no spaces inside a tag, specific before generic, no duplicates and no near-duplicates.`,
  tags: `Write between ${LIST_ASK.tags.min} and ${LIST_ASK.tags.max} YouTube SEO keyword tags for this video. These are search keywords, NOT hashtags: plain words or short phrases, lower case, NO '#', a multi-word phrase is allowed ("deep work"), specific before generic, no duplicates.`,
  igHook: `Write ONE short Instagram Reel opening line for this video: at most ${PROSE_CAP.igHook} characters, punchy and scroll-stopping, written for Instagram. Do NOT copy the YouTube title or description — write it fresh for a Reels audience.`,
  igCaption: `Write an Instagram caption body for this video: at most ${PROSE_CAP.igCaption} characters, one or two short punchy paragraphs written for Instagram, NOT the YouTube description reused. Open with the payoff, keep it conversational. Do not list hashtags here (they are a separate field) and do not add any link.`,
  igHashtags: `Write between ${LIST_ASK.igHashtags.min} and ${LIST_ASK.igHashtags.max} Instagram hashtags for this video, each starting with '#', lower case, no spaces inside a tag, a mix of specific and reach tags as suits Instagram, no duplicates and no near-duplicates.`,
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

function buildUser(field: MetadataField, source: RegenerateSource, lines: string[]): string {
  const facts = [
    `Book: ${source.bookTitle}`,
    source.author ? `Author: ${source.author}` : "Author: not established — do not name or imply one.",
    `Kind of book: ${source.archetype}`,
    source.hook ? `The video opens with: ${source.hook}` : null,
    source.cta ? `It closes with: ${source.cta}` : null,
    source.title && field !== "title" ? `Its current title: ${source.title}` : null,
  ].filter(Boolean);

  return [
    FIELD_BRIEF[field],
    "",
    "THE VIDEO:",
    ...facts.map((f) => `- ${f}`),
    "",
    "WHAT IT SAYS, IN ORDER:",
    ...lines.map((l, i) => `${i + 1}. ${l}`),
  ].join("\n");
}

export interface Regenerated {
  field: MetadataField;
  /** A string for title/description, a string[] for hashtags. */
  value: string | string[];
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

  const system = [SYSTEM_HEAD, "", "RULES:", ...RULES.map((r) => `- ${r}`)].join("\n");
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
    const detail = err instanceof Error ? err.message : String(err);
    throw new AppError("regenerate_failed", `The writer could not be reached: ${detail}`, 502);
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

  const raw = reply[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AppError("regenerate_failed", `The writer returned no ${field}, so nothing was changed.`, 502);
  }
  const value = raw.trim();
  const cap = PROSE_CAP[field];
  if ([...value].length > cap) {
    // Refused, not truncated: a title cut mid-word is not a title the operator
    // asked for, and the honest answer is "try again".
    throw new AppError(
      "regenerate_failed",
      `The writer returned a ${field} of ${[...value].length} characters, over the ${cap} asked for. Nothing was changed.`,
      502,
    );
  }

  // The purchase link is composed in code, exactly as the pipeline does it, so
  // a regenerated description ends the same way a generated one does.
  return { field, value: field === "description" ? appendBookLink(value, source.bookLink) : value };
}
