/**
 * What went wrong, in words an operator can act on.
 *
 * PURE, and separate from everything that makes a request, for the reason the
 * readiness check is: "quota exceeded" and "the channel is not verified" and
 * "the token was revoked" need different actions from the operator, and the only
 * way to prove all of them are distinguished is to drive this function through
 * every payload shape without a network. `tests/publish-youtube.test.mts` does
 * exactly that.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: no failure is ever reported as "the
 * upload failed". Every branch names the thing that refused, what it means, and
 * the one next step. A message that does not do that is a bug in this file.
 *
 * NOTHING HERE QUOTES A TOKEN. The only external text that reaches a message is
 * Google's own `error.message`, trimmed and length-capped, and Google does not
 * put credentials in it. The access token lives in a header, never in a body.
 */

/** The distinct things that can go wrong, as codes a UI or a test can key off. */
export type YouTubeFailure =
  | "not_configured"
  | "not_connected"
  | "reauth_required"
  | "quota_exceeded"
  | "rate_limited"
  | "forbidden"
  | "channel_unverified"
  | "no_channel"
  | "file_too_large"
  | "invalid_metadata"
  | "upload_session_gone"
  | "network"
  | "platform_error";

export interface MappedFailure {
  code: YouTubeFailure;
  /** A whole sentence, shown verbatim to the operator. */
  message: string;
  /** True when trying again, unchanged, could plausibly work. */
  retryable: boolean;
}

/** Google's error envelope, as much of it as is worth reading. */
interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  };
  /** The token endpoint uses the OAuth 2.0 shape instead. */
  error_description?: string;
}

const CAP = 300;

/** Google's own sentence, trimmed to something that fits in a UI line. */
function detail(text: unknown): string {
  if (typeof text !== "string") return "";
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") return "";
  return one.length > CAP ? `${one.slice(0, CAP - 1)}…` : one;
}

/** Every `reason` string Google put in the payload, lowercased. */
function reasons(body: GoogleErrorBody | null): string[] {
  const list = body?.error?.errors ?? [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item?.reason === "string") out.push(item.reason.toLowerCase());
  }
  if (typeof body?.error?.status === "string") out.push(body.error.status.toLowerCase());
  return out;
}

/** The OAuth 2.0 token-endpoint shape, which is NOT the Google API shape. */
export function mapTokenError(status: number, raw: unknown): MappedFailure {
  const body = (raw ?? null) as ({ error?: unknown; error_description?: string } | null);
  const oauthError = typeof body?.error === "string" ? body.error.toLowerCase() : "";
  const because = detail(body?.error_description);
  const tail = because ? ` Google said: ${because}` : "";

  if (oauthError === "invalid_grant") {
    return {
      code: "reauth_required",
      message:
        "YouTube no longer accepts this connection — the permission was withdrawn, " +
        "the Google password changed, or the grant expired after a long idle period. " +
        `Disconnect and connect YouTube again.${tail}`,
      retryable: false,
    };
  }
  if (oauthError === "invalid_client" || status === 401) {
    return {
      code: "not_configured",
      message:
        "Google rejected this app's own credentials. Check GOOGLE_CLIENT_ID and " +
        `GOOGLE_CLIENT_SECRET against the OAuth client in the Cloud console.${tail}`,
      retryable: false,
    };
  }
  if (oauthError === "redirect_uri_mismatch") {
    return {
      code: "not_configured",
      message:
        "Google refused the redirect address. GOOGLE_OAUTH_REDIRECT_URI must match an " +
        `Authorised redirect URI on the OAuth client exactly, character for character.${tail}`,
      retryable: false,
    };
  }
  if (oauthError === "access_denied") {
    return {
      code: "not_connected",
      message: "The Google consent screen was declined, so nothing was connected.",
      retryable: false,
    };
  }
  return {
    code: "platform_error",
    message: `Google's sign-in service refused this exchange (HTTP ${status}).${tail}`,
    retryable: status >= 500,
  };
}

/**
 * The YouTube Data API shape.
 *
 * `where` names the call ("the upload", "the thumbnail"), because the same HTTP
 * 403 means different things on the two and the operator needs to know which
 * one stopped.
 */
export function mapApiError(status: number, raw: unknown, where = "YouTube"): MappedFailure {
  const body = (raw ?? null) as GoogleErrorBody | null;
  const why = reasons(body);
  const because = detail(body?.error?.message);
  const tail = because ? ` YouTube said: ${because}` : "";
  const has = (...names: string[]) => names.some((n) => why.includes(n));

  if (has("quotaexceeded", "dailylimitexceeded")) {
    return {
      code: "quota_exceeded",
      message:
        "This Google Cloud project has used its YouTube API quota for the day. An upload " +
        "costs about 1,600 of the default 10,000 units, so roughly six a day. The quota " +
        `resets at midnight Pacific time, or request more in the Cloud console.${tail}`,
      retryable: false,
    };
  }
  if (has("userratelimitexceeded", "ratelimitexceeded", "resource_exhausted") || status === 429) {
    return {
      code: "rate_limited",
      message: `YouTube is rate-limiting this account. Wait a minute and try again.${tail}`,
      retryable: true,
    };
  }
  if (has("authenticationrequired", "unauthorized", "unauthenticated") || status === 401) {
    return {
      code: "reauth_required",
      message:
        "YouTube rejected the stored credential. Disconnect and connect YouTube again — " +
        `the permission may have been withdrawn in the Google account.${tail}`,
      retryable: false,
    };
  }
  if (has("youtubesignuprequired", "channelnotfound")) {
    return {
      code: "no_channel",
      message:
        "The connected Google account has no YouTube channel, so there is nothing to upload to. " +
        `Create a channel on that account, then connect again.${tail}`,
      retryable: false,
    };
  }
  if (has("uploadlimitexceeded")) {
    return {
      code: "forbidden",
      message:
        "This channel has hit its upload limit for now. YouTube applies one to new and " +
        `unverified channels; it lifts on its own.${tail}`,
      retryable: true,
    };
  }
  if (has("videoneedsverifiedaccount", "unverifiedaccount", "thumbnailsizetoobig", "invalidimage", "mediabodyrequired")) {
    // The thumbnail-specific family. The commonest by far is the first: a custom
    // thumbnail requires a phone-verified channel, and nothing this app can do
    // changes that.
    if (has("thumbnailsizetoobig", "invalidimage", "mediabodyrequired")) {
      return {
        code: "invalid_metadata",
        message: `YouTube refused the thumbnail image itself (${where}).${tail}`,
        retryable: false,
      };
    }
    return {
      code: "channel_unverified",
      message:
        "YouTube allows a custom thumbnail only on a verified channel. Verify the channel at " +
        "youtube.com/verify, then set the thumbnail in Studio. The video itself was not affected.",
      retryable: false,
    };
  }
  if (has("forbidden", "permission_denied", "insufficientpermissions", "insufficient_permissions") || status === 403) {
    return {
      code: "forbidden",
      message:
        `YouTube refused this ${where} as not permitted for the connected account. ` +
        "If the connection predates a change to what this app asks for, disconnect and " +
        `connect again.${tail}`,
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      code: "upload_session_gone",
      message:
        "The upload this app was resuming no longer exists at YouTube — a resumable session " +
        `is kept for about a week. Try again to start a fresh upload.${tail}`,
      retryable: true,
    };
  }
  if (status === 413) {
    return {
      code: "file_too_large",
      message:
        "YouTube refused the file as too large. The ceiling is 256 GB or 12 hours, so a " +
        `rendered short hitting it means the render is wrong — check the file before retrying.${tail}`,
      retryable: false,
    };
  }
  if (has("invalidvideometadata", "invalid_argument", "badrequest", "invalid") || status === 400) {
    return {
      code: "invalid_metadata",
      message: `YouTube refused the metadata for this video.${tail}`,
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      code: "platform_error",
      message: `YouTube answered with a server error (HTTP ${status}). This usually clears on its own.${tail}`,
      retryable: true,
    };
  }
  return {
    code: "platform_error",
    message: `YouTube refused this ${where} (HTTP ${status}).${tail}`,
    retryable: status >= 500,
  };
}

/**
 * A request that never reached Google.
 *
 * Distinguished from a refusal because the actions differ: a refusal is about
 * the account or the file, and this is about the connection — and because an
 * upload that died mid-transfer can be RESUMED, which is the one thing the
 * operator most needs to know here.
 */
export function mapTransportError(err: unknown, sentBytes: number | null = null): MappedFailure {
  const text = err instanceof Error ? err.message : String(err);
  const progress =
    sentBytes !== null && sentBytes > 0
      ? ` ${Math.round(sentBytes / 1_048_576)} MB had been accepted, and a retry resumes from there rather than starting over.`
      : "";
  return {
    code: "network",
    message: `The connection to YouTube was lost before it answered (${detail(text) || "no detail"}).${progress}`,
    retryable: true,
  };
}

/** A file this app will not even offer to YouTube. */
export function mapLocalRefusal(code: "file_too_large" | "invalid_metadata", message: string): MappedFailure {
  return { code, message, retryable: false };
}
