import type { JobView, SlotView } from "./board-types";

const names = { youtube: "YouTube", instagram: "Instagram" } as const;
const platforms = ["youtube", "instagram"] as const;
export function confirmedOutcome(job: JobView | null): "scheduled" | "posted" | null {
  if (job?.confirmation === "scheduled" && job.status === "PLATFORM_SCHEDULED") return "scheduled";
  if (job?.confirmation === "posted" && job.status === "POSTED") return "posted";
  return null;
}

export function videoCompletion(jobs: SlotView["jobs"]) {
  const confirmed = platforms.filter(p => confirmedOutcome(jobs[p]));
  const attention = platforms.flatMap(p => {
    const job = jobs[p];
    if (!job || confirmedOutcome(job)) return [];
    const status = job.status === "DRAFT" && job.sourceStatus === "QUEUED" ? "PAUSED" : job.sourceStatus ?? job.status;
    const unverified = ["PLATFORM_SCHEDULED", "POSTED"].includes(job.status);
    const needsAttention = unverified || ["FAILED", "REQUIRES_CONNECTION", "AWAITING_HUMAN", "CANCELLED", "HELD", "DRAFT", "PAUSED"].includes(status);
    if (!needsAttention) return [];
    return [{ platform: p, status: unverified ? "Confirmation missing or publication time differs" : status, error: job.error }];
  });
  const kind = confirmed.length === 2 ? "completed" : confirmed.length === 1 ? "partial" : attention.length ? "attention" : "pending";
  const pending = platforms.find(p => !confirmed.includes(p));
  const label = kind === "completed" ? "COMPLETED" : kind === "partial"
    ? `PARTIALLY COMPLETED – ${names[pending!]} Pending`
    : kind === "attention" ? "NEEDS ATTENTION" : "PENDING";
  return { kind, label, attention: attention.map(a => ({ ...a, label: `${names[a.platform]} – ${a.status}` })) };
}

export function batchCompletion(slots: readonly SlotView[]) {
  const videos = slots.filter(s => s.creation);
  const states = videos.map(s => videoCompletion(s.jobs));
  const jobs = new Map(videos.flatMap(s => Object.values(s.jobs)).filter((j): j is JobView => !!j).map(j => [j.id, j]));
  return {
    totalVideos: videos.length,
    completedVideos: states.filter(s => s.kind === "completed").length,
    partiallyCompletedVideos: states.filter(s => s.kind === "partial").length,
    pendingOrFailedVideos: states.filter(s => s.kind === "pending" || s.kind === "attention").length,
    confirmedScheduledPosts: [...jobs.values()].filter(j => confirmedOutcome(j) === "scheduled").length,
    confirmedPostedPosts: [...jobs.values()].filter(j => confirmedOutcome(j) === "posted").length,
  };
}
