/**
 * Two catalogues spell the same person differently -- "J. R. R. Tolkien" and
 * "J.R.R. Tolkien" are one author, and a chain that treats them as two would
 * suppress an author it had in fact confirmed twice.
 *
 * `NFKD` splits an accented letter into its base letter plus a combining mark
 * (e.g. an "i" plus a combining acute accent). The following `replace` strips
 * just the combining marks (U+0300 - U+036F) using the explicit
 * `\u0300-\u036f` escape below, not literal combining characters pasted
 * into source -- a literal combining mark sitting in this file is exactly the
 * kind of thing an editor, a merge, a lint autofix, or any tool that
 * normalizes Unicode on write can mangle silently, and the only symptom would
 * be accented names quietly failing to match. The escape keeps this file's
 * source ASCII-only in this region, leaving the bare base letter after the
 * strip so two spellings of the same name normalize to the same token. See
 * `src/lib/ingest/align.ts` for the same pattern applied to OCR/vision token
 * matching.
 */
export function normalizePersonName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sameName(a: string, b: string): boolean {
  return normalizePersonName(a) === normalizePersonName(b);
}

/**
 * Catalogue conventions that are not a person's name, however cleanly they
 * pass through normalisation and however confidently a model might echo them
 * back off a title page. Revealing "Various" or "Anonymous" as though it were
 * a verified byline is exactly the "probably" this whole chain exists to
 * refuse -- it is not a name at all, so no amount of agreement between the
 * catalogue and the model makes it certain.
 */
const NON_PERSON_TOKENS = new Set([
  "various",
  "various authors",
  "anonymous",
  "anon",
  "unknown",
  "unknown author",
  "author unknown",
  "editor",
  "editors",
  "edited by",
  "compiled by",
  "compiler",
  "translator",
  "translators",
  "et al",
  "n a",
  "na",
  "not available",
  "staff",
]);

/**
 * A conservative, curated check -- not a heuristic that tries to catch every
 * publisher imprint in existence. A two-or-more-word name ending in a bare
 * corporate/organisational word ("Penguin Random House", "HarperCollins
 * Publishers") is refused; a single-word surname that happens to be one of
 * these words ("House", "Press") is not, because the false-negative there
 * (an imprint slipping through) is far cheaper than the false-positive (a
 * real person's only name being erased).
 */
const ORG_LAST_WORDS = new Set([
  "press",
  "publishing",
  "publishers",
  "publications",
  "editions",
  "house",
  "media",
  "group",
  "inc",
  "llc",
  "ltd",
  "co",
]);

export function isNonPersonAuthor(raw: string): boolean {
  const normalized = normalizePersonName(raw);
  if (!normalized) return true;
  if (NON_PERSON_TOKENS.has(normalized)) return true;

  const words = normalized.split(" ");
  if (words.length >= 2 && ORG_LAST_WORDS.has(words[words.length - 1])) return true;

  return false;
}
