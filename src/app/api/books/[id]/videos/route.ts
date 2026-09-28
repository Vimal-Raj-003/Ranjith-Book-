import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { createIdeaEpisodes } from "@/lib/episodes/idea-episode";
import { enqueueEpisode } from "@/lib/episodes/queue";

const MAX_PER_REQUEST = 20;

/**
 * POST `{ ideaIds: string[] }` — make a video from each idea. Creates one
 * queued Episode per idea (an idea that already has a queued, running or
 * finished one is returned as-is, not duplicated) and hands each to the
 * one-at-a-time episode queue. Answers immediately; progress is polled through
 * `GET /api/episodes/[id]`, the same route every episode uses.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { ideaIds?: unknown } | null;
    const ideaIds = Array.isArray(body?.ideaIds)
      ? [...new Set(body.ideaIds.filter((v): v is string => typeof v === "string"))]
      : [];
    if (ideaIds.length === 0) {
      return NextResponse.json({ error: "Choose at least one idea to make into a video.", code: "bad_request" }, { status: 400 });
    }
    if (ideaIds.length > MAX_PER_REQUEST) {
      return NextResponse.json({ error: `At most ${MAX_PER_REQUEST} videos can be queued at once.`, code: "bad_request" }, { status: 400 });
    }

    const upload = await prisma.upload.findUnique({ where: { id } });
    if (!upload || upload.kind !== "pdf" || (upload.userId && upload.userId !== user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    if (upload.status !== "DONE") {
      return NextResponse.json({ error: "This book is still being analysed.", code: "not_ready" }, { status: 409 });
    }

    const episodes = await createIdeaEpisodes(id, ideaIds, user.id);
    if (episodes.length === 0) {
      return NextResponse.json({ error: "None of those ideas belong to this book.", code: "not_found" }, { status: 404 });
    }
    // A new episode is queued; so is an old QUEUED one this process is not
    // holding — what a server restart leaves behind — rather than left to wait
    // for the reaper. `enqueueEpisode` ignores one already in the queue.
    for (const e of episodes) if (e.created || e.status === "QUEUED") enqueueEpisode(e.episodeId);
    return NextResponse.json({ episodes });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
