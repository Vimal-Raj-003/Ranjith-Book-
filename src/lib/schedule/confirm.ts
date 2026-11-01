/** Read-only recovery of known native schedules. Never selects a file or presses Save. */
import { prisma } from "@/lib/db";
import { runInSession } from "@/lib/publish/browser/engine";
import { confirmChannel, YT } from "@/lib/publish/browser/youtube";
import { hasLeftOpenWindow, isPlatformBusy } from "@/lib/publish/browser/live";
import { youtubeScheduleControls } from "@/lib/publish/browser/native-controls";
import { accessTokenFor, verifyChannelIdentity } from "@/lib/publish/youtube/accounts";
import { judgeApiSchedule } from "@/lib/publish/native-schedule";
import type { EnvLike } from "@/lib/publish/youtube/secrets";

export interface KnownSchedule {
  userId: string; mode: string; remoteId: string; title: string; at: Date;
}
export type ScheduleVerifier = (job: KnownSchedule) => Promise<boolean>;

export async function verifyKnown(job: KnownSchedule, env: EnvLike): Promise<boolean> {
  if (job.mode === "api") {
    const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
    if ((await verifyChannelIdentity(job.userId, env, timedFetch)).verdict !== "match") return false;
    const token = await accessTokenFor(job.userId, env, timedFetch);
    const response = await timedFetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${encodeURIComponent(job.remoteId)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    const body = await response.json() as { items?: { id: string; snippet?: { title?: string }; status?: { privacyStatus?: string; publishAt?: string } }[] };
    const item = body.items?.find(item => item.id === job.remoteId);
    return item?.snippet?.title === job.title && judgeApiSchedule({ privacyStatus: item?.status?.privacyStatus, publishAt: item?.status?.publishAt }, job.at).confirmed;
  }
  // A person or an active job owns these windows. Leave them exactly as they are.
  if (isPlatformBusy("youtube") || hasLeftOpenWindow("youtube")) return false;
  const result = await runInSession("youtube", { env, jobTimeoutMs: 120_000 }, async session => {
    try {
      await session.page.goto(YT.studio, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await confirmChannel(session, "scheduled", env);
      if (!(await youtubeScheduleControls.confirm(session.page, job.remoteId, job.title, job.at)).ok) return { status: "FAILED", error: "The saved schedule could not be confirmed by a read-only check." };
      return { status: "PUBLISHED", externalId: job.remoteId, externalUrl: `https://youtu.be/${job.remoteId}`, confirmedAt: new Date(), scheduledFor: job.at, visibility: "scheduled" };
    } catch (error) {
      return { status: "FAILED", error: error instanceof Error ? error.message : String(error) };
    }
  });
  return result.status === "PUBLISHED";
}

export async function confirmKnownSchedules(options: { env?: EnvLike; verify?: ScheduleVerifier } = {}): Promise<number> {
  const plans = await prisma.weeklySchedule.findMany({ where: { status: "active", workflowVersion: 2 }, select: { id: true, userId: true } });
  const owners = new Map(plans.map(plan => [plan.id, plan.userId]));
  const slots = await prisma.scheduleSlot.findMany({
    where: { platform: "youtube", scheduleId: { in: plans.map(plan => plan.id) }, status: { in: ["failed", "skipped", "scheduling"] } }, orderBy: { id: "asc" },
  });
  const state = globalThis as unknown as { bookreelConfirmationCursor?: string };
  const cursor = slots.findIndex(slot => slot.id === state.bookreelConfirmationCursor);
  const ordered = cursor < 0 ? slots : [...slots.slice(cursor + 1), ...slots.slice(0, cursor + 1)];
  let checked = 0;
  let confirmed = 0;
  for (const slot of ordered) {
    const job = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform: "youtube" } } });
    if (!job || job.status !== "AWAITING_HUMAN") continue;
    const remoteId = job.externalId ?? job.remoteDraftId;
    if (!remoteId || !/^[\w-]{11}$/.test(remoteId) || slot.assignedAt <= new Date()) continue;
    if (++checked > 4) break;
    state.bookreelConfirmationCursor = slot.id;
    let title: string;
    try { title = JSON.parse(job.metadata ?? "{}").title; } catch { continue; }
    if (!title) continue;
    try {
      const candidate = { userId: owners.get(slot.scheduleId), mode: job.mode ?? "browser", remoteId, title, at: slot.assignedAt };
      if (!candidate.userId || !(await (options.verify ?? (candidate => verifyKnown(candidate, options.env ?? process.env)))(candidate as KnownSchedule))) continue;
      const changed = await prisma.publishJob.updateMany({ where: { id: job.id, status: "AWAITING_HUMAN", updatedAt: job.updatedAt }, data: { status: "SCHEDULED", scheduledFor: slot.assignedAt, publishedAt: null, externalId: remoteId, externalUrl: `https://youtu.be/${remoteId}`, lastError: null, progress: "Saved native schedule confirmed by a read-only check." } });
      if (!changed.count) continue;
      await prisma.scheduleSlot.update({ where: { id: slot.id }, data: { status: "scheduled", note: "YouTube confirmed the saved native schedule; no upload was repeated.", publishJobId: job.id } });
      confirmed++;
    } catch (error) { console.error(`[schedule confirmation ${job.id}]`, error instanceof Error ? error.message : String(error)); }
  }
  return confirmed;
}
