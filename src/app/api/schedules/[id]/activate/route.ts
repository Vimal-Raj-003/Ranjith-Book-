import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { activateSchedule } from "@/lib/schedule/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Activate a saved schedule: THE operator's confirmation that these videos go live
 * on the channel at their slot times, and cannot be taken back from here.
 *
 * It validates (a "made for kids" answer is saved; every slot still to do is at
 * least 15 minutes away and still a finished video of this book), marks the
 * schedule active, and starts the runner -- then returns the schedule at once. The
 * runner uploads the videos one at a time through the same browser-window route the
 * Publish Center uses, so each is recorded as SCHEDULED only after YouTube Studio
 * read the exact time back. See `lib/schedule/activate.ts`.
 *
 * Activating an active schedule again picks up where it stopped: videos that are
 * already scheduled or posted are skipped, never uploaded twice.
 *
 * `maxDuration` is raised for the same reason the browser-publish route's is: the
 * detached run shares the function's lifetime on a platform that enforces one.
 */
export const maxDuration = 900;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return NextResponse.json(await activateSchedule(user.id, id));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
