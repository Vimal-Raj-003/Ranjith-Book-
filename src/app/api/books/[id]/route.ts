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
        ideas: { include: { episodes: { select: { id: true, status: true, createdAt: true, startedAt: true, updatedAt: true } } } },
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

const VALID_RIGHTS = new Set(["public-domain", "in-copyright", "own-work"]);

/**
 * Updates editable book-level properties (such as `rightsStatus` after upload)
 * for the book linked to this PDF upload.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { rightsStatus?: unknown } | null;
    const rightsStatus = typeof body?.rightsStatus === "string" ? body.rightsStatus.trim() : "";
    if (!VALID_RIGHTS.has(rightsStatus)) {
      return NextResponse.json(
        { error: `"${rightsStatus}" is not a valid rights status.`, code: "bad_request" },
        { status: 400 },
      );
    }

    const upload = await prisma.upload.findUnique({
      where: { id },
      select: { id: true, kind: true, userId: true, bookId: true },
    });
    if (!upload || upload.kind !== "pdf" || (upload.userId && upload.userId !== user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }

    await prisma.book.update({
      where: { id: upload.bookId },
      data: { rightsStatus },
    });
    return NextResponse.json({ ok: true, rightsStatus });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
