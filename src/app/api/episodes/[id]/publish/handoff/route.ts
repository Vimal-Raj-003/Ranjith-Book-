import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { isPlatformId } from "@/lib/publish/limits";
import { recordHandoff } from "@/lib/publish/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record that this episode's files and text were handed over for one platform.
 *
 * It is NOT a publish, and the name is deliberate. With nothing connected, the
 * publisher for either platform is the assisted handoff: it validates the
 * metadata against that platform's real limits, confirms the video and poster
 * are on disk, freezes the exact metadata that was handed over, and returns
 * `REQUIRES_CONNECTION`. The row it writes has no `externalId` and no
 * `publishedAt`, because no platform said anything.
 *
 * So this answers one question the operator currently has no way to answer:
 * "did I already take this one to YouTube, and with which words?" It never
 * answers "is it live" — nothing in this build can.
 *
 * It refuses with 409 when the episode is not ready, rather than recording a
 * handoff of a video that is not on disk.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { platform?: unknown } | null;
    if (!isPlatformId(body?.platform)) {
      return NextResponse.json({ error: "Name a platform: youtube or instagram.", code: "bad_platform" }, { status: 400 });
    }

    return NextResponse.json(await recordHandoff(user.id, id, body.platform));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
