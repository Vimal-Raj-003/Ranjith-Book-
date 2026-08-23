/**
 * The local Project Gutenberg catalogue, and the reason search works at all.
 *
 * ## Why this exists
 *
 * Search used to be a call to `gutendex.com`. Measured from this machine:
 *
 *     ?search=work+out      HTTP 200 in 34.5s
 *     ?search=meditations   HTTP 200 in 42.5s
 *     ?search=frankenstein  HTTP 200 in  0.5s   (cached upstream)
 *
 * Gutendex is not down. It is forty seconds slow on anything not already in
 * its cache, which is most real queries. No timeout value rescues that: raise
 * it and the operator waits forty seconds, lower it and they get "Project
 * Gutenberg took too long to answer" — which is exactly the screenshot that
 * started this. The feature was unusable for the operator's own query.
 *
 * So search stops depending on Gutendex. Project Gutenberg publishes its whole
 * catalogue as one CSV — 21MB, ~76,000 records, HTTP 200 in about 8 seconds —
 * and that file is downloaded once and queried locally from then on. A search
 * is now a SQLite `SELECT`. There is no network call, so there is no timeout,
 * so there is no failure mode. Gutendex is still used for download URLs, where
 * it is a fast id lookup rather than a slow full-text search.
 *
 * ## Streaming, and why
 *
 * The import streams: the response body goes to disk, then the file is read
 * back in 1MB chunks and parsed incrementally. It is not read into one string
 * and mapped into one array, and that is a deliberate choice rather than an
 * aesthetic one. 21MB of UTF-8 becomes ~42MB as a JS string; ~76,000 row
 * objects with nine string fields each is roughly another 100MB of live heap;
 * held at the same time that is ~150MB of peak resident memory for a
 * background job on a machine that is also running ffmpeg and a TTS model.
 * Streaming holds one 1MB chunk, one 500-row batch, and the parser's
 * carry-over, and it lets progress be reported as rows actually land rather
 * than as one long silence followed by a number.
 *
 * Going via a file rather than parsing the socket directly separates the two
 * clocks: the network read finishes in seconds and the connection closes,
 * instead of being held open for the whole database import and risking a
 * timeout on a request that had already succeeded.
 *
 * ## The staged swap
 *
 * Every row carries the id of the sync that wrote it, and one `Setting` names
 * the generation search reads. A sync writes a *new* generation alongside the
 * live one and only flips that setting at the very end. So a sync that dies
 * halfway — network, disk, power — leaves the previous catalogue serving
 * exactly as it was. There is no window in which the operator is searching a
 * half-populated table that looks identical to a complete one, which is the
 * failure this design exists to make impossible. Abandoned generations are
 * swept at the start of the next sync.
 *
 * ## Raw SQL
 *
 * The `CatalogBook` model is declared in `schema.prisma`, but the statements
 * here are raw. Two reasons: a multi-row `INSERT` is what makes 76,000 rows a
 * half-minute job rather than a several-minute one, and — see `assertModels`
 * in `db.ts` — a Prisma client that has not been regenerated since the model
 * was added answers `undefined` for `prisma.catalogBook` and 500s the route.
 * Raw SQL against a table this module creates itself works either way, which
 * matters for a feature whose whole point is that it cannot fail.
 */

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma, getSetting, setSetting } from "@/lib/db";
import { WORK_ROOT } from "@/lib/paths";
import { guardedFetch, type FetchDeps } from "./client";
import { copy } from "./copy";
import { FILE_ORIGIN, isFileHost } from "./hosts";
import { CsvParser } from "./csv";
import { fail, ok, type FormatKey, type FreeBook, type BookSearchPage, type Result } from "./types";

/** The whole catalogue, as Project Gutenberg publishes it. A fixed URL. */
export const CATALOG_URL = new URL("/cache/epub/feeds/pg_catalog.csv", FILE_ORIGIN).toString();

/** Where the downloaded feed is kept, beside the other working files. */
export const CATALOG_DIR = path.join(WORK_ROOT, "gutenberg");
const CATALOG_FILE = path.join(CATALOG_DIR, "pg_catalog.csv");

/** Which generation search reads. Flipping this is the swap. */
const GENERATION_KEY = "gutenberg.catalog.generation";
const SYNCED_AT_KEY = "gutenberg.catalog.syncedAt";
const ROWS_KEY = "gutenberg.catalog.rows";

/** The feed is 21MB today. 128MB is headroom, and still a ceiling. */
export const MAX_CATALOG_BYTES = 128 * 1024 * 1024;
/** Generous: the download itself takes ~8s, but a cold mirror can crawl. */
export const CATALOG_TIMEOUT_MS = 180_000;

/** Rows per `INSERT`. Nine columns, so 500 rows is 4,500 bound parameters. */
const BATCH_ROWS = 500;

/** How many results one page of the UI shows. Matches the old Gutendex page. */
export const PAGE_SIZE = 32;

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

/**
 * Written to match what `prisma db push` generates for the `CatalogBook`
 * model, so the two agree and neither surprises the other. `IF NOT EXISTS`
 * means the sync works before the controller has pushed the schema and is a
 * no-op after.
 */
async function ensureTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CatalogBook" (
      "generation"  TEXT    NOT NULL,
      "gutenbergId" INTEGER NOT NULL,
      "type"        TEXT    NOT NULL,
      "title"       TEXT    NOT NULL,
      "authors"     TEXT    NOT NULL,
      "subjects"    TEXT    NOT NULL,
      "language"    TEXT    NOT NULL,
      "issued"      TEXT    NOT NULL,
      "rights"      TEXT    NOT NULL,
      PRIMARY KEY ("generation", "gutenbergId")
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "CatalogBook_generation_type_idx" ON "CatalogBook"("generation", "type")`,
  );
}

// ---------------------------------------------------------------------------
// One CSV record → one row.
// ---------------------------------------------------------------------------

/** The header Project Gutenberg ships: Text#,Type,Issued,Title,Language,… */
export type ColumnMap = Record<string, number>;

export function columnMap(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  header.forEach((name, i) => {
    map[name.trim().toLowerCase().replace(/[^a-z#]/g, "")] = i;
  });
  return map;
}

/**
 * Titles legitimately contain newlines — record 2 of the real file is a title
 * on two lines — so whitespace is collapsed rather than preserved. This is the
 * one place a field is altered, and it is a display concern, not a parse one.
 */
function tidy(value: string | undefined, max: number): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export interface CatalogRow {
  gutenbergId: number;
  type: string;
  title: string;
  authors: string;
  subjects: string;
  language: string;
  issued: string;
  rights: string;
}

/**
 * A record → a row, or null when it is not one.
 *
 * The feed has no `Rights` column: everything Project Gutenberg distributes is
 * public domain in the United States, which is the whole basis of the archive.
 * The column is still read by name in case the feed ever grows one, and
 * defaults to `public-domain` — the value `checkQuotationBudget` reads to mean
 * "no quotation limit at all".
 */
export function toCatalogRow(record: string[], columns: ColumnMap): CatalogRow | null {
  const at = (name: string) => record[columns[name] ?? -1];

  const rawId = (at("text#") ?? "").trim();
  if (!/^[0-9]{1,7}$/.test(rawId)) return null;
  const gutenbergId = Number(rawId);
  if (gutenbergId <= 0) return null;

  const title = tidy(at("title"), 300);
  if (!title) return null;

  return {
    gutenbergId,
    type: tidy(at("type"), 32) || "Text",
    title,
    authors: tidy(at("authors"), 400),
    subjects: tidy(at("subjects"), 600),
    language: tidy(at("language"), 40) || "en",
    issued: tidy(at("issued"), 20),
    rights: tidy(at("rights"), 40) || "public-domain",
  };
}

// ---------------------------------------------------------------------------
// Progress, readable while a sync runs.
// ---------------------------------------------------------------------------

export type SyncPhase = "idle" | "downloading" | "importing" | "activating" | "done" | "failed";

export interface SyncProgress {
  phase: SyncPhase;
  /** Bytes of the feed downloaded so far. */
  bytes: number;
  /** Total bytes, when the server declared a `Content-Length`. */
  totalBytes: number | null;
  /** Rows written so far — the number that actually moves during the import. */
  rows: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** A sentence safe to show a person. Never a stack or an upstream URL. */
  message: string | null;
}

const idleProgress = (): SyncProgress => ({
  phase: "idle",
  bytes: 0,
  totalBytes: null,
  rows: 0,
  startedAt: null,
  finishedAt: null,
  message: null,
});

/**
 * Pinned to `globalThis` for the same reason the Prisma client is: a dev server
 * re-evaluates this module on edit, and a fresh `progress` object would make a
 * running sync look like it had never started.
 */
const holder = globalThis as unknown as { __bookreelCatalogSync?: SyncProgress };
holder.__bookreelCatalogSync ??= idleProgress();

const progress = (): SyncProgress => holder.__bookreelCatalogSync as SyncProgress;
const setProgress = (patch: Partial<SyncProgress>) => {
  holder.__bookreelCatalogSync = { ...progress(), ...patch };
};

// ---------------------------------------------------------------------------
// The download.
// ---------------------------------------------------------------------------

/**
 * Stream the feed to disk, capping as it goes.
 *
 * The cap is enforced on the running total rather than on `Content-Length`,
 * because the header is a claim by someone else's server; the declared length
 * is only used as a cheap early refusal and to give the UI a percentage.
 */
async function downloadCatalog(deps: FetchDeps): Promise<Result<number>> {
  const res = await guardedFetch(CATALOG_URL, isFileHost, CATALOG_TIMEOUT_MS, deps);
  if (!res.ok) return res;

  const declared = Number(res.value.headers.get("content-length"));
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (totalBytes !== null && totalBytes > MAX_CATALOG_BYTES) {
    await res.value.body?.cancel().catch(() => {});
    return fail("too_large", copy.tooLarge);
  }
  setProgress({ totalBytes });

  await fs.mkdir(CATALOG_DIR, { recursive: true });
  const partial = `${CATALOG_FILE}.part`;
  const handle = await fs.open(partial, "w");
  let bytes = 0;

  try {
    const body = res.value.body;
    if (!body) return fail("bad_response", copy.badResponse);

    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => {});
        return fail("too_large", copy.tooLarge);
      }
      await handle.write(value);
      setProgress({ bytes });
    }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return name === "TimeoutError" || name === "AbortError"
      ? fail("timeout", copy.timeout)
      : fail("unreachable", copy.unreachable);
  } finally {
    await handle.close().catch(() => {});
  }

  // A truncated feed must not replace a complete catalogue, and the smallest
  // honest signal that something went wrong is a file far too small to be one.
  if (bytes < 1_000_000) return fail("bad_response", copy.catalogTruncated);

  await fs.rename(partial, CATALOG_FILE);
  return ok(bytes);
}

// ---------------------------------------------------------------------------
// The import.
// ---------------------------------------------------------------------------

function insertSql(count: number): string {
  const tuple = "(?,?,?,?,?,?,?,?,?)";
  return (
    `INSERT OR REPLACE INTO "CatalogBook" ` +
    `("generation","gutenbergId","type","title","authors","subjects","language","issued","rights") VALUES ` +
    new Array(count).fill(tuple).join(",")
  );
}

async function insertBatch(generation: string, rows: CatalogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: (string | number)[] = [];
  for (const r of rows) {
    params.push(generation, r.gutenbergId, r.type, r.title, r.authors, r.subjects, r.language, r.issued, r.rights);
  }
  await prisma.$executeRawUnsafe(insertSql(rows.length), ...params);
}

/**
 * Read the feed off disk and write it into `generation`, one batch at a time.
 *
 * The parser is fed 1MB chunks and hands back whatever records completed
 * inside each one, so a title with a newline in it and a record split across a
 * chunk boundary are both ordinary rather than special.
 */
async function importCatalog(generation: string): Promise<Result<number>> {
  const parser = new CsvParser();
  let columns: ColumnMap | null = null;
  let batch: CatalogRow[] = [];
  let imported = 0;
  const seen = new Set<number>();

  const decoder = new TextDecoder("utf-8");
  const stream = createReadStream(CATALOG_FILE, { highWaterMark: 1024 * 1024 });

  const take = async (records: string[][]) => {
    for (const record of records) {
      if (!columns) {
        columns = columnMap(record);
        // The feed's own header. If it is ever renamed, this is where it shows.
        if (columns["text#"] === undefined || columns.title === undefined) {
          throw new Error("header");
        }
        continue;
      }
      const row = toCatalogRow(record, columns);
      // The feed does repeat an id occasionally; the primary key would refuse
      // the second one mid-batch and lose the other 499 rows with it.
      if (!row || seen.has(row.gutenbergId)) continue;
      seen.add(row.gutenbergId);
      batch.push(row);
      if (batch.length >= BATCH_ROWS) {
        await insertBatch(generation, batch);
        imported += batch.length;
        batch = [];
        setProgress({ rows: imported });
      }
    }
  };

  try {
    for await (const chunk of stream) {
      await take(parser.push(decoder.decode(chunk as Buffer, { stream: true })));
    }
    const tail = parser.end();
    if (tail.unterminated) return fail("bad_response", copy.catalogTruncated);
    await take(tail.rows);

    if (batch.length > 0) {
      await insertBatch(generation, batch);
      imported += batch.length;
      setProgress({ rows: imported });
    }
  } catch (err) {
    if ((err as Error)?.message === "header") return fail("bad_response", copy.catalogShape);
    return fail("bad_response", copy.catalogShape);
  } finally {
    stream.destroy();
  }

  // A catalogue this small is not the catalogue; refusing here is what keeps
  // the swap from replacing 76,000 good rows with a handful of bad ones.
  if (imported < 10_000) return fail("bad_response", copy.catalogTruncated);

  return ok(imported);
}

// ---------------------------------------------------------------------------
// The sync.
// ---------------------------------------------------------------------------

async function dropGeneration(generation: string): Promise<void> {
  await prisma
    .$executeRawUnsafe(`DELETE FROM "CatalogBook" WHERE "generation" = ?`, generation)
    .catch(() => 0);
}

async function dropAllExcept(generation: string | null): Promise<void> {
  await prisma
    .$executeRawUnsafe(`DELETE FROM "CatalogBook" WHERE "generation" <> ?`, generation ?? "")
    .catch(() => 0);
}

async function runSync(deps: FetchDeps): Promise<void> {
  const generation = crypto.randomUUID();
  const live = await getSetting(GENERATION_KEY);

  try {
    await ensureTable();
    // Sweep anything a previous crashed sync left behind, but never the live
    // generation — that is the one still answering searches right now.
    await dropAllExcept(live);

    setProgress({ phase: "downloading" });
    const downloaded = await downloadCatalog(deps);
    if (!downloaded.ok) {
      setProgress({ phase: "failed", finishedAt: Date.now(), message: downloaded.message });
      return;
    }

    setProgress({ phase: "importing", bytes: downloaded.value });
    const imported = await importCatalog(generation);
    if (!imported.ok) {
      await dropGeneration(generation);
      setProgress({ phase: "failed", finishedAt: Date.now(), message: imported.message });
      return;
    }

    // The swap. Everything above this line was written beside the live
    // catalogue; this one statement is what makes it the live catalogue.
    setProgress({ phase: "activating" });
    await setSetting(GENERATION_KEY, generation);
    await setSetting(ROWS_KEY, String(imported.value));
    await setSetting(SYNCED_AT_KEY, new Date().toISOString());

    // Best-effort: a failure here leaves stale rows on disk, which costs space
    // and nothing else, because search reads one generation by name.
    await dropAllExcept(generation);

    setProgress({ phase: "done", rows: imported.value, finishedAt: Date.now(), message: null });
  } catch (err) {
    await dropGeneration(generation);
    const detail = err instanceof Error ? err.message : String(err);
    setProgress({ phase: "failed", finishedAt: Date.now(), message: `${copy.catalogFailed} (${detail.slice(0, 120)})` });
  }
}

/**
 * Start a sync, unless one is already running.
 *
 * Returns immediately with the progress record; the work continues in the
 * background and the UI polls `catalogStatus`. A route that awaited this would
 * be a half-minute request that any proxy in front of it is entitled to cut.
 */
export function startCatalogSync(deps: FetchDeps = {}): { started: boolean; progress: SyncProgress } {
  const current = progress();
  if (current.phase === "downloading" || current.phase === "importing" || current.phase === "activating") {
    return { started: false, progress: current };
  }

  holder.__bookreelCatalogSync = {
    ...idleProgress(),
    phase: "downloading",
    startedAt: Date.now(),
  };

  void runSync(deps);
  return { started: true, progress: progress() };
}

/** For tests and scripts: run a sync to completion rather than in the background. */
export async function syncCatalogNow(deps: FetchDeps = {}): Promise<SyncProgress> {
  holder.__bookreelCatalogSync = { ...idleProgress(), phase: "downloading", startedAt: Date.now() };
  await runSync(deps);
  return progress();
}

export interface CatalogStatus {
  /** False means the page genuinely cannot help yet — the one honest empty. */
  synced: boolean;
  rows: number;
  syncedAt: string | null;
  progress: SyncProgress;
}

export async function catalogStatus(): Promise<CatalogStatus> {
  const generation = await getSetting(GENERATION_KEY);
  const rows = Number(await getSetting(ROWS_KEY)) || 0;
  return {
    synced: Boolean(generation) && rows > 0,
    rows,
    syncedAt: await getSetting(SYNCED_AT_KEY),
    progress: progress(),
  };
}

// ---------------------------------------------------------------------------
// Search — a local query, and the entire point of the exercise.
// ---------------------------------------------------------------------------

/**
 * SQLite's `LIKE` is case-insensitive for ASCII out of the box, which is what
 * makes a lowercase-shadow column unnecessary here. `%` and `_` are wildcards
 * and `\` is the escape, so all three are escaped out of anything the operator
 * typed before it becomes a pattern.
 */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function likeExact(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Up to eight words; anything past that is a paste, not a search. */
function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

interface CatalogHit {
  gutenbergId: number;
  title: string;
  authors: string;
  subjects: string;
  language: string;
  issued: string;
  rights: string;
}

/**
 * Gutenberg's cover, by convention rather than by lookup.
 *
 * The feed carries no image URL, but the archive names every generated cover
 * the same way. It is built from a validated integer on the file host the
 * allowlist already trusts, and the card falls back to its lettered
 * placeholder on error — so a book without one looks deliberate rather than
 * broken, and no second network call is needed to find out which it is.
 */
function coverUrl(id: number): string {
  return new URL(`/cache/epub/${id}/pg${id}.cover.medium.jpg`, FILE_ORIGIN).toString();
}

/**
 * Which formats to offer.
 *
 * The feed does not say. Every `Text` record in the archive is generated into
 * EPUB, plain text and HTML, so those three are offered; the download route
 * still resolves the real URL from Gutendex and answers honestly if a
 * particular build is genuinely missing. PDF is never generated and is not
 * offered at all.
 */
const TEXT_FORMATS: FormatKey[] = ["epub", "text", "html"];

/** `"Shelley, Mary Wollstonecraft, 1797-1851; Someone Else"` → author objects. */
export function splitAuthors(raw: string): FreeBook["authors"] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((entry) => {
      // The feed appends life dates to the name: "Surname, First, 1797-1851".
      const dates = entry.match(/,\s*(\d{3,4}\??)\s*-\s*(\d{3,4}\??)?\s*$/);
      if (!dates) return { name: entry.slice(0, 160), birthYear: null, deathYear: null };
      const toYear = (v: string | undefined) => {
        const n = Number((v ?? "").replace("?", ""));
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      return {
        name: entry.slice(0, dates.index).trim().slice(0, 160),
        birthYear: toYear(dates[1]),
        deathYear: toYear(dates[2]),
      };
    });
}

function toFreeBook(hit: CatalogHit): FreeBook {
  return {
    id: hit.gutenbergId,
    title: hit.title,
    authors: splitAuthors(hit.authors),
    subjects: hit.subjects ? hit.subjects.split(";").map((s) => s.trim()).filter(Boolean).slice(0, 12) : [],
    languages: hit.language ? hit.language.split(";").map((s) => s.trim()).filter(Boolean).slice(0, 8) : [],
    // The feed has no download counts. Ordering is by relevance instead —
    // see the scoring below — and the card hides the number when it is zero.
    downloadCount: 0,
    coverUrl: coverUrl(hit.gutenbergId),
    formats: TEXT_FORMATS,
  };
}

export interface CatalogQuery {
  search?: string;
  page?: number;
}

/**
 * Search the local catalogue. No network call, no timeout, no failure mode
 * other than "the catalogue has never been synced", which is a distinct and
 * actionable answer rather than an error.
 *
 * Matching is AND across the words typed, over title, author and subject.
 * Ranking is done in SQL rather than in JavaScript so that `LIMIT`/`OFFSET`
 * paginates the *ranked* order — ranking a truncated page would put the best
 * match on page four.
 */
export async function searchCatalog(query: CatalogQuery): Promise<Result<BookSearchPage>> {
  const generation = await getSetting(GENERATION_KEY);
  if (!generation) return fail("not_found", copy.catalogMissing);

  const raw = (query.search ?? "").trim().slice(0, 200);
  const words = terms(raw);
  if (words.length === 0) return fail("bad_request", copy.catalogNoQuery);

  const page = Math.max(1, Math.min(Math.trunc(query.page ?? 1) || 1, 10_000));

  const where: string[] = [`"generation" = ?`, `"type" = 'Text'`];
  const whereParams: (string | number)[] = [generation];
  for (const word of words) {
    const pattern = likeTerm(word);
    where.push(`("title" LIKE ? ESCAPE '\\' OR "authors" LIKE ? ESCAPE '\\' OR "subjects" LIKE ? ESCAPE '\\')`);
    whereParams.push(pattern, pattern, pattern);
  }
  const whereSql = where.join(" AND ");

  // Relevance, in descending order of how strongly it means "this one".
  const scoreParts = [
    `(CASE WHEN "title" LIKE ? ESCAPE '\\' THEN 120 ELSE 0 END)`, // the title, exactly
    `(CASE WHEN "title" LIKE ? ESCAPE '\\' THEN 60 ELSE 0 END)`, // the title starts with it
    `(CASE WHEN "title" LIKE ? ESCAPE '\\' THEN 40 ELSE 0 END)`, // the phrase is in the title
    `(CASE WHEN "authors" LIKE ? ESCAPE '\\' THEN 20 ELSE 0 END)`, // the phrase is in the author
  ];
  const phrase = likeExact(raw);
  const scoreParams: (string | number)[] = [phrase, `${phrase}%`, `%${phrase}%`, `%${phrase}%`];
  // Every word in the title beats some words in the title and the rest in a
  // subject list, which is where the noise lives.
  for (const word of words) {
    scoreParts.push(`(CASE WHEN "title" LIKE ? ESCAPE '\\' THEN 8 ELSE 0 END)`);
    scoreParams.push(likeTerm(word));
  }
  const scoreSql = scoreParts.join(" + ");

  const countRows = await prisma.$queryRawUnsafe<{ n: number | bigint }[]>(
    `SELECT COUNT(*) AS n FROM "CatalogBook" WHERE ${whereSql}`,
    ...whereParams,
  );
  const total = Number(countRows[0]?.n ?? 0);

  const hits = await prisma.$queryRawUnsafe<CatalogHit[]>(
    `SELECT "gutenbergId","title","authors","subjects","language","issued","rights", ${scoreSql} AS score
       FROM "CatalogBook"
      WHERE ${whereSql}
      ORDER BY score DESC, LENGTH("title") ASC, "gutenbergId" ASC
      LIMIT ? OFFSET ?`,
    ...scoreParams,
    ...whereParams,
    PAGE_SIZE,
    (page - 1) * PAGE_SIZE,
  );

  return ok({
    books: hits.map(toFreeBook),
    total,
    page,
    hasNext: page * PAGE_SIZE < total,
    hasPrevious: page > 1,
  });
}
