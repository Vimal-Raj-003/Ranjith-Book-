/**
 * Gutendex keys its `formats` bag by MIME type, and the keys are not stable
 * strings: plain text arrives as `text/plain; charset=utf-8` on one book and
 * `text/plain; charset=us-ascii` on another, and a few carry no charset at
 * all. Matching on the exact key would silently drop half the catalogue, so
 * the type is matched on its `type/subtype` essence with the parameters cut
 * off.
 *
 * Only four formats are offered. The rest of the bag — RDF metadata, the
 * Mobipocket build, the `application/octet-stream` zip archives — is either
 * not a book or not something a reader can open, and an archive is exactly the
 * kind of thing that should not be proxied through this app's memory.
 */

import type { FormatKey } from "./types";

/** Display order, which is also preference order. EPUB first: it is the one
 *  most readers can actually open. */
export const FORMAT_KEYS: readonly FormatKey[] = ["epub", "text", "html", "pdf"] as const;

const FORMAT_SET = new Set<string>(FORMAT_KEYS);

/** A client-supplied string is only a format key if it is one of these four. */
export function toFormatKey(raw: unknown): FormatKey | null {
  return typeof raw === "string" && FORMAT_SET.has(raw) ? (raw as FormatKey) : null;
}

export const EXTENSIONS: Record<FormatKey, string> = {
  epub: "epub",
  text: "txt",
  html: "html",
  pdf: "pdf",
};

/**
 * The Content-Type this app answers the browser with. Deliberately NOT echoed
 * from upstream: a response header from someone else's server is attacker-
 * adjacent input, and `text/html` served from this origin would be a stored
 * XSS. Everything is sent as a download, and the two textual formats are
 * pinned to a charset so a reader does not have to guess.
 */
export const RESPONSE_TYPES: Record<FormatKey, string> = {
  epub: "application/epub+zip",
  text: "text/plain; charset=utf-8",
  // Served as plain octets, never as text/html — see above.
  html: "application/octet-stream",
  pdf: "application/pdf",
};

/** Strip `; charset=…` and normalise case, so one match handles every variant. */
function essence(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

function classify(mime: string): FormatKey | null {
  switch (essence(mime)) {
    case "application/epub+zip":
      return "epub";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "text";
    case "text/html":
      return "html";
    default:
      return null;
  }
}

/**
 * Rank one candidate URL against another for the same format key. Gutenberg
 * offers several builds of the same format and they are not equivalent:
 *
 * - a `.zip` is an archive, not a readable file — never offered at all;
 * - `charset=utf-8` beats `us-ascii`, which mangles anything but English;
 * - the `.images` HTML build is the complete one.
 */
function score(mime: string, url: string): number {
  let n = 0;
  if (/charset=utf-8/i.test(mime)) n += 2;
  if (/\.images$/.test(url)) n += 1;
  return n;
}

export interface FormatCandidate {
  key: FormatKey;
  mediaType: string;
  url: string;
}

/**
 * Pick the best URL for each of the four offered formats out of a raw Gutendex
 * `formats` bag. Anything not a string, not https, or an archive is skipped
 * rather than throwing — a single odd entry must not cost the whole result.
 */
export function pickFormats(bag: unknown): FormatCandidate[] {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return [];

  const best = new Map<FormatKey, { candidate: FormatCandidate; score: number }>();

  for (const [mime, value] of Object.entries(bag as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    // Archives are not offered: unzipping is not this app's job, and a zip
    // bomb proxied through the download route is a memory problem.
    if (/\.zip$/i.test(value)) continue;
    if (!value.startsWith("https://")) continue;

    const key = classify(mime);
    if (!key) continue;

    const candidate: FormatCandidate = { key, mediaType: mime, url: value };
    const s = score(mime, value);
    const held = best.get(key);
    if (!held || s > held.score) best.set(key, { candidate, score: s });
  }

  return FORMAT_KEYS.flatMap((k) => {
    const held = best.get(k);
    return held ? [held.candidate] : [];
  });
}

/** The cover image, if the book has one. Gutenberg keys it under `image/jpeg`. */
export function pickCover(bag: unknown): string | null {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  for (const [mime, value] of Object.entries(bag as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (!value.startsWith("https://")) continue;
    if (essence(mime).startsWith("image/")) return value;
  }
  return null;
}
