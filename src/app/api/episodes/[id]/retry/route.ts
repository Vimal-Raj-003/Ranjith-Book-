import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { canSee } from "@/lib/episodes/visibility";
import { prepareEpisodeRetry } from "@/lib/episodes/retry";
import { enqueueEpisode } from "@/lib/episodes/queue";

/**
 * POST — regenerate ONE failed episode, on the same row.
 *
 * Named `retry`, not `regenerate`: `episodes/[id]/publish/regenerate` is the
 * unrelated route that rewrites an episode's caption copy.
 *
 * This is not a second pipeline. `prepareEpisodeRetry` puts the FAILED row back
 * to QUEUED (clearing only the previous attempt's run state — see `lib/episodes/
 * retry.ts`), and `enqueueEpisode` hands it to the same one-at-a-time queue and
 * the same `runEpisode` every generation uses. The episode keeps its idea, its
 * source pages, its theme and its saved voice, because it is the same row.
 * Nothing else is touched: other episodes of the book, queued, running or done,
 * are not read, let alone changed.
 *
 * The answer is an acknowledgement, not the outcome: the run takes minutes, and
 * the card already polls `GET /api/episodes/[id]` for it.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const episode = await prisma.episode.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    });
    // `episodes/visibility.ts`, not a copy of the rule here. That module is
    // explicit that re-queueing an ownerless episode is the same kind of call
    // as cancelling one: any signed-in user may, because the alternative was an
    // empty library. This route follows `cancel` and inherits that decision
    // rather than making a new one.
    if (!canSee(episode, user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }

    // The decision and the database writes live in `lib/episodes/retry.ts` so a
    // test can reach them — this handler cannot be called from one, because
    // `requireUser()` above reads `cookies()`.
    const outcome = await prepareEpisodeRetry(id);
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.httpStatus });
    }

    // Here and not in the lib, so the lib is safe to call from a test. Only an
    // outcome that actually reset the row gets here, and `enqueueEpisode` is
    // itself a no-op for an episode already queued or running in this process,
    // so a retry is never enqueued twice.
    enqueueEpisode(id);

    return NextResponse.json({ ok: true, status: outcome.status });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
