import type { Platform } from "./board-types";

/**
 * Which generated videos are ticked on the schedule page, and what pressing
 * Publish would do with them.
 *
 * Plain functions with no React, for the same reason bulk-selection.ts is: the
 * properties that matter - a video can only be in the selection once, one that
 * cannot be published can never be in it, and nothing is selected by itself - are
 * ones a screen cannot show. Every function returns a new Set.
 */

/** The part of a video this reads. */
export interface SelectableVideo {
  id: string;
  title: string;
  selectable: boolean;
  platforms: Record<Platform, { canPublish: boolean; blockedReason: string | null; blockedKind?: string | null }>;
}

/** What each kind of post that is in the way is, in a few words: the heading a group of skipped videos goes under. */
export const CONFLICT_WORDS: Record<string, string> = {
  "disabled": "Instagram publishing is disabled",
  "inactive-plan": "activate the draft or resume the schedule first",
  "immediate-queued": "queued for an immediate post that has not started",
  "immediate-publishing": "being posted right now",
  "scheduled-post": "already in a weekly schedule",
  "scheduled-later": "already scheduled for a later time",
  held: "on hold",
  "waiting-on-you": "waiting on you to finish it on the platform",
  "platform-scheduled": "already scheduled on the platform",
  posted: "already published",
  "unknown-live": "already have a post in progress",
  // Scheduling-only reasons (schedulePlanFor): a video with no slot, a slot already gone, or one
  // a platform cannot take natively.
  "no-slot": "not assigned to a weekly schedule",
  "past-slot": "assigned time has passed",
  "youtube-not-public": "the schedule's YouTube visibility is not public",
  "missing-file": "the video file is missing",
};

/** Tick or untick one video. A video that cannot be selected stays out, however it is asked for. */
export function toggle(selection: ReadonlySet<string>, id: string, selectable: boolean, on?: boolean): Set<string> {
  const next = new Set(selection);
  const want = on ?? !next.has(id);
  if (want && selectable) next.add(id);
  else next.delete(id);
  return next;
}

/** Everything that can be picked, on every page. */
export const selectAll = (selectableIds: readonly string[]): Set<string> => new Set(selectableIds);

export const deselectAll = (): Set<string> => new Set();

/**
 * The selection with anything that can no longer be picked taken out.
 *
 * After a refresh a video may have been deleted, or have gone out through another
 * tab, and a selection that still named it would publish a video nobody is looking
 * at.
 */
export function prune(selection: ReadonlySet<string>, selectableIds: readonly string[]): Set<string> {
  const allowed = new Set(selectableIds);
  return new Set([...selection].filter((id) => allowed.has(id)));
}

/** "1 video" / "5 videos". */
export const countLabel = (n: number): string => `${n} video${n === 1 ? "" : "s"}`;

export interface PlanCell {
  /** A post will be started. */
  will: boolean;
  /** Why not, when it will not. */
  note: string | null;
  /** What kind of post is in the way, when one is. */
  kind?: string | null;
}

export interface PlanRow {
  id: string;
  title: string;
  cells: Partial<Record<Platform, PlanCell>>;
}

export interface Plan {
  rows: PlanRow[];
  /** Posts that will be started. */
  posts: number;
  /** Posts that will not, because they already exist. */
  skipped: number;
  /** The skipped posts grouped by what is in the way, biggest group first. */
  skippedBy: { kind: string; label: string; count: number }[];
}

/**
 * What confirming would do, per video and platform, from what is known now.
 *
 * The server decides again when the request arrives; this is so the summary does
 * not promise a post that the duplicate rule is going to refuse.
 */
export function planFor(videos: readonly SelectableVideo[], platforms: readonly Platform[]): Plan {
  const rows = videos.map((v): PlanRow => {
    const cells: PlanRow["cells"] = {};
    for (const p of platforms) {
      const state = v.platforms[p];
      cells[p] = state.canPublish ? { will: true, note: null } : { will: false, note: state.blockedReason, kind: state.blockedKind ?? null };
    }
    return { id: v.id, title: v.title, cells };
  });

  let posts = 0;
  let skipped = 0;
  const groups = new Map<string, number>();
  for (const row of rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell?.will) posts++;
      else {
        skipped++;
        const kind = cell?.kind ?? "unknown-live";
        groups.set(kind, (groups.get(kind) ?? 0) + 1);
      }
    }
  }
  const skippedBy = [...groups.entries()]
    .map(([kind, count]) => ({ kind, label: CONFLICT_WORDS[kind] ?? CONFLICT_WORDS["unknown-live"], count }))
    .sort((a, b) => b.count - a.count);
  return { rows, posts, skipped, skippedBy };
}

/* --------------------------------------------------------- the schedule summary -- */

/** A video as the schedule summary reads it: its platform verdicts, its file, and its assigned slot. */
export interface SchedulableVideo extends SelectableVideo {
  /** The file check; a video whose file is gone cannot be scheduled. Absent counts as present. */
  file?: { ok: boolean; problem: string | null };
  /**
   * The weekly-schedule slot this video is assigned, or null when it is in no schedule. `slotAt` is
   * the exact persisted instant and `youtubePrivacy` the schedule's YouTube visibility — the two
   * facts that decide whether a slot can be scheduled natively on a platform.
   */
  schedule: { slotAt: string; youtubePrivacy: string; status?: string } | null;
}

export interface SchedulePlanRow extends PlanRow {
  /** The exact persisted instant this video is assigned, ISO; null means it is in no schedule. */
  slotAt: string | null;
}

export interface SchedulePlan {
  rows: SchedulePlanRow[];
  /** Posts that will be scheduled. */
  posts: number;
  /** Posts that will not be — already out or scheduled, no slot, a time gone by, or not native-able. */
  skipped: number;
  /** Videos that belong to no schedule at all (so nothing about them will be scheduled). */
  noSlot: number;
  /** The skipped posts grouped by what stopped them, biggest group first. */
  skippedBy: { kind: string; label: string; count: number }[];
}

/**
 * What scheduling the ticked videos would do, per video and platform, from what is known now.
 *
 * It mirrors scheduleSelected's rules so the summary never promises a schedule the server will
 * refuse: a video in no schedule is "not assigned" (and is never quietly published instead), a
 * slot whose time has already passed is refused, YouTube is refused unless the schedule is public,
 * and a platform that already holds this video is skipped. The exact time comes from the slot's
 * persisted instant and is never recomputed; `now` is a plain number so a test can fix it.
 */
export function schedulePlanFor(
  videos: readonly SchedulableVideo[],
  platforms: readonly Platform[],
  now: number = Date.now(),
): SchedulePlan {
  const rows = videos.map((v): SchedulePlanRow => {
    const cells: PlanRow["cells"] = {};
    const slot = v.schedule;
    const fileGone = v.file ? !v.file.ok : false;
    const past = slot ? new Date(slot.slotAt).getTime() <= now : false;
    for (const p of platforms) {
      const state = v.platforms[p];
      if (fileGone) cells[p] = { will: false, note: v.file?.problem ?? "The video file is missing.", kind: "missing-file" };
      else if (!slot) cells[p] = { will: false, note: "Not assigned to a schedule.", kind: "no-slot" };
      else if (slot.status && slot.status !== "ACTIVE") cells[p] = {will:false,note:"Activate this draft explicitly, or resume the schedule, before scheduling its posts.",kind:"inactive-plan"};
      else if (!state.canPublish) cells[p] = { will: false, note: state.blockedReason, kind: state.blockedKind ?? null };
      else if (past) cells[p] = { will: false, note: "Its assigned time has passed — reschedule it, or use Publish now.", kind: "past-slot" };
      else if (p === "youtube" && slot.youtubePrivacy !== "public")
        cells[p] = { will: false, note: `This schedule's YouTube visibility is ${slot.youtubePrivacy}; only a public schedule can be scheduled natively on YouTube.`, kind: "youtube-not-public" };
      else cells[p] = { will: true, note: null };
    }
    return { id: v.id, title: v.title, slotAt: slot?.slotAt ?? null, cells };
  });

  let posts = 0;
  let skipped = 0;
  const groups = new Map<string, number>();
  for (const row of rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell?.will) posts++;
      else {
        skipped++;
        groups.set(cell?.kind ?? "unknown-live", (groups.get(cell?.kind ?? "unknown-live") ?? 0) + 1);
      }
    }
  }
  const skippedBy = [...groups.entries()]
    .map(([kind, count]) => ({ kind, label: CONFLICT_WORDS[kind] ?? CONFLICT_WORDS["unknown-live"], count }))
    .sort((a, b) => b.count - a.count);
  return { rows, posts, skipped, noSlot: rows.filter((r) => r.slotAt === null).length, skippedBy };
}

export const STORAGE_KEY = "bookreel.publish-selection";

/** Read the remembered selection. Anything unreadable is an empty one: it is a convenience, never state that matters. */
export function parseStored(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 500));
  } catch {
    return new Set();
  }
}
