import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { runIngest, runEpisode } from "@/lib/pipeline";
import { errorBody, errorStatus } from "@/lib/errors";

/**
 * Starts the whole pipeline and answers immediately. Ingest and every episode
 * it produces can run for minutes — well past any reasonable HTTP timeout —
 * so this route never awaits any of it. The operator watches progress by
 * polling `GET /api/uploads/[id]` (before any episode exists) and then
 * `GET /api/episodes/[id]` (once it does), not by waiting on this response.
 *
 * `runIngest` only produces the episode plan and rows — see its own doc
 * comment — so chaining `runEpisode` over every id it returns is what turns
 * "ingest finished" into "a video exists": the one thing an operator who just
 * pressed this button actually came here for. `Promise.allSettled` (rather
 * than `Promise.all`) means one episode failing never leaves another
 * episode's promise an unhandled rejection.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const upload = await prisma.upload.findUnique({ where: { id } });
    if (!upload) return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    if (upload.userId && upload.userId !== user.id) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }

    void runIngest(id)
      .then((episodeIds) => Promise.allSettled(episodeIds.map((epId) => runEpisode(epId))))
      .catch(() => {
        // The failure itself is already recorded on the Upload/Episode rows
        // by runIngest/runEpisode; there is no request left to answer it to.
      });

    return NextResponse.json({ ok: true, uploadId: id });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
