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
 *
 * This is deliberately a full-string denylist, not a "last word looks
 * organisational" heuristic. An earlier version of this file rejected any
 * two-or-more-word name ending in a bare word like "house", "press", "media"
 * or "group" -- which is exactly the ordinary shape of a real English surname
 * plus a given name: `isNonPersonAuthor("Silas House")` came back `true`, and
 * Silas House is a real, awarded novelist (Kentucky Poet Laureate 2017-18);
 * so is Christian House. Both would have been permanently blocked from ever
 * being verified, no matter how strongly the catalogue, the model and the
 * adversarial pass all agreed. A false rejection is far cheaper than a false
 * attribution, but "cheaper" is not "free" -- a rule that reliably erases a
 * working author's byline is not an acceptable trade. So the check only ever
 * matches the FULL normalised author string against known catalogue
 * conventions and specific, named publisher imprints below; it never infers
 * "this looks like an organisation" from a word shape.
 */
const NON_PERSON_TOKENS = new Set([
  // Catalogue conventions for "no identifiable single author".
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
  // Specific, named publisher imprints, matched as whole strings only --
  // never as "any name ending in one of these words".
  "penguin random house",
  "penguin books",
  "penguin classics",
  "harpercollins",
  "harpercollins publishers",
  "simon schuster",
  "macmillan publishers",
  "hachette book group",
  "scholastic inc",
  "oxford university press",
  "cambridge university press",
  "random house",
  "vintage books",
]);

export function isNonPersonAuthor(raw: string): boolean {
  const normalized = normalizePersonName(raw);
  if (!normalized) return true;
  return NON_PERSON_TOKENS.has(normalized);
}
