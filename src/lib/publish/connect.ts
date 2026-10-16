/**
 * The wire shape of a platform connection, and the words the UI says about it.
 *
 * IT HAS NO IMPORTS, and must keep it that way, for the same reason `limits.ts`
 * has none: `PublishCenter` and the connection card are `"use client"`
 * components and load this in the browser, so anything pulled in here lands in
 * the browser bundle. `tests/publish-youtube.test.mts` holds it to that, and
 * `tests/client-ui.test.mts` lists it as one of the handful of modules a
 * component may import.
 *
 * It is also the reason no secret can reach the browser through this route:
 * `ConnectionView` HAS NO TOKEN FIELD. Not a real one and not a redacted one.
 * `GET /api/publish/youtube` answers with this type, and
 * `src/lib/publish/youtube/accounts.ts` annotates its own return value with it,
 * so the compiler is what stops a credential being added to the payload — not a
 * reviewer noticing.
 *
 * The copy lives here rather than in `strings.ts` because this module is a leaf
 * the server also reads (the route builds `missing` from the same names), and
 * because the connection vocabulary is meaningless away from the type it
 * describes.
 */

/** What this install is missing before it can connect at all. Names, never values. */
export interface ConfigView {
  configured: boolean;
  /** Environment variable NAMES. Never a value, not even a prefix. */
  missing: string[];
  /** Why the token store is unusable. Names the variable; quotes nothing. */
  keyProblem: string | null;
}

/**
 * One user's connection to one platform, as the browser is allowed to see it.
 *
 * Every field here is either a verdict, a public identifier the platform itself
 * published, or a sentence for the operator. There is deliberately nothing on
 * it that could be replayed.
 */
export interface ConnectionView {
  config: ConfigView;
  connected: boolean;
  /**
   * The account, as the PLATFORM reported it. Null until it has.
   *
   * YouTube: the channel id and its title or @handle. Instagram: the Business
   * account id and its `@username`.
   */
  channelId: string | null;
  channelTitle: string | null;
  connectedAt: string | null;
  /** The scopes granted, so the operator can see what they agreed to. */
  scopes: string[];
  /** Set when a grant is stored but unusable, with the reason and the fix. */
  problem: string | null;

  /**
   * WHICH ACCOUNT IS THIS, ACCORDING TO THE PLATFORM'S OWN API.
   *
   * `verifiedHandle` is only ever the `@handle` a platform API returned for the
   * stored credential (YouTube `channels.list?mine=true`, Instagram
   * `instagram_business_account.username`). It is NEVER a label an operator
   * typed or a title that came back from an upload: a channel can be named
   * "@between_pages" by anyone, and a display label is not an identity.
   */
  verifiedHandle: string | null;
  /** The handle this install is meant to publish to, from the environment. */
  expectedHandle: string;
  identity: IdentityVerdict;
  /** A whole sentence explaining the verdict. Null on a match. */
  identityNote: string | null;
  /**
   * True when the identity verdict must stop an API publish. A `mismatch`
   * always blocks. `unverified` blocks too, except for a YouTube connection
   * that predates the identity scope: it keeps the upload ability it was
   * granted and is shown a reconnect-to-verify warning instead.
   */
  identityBlocksPublish: boolean;
}

/**
 * The three answers to "is this the account we mean to publish to".
 *
 *  - `match`      the platform's API named exactly the expected handle;
 *  - `mismatch`   the platform's API named a DIFFERENT handle;
 *  - `unverified` the platform's API has not named one (never asked, the scope
 *                 was not granted, or the call failed).
 */
export const IDENTITY_VERDICTS = ["match", "mismatch", "unverified"] as const;
export type IdentityVerdict = (typeof IDENTITY_VERDICTS)[number];

/** Lowercase, `@` stripped, trimmed: the form two handles are compared in. */
export function normaliseHandle(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** `betweenpages08-l4d` or `@betweenpages08-l4d` → `@betweenpages08-l4d`. Empty stays empty. */
export function displayHandle(raw: string | null | undefined): string {
  const bare = typeof raw === "string" ? raw.trim().replace(/^@+/, "").trim() : "";
  return bare === "" ? "" : `@${bare}`;
}

/**
 * Compare what the platform said with what we expect.
 *
 * `verified` must be the handle the platform's API returned. A null or blank
 * `verified` is `unverified`, never a match — and a blank `expected` cannot
 * match anything either, so an install whose expected handle was blanked out
 * fails closed instead of treating every account as the right one.
 */
export function judgeIdentity(verified: string | null | undefined, expected: string): IdentityVerdict {
  const have = normaliseHandle(verified);
  const want = normaliseHandle(expected);
  if (have === "") return "unverified";
  if (want === "") return "mismatch";
  return have === want ? "match" : "mismatch";
}

/** The sentence for a verdict, so the server and the card say the same thing. */
export function identitySentence(
  platform: string,
  verdict: IdentityVerdict,
  verified: string | null,
  expected: string,
  options: { legacy?: boolean } = {},
): string | null {
  if (verdict === "match") return null;
  const want = displayHandle(expected);
  if (verdict === "mismatch") {
    return (
      `Wrong ${platform} account. ${platform} reports this connection as ${displayHandle(verified)}, ` +
      `but this install is set up to publish to ${want}. Publishing is blocked. ` +
      "Disconnect, then connect the right account."
    );
  }
  if (options.legacy) {
    return (
      `This ${platform} connection predates account verification, so it cannot be checked against ${want}. ` +
      "Reconnect to verify which account it is."
    );
  }
  return (
    `${platform} has not confirmed which account this is, so it cannot be checked against ${want}. ` +
    "Publishing is blocked until it can. Reconnect to verify."
  );
}

/** The result the OAuth callback reports back through the URL. */
export const CONNECT_RESULTS = ["connected", "denied", "failed"] as const;
export type ConnectResult = (typeof CONNECT_RESULTS)[number];

export function isConnectResult(v: unknown): v is ConnectResult {
  return typeof v === "string" && (CONNECT_RESULTS as readonly string[]).includes(v);
}

/** The query parameter the callback appends, named once so both sides agree. */
export const CONNECT_PARAM = "youtube";
/** Where a reason sentence is carried back, when there is one. */
export const CONNECT_REASON_PARAM = "youtube_reason";

export const connectCopy = {
  heading: "Connection",
  /** The three states, as a sentence each. */
  notConfigured:
    "This server has no Google credentials, so it cannot post to YouTube. Everything below still works by hand.",
  missingLabel: "Set on the server, then restart it:",
  notConnected:
    "This server can connect to YouTube, but no channel has authorised it yet. Connecting opens Google's own sign-in — this app never sees your password.",
  connectedTo: (channel: string | null) =>
    channel ? `Connected to ${channel}.` : "Connected. The channel name appears after the first upload.",
  grantedLabel: "Granted",
  since: (when: string) => `Authorised ${when}`,

  connect: "Connect YouTube",
  connecting: "Opening Google…",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  reconnect: "Reconnect YouTube",

  /** What Connect is about to do, said before it is pressed. */
  consentNote:
    "You will sign in at accounts.google.com and grant permission to upload. This app stores only the permission Google returns, encrypted, on this server.",
  disconnectNote:
    "Disconnect asks Google to revoke the permission, then deletes it from this server.",
  disconnected: "YouTube disconnected.",
  revokeFailed: (why: string) =>
    `The permission was deleted from this server, but Google did not confirm the revoke: ${why} Remove it yourself at myaccount.google.com/permissions.`,

  /** The publish action. */
  publish: "Upload to YouTube as private",
  publishing: "Starting…",
  publishNote:
    "Uploads as PRIVATE, every time. Nothing here can make a video public — you do that in YouTube Studio once you have watched it.",
  notOwned:
    "This episode has no owner on this install, so it cannot be uploaded to a platform from this account. The handoff below still works.",
  uploadStarted: "Upload started.",
  uploadFailed: "The upload could not be started.",

  /** Progress, from measured bytes only. */
  progressLabel: "Uploaded",
  progressValue: (sent: number, total: number) =>
    `${(sent / 1_048_576).toFixed(1)} of ${(total / 1_048_576).toFixed(1)} MB`,
  progressUnknown: "YouTube has not reported a byte count yet.",

  /** After a confirmed upload. */
  reviewHeading: "Finish it in YouTube Studio",
  openStudio: "Open in YouTube Studio",
  privacyLabel: "Privacy",
  videoIdLabel: "Video id",
  thumbnailLabel: "Thumbnail",
  thumbnailApplied: "Applied",
  thumbnailSkipped: "Not attempted",
  thumbnailFailed: "Not applied",
  reviewNote:
    "The video is on the channel and private. Watch it, set the thumbnail if it was not applied, answer YouTube's audience question, and publish it there.",

  /** The callback's own outcomes. */
  resultConnected: "YouTube connected.",
  resultDenied: "The Google consent was declined, so nothing was connected.",
  resultFailed: "YouTube could not be connected.",
} as const;

/**
 * The words the identity block says, on either platform's card.
 *
 * Kept apart from `connectCopy` so the Instagram card does not have to borrow a
 * YouTube-shaped string, and so neither card can say "verified" in a state the
 * verdict did not earn it: every line below is selected by `identity`.
 */
export const identityCopy = {
  heading: "Account check",
  verifiedLabel: "Verified account",
  expectedLabel: "Expected account",
  verifiedBy: (platform: string) => `Reported by ${platform}'s API, not typed in.`,
  notVerified: "Not verified",
  match: (platform: string, handle: string) =>
    `Verified: ${platform} reports this connection as ${handle}, which is the expected account.`,
  blockedHeading: "Publishing is blocked",
  publishBlocked:
    "Publishing through the API is blocked until the connected account is the expected one. The hand-off below still works.",
  /** After the OAuth callback, when the account connected is not the expected one. */
  connectedWrongAccount: (verified: string, expected: string) =>
    `Connected, but this is ${verified} and this install publishes to ${expected}. Publishing is blocked.`,
} as const;

/** The query parameter the Instagram callback appends, named once so both sides agree. */
export const INSTAGRAM_CONNECT_PARAM = "instagram";
/** Where an Instagram reason sentence is carried back, when there is one. */
export const INSTAGRAM_CONNECT_REASON_PARAM = "instagram_reason";

export const instagramCopy = {
  notConfigured:
    "This server has no Meta app credentials, so it cannot post to Instagram through the official API. The hand-off below still works.",
  missingLabel: "Set on the server, then restart it:",
  notConnected:
    "This server can connect to Instagram, but no account has authorised it yet. Connecting opens Facebook's own sign-in — this app never sees your password.",
  connectedTo: (handle: string | null) =>
    handle ? `Connected to ${handle}.` : "Connected. The account name has not been reported yet.",
  grantedLabel: "Granted",
  since: (when: string) => `Authorised ${when}`,

  connect: "Connect Instagram",
  reconnect: "Reconnect Instagram",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  consentNote:
    "You will sign in at facebook.com and grant access to the Facebook Page linked to your Instagram professional account. This app stores only the Page permission Meta returns, encrypted, on this server.",
  disconnectNote:
    "Disconnect asks Meta to revoke the permission, then deletes it from this server.",
  disconnected: "Instagram disconnected.",
  revokeFailed: (why: string) =>
    `The permission was deleted from this server, but Meta did not confirm the revoke: ${why} Remove it yourself under Facebook Settings, Business Integrations.`,

  /** The publish action. Instagram has no draft: this posts at once, in public. */
  publish: "Publish Reel to Instagram now",
  publishing: "Starting…",
  confirmPrompt:
    "Instagram's API cannot save a draft or post privately. This posts the Reel on the account at once, in public.",
  confirmYes: "Yes, publish publicly now",
  confirmNo: "Cancel",
  publishNote:
    "Posts immediately and publicly. The API has no review step, so check the caption and the video here first.",
  notOwned:
    "This episode has no owner on this install, so it cannot be posted to a platform from this account. The hand-off below still works.",
  publishStarted: "Publishing started.",
  publishFailed: "The publish could not be started.",

  /** While it runs. No byte count exists on this path, so there is no bar. */
  preparing: "Checking the publishing quota and sending Instagram the video link…",
  processing:
    "Instagram is fetching and processing the video. This can take a few minutes. Nothing is posted until it finishes.",

  resultConnected: "Instagram connected.",
  resultDenied: "The Facebook consent was declined, so nothing was connected.",
  resultFailed: "Instagram could not be connected.",
} as const;
