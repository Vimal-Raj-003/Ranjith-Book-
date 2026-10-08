import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { connectionFor, disconnect } from "@/lib/publish/youtube/accounts";
import type { ConnectionView } from "@/lib/publish/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where this install stands with YouTube, and how to stop standing there.
 *
 * GET answers a `ConnectionView` — the client-safe type, which HAS NO TOKEN
 * FIELD. That is the whole safety story for this endpoint: the response is
 * annotated with a type that cannot carry a credential, so adding one to the
 * payload does not compile. What it does carry is verdicts ("configured",
 * "connected"), the NAMES of any missing environment variables, the scopes
 * Google granted, and the channel the platform itself told us about. No value
 * of any secret, not even a prefix, not even redacted.
 *
 * DELETE disconnects, and actually revokes: it asks Google to invalidate the
 * grant, and then deletes the row whether or not Google answered. That order is
 * deliberate — a Disconnect that left a live refresh token in the database
 * because a network call failed would be the worse of the two outcomes. When
 * the revoke did not land, the response says so and names the page where the
 * operator can finish it, rather than claiming a clean disconnect.
 *
 * Neither is cached: the answer is per-session and changes the moment the
 * operator connects or disconnects.
 */
export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const view: ConnectionView = await connectionFor(user.id);
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function DELETE() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const result = await disconnect(user.id);
    const view: ConnectionView = await connectionFor(user.id);
    return NextResponse.json({
      ...view,
      // Facts about what just happened, beside the new state. `revoked: false`
      // is reported, not hidden: the credential is gone from here, and the
      // grant may not be gone from Google.
      disconnected: result.hadAccount,
      revoked: result.revoked,
      revokeProblem: result.detail,
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
