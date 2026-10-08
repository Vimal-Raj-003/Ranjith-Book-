import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { publishView, saveMetadata } from "@/lib/publish/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the Publish Center shows, and the one write that changes it.
 *
 * GET is the whole surface in one request: the readiness verdict (with the list
 * of what is missing), the metadata, each platform's shaped variant with its
 * character and tag counts, each platform's state, and the handoff steps. One
 * request rather than five because every one of those answers depends on the
 * same `stat()` of the same render — split up, the panel could show
 * READY beside a missing-file error from a request that landed a moment later.
 *
 * PUT saves an operator's edit to `title`, `description` and/or `hashtags`, and
 * answers with the same shape GET does, so the client never has to re-fetch to
 * find out what its own write produced.
 *
 * Neither is cached: `dynamic = "force-dynamic"` because the answer depends on
 * the session and on what is on disk right now.
 *
 * The rules are all in `lib/publish/state.ts` — this handler only establishes
 * who is asking, which is the one part that cannot run outside a request.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    return NextResponse.json(await publishView(user.id, id));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    return NextResponse.json(await saveMetadata(user.id, id, body));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
