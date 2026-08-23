/**
 * Every sentence the Free Books pane shows.
 *
 * TODO: fold into `src/lib/strings.ts`. Two reasons it is not there yet:
 * `strings.ts` is owned by another workstream right now, and — the load-bearing
 * one — `tests/client-ui.test.mts` allows a `"use client"` component to import
 * from exactly four `@/lib` modules. Anything else in `@/lib`, however
 * harmless, is a bundle-graph risk the guard refuses on principle, and it is
 * right to. So this lives beside the component that uses it until it can move
 * into `strings.ts` proper, which is already on the allowlist.
 *
 * The server has its own copy module (`src/lib/gutenberg/copy.ts`) for failure
 * messages it produces itself. That one is not duplicated here: the API sends
 * its message down and this pane renders it.
 */
export const freeBooks = {
  heading: "Free books",
  intro: "Search Project Gutenberg — around 75,000 titles, all out of copyright, all free to download.",

  searchLabel: "Search Project Gutenberg",
  searchPlaceholder: "Title, author, or subject",
  searchAction: "Search",
  searching: "Searching…",
  clear: "Clear",

  loading: "Asking Project Gutenberg…",
  retry: "Try again",

  /** Nothing typed yet — the resting state, not an error. */
  idleTitle: "Nothing searched yet",
  idleBody: "Type a title, an author or a subject above to browse the public-domain catalogue.",

  /** A real search that matched nothing. */
  noResultsTitle: (query: string) => `Nothing found for “${query}”`,
  noResultsBody: "Try a shorter phrase, an author's surname, or a broader subject.",

  errorTitle: "Project Gutenberg is not answering",
  /** Last resort only: the API almost always sends its own sentence. */
  errorFallback: "Something went wrong reaching Project Gutenberg. Try again in a moment.",

  countLabel: (total: number, shown: number) =>
    total === 0
      ? "No matches"
      : total === shown
        ? `${total} ${total === 1 ? "match" : "matches"}`
        : `${shown} of ${total.toLocaleString("en")} matches`,

  downloadsLabel: "Download",
  noFormats: "No downloadable format",
  downloading: "Preparing…",
  downloadFailed: "That download failed. Try another format.",

  formatLabel: { epub: "EPUB", text: "Plain text", html: "HTML", pdf: "PDF" } as const,
  formatShort: { epub: "EPUB", text: "TXT", html: "HTML", pdf: "PDF" } as const,

  downloadAria: (title: string, format: string) => `Download ${title} as ${format}`,
  coverAlt: "",
  downloadsCount: (n: number) => `${n.toLocaleString("en")} downloads`,

  prev: "Previous",
  next: "Next",
  pageLabel: (page: number) => `Page ${page}`,

  /** Rendered under the results, because provenance is the point of this pane. */
  attribution: "Books and metadata from Project Gutenberg. All titles are in the public domain.",

  /** Shown when a book records no author at all — commoner than you'd think. */
  unknownAuthor: "Unknown author",

  /** "Shelley, Mary Wollstonecraft (1797–1851)" */
  authorLine(name: string, birthYear: number | null, deathYear: number | null): string {
    if (birthYear === null && deathYear === null) return name;
    return `${name} (${birthYear ?? "?"}–${deathYear ?? "?"})`;
  },
} as const;
