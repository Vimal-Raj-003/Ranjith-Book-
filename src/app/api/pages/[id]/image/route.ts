import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";

/**
 * Photographs are private — they are pictures of what someone is reading,
 * taken in their home — so this route requires a session before it will
 * stream anything back, the same way the upload route requires one to
 * accept anything in.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();

    const { id } = await ctx.params;
    const page = await prisma.page.findUnique({ where: { id }, include: { upload: { select: { userId: true } } } });
    // Someone else's page is answered exactly like a missing one, the same
    // rule the upload and episode routes apply, so an id reveals nothing.
    if (!page || (page.upload.userId && page.upload.userId !== user.id)) {
      return NextResponse.json({ error: "No such page.", code: "not_found" }, { status: 404 });
    }

    const bytes = await readFile(page.derivedPath ?? page.filePath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" },
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
