/**
 * SERVER-ONLY. YouTube, behind the one `Publisher` contract.
 *
 * Nothing above this file knows that YouTube has a resumable protocol, a
 * 500-character tag budget or a verified-channel rule for thumbnails. The
 * routes call `prepare` and `publish`; the Publish Center renders capabilities,
 * statuses and handoff steps that arrived as JSON. That was the promise
 * `contract.ts` was written to keep, and this is the first provider to test it:
 * the only change outside this folder is one entry in `registry.ts`, plus the
 * connection UI (which is about an OAuth grant, not about publishing) and the
 * progress fields the job now records.
 *
 * THE THREE THINGS THIS FILE IS CAREFUL ABOUT:
 *
 * 1. IT CANNOT CLAIM SUCCESS. `PublishOutcome`'s PUBLISHED variant needs an
 *    `externalId`, and the only source of one here is `uploadVideo`, which
 *    throws rather than returning a resource with no `id`. There is no literal
 *    `status: "PUBLISHED"` in this file that is not immediately beside a
 *    `result.videoId` the platform sent.
 *
 * 2. THE FALLBACK NEVER GOES AWAY. `prepare` returns the SAME handoff steps the
 *    assisted provider returns, in every state — unconfigured, configured but
 *    not connected, and fully connected. An operator who would rather do it by
 *    hand always can, and an install with no Google project is exactly as
 *    capable as it was before this file existed. `status` is `READY` only when
 *    there is a usable grant; otherwise `REQUIRES_CONNECTION`, which is what
 *    makes the Publish button absent rather than broken.
 *
 * 3. IT IS BOUND TO ONE USER. The factory takes the user id, and
 *    `isConfigured()` is false without one. A publisher with no user cannot
 *    reach a token, so a caller that forgot to pass one gets
 *    REQUIRES_CONNECTION rather than somebody else's channel.
 */
import {
  PLATFORM_LABELS,
  PLATFORM_LIMITS,
  normaliseHashtags,
  variantProblems,
} from "../limits";
import { PublishRefused, type PublishHooks } from "../contract";
import type {
  PlatformCapabilities,
  PreparedPublish,
  PublishOutcome,
  PublishRequest,
  PublishValidation,
  Publisher,
} from "../contract";
import { handoffSteps } from "../manual";
import { ENV, publicConfig, studioUrlFor, watchUrlFor } from "./config";
import type { EnvLike } from "./secrets";
import { YouTubeNotConnected, accessTokenFor, isConnected, noteChannel } from "./accounts";
import { TAGS_MAX_CHARS, YouTubeApiError, setThumbnail, uploadVideo } from "./upload";
import type { Fetcher } from "./oauth";

/**
 * YouTube's own ceiling on the file, for completeness. A rendered vertical
 * short is four orders of magnitude under it; the check exists so that if a
 * render ever goes catastrophically wrong, the refusal names the real reason
 * instead of being a 413 from Google half a minute into an upload.
 */
export const VIDEO_MAX_BYTES = 256 * 1024 * 1024 * 1024;

/**
 * The category the video is filed under.
 *
 * YouTube requires one, and there is no honest way to derive it from a book
 * summary, so it is a documented default the operator can change with one
 * environment variable rather than a value buried in a request body. 27 is
 * "Education"; 22 is "People & Blogs" if that fits the channel better.
 */
export const DEFAULT_CATEGORY_ID = "27";

export function categoryId(env: EnvLike = process.env): string {
  const raw = (env.YOUTUBE_CATEGORY_ID ?? "").trim();
  return /^\d{1,3}$/.test(raw) ? raw : DEFAULT_CATEGORY_ID;
}

export interface YouTubeContext {
  /** Whose grant to use. Null means "nobody", which reads as not connected. */
  userId: string | null;
  env?: EnvLike;
  /** Injectable so the whole provider can be driven against a mocked API. */
  fetchImpl?: Fetcher;
}

/** `#deep-work` → `deep-work`: `snippet.tags` are words, not hashtags. */
export function tagsFrom(hashtags: string[]): string[] {
  return normaliseHashtags(hashtags).map((t) => t.replace(/^#/, ""));
}

/** How many characters YouTube counts against the 500-character tag budget. */
export function tagsLength(tags: string[]): number {
  // YouTube counts the quoting a tag containing a space needs, so a tag with a
  // space costs two more. Counting it the strict way means this app refuses
  // slightly earlier than YouTube would, never later.
  return tags.reduce((sum, t) => sum + [...t].length + (t.includes(" ") ? 3 : 1), 0);
}

export function youTubePublisher(ctx: YouTubeContext): Publisher {
  const env = ctx.env ?? process.env;
  const doFetch = ctx.fetchImpl ?? fetch;
  const platform = "youtube" as const;

  const capabilities = (): PlatformCapabilities => ({
    id: platform,
    label: PLATFORM_LABELS[platform],
    // It genuinely can, when connected. `isConfigured()` is the separate
    // question of whether THIS install can right now — the distinction
    // `contract.ts` insists on, and the reason a REQUIRES_CONNECTION row does
    // not show a Publish button.
    canUpload: true,
    canSetThumbnail: true,
    // Not implemented, and so stated as false. YouTube's API can schedule
    // (`status.publishAt`), but this app uploads as private for the operator to
    // review, and a scheduler that publishes unreviewed video is the opposite
    // of that. Saying `true` here would offer a control that does nothing.
    canSchedule: false,
    // It reports the video id and the privacy the platform recorded.
    canReportBack: true,
    limits: PLATFORM_LIMITS[platform],
    requires: [
      "A Google Cloud project with the YouTube Data API v3 enabled",
      `An OAuth client, with ${ENV.clientId} and ${ENV.clientSecret} set on this server`,
      `${ENV.redirectUri} matching an Authorised redirect URI on that client, exactly`,
      `${ENV.tokenKey} set, so the stored refresh token can be encrypted at rest`,
      "A one-time consent from the channel's Google account, granting youtube.upload",
      "A verified channel, for the thumbnail only — the video uploads either way",
    ],
  });

  const validate = (request: PublishRequest): PublishValidation => {
    const problems: string[] = [];
    if (request.video.bytes === 0) {
      problems.push("The rendered video is empty, so there is nothing to upload.");
    } else if (request.video.bytes > VIDEO_MAX_BYTES) {
      problems.push("The rendered video is larger than the 256 GB YouTube accepts.");
    }
    if (!request.poster) {
      problems.push("YouTube needs a thumbnail, and this episode has no poster.");
    }
    // The same measurement the Publish Center shows its counters from, so a
    // refusal and a red number can never disagree.
    problems.push(...variantProblems(platform, request.metadata));

    const tags = tagsFrom(request.metadata.hashtags);
    const length = tagsLength(tags);
    if (length > TAGS_MAX_CHARS) {
      problems.push(
        `The hashtags come to ${length} characters as YouTube tags, and it allows ${TAGS_MAX_CHARS}. Remove a few.`,
      );
    }
    // YouTube refuses angle brackets outright, with a generic 400 that says
    // nothing useful. Naming it here turns a mystery into a one-word fix.
    if (/[<>]/.test(request.metadata.title) || /[<>]/.test(request.metadata.description)) {
      problems.push("YouTube refuses < and > in a title or description. Remove them.");
    }
    return { ok: problems.length === 0, problems };
  };

  const isConfigured = async (): Promise<boolean> => {
    if (!publicConfig(env).configured) return false;
    return isConnected(ctx.userId, env);
  };

  return {
    capabilities,
    isConfigured,
    validate,

    prepare: async (request): Promise<PreparedPublish> => {
      const verdict = validate(request);
      if (!verdict.ok) throw new PublishRefused(verdict.problems);
      const connected = await isConfigured().catch(() => false);
      return {
        platform,
        episodeId: request.episodeId,
        metadata: request.metadata,
        video: request.video,
        poster: request.poster,
        preparedAt: new Date(),
        status: connected ? "READY" : "REQUIRES_CONNECTION",
        // ALWAYS offered, in every state. See the header comment.
        handoff: handoffSteps(platform, request),
      };
    },

    publish: async (prepared, hooks: PublishHooks = {}): Promise<PublishOutcome> => {
      if (!ctx.userId) {
        return {
          status: "REQUIRES_CONNECTION",
          error: "No signed-in account, so there is no YouTube connection to publish with.",
        };
      }
      const config = publicConfig(env);
      if (!config.configured) {
        return {
          status: "REQUIRES_CONNECTION",
          error:
            "This server has no YouTube connection configured, so it cannot post for you. " +
            `Missing: ${config.missing.join(", ")}. The video, poster and text are ready to hand over instead.`,
        };
      }

      let accessToken: string;
      try {
        accessToken = await accessTokenFor(ctx.userId, env, doFetch);
      } catch (err) {
        if (err instanceof YouTubeNotConnected) return { status: "REQUIRES_CONNECTION", error: err.message };
        return {
          status: "FAILED",
          error: err instanceof Error ? err.message : "The YouTube credential could not be used.",
        };
      }

      await hooks.onProgress?.({ status: "PREPARING", bytesSent: 0, totalBytes: prepared.video.bytes });

      let result;
      try {
        result = await uploadVideo(
          accessToken,
          prepared.video.path,
          prepared.video.bytes,
          prepared.video.contentType,
          {
            title: prepared.metadata.title,
            description: prepared.metadata.description,
            tags: tagsFrom(prepared.metadata.hashtags),
            categoryId: categoryId(env),
          },
          {
            resumeFrom: hooks.resumeFrom ?? null,
            onSession: hooks.onSession,
            onProgress: (acknowledged, total) =>
              hooks.onProgress?.({ status: "UPLOADING", bytesSent: acknowledged, totalBytes: total }),
          },
          doFetch,
        );
      } catch (err) {
        if (err instanceof YouTubeApiError) {
          // A credential that stopped working mid-attempt is a connection
          // state, not an upload failure: the operator's next action is
          // "reconnect", not "retry".
          if (err.failure.code === "reauth_required" || err.failure.code === "not_connected") {
            return { status: "REQUIRES_CONNECTION", error: err.failure.message };
          }
          return { status: "FAILED", error: err.failure.message };
        }
        return { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
      }

      // The video is up. Everything from here is extra, and nothing from here
      // may turn a successful upload into a reported failure.
      await noteChannel(ctx.userId, result.channelId, result.channelTitle);

      let thumbnail: { applied: boolean; reason: string | null } = {
        applied: false,
        reason: "This episode had no poster to set.",
      };
      if (prepared.poster) {
        const outcome = await setThumbnail(
          accessToken,
          result.videoId,
          prepared.poster.path,
          prepared.poster.contentType,
          doFetch,
        );
        thumbnail = { applied: outcome.applied, reason: outcome.reason };
      }

      return {
        status: "PUBLISHED",
        externalId: result.videoId,
        externalUrl: watchUrlFor(result.videoId),
        confirmedAt: new Date(),
        thumbnail,
        reviewUrl: studioUrlFor(result.videoId),
      };
    },
  };
}
