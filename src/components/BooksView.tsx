"use client";

import { useCallback, useEffect, useState } from "react";
import { strings } from "@/lib/strings";
import type { AnalysisSummary } from "./types";
import PdfUpload from "./PdfUpload";
import BookAnalysis from "./BookAnalysis";
import { Disclosure, EmptyState, Panel, StatusBadge } from "./ui";

/**
 * The book-PDF workbench: upload a book on the left with the list of books
 * already analysed under it; the open book's progress and ideas on the right.
 * It sits beside the photo Studio rather than inside it — the photo flow is
 * untouched, and a PDF ends in a list of ideas, not in a video (yet).
 */
export default function BooksView() {
  const [books, setBooks] = useState<AnalysisSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(() => setNonce((n) => n + 1), []);

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
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 id="books-heading" className="font-display text-[18px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>
          {strings.books.heading}
        </h1>
        <span className="text-[12px]" style={{ color: "var(--mute)" }}>
          {strings.books.intro}
        </span>
        <div className="ms-auto">
          <Disclosure quiet summary={strings.books.helpSummary}>
            <p className="max-w-[60ch] text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
              {strings.books.help}
            </p>
          </Disclosure>
        </div>
      </div>

      <div className="work-split">
        <div className="work-col">
          <Panel title={strings.books.uploadHeading}>
            <PdfUpload
              onStarted={(id) => {
                setOpenId(id);
                load();
              }}
            />
          </Panel>

          <Panel title={strings.books.listHeading}>
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
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
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
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="work-col">
          {active ? (
            <BookAnalysis key={active} uploadId={active} onChanged={load} />
          ) : (
            <EmptyState>{strings.books.nothingOpen}</EmptyState>
          )}
        </div>
      </div>
    </section>
  );
}
