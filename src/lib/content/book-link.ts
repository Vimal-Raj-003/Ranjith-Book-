/**
 * The operator's optional "where to buy this book" link.
 *
 * Two rules govern everything in this module, and both exist because this one
 * string is typed by hand at upload and then rendered into a public YouTube
 * description AND into an HTML video composition:
 *
 * 1. **It is never asked of the model.** `appendBookLink` composes the
 *    purchase line deterministically, in code. A language model that invents
 *    or mistypes a URL publishes a wrong link under the operator's name,
 *    which is strictly worse than publishing no link at all — see §11 of the
 *    presentation spec.
 * 2. **A bad link is dropped, never rejected.** An upload is twenty
 *    photographs the operator may have spent minutes taking; refusing the
 *    whole batch because the link field holds a bare word would cost them all
 *    of that for a field that is optional in the first place. Anything that
 *    is not an `http:`/`https:` URL becomes `null` and the video simply ends
 *    without a purchase card.
 *
 * This module deliberately has NO imports. It is pure string handling, and
 * that keeps it safe to import from an ingest path, from the pipeline, and
 * from a test, without dragging anything behind it.
 */

/**
 * Long enough for a real affiliate/store URL with tracking parameters, short
 * enough that a pasted megabyte of junk never reaches the database, the
 * description, or the composition. Applied to both the raw input and the
 * normalised output, because percent-encoding can only lengthen a string.
 */
export const MAX_BOOK_LINK_LENGTH = 2048;

/**
 * Characters that could end an HTML attribute value and start markup, left
 * over after WHATWG URL normalisation.
 *
 * `new URL().href` already percent-encodes `<`, `>`, `"`, backtick and
 * whitespace — but NOT the apostrophe in a path or fragment, and an
 * apostrophe is enough to break out of `href='...'`. Rather than trust the
 * eventual consumer to have picked double quotes, every one of these is
 * encoded here, once, so the stored value is inert in any embedding.
 *
 * `&` is deliberately NOT encoded: it is a query-string separator, so
 * encoding it would corrupt real store URLs, and on its own it cannot
 * terminate an attribute or open a tag — the worst it can do is form a
 * character reference that decodes back into the attribute's own value.
 */
const HTML_UNSAFE = /['"<>`]/g;

function percentEncode(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Validate and canonicalise a link typed by the operator.
 *
 * Returns the normalised absolute URL, or `null` for anything that is not a
 * plain web link: an empty or whitespace-only field, a bare word, a relative
 * path, `javascript:`, `data:`, `file:`, `ftp:`, or anything absurdly long.
 * Never throws, and never returns an empty string — absent is `null`, so the
 * database column, the description and the composition all agree on one
 * single representation of "no link".
 *
 * The return value is safe to embed in HTML: see `HTML_UNSAFE`.
 */
export function normalizeBookLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_BOOK_LINK_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // A bare word, a relative path, "www.example.com" — not a URL at all.
    return null;
  }

  // The scheme allow-list, not a deny-list: a deny-list of "javascript:" and
  // "data:" would still admit "vbscript:", "file:" and whatever the next
  // browser ships.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const href = url.href.replace(HTML_UNSAFE, percentEncode);
  if (href.length > MAX_BOOK_LINK_LENGTH) return null;

  return href;
}

/**
 * The sentence introducing the link in the published description. Lives here
 * rather than in `src/lib/strings.ts` because it is written copy that ships
 * inside the episode's own description, alongside the model's prose — not UI
 * chrome — and because `strings.ts` must stay importable by client
 * components, which this module has no business being pulled into.
 */
export const BOOK_LINK_PREFIX = "Get the book:";

/**
 * The description exactly as published, with the purchase line appended when —
 * and only when — a valid link exists.
 *
 * No link means no line and no placeholder: an "unavailable" or an empty
 * "Get the book:" is worse than silence, because it advertises a missing
 * thing to every viewer.
 *
 * The link is re-validated here rather than trusted from storage. Validating
 * at the boundary AND at the point of rendering is what makes it true that a
 * `javascript:` URL cannot reach a description, no matter which path put it
 * in the database or how old that row is.
 */
export function appendBookLink(description: string, link: string | null): string {
  const body = typeof description === "string" ? description.trimEnd() : "";
  const safe = normalizeBookLink(link);
  if (!safe) return body;

  const line = `${BOOK_LINK_PREFIX} ${safe}`;
  // A blank line between the writer's description and the purchase line, so
  // the link reads as an appended footer rather than as the end of the last
  // sentence. An empty description gets the line alone, with no leading
  // whitespace for a platform to render as a gap.
  return body ? `${body}\n\n${line}` : line;
}
