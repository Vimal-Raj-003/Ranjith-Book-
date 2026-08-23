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

/**
 * Choose the line a poster is built around.
 *
 * The old rule was "the hook, cut to N words", and at 200px that was the
 * single worst thing about these thumbnails. A hook is written to be *heard*
 * over the opening two seconds of a video, so it is routinely nine or ten
 * words — "Busy can be a performance you put on for yourself." — and cutting
 * it produced "BUSY CAN BE A PERFORMANCE YOU PUT…", a fragment ending in an
 * ellipsis. A scroller does not decode a fragment; they skip it. A truncated
 * headline is strictly worse than a shorter complete one.
 *
 * So this prefers a WHOLE thought that fits, in descending order of punch, and
 * only truncates when the package offers nothing that fits at all:
 *
 *  1. The hook's first sentence — usually the claim, with the qualifier in the
 *     second sentence ("Most people are busy. Almost nobody is focused.").
 *  2. A clause of the hook carrying a keyword. A hook hinged on a dash or a
 *     colon has its point on one side of the hinge.
 *  3. The hook beat's `onScreen` line. This is the most underused material in
 *     the package: the writer is asked for at most six words of on-screen
 *     label, which is a thumbnail headline in everything but name, and it is
 *     the same idea in the same voice — not an invention.
 *  4. Any other beat's `onScreen`, then the title.
 *  5. Only now, the hook cut to budget with an ellipsis.
 *
 * Deterministic: a fixed candidate order and a word count, no scoring on
 * anything that could tie differently between runs.
 */
export function headlineText(
  copy: { title: string; hook: string; keywords: string[]; onScreen?: string[] },
  maxWords: number,
): string {
  const words = (s: string) => clean(s).split(" ").filter(Boolean).length;
  const fits = (s: string) => {
    const n = words(s);
    return n > 0 && n <= maxWords;
  };

  const hook = clean(copy.hook);
  const sentences = hook ? hook.split(/(?<=[.!?])\s+/).filter(Boolean) : [];
  const strip = (s: string) => clean(s).replace(/[\s.,;:—–-]+$/, "");

  const candidates: string[] = [];
  if (sentences[0]) candidates.push(strip(sentences[0]));

  // Clauses, longest hinge first. Only the parts carrying a keyword are worth
  // promoting over the beat lines — a clause with none of the hook's meaning
  // in it is a worse headline than the writer's own short label.
  const norm = (s: string) => clean(s).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "");
  const keys = (Array.isArray(copy.keywords) ? copy.keywords : []).map(norm).filter(Boolean);
  for (const sentence of sentences) {
    for (const part of sentence.split(/\s*[—–:;,]\s*|\s+—\s+/).filter(Boolean)) {
      const clause = strip(part);
      if (!fits(clause)) continue;
      if (keys.length === 0 || keys.some((k) => norm(clause).includes(k))) candidates.push(clause);
    }
  }

  for (const line of Array.isArray(copy.onScreen) ? copy.onScreen : []) {
    const t = strip(line);
    if (t) candidates.push(t);
  }
  const title = strip(copy.title);
  if (title) candidates.push(title);

  for (const c of candidates) {
    if (fits(c)) return c;
  }
  // Nothing whole fits. Cut the longest thing we have rather than the first.
  return trimWords(hook || title || candidates[0] || "", maxWords);
}
