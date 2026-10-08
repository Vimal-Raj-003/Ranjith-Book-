import fs from "node:fs";
import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/db";
import { visibleTo } from "@/lib/episodes/visibility";
import { nodeToWebStream } from "@/lib/node-web-stream";
import { parseThumbnails, selectThumb } from "@/lib/thumbnails";
import { cacheControlFor, deriveGrid, parseSize } from "@/lib/thumbnails/derive";

const notFound = (error = "Not found") => Response.json({ error }, { status: 404 });

/**
 * Stream one thumbnail to a signed-in user who may see its episode.
 *
 * This lives outside the route handler for the same reason `editPoster` and
 * `listEpisodes` do: the route's other job is `currentUser()`, which reads
 * `cookies()` and cannot run outside a request, so the rules -- the part worth
 * testing -- stay here and the route only establishes who is asking.
 *
 * Same guard as the video route, for the same reason: thumbnails are the
 * operator's own photograph of their own book, they live outside `public/`, and
 * the only way to read one is through a handler that has checked the episode.
 *
 * "May see" is `visibleTo`: the user's own episodes AND the ones nobody owns.
 * That is exactly the set the library lists, so a card never has a poster that
 * 404s. It must never reach another account's episode, and a test holds it to
 * that.
 *
 * `key` is hostile input. It is never joined to a path, never normalised, never
 * used to build a filename -- it is compared, byte for byte, against the keys
 * already recorded on that episode's row (`selectThumb`), and the path that is
 * opened comes from the matched record and is confined to that episode's own
 * directory. A crafted `../../etc/passwd` matches nothing and 404s before the
 * filesystem is touched at all. `size` is treated the same way (`parseSize`).
 */
export async function serveThumbnail(
  userId: string,
  episodeId: string,
  key: string,
  sizeParam: string | null,
  ifNoneMatch: string | null,
  /** The request's `AbortSignal`: when the client leaves, the file is closed. */
  signal?: AbortSignal,
): Promise<Response> {
  // No `select` for `thumbnails`: the column is read structurally by
  // `parseThumbnails`, so this compiles and runs both before and after the
  // Prisma client is regenerated for the new column.
  const episode = await prisma.episode.findFirst({ where: { id: episodeId, ...visibleTo(userId) } });
  if (!episode) return notFound();

  const spec = selectThumb(parseThumbnails(episode), key, episode.id);
  if (!spec) return notFound();

  // The grid derivative when one was asked for and could be made; the
  // full-resolution original otherwise. A derivation that fails degrades to
  // the original rather than to an error -- slow beats broken.
  const size = parseSize(sizeParam);
  const derived = size === "grid" ? await deriveGrid(spec, episode.id) : null;
  const file = derived ?? spec.path;
  const type = derived ? "image/webp" : "image/jpeg";
  const cacheControl = cacheControlFor(size, derived);

  let stat: Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return notFound("That thumbnail is no longer on disk.");
  }

  // A poster changes only when something explicitly re-renders it, so the
  // browser may keep these bytes for good. The previous
  // `max-age=0, must-revalidate` meant a 100-episode library re-downloaded
  // roughly 27 MB on every single visit.
  //
  // The catch is that `immutable` is a promise about this URL. A re-render
  // writes the same key to the same path, so anything that redoes a poster must
  // also change the URL it is requested by; this cannot do that for it.
  // The ETag below (size + mtime) is what a revalidation would be answered
  // with, and it does change on a re-render, but only a request that bypasses
  // the cache will ask.
  //
  // `private` is retained deliberately. A shared proxy must never hold one
  // operator's photograph of their own book where another could be handed it;
  // only the browser that asked for it caches this.
  //
  // A grid request that fell back to the full JPEG is the one case that is NOT
  // immutable (see `cacheControlFor`): it must be allowed to try again.
  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  // Not `Readable.toWeb`: a client that leaves mid-body made it throw an
  // uncatchable `ERR_INVALID_STATE`. See `lib/node-web-stream.ts`.
  const stream = nodeToWebStream(fs.createReadStream(file), signal);
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(stat.size),
      "Cache-Control": cacheControl,
      ETag: etag,
      // The filename is built from the validated key, never from the raw URL.
      "Content-Disposition": `inline; filename="${spec.key}${derived ? ".webp" : ".jpg"}"`,
    },
  });
}
