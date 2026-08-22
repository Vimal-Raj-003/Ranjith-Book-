import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";

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
