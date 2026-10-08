import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { regenerateCover, serveCover } from "@/lib/covers/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Anything that is not "you are not signed in" is answered as a missing cover,
 * not a 500: a card's cover is decoration, and the only thing a failure here
 * should cost is its initials tile. `serveCover` and `regenerateCover` already
 * catch their own failures; this is the same promise for the one call that is
 * not theirs, `requireUser()` (which reads a session from the database).
 */
function failure(err: unknown) {
  // `errorStatus`, not `isAppError`: this must compile against what is
  // committed, and only `errorBody`/`errorStatus` are there.
  if (errorStatus(err) === 401) return NextResponse.json(errorBody(err), { status: 401 });
  return NextResponse.json({ error: "The cover is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET — one cover, `?size=small|medium|large` (default medium).
 *
 * Everything but "who is asking" is in `serveCover`: the ownership rule
 * (`visibleTo`), the size validation, the derivation and its cache, the
 * `immutable` caching headers. They live there because `requireUser()` reads
 * `cookies()` and cannot run outside a request, so a handler that held them
 * could not be tested. The `v=` the client sends is a cache key only; it is
 * not read.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return await serveCover(user.id, id, new URL(req.url).searchParams.get("size"), req.headers.get("if-none-match"));
  } catch (err) {
    return failure(err);
  }
}

/**
 * POST — regenerate this upload's cover: clear its cached files and derive them
 * again, answering with the new `coverStatus` and `coverRev` so the card can
 * point at the new URL without waiting for a list reload.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return await regenerateCover(user.id, id);
  } catch (err) {
    return failure(err);
  }
}
