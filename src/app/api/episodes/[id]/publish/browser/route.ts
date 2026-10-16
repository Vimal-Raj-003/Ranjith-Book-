import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { AppError, errorBody, errorStatus } from "@/lib/errors";
import { isPlatformId } from "@/lib/publish/limits";
import { startBrowserPublish } from "@/lib/publish/browser/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Publish this episode by driving the platform's own web uploader in a Chromium
 * window -- the OPTIONAL alternative to the official-API routes beside this one
 * (`./youtube`, `./instagram`), which stay the default and are untouched.
 *
 * It is a route of its own rather than a `mode` flag on those two so that the API
 * routes' behaviour cannot change by accident, and so this one can carry the
 * fields only a browser publish has.
 *
 * BODY: `{ platform: "youtube" | "instagram", confirmPublic?, visibility?,
 * scheduledAt?, madeForKids?, acknowledgeRetry? }`.
 *
 *  - `confirmPublic: true` is required for anything that goes live: every
 *    Instagram share, and a YouTube post that is public or scheduled.
 *  - `madeForKids` is required for YouTube and is never defaulted: it is a legal
 *    declaration the operator makes.
 *  - `scheduledAt` (ISO) schedules through YouTube Studio. Instagram's web
 *    uploader has no schedule, so it is refused there rather than ignored.
 *  - `acknowledgeRetry: true` is the operator saying they have looked at the
 *    platform after the last attempt stopped for them. Without it, an
 *    AWAITING_HUMAN job is not run again.
 *
 * It returns as soon as the job has genuinely STARTED, with the whole
 * `PublishView`. The window opens on the SERVER's desktop and the work continues
 * detached while the Publish Center polls; the result is only ever what the
 * platform's own page confirmed. Every refusal is a 4xx with a sentence, before
 * a row is claimed or a window is opened.
 *
 * Ownership is the strict rule, as for the API routes: an ownerless episode is a
 * 403, because this posts under an account and cannot be taken back from here.
 *
 * `maxDuration` is raised for the same reason the API routes' are: the detached
 * work shares the function's lifetime on a platform that enforces one.
 */
export const maxDuration = 900;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("bad_body", "Expected a JSON object.", 400);
    }
    if (!isPlatformId(body.platform)) {
      throw new AppError("bad_platform", "Say which platform: youtube or instagram.", 400);
    }

    const asked = body.visibility;
    if (asked !== undefined && asked !== null && asked !== "" && asked !== "private" && asked !== "unlisted" && asked !== "public") {
      throw new AppError("bad_options", "Visibility must be private, unlisted or public. Nothing was sent.", 400);
    }
    const visibility = asked === "private" || asked === "unlisted" || asked === "public" ? asked : undefined;
    const scheduledAt =
      typeof body.scheduledAt === "string" && body.scheduledAt.trim() !== "" ? new Date(body.scheduledAt) : null;

    return NextResponse.json(
      await startBrowserPublish(user.id, id, body.platform, {
        confirmPublic: body.confirmPublic === true,
        acknowledgeRetry: body.acknowledgeRetry === true,
        madeForKids: typeof body.madeForKids === "boolean" ? body.madeForKids : undefined,
        visibility,
        scheduledAt,
      }),
    );
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
