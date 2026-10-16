import { serveSignedMedia } from "@/lib/publish/media-serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The URL Meta fetches a video from, and the one public route in the publish
 * surface.
 *
 * THERE IS NO SESSION CHECK HERE, ON PURPOSE. Meta's servers have no cookie, and
 * the whole point of this endpoint is to be reachable by them. What stands in
 * for a session is the token in the path: an HMAC-signed grant for ONE episode
 * that expires in minutes (`lib/publish/media-link.ts`), minted only after the
 * owner of the episode asked to publish it. A request without a valid token gets
 * a 403 that says nothing about why, and a request with one gets exactly one
 * file — `RENDER_DIR/<episodeId>.mp4`, never a path from the URL.
 *
 * GET only. Next answers every other method with a 405.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return serveSignedMedia(req, token);
}
