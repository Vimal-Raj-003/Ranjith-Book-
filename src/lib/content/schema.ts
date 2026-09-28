/**
 * Book archetypes. The beat template is chosen from this, so that a philosophy
 * book and a memoir are not narrated in the identical rhythm — every video
 * sharing one skeleton is what makes a daily channel feel repetitive.
 */
export type Archetype = "story" | "motivation" | "philosophy" | "howto" | "memoir";

export const ARCHETYPES: Archetype[] = ["story", "motivation", "philosophy", "howto", "memoir"];

export interface Beat {
  /** "hook" | "context" | "idea-1" .. | "turn" | "takeaway" | "cta" */
  id: string;
  /**
   * Spoken narration for this beat. Fed to text-to-speech ONE BEAT AT A TIME
   * (see `beatTexts`), so it must be speakable on its own: no markdown, no
   * bracketed stage directions, no emoji, no URLs, no "(pause)". This is the
   * writer's own commentary about the page, quoting it directly at most once
   * and briefly — never a recitation of the page itself.
   */
  voiceover: string;
  /** Short on-screen label, six words at most. */
  onScreen: string;
  /**
   * One emoji standing for what THIS beat is about, shown on the cue card and
   * available to social copy — never spoken.
   *
   * Optional in both directions: the CLI providers have no structured-output
   * mode, so nothing can guarantee a reply carries it, and a beat whose
   * meaning has no honest emoji is better off without one than with a
   * decorative sparkle. Every consumer must survive it being absent, empty,
   * or holding something that is not an emoji at all.
   *
   * It must never reach `voiceover`, and `sanitizeForSpeech` must keep
   * stripping emoji from `voiceover` for the same reason this field exists at
   * all: a speech engine either skips an emoji silently, leaving dead air
   * mid-sentence, or reads its CLDR name aloud ("fire", "face with tears of
   * joy"). `voScriptFromPackage` and `beatTexts` are built from `voiceover`
   * alone, so this field has no path into audio — `tests/content-schema`
   * holds that line.
   */
  emoji?: string;
  /**
   * Which page this beat is about — the `pageIndex` value of one entry in
   * `GenerateInput.pages` (the number shown as "PAGE n" in the prompt), NOT
   * that entry's position in the array. The two usually coincide but are not
   * guaranteed to: an episode can cover a non-contiguous or offset slice of
   * an upload, and the prompt labels pages by their real `pageIndex` so the
   * model always names the number it was actually shown.
   */
  sourcePage: number;
  /**
   * Index into that page's word array (the entry of `GenerateInput.pages`
   * whose `pageIndex` equals `sourcePage`) where the marker sweep begins for
   * this beat. Zero-based, restarting at 0 on every page, and must be the
   * actual first word this beat is talking about — not a guess, not a round
   * number.
   */
  startWord: number;
  /**
   * Index into that same word array where the sweep ends. Must be >= startWord
   * — a backwards range narrates the passage in reverse and is worse than no
   * highlight at all, because the voice and the marker visibly disagree.
   */
  endWord: number;
}

export interface ContentPackage {
  title: string;
  hook: string;
  /**
   * The two or three words in `hook` carrying its meaning, painted in the theme
   * accent on the opening card and on every thumbnail.
   *
   * Required by `CONTENT_JSON_SCHEMA` and asked for explicitly in the prompt,
   * but deliberately still OPTIONAL in TypeScript: the CLI providers have no
   * structured-output mode, so nothing can guarantee a reply actually carries
   * it. Every consumer must survive it being absent, empty, or naming a word
   * that does not appear in `hook` — the accent is a flourish, and a missing
   * flourish must never cost a video.
   */
  hookKeywords?: string[];
  ideaKey: string;
  archetype?: Archetype;
  beats: Beat[];
  cta: string;
  description: string;
  hashtags: string[];
  /** Bullet points for the takeaway sheet. Written now, rendered in milestone three. */
  takeaway: string[];
}

export const CONTENT_JSON_SCHEMA = {
  type: "object",
  required: ["title", "hook", "hookKeywords", "ideaKey", "beats", "cta", "description", "hashtags", "takeaway"],
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 100 },
    hook: { type: "string", maxLength: 140 },
    hookKeywords: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
    ideaKey: { type: "string", pattern: "^[a-z0-9-]+$" },
    archetype: { type: "string", enum: ARCHETYPES },
    beats: {
      type: "array",
      minItems: 4,
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "voiceover", "onScreen", "sourcePage", "startWord", "endWord"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          voiceover: { type: "string", maxLength: 320 },
          onScreen: { type: "string", maxLength: 42 },
          // Optional, and capped at a length that admits one emoji — a base
          // character plus a variation selector, a skin-tone modifier, or the
          // two regional indicators of a flag — while refusing a string of
          // them or a sentence smuggled into the field. Never in `required`:
          // a beat with no honest emoji must be allowed to have none.
          emoji: { type: "string", maxLength: 8 },
          sourcePage: { type: "integer", minimum: 0 },
          startWord: { type: "integer", minimum: 0 },
          endWord: { type: "integer", minimum: 0 },
        },
      },
    },
    cta: { type: "string", maxLength: 160 },
    description: { type: "string", maxLength: 1200 },
    hashtags: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 12 },
    takeaway: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
  },
} as const;

export interface GenerateInput {
  bookTitle: string;
  /** Absent unless verified. The writer is never handed an unverified name. */
  author: string | null;
  archetype: Archetype;
  rightsStatus: "public-domain" | "in-copyright" | "own-work";
  ideaKey: string;
  /** Page text the episode covers, page by page, as transcribed. */
  pages: { pageIndex: number; chapterHeading: string | null; words: string[] }[];
  avoidHooks: string[];
  /** The book-analysis idea this episode is made from. Absent for a photo episode. */
  brief?: IdeaBrief;
  /** Absent means "short" — the photo pipeline's original 60–90 s shape. */
  length?: ScriptLength;
}

/**
 * How long a script runs. `short` is the original photo-episode shape and
 * stays exactly as it was; `long` is a 1–2 minute idea episode.
 */
export type ScriptLength = "short" | "long";

export interface LengthSpec {
  minBeats: number;
  maxBeats: number;
  /** Spoken words across every beat's voiceover, inclusive. Null = unchecked. */
  minWords: number | null;
  maxWords: number | null;
  /** What the writer is told the video runs, for its sense of pace. */
  seconds: string;
}

export const LENGTHS: Record<ScriptLength, LengthSpec> = {
  short: { minBeats: 4, maxBeats: 8, minWords: null, maxWords: null, seconds: "60-to-90-second" },
  // 170–280 words is 60–120 s of finished video at the narrator's pace:
  // Pocket TTS speaks ~150–165 words a minute, plus the pause between beats,
  // the 0.7 s lead-in and the 1.8 s outro.
  long: { minBeats: 7, maxBeats: 12, minWords: 170, maxWords: 280, seconds: "60-to-120-second" },
};

/**
 * The idea a long episode is built around, from `ContentIdea`. Its quotes are
 * the passages book analysis located on the page — the writer is told where
 * they are so its beats can cite them, and every beat is still held to the
 * same page-and-word grounding as any other script.
 */
export interface IdeaBrief {
  title: string;
  coreIdea: string;
  hook: string;
  whyItMatters: string;
  quotes: { pageIndex: number; startWord: number; endWord: number; text: string }[];
}

/** Spoken words in a package — what the long-episode length gate counts. */
export function spokenWordCount(pkg: Pick<ContentPackage, "beats">): number {
  return pkg.beats.reduce((n, b) => n + b.voiceover.split(/\s+/).filter(Boolean).length, 0);
}

/** `CONTENT_JSON_SCHEMA` with the beat count of the given length. */
export function contentJsonSchema(length: ScriptLength = "short") {
  const spec = LENGTHS[length];
  return {
    ...CONTENT_JSON_SCHEMA,
    properties: {
      ...CONTENT_JSON_SCHEMA.properties,
      beats: { ...CONTENT_JSON_SCHEMA.properties.beats, minItems: spec.minBeats, maxItems: spec.maxBeats },
    },
  };
}

/**
 * A defensive net under `voiceover`, not a substitute for the prompt telling
 * the writer not to produce this in the first place: the CLI providers have
 * no structured-output mode and no way to reject a reply that slips a
 * markdown asterisk or a stray URL past the instructions. `beatTexts` is what
 * actually reaches text-to-speech, one file per beat, so anything left in
 * here is read aloud verbatim by a neural voice — a literal "asterisk" or a
 * URL spelled out letter by letter is a worse failure than a model ignoring
 * the rule would be silent about.
 *
 * Deliberately NOT stripping bare parentheses in general: a blanket
 * "(...)" strip would also eat a legitimate parenthetical aside in the
 * writer's own commentary, and a silently mangled sentence is harder to
 * notice than a stage direction that slipped through.
 *
 * The one exception is the exact, narrow set of parenthesised stage
 * directions the prompt itself names as forbidden ("(pause)", "(beat)",
 * "(laughs)", "(sighs)") — those aren't ordinary parenthetical prose, they
 * are literally the words the prompt tells the writer never to write, so a
 * model that writes one anyway would otherwise have it read aloud verbatim
 * ("...and then, pause, he continued."). Stripping only this named set
 * closes that specific gap without touching any other parenthetical.
 */
const STAGE_DIRECTION_RE = /\((?:pause|beat|laughs?|sighs?)\)/gi;

function sanitizeForSpeech(text: string): string {
  return text
    // URLs: a speech engine reads "h t t p s colon slash slash" aloud.
    .replace(/\bhttps?:\/\/\S+/gi, "")
    // Bracketed asides ("[pause]", "[laughs]") are stage directions, not lines.
    .replace(/\[[^\]]*\]/g, "")
    // The prompt's own named parenthesised stage directions — see doc comment.
    .replace(STAGE_DIRECTION_RE, "")
    // Emoji and pictographic symbols: not speakable, and Pocket TTS/other
    // engines either skip them silently (dead air) or mispronounce them.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu, "")
    // Markdown emphasis/heading/code markers — read literally by a speech
    // engine ("asterisk", "underscore", "backtick") if left in.
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The full spoken script, in beat order — what a reviewer reads to hear the
 * whole video without opening the audio. On-screen-only text (`onScreen`,
 * labels) never appears here; only what is actually said.
 *
 * An empty or whitespace-only beat (a placeholder the writer left blank)
 * contributes nothing rather than an empty token, so joining beats never
 * produces a double space or a leading/trailing space.
 */
export function voScriptFromPackage(pkg: ContentPackage): string {
  return pkg.beats
    .map((b) => sanitizeForSpeech(b.voiceover))
    .filter(Boolean)
    .join(" ");
}

/**
 * One string per beat — each becomes its own audio file, so beat boundaries
 * are measured from real audio rather than estimated by splitting one long
 * track. Order and count are exactly `pkg.beats`': a downstream file at
 * index `i` names beat `i`, so this never filters, reorders, or merges
 * entries — even a beat left blank still occupies its slot, as an empty
 * string, rather than shifting every later beat's audio file by one.
 */
export function beatTexts(pkg: ContentPackage): string[] {
  return pkg.beats.map((b) => sanitizeForSpeech(b.voiceover));
}
