import { NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";
import { parseThumbnails, selectThumb } from "@/lib/thumbnails";

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
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
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

  let size: number;
  try {
    size = (await fsp.stat(spec.path)).size;
  } catch {
    return NextResponse.json({ error: "That thumbnail is no longer on disk." }, { status: 404 });
  }

  const stream = Readable.toWeb(fs.createReadStream(spec.path)) as WebReadableStream<Uint8Array>;
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(size),
      // Private: a shared proxy must never hand one user's page photo to another.
      "Cache-Control": "private, max-age=0, must-revalidate",
      // The filename is built from the validated key, never from the raw URL.
      "Content-Disposition": `inline; filename="${spec.key}.jpg"`,
    },
  });
}
