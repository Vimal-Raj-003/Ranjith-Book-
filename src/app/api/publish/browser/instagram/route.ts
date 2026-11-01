import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { instagramConnectionView, parseCheckRequest, startInstagramCheck } from "@/lib/publish/browser/instagram-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Instagram account connection for the Publish panel.
 *
 * GET   the last look at the account (who was signed in, what kind of account,
 *       whether the composer offered "Schedule content"), the state that follows,
 *       and the progress of a check that is running. Opens no browser.
 *
 * POST  `{ action: "verify" }` reads the account through BookReel's Instagram
 *       profile and uploads nothing. `{ action: "check_scheduling", confirm: true }`
 *       also loads a blank placeholder clip into Instagram's composer to see
 *       whether it offers "Schedule content"; it is refused without `confirm`.
 *       Either starts a background check and answers 202 at once -- the card polls
 *       GET. Neither shares, schedules or posts anything, and neither touches a
 *       publishing flag.
 *
 * Opening the sign-in window is NOT here: it is the existing
 * `POST /api/publish/browser/signin` with `{ platform: "instagram" }`.
 *
 * Authenticated like every publish route: a window opening on the server's
 * desktop is not something to offer anonymously.
 */
export async function GET() {
  try {
    await requireUser();
    return NextResponse.json({ connection: await instagramConnectionView() });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function POST(req: Request) {
  try {
    await requireUser();
    const mode = parseCheckRequest(await req.json().catch(() => null));
    return NextResponse.json({ connection: await startInstagramCheck(mode) }, { status: 202 });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
