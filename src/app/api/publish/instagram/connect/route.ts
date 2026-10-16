import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { beginFlow } from "@/lib/publish/instagram/accounts";
import { SCOPE_PARAM, publicConfig, serverConfig } from "@/lib/publish/instagram/config";
import { authorizeUrl } from "@/lib/publish/instagram/graph";
import { safeReturnTo } from "@/lib/publish/youtube/config";
import { makeState } from "@/lib/publish/youtube/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start the Facebook consent, by sending the operator's browser to Facebook.
 *
 * A 303 REDIRECT rather than a JSON `{ url }` the client then navigates to, for
 * the reasons the YouTube route gives: the URL carries the `state` this server
 * just stored, and handing it to JavaScript first gives it one more place to be
 * logged or kept.
 *
 * WHAT GOES IN THAT URL, and what does not. It carries the app id (public by
 * design), the redirect URI, the scope and the opaque `state`. It does NOT carry
 * the app secret, which never leaves this process. Meta's web flow has no PKCE,
 * so there is no verifier either: the single-use, session-bound `state` is what
 * ties the callback to this session.
 *
 * WHAT THIS ROUTE IS NOT. It does not collect a Facebook or Instagram password,
 * and there is nothing here that could: the operator signs in on facebook.com in
 * their own browser. No page is driven, no DOM is touched, no selector exists.
 *
 * An unconfigured install answers 409 with the names of the variables it is
 * missing instead of redirecting to a Facebook error page.
 */
function returnTarget(req: Request): string | null {
  const here = new URL(req.url);
  const asked = here.searchParams.get("returnTo");
  if (asked) return asked;

  const referer = req.headers.get("referer");
  if (!referer) return null;
  try {
    const from = new URL(referer);
    if (from.origin !== here.origin) return null;
    return `${from.pathname}${from.search}`;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const config = serverConfig();
    if (!config) {
      const { missing } = publicConfig();
      return NextResponse.json(
        {
          error:
            "This server cannot connect to Instagram yet. Set " +
            `${missing.join(", ")} and restart it. Nothing was sent to Meta.`,
          code: "not_configured",
          missing,
        },
        { status: 409 },
      );
    }

    // App-relative only: an absolute `returnTo` would make this an open
    // redirector. `safeReturnTo` refuses one.
    const returnTo = safeReturnTo(returnTarget(req));

    const { state, stateHash } = makeState();
    // Stored BEFORE the redirect: a callback that arrives before the state row
    // exists would be rejected, and the operator would have signed in for nothing.
    await beginFlow(user.id, stateHash, state, returnTo);

    return NextResponse.redirect(authorizeUrl(config, state, SCOPE_PARAM), 303);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
