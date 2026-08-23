/**
 * A book's plain text, with Project Gutenberg's licence removed.
 *
 * Two jobs, and the second one is the reason this is not three lines of
 * `fetch`.
 *
 * **Getting the text.** The client never supplies a URL; it supplies an
 * integer. The URL is built here from a fixed origin and that validated
 * integer, then run through the same `guardedFetch` the download proxy uses —
 * host allowlist, address guard, manual redirects re-checked at every hop,
 * hard size cap. Gutenberg publishes the same text under three paths that have
 * drifted over the years, so they are tried in order; each candidate is a
 * separate guarded fetch, not a redirect chase.
 *
 * **Removing the licence.** Every Gutenberg text is wrapped in a header and a
 * footer of licence boilerplate, marked like this:
 *
 *     *** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***
 *     …the actual book…
 *     *** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***
 *
 * That boilerplate is not the book. It is a licence, a donation appeal and a
 * list of email addresses, and a narrator reading it aloud over a typeset page
 * would be the single most obvious defect in the finished video. So it is cut
 * — but only when a marker is actually found. Guessing "the book starts about
 * 900 characters in" silently eats the first chapter of anything unusual, so
 * an unmarked file is returned exactly as it arrived and the caller is told
 * which happened via `stripped`.
 *
 * The spellings have changed several times since 1994 and older texts are
 * still served in their original form, so the marker match covers THE/THIS,
 * EBOOK/ETEXT, and the pre-2002 `*END*THE SMALL PRINT!` block that came before
 * the `***` convention existed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "@/lib/paths";
import { FILE_TIMEOUT_MS, guardedFetch, readCapped, toBookId, type FetchDeps } from "./client";
import { copy } from "./copy";
import { FILE_ORIGIN, isFileHost } from "./hosts";
import { fail, ok, type Result } from "./types";

/** Where a fetched book is kept so the second request costs nothing. */
export const TEXT_CACHE_DIR = path.join(WORK_ROOT, "gutenberg", "text");

/**
 * A generous ceiling that is still a ceiling. The longest things in the
 * catalogue are dictionaries and encyclopaedia volumes at a few megabytes;
 * 24MB leaves room for those without letting one request pin an unbounded
 * amount of memory.
 */
export const MAX_TEXT_BYTES = 24 * 1024 * 1024;

/**
 * The three paths Gutenberg has served plain text under, newest first.
 *
 * `/cache/epub/{id}/pg{id}.txt` is the modern generated UTF-8 build and is
 * what `/ebooks/{id}.txt.utf-8` redirects to. `/files/{id}/{id}-0.txt` is the
 * older hand-uploaded UTF-8 file, still the only one present for some titles.
 */
function candidateUrls(id: number): string[] {
  return [
    new URL(`/cache/epub/${id}/pg${id}.txt`, FILE_ORIGIN).toString(),
    new URL(`/ebooks/${id}.txt.utf-8`, FILE_ORIGIN).toString(),
    new URL(`/files/${id}/${id}-0.txt`, FILE_ORIGIN).toString(),
    new URL(`/files/${id}/${id}.txt`, FILE_ORIGIN).toString(),
  ];
}

export interface TextOptions extends FetchDeps {
  /**
   * Where the fetched text is cached. Overridden only by tests, so a test run
   * neither writes into the operator's `WORK_ROOT` nor — worse — passes on the
   * second run because the first one left a file there.
   */
  cacheDir?: string;
}

export interface BookText {
  /** The Project Gutenberg id this text belongs to. */
  id: number;
  /**
   * The book itself: the licence header and footer are gone, line endings are
   * `\n`, and there is no byte-order mark. Never empty on a successful result.
   */
  text: string;
  /** `text.length`, so a caller can page it without measuring again. */
  chars: number;
  /**
   * False when no start/end marker was found and the file was returned
   * verbatim. Worth surfacing: it means the first page may open on boilerplate.
   */
  stripped: boolean;
  /** True when it was read from the `WORK_ROOT` cache rather than the network. */
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Boilerplate removal.
// ---------------------------------------------------------------------------

/**
 * `*** START OF THE PROJECT GUTENBERG EBOOK <title> ***`, in every spelling
 * the archive has used.
 *
 * The title sits between the words and the closing `***` and can wrap onto a
 * second line, so the gap is `[\s\S]` rather than `.` — but it is bounded, so
 * a stray `***` elsewhere in a book cannot make this match run away across the
 * whole file and swallow a chapter.
 */
const START_MARKER = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG (?:EBOOK|ETEXT)\b[\s\S]{0,400}?\*\*\*/i;
const END_MARKER = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG (?:EBOOK|ETEXT)\b[\s\S]{0,400}?\*\*\*/i;

/**
 * The pre-2002 form. Texts from the first decade end their header with
 * `*END*THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS*Ver.04.29.93*END*` and have
 * no `***` marker at all.
 */
const SMALL_PRINT = /\*\s*END\s*\*?\s*THE SMALL PRINT![\s\S]{0,400}?\*\s*END\s*\*/i;

/**
 * Cut the licence off a Gutenberg text.
 *
 * Returns the input **unchanged** when no marker is found. That is the whole
 * contract: this function never guesses an offset, because the cost of being
 * wrong is a missing first chapter that nothing downstream can detect.
 */
export function stripGutenbergBoilerplate(raw: string): { text: string; stripped: boolean } {
  let body = raw;
  let stripped = false;

  const start = START_MARKER.exec(body);
  if (start) {
    body = body.slice(start.index + start[0].length);
    stripped = true;
  } else {
    const smallPrint = SMALL_PRINT.exec(body);
    if (smallPrint) {
      body = body.slice(smallPrint.index + smallPrint[0].length);
      stripped = true;
    }
  }

  const end = END_MARKER.exec(body);
  if (end) {
    body = body.slice(0, end.index);
    stripped = true;
  }

  if (!stripped) return { text: raw, stripped: false };

  // Only now, and only because a marker was found: the blank lines either side
  // of a marker belong to the marker, not to the book.
  return { text: body.replace(/^\s+/, "").replace(/\s+$/, ""), stripped: true };
}

/** Decode, normalise line endings, drop a BOM. Never guesses an offset. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

// ---------------------------------------------------------------------------
// The fetch.
// ---------------------------------------------------------------------------

function cachePath(dir: string, id: number): string {
  // `id` is an integer that has already been through `toBookId`, so there is
  // nothing here a path traversal could hold on to.
  return path.join(dir, `${id}.txt`);
}

async function readCache(dir: string, id: number): Promise<string | null> {
  try {
    const text = await fs.readFile(cachePath(dir, id), "utf8");
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function writeCache(dir: string, id: number, text: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    // Written to a neighbouring temp name and renamed, so a process killed
    // mid-write cannot leave a half-file that the next call happily serves.
    const tmp = `${cachePath(dir, id)}.${process.pid}.part`;
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, cachePath(dir, id));
  } catch {
    // A cache that cannot be written is a slow path, not a failure.
  }
}

/**
 * The book's plain text, licence removed, cached under `WORK_ROOT`.
 *
 * Never throws: every failure — a bad id, an unreachable host, a redirect off
 * Gutenberg, a body over the cap — comes back as a typed `Failure` carrying a
 * sentence that is safe to show a person.
 *
 *     import { fetchBookText } from "@/lib/gutenberg/text";
 *     const result = await fetchBookText(84);
 *     if (result.ok) result.value.text // "Frankenstein;\n\nor, the Modern…"
 *
 * `options` exists for tests only; production callers pass nothing.
 */
export async function fetchBookText(gutenbergId: unknown, options: TextOptions = {}): Promise<Result<BookText>> {
  const id = toBookId(gutenbergId);
  if (id === null) return fail("bad_request", copy.badBookId);

  const dir = options.cacheDir ?? TEXT_CACHE_DIR;
  const cached = await readCache(dir, id);
  if (cached) return ok({ id, text: cached, chars: cached.length, stripped: true, cached: true });

  // Every candidate is fetched through the same gate as a proxied download:
  // allowlist first, address guard second, redirects re-checked, body capped.
  let lastFailure: Result<BookText> | null = null;

  for (const url of candidateUrls(id)) {
    const res = await guardedFetch(url, isFileHost, FILE_TIMEOUT_MS, options);
    if (!res.ok) {
      lastFailure = res;
      // A 404 means "not at this path"; anything else means the host is
      // unhappy and trying three more paths will not improve its mood.
      if (res.code === "not_found") continue;
      return res;
    }

    const body = await readCapped(res.value, MAX_TEXT_BYTES);
    if (!body.ok) return body;

    const { text, stripped } = stripGutenbergBoilerplate(decode(body.value));
    if (text.trim().length === 0) {
      lastFailure = fail("bad_response", copy.badResponse);
      continue;
    }

    // Only a stripped text is cached. An unmarked file is a rarity worth
    // re-examining on the next run rather than freezing in place.
    if (stripped) await writeCache(dir, id, text);

    return ok({ id, text, chars: text.length, stripped, cached: false });
  }

  return lastFailure ?? fail("not_found", copy.notFound);
}
