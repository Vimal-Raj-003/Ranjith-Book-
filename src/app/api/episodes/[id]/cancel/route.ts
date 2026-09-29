import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { requestCancel } from "@/lib/cancel";

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
    if (!episode || (episode.userId && episode.userId !== user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    if (episode.status !== "RUNNING") {
      return NextResponse.json(
        { error: `This episode is not running (it is ${episode.status.toLowerCase()}), so there is nothing to cancel.`, code: "not_running" },
        { status: 409 },
      );
    }

    if (!requestCancel(id)) {
      // Never fake it: if there is no live controller for this episode in
      // this process, nothing was actually signalled, so nothing has
      // actually stopped — the honest answer is failure, not a status flip.
      return NextResponse.json(
        {
          error:
            "No active run was found for this episode on this server. If it still shows as running, the server likely restarted mid-run — it will be marked interrupted automatically within a few minutes.",
          code: "not_active_here",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, status: "cancelling" });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
