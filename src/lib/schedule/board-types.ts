/** UI contracts adapted from RepoReel. IDs always name BookReel records. */
import type { Issue, TimeWindow } from "./plan";
export type Platform = "youtube" | "instagram";
export type ConflictKind = string;
export type PlatformStatus = "none" | "queued" | "publishing" | "published" | "scheduled" | "scheduled-on-platform" | "held" | "needs-you" | "failed" | "cancelled" | "disabled";
export interface VideoThumbnails { shape: "vertical" | "landscape"; selected: string | null; options: {id: string; name: string; why: string; preview: "vertical" | "landscape"; url: string}[]; message: string | null; }
export interface Candidate {
  id: string;
  owner: string;
  repo: string;
  title: string;
  format: string;
  createdAt: string;
  hasPlatformCopy: boolean;
  hasThumbnail: boolean;
  /** Why this video cannot be scheduled as it is. Empty means it can. */
  problems: string[];
}

export interface JobView {
  id: string;
  platform: string;
  status: string;
  error: string | null;
  remoteUrl: string | null;
  startAt: string | null;
  publishAt: string | null;
  startedAt: string | null;
  lastAttemptAt: string | null;
  updatedAt: string;
  postedAt: string | null;
  attempts: number;
  /** YouTube holds this job's schedule. */
  nativeSchedule: boolean;
  /** The platform's own word for the state, once it confirmed a native schedule. */
  platformStatus: string | null;
  /** The instant the platform confirmed it will publish. */
  platformPublishAt: string | null;
  /** True only when externalId, remoteDraftId, and sessionUrlEnc are all null. */
  preUpload?: boolean;
}

export interface SlotConflict {
  platform: "youtube" | "instagram";
  kind: ConflictKind;
  /** What is in the way and the safe way out of it. */
  message: string;
  jobId: string;
  /** Cancelling it from this schedule is possible: it is an immediate post that has not started. */
  releasable: boolean;
}

export interface UnavailableVideo {
  id: string;
  title: string;
  repo: string;
  kind: ConflictKind | "in-schedule";
  message: string;
}

export interface SlotView {
  id: string;
  day: number;
  position: number;
  localDate: string;
  localTime: string;
  scheduledAt: string;
  status: string;
  creation: { id: string; title: string; owner: string; repo: string; format: string; hasPlatformCopy: boolean; hasThumbnail: boolean } | null;
  jobs: { youtube: JobView | null; instagram: JobView | null };
  issues: Issue[];
  /** Posts that already exist for this slot's video and would stop it being armed. Only a draft has any. */
  conflicts: SlotConflict[];
}

export interface ScheduleView {
  madeForKids: boolean | null;
  instagramEnabled: boolean;
  workerEnabled: boolean;
  workflowVersion: number;
  id: string;
  name: string;
  timezone: string;
  status: string;
  startDate: string;
  days: number;
  windows: TimeWindow[];
  endInclusive: boolean;
  seed: number;
  leadMinutes: number;
  instagramOffsetMinutes: number;
  youtubePrivacy: string;
  youtubeChannel: string;
  /** YouTube holds this schedule's times (the visibility is public), instead of RepoReel holding them. */
  youtubeNative: boolean;
  minGapMinutes: number;
  missGraceMinutes: number;
  activatedAt: string | null;
  slots: SlotView[];
  /** Findings on the schedule as a whole, shown above the table. */
  issues: Issue[];
  /** Videos that could go into an empty slot or replace one. Only a draft needs them. */
  candidates: Candidate[];
  /** Finished videos that could not be offered, each with why. Only a draft needs them. */
  unavailable: UnavailableVideo[];
  /** Immediate posts that have not started and are blocking this draft's videos: the ones "release" would cancel. */
  releasable: number;
  /** What the browser engine needs that this code cannot check: whether a profile has ever been used. */
  profiles: { youtube: boolean; instagram: boolean };
  counts: { slots: number; withVideo: number; jobs: number; posted: number; scheduledOnPlatform: number; failed: number; waiting: number };
}
export interface JobSummary {
  id: string;
  mode: string;
  status: string;
  scheduledAt: string | null;
  publishAt: string | null;
  remoteUrl: string | null;
  /** The sentence the job shows: progress while it runs, the reason when it did not work. */
  error: string | null;
  attempts: number;
  postedAt: string | null;
  createdAt: string;
  /** YouTube is to hold this job's schedule, not RepoReel. */
  nativeSchedule: boolean;
  /** The weekly-schedule slot this job belongs to, if it was made by a schedule. */
  slotId: string | null;
  /** For a native schedule the platform confirmed: its own word for the state, and when it will publish. */
  platformStatus: string | null;
  platformPublishAt: string | null;
}

export interface PlatformState {
  executionEnabled?: boolean;
  platform: Platform;
  status: PlatformStatus;
  /** The job that decides `status`. */
  job: JobSummary | null;
  /** A new post may be started here: nothing is in flight and nothing has been published. */
  canPublish: boolean;
  /** Why not, when it may not. */
  blockedReason: string | null;
  /** What kind of post is in the way (a ConflictKind), when one is. */
  blockedKind: string | null;
}

export interface GeneratedVideo {
  id: string;
  title: string;
  repo: string;
  repoUrl: string;
  format: string;
  createdAt: string;
  durationSec: number | null;
  /** The run's own status: QUEUED | RUNNING | DONE | FAILED. */
  status: string;
  /** For a run that has not finished: what it is doing, or why it failed. */
  detail: string | null;
  file: { ok: boolean; bytes: number | null; problem: string | null };
  thumbnailUrl: string;
  /** Which thumbnail publishes, and what else there really is to choose from. Null until the video is finished. */
  thumbnail: VideoThumbnails | null;
  videoUrl: string | null;
  platforms: Record<Platform, PlatformState>;
  /**
   * The weekly schedule this video is in, with its slot's exact assigned time, when one
   * that is still wanted holds it. `slotAt` is the persisted go-live instant — an absolute
   * moment, never recomputed — so a screen can show the assigned time in Asia/Kolkata and a
   * summary can promise exactly the slot scheduling will arm. Null when the video is in no
   * schedule, which is what "not assigned to a schedule" means.
   */
  schedule: {
    id: string;
    name: string;
    status: string;
    /** The schedule's own timezone; its local slot times were persisted in it. */
    timezone: string;
    /** The schedule's YouTube visibility: only "public" can be scheduled natively on YouTube. */
    youtubePrivacy: string;
    /** The exact persisted go-live instant, ISO. The one scheduling uses. */
    slotAt: string;
    /** The slot's persisted local date and time, as the schedule stored them. */
    localDate: string;
    localTime: string;
  } | null;
  selectable: boolean;
  /** Why it cannot be selected. */
  reason: string | null;
}

export interface VideoPage {
  items: GeneratedVideo[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Every video on every page that can be picked, for "Select all". */
  selectableIds: string[];
}
export interface BulkItem { creationId: string; platform: Platform; outcome: "started" | "skipped" | "rejected"; jobId: string | null; message: string | null; code: string | null; kind: string | null; }
export interface BulkResult {items: BulkItem[]; started: number; skipped: number; rejected: number;}
