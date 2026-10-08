/**
 * The shape `GET /api/episodes/[id]/publish` answers with — the one thing the
 * server and the browser both have to agree about.
 *
 * It lives in its own module, apart from `state.ts`, for exactly the reason
 * `episode-view.ts` exists: `state.ts` imports Prisma, `node:fs` and the work
 * root, and `PublishCenter` is a `"use client"` component. A component that
 * imported the view type from `state.ts` would drag all of that into the
 * browser bundle — a 500 on every route, which a clean typecheck does not catch
 * and `tests/client-ui.test.mts` exists to prevent.
 *
 * It is also not a second hand-written copy of the server's shape, which is the
 * other way this usually goes wrong: `state.ts` imports these very types and
 * annotates its return value with them, so the compiler is what keeps the two
 * sides together rather than a convention.
 *
 * Client-safe: only `./limits`, `./readiness` and `./contract`, none of which
 * import anything outside this folder, and two of which are type-only here.
 */
import type { PlatformId, PublishMetadata, PublishStatus, VariantField } from "./limits";
import type { HandoffStep, PlatformCapabilities } from "./contract";
import type { Readiness } from "./readiness";

export type { HandoffStep, PlatformCapabilities } from "./contract";
export type { Readiness, ReadinessIssue } from "./readiness";
export type { PlatformId, PublishMetadata, PublishStatus, VariantField } from "./limits";

/** The last recorded attempt on one platform. */
export interface PublishJobView {
  status: PublishStatus;
  /** The id the PLATFORM returned. Null until a platform confirms one. */
  externalId: string | null;
  externalUrl: string | null;
  attempts: number;
  lastError: string | null;
  preparedAt: string | null;
  /** ISO, and only ever set from a platform's own confirmation. */
  publishedAt: string | null;
  /** The metadata frozen at the moment of the attempt. */
  metadata: PublishMetadata | null;
  /**
   * Bytes the PLATFORM has acknowledged receiving, and the size of the file.
   *
   * Both null means "no measurement", and a reader must then show no progress
   * bar at all rather than one at a plausible-looking position. There is no
   * percentage on this type on purpose: a percentage can be invented, and two
   * byte counts cannot.
   */
  uploadedBytes: number | null;
  totalBytes: number | null;
  /** `APPLIED` | `SKIPPED` | `FAILED`, or null when no attempt was made. */
  thumbnailStatus: string | null;
  /** Why the thumbnail was not applied. A video can succeed while this fails. */
  thumbnailError: string | null;
  /** The privacy the platform recorded. `private` for anything this app uploaded. */
  privacyStatus: string | null;
  /** Where the operator finishes the job, for a platform that has a review surface. */
  reviewUrl: string | null;
}

/** Which fields the operator has typed over, as ISO timestamps. Null means "as written". */
export interface MetadataEdits {
  title: string | null;
  description: string | null;
  hashtags: string | null;
}

/** How one platform stands. */
export interface PlatformState {
  platform: PlatformId;
  label: string;
  status: PublishStatus;
  capabilities: PlatformCapabilities;
  /** Is there a provider at all that could upload? False everywhere in this build. */
  hasPublisher: boolean;
  /** Does this install have what that provider needs? */
  configured: boolean;
  /** Why this platform would refuse right now. Whole sentences. */
  problems: string[];
  /** The metadata shaped for this platform, with its counters. */
  variant: VariantField[];
  /** What the operator does by hand. Empty when readiness or validation refuses. */
  handoff: HandoffStep[];
  requires: string[];
  job: PublishJobView | null;
}

export interface PublishView {
  episodeId: string;
  title: string | null;
  bookTitle: string;
  status: string;
  durationSec: number | null;
  /** The session-guarded URL of the render, or null when there is nothing to serve. */
  videoUrl: string | null;
  videoBytes: number | null;
  poster: { key: string; url: string; width: number; height: number } | null;
  metadata: PublishMetadata;
  edits: MetadataEdits;
  readiness: Readiness;
  platforms: PlatformState[];
  /**
   * Does the viewer actually OWN this episode?
   *
   * `episodes/visibility.ts` is deliberately generous about ownerless episodes
   * — most of this install's library has no `userId`, and excluding them would
   * empty the library. Reading one, retitling one and recording a handoff for
   * one all inherit that generosity, because they are local and reversible.
   *
   * AN API PUBLISH DOES NOT. It puts a file on a third party's servers under
   * someone's account, and it cannot be taken back from here. So the publish
   * entry point requires `userId === viewer.id`, and this flag is how the UI
   * knows not to offer a button that would be refused — the refusal still
   * exists server-side and is the actual guard; this only stops the operator
   * finding it the hard way.
   */
  owned: boolean;
}

export type MetadataField = "title" | "description" | "hashtags";

export const METADATA_FIELDS: MetadataField[] = ["title", "description", "hashtags"];

export function isMetadataField(v: unknown): v is MetadataField {
  return v === "title" || v === "description" || v === "hashtags";
}

/**
 * The status to show for one platform, derived fresh on every read.
 *
 * A recorded PUBLISHED or FAILED wins: those are facts about something that
 * happened, and no amount of local recomputation may overwrite them. So do the
 * two in-flight states, which describe work another request started.
 *
 * Everything else is DERIVED rather than stored, because it describes the
 * present: an episode that was READY and then had its render deleted is
 * NOT_READY now, and a stored READY would have become a lie the moment it was
 * written. That is the whole reason this function exists instead of a `status`
 * column being trusted.
 *
 * Pure, and here rather than in `state.ts`, so a test can walk every
 * combination without a database.
 */
export function platformStatus(
  readiness: Readiness,
  configured: boolean,
  recorded: PublishStatus | null,
): PublishStatus {
  if (recorded === "PUBLISHED" || recorded === "FAILED") return recorded;
  if (recorded === "PREPARING" || recorded === "UPLOADING") return recorded;
  if (!readiness.ready) return "NOT_READY";
  return configured ? "READY" : "REQUIRES_CONNECTION";
}
