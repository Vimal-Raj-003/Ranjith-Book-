import { NextResponse } from "next/server";
import { setIdeasSelection } from "@/lib/ideas-selection";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";

/**
 * PATCH `{ selected: boolean, ideaIds?: string[] }` — bulk-select or bulk-deselect
 * a book's content ideas so "Select all" and "Deselect all" persist across reloads.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { selected?: unknown; ideaIds?: unknown } | null;
    if (typeof body?.selected !== "boolean") {
      return NextResponse.json({ error: "Send { selected: true | false }.", code: "bad_request" }, { status: 400 });
    }

    const res = await setIdeasSelection(
      id,
      user.id,
      body.selected,
      Array.isArray(body.ideaIds) ? (body.ideaIds as string[]) : null,
    );
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
