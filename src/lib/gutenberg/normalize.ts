/**
 * Raw Gutendex JSON in, this app's own types out — and this is the only file
 * that ever sees the raw shape.
 *
 * The rule here is that a remote service is allowed to surprise us. Every
 * field is checked rather than asserted: `results` might not be an array, an
 * author might be a string instead of an object, `download_count` might be
 * missing on a newly indexed row. None of that may throw. A row that cannot be
 * made sense of is dropped; a field that cannot be made sense of falls back to
 * an empty value. The alternative — a `500` on the search route because one
 * book in a page of thirty-two had a null title — is worse than showing
 * thirty-one books.
 */

import { pickCover, pickFormats, type FormatCandidate } from "./formats";
import { isFileHost } from "./hosts";
import type { BookAuthor, BookSearchPage, FreeBook } from "./types";

/**
 * A book plus its resolved download URLs. Server-side only: the URLs are what
 * the download proxy looks up, and they are deliberately absent from the
 * `FreeBook` the client receives.
 */
export interface ResolvedBook {
  book: FreeBook;
  downloads: FormatCandidate[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function year(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function strings(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => str(item, 160))
    .filter(Boolean)
    .slice(0, cap);
}

function authors(v: unknown): BookAuthor[] {
  if (!Array.isArray(v)) return [];
  const out: BookAuthor[] = [];
  for (const raw of v.slice(0, 8)) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name, 160);
    if (!name) continue;
    out.push({ name, birthYear: year(raw.birth_year), deathYear: year(raw.death_year) });
  }
  return out;
}

/**
 * The cover is the one field that gets rendered by the browser as a URL, so it
 * is held to the same allowlist as a download. A compromised or impersonated
 * API answering with a cover on someone else's host would otherwise turn every
 * result card into an outbound request the operator did not ask for.
 */
function cover(bag: unknown): string | null {
  const raw = pickCover(bag);
  if (!raw) return null;
  try {
    return isFileHost(new URL(raw).hostname) ? raw : null;
  } catch {
    return null;
  }
}

/** One raw row → a book, or null when it is not usable. */
export function normalizeBook(raw: unknown): ResolvedBook | null {
  if (!isRecord(raw)) return null;

  const id = raw.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;

  const title = str(raw.title, 300);
  if (!title) return null;

  const downloads = pickFormats(raw.formats);

  return {
    book: {
      id,
      title,
      authors: authors(raw.authors),
      subjects: strings(raw.subjects, 12),
      languages: strings(raw.languages, 8),
      downloadCount: count(raw.download_count),
      coverUrl: cover(raw.formats),
      formats: downloads.map((d) => d.key),
    },
    downloads,
  };
}

/** A whole `/books/` page → the typed page, dropping rows that make no sense. */
export function normalizeSearchPage(raw: unknown, page: number): BookSearchPage {
  const body = isRecord(raw) ? raw : {};
  const rows = Array.isArray(body.results) ? body.results : [];

  const books = rows.flatMap((row) => {
    const resolved = normalizeBook(row);
    return resolved ? [resolved.book] : [];
  });

  return {
    books,
    total: count(body.count),
    page,
    // `next` / `previous` are absolute URLs or null. Only their presence is
    // used — the page number this app already knows is more trustworthy than
    // re-parsing a URL somebody else built.
    hasNext: typeof body.next === "string" && body.next.length > 0,
    hasPrevious: typeof body.previous === "string" && body.previous.length > 0,
  };
}
