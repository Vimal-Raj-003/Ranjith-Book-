/**
 * What the Weekly Schedule panel is told. Types and constants only -- no imports
 * of the server -- so `WeeklySchedule.tsx` can share them with the routes and the
 * compiler, not a convention, keeps the two in step.
 */

export const SLOT_STATUSES = ["pending", "scheduling", "scheduled", "published", "failed", "skipped"] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export type ScheduleStatus = "draft" | "active" | "paused" | "cancelled";

/**
 * The platforms a schedule can target. A local union, not an import of the
 * server's `PlatformId`: this file is shared with the browser panel and must not
 * pull server code in. `manual` is a `PublishJob` platform but never a schedule's.
 */
export const SCHEDULE_PLATFORMS = ["youtube", "instagram"] as const;
export type SchedulePlatform = (typeof SCHEDULE_PLATFORMS)[number];

export const isSchedulePlatform = (value: unknown): value is SchedulePlatform =>
  typeof value === "string" && (SCHEDULE_PLATFORMS as readonly string[]).includes(value);

/** The video's YouTube job as the publish engine recorded it. Read, never written, from here. */
export interface SlotJobView {
  progress?: string | null;
  status: string;
  /** ISO. The time YouTube Studio read back; null until it has. */
  scheduledFor: string | null;
  externalUrl: string | null;
  lastError: string | null;
}

export interface SlotView {
  id: string;
  episodeId: string;
  title: string | null;
  /** Which platform this slot publishes to. */
  platform: SchedulePlatform;
  position: number;
  /** ISO, the exact UTC instant this video should go live. */
  assignedAt: string;
  status: SlotStatus;
  note: string | null;
  job: SlotJobView | null;
}

export interface ScheduleView {
  windows?: { start: string; end: string }[];
  seed?: number;
  endInclusive?: boolean;
  instagramOffsetMinutes?: number;
  instagramEnabled?: boolean;
  workerEnabled?: boolean;
  workflowVersion?: number;
  id: string;
  uploadId: string;
  /** `YYYY-MM-DD`. */
  weekStart: string;
  days: number;
  timeSlots: string[];
  timezone: string;
  /** The platforms this schedule targets, derived from its slots. At least one. */
  platforms: SchedulePlatform[];
  madeForKids: boolean | null;
  status: ScheduleStatus;
  /** True while the activation runner is working through the slots in THIS server process. */
  running: boolean;
  slots: SlotView[];
}

/** `GET /api/schedules?uploadId=` and every write on the schedule routes. */
export interface ScheduleResponse {
  schedule: ScheduleView | null;
}

/**
 * Where ONE video sits in the newest ACTIVATED schedule that holds it -- what the Publish page
 * reads so it posts at the schedule's exact instant instead of one typed beside it.
 * `GET /api/schedules?episodeId=`.
 */
export interface EpisodeSlotView {
  scheduleId: string;
  slotId: string;
  /** ISO, the exact UTC instant the schedule assigned. The Publish page sends this string as it is. */
  assignedAt: string;
  /** The zone the schedule was planned in, for showing the time the way the operator planned it. */
  timezone: string;
  /** The schedule's saved "made for kids" answer, or null if the operator never gave one. */
  madeForKids: boolean | null;
  status: SlotStatus;
  note: string | null;
}

/** `GET /api/schedules?episodeId=`: the governing slot, or `{ slot: null }` when no activated schedule holds the video. */
export interface EpisodeSlotResponse {
  slot: EpisodeSlotView | null;
}

/** The body of `POST /api/schedules`. */
export interface SaveDraftBody {
  windows?: { start: string; end: string }[];
  seed?: number;
  endInclusive?: boolean;
  instagramOffsetMinutes?: number;
  uploadId: string;
  weekStart: string;
  days: number;
  timeSlots: string[];
  timezone?: string;
  /** Which platforms to publish to. Defaults to `["youtube"]` when omitted. At least one. */
  platforms?: SchedulePlatform[];
  madeForKids?: boolean | null;
  /** In the order they should go live. */
  videoIds: string[];
}

/**
 * A slot with nothing left to do. `scheduled` (YouTube held it), `published`
 * (Instagram shared it) and `skipped` (it was already there) are settled:
 * re-activating leaves them alone, and the due-runner never posts one again.
 */
export const isSettledSlot = (status: string): boolean =>
  status === "scheduled" || status === "published" || status === "skipped";

/**
 * YouTube will not schedule a video closer than this. A mirror of the engine's
 * `MIN_SCHEDULE_LEAD_MS` (server-only, so not importable from the browser); a test
 * holds the two equal. The panel uses it only to warn early -- the server decides.
 */
export const SCHEDULE_LEAD_MINUTES = 15;
