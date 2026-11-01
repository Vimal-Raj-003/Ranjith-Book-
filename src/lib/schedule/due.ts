/** Compatibility exports for the old Instagram ticker. Both platforms now use
 * the existing schedule runner and native platform scheduling, ahead of time. */
import { prisma } from "@/lib/db";
import { publishingEnabled } from "@/lib/publish/execution";
import { runSchedule, type RunScheduleOptions } from "./activate";
import { startScheduleWorker } from "./worker";
import type { SlotStatus } from "./view";

export interface DueOptions extends RunScheduleOptions { now?: number; scheduleId?: string }
interface JobFacts { id: string; status: string; externalId: string | null; externalUrl: string | null; lastError: string | null }
export async function instagramJob(episodeId: string) {
  return prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform: "instagram" } } });
}
export function alreadyPostedInstagram(job: JobFacts | null): { status: SlotStatus; note: string } | null {
  if (!job) return null;
  if (job.status === "SCHEDULED") return { status: "scheduled", note: "Instagram confirmed the native schedule." };
  if (job.status === "PUBLISHED") return { status: "published", note: "Already posted on Instagram; nothing was sent." };
  if (job.externalId) return { status: "skipped", note: "Instagram already showed this Reel; no second upload was started." };
  return null;
}
export function instagramOutcome(job: JobFacts | null): { status: SlotStatus; note: string | null; stop: boolean } {
  const settled = alreadyPostedInstagram(job);
  if (settled && job?.status !== "AWAITING_HUMAN") return { ...settled, stop: false };
  if (job && ["PREPARING", "UPLOADING"].includes(job.status)) return { status: "scheduling", note: null, stop: false };
  return { status: "failed", note: job?.lastError ?? "No confirmed Instagram receipt was recorded.", stop: job?.status === "AWAITING_HUMAN" || job?.status === "REQUIRES_CONNECTION" };
}
let busy = false;
export const isInstagramDuePassActive = () => busy;
export async function publishDueInstagram(options: DueOptions = {}): Promise<number> {
  if (busy || !publishingEnabled("instagram", options.env ?? process.env)) return 0;
  busy = true;
  try {
    const plans = await prisma.weeklySchedule.findMany({ where: { status: "active", workflowVersion: 2, ...(options.scheduleId ? { id: options.scheduleId } : {}) } });
    for (const plan of plans) await runSchedule(plan.id, { ...options, platform: "instagram", automatic: true });
    return plans.length;
  } finally { busy = false; }
}
export const startInstagramTicker = startScheduleWorker;
