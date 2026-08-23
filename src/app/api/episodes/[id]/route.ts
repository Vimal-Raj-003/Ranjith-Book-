import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { reapStaleRuns } from "@/lib/reap";
import { parseThumbnails } from "@/lib/thumbnails/store";
import { publicThumbs } from "@/lib/episode-view";

/** `hashtags` is stored as a JSON string[]; a malformed or legacy row must not
 *  break the poll this rides in on, so it degrades to an empty list. */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Polled every 1.5s by the client while an episode runs (see `PipelineRail`).
 * Kept to the fields the rail, the player and the publish panel actually need
 * — the full `script`/`verification` JSON blobs are for a future review
 * screen, not this poll.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    // Best-effort, same reasoning as the uploads poll route: this is the
    // natural place to notice and close out a run that stopped responding,
    // and it must never break the poll it rides in on.
    await reapStaleRuns().catch(() => {});

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
      // The publish panel's copy blocks. Written by the content step, so they
      // are null until it runs — the client renders nothing rather than an
      // empty box.
      hook: episode.hook,
      cta: episode.cta,
      description: episode.description,
      hashtags: parseTags(episode.hashtags),
      thumbnails: publicThumbs(parseThumbnails(episode.thumbnails)),
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
