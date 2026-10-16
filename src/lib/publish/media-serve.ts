/**
 * SERVER-ONLY. The body of `GET /api/publish/media/[token]`: stream one rendered
 * video to whoever holds a valid signed link, and to nobody else.
 *
 * It lives here and not in the route for the reason `serveThumbnail` does: the
 * route has nothing to establish (there is NO session on this endpoint, by
 * design — Meta's servers have none), so the rules are the whole of it, and the
 * part worth testing is a function that can be called without a request.
 *
 * THE ONLY AUTHORITY IS THE TOKEN. `verifyMediaToken` proves this server signed a
 * link for this episode id and that it has not expired. Everything after that is
 * about not being fooled by what the id points at:
 *
 *  - the file is `RENDER_DIR/<episodeId>.mp4`, built from the id the SIGNATURE
 *    covers, never from anything in the request URL beyond the token;
 *  - the episode must exist and must have a recorded render, and the file must
 *    be on disk, or the answer is a plain 404;
 *  - the resolved path must be a direct child of `RENDER_DIR`, as the video
 *    route checks, so even an id that somehow carried a separator cannot leave
 *    the directory;
 *  - nothing in any response names a path, a title, an owner or a reason beyond
 *    "not valid" — a bad signature, an expired link and a malformed token are all
 *    the same 403.
 *
 * It mirrors the range handling of `/api/episodes/[id]/video` (which this does
 * not modify): Meta's fetcher may request the file in ranges, and a 206 path is
 * what lets it. The headers differ on purpose: no `Content-Disposition` title,
 * `no-store` instead of `private`, and `nosniff`.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { nodeToWebStream } from "@/lib/node-web-stream";
import { RENDER_DIR } from "@/lib/paths";
import { isMediaLinkError, verifyMediaToken } from "./media-link";
import type { EnvLike } from "./youtube/secrets";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

const refuse = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: { ...HEADERS } });

export async function serveSignedMedia(
  req: Request,
  token: string,
  env: EnvLike = process.env,
  now: number = Date.now(),
): Promise<Response> {
  let episodeId: string;
  try {
    episodeId = verifyMediaToken(token, env, now).episodeId;
  } catch (err) {
    // Every reason is one answer. A caller probing the endpoint learns nothing
    // about whether a signature was close, a link expired, or a key is missing.
    if (isMediaLinkError(err)) return refuse(403, "This link is not valid or has expired.");
    throw err;
  }

  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    select: { id: true, videoPath: true },
  });
  if (!episode || !episode.videoPath) return refuse(404, "Not found");

  const file = path.join(RENDER_DIR, `${episode.id}.mp4`);
  if (path.dirname(path.resolve(file)) !== path.resolve(RENDER_DIR)) return refuse(404, "Not found");

  let size: number;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return refuse(404, "Not found");
  }

  const base = { ...HEADERS, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
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
      return new Response(null, { status: 416, headers: { ...HEADERS, "Content-Range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);

    return new Response(nodeToWebStream(fs.createReadStream(file, { start, end }), req.signal), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(nodeToWebStream(fs.createReadStream(file), req.signal), {
    status: 200,
    headers: { ...base, "Content-Length": String(size) },
  });
}
