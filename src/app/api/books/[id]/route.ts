import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { reapStaleRuns } from "@/lib/reap";
import { analysisView } from "@/lib/analysis/view";

/**
 * Polled while a book is being analysed, and read once it is done: status,
 * the current step and position inside it, notes, and — once they exist —
 * the ideas. Reaps first, like the other poll routes, so a run killed by a
 * server restart shows as interrupted instead of spinning forever.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await reapStaleRuns().catch(() => {});

    const upload = await prisma.upload.findUnique({
      where: { id },
      include: {
        book: true,
        ideas: { include: { episodes: { select: { id: true, status: true, createdAt: true } } } },
        pages: { select: { id: true, pageIndex: true, pageLabel: true } },
      },
    });
    if (!upload || upload.kind !== "pdf" || (upload.userId && upload.userId !== user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    return NextResponse.json(analysisView(upload));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
