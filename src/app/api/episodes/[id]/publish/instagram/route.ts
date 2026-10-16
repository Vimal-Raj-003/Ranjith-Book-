import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { startInstagramPublish } from "@/lib/publish/instagram/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Publish this episode to Instagram as a Reel, through Meta's official API.
 *
 * IT POSTS PUBLICLY AND AT ONCE. Instagram's Content Publishing API has no draft
 * and no private mode, so unlike the YouTube route (private, finished in Studio)
 * there is nothing to review afterwards. The body must therefore be
 * `{ "confirmPublic": true }`; anything else is a 409 `needs_confirmation` and
 * nothing is sent. The check is in `startInstagramPublish`, not only here.
 *
 * It returns as soon as the publish has genuinely STARTED, with the whole
 * `PublishView`. The container is created, Instagram fetches and processes the
 * video (minutes, not seconds), and the Reel is published, all in one detached
 * server-side operation while the Publish Center polls for the stage. A route that
 * awaited that would hold a connection open for minutes and lose the work if the
 * operator navigated away.
 *
 * WHAT IS GUARANTEED BEFORE THIS ROUTE RETURNS 200: the caller owns the episode
 * (ownerless episodes are refused, as for YouTube -- a public post cannot be taken
 * back from here), the episode is ready, the caption passed Instagram's limits,
 * this server is configured, a grant exists, the connected account is the
 * EXPECTED one according to Instagram's own API, and `PUBLIC_BASE_URL` is an
 * address Meta can reach. Each of those failing is a 4xx with a sentence naming it.
 *
 * `maxDuration` is raised for the same reason the YouTube route's is: the detached
 * work shares the function's lifetime on a platform that enforces one.
 */
export const maxDuration = 900;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { confirmPublic?: unknown } | null;
    return NextResponse.json(await startInstagramPublish(user.id, id, { confirmPublic: body?.confirmPublic === true }));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
