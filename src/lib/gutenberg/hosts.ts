/**
 * Which hosts this app is willing to talk to, and nothing else.
 *
 * The download route is the reason this file exists. It hands a URL to
 * `fetch()` from the server, and the only thing standing between that and a
 * server-side request forgery is that the URL was not chosen by the caller.
 * So there are two independent checks, in this order:
 *
 *   1. this file — is the host one of Gutenberg's own? (pure, no I/O)
 *   2. `fetch-guard` — does that host resolve to a public address?
 *
 * The order matters. The allowlist runs first so an attacker-supplied host
 * never reaches the resolver: no DNS lookup is spent on it, nothing is logged
 * about it upstream, and there is no window in which a name that resolves
 * publicly on the first look could be re-pointed. `fetch-guard`'s own comment
 * is honest that it cannot beat a hostile DNS server on its own; an allowlist
 * of four names it cannot control is what closes that gap here.
 *
 * Matching is on the parsed `URL.hostname`, never on the raw string, so
 * `https://gutenberg.org@evil.example.com/` (userinfo, not a host) and
 * `https://evil-gutenberg.org/` both miss. Suffix matching is anchored to a
 * leading dot for the same reason.
 */

import { fail, ok, type Result } from "./types";

/** The metadata API. Only ever fetched as JSON. */
export const API_ORIGIN = "https://gutendex.com";

const API_HOSTS = new Set(["gutendex.com", "www.gutendex.com"]);

/**
 * Where Gutenberg serves its files. `gutenberg.org` and its subdomains cover
 * the `www.` links Gutendex returns today plus the mirrors it has used before
 * (`aleph.`, `readingroo.ms` is deliberately NOT here — it is a different
 * registrable domain and would have to be added on purpose).
 */
const FILE_DOMAINS = ["gutenberg.org", "pglaf.org"];

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isApiHost(hostname: string): boolean {
  return API_HOSTS.has(hostname.toLowerCase());
}

export function isFileHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return FILE_DOMAINS.some((d) => matchesDomain(host, d));
}

/** Either of the two — used for cover images, which come from the file hosts. */
export function isGutenbergHost(hostname: string): boolean {
  return isApiHost(hostname) || isFileHost(hostname);
}

/**
 * Parse a URL and refuse it unless it is https and on an allowed host.
 *
 * Returns a `Result` rather than throwing: every caller here is on a path that
 * must degrade into a message, not a 500. Plain http is refused as well as the
 * exotic schemes — Gutenberg serves https, and accepting http would let a
 * downgrade land in the middle of a proxied download.
 */
export function parseAllowedUrl(raw: unknown, allow: (hostname: string) => boolean): Result<URL> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return fail("blocked", "That download link is not a usable URL.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("blocked", "That download link is not a usable URL.");
  }

  if (url.protocol !== "https:") {
    return fail("blocked", "Only secure https links to Project Gutenberg are fetched.");
  }

  // Credentials in a URL are a classic way to make a hostname *look* like an
  // allowed one. There is never a legitimate reason for Gutenberg to use them.
  if (url.username || url.password) {
    return fail("blocked", "That download link is not a usable URL.");
  }

  if (!allow(url.hostname)) {
    return fail("blocked", "That file is not hosted by Project Gutenberg, so it was not fetched.");
  }

  return ok(url);
}

/** The download proxy's gate: a file URL, on a Gutenberg file host, over https. */
export const parseFileUrl = (raw: unknown): Result<URL> => parseAllowedUrl(raw, isFileHost);

/** The metadata client's gate. */
export const parseApiUrl = (raw: unknown): Result<URL> => parseAllowedUrl(raw, isApiHost);
