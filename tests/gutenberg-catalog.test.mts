import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CsvParser, parseCsv } from "../src/lib/gutenberg/csv";
import { columnMap, splitAuthors, toCatalogRow } from "../src/lib/gutenberg/catalog";
import { fetchBookText, stripGutenbergBoilerplate, MAX_TEXT_BYTES, type TextOptions } from "../src/lib/gutenberg/text";

/**
 * Nothing here touches the network or the database.
 *
 * The CSV cases are the ones that would otherwise be found in production, by
 * an operator wondering why a book they know exists is not in the catalogue:
 * a naive parser does not crash on `pg_catalog.csv`, it silently produces tens
 * of thousands of *plausible-looking* wrong rows. So every awkward feature of
 * the real file is pinned here, and each one is also fed through the parser a
 * single character at a time — because in the sync it arrives in 1MB chunks
 * that can split anywhere, and "works on the whole string" is not the property
 * that matters.
 */

/** Feed the parser one character per `push`, the worst chunking there is. */
function parseByChar(text: string): string[][] {
  const parser = new CsvParser();
  const rows: string[][] = [];
  for (const ch of text) rows.push(...parser.push(ch));
  rows.push(...parser.end().rows);
  return rows;
}

/** Assert the same records come out whole, and one character at a time. */
function assertParses(text: string, expected: string[][], what: string) {
  assert.deepEqual(parseCsv(text), expected, `${what} (whole)`);
  assert.deepEqual(parseByChar(text), expected, `${what} (one character per chunk)`);
}

// ---------------------------------------------------------------------------
// The CSV parser.
// ---------------------------------------------------------------------------

test("a quoted field keeps its commas instead of becoming three fields", () => {
  assertParses(
    `1,Text,"Jefferson, Thomas, 1743-1826",en\n`,
    [["1", "Text", "Jefferson, Thomas, 1743-1826", "en"]],
    "quoted commas",
  );
});

test("a doubled quote is one literal quote", () => {
  assertParses(`63,"The Number ""e""",en\n`, [["63", 'The Number "e"', "en"]], "escaped quotes");
});

test("a quoted field may contain newlines, and the record does not end there", () => {
  // This is real: record 2 of pg_catalog.csv is a title on two lines. The file
  // has ~90,500 physical lines and ~76,000 records for exactly this reason.
  assertParses(
    `2,"The United States Bill of Rights\nThe Ten Original Amendments",en\n3,Next,en\n`,
    [
      ["2", "The United States Bill of Rights\nThe Ten Original Amendments", "en"],
      ["3", "Next", "en"],
    ],
    "newline inside quotes",
  );
});

test("CRLF ends a record, and a lone CR does too", () => {
  assertParses(`a,b\r\nc,d\r\n`, [["a", "b"], ["c", "d"]], "CRLF");
  assertParses(`a,b\rc,d\r`, [["a", "b"], ["c", "d"]], "bare CR");
});

test("a CRLF inside a quoted field is content, not a record boundary", () => {
  assertParses(`1,"line one\r\nline two"\r\n2,x\r\n`, [["1", "line one\r\nline two"], ["2", "x"]], "CRLF in quotes");
});

test("a record split across chunks survives, wherever the split lands", () => {
  const text = `1,"Jefferson, Thomas","a ""quoted"" bit\nsecond line",en\r\n2,plain,x,y\r\n`;
  const expected = parseCsv(text);
  assert.equal(expected.length, 2);

  // Every possible boundary, including between the two halves of a `""` and
  // between the `\r` and the `\n` of a line ending.
  for (let cut = 0; cut <= text.length; cut++) {
    const parser = new CsvParser();
    const rows = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut))];
    rows.push(...parser.end().rows);
    assert.deepEqual(rows, expected, `split at ${cut}`);
  }
});

test("a final record with no trailing newline is not dropped", () => {
  assertParses(`a,b\nc,d`, [["a", "b"], ["c", "d"]], "no trailing newline");
});

test("empty fields stay empty rather than disappearing", () => {
  assertParses(`1,,"",4\n`, [["1", "", "", "4"]], "empty fields");
});

test("a file that ends inside a quoted field is reported as truncated", () => {
  const parser = new CsvParser();
  parser.push(`1,"unfinished`);
  assert.equal(parser.end().unterminated, true, "a truncated download must be detectable");

  const fine = new CsvParser();
  fine.push(`1,"finished"\n`);
  assert.equal(fine.end().unterminated, false);
});

// ---------------------------------------------------------------------------
// Records → rows.
// ---------------------------------------------------------------------------

const HEADER = ["Text#", "Type", "Issued", "Title", "Language", "Authors", "Subjects", "LoCC", "Bookshelves"];
const COLUMNS = columnMap(HEADER);

test("a real catalogue record becomes a row", () => {
  const row = toCatalogRow(
    ["84", "Text", "1993-10-01", "Frankenstein; Or, The Modern Prometheus", "en", "Shelley, Mary Wollstonecraft, 1797-1851", "Gothic fiction; Horror tales", "PR", "Gothic Fiction"],
    COLUMNS,
  );
  assert.ok(row);
  assert.equal(row.gutenbergId, 84);
  assert.equal(row.title, "Frankenstein; Or, The Modern Prometheus");
  assert.equal(row.type, "Text");
  assert.equal(row.language, "en");
  // The feed has no rights column; everything the archive distributes is
  // public domain, and that is the value the quotation budget reads.
  assert.equal(row.rights, "public-domain");
});

test("a title spanning two lines is collapsed onto one", () => {
  const row = toCatalogRow(
    ["2", "Text", "1972-12-01", "The United States Bill of Rights\nThe Ten Original Amendments", "en", "United States", "", "", ""],
    COLUMNS,
  );
  assert.equal(row?.title, "The United States Bill of Rights The Ten Original Amendments");
});

test("a record without a usable id or title is dropped rather than guessed at", () => {
  for (const bad of [
    ["", "Text", "", "Title", "en", "", "", "", ""],
    ["abc", "Text", "", "Title", "en", "", "", "", ""],
    ["-1", "Text", "", "Title", "en", "", "", "", ""],
    ["12345678", "Text", "", "Title", "en", "", "", "", ""], // eight digits
    ["84", "Text", "", "   ", "en", "", "", "", ""], // no title
  ]) {
    assert.equal(toCatalogRow(bad, COLUMNS), null, `${bad[0]}/${bad[3]} is not a row`);
  }
});

test("the header is matched by name, not by position", () => {
  // Project Gutenberg has reordered this feed before. Reading by index would
  // silently import authors as titles; reading by name simply keeps working.
  const shuffled = columnMap(["Title", "Text#", "Authors", "Language", "Type", "Issued", "Subjects"]);
  const row = toCatalogRow(["Meditations", "2680", "Marcus Aurelius, 121-180", "en", "Text", "1900-01-01", "Ethics"], shuffled);
  assert.equal(row?.gutenbergId, 2680);
  assert.equal(row?.title, "Meditations");
  assert.equal(row?.authors, "Marcus Aurelius, 121-180");
});

test("life dates are lifted off an author name rather than shown as part of it", () => {
  assert.deepEqual(splitAuthors("Shelley, Mary Wollstonecraft, 1797-1851"), [
    { name: "Shelley, Mary Wollstonecraft", birthYear: 1797, deathYear: 1851 },
  ]);
  assert.deepEqual(splitAuthors("Unknown"), [{ name: "Unknown", birthYear: null, deathYear: null }]);
  assert.deepEqual(splitAuthors(""), []);
  // Two authors, and an open-ended date range.
  const pair = splitAuthors("Nemiroff, Robert J.; Bonnell, Jerry T., 1930-");
  assert.equal(pair.length, 2);
  assert.equal(pair[1].birthYear, 1930);
  assert.equal(pair[1].deathYear, null);
});

// ---------------------------------------------------------------------------
// The licence header and footer.
// ---------------------------------------------------------------------------

const BODY = "Chapter 1\n\nIt was a dark and stormy night.";

test("the modern licence header and footer are removed", () => {
  const raw = [
    "The Project Gutenberg eBook of Frankenstein",
    "",
    "This ebook is for the use of anyone anywhere in the United States...",
    "",
    "*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***",
    "",
    BODY,
    "",
    "*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***",
    "",
    "Updated editions will replace the previous one...",
    "Section 1. General Terms of Use...",
  ].join("\n");

  const { text, stripped } = stripGutenbergBoilerplate(raw);
  assert.equal(stripped, true);
  assert.equal(text, BODY);
  assert.ok(!/PROJECT GUTENBERG/i.test(text), "no boilerplate survives to be narrated");
});

test("the older marker spellings are removed too", () => {
  for (const [start, end] of [
    ["*** START OF THIS PROJECT GUTENBERG EBOOK MOBY DICK ***", "*** END OF THIS PROJECT GUTENBERG EBOOK MOBY DICK ***"],
    ["***START OF THE PROJECT GUTENBERG ETEXT MOBY DICK***", "***END OF THE PROJECT GUTENBERG ETEXT MOBY DICK***"],
    ["*** start of the project gutenberg ebook x ***", "*** end of the project gutenberg ebook x ***"],
  ]) {
    const { text, stripped } = stripGutenbergBoilerplate(`header junk\n${start}\n${BODY}\n${end}\nlicence junk`);
    assert.equal(stripped, true, start);
    assert.equal(text, BODY, start);
  }
});

test("a marker wrapped onto a second line is still matched", () => {
  const raw = `junk\n*** START OF THE PROJECT GUTENBERG EBOOK A VERY LONG TITLE THAT\nWRAPPED ONTO A SECOND LINE ***\n${BODY}\n*** END OF THE PROJECT GUTENBERG EBOOK A VERY LONG TITLE THAT\nWRAPPED ONTO A SECOND LINE ***\nlicence`;
  assert.equal(stripGutenbergBoilerplate(raw).text, BODY);
});

test("the pre-2002 small-print header is removed", () => {
  const raw = `Project Gutenberg's Etext\n*END*THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS*Ver.04.29.93*END*\n\n${BODY}`;
  const { text, stripped } = stripGutenbergBoilerplate(raw);
  assert.equal(stripped, true);
  assert.equal(text, BODY);
});

test("a text with no marker at all is returned unchanged, not guessed at", () => {
  // The rule that keeps a missing first chapter from being invented: no offset
  // is ever assumed. An unmarked file comes back byte for byte.
  const raw = `A book with no Gutenberg markers whatsoever.\n\n${BODY}\n`;
  const { text, stripped } = stripGutenbergBoilerplate(raw);
  assert.equal(stripped, false);
  assert.equal(text, raw, "identical, including the trailing newline");
});

test("a footer with no header still has its footer removed", () => {
  const raw = `${BODY}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nlicence text`;
  const { text, stripped } = stripGutenbergBoilerplate(raw);
  assert.equal(stripped, true);
  assert.equal(text, BODY);
});

// ---------------------------------------------------------------------------
// The text fetch is held to the download route's security standard.
// ---------------------------------------------------------------------------

const EVIL = "evil.example.com";
const permissiveGuard = async (raw: string) => new URL(raw);

/**
 * A throwaway cache directory per run. Without it the first run would leave a
 * file in `WORK_ROOT` that the second run reads instead of fetching — and the
 * assertions about *which hosts were contacted* would pass by never contacting
 * any, which is the sort of green that means nothing.
 */
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "bookreel-text-"));
test.after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

function recorder(handler: (url: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl, hosts: () => seen.map((u) => new URL(u).hostname) };
}

test("a hostile book id is refused before anything is fetched", async () => {
  const rec = recorder(() => new Response("x"));
  const deps: TextOptions = { fetchImpl: rec.fetchImpl, guard: permissiveGuard, cacheDir: CACHE };

  for (const attack of [
    `https://${EVIL}/payload.txt`,
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "../../etc/passwd",
    "84/../../../etc/passwd",
    "0",
    "-1",
  ]) {
    const result = await fetchBookText(attack, deps);
    assert.equal(result.ok, false, `${attack} must be refused`);
    if (!result.ok) assert.equal(result.code, "bad_request");
  }

  assert.deepEqual(rec.seen, [], "a hostile id must not cause any request at all");
});

test("the text fetch only ever asks Project Gutenberg's own file host", async () => {
  const rec = recorder(() => new Response(`*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${BODY}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***`));
  const result = await fetchBookText(999999, { fetchImpl: rec.fetchImpl, guard: permissiveGuard, cacheDir: CACHE });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.text, BODY);
  assert.deepEqual([...new Set(rec.hosts())], ["www.gutenberg.org"]);
});

test("a redirect off Gutenberg is refused and never followed", async () => {
  const rec = recorder(() => new Response(null, { status: 302, headers: { location: `https://${EVIL}/payload.txt` } }));
  const result = await fetchBookText(999998, { fetchImpl: rec.fetchImpl, guard: permissiveGuard, cacheDir: CACHE });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.ok(!rec.seen.some((u) => u.includes(EVIL)), "the attacker's URL was never requested");
});

test("a redirect to a private address is refused", async () => {
  const rec = recorder(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/api/episodes" } }));
  const result = await fetchBookText(999997, { fetchImpl: rec.fetchImpl, guard: permissiveGuard, cacheDir: CACHE });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.ok(!rec.seen.some((u) => u.includes("127.0.0.1")));
});

test("the address guard is a second gate on the text fetch too", async () => {
  const rec = recorder(() => new Response("body"));
  const result = await fetchBookText(999996, {
    fetchImpl: rec.fetchImpl,
    guard: async () => {
      throw new Error("resolves to a non-public address");
    },
    cacheDir: CACHE,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "blocked");
  assert.deepEqual(rec.seen, [], "nothing is fetched when the guard refuses");
});

test("an oversized text is refused rather than buffered", async () => {
  const rec = recorder(
    () => new Response("x", { headers: { "content-length": String(MAX_TEXT_BYTES + 1) } }),
  );
  const result = await fetchBookText(999995, { fetchImpl: rec.fetchImpl, guard: permissiveGuard, cacheDir: CACHE });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "too_large");
});

test("a 404 on one path tries the next one, and a real outage does not", async () => {
  // Gutenberg serves the same text under paths that have drifted over 30 years,
  // so a 404 means "not at this path". A 503 means the host is unhappy, and
  // asking it three more times is rude and pointless.
  const missing = recorder((url) =>
    url.includes("/cache/epub/") || url.includes("/ebooks/")
      ? new Response("", { status: 404 })
      : new Response(`*** START OF THE PROJECT GUTENBERG EBOOK X ***\n${BODY}\n*** END OF THE PROJECT GUTENBERG EBOOK X ***`),
  );
  const found = await fetchBookText(999994, { fetchImpl: missing.fetchImpl, guard: permissiveGuard, cacheDir: CACHE });
  assert.equal(found.ok, true);
  assert.ok(missing.seen.length > 1, "it moved on to the next path");

  const down = recorder(() => new Response("", { status: 503 }));
  const failed = await fetchBookText(999993, { fetchImpl: down.fetchImpl, guard: permissiveGuard, cacheDir: CACHE });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "upstream_error");
  assert.equal(down.seen.length, 1, "one refusal is enough");
});
