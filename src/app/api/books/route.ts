import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { createPdfUpload } from "@/lib/pdf/create-pdf-upload";
import { errorBody, errorStatus } from "@/lib/errors";
import { visibleTo } from "@/lib/episodes/visibility";
import { coverState } from "@/lib/covers/status";
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
    // The same ownership rule the episode routes use, from the one module that
    // states it. An `Upload` carries the same nullable `userId` and for the
    // same reason: uploads made before sign-in existed, or by tooling with no
    // session, have no owner, and hiding them would empty the operator's own
    // shelf. (The module is named for episodes because that is where the drift
    // bug happened; the rule is the install's, not the table's.)
    const uploads = await prisma.upload.findMany({
      where: { kind: "pdf", ...visibleTo(user.id) },
      include: {
        book: { select: { title: true } },
        _count: { select: { ideas: true } },
        // The page a cover is made from: the lowest-numbered one, one row per
        // upload. Only its two paths are read.
        pages: { orderBy: { pageIndex: "asc" }, take: 1, select: { derivedPath: true, filePath: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // Where each cover stands, read off the filesystem. Derives nothing -- that
    // happens when a card asks for its image -- and never throws: a book whose
    // cover cannot be read is `failed`, not a reason to lose the list.
    const covers = await Promise.all(uploads.map((u) => coverState(u.id, u.pages[0])));
    const books: AnalysisSummary[] = uploads.map((u, i) => ({
      id: u.id,
      bookTitle: u.book.title,
      status: u.status,
      step: u.step,
      pageCount: u.pageCount,
      ideaCount: u._count.ideas,
      createdAt: u.createdAt.toISOString(),
      coverStatus: covers[i].status,
      coverRev: covers[i].rev,
    }));
    return NextResponse.json({ books });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
