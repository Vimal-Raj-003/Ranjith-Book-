/**
 * The shapes the rest of the app binds to.
 *
 * Gutendex's raw JSON never leaves `normalize.ts`. Its `formats` object is a
 * bag keyed by MIME type ("text/plain; charset=utf-8"), its author years can
 * be `null`, and it has fields this app has no use for. Leaking that into a
 * route or a component would make every consumer responsible for a remote
 * service's shape, so it is converted once, defensively, at the boundary.
 *
 * Types only — nothing here is emitted, so this module is import-safe
 * anywhere.
 */

/** The formats offered for download, in the order the UI shows them. */
export type FormatKey = "epub" | "text" | "html" | "pdf";

export interface BookAuthor {
  name: string;
  /** Null when Gutenberg does not record the year — common for older entries. */
  birthYear: number | null;
  deathYear: number | null;
}

/** One downloadable file. `url` is server-side only and never sent to a client. */
export interface BookDownload {
  key: FormatKey;
  /** The MIME type Gutendex keyed it under, kept for the proxy's response. */
  mediaType: string;
  /** The file extension this format gets when saved. */
  extension: string;
  url: string;
}

/** A book as the UI sees it. Note: no download URLs — only their format keys. */
export interface FreeBook {
  id: number;
  title: string;
  authors: BookAuthor[];
  subjects: string[];
  languages: string[];
  downloadCount: number;
  /** Direct Gutenberg cover image, or null when the book has none. */
  coverUrl: string | null;
  /** Which formats exist, for the UI's per-result download buttons. */
  formats: FormatKey[];
}

export interface BookSearchPage {
  books: FreeBook[];
  /** Total matches across all pages, as reported by Gutendex. */
  total: number;
  page: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface SearchQuery {
  search?: string;
  topic?: string;
  languages?: string;
  page?: number;
}

/**
 * Why a call did not produce a result. The UI maps each to a sentence; nothing
 * here is ever an unhandled throw.
 */
export type FailureCode =
  | "timeout"
  | "unreachable"
  | "rate_limited"
  | "upstream_error"
  | "bad_response"
  | "blocked"
  | "not_found"
  | "bad_request"
  | "too_large";

export interface Failure {
  ok: false;
  code: FailureCode;
  /** Safe to show a user. Never contains an upstream URL or a stack. */
  message: string;
}

export type Result<T> = { ok: true; value: T } | Failure;

export const fail = (code: FailureCode, message: string): Failure => ({ ok: false, code, message });
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
