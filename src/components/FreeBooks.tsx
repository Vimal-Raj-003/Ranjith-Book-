"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { freeBooks as t } from "./free-books-copy";
import { Badge, EmptyState, Hint } from "./ui";

/**
 * Browse Project Gutenberg and download a book.
 *
 * This component talks to `/api/gutenberg/*` over `fetch` and imports nothing
 * from `src/lib/gutenberg`. That is not a style preference: the server library
 * reaches `fetch-guard`, which reaches `node:dns` and `node:net`, and pulling
 * that into a `"use client"` module puts it in the browser bundle and 500s
 * every route in the app. `tests/client-ui.test.mts` enforces it. The book
 * shapes below are therefore declared here rather than imported from
 * `@/lib/gutenberg/types` — a duplicated interface is the cheap half of that
 * trade, and the API route is what keeps the two honest.
 *
 * The shape of this pane changed when search stopped being a network call.
 * Results now arrive in about forty milliseconds, so the loading state is
 * almost never seen and has been demoted: previous results stay on screen,
 * dimmed, rather than being replaced by a skeleton that flashes. What matters
 * instead is the *catalogue* state, because there is now one condition under
 * which this page genuinely cannot answer anything — nobody has downloaded the
 * catalogue yet — and that gets the largest, plainest treatment on the page.
 */

type FormatKey = "epub" | "text" | "html" | "pdf";

interface Author {
  name: string;
  birthYear: number | null;
  deathYear: number | null;
}

interface FreeBook {
  id: number;
  title: string;
  authors: Author[];
  subjects: string[];
  languages: string[];
  downloadCount: number;
  coverUrl: string | null;
  formats: FormatKey[];
}

interface SearchPage {
  books: FreeBook[];
  total: number;
  page: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

type SyncPhase = "idle" | "downloading" | "importing" | "activating" | "done" | "failed";

interface SyncProgress {
  phase: SyncPhase;
  bytes: number;
  totalBytes: number | null;
  rows: number;
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
}

interface CatalogStatus {
  synced: boolean;
  rows: number;
  syncedAt: string | null;
  progress: SyncProgress;
}

/** What the pane is doing right now. One value, so two states cannot both show. */
type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; page: SearchPage; query: string };

const RUNNING: SyncPhase[] = ["downloading", "importing", "activating"];
const isRunning = (p: SyncProgress | null) => Boolean(p && RUNNING.includes(p.phase));

/**
 * Read the catalogue's state. Deliberately module-scope and free of any
 * `setState`: it is called from an effect, from an interval and from a click
 * handler, and each of those decides for itself whether it is still interested
 * in the answer by the time it arrives.
 */
async function readCatalogStatus(): Promise<CatalogStatus | null> {
  try {
    const res = await fetch("/api/gutenberg/catalog", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as CatalogStatus;
  } catch {
    return null;
  }
}

function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "PG";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The cover, or a quiet tinted field with the book's initials.
 *
 * A broken-image icon is never acceptable here, and it matters more than it
 * used to: the catalogue feed carries no image URL, so the cover address is
 * built from Project Gutenberg's own naming convention rather than looked up.
 * That is right for the large majority of the archive and wrong for the tail,
 * and `onError` is what makes the tail look deliberate instead of broken.
 */
function Cover({ book }: { book: FreeBook }) {
  const [broken, setBroken] = useState(false);

  return (
    <div
      className="w-full overflow-hidden"
      style={{ aspectRatio: "2 / 3", background: "var(--slab-2)" }}
    >
      {book.coverUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- a remote public-domain cover, not a statically optimizable asset
        <img
          src={book.coverUrl}
          alt={t.coverAlt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="block h-full w-full object-cover"
        />
      ) : (
        <div className="poster-empty" aria-hidden>
          {initials(book.title)}
        </div>
      )}
    </div>
  );
}

function authorLine(book: FreeBook): string {
  if (book.authors.length === 0) return t.unknownAuthor;
  const [first] = book.authors;
  const line = t.authorLine(first.name, first.birthYear, first.deathYear);
  return book.authors.length > 1 ? `${line} +${book.authors.length - 1}` : line;
}

/** Pull the server's filename out of `Content-Disposition`, or fall back. */
function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the ASCII form */
    }
  }
  const plain = header.match(/filename="([^"]+)"/i);
  return plain ? plain[1] : fallback;
}

function BookCard({ book }: { book: FreeBook }) {
  const [pending, setPending] = useState<FormatKey | null>(null);
  const [failed, setFailed] = useState(false);

  async function download(format: FormatKey) {
    if (pending) return;
    setPending(format);
    setFailed(false);
    try {
      // Only an id and a format key ever leave the browser. The route looks
      // the real URL up itself — see the comment on the download route.
      const res = await fetch(
        `/api/gutenberg/download?id=${encodeURIComponent(book.id)}&format=${encodeURIComponent(format)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error("download failed");

      const blob = await res.blob();
      const name = filenameFrom(res.headers.get("content-disposition"), `${book.id}.${format}`);
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: revoking synchronously can beat the click
      // in some browsers and produce a zero-byte file.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <li className="flex">
      <article className="library-card w-full" aria-labelledby={`gb-${book.id}-title`}>
        {/* Keyed by the cover URL so a card reused for a different book starts
            with a fresh `broken` flag — resetting it from an effect would be a
            cascading render, and this is what keys are for. */}
        <Cover key={book.coverUrl ?? "no-cover"} book={book} />

        <div className="flex flex-1 flex-col gap-1.5 p-3">
          <h3
            id={`gb-${book.id}-title`}
            className="font-display text-[14px] font-semibold leading-snug"
            style={{ color: "var(--ink)" }}
          >
            {book.title}
          </h3>

          <p className="text-[12px] leading-snug" style={{ color: "var(--mute)" }}>
            {authorLine(book)}
          </p>

          <p className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
            {t.bookMeta(book.id, book.languages)}
          </p>

          <div className="mt-auto flex flex-col gap-1.5 pt-2">
            {book.formats.length === 0 ? (
              <Hint>{t.noFormats}</Hint>
            ) : (
              <>
                <span className="field-label" style={{ marginBottom: 0 }}>
                  {t.downloadsLabel}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {book.formats.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => download(f)}
                      disabled={pending !== null}
                      aria-label={t.downloadAria(book.title, t.formatLabel[f])}
                      className="rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider disabled:opacity-60"
                      style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
                    >
                      {pending === f ? t.downloading : t.formatShort[f]}
                    </button>
                  ))}
                </div>
              </>
            )}

            {failed && (
              <p role="alert" className="text-[12px]" style={{ color: "var(--rose)" }}>
                {t.downloadFailed}
              </p>
            )}
          </div>
        </div>
      </article>
    </li>
  );
}

/** A one-word search the operator can run with a click. */
function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <span className="field-label" style={{ marginBottom: 0 }}>
        {t.suggestionsLabel}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {t.suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-lg border px-2.5 py-1 text-[12px]"
            style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The catalogue's state, and the only control that changes it.
 *
 * Three shapes, deliberately very different in weight:
 *
 *  - **never synced** — a full panel, because the page cannot do its job and
 *    saying so quietly would leave the operator searching an empty catalogue
 *    and concluding the archive has no books about philosophy;
 *  - **syncing** — a progress line that names the phase and moves;
 *  - **ready** — one small line with a row count, the age, and a re-sync.
 */
function CatalogPanel({
  status,
  onSync,
  busy,
}: {
  status: CatalogStatus | null;
  onSync: () => void;
  busy: boolean;
}) {
  if (!status) {
    return <Hint>{t.catalogChecking}</Hint>;
  }

  const p = status.progress;
  const running = isRunning(p);

  if (running) {
    const pct =
      p.phase === "downloading" && p.totalBytes ? Math.min(100, Math.round((p.bytes / p.totalBytes) * 100)) : null;
    return (
      <div className="panel panel-body flex flex-col gap-2" aria-label={t.catalogProgressLabel}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
            {t.catalogPhase[p.phase]}
          </p>
          <p className="font-mono text-[11px]" style={{ color: "var(--mute-2)" }} aria-live="polite">
            {p.phase === "downloading" ? t.catalogBytes(p.bytes, p.totalBytes) : t.catalogRows(p.rows)}
          </p>
        </div>
        {/* A determinate bar while bytes are counted, an indeterminate shimmer
            once the phase has no total to divide by. */}
        <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--slab-2)" }}>
          <div
            className={pct === null ? "skeleton h-full w-full" : "h-full"}
            style={pct === null ? undefined : { width: `${pct}%`, background: "var(--ink)", transition: "width 200ms" }}
          />
        </div>
        <Hint>{t.catalogSafety}</Hint>
      </div>
    );
  }

  if (!status.synced) {
    return (
      <div className="panel panel-body flex flex-col gap-2">
        <p className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
          {t.catalogEmptyTitle}
        </p>
        <EmptyState>{t.catalogEmptyBody}</EmptyState>
        {p.phase === "failed" && (
          <p role="alert" className="text-[13px]" style={{ color: "var(--rose)" }}>
            {p.message ?? t.catalogFailedFallback}
          </p>
        )}
        <div>
          <button
            type="button"
            onClick={onSync}
            disabled={busy}
            className="rounded-lg border px-3.5 py-2 text-[13px] font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
          >
            {p.phase === "failed" ? t.catalogRetryAction : t.catalogSyncAction}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
        {t.catalogReady(status.rows, t.since(status.syncedAt))}
      </p>
      <div className="flex items-center gap-2">
        {p.phase === "failed" && (
          <span role="alert" className="text-[12px]" style={{ color: "var(--rose)" }}>
            {p.message ?? t.catalogFailedFallback}
          </span>
        )}
        <button
          type="button"
          onClick={onSync}
          disabled={busy}
          className="rounded-lg border px-3 py-1.5 text-[12px] disabled:opacity-60"
          style={{ borderColor: "var(--line)", color: "var(--mute)" }}
        >
          {t.catalogResyncAction}
        </button>
      </div>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <ul className="library-grid" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="flex">
          <div className="library-card w-full">
            <div className="skeleton w-full" style={{ aspectRatio: "2 / 3", borderRadius: 0 }} />
            <div className="flex flex-col gap-2 p-3">
              <div className="skeleton" style={{ height: 14 }} />
              <div className="skeleton" style={{ height: 11, width: "65%" }} />
              <div className="skeleton" style={{ height: 24, width: "80%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function FreeBooks() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** The submitted query and page — changing either is what triggers a fetch. */
  const [request, setRequest] = useState<{ query: string; page: number } | null>(null);
  /** Null until the first status has come back; never guessed at. */
  const [catalog, setCatalog] = useState<CatalogStatus | null>(null);
  /**
   * Set by the click and cleared when the POST comes back. It covers only the
   * gap before the first status shows the sync running — after that, whether a
   * sync is in flight is derived from the status itself, so a sync started in
   * another tab disables this one's button too.
   */
  const [starting, setStarting] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /**
   * The last successful page, kept on screen (dimmed) while the next one
   * loads. State rather than a ref: it is read during render, and a ref read
   * during render is exactly the stale-value bug `react-hooks/refs` exists to
   * stop.
   */
  const [held, setHeld] = useState<SearchPage | null>(null);

  /** Read the status once. Nothing is set here — see the effects below. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const body = await readCatalogStatus();
      if (!cancelled && body) setCatalog(body);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Poll while a sync is running, and stop the moment it is not.
   *
   * The interval is keyed off the status the pane already holds, so a sync
   * started in another tab (or left running across a reload) is picked up on
   * the first status read rather than only by the tab that clicked the button.
   */
  useEffect(() => {
    if (!isRunning(catalog?.progress ?? null)) return;
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        const body = await readCatalogStatus();
        if (!cancelled && body) setCatalog(body);
      })();
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [catalog]);

  const startSync = useCallback(async () => {
    setStarting(true);
    try {
      await fetch("/api/gutenberg/catalog", { method: "POST", cache: "no-store" });
    } catch {
      /* the status poll above reports whatever actually happened */
    }
    const body = await readCatalogStatus();
    if (body) setCatalog(body);
    setStarting(false);
  }, []);

  /**
   * Start a search. The move into `loading` belongs to the event that caused
   * it, not to the effect that services it — setting state synchronously
   * inside an effect body is a cascading render, and `react-hooks` is right to
   * refuse it. The effect below only reports what the fetch *came back* with.
   *
   * A fresh object every time, so asking for the same query and page again
   * (the retry button) still changes the dependency and re-runs the fetch.
   */
  const startRequest = useCallback((next: { query: string; page: number }) => {
    setPhase({ kind: "loading" });
    setRequest({ ...next });
  }, []);

  useEffect(() => {
    if (!request) return;

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const url = `/api/gutenberg/search?q=${encodeURIComponent(request.query)}&page=${request.page}`;
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (cancelled) return;

        // Two failure shapes: the route refused (401 and friends), or the
        // catalogue could not answer and the route passed its sentence through
        // with a 200 — "never synced" arrives this way.
        if (!res.ok || !body || typeof body.error === "string") {
          setPhase({ kind: "error", message: body?.error || t.errorFallback });
          // A refusal may well *be* "no catalogue"; re-read the status so the
          // panel above turns into the sync button rather than staying silent.
          const status = await readCatalogStatus();
          if (!cancelled && status) setCatalog(status);
          return;
        }

        setHeld(body as SearchPage);
        setPhase({ kind: "ready", page: body as SearchPage, query: request.query });
      } catch (err) {
        if (cancelled || (err as { name?: string })?.name === "AbortError") return;
        setPhase({ kind: "error", message: t.errorFallback });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [request]);

  const run = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      setInput(trimmed);
      startRequest({ query: trimmed, page: 1 });
    },
    [startRequest],
  );

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      run(input);
    },
    [input, run],
  );

  const goPage = useCallback(
    (page: number) => {
      if (!request) return;
      startRequest({ ...request, page });
      // Send focus back to the heading: paging swaps the whole grid out from
      // under the keyboard, and leaving focus on a now-disabled Next button
      // strands it.
      headingRef.current?.focus();
    },
    [request, startRequest],
  );

  const retry = useCallback(() => {
    if (request) startRequest(request);
  }, [request, startRequest]);

  const clear = useCallback(() => {
    setInput("");
    setRequest(null);
    setHeld(null);
    setPhase({ kind: "idle" });
  }, []);

  const busy = phase.kind === "loading";
  const noCatalog = catalog !== null && !catalog.synced;
  const syncing = starting || isRunning(catalog?.progress ?? null);
  /**
   * During a re-search the previous grid stays up, dimmed. A local query
   * answers in tens of milliseconds, so a skeleton would be a flash of nothing
   * where a stable page belongs. The skeleton is kept for the one case it
   * still earns: the very first search, when there is nothing to keep.
   */
  const shown = phase.kind === "ready" ? phase.page : busy ? held : null;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="free-books-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2
            id="free-books-heading"
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-[20px] font-semibold"
            style={{ color: "var(--ink)" }}
          >
            {t.heading}
          </h2>
          <p className="mt-1 text-[13px]" style={{ color: "var(--mute)" }}>
            {t.intro}
          </p>
        </div>
        {phase.kind === "ready" && (
          <Badge>{t.countLabel(phase.page.total, phase.page.books.length)}</Badge>
        )}
      </div>

      <CatalogPanel status={catalog} onSync={startSync} busy={syncing} />

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2" role="search">
        <div className="min-w-[220px] flex-1">
          <label className="field-label" htmlFor="free-books-q">
            {t.searchLabel}
          </label>
          <input
            id="free-books-q"
            className="control"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.searchPlaceholder}
            autoComplete="off"
            disabled={noCatalog}
          />
        </div>
        <button
          type="submit"
          disabled={noCatalog || input.trim().length === 0}
          className="rounded-lg border px-3.5 py-2 text-[13px] font-semibold disabled:opacity-60"
          style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--slab-2)" }}
        >
          {busy ? t.searching : t.searchAction}
        </button>
        {request && (
          <button
            type="button"
            onClick={clear}
            className="rounded-lg border px-3.5 py-2 text-[13px] disabled:opacity-60"
            style={{ borderColor: "var(--line)", color: "var(--mute)" }}
          >
            {t.clear}
          </button>
        )}
      </form>

      {/* One live region for the whole pane, so a screen reader is told what
          happened once rather than once per card. */}
      <p className="sr-only" aria-live="polite">
        {phase.kind === "loading"
          ? t.loading
          : phase.kind === "ready"
            ? t.countLabel(phase.page.total, phase.page.books.length)
            : phase.kind === "error"
              ? phase.message
              : ""}
      </p>

      {phase.kind === "idle" && !noCatalog && (
        <div className="panel panel-body flex flex-col gap-1">
          <p className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
            {t.idleTitle}
          </p>
          <EmptyState>{t.idleBody}</EmptyState>
          <Suggestions onPick={run} />
        </div>
      )}

      {busy && shown === null && <ResultSkeleton />}

      {phase.kind === "error" && (
        <div className="panel panel-body flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[13px] font-semibold" style={{ color: "var(--rose)" }}>
              {t.errorTitle}
            </p>
            <p role="alert" className="text-[13px]" style={{ color: "var(--mute)" }}>
              {phase.message}
            </p>
          </div>
          {!noCatalog && (
            <button
              type="button"
              onClick={retry}
              className="rounded-lg border px-3 py-1.5 text-[13px]"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}
            >
              {t.retry}
            </button>
          )}
        </div>
      )}

      {phase.kind === "ready" && phase.page.books.length === 0 && (
        <div className="panel panel-body flex flex-col gap-1">
          <p className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
            {t.noResultsTitle(phase.query)}
          </p>
          <EmptyState>{t.noResultsBody}</EmptyState>
          <Suggestions onPick={run} />
        </div>
      )}

      {shown !== null && shown.books.length > 0 && (
        <div style={busy ? { opacity: 0.55, transition: "opacity 120ms" } : undefined}>
          <ul role="list" className="library-grid">
            {shown.books.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </ul>

          {(shown.hasPrevious || shown.hasNext) && (
            <nav className="mt-4 flex items-center justify-center gap-3" aria-label={t.pageLabel(shown.page)}>
              <button
                type="button"
                onClick={() => goPage(shown.page - 1)}
                disabled={!shown.hasPrevious || busy}
                className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              >
                {t.prev}
              </button>
              <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
                {t.pageLabel(shown.page)}
              </span>
              <button
                type="button"
                onClick={() => goPage(shown.page + 1)}
                disabled={!shown.hasNext || busy}
                className="rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              >
                {t.next}
              </button>
            </nav>
          )}
        </div>
      )}

      <Hint>{t.attribution}</Hint>
    </section>
  );
}
