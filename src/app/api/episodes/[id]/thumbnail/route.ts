import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { editPoster } from "@/lib/episodes/poster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Choose a poster, and/or retitle them.
 *
 * `{ choice }` records which poster represents the episode and renders nothing.
 * `{ headline }` redraws all six posters with that headline (an empty one goes
 * back to the generated headline), which takes a few seconds -- the client
 * holds the control in a pending state meanwhile. Both may be sent together.
 * The rules live in `editPoster`; this handler only establishes who is asking
 * and reads the body, because nothing else here can be exercised outside a
 * request.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await editPoster(user.id, id, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
