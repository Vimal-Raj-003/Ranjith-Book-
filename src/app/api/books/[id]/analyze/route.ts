import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { runBookAnalysis, isAnalysisRunning } from "@/lib/analysis/run";

/**
 * Starts (or, after a failure, restarts) a book's analysis and answers at
 * once. A 200-page book takes minutes — longer still when it is scanned — so
 * this never awaits the run; the client polls `GET /api/books/[id]`.
 *
 * A run already in progress is refused with 409 rather than started twice:
 * two runs over one upload would each delete the other's sections and ideas.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const upload = await prisma.upload.findUnique({ where: { id } });
    if (!upload || upload.kind !== "pdf" || (upload.userId && upload.userId !== user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    if (isAnalysisRunning(id)) {
      return NextResponse.json({ error: "This book is already being analysed.", code: "already_running" }, { status: 409 });
    }

    await prisma.upload.update({ where: { id }, data: { status: "QUEUED", step: "Queued", error: null, progress: null } });
    void runBookAnalysis(id).catch(() => {
      // Recorded on the Upload row by runBookAnalysis; nobody is left to tell.
    });
    return NextResponse.json({ ok: true, uploadId: id });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
