"use client";

import { useState } from "react";
import { coverUrl } from "@/lib/covers/sizes";
import type { AnalysisSummary } from "./types";

function initials(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "BR";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

/**
 * A book's cover -- page 1 of the PDF -- or a quiet tinted field with the
 * book's initials.
 *
 * The same fallback `LibraryGrid` gives a poster that has none, and for the
 * same reason: a broken-image icon is never acceptable. The field shows for
 * `pending` (no pages yet), `failed` (the page is gone or will not decode), a
 * row with no cover fields at all (a server that predates covers), and an image
 * that fails to load anyway.
 *
 * `broken` is remembered by URL, not as a flag: the URL carries the cover's
 * revision, so a cover that has since been regenerated is a new URL and gets a
 * fresh chance rather than inheriting the old one's failure.
 *
 * The image is `loading="lazy"`, and asks for the small size (160px, about
 * four times what a card paints). Its `alt` is empty because the card's own
 * label already names the book.
 */
export function BookCover({ book }: { book: Pick<AnalysisSummary, "id" | "bookTitle" | "coverStatus" | "coverRev"> }) {
  const src = book.coverStatus === "ready" ? coverUrl(book.id, "small", book.coverRev ?? 0) : null;
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  return (
    <span className="book-cover" aria-hidden>
      {src && brokenSrc !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- session-guarded API route, not a statically optimizable asset
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBrokenSrc(src)} />
      ) : (
        <span className="book-cover-empty">{initials(book.bookTitle)}</span>
      )}
    </span>
  );
}

export default BookCover;
