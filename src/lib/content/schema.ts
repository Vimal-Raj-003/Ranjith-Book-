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
  /** The two or three words in `hook` carrying its meaning, painted in accent. */
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
  required: ["title", "hook", "ideaKey", "beats", "cta", "description", "hashtags", "takeaway"],
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 100 },
    hook: { type: "string", maxLength: 140 },
    hookKeywords: { type: "array", items: { type: "string" }, maxItems: 3 },
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
