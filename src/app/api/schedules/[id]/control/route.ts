import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { controlSchedule } from "@/lib/schedule/store";

export const runtime = "nodejs";
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json();
    return NextResponse.json(await controlSchedule(user.id, id, body.action, { acknowledgeRetry: body.acknowledgeRetry === true }));
  } catch (error) { return NextResponse.json(errorBody(error), { status: errorStatus(error) }); }
}
