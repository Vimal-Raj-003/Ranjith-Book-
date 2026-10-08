import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { serveThumbnail } from "@/lib/thumbnails/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stream one thumbnail to a signed-in user who may see its episode.
 *
 * Everything but "who is asking" is in `serveThumbnail`: the episode lookup
 * (`visibleTo`, the same rule the library lists by), the key and `size`
 * validation, the grid derivative and its fallback, the caching headers. They
 * live there because `currentUser()` reads `cookies()` and cannot run outside a
 * request, so a handler that held them could not be tested.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const { id, key } = await ctx.params;
  return serveThumbnail(
    user.id,
    id,
    key,
    new URL(req.url).searchParams.get("size"),
    req.headers.get("if-none-match"),
    req.signal,
  );
}
