/**
 * Emoji handling for titles: telling whether a piece of text is an emoji,
 * taking them out, and measuring how a title wears them.
 *
 * This module has NO imports and must keep it that way. The title now carries
 * emoji by design (one leading, one or two trailing, chosen for the topic), but
 * three places must never show them: a thumbnail headline (a poster is a
 * designed object, and a colour emoji glyph is whatever font the renderer
 * happens to find), anything spoken, and a file name. Those consumers take the
 * emoji back out with `stripEmoji` rather than each growing its own regex.
 *
 * WHY GRAPHEMES AND NOT A CODE-POINT RANGE. A flag is two code points, a
 * family or a "technologist" is up to seven joined by zero-width joiners, a
 * thumbs-up with a skin tone is two, and a keycap is three. Counted by code
 * point those are 2, 7, 2 and 3 "emoji"; to a reader each one is ONE. The
 * length LIMIT elsewhere in this app counts code points (it must agree with
 * the JSON schema's `maxLength`), but "how many emoji does this title end in"
 * is a question about what a person sees, so it is answered per grapheme.
 */

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
/**
 * The blocks where a pictographic character is an emoji whether or not a
 * variation selector follows it: the supplementary emoji planes, Miscellaneous
 * Symbols and Dingbats, and Miscellaneous Symbols and Arrows. The same ranges
 * `sanitizeForSpeech` (content/schema.ts) strips from a voiceover.
 *
 * Deliberately NOT every `Extended_Pictographic` character: that property
 * includes the copyright, registered and trade-mark signs and a handful of
 * arrows, which are ordinary typography in a title ("Brand™") and are only an
 * emoji when something asks for the emoji presentation (U+FE0F).
 */
const EMOJI_BLOCKS = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

/** One user-perceived character at a time. Falls back to code points where `Intl.Segmenter` is missing. */
function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
}

/** Is this one user-perceived character an emoji (a flag, a keycap, a ZWJ sequence, a pictograph)? */
export function isEmojiCluster(cluster: string): boolean {
  if (cluster === "") return false;
  if (REGIONAL_INDICATOR.test(cluster) || cluster.includes("\u20E3")) return true;
  if (EMOJI_PRESENTATION.test(cluster)) return true;
  if (!PICTOGRAPHIC.test(cluster)) return false;
  return cluster.includes("\uFE0F") || EMOJI_BLOCKS.test(cluster);
}

/** Does this text contain any emoji at all? */
export function hasEmoji(text: string): boolean {
  return graphemes(text).some(isEmojiCluster);
}

/**
 * The text with every emoji taken out and the spaces they leaned on tidied, so
 * "🧠 Deep Work Beats Hustle 🚀" becomes "Deep Work Beats Hustle" and not
 * " Deep Work Beats Hustle  ". Everything that is not an emoji is untouched.
 */
export function stripEmoji(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return graphemes(text)
    .filter((g) => !isEmojiCluster(g))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** How a title wears its emoji. */
export interface TitleEmojiShape {
  /** Emoji before the first word. */
  leading: number;
  /** Emoji after the last word. */
  trailing: number;
  /** Emoji in the middle of the title — there should be none. */
  inside: number;
  /** The title with its emoji taken out. */
  text: string;
}

/**
 * Count the emoji at each end of a title and any stranded in the middle.
 * Spaces between emoji at an end ("🚀 🧠") are skipped, not counted as text.
 */
export function titleEmojiShape(title: string): TitleEmojiShape {
  const parts = graphemes(typeof title === "string" ? title : "");
  const isText = (g: string) => !isEmojiCluster(g) && g.trim() !== "";

  const first = parts.findIndex(isText);
  const last = parts.length - 1 - [...parts].reverse().findIndex(isText);

  // A title that is nothing but emoji (or empty) has no text to lean on.
  if (first === -1) {
    return { leading: parts.filter(isEmojiCluster).length, trailing: 0, inside: 0, text: "" };
  }

  const count = (from: number, to: number) => parts.slice(from, to).filter(isEmojiCluster).length;
  return {
    leading: count(0, first),
    trailing: count(last + 1, parts.length),
    inside: count(first, last + 1),
    text: stripEmoji(title),
  };
}
