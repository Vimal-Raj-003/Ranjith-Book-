"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import type { AnalysisSummary } from "./types";
import PdfUpload from "./PdfUpload";
import BookAnalysis from "./BookAnalysis";
import { BookCover } from "./BookCover";
import { useToast } from "./Toast";
import { Disclosure, EmptyState, Panel, StatusBadge } from "./ui";

/**
 * The book-PDF workbench: upload a book on the left with the list of books
 * already analysed under it; the open book's progress and ideas on the right.
 * It sits beside the photo Studio rather than inside it — the photo flow is
 * untouched, and a PDF ends in a list of ideas, not in a video (yet).
 */
export default function BooksView() {
  const { show } = useToast();
  const [books, setBooks] = useState<AnalysisSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Per book, not one slot: regenerating A while B is also running must not let
  // A's finish clear B's flag. The ref is the guard (state lags a double click by
  // a render); the state is what the cards read to say "Regenerating…".
  const inflight = useRef<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => setNonce((n) => n + 1), []);

  /**
   * Throw away one book's cached cover and make it again. The response carries
   * the new status and revision, and the card is pointed at them directly: the
   * old image is `immutable` in the browser at its old URL, so only a new
   * `coverRev` reaches it, and waiting for the next list load would leave the
   * stale cover showing until then.
   */
  const regenerate = useCallback(
    async (id: string) => {
      // `aria-disabled` on the button, never `disabled`: a button that disables
      // itself while it waits drops keyboard focus (see the voice preview in the
      // inspector). This early return is what makes it one request at a time.
      if (inflight.current.has(id)) return;
      inflight.current.add(id);
      setRegenerating(new Set(inflight.current));
      try {
        const res = await fetch(`/api/uploads/${encodeURIComponent(id)}/cover`, { method: "POST" });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error();
        setBooks((prev) =>
          prev ? prev.map((b) => (b.id === id ? { ...b, coverStatus: body.coverStatus, coverRev: body.coverRev } : b)) : prev,
        );
      } catch {
        show(strings.books.coverRegenerateError, "error");
      } finally {
        inflight.current.delete(id);
        setRegenerating(new Set(inflight.current));
      }
    },
    [show],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/books", { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body) throw new Error();
        if (cancelled) return;
        setBooks(body.books as AnalysisSummary[]);
        setListError(false);
      } catch {
        if (!cancelled) setListError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const active = openId ?? books?.[0]?.id ?? null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="books-heading">
      <div className="pane-head">
        <h1 id="books-heading" className="font-display text-[18px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
          {strings.books.heading}
        </h1>
        <span className="text-[12px]" style={{ color: "var(--mute)" }}>
          {strings.books.intro}
        </span>
        <div className="pane-head-end">
          <Disclosure quiet summary={strings.books.helpSummary}>
            <p className="max-w-[60ch] text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
              {strings.books.help}
            </p>
          </Disclosure>
        </div>
      </div>

      {/* The aside is 320px now rather than half the window: an upload form
          and a list of book titles are both finished well inside that, and
          everything past it was the empty space the operator complained
          about. The ideas for the open book get the rest. */}
      <div className="work-split">
        <div className="work-col">
          {/* Both groups fold, because the operator asked for it and because
              on a run you are reading ideas, not uploading. `Panel` for the
              upload rather than a disclosure: a drag-and-drop target you
              cannot see is a drag-and-drop target that does not work, and
              this is the one control that starts everything. */}
          <Panel title={strings.books.uploadHeading}>
            <PdfUpload
              onStarted={(id) => {
                setOpenId(id);
                load();
              }}
            />
          </Panel>

          <Disclosure
            className="disclosure-panel"
            summary={books === null ? strings.books.listHeading : strings.books.listSummary(books.length)}
            defaultOpen
          >
            {listError ? (
              <EmptyState>{strings.books.listLoadError}</EmptyState>
            ) : books === null ? (
              <EmptyState>{strings.studio.loading}</EmptyState>
            ) : books.length === 0 ? (
              <EmptyState>{strings.books.listEmpty}</EmptyState>
            ) : (
              <ul role="list" className="flex flex-col gap-1">
                {books.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(b.id)}
                      aria-current={b.id === active ? "true" : undefined}
                      aria-label={strings.books.open(b.bookTitle)}
                      className="nav-item w-full text-left"
                    >
                      <BookCover book={b} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        {/* A book title is longer than any list row that also
                            has a cover and a status badge, at every width this
                            app has ever had — measured at 390, 1440 and 1920.
                            The screen reader gets it whole from the button's
                            `aria-label`; `title` is the sighted equivalent, and
                            is the reason the narrower aside costs nothing here. */}
                        <span className="truncate text-[13px] font-semibold" style={{ color: "var(--ink)" }} title={b.bookTitle}>
                          {b.bookTitle}
                        </span>
                        <span className="text-[11.5px]" style={{ color: "var(--mute)" }}>
                          {[strings.books.pages(b.pageCount), b.status === "DONE" ? strings.books.ideaCount(b.ideaCount) : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <StatusBadge status={b.status} label={strings.run.statusLabel(b.status)} />
                    </button>
                    {/* A sibling of the card, not inside it: a button cannot hold a button.
                        Offered on the open book, and on any whose cover failed, so a failure
                        is never a dead end. Nothing to regenerate before there are pages. */}
                    {b.coverStatus && b.coverStatus !== "pending" && (b.id === active || b.coverStatus === "failed") && (
                      <button
                        type="button"
                        className="book-cover-action"
                        onClick={() => regenerate(b.id)}
                        aria-disabled={regenerating.has(b.id)}
                        aria-busy={regenerating.has(b.id)}
                        aria-label={strings.books.coverRegenerateFor(b.bookTitle)}
                      >
                        {regenerating.has(b.id) ? strings.books.coverRegenerating : strings.books.coverRegenerate}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </div>

        <div className="work-col">
          {active ? (
            <BookAnalysis key={active} uploadId={active} onChanged={load} />
          ) : (
            /* A bare sentence floating in an empty half-window read as a
               rendering failure. It is a panel like everything else now. */
            <Panel>
              <EmptyState>{strings.books.nothingOpen}</EmptyState>
            </Panel>
          )}
        </div>
      </div>
    </section>
  );
}
