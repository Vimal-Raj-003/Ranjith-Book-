import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { isApiHost, isFileHost, parseApiUrl, parseFileUrl } from "../src/lib/gutenberg/hosts";
import { pickCover, pickFormats, toFormatKey } from "../src/lib/gutenberg/formats";
import { normalizeBook, normalizeSearchPage } from "../src/lib/gutenberg/normalize";
import {
  MAX_FILE_BYTES,
  downloadBook,
  getBook,
  readCapped,
  safeFilename,
  searchBooks,
  toBookId,
  toPage,
  type FetchDeps,
} from "../src/lib/gutenberg/client";

/**
 * Nothing here touches the network.
 *
 * `fetchImpl` and `guard` are injected on every call, and every test that
 * exercises a refusal also asserts *which hosts were actually contacted* —
 * because "it returned an error" and "it never made the request" are very
 * different outcomes for an SSRF, and only the second one is a fix.
 */

/** Records every URL the code under test tried to fetch. */
function recorder(handler: (url: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl, hosts: () => seen.map((u) => new URL(u).hostname) };
}

/** A guard that approves everything, so the *allowlist* is what is under test. */
const permissiveGuard = async (raw: string) => new URL(raw);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The real shape, taken from a live `GET https://gutendex.com/books/84/`. */
const FRANKENSTEIN = {
  id: 84,
  title: "Frankenstein; or, the modern prometheus",
  authors: [{ name: "Shelley, Mary Wollstonecraft", birth_year: 1797, death_year: 1851 }],
  translators: [],
  subjects: ["Gothic fiction", "Horror tales", "Science fiction"],
  bookshelves: ["Gothic Fiction"],
  languages: ["en"],
  copyright: false,
  media_type: "Text",
  formats: {
    "text/html": "https://www.gutenberg.org/ebooks/84.html.images",
    "application/epub+zip": "https://www.gutenberg.org/ebooks/84.epub3.images",
    "application/x-mobipocket-ebook": "https://www.gutenberg.org/ebooks/84.kf8.images",
    "application/rdf+xml": "https://www.gutenberg.org/ebooks/84.rdf",
    "image/jpeg": "https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg",
    "application/octet-stream": "https://www.gutenberg.org/cache/epub/84/pg84-h.zip",
    "text/plain; charset=utf-8": "https://www.gutenberg.org/ebooks/84.txt.utf-8",
  },
  download_count: 58824,
};

/** A book whose metadata points its EPUB somewhere it has no business pointing. */
function bookWithFormatUrl(url: string) {
  return { ...FRANKENSTEIN, formats: { ...FRANKENSTEIN.formats, "application/epub+zip": url } };
}

const EVIL = "evil.example.com";

// ---------------------------------------------------------------------------
// The host allowlist — pure, no I/O, and the first line of the SSRF defence.
// ---------------------------------------------------------------------------

test("Gutenberg's own hosts are recognised", () => {
  for (const h of ["gutenberg.org", "www.gutenberg.org", "aleph.gutenberg.org", "gutenberg.pglaf.org"]) {
    assert.equal(isFileHost(h), true, `${h} should be a file host`);
  }
  assert.equal(isApiHost("gutendex.com"), true);
  assert.equal(isApiHost("www.gutendex.com"), true);
});

test("hosts that merely look like Gutenberg's are refused", () => {
  for (const h of [
    "evil-gutenberg.org", // suffix without the dot
    "gutenberg.org.evil.com", // Gutenberg as a *prefix* of someone else's domain
    "notgutenberg.org",
    "gutenberg.com", // right name, wrong TLD
    "xgutendex.com",
    "gutendex.com.evil.com",
    "169.254.169.254",
    "localhost",
  ]) {
    assert.equal(isFileHost(h), false, `${h} must not be a file host`);
    assert.equal(isApiHost(h), false, `${h} must not be an API host`);
  }
});

test("the API host and the file host are not interchangeable", () => {
  // A file may not be fetched from the metadata host, and vice versa — the two
  // allowlists are passed separately on purpose.
  assert.equal(isFileHost("gutendex.com"), false);
  assert.equal(isApiHost("www.gutenberg.org"), false);
});

test("only https on an allowed host parses", () => {
  assert.equal(parseFileUrl("https://www.gutenberg.org/ebooks/84.epub3.images").ok, true);

  for (const bad of [
    "http://www.gutenberg.org/ebooks/84.epub3.images", // downgrade
    "ftp://www.gutenberg.org/x",
    "file:///etc/passwd",
    "data:text/html,hi",
    "https://evil.example.com/payload.epub",
    "https://169.254.169.254/latest/meta-data/",
    "not a url",
    "",
    null,
    undefined,
    42,
    { toString: () => "https://www.gutenberg.org/x" },
  ]) {
    const r = parseFileUrl(bad as unknown);
    assert.equal(r.ok, false, `${String(bad)} must be refused`);
    if (!r.ok) assert.equal(r.code, "blocked");
  }
});

test("userinfo cannot smuggle an allowed host in front of an attacker's", () => {
  // `https://www.gutenberg.org@evil.example.com/x` has hostname evil.example.com.
  const r = parseFileUrl(`https://www.gutenberg.org@${EVIL}/payload.epub`);
  assert.equal(r.ok, false);
  const r2 = parseApiUrl(`https://gutendex.com:pass@${EVIL}/books/`);
  assert.equal(r2.ok, false);
});

// ---------------------------------------------------------------------------
// The download route's SSRF defences.
// ---------------------------------------------------------------------------

test("there is no way to hand the download route a URL to fetch", async () => {
  // `downloadBook` takes an id and a format key. An attacker-supplied URL in
  // either position is rejected as malformed *before* anything is fetched.
  const rec = recorder(() => json(FRANKENSTEIN));
  const deps: FetchDeps = { fetchImpl: rec.fetchImpl, guard: permissiveGuard };

  for (const attack of [
    `https://${EVIL}/payload.epub`,
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "../../etc/passwd",
  ]) {
    const asId = await downloadBook(attack, "epub", deps);
    assert.equal(asId.ok, false);
    if (!asId.ok) assert.equal(asId.code, "bad_request");

    const asFormat = await downloadBook("84", attack, deps);
    assert.equal(asFormat.ok, false);
    if (!asFormat.ok) assert.equal(asFormat.code, "bad_request");
  }

  assert.deepEqual(rec.seen, [], "a hostile id or format must not cause any request at all");
});

test("a non-Gutenberg host in the API response is never fetched", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(bookWithFormatUrl(`https://${EVIL}/payload.epub`));
    throw new Error("the attacker's host was contacted");
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.deepEqual(rec.hosts(), ["gutendex.com"], "only the metadata host was contacted");
});

test("a cloud-metadata URL in the API response is never fetched", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(bookWithFormatUrl("http://169.254.169.254/latest/meta-data/"));
    throw new Error("the metadata service was contacted");
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, false);
  assert.deepEqual(rec.hosts(), ["gutendex.com"]);
});

test("a redirect off Gutenberg's hosts is refused and never followed", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(FRANKENSTEIN);
    if (url.includes("gutenberg.org")) {
      return new Response(null, { status: 302, headers: { location: `https://${EVIL}/payload.epub` } });
    }
    throw new Error("the redirect target was fetched");
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.deepEqual(rec.hosts(), ["gutendex.com", "www.gutenberg.org"]);
  assert.ok(!rec.seen.some((u) => u.includes(EVIL)), "the attacker's URL was never requested");
});

test("a redirect to a private address is refused", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(FRANKENSTEIN);
    if (url.includes("gutenberg.org")) {
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/api/episodes" } });
    }
    throw new Error("loopback was fetched");
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.ok(!rec.seen.some((u) => u.includes("127.0.0.1")));
});

test("a relative redirect that stays on Gutenberg is followed", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(FRANKENSTEIN);
    if (url.endsWith("84.epub3.images")) {
      return new Response(null, { status: 301, headers: { location: "/cache/epub/84/pg84.epub3" } });
    }
    return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 });
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.bytes.byteLength, 4);
  assert.ok(rec.seen.some((u) => u.endsWith("/cache/epub/84/pg84.epub3")));
});

test("a redirect loop is abandoned rather than followed for ever", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(FRANKENSTEIN);
    return new Response(null, { status: 302, headers: { location: "https://www.gutenberg.org/round-and-round" } });
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.ok(rec.seen.length < 8, `bounded, not unbounded (made ${rec.seen.length} requests)`);
});

test("the address guard is a second gate, not a formality", async () => {
  // Simulates fetch-guard refusing because the allowed host resolved to a
  // private address — the case the allowlist alone cannot see.
  const rec = recorder(() => json(FRANKENSTEIN));
  const result = await downloadBook("84", "epub", {
    fetchImpl: rec.fetchImpl,
    guard: async () => {
      throw new Error("resolves to a non-public address");
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.deepEqual(rec.seen, [], "nothing is fetched when the guard refuses");
});

test("the download route reads only an id and a format", async () => {
  // A static guard against the hole growing back: if someone ever adds a
  // `?url=` (or `href`/`src`/`target`) parameter to this route, this fails.
  const routePath = fileURLToPath(new URL("../src/app/api/gutenberg/download/route.ts", import.meta.url));
  const source = await fs.readFile(routePath, "utf8");

  const read = [...source.matchAll(/params\.get\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(read.sort(), ["format", "id"], `the route reads: ${read.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Size caps.
// ---------------------------------------------------------------------------

test("a declared Content-Length over the cap is refused before the body is read", async () => {
  const res = new Response("x", { headers: { "content-length": String(MAX_FILE_BYTES + 1) } });
  const result = await readCapped(res, MAX_FILE_BYTES);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "too_large");
});

test("a body that lies about its size is cut off mid-stream", async () => {
  let produced = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 1024;
      // Would run for ever if the cap did not stop it.
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await readCapped(new Response(body), 4096);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "too_large");
  assert.ok(cancelled, "the stream was cancelled rather than drained");
  assert.ok(produced <= 4096 + 4096, `stopped promptly (read ${produced} bytes)`);
});

test("an oversized download is refused by the download path itself", async () => {
  const rec = recorder((url) => {
    if (url.includes("gutendex.com")) return json(FRANKENSTEIN);
    return new Response(new Uint8Array(16), {
      headers: { "content-length": String(MAX_FILE_BYTES + 1_000_000) },
    });
  });

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "too_large");
});

// ---------------------------------------------------------------------------
// Degraded upstream — none of these may throw.
// ---------------------------------------------------------------------------

test("the API being down is a message, not a throw", async () => {
  const result = await searchBooks(
    { search: "frankenstein" },
    {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      guard: permissiveGuard,
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unreachable");
    assert.match(result.message, /Project Gutenberg/);
    assert.ok(!/fetch failed/.test(result.message), "an upstream stack is never shown to a user");
  }
});

test("a timeout is reported as a timeout", async () => {
  const timeoutError = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
  const result = await searchBooks(
    { search: "x" },
    {
      fetchImpl: (async () => {
        throw timeoutError;
      }) as unknown as typeof fetch,
      guard: permissiveGuard,
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "timeout");
});

test("upstream statuses map to distinguishable failures", async () => {
  const cases: [number, string][] = [
    [429, "rate_limited"],
    [500, "upstream_error"],
    [503, "upstream_error"],
    [404, "not_found"],
  ];

  for (const [status, code] of cases) {
    const result = await searchBooks(
      { search: "x" },
      {
        fetchImpl: (async () => new Response("", { status })) as unknown as typeof fetch,
        guard: permissiveGuard,
      },
    );
    assert.equal(result.ok, false, `${status} should fail`);
    if (!result.ok) assert.equal(result.code, code, `${status} -> ${code}`);
  }
});

test("an HTML error page where JSON was expected is a message, not a crash", async () => {
  const result = await searchBooks(
    { search: "x" },
    {
      fetchImpl: (async () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
      guard: permissiveGuard,
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "bad_response");
});

test("valid JSON of an unexpected shape is refused rather than half-rendered", async () => {
  for (const body of [{ detail: "Not found" }, [], null, 42, "ok", { results: "not an array" }]) {
    const result = await searchBooks(
      { search: "x" },
      { fetchImpl: (async () => json(body)) as unknown as typeof fetch, guard: permissiveGuard },
    );
    assert.equal(result.ok, false, `${JSON.stringify(body)} should be refused`);
    if (!result.ok) assert.equal(result.code, "bad_response");
  }
});

test("a genuinely empty result set is a success with no books", async () => {
  const result = await searchBooks(
    { search: "zzzzqqqq" },
    {
      fetchImpl: (async () =>
        json({ count: 0, next: null, previous: null, results: [] })) as unknown as typeof fetch,
      guard: permissiveGuard,
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.books, []);
    assert.equal(result.value.total, 0);
    assert.equal(result.value.hasNext, false);
  }
});

test("one unusable row does not cost the whole page", async () => {
  const result = await searchBooks(
    { search: "x" },
    {
      fetchImpl: (async () =>
        json({
          count: 4,
          next: "https://gutendex.com/books/?page=2",
          previous: null,
          results: [
            FRANKENSTEIN,
            null, // not an object
            { id: "84", title: "String id" }, // wrong id type
            { id: 99, title: null }, // no title
            { id: 100, title: "Formats missing entirely" },
          ],
        })) as unknown as typeof fetch,
      guard: permissiveGuard,
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.value.books.map((b) => b.id),
      [84, 100],
    );
    assert.equal(result.value.hasNext, true);
    assert.deepEqual(result.value.books[1].formats, [], "a book with no formats is listed, just not downloadable");
  }
});

test("a book id that does not exist upstream is not_found", async () => {
  const result = await getBook(999999, {
    fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    guard: permissiveGuard,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "not_found");
});

test("asking for a format the book does not have says so", async () => {
  const rec = recorder(() => json(FRANKENSTEIN)); // Frankenstein has no PDF
  const result = await downloadBook("84", "pdf", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "not_found");
  assert.deepEqual(rec.hosts(), ["gutendex.com"], "no file request is made for a format that does not exist");
});

// ---------------------------------------------------------------------------
// Normalisation — the raw shape never leaks.
// ---------------------------------------------------------------------------

test("a real Gutendex row normalises into this app's own shape", () => {
  const resolved = normalizeBook(FRANKENSTEIN);
  assert.ok(resolved);

  const { book, downloads } = resolved;
  assert.equal(book.id, 84);
  assert.equal(book.title, "Frankenstein; or, the modern prometheus");
  assert.deepEqual(book.authors, [{ name: "Shelley, Mary Wollstonecraft", birthYear: 1797, deathYear: 1851 }]);
  assert.equal(book.downloadCount, 58824);
  assert.deepEqual(book.languages, ["en"]);
  assert.equal(book.coverUrl, "https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg");

  // EPUB, plain text and HTML exist; there is no PDF for this title.
  assert.deepEqual(book.formats, ["epub", "text", "html"]);

  // The download URLs are resolved server-side and are NOT part of the public
  // book — the client only ever learns which format keys exist.
  assert.ok(!("url" in (book as object)));
  assert.ok(!JSON.stringify(book).includes("epub3.images"));
  assert.equal(downloads.find((d) => d.key === "epub")?.url, "https://www.gutenberg.org/ebooks/84.epub3.images");
});

test("archives and non-book formats are never offered", () => {
  const picked = pickFormats(FRANKENSTEIN.formats).map((f) => f.key);
  assert.ok(!picked.includes("pdf" as never));
  // The zip under application/octet-stream and the Mobipocket build are gone.
  assert.equal(picked.length, 3);

  const zipOnly = pickFormats({ "application/epub+zip": "https://www.gutenberg.org/x/book.zip" });
  assert.deepEqual(zipOnly, [], "a .zip is not offered even under a book MIME type");
});

test("the utf-8 text build is preferred over us-ascii", () => {
  const picked = pickFormats({
    "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/84/84-0.txt",
    "text/plain; charset=utf-8": "https://www.gutenberg.org/ebooks/84.txt.utf-8",
  });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].url, "https://www.gutenberg.org/ebooks/84.txt.utf-8");
});

test("plain text with no charset parameter is still recognised", () => {
  const picked = pickFormats({ "text/plain": "https://www.gutenberg.org/files/84/84.txt" });
  assert.deepEqual(picked.map((p) => p.key), ["text"]);
});

test("a cover on someone else's host is dropped rather than rendered", () => {
  const bag = { "image/jpeg": `https://${EVIL}/tracker.jpg` };
  assert.equal(pickCover(bag), `https://${EVIL}/tracker.jpg`, "pickCover is shape-only");
  // ...but normalisation, which is what the UI sees, refuses it.
  const resolved = normalizeBook({ ...FRANKENSTEIN, formats: bag });
  assert.equal(resolved?.book.coverUrl, null);
});

test("nonsense in the formats bag does not throw", () => {
  for (const bag of [null, undefined, 42, "string", [], { "text/plain": 5 }, { "text/plain": null }]) {
    assert.doesNotThrow(() => pickFormats(bag));
    assert.doesNotThrow(() => pickCover(bag));
  }
  assert.equal(normalizeBook({ id: 1, title: "T", formats: 42 })?.book.formats.length, 0);
});

test("missing author years become null rather than NaN", () => {
  const resolved = normalizeBook({
    ...FRANKENSTEIN,
    authors: [{ name: "Anonymous" }, { name: "", birth_year: 1 }, "not an object"],
  });
  assert.deepEqual(resolved?.book.authors, [{ name: "Anonymous", birthYear: null, deathYear: null }]);
});

test("an empty page normalises without throwing on any input", () => {
  for (const raw of [null, undefined, 42, "x", [], {}]) {
    assert.doesNotThrow(() => normalizeSearchPage(raw, 1));
    assert.deepEqual(normalizeSearchPage(raw, 1).books, []);
  }
});

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

test("only a plain positive integer is a book id", () => {
  assert.equal(toBookId("84"), 84);
  assert.equal(toBookId(84), 84);

  for (const bad of [
    "0",
    "-1",
    "1e3",
    " 84",
    "84 ",
    "84abc",
    "+84",
    "0x54",
    "84.0",
    "",
    "99999999", // eight digits
    "٨٤", // Arabic-Indic digits: Number() accepts these, the regex must not
    null,
    undefined,
    {},
    [],
    NaN,
    Infinity,
    1.5,
    -3,
  ]) {
    assert.equal(toBookId(bad as unknown), null, `${String(bad)} is not a book id`);
  }
});

test("only the four offered format keys are accepted", () => {
  for (const good of ["epub", "text", "html", "pdf"]) assert.equal(toFormatKey(good), good);
  for (const bad of ["exe", "EPUB", "epub ", "__proto__", "constructor", "", null, undefined, 1, {}]) {
    assert.equal(toFormatKey(bad as unknown), null, `${String(bad)} is not a format`);
  }
});

test("a page number is clamped rather than trusted", () => {
  assert.equal(toPage("1"), 1);
  assert.equal(toPage("7"), 7);
  assert.equal(toPage("0"), 1);
  assert.equal(toPage("-5"), 1);
  assert.equal(toPage("abc"), 1);
  assert.equal(toPage(null), 1);
  assert.equal(toPage("99999999"), 10_000);
  assert.equal(toPage(3.9), 3);
});

test("a filename cannot escape its directory or split a header", () => {
  assert.equal(safeFilename("Frankenstein; or, the modern prometheus", "epub"), "Frankenstein; or, the modern prometheus.epub");
  assert.equal(safeFilename("../../etc/passwd", "text"), "etc passwd.txt");
  assert.equal(safeFilename("a/b\\c:d*e?f", "html"), "a b c d e f.html");
  assert.equal(safeFilename("....", "pdf"), "gutenberg-book.pdf");
  assert.equal(safeFilename("", "epub"), "gutenberg-book.epub");

  const injected = safeFilename('x"\r\nSet-Cookie: a=b', "epub");
  assert.ok(!/[\r\n"]/.test(injected), `no header-splitting characters survive: ${injected}`);

  assert.ok(safeFilename("z".repeat(500), "epub").length <= 90, "bounded length");
});

test("a search query cannot change the host or the path it is sent to", async () => {
  const rec = recorder(() => json({ count: 0, next: null, previous: null, results: [] }));
  await searchBooks(
    { search: "../../admin?x=1&host=evil", page: 2, languages: "en", topic: "horror" },
    { fetchImpl: rec.fetchImpl, guard: permissiveGuard },
  );

  assert.equal(rec.seen.length, 1);
  const url = new URL(rec.seen[0]);
  assert.equal(url.origin, "https://gutendex.com");
  assert.equal(url.pathname, "/books/");
  assert.equal(url.searchParams.get("search"), "../../admin?x=1&host=evil");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("languages"), "en");
});

test("a bogus languages filter is dropped rather than passed upstream", async () => {
  const rec = recorder(() => json({ count: 0, next: null, previous: null, results: [] }));
  await searchBooks({ search: "x", languages: "en;DROP" }, { fetchImpl: rec.fetchImpl, guard: permissiveGuard });
  assert.equal(new URL(rec.seen[0]).searchParams.has("languages"), false);
});

// ---------------------------------------------------------------------------
// The happy path, end to end, with a fake upstream.
// ---------------------------------------------------------------------------

test("a download comes back with the book's bytes, name and type", async () => {
  const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const rec = recorder((url) =>
    url.includes("gutendex.com") ? json(FRANKENSTEIN) : new Response(payload, { status: 200 }),
  );

  const result = await downloadBook("84", "epub", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual([...result.value.bytes], [...payload]);
    assert.equal(result.value.filename, "Frankenstein; or, the modern prometheus.epub");
    assert.equal(result.value.contentType, "application/epub+zip");
  }
  assert.deepEqual(rec.hosts(), ["gutendex.com", "www.gutenberg.org"]);
});

test("HTML is never proxied back as text/html from this origin", async () => {
  const rec = recorder((url) =>
    url.includes("gutendex.com") ? json(FRANKENSTEIN) : new Response("<script>alert(1)</script>", { status: 200 }),
  );

  const result = await downloadBook("84", "html", { fetchImpl: rec.fetchImpl, guard: permissiveGuard });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.contentType, "application/octet-stream");
    assert.ok(!result.value.contentType.includes("text/html"));
  }
});
