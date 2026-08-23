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
  intro:
    "Search Project Gutenberg — around 78,000 titles, all out of copyright, all free to download. Searched locally, so results are instant.",

  searchLabel: "Search Project Gutenberg",
  searchPlaceholder: "Title, author, or subject",
  searchAction: "Search",
  searching: "Searching…",
  clear: "Clear",

  loading: "Searching the catalogue…",
  retry: "Try again",

  /** Nothing typed yet — the resting state, not an error. */
  idleTitle: "Nothing searched yet",
  idleBody: "Type a title, an author or a subject above. Nothing leaves this machine, so it answers immediately.",

  /** A real search that matched nothing. */
  noResultsTitle: (query: string) => `Nothing found for “${query}”`,
  noResultsBody:
    "Every word you typed has to appear in the title, the author or the subject. Try one word instead of three, an author's surname, or a broader subject.",
  /** Offered under both the idle and the empty state — a search costs nothing now. */
  suggestionsLabel: "Try one of these",
  suggestions: ["Frankenstein", "Marcus Aurelius", "philosophy", "Sherlock Holmes", "fairy tales"] as const,

  errorTitle: "That search could not be run",
  /** Last resort only: the API almost always sends its own sentence. */
  errorFallback: "Something went wrong searching the catalogue. Try again in a moment.",

  countLabel: (total: number, shown: number) =>
    total === 0
      ? "No matches"
      : total === shown
        ? `${total} ${total === 1 ? "match" : "matches"}`
        : `${shown} of ${total.toLocaleString("en")} matches`,

  // ---------------------------------------------------------------------
  // The catalogue. The one state where the page genuinely cannot help yet.
  // ---------------------------------------------------------------------

  /** Shown while the pane is still finding out whether a catalogue exists. */
  catalogChecking: "Checking the catalogue…",

  catalogEmptyTitle: "The catalogue has not been downloaded yet",
  catalogEmptyBody:
    "Project Gutenberg's own search takes 30 to 45 seconds per query, which is why this page used to time out. Instead, the whole catalogue — about 78,000 titles — is downloaded once, here, and searched locally from then on. It is a 21MB file and takes under a minute.",
  catalogSyncAction: "Download the catalogue",
  catalogResyncAction: "Re-sync",
  catalogRetryAction: "Try the sync again",

  catalogReady: (rows: number, when: string) => `${rows.toLocaleString("en")} titles · synced ${when}`,
  catalogNeverSynced: "Never synced",

  /** Live progress. Each phase says what is actually happening right now. */
  catalogPhase: {
    downloading: "Downloading the catalogue…",
    importing: "Indexing titles…",
    activating: "Switching over…",
    done: "Catalogue ready.",
    failed: "The sync failed.",
    idle: "",
  } as const,
  catalogBytes: (done: number, total: number | null) =>
    total ? `${Math.round((done / total) * 100)}% of ${(total / 1_048_576).toFixed(1)}MB` : `${(done / 1_048_576).toFixed(1)}MB`,
  catalogRows: (n: number) => `${n.toLocaleString("en")} titles indexed`,
  /** Said once, plainly, because it is the property that makes a re-sync safe. */
  catalogSafety: "A sync that fails leaves the catalogue you already have exactly as it was.",
  catalogProgressLabel: "Catalogue sync progress",
  catalogFailedFallback: "The sync failed. The previous catalogue is untouched.",

  /** "3 minutes ago" — the pane's only relative time, so it lives here. */
  since(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return "just now";
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  },

  downloadsLabel: "Download",
  noFormats: "No downloadable format",
  downloading: "Preparing…",
  downloadFailed: "That download failed. Try another format.",

  formatLabel: { epub: "EPUB", text: "Plain text", html: "HTML", pdf: "PDF" } as const,
  formatShort: { epub: "EPUB", text: "TXT", html: "HTML", pdf: "PDF" } as const,

  downloadAria: (title: string, format: string) => `Download ${title} as ${format}`,
  coverAlt: "",
  /**
   * The catalogue feed carries no download counts, so the card names the book
   * instead: its Project Gutenberg id, which is the thing an operator actually
   * uses, and its language.
   */
  bookMeta: (id: number, languages: string[]) =>
    `PG ${id}${languages.length ? ` · ${languages.join(", ").toUpperCase()}` : ""}`,

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
