import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { startYouTubePublish } from "@/lib/publish/youtube/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a real upload of this episode to YouTube.
 *
 * It returns as soon as the upload has genuinely STARTED, with the whole
 * `PublishView` — the same shape every other write on this surface answers
 * with, so the client never re-fetches to see what its own action did. The
 * upload continues in the background and the panel polls for the byte count
 * YouTube acknowledges. A route that awaited a 38 MB transfer would hold a
 * connection open for a minute, show nothing while it did, and lose the upload
 * if the operator navigated away.
 *
 * WHAT IS GUARANTEED BEFORE THIS ROUTE RETURNS 200: the caller owns the
 * episode, the episode is ready, the metadata passed YouTube's own limits, this
 * server is configured, a usable grant exists, and a resumable session is being
 * opened. Every one of those failing is a 4xx with a sentence naming it —
 * nothing is "started" that could not start.
 *
 * OWNERSHIP IS STRICTER HERE THAN ANYWHERE ELSE ON THIS SURFACE.
 * `episodes/visibility.ts` is deliberately generous about ownerless episodes,
 * and reading publish state, editing metadata and recording a handoff all
 * inherit that: they are local and reversible. THIS IS NOT. It puts a file on
 * YouTube under someone's channel and cannot be taken back from this app, so
 * `startYouTubePublish` requires `userId === user.id` and answers 403 for an
 * ownerless episode with the reason spelled out. That is the one place this
 * integration is less convenient than the rest of the app, on purpose.
 *
 * `maxDuration` is raised because, although the handler returns quickly, the
 * detached upload shares the function's lifetime on a platform that enforces
 * one. On this install (a long-running `next dev` / `next start`) it simply
 * runs to completion.
 */
export const maxDuration = 900;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    return NextResponse.json(await startYouTubePublish(user.id, id));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
