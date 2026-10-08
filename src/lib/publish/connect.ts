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
  /** The channel, as the PLATFORM reported it. Null until it has. */
  channelId: string | null;
  channelTitle: string | null;
  connectedAt: string | null;
  /** The scopes granted, so the operator can see what they agreed to. */
  scopes: string[];
  /** Set when a grant is stored but unusable, with the reason and the fix. */
  problem: string | null;
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
