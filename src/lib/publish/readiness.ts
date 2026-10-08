/**
 * Whether an episode may be published at all, and when it may not, exactly
 * what is missing.
 *
 * This is a PURE function over a snapshot, deliberately. The alternative —
 * `episode.status === "DONE" && episode.hasVideo && episode.title && …` written
 * inside the panel that renders the button — is how a readiness rule ends up
 * meaning something different in the three places that ask. It also cannot be
 * tested: proving "a DONE episode whose render was deleted off disk is NOT
 * ready" would need a browser, a session and a filesystem.
 *
 * The filesystem checks are still real; they just happen OUTSIDE. The caller
 * (`state.ts`) stats the render and the chosen poster and hands the answers in
 * as booleans. So "is the video on disk" is genuinely verified against the
 * disk, while THIS module stays something a test can drive through every branch
 * in microseconds.
 *
 * Nothing short-circuits. An episode missing a video AND a description reports
 * both, because an operator who fixes one thing and is then told about the next
 * has been made to go round twice for no reason.
 *
 * Client-safe: imports only `./limits`, which has no imports at all.
 */
import { SANE_DURATION } from "./limits";

/** What readiness is decided from. Every field is what the caller measured, not what it assumed. */
export interface ReadinessInput {
  /** `Episode.status`: QUEUED | RUNNING | DONE | FAILED | CANCELLED. */
  status: string;
  /** `Episode.error`. A DONE episode normally has none; one left over from a
   *  failed-then-rerun attempt is the "unresolved render failure" case. */
  error: string | null;
  durationSec: number | null;
  /** True only if `Episode.videoPath` is set AND the render is on disk. */
  videoPath: string | null;
  videoOnDisk: boolean;
  /** Bytes on disk. Zero is a render that was created and never written. */
  videoBytes: number;
  /** How many posters the episode has at all. */
  posterCount: number;
  /** The poster that would be used (`pickPoster`), and whether its file resolves. */
  posterKey: string | null;
  posterOnDisk: boolean;
  title: string | null;
  description: string | null;
  hashtags: string[];
}

export type ReadinessCode =
  | "episode_not_done"
  | "render_error"
  | "no_video"
  | "video_missing"
  | "video_empty"
  | "no_duration"
  | "duration_implausible"
  | "no_poster"
  | "poster_missing"
  | "no_title"
  | "no_description"
  | "no_hashtags";

export interface ReadinessIssue {
  code: ReadinessCode;
  /** A whole sentence naming the thing and what to do, shown verbatim. */
  message: string;
}

export interface Readiness {
  ready: boolean;
  issues: ReadinessIssue[];
}

const blank = (s: string | null | undefined): boolean => typeof s !== "string" || s.trim() === "";

/**
 * The verdict, and the list.
 *
 * `ready` is `issues.length === 0` and is computed, never passed in, so there
 * is no way to return a ready verdict alongside a list of reasons it is not.
 */
export function checkReadiness(input: ReadinessInput): Readiness {
  const issues: ReadinessIssue[] = [];
  const add = (code: ReadinessCode, message: string) => issues.push({ code, message });

  if (input.status !== "DONE") {
    add(
      "episode_not_done",
      input.status === "RUNNING" || input.status === "QUEUED"
        ? "This episode is still being made. Publishing is offered once the run finishes."
        : `This episode's run ended as ${input.status.toLowerCase()}, so there is nothing finished to publish.`,
    );
  } else if (!blank(input.error)) {
    // Only for a DONE episode: on a FAILED one the line above already said so,
    // and repeating the same fact twice makes the list look longer than it is.
    add(
      "render_error",
      `This episode finished but still carries an unresolved failure: ${input.error!.trim()}. Re-render it before publishing.`,
    );
  }

  if (!input.videoPath) {
    add("no_video", "No video has been rendered for this episode yet.");
  } else if (!input.videoOnDisk) {
    add("video_missing", "The rendered video is recorded but is no longer on disk, so there is no file to upload.");
  } else if (input.videoBytes === 0) {
    add("video_empty", "The rendered video file is empty (0 bytes). Re-render it before publishing.");
  }

  if (input.durationSec === null || !Number.isFinite(input.durationSec)) {
    add("no_duration", "This episode's length was never measured, so it cannot be checked against a platform.");
  } else if (input.durationSec < SANE_DURATION.min || input.durationSec > SANE_DURATION.max) {
    add(
      "duration_implausible",
      `This episode's recorded length is ${Math.round(input.durationSec)} seconds, which is not a plausible vertical video. Re-render it before publishing.`,
    );
  }

  if (input.posterCount === 0 || input.posterKey === null) {
    add("no_poster", "This episode has no poster, so there is no thumbnail to upload with it.");
  } else if (!input.posterOnDisk) {
    add("poster_missing", "The selected poster is recorded but its image is no longer on disk.");
  }

  if (blank(input.title)) add("no_title", "This episode has no title. Every platform requires one.");
  if (blank(input.description)) {
    add("no_description", "This episode has no description. Write one, or regenerate it, before publishing.");
  }
  if (input.hashtags.filter((t) => typeof t === "string" && t.trim() !== "").length === 0) {
    add("no_hashtags", "This episode has no hashtags. Add at least one, or regenerate them.");
  }

  return { ready: issues.length === 0, issues };
}
