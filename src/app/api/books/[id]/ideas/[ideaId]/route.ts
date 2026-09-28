import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";

/**
 * PATCH `{ selected: boolean }` — mark an idea as one the operator wants made
 * into a video. Selection is stored, not just held in the browser, so it
 * survives a reload and is there for video generation to pick up.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; ideaId: string }> }) {
  try {
    const user = await requireUser();
    const { id, ideaId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { selected?: unknown } | null;
    if (typeof body?.selected !== "boolean") {
      return NextResponse.json({ error: "Send { selected: true | false }.", code: "bad_request" }, { status: 400 });
    }

    const idea = await prisma.contentIdea.findUnique({ where: { id: ideaId }, include: { upload: true } });
    if (!idea || idea.uploadId !== id || (idea.upload.userId && idea.upload.userId !== user.id)) {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    await prisma.contentIdea.update({
      where: { id: ideaId },
      data: { status: body.selected ? "SELECTED" : "PROPOSED" },
    });
    return NextResponse.json({ ok: true, selected: body.selected });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
