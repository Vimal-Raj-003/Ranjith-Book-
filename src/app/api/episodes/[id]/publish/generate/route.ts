import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { AppError, errorBody, errorStatus } from "@/lib/errors";
import { generateMissingPlatformMetadata } from "@/lib/publish/generate";
import { loadForRegenerate, publishView } from "@/lib/publish/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A model call, run the way Regenerate's is (it is not one of `EPISODE_KINDS`,
 * so `cli.ts` does not isolate it), so the same ceiling applies: the watchdogs
 * in `cli.ts` are the limit, and Next's default function timeout would cut the
 * call short, so it is raised to just past them.
 */
export const maxDuration = 700;

/**
 * Write the YouTube tags and the Instagram hook, caption and hashtags that an
 * episode does not have yet.
 *
 * The Publish Center posts here once when it opens a finished episode with any
 * of those four empty — an episode rendered before the render wrote them — and
 * again if the operator presses Generate after a failure. No body is read: which
 * fields are missing is the server's own measurement of the row.
 *
 * ONLY EMPTY FIELDS ARE WRITTEN. A field that already has a value is not
 * replaced, and a field the operator has edited — including one they emptied on
 * purpose — is theirs and is left alone (`storeGeneratedPlatform` makes that a
 * property of the write itself). When nothing is missing the answer is the
 * current view and no model call is made. Replacing a value is what
 * `.../regenerate` is for, with its confirmation.
 *
 * The answer is the whole `publishView`, the same shape GET, PUT and Regenerate
 * return, so the client takes it as the new state without a second request.
 *
 * Visibility is `visibleTo` (via `loadForRegenerate`) like every other local,
 * reversible write on this surface: the copy it writes is this app's own
 * metadata, and nothing here posts anywhere.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const row = await loadForRegenerate(user.id, id);

    // The copy is written from a finished script; an episode that is queued,
    // running, failed or cancelled has none to write from, or is about to have
    // the render write these fields itself.
    if (row.status !== "DONE") {
      throw new AppError(
        "not_ready",
        "This episode is not finished yet, so there is nothing to write its tags and Instagram copy from.",
        409,
      );
    }

    await generateMissingPlatformMetadata(id);
    return NextResponse.json(await publishView(user.id, id));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
