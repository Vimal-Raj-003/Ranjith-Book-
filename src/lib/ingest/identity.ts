import { assertPublicUrl } from "../media/fetch-guard";
import { isNonPersonAuthor, sameName } from "./names";

export interface AuthorEvidence {
  /** Works the catalogue returned for the identified title. */
  works: { authors: string[] }[];
  /** What the model independently read off the page images. */
  modelGuess: string | null;
  /** Whether the adversarial pass confirmed the name against those images. */
  adversarialConfirmed: boolean;
}

export interface AuthorResolution {
  author: string | null;
  verified: boolean;
  /** Which link broke, so the omission is explainable rather than mysterious. */
  reason: string | null;
}

const absent = (reason: string): AuthorResolution => ({ author: null, verified: false, reason });

/**
 * All four links or nothing. There is deliberately no intermediate confidence
 * state: a "probably" would eventually be rendered, and a wrong author on a
 * real channel is worse than no author at all.
 *
 * Two editions of the same work returned as separate catalogue docs are
 * treated exactly like two different books with the same title: `works`
 * having more than one entry is an automatic "multiple-works" absence, even
 * when every entry lists the identical single author. There is no reliable,
 * purely-structural way for `lookupBook`'s exact-title match to tell "the
 * 2004 hardback and the 2009 paperback of the same work" apart from "two
 * unrelated books that happen to share a title" -- both show up as more than
 * one doc with a matching title and no shared identifier this code trusts.
 * Collapsing "same title, same single author across all docs" into a verified
 * match would require deciding those two situations are the same *before* the
 * author is revealed, on weaker evidence than the rest of the chain demands.
 * Staying absent is the safe default; a human can still correct the record,
 * but this code will never publish a name it inferred from a coincidence.
 */
export function resolveAuthor(e: AuthorEvidence): AuthorResolution {
  if (e.works.length === 0) return absent("no-catalogue-match");
  if (e.works.length > 1) return absent("multiple-works");

  const authors = e.works[0].authors.map((a) => a.trim()).filter((a) => a.length > 0);
  if (authors.length === 0) return absent("no-catalogue-author");
  if (authors.length > 1) return absent("multiple-authors");

  // "Various", "Anonymous", "Editor", a publisher's imprint -- these are
  // catalogue conventions, not a person, and no amount of downstream
  // agreement turns a non-name into a certain one.
  if (isNonPersonAuthor(authors[0])) return absent("non-person-author");

  if (!e.modelGuess?.trim()) return absent("model-silent");
  if (!sameName(authors[0], e.modelGuess)) return absent("model-disagreed");
  if (!e.adversarialConfirmed) return absent("adversarial-declined");

  // The catalogue's spelling is canonical; the model's casing is not.
  return { author: authors[0], verified: true, reason: null };
}

const OPEN_LIBRARY = "https://openlibrary.org/search.json";

export interface BookIdentity {
  openLibraryId: string | null;
  year: number | null;
  subjects: string[];
  works: { authors: string[] }[];
}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  subject?: string[];
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibraryDoc[];
}

const MAX_REDIRECTS = 5;
/**
 * A deadline for the WHOLE lookup, not for any single hop. Ingest budgets 35
 * seconds for six pages, and this lookup is one stage inside that; if each of
 * up to 6 hops (the original request plus 5 redirects) got its own fresh 8s
 * timer, a redirecting server could burn 6 x 8s = 48s on its own -- longer
 * than the entire ingest budget -- and the failure would surface as "ingest
 * is slow" rather than "one catalogue lookup hung". One `AbortSignal.timeout`
 * created before the loop starts and reused for every hop's `fetch` enforces
 * a single deadline across the whole chain instead.
 */
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * `fetch-guard.ts` exports a checker (`assertPublicUrl`), not a fetcher --
 * there is no `guardedFetch`. So every hop of the request is checked here by
 * hand: the guard is asked about the URL, then `fetch` is called with
 * `redirect: "manual"` so a redirect response never gets silently followed by
 * the runtime, and the `Location` header of every redirect is re-checked
 * through the same guard before it is followed. That manual loop is the
 * guard's whole point for a third-party URL like Open Library's -- an
 * attacker-controlled redirect chain that starts public and ends at a private
 * address would slip past a single up-front check.
 */
async function fetchGuardedFollowingRedirects(rawUrl: string): Promise<Response> {
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, { redirect: "manual", signal });

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (!isRedirect || !location) return res;

    current = new URL(location, url).toString();
  }

  throw new Error(`Too many redirects fetching ${rawUrl}`);
}

/**
 * Open Library is a third-party URL, so it goes through the guard above like
 * every other outbound fetch. A catalogue failure is non-fatal: whatever goes
 * wrong here (down, slow, rate-limited, blocked by the guard, or a response
 * that doesn't parse as expected) is swallowed and reported as simply having
 * found no works, never thrown out into the ingest pipeline. The title itself
 * always stands on the model's own reading; only the author lookup depends on
 * this succeeding.
 */
export async function lookupBook(title: string): Promise<BookIdentity> {
  const empty: BookIdentity = { openLibraryId: null, year: null, subjects: [], works: [] };

  try {
    const url = `${OPEN_LIBRARY}?title=${encodeURIComponent(title)}&limit=5&fields=key,title,author_name,first_publish_year,subject`;
    const res = await fetchGuardedFollowingRedirects(url);
    if (!res.ok) return empty;

    const data = (await res.json()) as OpenLibrarySearchResponse;
    if (!Array.isArray(data.docs)) return empty;

    // Only exact title matches count as candidates (case and surrounding
    // whitespace normalised, nothing else). A fuzzy match is precisely how an
    // author from a different book ends up attributed on someone's video.
    const wanted = title.trim().toLowerCase();
    const docs = data.docs.filter((d) => (d.title ?? "").trim().toLowerCase() === wanted);

    return {
      openLibraryId: docs[0]?.key ?? null,
      year: docs[0]?.first_publish_year ?? null,
      subjects: (docs[0]?.subject ?? []).slice(0, 12),
      works: docs.map((d) => ({ authors: d.author_name ?? [] })),
    };
  } catch {
    return empty;
  }
}
