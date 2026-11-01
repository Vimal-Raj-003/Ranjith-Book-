import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { AppError, errorBody, errorStatus } from "@/lib/errors";
import { isPlatformId } from "@/lib/publish/limits";
import { openSignInWindow } from "@/lib/publish/browser/signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open the one-time sign-in window for the browser-publishing route: an ordinary
 * Chrome, on the computer running BookReel, on BookReel's own dedicated profile.
 *
 * This is the first half of "sign in once, then reuse". The person signs in to
 * the platform in that window by hand and closes it; the next browser publish
 * opens Chrome on the same profile already signed in, so Google's sign-in page --
 * which refuses automated browsers -- is never shown to it. See `signin.ts` for
 * what the window is (a plain process with only the profile on its command line)
 * and what this app never does (type or store a password, copy a cookie, touch the
 * person's own Chrome profile).
 *
 * BODY: `{ platform: "youtube" | "instagram" }` and nothing else. The profile, the
 * program and its arguments are all decided on the server; nothing the caller sends
 * can name a path or a flag.
 *
 * ANSWERS: 200 `{ ok: true, message }` once the window is opening; 409 with a
 * sentence and a `code` when it cannot be (no installed Chrome, not in channel
 * mode, a publish holds the profile). Authenticated like every publish route: a
 * window opening on the server's desktop is not something to offer anonymously.
 */
export async function POST(req: Request) {
  try {
    await requireUser();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("bad_body", "Expected a JSON object.", 400);
    }
    if (!isPlatformId(body.platform)) {
      throw new AppError("bad_platform", "Say which platform: youtube or instagram.", 400);
    }

    const result = await openSignInWindow(body.platform);
    if (!result.ok) throw new AppError(result.code, result.message, 409);
    return NextResponse.json({ ok: true, message: result.message });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
