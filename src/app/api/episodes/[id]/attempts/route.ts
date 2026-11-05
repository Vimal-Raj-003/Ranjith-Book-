import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { readAttemptHistory } from "@/lib/episodes/attempt-history";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const history = await readAttemptHistory(id, user.id);
    return history ? NextResponse.json(history) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
