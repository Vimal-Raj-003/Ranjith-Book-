import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { cancelEpisode } from "@/lib/cancel";
import { canSee } from "@/lib/episodes/visibility";

/**
 * POST — stop a running episode. Only meaningful while `status` is RUNNING:
 * a QUEUED episode has no process yet to signal (removing it from the queue
 * is a separate concern this route does not cover), and DONE/FAILED/CANCELLED
 * are already finished.
 *
 * `requestCancel` aborts the real `AbortController` `runEpisode` registered
 * for this episode — which kills whatever child process (the Claude CLI,
 * faster-whisper, the renderer) is running right now — rather than only
 * writing a status here and hoping the pipeline notices; see `lib/cancel.ts`.
 * The actual `status: "CANCELLED"` write happens moments later, from inside
 * `runEpisode` itself once the killed step's promise rejects, so this route
 * answers with an acknowledgement, not the final state — the client already
 * polls `GET /api/episodes/[id]` and will see it land.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const episode = await prisma.episode.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    });
    // `episodes/visibility.ts`, not a copy of the rule here. Note what that
    // module says about destructive actions: cancelling is the one call site
    // where "any signed-in user may act on an ownerless episode" is doing more
    // than reading. It is what this route has always done, and narrowing it is
    // a policy decision, not a refactor.
    if (!canSee(episode, user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    // The decision lives in `lib/cancel.ts` (`cancelEpisode`) so that it is
    // reachable from a test — this handler cannot be, because `requireUser()`
    // above reads `cookies()`. Same single cancellation path either way.
    const outcome = cancelEpisode(id, episode.status);
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.httpStatus });
    }

    return NextResponse.json({ ok: true, status: outcome.status });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
