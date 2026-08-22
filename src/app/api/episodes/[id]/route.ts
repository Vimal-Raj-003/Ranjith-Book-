import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";

/**
 * Polled every 1.5s by the client while an episode runs (see `PipelineRail`).
 * Kept to the fields the rail and player actually need — the full `script`/
 * `verification` JSON blobs are for a future review screen, not this poll.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const episode = await prisma.episode.findUnique({
      where: { id },
      include: { book: { select: { title: true } } },
    });
    if (!episode) return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    if (episode.userId && episode.userId !== user.id) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }

    return NextResponse.json({
      id: episode.id,
      bookTitle: episode.book.title,
      title: episode.title,
      status: episode.status,
      step: episode.step,
      error: episode.error,
      notes: episode.notes ? (JSON.parse(episode.notes) as string[]) : [],
      partNumber: episode.partNumber,
      seriesTotal: episode.seriesTotal,
      durationSec: episode.durationSec,
      hasVideo: Boolean(episode.videoPath),
      startedAt: episode.startedAt,
      finishedAt: episode.finishedAt,
      totalMs: episode.totalMs,
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
