/**
 * Book text in, the token stream the page is built from out.
 *
 * This is the typeset path's answer to `wordsOf()` in `vision.ts`, and it
 * splits on exactly the same rule — `/\s+/`, punctuation kept, nothing
 * corrected or modernised — because both paths feed the same word-range
 * contract: a beat says "words 12 through 27 of page 3", and the two paths
 * must agree on what a word is or the ranges mean different things depending
 * on where the page came from.
 *
 * Everything here is pure and browser-free, so the parts of typesetting that
 * can be reasoned about without a rendering engine are testable without one.
 */

/** One word, and the two things the page layout needs to know about it. */
export interface TypesetWord {
  /** The token, as split. Emphasis markers are not part of it. */
  word: string;
  /** Index into the paragraph list, so a page can open a new `<p>`. */
  paragraph: number;
  /** Set inside a `_.._` run: rendered in italic, like the printed book. */
  italic: boolean;
}

/**
 * Paragraphs, from a plain-text book.
 *
 * Project Gutenberg's plain text is hard-wrapped at about 70 columns, so a
 * single newline is a typesetting artefact of THAT file and not a break in the
 * prose — joining those lines back into one run of text is what lets this
 * module re-break them against its own measure. A blank line (or a form feed,
 * which Gutenberg uses as a page separator) is the real paragraph break.
 *
 * Any non-string input, and text that is empty or only whitespace, yields an
 * empty list rather than one empty paragraph: a page of nothing is not a page.
 */
export function toParagraphs(text: unknown): string[] {
  if (typeof text !== "string" || text.length === 0) return [];

  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*(?:\n[ \t]*)+|\f/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

interface Segment {
  text: string;
  italic: boolean;
}

/**
 * Split a paragraph on Project Gutenberg's `_emphasis_` markers.
 *
 * Those underscores are markup, not letters. Left in place they would appear
 * twice over: as underscores printed on the page, and inside the word tokens
 * a beat quotes from — so `_Paradise Lost_` would be narrated with underscores
 * in it. Turning them into real italics instead is both truer to the printed
 * book and the only reading that keeps the token stream clean.
 *
 * The match is deliberately narrow: the run must be opened and closed within
 * one paragraph, must not be empty, and must not begin or end with a space
 * (`_ not this _`). An unmatched underscore is left exactly where it is —
 * silently deleting it would be a worse failure than printing it.
 */
export function toSegments(paragraph: string): Segment[] {
  const out: Segment[] = [];
  const pattern = /_(?!\s)((?:[^_\n]){1,400}?)(?<!\s)_/g;

  let cursor = 0;
  for (const match of paragraph.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) out.push({ text: paragraph.slice(cursor, at), italic: false });
    out.push({ text: match[1], italic: true });
    cursor = at + match[0].length;
  }
  if (cursor < paragraph.length) out.push({ text: paragraph.slice(cursor), italic: false });

  return out.filter((s) => s.text.trim().length > 0);
}

/** The flat token stream, in reading order, for a whole book or an extract. */
export function toWords(paragraphs: string[]): TypesetWord[] {
  const words: TypesetWord[] = [];

  for (let paragraph = 0; paragraph < paragraphs.length; paragraph++) {
    for (const segment of toSegments(paragraphs[paragraph])) {
      for (const word of segment.text.split(/\s+/)) {
        if (word.length === 0) continue;
        words.push({ word, paragraph, italic: segment.italic });
      }
    }
  }

  return words;
}

/** Text in, the words a page can be filled from out. */
export function wordsOfText(text: unknown): TypesetWord[] {
  return toWords(toParagraphs(text));
}
