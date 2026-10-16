/**
 * What went wrong at Meta, in words an operator can act on.
 *
 * PURE, and separate from everything that makes a request, for the reason
 * `youtube/errors.ts` is: "your token expired", "you hit the daily cap" and
 * "Meta could not fetch the video" need different actions, and the only way to
 * prove they are distinguished is to drive this function through every payload
 * shape without a network. `tests/publish-instagram.test.mts` does exactly that.
 *
 * THE RULE: no failure is ever reported as "publishing failed". Every branch
 * names the thing that refused and the one next step, and says whether trying
 * again, unchanged, could work.
 *
 * Meta's error envelope is `{ error: { message, type, code, error_subcode,
 * fbtrace_id, error_user_title, error_user_msg } }`. The ones that matter:
 *
 *   190            the access token is invalid or was revoked (subcodes 458, 460,
 *                  463, 467 are the flavours of it) -> RECONNECT, not retry;
 *   10, 200-299    a permission is missing or was withdrawn -> fatal;
 *   400 (HTTP)     the request itself is wrong -> fatal;
 *   4, 17, 32, 613, 80002
 *                  rate limits -> retryable, later;
 *   1, 2           Meta-side and transient -> retryable.
 *
 * NOTHING HERE QUOTES A TOKEN. The only external text that reaches a message is
 * Meta's own `error.message`, trimmed and length-capped, and Meta does not put
 * credentials in it. The access token travels in a body or a query string this
 * module never sees.
 */

export type InstagramFailure =
  | "not_configured"
  | "not_connected"
  | "reauth_required"
  | "rate_limited"
  | "daily_cap"
  | "forbidden"
  | "invalid_request"
  | "media_unreachable"
  | "media_unsupported"
  | "media_not_ready"
  | "no_instagram_account"
  | "platform_error"
  | "network"
  | "container_error"
  | "container_timeout";

export interface MappedFailure {
  code: InstagramFailure;
  /** A whole sentence, shown verbatim to the operator. */
  message: string;
  /** True when trying again, unchanged, could plausibly work. */
  retryable: boolean;
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
  };
}

const CAP = 300;

/** Meta's own sentence, trimmed to something that fits in a UI line. */
function detail(text: unknown): string {
  if (typeof text !== "string") return "";
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") return "";
  return one.length > CAP ? `${one.slice(0, CAP - 1)}…` : one;
}

const RATE_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
/** Code 10, and the whole 200-299 block Meta reserves for permission errors. */
const isPermissionCode = (code: number): boolean => code === 10 || (code >= 200 && code <= 299);

/**
 * The Graph API shape.
 *
 * `where` names the call ("the media container", "the publish"), because the
 * same HTTP 400 means different things on the two.
 */
export function mapGraphError(status: number, raw: unknown, where = "the request"): MappedFailure {
  const body = (raw ?? null) as GraphErrorBody | null;
  const code = typeof body?.error?.code === "number" ? body.error.code : null;
  const sub = typeof body?.error?.error_subcode === "number" ? body.error.error_subcode : null;
  const because = detail(body?.error?.error_user_msg) || detail(body?.error?.message);
  const tail = because ? ` Meta said: ${because}` : "";

  // The session is gone: an expired, revoked or invalidated token. The action is
  // to reconnect, and retrying the same request cannot help.
  if (code === 190 || status === 401) {
    return {
      code: "reauth_required",
      message:
        "Instagram rejected the stored permission — it expired, was revoked, or the Facebook password was changed. " +
        `Disconnect and connect Instagram again.${tail}`,
      retryable: false,
    };
  }

  // Specific media failures first: they arrive as code 100 / 9004 / 2207xxx and
  // would otherwise all be read as the generic "invalid request".
  if (sub === 2207003 || sub === 2207032 || sub === 2207001) {
    return {
      code: "media_unreachable",
      message:
        `Instagram could not fetch the video from this server (${where}). It downloads the file itself, from ` +
        `PUBLIC_BASE_URL, so that address must be reachable from the internet over https. Check it, then try again.${tail}`,
      retryable: true,
    };
  }
  if (sub === 2207026 || sub === 2207023) {
    return {
      code: "media_unsupported",
      message:
        `Instagram does not accept this video's format (${where}). Reels need an MP4 or MOV with H.264 video and ` +
        `AAC audio, 9:16, within the length limit.${tail}`,
      retryable: false,
    };
  }
  if (sub === 2207027) {
    return {
      code: "media_not_ready",
      message: `Instagram is still processing the video, so it cannot be published yet. Wait a minute and try again.${tail}`,
      retryable: true,
    };
  }
  if (sub === 2207042) {
    return {
      code: "daily_cap",
      message:
        "This Instagram account has reached the daily limit on API-published posts (25 in 24 hours). " +
        `Try again tomorrow, or post this one by hand with the hand-off.${tail}`,
      retryable: false,
    };
  }

  if (code !== null && RATE_CODES.has(code)) {
    return {
      code: "rate_limited",
      message: `Meta is rate-limiting this app or account. Wait a few minutes and try again.${tail}`,
      retryable: true,
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: `Meta is rate-limiting this app or account. Wait a few minutes and try again.${tail}`,
      retryable: true,
    };
  }

  // 10 and the 200s: a permission the app needs is missing or was withdrawn.
  if (code !== null && isPermissionCode(code)) {
    return {
      code: "forbidden",
      message:
        `Meta refused ${where} as not permitted for the connected account. The app needs ` +
        "instagram_content_publish (and Meta's App Review approval for it, unless the account is a tester). " +
        `Reconnect and accept every permission.${tail}`,
      retryable: false,
    };
  }
  if (code === 368) {
    return {
      code: "forbidden",
      message: `Meta has temporarily blocked this action for the account (it looked like spam).${tail}`,
      retryable: false,
    };
  }

  if (code === 1 || code === 2 || status >= 500) {
    return {
      code: "platform_error",
      message: `Meta answered with a server error${status ? ` (HTTP ${status})` : ""}. This usually clears on its own.${tail}`,
      retryable: true,
    };
  }

  // 400 and anything else: the request itself was refused. Fatal.
  if (code === 100 || status === 400) {
    return {
      code: "invalid_request",
      message: `Meta refused ${where} as invalid, so retrying it unchanged will not help.${tail}`,
      retryable: false,
    };
  }
  return {
    code: "platform_error",
    message: `Meta refused ${where} (HTTP ${status}).${tail}`,
    retryable: false,
  };
}

/**
 * A request that never reached Meta.
 *
 * `afterSend` is true when the failure happened on the call that publishes. That
 * one is special: the request may have been received and acted on before the
 * connection dropped, so "try again" could post the Reel twice. It is reported
 * as NOT retryable, and the message tells the operator to look at the account
 * first.
 */
export function mapTransportError(err: unknown, afterSend = false): MappedFailure {
  const text = detail(err instanceof Error ? err.message : String(err));
  if (afterSend) {
    return {
      code: "network",
      message:
        `The connection to Meta was lost while publishing (${text || "no detail"}). The Reel may or may not have been ` +
        "posted: check the Instagram account before trying again, so it is not posted twice.",
      retryable: false,
    };
  }
  return {
    code: "network",
    message: `The connection to Meta was lost before it answered (${text || "no detail"}). Nothing was posted. Try again.`,
    retryable: true,
  };
}
