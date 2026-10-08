import fs from "node:fs/promises";
import { coverFailed, coverFile } from "./derive";
import type { CoverStatus } from "./sizes";

/** The two paths a page row records. */
export interface PageSource {
  derivedPath: string | null;
  filePath: string;
}

/**
 * Which file a cover is made from, and how old it is.
 *
 * The downscaled copy when there is one, the original otherwise -- and
 * "there is one" means it is on disk, not that the row names it: a derived path
 * whose file has gone falls back to the original rather than costing the book
 * its cover. `null` when neither is there.
 */
export async function locateSource(page: PageSource): Promise<{ path: string; mtimeMs: number } | null> {
  for (const candidate of [page.derivedPath, page.filePath]) {
    if (!candidate) continue;
    try {
      const s = await fs.stat(candidate);
      if (s.isFile()) return { path: candidate, mtimeMs: s.mtimeMs };
    } catch {
      // not there: try the next
    }
  }
  return null;
}

export interface CoverState {
  status: CoverStatus;
  /**
   * The version token for the cover's URL, in milliseconds. 0 when there is
   * nothing to version.
   *
   * It is the newer of the page and the `small` cover made from it. `small` is
   * the size the books list shows, so it is the one that is always made first
   * (and the only one a Regenerate makes); the other sizes are made on demand
   * and only ever from the same page. A re-rendered page is newer than its
   * cover, a regenerated cover is newer than its page, and a cover that has not
   * been made yet is just the page. Either way the URL changes whenever the
   * bytes behind it might, which is what lets the file be served `immutable`.
   * It moves once more when the cover is first derived (page time, then cover
   * time); that costs one small re-download.
   */
  rev: number;
}

/**
 * Where an upload's cover stands, from the filesystem alone -- no column.
 *
 *  - no pages yet            -> `pending`
 *  - pages, page readable    -> `ready` (derivation is lazy, so "ready" means
 *                               "can be had", not "has been made")
 *  - page gone, or the last attempt to derive it failed -> `failed`
 *
 * `page` is the upload's lowest-index page, which the caller already has in
 * hand from the same query as the upload. This never derives anything and never
 * throws: the books list calls it for every row, and one unreadable directory
 * must not cost the operator the list.
 */
export async function coverState(uploadId: string, page: PageSource | null | undefined): Promise<CoverState> {
  try {
    if (!page) return { status: "pending", rev: 0 };
    const source = await locateSource(page);
    if (!source) return { status: "failed", rev: 0 };
    if (await coverFailed(uploadId, source.path)) return { status: "failed", rev: Math.trunc(source.mtimeMs) };

    let made = 0;
    try {
      made = (await fs.stat(coverFile(uploadId, "small"))).mtimeMs;
    } catch {
      // not derived yet
    }
    return { status: "ready", rev: Math.trunc(Math.max(source.mtimeMs, made)) };
  } catch {
    return { status: "failed", rev: 0 };
  }
}
