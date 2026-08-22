import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { reapStaleRuns } from "@/lib/reap";

/**
 * Polled while ingest is running and no `Episode` exists yet — the first
 * several `INGEST_STEPS` (reading, measuring, aligning, identifying,
 * planning) happen before a single episode row is created, so the client has
 * nothing else to poll during that window. Once `episodeIds` is non-empty,
 * the client switches to polling `GET /api/episodes/[id]` for each one.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    // Best-effort: an operator's own poll is what notices a run that has
    // stopped responding, so this is the natural place to reap it — the very
    // next poll after the staleness cutoff shows FAILED instead of a spinner
    // that will never finish. A failure here must never break the poll
    // itself, since the client has no other way to learn this upload's state.
    await reapStaleRuns().catch(() => {});

    const upload = await prisma.upload.findUnique({
      where: { id },
      include: { episodes: { select: { id: true }, orderBy: { partNumber: "asc" } } },
    });
    if (!upload) return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    if (upload.userId && upload.userId !== user.id) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }

    return NextResponse.json({
      id: upload.id,
      status: upload.status,
      step: upload.step,
      error: upload.error,
      episodeIds: upload.episodes.map((e) => e.id),
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
