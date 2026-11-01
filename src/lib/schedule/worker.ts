/** One startup worker for BookReel's existing slots. Execution is opt-in. */
import { prisma } from "@/lib/db";
import { recoverInterruptedBrowserJobs } from "@/lib/publish/browser/recover";
import { publishingEnabled } from "@/lib/publish/execution";
import { recoverYouTubeUploads } from "@/lib/publish/youtube/run";
import { runSchedule, slotOutcome, type RunScheduleOptions } from "./activate";
import { confirmKnownSchedules } from "./confirm";
import { runImmediateQueue } from "@/lib/publish/immediate-queue";

const state = globalThis as unknown as { bookreelScheduleTimer?: ReturnType<typeof setInterval>; bookreelQueueBusy?: boolean; bookreelConfirmationAt?: number };

export async function processScheduleQueue(options: RunScheduleOptions = {}): Promise<void> {
  if (state.bookreelQueueBusy) return;
  state.bookreelQueueBusy = true;
  try {
    await recoverInterruptedBrowserJobs();
    await recoverYouTubeUploads();
    await runImmediateQueue(options);
    if (options.verifyKnownSchedule || (!options.makePublisher && !process.env.BOOKREEL_TEST_DB_PID && Date.now() - (state.bookreelConfirmationAt ?? 0) >= 10 * 60_000)) {
      state.bookreelConfirmationAt = Date.now();
      await confirmKnownSchedules({ env: options.env, verify: options.verifyKnownSchedule });
    }
    // Historical active plans remain excluded until explicitly reactivated.
    const plans = await prisma.weeklySchedule.findMany({ where: { status: "active", workflowVersion: 2 }, orderBy: { createdAt: "asc" } });
    for (const plan of plans) {
      const interrupted = await prisma.scheduleSlot.findMany({ where: { scheduleId: plan.id, status: "scheduling" } });
      for (const slot of interrupted) {
        const job = await prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId: slot.episodeId, platform: slot.platform } } });
        if (job && ["PREPARING", "UPLOADING"].includes(job.status)) continue;
        const outcome = job && job.status !== "QUEUED" ? slotOutcome(job, slot.assignedAt, plan.timezone) : { status: "pending", note: null };
        await prisma.scheduleSlot.updateMany({ where: { id: slot.id, status: "scheduling", updatedAt: slot.updatedAt }, data: { status: outcome.status, note: outcome.note, publishJobId: job?.id } });
      }
    }
    await Promise.all((["youtube", "instagram"] as const).map(async platform => {
      if (!publishingEnabled(platform, options.env ?? process.env)) return;
      for (const plan of plans) await runSchedule(plan.id, { ...options, platform, automatic: true });
    }));
  } finally { state.bookreelQueueBusy = false; }
}

export function startScheduleWorker(): void {
  // Deployment opt-in, left OFF during debugging. Tests call the pass directly
  // with mock publishers and isolated databases; no timer runs under tests.
  if (process.env.BOOKREEL_TEST_DB_PID || process.env.BOOKREEL_SCHEDULE_WORKER_ENABLED !== "1" || state.bookreelScheduleTimer) return;
  const tick = () => void processScheduleQueue().catch(error => console.error("[schedule worker]", error instanceof Error ? error.message : String(error)));
  state.bookreelScheduleTimer = setInterval(tick, 30_000);
  state.bookreelScheduleTimer.unref?.();
  tick();
}
