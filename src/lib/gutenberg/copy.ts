/**
 * Server-side sentences for this feature.
 *
 * TODO: fold into `src/lib/strings.ts`. It lives here only because that module
 * is being edited by another workstream right now and a second writer would
 * collide. Nothing about this copy is special — when `strings.ts` settles,
 * move the whole object under `strings.freeBooks` and delete this file.
 *
 * Every one of these is shown to a person, so none of them names an upstream
 * URL, a host, a status code or a stack. "Project Gutenberg is not answering"
 * is something an operator can act on; "TypeError: fetch failed" is not.
 */
export const copy = {
  timeout: "Project Gutenberg took too long to answer. Try again in a moment.",
  unreachable: "Could not reach Project Gutenberg. It may be down, or the network may be blocked.",
  rateLimited: "Project Gutenberg is rate-limiting this app right now. Wait a minute and try again.",
  upstreamError: "Project Gutenberg answered with an error. This is on their side, not yours.",
  badResponse: "Project Gutenberg sent something this app could not read. Try again in a moment.",
  blocked: "That link was refused: it does not point at Project Gutenberg.",
  tooManyRedirects: "That download bounced through too many redirects and was abandoned.",
  tooLarge: "That file is larger than this app will proxy.",
  notFound: "No such book on Project Gutenberg.",
  formatMissing: "Project Gutenberg does not offer that format for this book.",
  badBookId: "That is not a valid Project Gutenberg book id.",
  badFormat: "That is not a format this app can download.",

  // The local catalogue. `catalogMissing` is the one that is not a failure:
  // it is the honest answer to "search this" before anything has been synced,
  // and the UI turns it into a button rather than an apology.
  catalogMissing: "The Project Gutenberg catalogue has not been downloaded yet. Sync it once and search is instant from then on.",
  catalogNoQuery: "Type a title, an author or a subject to search the catalogue.",
  catalogTruncated:
    "Project Gutenberg's catalogue file arrived incomplete, so it was discarded. The previous catalogue is untouched.",
  catalogShape:
    "Project Gutenberg's catalogue file was not in the expected format, so it was discarded. The previous catalogue is untouched.",
  catalogFailed: "The catalogue sync failed. The previous catalogue is untouched.",
  catalogBusy: "A catalogue sync is already running.",
} as const;
