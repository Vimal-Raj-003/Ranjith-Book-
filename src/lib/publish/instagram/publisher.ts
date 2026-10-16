/**
 * SERVER-ONLY. Instagram, behind the one `Publisher` contract, through Meta's
 * official Content Publishing API.
 *
 * THE SHAPE OF A PUBLISH, as the API defines it, and as `publish()` performs it:
 *
 *   1. read back which account the credential is for        GET  /{ig-user-id}?fields=username
 *   2. check the daily ceiling                              GET  /{ig-user-id}/content_publishing_limit
 *   3. create a Reel container from a URL                   POST /{ig-user-id}/media
 *   4. wait until Instagram has FETCHED and PROCESSED it    GET  /{container-id}?fields=status_code
 *   5. publish the container                                POST /{ig-user-id}/media_publish
 *   6. read the permalink                                   GET  /{media-id}?fields=permalink
 *
 * Step 3 hands Meta a signed, short-lived URL (`media-link.ts`) because the API
 * does not take an upload: Meta downloads the file itself. Step 5 is the one that
 * posts, and it posts PUBLICLY and at once — there is no draft or private mode on
 * this API, which is why the route that reaches this file demands an explicit
 * confirmation and the card says so in as many words.
 *
 * THE THINGS THIS FILE IS CAREFUL ABOUT, the same three the YouTube provider is:
 *
 * 1. IT CANNOT CLAIM SUCCESS. `PublishOutcome`'s PUBLISHED variant needs an
 *    `externalId`, and the only source of one here is `publishContainer`, which
 *    throws rather than return a response with no `id`. A container that does not
 *    reach FINISHED within the time allowed is a FAILED outcome that says nothing
 *    was posted; there is no path that turns "still processing" into "posted".
 *
 * 2. THE HAND-OFF NEVER GOES AWAY. `prepare` returns the SAME handoff steps the
 *    assisted provider returns in every state, and `publish` for an install that
 *    is unconfigured, unconnected, or connected to the wrong account returns
 *    REQUIRES_CONNECTION. An operator who would rather post by hand always can,
 *    and an install with no Meta app is exactly as capable as it was before.
 *
 * 3. IT IS BOUND TO ONE USER AND ONE VERIFIED ACCOUNT. The factory takes the user
 *    id, and `isConfigured()` is true only for a configured server, a stored
 *    grant, AND an account whose API-reported handle is the expected one. The
 *    handle is read back from Instagram again at step 1, immediately before
 *    anything is sent, so a stale stored label cannot authorise a post.
 */
import {
  PLATFORM_LABELS,
  PLATFORM_LIMITS,
  instagramCaption,
} from "../limits";
import {
  PublishRefused,
  type PlatformCapabilities,
  type PreparedPublish,
  type PublishHooks,
  type PublishOutcome,
  type PublishRequest,
  type PublishValidation,
  type Publisher,
} from "../contract";
import { handoffSteps, manualHandoff } from "../manual";
import { identitySentence, judgeIdentity, type ConnectionView } from "../connect";
import { expectedHandle } from "../identity";
import { DEFAULT_MEDIA_TTL_MS, isMediaLinkError, signMediaUrl } from "../media-link";
import type { EnvLike } from "../youtube/secrets";
import { ENV, publicBaseProblem } from "./config";
import { connectionFor, credentialsFor, markRevoked, noteUsername, type InstagramCredentials } from "./accounts";
import {
  DAILY_CAP,
  accountUsername,
  containerStatus,
  createReelContainer,
  isInstagramApiError,
  mediaPermalink,
  publishContainer,
  publishingLimit,
  type Fetcher,
} from "./graph";
import { mapGraphError } from "./errors";

/** Reels are shared to the feed as well: the operator posts a Reel, not a feed-hidden video. */
export const SHARE_TO_FEED = true;

/** How often the container is asked how far along it is. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** How long it is waited for. Past this the outcome is an honest FAILED, never a guess. */
export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;
/** Consecutive transient errors tolerated while waiting before the wait is abandoned. */
const MAX_POLL_ERRORS = 3;

export interface InstagramContext {
  /** Whose grant to use. Null means "nobody", which reads as not connected. */
  userId: string | null;
  env?: EnvLike;
  /** Injectable so the whole provider can be driven against a mocked API. */
  fetchImpl?: Fetcher;
  /** Injectable so a test does not wait five seconds between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the poll timeout. */
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** What `publish` reports while it works, in stages. There is no byte count on this path, so no bar. */
export interface InstagramHooks extends PublishHooks {
  onStage?: (stage: "PREPARING" | "UPLOADING") => void | Promise<void>;
}

/** Can API publishing happen right now, and if not, the sentence that says why. */
export interface InstagramGate {
  ready: boolean;
  reason: string | null;
  connection: ConnectionView;
}

export interface InstagramPublisher extends Omit<Publisher, "publish"> {
  /** `Publisher.publish`, accepting the Instagram stage hook as well. Still assignable to `Publisher`. */
  publish(prepared: PreparedPublish, hooks?: InstagramHooks): Promise<PublishOutcome>;
  /** The full verdict behind `isConfigured()`, with the reason. Also refreshes `capabilities()`. */
  gate(): Promise<InstagramGate>;
}

const IG_REQUIRES = [
  "An Instagram professional (Business or Creator) account linked to a Facebook Page",
  `A Meta app with ${ENV.appId} and ${ENV.appSecret} set on this server, and the Instagram Content Publishing permission approved through Meta App Review (or the account added as an app tester)`,
  `${ENV.publicBaseUrl} set to a PUBLIC https address, so Meta can fetch the video from it`,
  `${ENV.tokenKey} set, so the stored Page token can be encrypted at rest`,
  "A one-time Facebook sign-in that grants the Page and the Instagram permissions",
  "The connected account's @handle matching the expected one, as Instagram itself reports it",
];

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function instagramPublisher(ctx: InstagramContext): InstagramPublisher {
  const env = ctx.env ?? process.env;
  const doFetch = ctx.fetchImpl ?? fetch;
  const sleep = ctx.sleep ?? sleepFor;
  const now = ctx.now ?? Date.now;
  const platform = "instagram" as const;
  const handoff = manualHandoff(platform);

  /**
   * The last verdict `gate()` reached, so the synchronous `capabilities()` can
   * answer from it. `state.ts` asks `isConfigured()` first for exactly this
   * reason. Before any verdict exists the answer is the hand-off's: nothing is
   * claimed that has not been established.
   */
  let lastGate: InstagramGate | null = null;

  async function gate(): Promise<InstagramGate> {
    const connection = await connectionFor(ctx.userId, env);
    let reason: string | null = null;
    if (!ctx.userId) {
      reason = "No signed-in account, so there is no Instagram connection to publish with.";
    } else if (!connection.config.configured) {
      reason =
        "This server has no Instagram connection configured, so it cannot post for you. " +
        `Missing: ${connection.config.missing.join(", ")}. The video and text are ready to hand over instead.`;
    } else if (!connection.connected) {
      reason = connection.problem ?? "No Instagram account is connected for this user. Connect Instagram to publish.";
    } else if (connection.identityBlocksPublish) {
      reason = connection.identityNote ?? "Instagram has not confirmed which account this is.";
    }
    lastGate = { ready: reason === null, reason, connection };
    return lastGate;
  }

  const capabilities = (): PlatformCapabilities => {
    const base = { ...handoff.capabilities(), requires: IG_REQUIRES };
    if (lastGate?.ready !== true) return base;
    // Only now: configured, connected AND the account is the expected one.
    return {
      ...base,
      label: PLATFORM_LABELS[platform],
      canUpload: true,
      // No cover is sent: Instagram takes a frame from the video. Saying `true`
      // here would offer a control that does nothing.
      canSetThumbnail: false,
      // Not implemented; the API cannot schedule a Reel from this flow.
      canSchedule: false,
      // It reads the media id and the permalink back.
      canReportBack: true,
      limits: PLATFORM_LIMITS[platform],
    };
  };

  /**
   * The request-level checks, EXACTLY the hand-off's. They are the same checks
   * because the hand-off is offered in every state and its availability must not
   * depend on whether an API connection happens to exist. Account identity is
   * NOT part of this: a wrong or unverified account stops the API publish
   * (`gate`, `prepare`'s status, `publish`, the route) but must not remove the
   * operator's ability to post by hand.
   */
  const validate = (request: PublishRequest): PublishValidation => handoff.validate(request);

  const isConfigured = async (): Promise<boolean> => {
    try {
      return (await gate()).ready;
    } catch {
      lastGate = null;
      return false;
    }
  };

  /** What a not-ready gate becomes: the hand-off's own sentence where it fits. */
  async function refusal(prepared: PreparedPublish, g: InstagramGate): Promise<PublishOutcome> {
    if (!ctx.userId) return handoff.publish(prepared);
    return { status: "REQUIRES_CONNECTION", error: g.reason ?? "Instagram is not connected." };
  }

  /** Wait for Instagram to finish fetching and processing the container. */
  async function waitForContainer(
    containerId: string,
    token: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const interval = ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = ctx.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const started = now();
    let errors = 0;

    for (;;) {
      try {
        const status = await containerStatus(containerId, token, doFetch, env);
        errors = 0;
        if (status.state === "FINISHED") return { ok: true };
        if (status.state === "ERROR") {
          // The detail often carries a 2207xxx subcode; when it is one this
          // module knows, the specific advice is used instead of the generic.
          const sub = /\b(2207\d{3})\b/.exec(status.detail ?? "");
          const mapped = sub
            ? mapGraphError(400, { error: { code: 100, error_subcode: Number(sub[1]), message: status.detail ?? "" } }, "the video")
            : null;
          return {
            ok: false,
            message:
              mapped && mapped.code !== "invalid_request"
                ? mapped.message
                : `Instagram could not process the video${status.detail ? `: ${status.detail}` : "."} Nothing was posted.`,
          };
        }
        if (status.state === "EXPIRED") {
          return {
            ok: false,
            message: "Instagram discarded the video container before it was published (they last 24 hours). Nothing was posted. Try again.",
          };
        }
        if (status.state === "PUBLISHED") {
          return {
            ok: false,
            message:
              "Instagram reports this container as already published, but this app has no media id for it. " +
              "Check the Instagram account before trying again.",
          };
        }
      } catch (err) {
        // A transient failure while WAITING does not end the wait; a run of them
        // does, and a non-retryable one (a revoked token) does at once.
        if (!isInstagramApiError(err) || !err.failure.retryable || ++errors >= MAX_POLL_ERRORS) throw err;
      }

      if (now() - started >= timeout) {
        const minutes = Math.max(1, Math.round(timeout / 60_000));
        return {
          ok: false,
          message:
            `Instagram was still processing the video after ${minutes} minute${minutes === 1 ? "" : "s"}, so it was NOT posted. ` +
            "Nothing is live. Try again in a few minutes, or post it by hand with the hand-off.",
        };
      }
      await sleep(interval);
    }
  }

  return {
    capabilities,
    isConfigured,
    validate,
    gate,

    prepare: async (request): Promise<PreparedPublish> => {
      const verdict = validate(request);
      if (!verdict.ok) throw new PublishRefused(verdict.problems);
      const ready = await isConfigured();
      return {
        platform,
        episodeId: request.episodeId,
        metadata: request.metadata,
        video: request.video,
        poster: request.poster,
        preparedAt: new Date(),
        status: ready ? "READY" : "REQUIRES_CONNECTION",
        // ALWAYS offered, in every state. See the header comment.
        handoff: handoffSteps(platform, request),
      };
    },

    publish: async (prepared, hooks: InstagramHooks = {}): Promise<PublishOutcome> => {
      const g = await gate().catch((): InstagramGate | null => null);
      if (!g) return { status: "REQUIRES_CONNECTION", error: "Instagram's connection state could not be read." };
      if (!g.ready) return refusal(prepared, g);

      // Meta fetches the video from PUBLIC_BASE_URL, so an address it cannot
      // reach is a refusal now, not a container that fails later with an error
      // that never mentions localhost.
      const unreachable = publicBaseProblem(env);
      if (unreachable) {
        return {
          status: "REQUIRES_CONNECTION",
          error: `${unreachable} The video and text are ready to hand over instead. Nothing was sent.`,
        };
      }

      const userId = ctx.userId as string;
      let creds: InstagramCredentials;
      try {
        creds = await credentialsFor(userId, env);
      } catch (err) {
        return { status: "REQUIRES_CONNECTION", error: err instanceof Error ? err.message : "The Instagram credential could not be used." };
      }

      try {
        // 1. WHICH ACCOUNT IS THIS, ASKED OF INSTAGRAM, NOW. The stored handle was
        //    read when the operator connected; a publish cannot be taken back.
        const expected = expectedHandle(platform, env);
        const live = await accountUsername(creds.igUserId, creds.accessToken, doFetch, env);
        const sameAccount = live.id === null || live.id === creds.igUserId;
        const verdict = sameAccount ? judgeIdentity(live.username, expected) : "unverified";
        if (live.username) await noteUsername(userId, live.username);
        if (verdict !== "match") {
          return {
            status: "REQUIRES_CONNECTION",
            error: `${identitySentence("Instagram", verdict, live.username, expected) ?? "Instagram has not confirmed which account this is."} Nothing was sent.`,
          };
        }

        await hooks.onStage?.("PREPARING");

        // 2. THE DAILY CEILING. Checked before anything is created, so the refusal
        //    is "you are at the cap" and not a half-made container.
        const limit = await publishingLimit(creds.igUserId, creds.accessToken, doFetch, env);
        if (limit.used >= (limit.total > 0 ? limit.total : DAILY_CAP)) {
          return {
            status: "FAILED",
            error:
              `Instagram has already counted ${limit.used} API-published posts on this account in the last 24 hours, ` +
              `and the limit is ${limit.total}. Nothing was posted. Try again later, or post this one by hand with the hand-off.`,
          };
        }

        // 3. THE CONTAINER. Nothing is live yet.
        const videoUrl = signMediaUrl(prepared.episodeId, DEFAULT_MEDIA_TTL_MS, env, now());
        const containerId = await createReelContainer(
          creds.igUserId,
          creds.accessToken,
          { videoUrl, caption: instagramCaption(prepared.metadata), shareToFeed: SHARE_TO_FEED },
          doFetch,
          env,
        );

        // 4. WAIT FOR INSTAGRAM TO FETCH AND PROCESS IT.
        await hooks.onStage?.("UPLOADING");
        const processed = await waitForContainer(containerId, creds.accessToken);
        if (!processed.ok) return { status: "FAILED", error: processed.message };

        // 5. PUBLISH. This is the step that posts, publicly, at once.
        const mediaId = await publishContainer(creds.igUserId, creds.accessToken, containerId, doFetch, env);

        // 6. THE PERMALINK. The post is up; failing to read its link is not
        //    failing to post it.
        const permalink = await mediaPermalink(mediaId, creds.accessToken, doFetch, env).catch(() => null);

        return {
          status: "PUBLISHED",
          externalId: mediaId,
          externalUrl: permalink,
          confirmedAt: new Date(),
          reviewUrl: permalink,
        };
      } catch (err) {
        if (isInstagramApiError(err)) {
          if (err.failure.code === "reauth_required") {
            // The credential stopped working: the next action is reconnect, not retry.
            await markRevoked(userId);
            return { status: "REQUIRES_CONNECTION", error: err.failure.message };
          }
          return { status: "FAILED", error: err.failure.message };
        }
        if (isMediaLinkError(err)) {
          return { status: "REQUIRES_CONNECTION", error: `${err.message} Nothing was sent.` };
        }
        return { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
