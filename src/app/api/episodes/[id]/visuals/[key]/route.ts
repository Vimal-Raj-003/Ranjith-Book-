import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { serveSceneVisual } from "@/lib/video/visual-engine/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const { id, key } = await ctx.params;
  return serveSceneVisual(user.id, id, key);
}
