/**
 * The one contract every platform goes behind.
 *
 * The point of writing this before there is a single real platform behind it is
 * that YouTube and Instagram should slot in without anything above them
 * changing: `state.ts` asks a publisher what it can do and whether it is
 * configured, the route asks it to validate and prepare, and the component is
 * handed the answers as data. No component in this app names a platform's API,
 * holds a token, or knows what an upload looks like — and none has to, because
 * everything provider-shaped stops at this file.
 *
 * TYPES ARE DOING THE HONESTY WORK HERE, not comments and not discipline:
 *
 *  - `PublishOutcome`'s success variant cannot be constructed without an
 *    `externalId` and a `confirmedAt`. There is no `{ status: "PUBLISHED" }` to
 *    write by accident, so a provider physically cannot report success without
 *    something the platform handed back. `manual.ts` is the proof: it has no id
 *    to give, so it cannot even type a published outcome.
 *  - `publish()` takes a `PreparedPublish`, which only `prepare()` returns. A
 *    caller cannot skip validation on the way to an upload.
 *  - `capabilities()` is separate from `isConfigured()`. "This provider could
 *    upload" and "this install can use it right now" are different facts, and
 *    collapsing them is how a UI ends up offering a button that cannot work.
 *
 * This module imports only `./limits` (which has no imports) and the readiness
 * types, so it is safe anywhere — but no `"use client"` component needs it:
 * the state module turns a publisher into plain JSON for the browser.
 */
import type { PlatformId, PlatformLimits, PublishMetadata, PublishStatus } from "./limits";

/** A file this app is about to hand over, already resolved and confirmed present. */
export interface AssetRef {
  /** Absolute path under WORK_ROOT. Never sent to the browser — see `episode-view.ts`. */
  path: string;
  bytes: number;
  /** The URL the browser downloads it from, which IS session-guarded. */
  url: string;
  contentType: string;
}

/** Everything a publisher is told about what it is being asked to post. */
export interface PublishRequest {
  episodeId: string;
  /** The metadata as stored right now, before any platform shaping. */
  metadata: PublishMetadata;
  durationSec: number | null;
  video: AssetRef;
  /** The chosen poster. Null when the episode has none — `validate` is what decides whether that matters. */
  poster: AssetRef | null;
}

/**
 * What a provider can do, as facts rather than as promises.
 *
 * `canUpload: false` is not a defect — the assisted handoff is a real, useful
 * publisher that simply does its work through the operator's hands. What would
 * be a defect is a `canUpload: true` that then does nothing, which is why the
 * UI reads this field to decide whether to offer a Publish button at all.
 */
export interface PlatformCapabilities {
  id: PlatformId;
  label: string;
  /** Can this provider itself put the file on the platform, without the operator? */
  canUpload: boolean;
  /** Can it set the thumbnail as part of that? */
  canSetThumbnail: boolean;
  /** Can it schedule for later rather than posting now? */
  canSchedule: boolean;
  /** Can it come back afterwards and read what the platform did with it? */
  canReportBack: boolean;
  limits: PlatformLimits;
  /** What this install must have before `isConfigured()` can be true. */
  requires: string[];
}

/** A refusal, or a pass. Carries every problem, not the first. */
export interface PublishValidation {
  ok: boolean;
  /** Whole sentences, shown verbatim. Empty when `ok`. */
  problems: string[];
}

/**
 * The receipt `prepare()` issues and `publish()` requires.
 *
 * `metadata` is the SHAPED metadata — what would actually be sent — not the
 * episode's own columns, so what is recorded in `PublishJob.metadata` is what
 * was handed over rather than what happened to be in the database afterwards.
 */
export interface PreparedPublish {
  platform: PlatformId;
  episodeId: string;
  metadata: PublishMetadata;
  video: AssetRef;
  poster: AssetRef | null;
  preparedAt: Date;
  /**
   * The state this preparation leaves the job in. A provider that cannot upload
   * prepares to `REQUIRES_CONNECTION`; one that can prepares to `READY`.
   * Never `PUBLISHED` — `prepare` has not spoken to a platform.
   */
  status: Exclude<PublishStatus, "PUBLISHED">;
  /**
   * What the operator is to do with this, when the provider cannot do it
   * itself. Empty for a provider that uploads. Pure data: labels and URLs the
   * component renders, never markup.
   */
  handoff: HandoffStep[];
}

/** One thing the operator does by hand, named so the UI does not have to guess. */
export interface HandoffStep {
  /** `download` and `copy` are satisfied by this app; `open` leaves for the platform. */
  kind: "download" | "copy" | "open";
  label: string;
  /** For `download` and `open`: where to go. For `copy`: absent. */
  href?: string;
  /** For `copy`: the text. */
  text?: string;
  /** True for `open`: a new tab, and `rel="noreferrer"`. */
  external?: boolean;
}

/**
 * The end of an attempt. Four variants, and only one of them is success.
 *
 * `PUBLISHED` requires `externalId` and `confirmedAt`, so it cannot be returned
 * by a provider that has not been told something by a platform. That is the
 * whole mechanism behind "no Published badge without a platform confirmation" —
 * it is not a rule someone has to remember, it is a type that will not compile
 * otherwise.
 */
export type PublishOutcome =
  | {
      status: "PUBLISHED";
      /** The id the PLATFORM returned. Not ours, not derived, not a guess. */
      externalId: string;
      externalUrl: string | null;
      /** When the platform confirmed. */
      confirmedAt: Date;
      /**
       * Whether the chosen poster was accepted, and why not when it was not.
       *
       * SEPARATE FROM THE VIDEO ON PURPOSE, and optional so a provider that
       * does not do thumbnails omits it. YouTube allows a custom thumbnail only
       * on a verified channel, and that refusal arrives AFTER a 38 MB upload
       * has already succeeded. Folding it into the video's outcome would force
       * one of two lies: report FAILED for a video that is up, or report
       * success for a thumbnail that was refused. So it is its own fact.
       */
      thumbnail?: { applied: boolean; reason: string | null };
      /**
       * Where the operator finishes the job. For a review-first upload this is
       * the whole point of the flow, so it is part of the outcome rather than
       * something a reader has to reconstruct from the id.
       */
      reviewUrl?: string | null;
      /**
       * Set ONLY when the platform is HOLDING the post for later: the id is real
       * but nothing is live yet. A caller records it as SCHEDULED, not PUBLISHED.
       * It is the time the platform READ BACK, never the time that was asked for.
       * Only the browser publishers set it; the API publishers never do.
       */
      scheduledFor?: Date | null;
      /** The visibility the platform read back (`private`, `unlisted`, `public`, `scheduled`). */
      visibility?: string | null;
    }
  | { status: "FAILED"; error: string }
  | { status: "REQUIRES_CONNECTION"; error: string }
  /**
   * A browser-mode job that only a person can take further, and whose real
   * outcome may be unknown. It is deliberately NOT a failure (a retry could post a
   * second copy) and NOT a success (nothing confirmed). `error` says what to do.
   *
   * `externalId`/`externalUrl` are optional and only ever something the platform
   * itself showed: when present, a video is probably already there, which is why a
   * recorded id blocks a re-run.
   */
  | { status: "AWAITING_HUMAN"; error: string; externalId?: string | null; externalUrl?: string | null };

/**
 * What a provider tells the caller while an upload is in flight.
 *
 * `bytesSent` is what the PLATFORM has acknowledged receiving, never a local
 * running total and never a time-based estimate — see `youtube/upload.ts` for
 * how that is obtained. A provider that cannot measure genuine progress must
 * not call `onProgress` at all; the alternative is a bar that moves while
 * nothing happens, which is the one thing this surface may never show.
 */
export interface PublishProgress {
  status: "PREPARING" | "UPLOADING";
  bytesSent: number;
  totalBytes: number;
}

/**
 * The optional channel between a provider mid-upload and the caller that is
 * recording its progress. Added when YouTube landed, because real progress
 * cannot be reported through a function that only resolves at the end, and a
 * synthetic percentage is forbidden.
 *
 * Every field is optional and the whole argument is optional, so a provider
 * written before this existed (`manual.ts`) is unchanged and still type-checks.
 */
export interface PublishHooks {
  onProgress?: (progress: PublishProgress) => void | Promise<void>;
  /**
   * Called once a resumable session exists. The caller persists it so a RETRY
   * resumes rather than re-uploading — the mechanism behind "retry must not
   * re-upload an already-uploaded video".
   */
  onSession?: (sessionRef: string) => void | Promise<void>;
  /** A session a previous attempt recorded, to be continued instead of restarted. */
  resumeFrom?: string | null;
}

export interface Publisher {
  /** Facts about this provider. Synchronous: it reads nothing. */
  capabilities(): PlatformCapabilities;
  /**
   * Can this install use it right now? Async because a real one reads a stored
   * token. Must never throw: a provider whose credential store is unreachable
   * is not configured, and that is an answer, not an error.
   */
  isConfigured(): Promise<boolean>;
  /** Would this request be accepted? Pure, so it can be shown before anything is attempted. */
  validate(request: PublishRequest): PublishValidation;
  /** Shape the metadata, confirm the assets, and issue the receipt. Throws only if `validate` would have refused. */
  prepare(request: PublishRequest): Promise<PreparedPublish>;
  /**
   * Attempt it. The only thing in the system allowed to produce a PUBLISHED
   * outcome.
   *
   * `hooks` is optional and a provider may ignore it entirely — the handoff
   * does. A provider that uses it reports measured progress and hands back the
   * resumable session so a retry continues rather than restarts.
   */
  publish(prepared: PreparedPublish, hooks?: PublishHooks): Promise<PublishOutcome>;
}

/** Thrown by `prepare` when `validate` refuses, so the caller gets the list. */
export class PublishRefused extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems[0] ?? "This episode cannot be published yet.");
    this.name = "PublishRefused";
    this.problems = problems;
  }
}

/** By name, not `instanceof` — see `isAppError` in lib/errors.ts for why. */
export function isPublishRefused(err: unknown): err is PublishRefused {
  return err instanceof Error && err.name === "PublishRefused";
}
