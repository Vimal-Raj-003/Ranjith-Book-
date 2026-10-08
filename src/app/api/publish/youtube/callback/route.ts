import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { redeemState, storeGrant } from "@/lib/publish/youtube/accounts";
import { CONNECT_PARAM, CONNECT_REASON_PARAM } from "@/lib/publish/connect";
import { safeReturnTo, serverConfig } from "@/lib/publish/youtube/config";
import { YouTubeAuthError, exchangeCode, hasUploadScope } from "@/lib/publish/youtube/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Google sends the browser back, and the one place an authorisation code
 * is redeemed.
 *
 * FOUR THINGS ARE CHECKED BEFORE A CODE IS WORTH ANYTHING, and each one is a
 * different attack if it is skipped:
 *
 *  1. There is a session. An unauthenticated callback has nobody to connect.
 *  2. `state` hashes to a row THIS SERVER wrote (`redeemState`). Without it,
 *     anyone could hand this endpoint a code and have it grafted onto whichever
 *     account happened to be signed in — the textbook OAuth CSRF.
 *  3. That row belongs to this session's user. A state issued to one account
 *     cannot be redeemed into another.
 *  4. The row has not expired, and is single-use: redeeming deletes it, so a
 *     replayed callback finds nothing.
 *
 * THE EXCHANGE IS SERVER-SIDE. The code goes to Google from this process, with
 * the client secret and with the PKCE verifier that was sealed in the database.
 * Neither ever reaches the browser. The tokens that come back do not either:
 * `storeGrant` seals them, and this handler answers with a REDIRECT — it has no
 * JSON body that a token could be put into even by accident.
 *
 * THE ANSWER IS A REDIRECT BACK INTO THE APP, with a short result word in the
 * query (`?youtube=connected|denied|failed`). The reason sentence travels in
 * the URL too, and is the mapped, operator-facing message — never Google's raw
 * payload and never anything derived from a token.
 */
/**
 * Is this an error this app deliberately wrote a sentence for?
 *
 * By NAME, not `instanceof`: `lib/errors.ts` already documents why — tsx
 * evaluates a module once per graph, so two copies of `AppError` are never
 * reference-equal and an `instanceof` check silently answers false. Written
 * locally rather than imported so this route depends on nothing beyond what is
 * already committed.
 */
function isNamedAppError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && err.name === "AppError" && typeof (err as { code?: unknown }).code === "string";
}

function back(req: Request, returnTo: string | null, result: string, reason?: string) {
  const target = new URL(returnTo ?? "/", req.url);
  target.searchParams.set(CONNECT_PARAM, result);
  if (reason) target.searchParams.set(CONNECT_REASON_PARAM, reason);
  return NextResponse.redirect(target, 303);
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const user = await currentUser();
  if (!user) {
    // No session: there is nothing to attach a grant to, and this app will not
    // guess. The code is simply not redeemed.
    return back(req, "/", "failed", "Sign in, then connect YouTube again.");
  }

  // Google's own refusal path. `access_denied` is the operator declining the
  // consent screen, which is not an error — it is an answer.
  const googleError = params.get("error");
  if (googleError) {
    const denied = googleError === "access_denied";
    return back(
      req,
      null,
      denied ? "denied" : "failed",
      denied
        ? "The Google consent was declined, so nothing was connected."
        : "Google refused the authorisation, so nothing was connected.",
    );
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return back(req, null, "failed", "That callback was incomplete. Start the connection again.");
  }

  let returnTo: string | null = null;
  try {
    const redeemed = await redeemState(user.id, state);
    returnTo = safeReturnTo(redeemed.returnTo);

    const config = serverConfig();
    if (!config) {
      return back(
        req,
        returnTo,
        "failed",
        "This server's Google credentials changed while the consent was in progress. Try again.",
      );
    }

    const tokens = await exchangeCode(config, code, redeemed.verifier);
    if (!hasUploadScope(tokens.scope)) {
      // A consent that did not actually grant upload would leave the panel
      // saying "connected" and every publish failing. Refusing here is honest.
      return back(
        req,
        returnTo,
        "failed",
        "That consent did not include permission to upload, so nothing was stored. Connect again and accept the upload permission.",
      );
    }
    await storeGrant(user.id, tokens);
    return back(req, returnTo, "connected");
  } catch (err) {
    // MAPPED, OPERATOR-FACING SENTENCES ONLY, and this is an allow-list rather
    // than a fallthrough on purpose.
    //
    // An earlier draft used `err.message` for any `Error`, and a stale Prisma
    // client duly put "Cannot read properties of undefined (reading
    // 'findUnique')" into the browser's address bar. That is an internal detail
    // in a user-facing URL, which is both useless to the operator and the kind
    // of thing that leaks shapes it should not. So only an error this app
    // deliberately wrote a sentence for is shown; anything else gets the
    // generic one and stays in the server's own log.
    const reason =
      err instanceof YouTubeAuthError
        ? err.failure.message
        : isNamedAppError(err)
          ? err.message
          : "YouTube could not be connected. Check the server log, then try again.";
    return back(req, returnTo, "failed", reason);
  }
}
