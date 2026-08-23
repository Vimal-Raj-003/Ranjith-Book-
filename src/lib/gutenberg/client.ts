/**
 * Every outbound call this feature makes.
 *
 * Three things are true of `gutendex.com` and they shaped this file:
 *
 *  1. It is slow, and sometimes simply down. During development the cached
 *     endpoints answered in 250ms while an uncached search hung past sixty
 *     seconds — the same host, the same minute. So everything has a timeout
 *     and every failure is a typed `Failure`, never a throw. A route that
 *     500s because a third party is having a bad afternoon is this app's bug,
 *     not theirs.
 *  2. It redirects. `/books?search=x` is a 301 to `/books/?search=x`. That is
 *     harmless, but it means redirect handling cannot be switched off — and a
 *     redirect is precisely how an SSRF gets past a check that only looked at
 *     the first URL. So `redirect: "manual"` is used and *every hop is
 *     re-checked from scratch*, against both the host allowlist and
 *     `fetch-guard`.
 *  3. It is not this app's data. Nothing it returns is trusted: the body is
 *     size-capped before it is parsed, and its shape is checked field by field
 *     in `normalize.ts`.
 *
 * `fetchImpl` and `guard` are injectable so the security behaviour can be
 * tested without a network — the tests drive a fake upstream that redirects to
 * an attacker host and assert the fetch never happens.
 */

import { assertPublicUrl } from "@/lib/media/fetch-guard";
import { EXTENSIONS, RESPONSE_TYPES, toFormatKey, type FormatCandidate } from "./formats";
import { API_ORIGIN, isApiHost, isFileHost, parseAllowedUrl } from "./hosts";
import { normalizeBook, normalizeSearchPage, type ResolvedBook } from "./normalize";
import { copy } from "./copy";
import { fail, ok, type BookSearchPage, type FormatKey, type Result, type SearchQuery } from "./types";

/** Long enough for a cold Gutendex, short enough that a hung route is not one. */
export const API_TIMEOUT_MS = 12_000;
/** A book file is bigger and comes off a fast static host. */
export const FILE_TIMEOUT_MS = 30_000;

/** A page of Gutendex metadata is ~15KB. 2MB is absurdly generous. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
/**
 * The hard ceiling on a proxied download. The largest illustrated EPUB in the
 * catalogue is a few megabytes; 32MB leaves room without letting one request
 * pin 32MB *per concurrent caller* — which is why the body is capped as it is
 * read rather than after, and why the read aborts the moment it is exceeded.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** More than Gutendex ever needs, few enough that a redirect loop cannot spin. */
const MAX_REDIRECTS = 3;

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  /** Defaults to `fetch-guard`'s public-address check. */
  guard?: (raw: string) => Promise<URL>;
}

function deps(d: FetchDeps = {}) {
  return {
    doFetch: d.fetchImpl ?? globalThis.fetch,
    guard: d.guard ?? assertPublicUrl,
  };
}

function statusFailure(status: number) {
  if (status === 404) return fail("not_found", copy.notFound);
  if (status === 429) return fail("rate_limited", copy.rateLimited);
  return fail("upstream_error", copy.upstreamError);
}

/**
 * Fetch a URL, re-verifying the allowlist and the address guard on the initial
 * request and on every redirect it answers with.
 *
 * Exported because the catalogue sync and the book-text fetch are outbound
 * calls too, and they are held to exactly this standard rather than a second,
 * subtly weaker copy of it. There is only one place in this feature that calls
 * `fetch`, and this is it.
 */
export async function guardedFetch(
  startUrl: string,
  allow: (hostname: string) => boolean,
  timeoutMs: number,
  d: FetchDeps,
): Promise<Result<Response>> {
  const { doFetch, guard } = deps(d);
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Check 1 (pure): is this one of Gutenberg's hosts, over https?
    const parsed = parseAllowedUrl(current, allow);
    if (!parsed.ok) return parsed;

    // Check 2 (resolves): does that host point at a public address?
    try {
      await guard(parsed.value.toString());
    } catch {
      return fail("blocked", copy.blocked);
    }

    let res: Response;
    try {
      res = await doFetch(parsed.value.toString(), {
        // The whole point: a 302 comes back as a 302, so the next hop goes
        // through both checks above instead of being followed by `fetch`.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json, */*;q=0.1",
          "user-agent": "BookReel/1.0 (+free books browser)",
        },
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") return fail("timeout", copy.timeout);
      return fail("unreachable", copy.unreachable);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return fail("upstream_error", copy.upstreamError);
      // Drain the redirect body so the connection is not left half-read.
      await res.body?.cancel().catch(() => {});
      // Resolved against the *current* URL, so a relative Location works —
      // and an absolute one to another host simply fails the next check.
      try {
        current = new URL(location, parsed.value).toString();
      } catch {
        return fail("blocked", copy.blocked);
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return statusFailure(res.status);
    }

    return ok(res);
  }

  return fail("blocked", copy.tooManyRedirects);
}

/**
 * Read a body with a hard ceiling, aborting the stream the moment it is
 * crossed. `Content-Length` is checked first as a cheap early out, but it is a
 * claim by someone else's server, so the running total is what actually
 * enforces the limit.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Result<Uint8Array>> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return fail("too_large", copy.tooLarge);
  }

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? fail("too_large", copy.tooLarge) : ok(buf);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return fail("too_large", copy.tooLarge);
      }
      chunks.push(value);
    }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return fail("timeout", copy.timeout);
    return fail("unreachable", copy.unreachable);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return ok(out);
}

async function getJson(url: string, d: FetchDeps): Promise<Result<unknown>> {
  const res = await guardedFetch(url, isApiHost, API_TIMEOUT_MS, d);
  if (!res.ok) return res;

  const body = await readCapped(res.value, MAX_JSON_BYTES);
  if (!body.ok) return body;

  try {
    return ok(JSON.parse(new TextDecoder().decode(body.value)) as unknown);
  } catch {
    // HTML error page, truncated body, Cloudflare interstitial — all land here.
    return fail("bad_response", copy.badResponse);
  }
}

/** Clamp a page number out of a query string into something sane. */
export function toPage(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  // Gutendex has ~2,500 pages of 32. A five-digit page is a probe, not a user.
  return Math.min(Math.trunc(n), 10_000);
}

/** A Gutenberg book id: digits only, no sign, no exponent, no padding tricks. */
export function toBookId(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 && raw <= 9_999_999 ? raw : null;
  if (typeof raw !== "string" || !/^[0-9]{1,7}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

function buildSearchUrl(query: SearchQuery): string {
  // Built from a fixed origin with `URLSearchParams`, so nothing a caller
  // types can change the host, the path, or add a parameter of its own.
  const url = new URL("/books/", API_ORIGIN);
  const p = url.searchParams;

  const search = (query.search ?? "").trim().slice(0, 200);
  if (search) p.set("search", search);

  const topic = (query.topic ?? "").trim().slice(0, 100);
  if (topic) p.set("topic", topic);

  const languages = (query.languages ?? "").trim().slice(0, 40);
  if (/^[a-z]{2}(,[a-z]{2})*$/i.test(languages)) p.set("languages", languages.toLowerCase());

  const page = toPage(query.page ?? 1);
  if (page > 1) p.set("page", String(page));

  return url.toString();
}

/** Search or browse the catalogue. Never throws. */
export async function searchBooks(query: SearchQuery, d: FetchDeps = {}): Promise<Result<BookSearchPage>> {
  const page = toPage(query.page ?? 1);
  const body = await getJson(buildSearchUrl(query), d);
  if (!body.ok) return body;

  // A well-formed page always carries a `results` array. A body that parsed as
  // JSON but has no `results` key at all is a different service answering, not
  // an empty search — those two are worth telling apart, because one is worth
  // retrying and the other is not.
  const hasResults =
    typeof body.value === "object" &&
    body.value !== null &&
    Array.isArray((body.value as { results?: unknown }).results);
  if (!hasResults) return fail("bad_response", copy.badResponse);

  return ok(normalizeSearchPage(body.value, page));
}

/** One book by id, with its download URLs resolved. Never throws. */
export async function getBook(id: number, d: FetchDeps = {}): Promise<Result<ResolvedBook>> {
  const url = new URL(`/books/${id}/`, API_ORIGIN).toString();
  const body = await getJson(url, d);
  if (!body.ok) return body;

  const resolved = normalizeBook(body.value);
  if (!resolved) return fail("not_found", copy.notFound);
  return ok(resolved);
}

/**
 * Turn a title into something a filesystem will accept, on any OS. Path
 * separators, the Windows reserved characters, control characters and leading
 * dots all go — a `Content-Disposition` filename is written to disk by the
 * browser, so it is an injection surface of its own.
 */
export function safeFilename(title: string, key: FormatKey): string {
  const cleaned = title
    .normalize("NFKD")
    // Control characters (including CR/LF, which would otherwise split the
    // header), path separators, and the Windows-reserved set.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    // Leading dots and spaces go together and go repeatedly: once the
    // separators in `../../etc/passwd` have become spaces, stripping only the
    // first run of dots would leave `.. etc passwd` behind. Trailing dots go
    // too — Windows silently drops them, which would rename the file.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");

  return `${cleaned || "gutenberg-book"}.${EXTENSIONS[key]}`;
}

export interface DownloadPayload {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/**
 * The security-critical path, in one place.
 *
 * The client sends a book **id** and a **format key**. It does not send a URL,
 * and there is no code path here that would use one if it did: the URL is
 * looked up from Gutendex server-side, matched against the four format keys
 * this app offers, and then checked against the file-host allowlist a second
 * time before a single byte is fetched — even though it came from the API,
 * because "the API told me to" is not an authorisation.
 */
export async function downloadBook(
  rawId: unknown,
  rawFormat: unknown,
  d: FetchDeps = {},
): Promise<Result<DownloadPayload>> {
  const id = toBookId(rawId);
  if (id === null) return fail("bad_request", copy.badBookId);

  const key = toFormatKey(rawFormat);
  if (!key) return fail("bad_request", copy.badFormat);

  const found = await getBook(id, d);
  if (!found.ok) return found;

  const candidate: FormatCandidate | undefined = found.value.downloads.find((f) => f.key === key);
  if (!candidate) return fail("not_found", copy.formatMissing);

  // Second gate, on a URL that came from upstream rather than from us.
  const checked = parseAllowedUrl(candidate.url, isFileHost);
  if (!checked.ok) return checked;

  const res = await guardedFetch(checked.value.toString(), isFileHost, FILE_TIMEOUT_MS, d);
  if (!res.ok) return res;

  const body = await readCapped(res.value, MAX_FILE_BYTES);
  if (!body.ok) return body;

  return ok({
    bytes: body.value,
    filename: safeFilename(found.value.book.title, key),
    contentType: RESPONSE_TYPES[key],
  });
}
