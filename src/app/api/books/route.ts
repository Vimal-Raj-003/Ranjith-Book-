import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { createPdfUpload } from "@/lib/pdf/create-pdf-upload";
import { errorBody, errorStatus } from "@/lib/errors";
import type { AnalysisSummary } from "@/lib/analysis/view";

/**
 * POST — upload one book PDF. The PDF is the raw request body
 * (`Content-Type: application/pdf`), not multipart: a 200-page book can be
 * over 100MB, and a raw body can be streamed straight to disk, where
 * `formData()` would buffer all of it in memory first. The book's details
 * ride in the query string.
 *
 * GET — the signed-in operator's PDF analyses, newest first.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const result = await createPdfUpload(
      {
        title: url.searchParams.get("title") ?? "",
        rightsStatus: url.searchParams.get("rightsStatus"),
        bookLink: url.searchParams.get("bookLink"),
        body: req.body,
      },
      user.id,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function GET() {
  try {
    const user = await requireUser();
    const uploads = await prisma.upload.findMany({
      where: { kind: "pdf", OR: [{ userId: user.id }, { userId: null }] },
      include: { book: { select: { title: true } }, _count: { select: { ideas: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const books: AnalysisSummary[] = uploads.map((u) => ({
      id: u.id,
      bookTitle: u.book.title,
      status: u.status,
      step: u.step,
      pageCount: u.pageCount,
      ideaCount: u._count.ideas,
      createdAt: u.createdAt.toISOString(),
    }));
    return NextResponse.json({ books });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
