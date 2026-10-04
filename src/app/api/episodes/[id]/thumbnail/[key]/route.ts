import { NextResponse } from "next/server";
import fs from "node:fs";
import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";
import { parseThumbnails, selectThumb } from "@/lib/thumbnails";
import { deriveGrid, parseSize } from "@/lib/thumbnails/derive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stream one thumbnail to the user who made it.
 *
 * Same guard as the video route, for the same reason: thumbnails are the
 * operator's own photograph of their own book, they live outside `public/`, and
 * the only way to read one is through this handler with that episode's session.
 *
 * `key` is hostile input. It is never joined to a path, never normalised, never
 * used to build a filename — it is compared, byte for byte, against the keys
 * already recorded on that episode's row (`selectThumb`), and the path that is
 * opened comes from the matched record and is confined to that episode's own
 * directory. A crafted `../../etc/passwd` matches nothing and 404s before the
 * filesystem is touched at all.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const { id, key } = await ctx.params;

  // No `select` for `thumbnails`: the column is read structurally by
  // `parseThumbnails`, so this handler compiles and runs both before and after
  // the Prisma client is regenerated for the new column.
  const episode = await prisma.episode.findFirst({ where: { id, userId: user.id } });
  if (!episode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const spec = selectThumb(parseThumbnails(episode), key, episode.id);
  if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The grid derivative when one was asked for and could be made; the
  // full-resolution original otherwise. A derivation that fails degrades to
  // the original rather than to an error — slow beats broken.
  const size = parseSize(new URL(req.url).searchParams.get("size"));
  const derived = size === "grid" ? await deriveGrid(spec, episode.id) : null;
  const file = derived ?? spec.path;
  const type = derived ? "image/webp" : "image/jpeg";

  let stat: Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return NextResponse.json({ error: "That thumbnail is no longer on disk." }, { status: 404 });
  }

  // A poster changes only when something explicitly re-renders it, so the
  // browser may keep these bytes for good. The previous
  // `max-age=0, must-revalidate` meant a 100-episode library re-downloaded
  // roughly 27 MB on every single visit.
  //
  // The catch is that `immutable` is a promise about this URL. A re-render
  // writes the same key to the same path, so anything that redoes a poster must
  // also change the URL it is requested by; this route cannot do that for it.
  // The ETag below (size + mtime) is what a revalidation would be answered
  // with, and it does change on a re-render, but only a request that bypasses
  // the cache will ask.
  //
  // `private` is retained deliberately. A shared proxy must never hold one
  // operator's photograph of their own book where another could be handed it;
  // only the browser that asked for it caches this.
  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(file)) as WebReadableStream<Uint8Array>;
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
      // The filename is built from the validated key, never from the raw URL.
      "Content-Disposition": `inline; filename="${spec.key}${derived ? ".webp" : ".jpg"}"`,
    },
  });
}
