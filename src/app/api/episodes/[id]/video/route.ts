import { NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { prisma } from "@/lib/db";
import { RENDER_DIR } from "@/lib/paths";
import { currentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The `Content-Disposition` for a title, which is NOT simply the title.
 *
 * Header values are ByteStrings, so any character above U+00FF throws on
 * construction and takes the whole response down with it — and this app's own
 * title writer produces em dashes ("Productivity Isn't Hustle — The Eagle
 * Way"), so a plain interpolation 500s on ordinary output rather than on some
 * exotic edge case. RFC 5987 is the fix, and `/api/gutenberg/download` already
 * uses it: the ASCII `filename` is the fallback and `filename*` carries the
 * real one. Quotes, backslashes and control characters are replaced rather
 * than escaped, because a bare CR/LF in the fallback would split the header.
 */
function disposition(title: string): string {
  const name = `${title}.mp4`;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Stream a finished video to the user who made it.
 *
 * Renders live outside `public/` precisely so this check cannot be skipped, and
 * the handler answers Range requests because a `<video>` element needs them to
 * seek — without a 206 path the browser can only play straight through.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const { id } = await ctx.params;
  const episode = await prisma.episode.findFirst({
    where: { id, userId: user.id },
    select: { id: true, title: true },
  });
  if (!episode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // `id` came from the database, so it cannot traverse — but resolve and confine
  // it anyway rather than trusting that to stay true.
  const file = path.join(RENDER_DIR, `${episode.id}.mp4`);
  if (path.dirname(path.resolve(file)) !== path.resolve(RENDER_DIR)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let size: number;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return NextResponse.json({ error: "That video is no longer on disk." }, { status: 404 });
  }

  const base = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    // Private: a shared proxy must never hand one user's video to another.
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Content-Disposition": disposition(episode.title || episode.id),
  };

  const range = req.headers.get("range");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);

  if (match) {
    const [, rawStart, rawEnd] = match;
    let start = rawStart ? Number(rawStart) : 0;
    let end = rawEnd ? Number(rawEnd) : size - 1;

    if (!rawStart && rawEnd) {
      // A suffix range ("bytes=-500") asks for the final N bytes.
      start = Math.max(0, size - Number(rawEnd));
      end = size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    end = Math.min(end, size - 1);

    const stream = Readable.toWeb(
      fs.createReadStream(file, { start, end }),
    ) as WebReadableStream<Uint8Array>;

    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(file)) as WebReadableStream<Uint8Array>;
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: { ...base, "Content-Length": String(size) },
  });
}
