import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { beginFlow } from "@/lib/publish/youtube/accounts";
import { publicConfig, safeReturnTo, serverConfig } from "@/lib/publish/youtube/config";
import { authorizeUrl, makePkce, makeState } from "@/lib/publish/youtube/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start the Google consent, by sending the operator's browser to Google.
 *
 * A 303 REDIRECT rather than a JSON `{ url }` the client then navigates to, for
 * two reasons. The URL carries the `state` this server just stored, and handing
 * it to JavaScript first gives it one more place to be logged or kept. And a
 * redirect is what the browser does with it anyway — the extra hop would only
 * add a failure mode.
 *
 * WHAT GOES IN THAT URL, and what does not. It carries the client ID (public by
 * design), the redirect URI, the scope, the opaque `state`, and the PKCE
 * challenge. It does NOT carry the client secret, which never leaves this
 * process, and it does not carry the PKCE verifier, which is sealed in the
 * database. So the address bar, the browser history and any proxy log in
 * between see nothing that could be replayed.
 *
 * WHAT THIS ROUTE IS NOT. It does not collect a Google password, and there is
 * nothing here that could: the operator signs in on accounts.google.com, in
 * their own browser, with their own session. No page is driven, no DOM is
 * touched, no selector exists.
 *
 * An unconfigured install answers 409 with the names of the variables it is
 * missing instead of redirecting to a Google error page — the operator needs to
 * know what to set, and finding that out from Google's screen is impossible.
 */
/**
 * Where to send the operator after the round trip.
 *
 * An explicit `?returnTo=` wins, so a caller that knows can say. Otherwise the
 * `Referer` — SAME ORIGIN ONLY, and reduced to its path and query, so the
 * host, the scheme and any credentials in it are discarded before anything is
 * done with it. Whatever comes out of here still goes through `safeReturnTo`,
 * which refuses anything that is not app-relative, so neither route into this
 * function can produce an open redirect.
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
            "This server cannot connect to YouTube yet. Set " +
            `${missing.join(", ")} and restart it. Nothing was sent to Google.`,
          code: "not_configured",
          missing,
        },
        { status: 409 },
      );
    }

    // App-relative only. An absolute `returnTo` would make this an open
    // redirector, which is a phishing primitive — `safeReturnTo` refuses one.
    const returnTo = safeReturnTo(returnTarget(req));

    const { state, stateHash } = makeState();
    const pkce = makePkce();
    // Stored BEFORE the redirect: a callback that arrives before the state row
    // exists would be rejected, and the operator would have signed in for
    // nothing.
    await beginFlow(user.id, stateHash, pkce.verifier, returnTo);

    return NextResponse.redirect(authorizeUrl(config, state, pkce.challenge), 303);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
