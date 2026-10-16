import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import {
  INSTAGRAM_CONNECT_PARAM,
  INSTAGRAM_CONNECT_REASON_PARAM,
  identityCopy,
  judgeIdentity,
} from "@/lib/publish/connect";
import { expectedHandle } from "@/lib/publish/identity";
import { exchangeCode, redeemState, storeGrant } from "@/lib/publish/instagram/accounts";
import { serverConfig } from "@/lib/publish/instagram/config";
import { isInstagramApiError } from "@/lib/publish/instagram/graph";
import { safeReturnTo } from "@/lib/publish/youtube/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Facebook sends the browser back, and the one place an authorisation code
 * is redeemed.
 *
 * FOUR THINGS ARE CHECKED BEFORE A CODE IS WORTH ANYTHING, each a different
 * attack if skipped (see `redeemState`): there is a session; `state` hashes to a
 * row THIS SERVER wrote (the textbook OAuth CSRF otherwise); that row belongs to
 * this session's user AND to this provider; and it has not expired and is
 * single-use.
 *
 * THE EXCHANGE IS SERVER-SIDE. The code goes to Meta from this process, with the
 * app secret. The tokens that come back never reach the browser: `storeGrant`
 * seals them, and this handler answers with a REDIRECT -- it has no JSON body a
 * token could be put into even by accident.
 *
 * THE ANSWER IS A REDIRECT BACK INTO THE APP with a short result word in the
 * query (`?instagram=connected|denied|failed`) and, where there is one, a reason
 * sentence that is the mapped, operator-facing message -- never Meta's raw
 * payload and never anything derived from a token.
 *
 * A connected account whose API-reported handle is not the expected one is still
 * stored (so the card can say which account it is and offer Disconnect) and is
 * reported in the reason; publishing to it is blocked by
 * `identityBlocksPublish`.
 */

/**
 * Is this an error this app deliberately wrote a sentence for?
 *
 * By NAME, not `instanceof`: `lib/errors.ts` documents why. Written locally so
 * this route depends on nothing beyond what is already committed.
 */
function isNamedAppError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && err.name === "AppError" && typeof (err as { code?: unknown }).code === "string";
}

function back(req: Request, returnTo: string | null, result: string, reason?: string) {
  const target = new URL(returnTo ?? "/", req.url);
  target.searchParams.set(INSTAGRAM_CONNECT_PARAM, result);
  if (reason) target.searchParams.set(INSTAGRAM_CONNECT_REASON_PARAM, reason);
  return NextResponse.redirect(target, 303);
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const user = await currentUser();
  if (!user) {
    // No session: there is nothing to attach a grant to, and this app will not guess.
    return back(req, "/", "failed", "Sign in, then connect Instagram again.");
  }

  // Facebook's own refusal path. Declining the dialog is an answer, not an error.
  const refusal = params.get("error");
  if (refusal) {
    const denied = refusal === "access_denied";
    return back(
      req,
      null,
      denied ? "denied" : "failed",
      denied
        ? "The Facebook consent was declined, so nothing was connected."
        : "Facebook refused the authorisation, so nothing was connected.",
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
        "This server's Meta credentials changed while the consent was in progress. Try again.",
      );
    }

    const grant = await exchangeCode(config, code);
    await storeGrant(user.id, grant);

    // The handle in the grant is the one INSTAGRAM returned for the account that
    // was just connected. A wrong account is stored and reported, not hidden.
    const expected = expectedHandle("instagram");
    if (judgeIdentity(grant.username, expected) !== "match") {
      return back(
        req,
        returnTo,
        "connected",
        identityCopy.connectedWrongAccount(`@${grant.username.replace(/^@/, "")}`, expected),
      );
    }
    return back(req, returnTo, "connected");
  } catch (err) {
    // MAPPED, OPERATOR-FACING SENTENCES ONLY, an allow-list rather than a
    // fallthrough: a raw `err.message` once put a Prisma TypeError into the
    // browser's address bar on the YouTube flow.
    const reason = isInstagramApiError(err)
      ? err.failure.message
      : isNamedAppError(err)
        ? err.message
        : "Instagram could not be connected. Check the server log, then try again.";
    return back(req, returnTo, "failed", reason);
  }
}
