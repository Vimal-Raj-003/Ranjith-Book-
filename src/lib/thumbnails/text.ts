/**
 * Text handling for thumbnails: escaping, word budgets, keyword painting.
 *
 * The escape helper lives here rather than being imported from the video
 * composition on purpose. Book text is arbitrary — a page can legitimately
 * contain `<`, `&` or the literal characters `</script>`, and a single
 * unescaped one of those has blanked a render on this project before. This
 * module owns its own copy so that a rewrite of the composition's helper
 * cannot silently change what a thumbnail does with hostile text.
 */

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape for both element text and quoted attribute values. `<` and `>` are
 * both escaped (not just `<`) so a stray `</script>` or `-->` in a book quote
 * cannot terminate any enclosing construct, and both quote characters are
 * escaped so the same helper is safe in `attr="..."` and `attr='...'`.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Collapse whitespace; a newline inside a hook becomes a wrap we did not choose. */
export function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * A thumbnail is read at ~200px wide in a feed, so the word count is the
 * design. Prefer the first sentence when it already fits the budget —
 * a complete thought beats a truncated one — and only then fall back to
 * cutting at `maxWords`.
 */
export function trimWords(text: string, maxWords: number): string {
  const t = clean(text);
  if (!t) return "";

  const sentence = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  const useSentence = sentence.split(" ").filter(Boolean).length <= maxWords;
  const source = useSentence ? sentence : t;

  const words = source.split(" ").filter(Boolean);
  if (words.length <= maxWords) return source.replace(/[.,;:]+$/, "");
  return words.slice(0, maxWords).join(" ").replace(/[.,;:]+$/, "") + "…";
}

/** Lowercase, strip anything that is not a letter or digit — for matching only. */
function norm(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Paint the keywords inside `text` in the accent colour and return HTML.
 *
 * Everything is escaped, keyword or not. Matching is punctuation- and
 * case-insensitive and handles multi-word keywords by matching a run of
 * consecutive words. An absent, empty, or non-matching keyword list is not an
 * error and never throws: the line is simply rendered entirely in ink, which
 * is a duller thumbnail, not a failed one.
 */
export function paintKeywords(text: string, keywords: string[] | undefined | null): string {
  const words = clean(text).split(" ").filter(Boolean);
  if (words.length === 0) return "";

  const hit = new Array<boolean>(words.length).fill(false);
  const normWords = words.map(norm);

  const phrases = (Array.isArray(keywords) ? keywords : [])
    .map((k) => clean(k).split(" ").map(norm).filter(Boolean))
    .filter((parts) => parts.length > 0)
    // Longest phrase first, so "deep work" wins over a bare "work".
    .sort((a, b) => b.length - a.length);

  for (const parts of phrases) {
    for (let i = 0; i + parts.length <= normWords.length; i++) {
      let match = true;
      for (let j = 0; j < parts.length; j++) {
        if (normWords[i + j] !== parts[j]) {
          match = false;
          break;
        }
      }
      if (match) for (let j = 0; j < parts.length; j++) hit[i + j] = true;
    }
  }

  return words
    .map((w, i) => (hit[i] ? `<em class="kw">${escapeHtml(w)}</em>` : escapeHtml(w)))
    .join(" ");
}
