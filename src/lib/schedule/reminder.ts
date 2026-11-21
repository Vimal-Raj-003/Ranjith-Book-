import { getSetting, prisma, setSetting } from "@/lib/db";
import { sendScheduleReminderEmail } from "@/lib/auth/mailer";
import { strings } from "@/lib/strings";
import {
  DEFAULT_TIMEZONE,
  addDays,
  isValidDate,
  isValidZone,
  localParts,
  todayIn,
} from "./reference-time";

export interface ScheduleReminderPersistedState {
  notifiedLastDate?: string;
  notifiedFollowingDate?: string;
  notifiedAt?: string;
  emailSent?: boolean;
  dismissedForLastDate?: string;
  dismissedOnDay?: string;
}

export interface ScheduleReminderStatus {
  enabled: boolean;
  timezone: string;
  today: string;
  todayFormatted: string;
  scheduledDates: string[];
  lastScheduledDate: string | null;
  lastScheduledDateFormatted: string | null;
  followingDate: string | null;
  followingDateFormatted: string | null;
  hasVideosForFollowingDay: boolean;
  due: boolean;
  dismissedToday: boolean;
  activeAlert: boolean;
  title: string | null;
  message: string | null;
  statusSummary: string;
}

export interface DispatchedScheduleReminder {
  userId: string;
  email: string;
  lastScheduledDate: string;
  followingDate: string;
  emailSent: boolean;
}

const REMINDER_STATE_PREFIX = "scheduleReminderState:";

const dateDisplayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Formats a `YYYY-MM-DD` calendar string as e.g. `"16 Nov 2026"`. */
export function formatReminderDate(ymd: string): string {
  if (!isValidDate(ymd)) return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  return dateDisplayFormatter.format(new Date(Date.UTC(y, m - 1, d)));
}

function stateKeyForUser(userId: string): string {
  return `${REMINDER_STATE_PREFIX}${userId}`;
}

async function readReminderState(userId: string): Promise<ScheduleReminderPersistedState> {
  const raw = await getSetting(stateKeyForUser(userId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ScheduleReminderPersistedState;
    }
  } catch {
    // Ignore malformed legacy state.
  }
  return {};
}

async function writeReminderState(userId: string, state: ScheduleReminderPersistedState): Promise<void> {
  await setSetting(stateKeyForUser(userId), JSON.stringify(state));
}

export async function dismissScheduleReminderForToday(
  userId: string,
  forLastDate: string,
  options?: { now?: Date; timezone?: string },
): Promise<void> {
  if (!isValidDate(forLastDate)) return;
  const current = await readReminderState(userId);
  const zone = options?.timezone && isValidZone(options.timezone) ? options.timezone : DEFAULT_TIMEZONE;
  const today = todayIn(zone, options?.now ?? new Date());
  await writeReminderState(userId, {
    ...current,
    dismissedForLastDate: forLastDate,
    dismissedOnDay: today,
  });
}

export async function clearScheduleReminderDismissal(userId: string): Promise<void> {
  const current = await readReminderState(userId);
  if (!current.dismissedForLastDate && !current.dismissedOnDay) return;
  const next: ScheduleReminderPersistedState = { ...current };
  delete next.dismissedForLastDate;
  delete next.dismissedOnDay;
  await writeReminderState(userId, next);
}

/**
 * Inspects the user's active schedule slots and confirmed scheduled publish jobs,
 * finds the last scheduled calendar date, and determines whether today is that
 * last scheduled date with zero videos scheduled for the following day.
 */
export async function evaluateScheduleReminder(
  userId: string,
  options?: { now?: Date; timezone?: string },
): Promise<ScheduleReminderStatus> {
  const now = options?.now ?? new Date();
  const [rawEnabled, plans, scheduledPublishJobs, persistedState] = await Promise.all([
    getSetting("scheduleReminder"),
    prisma.weeklySchedule.findMany({
      where: { userId, status: "active" },
      orderBy: { createdAt: "desc" },
      select: { id: true, timezone: true },
    }),
    prisma.publishJob.findMany({
      where: {
        episode: { userId },
        status: "SCHEDULED",
        scheduledFor: { not: null },
      },
      select: { scheduledFor: true },
    }),
    readReminderState(userId),
  ]);

  const enabled = rawEnabled === "on";
  const planZone = plans.find((p) => isValidZone(p.timezone))?.timezone;
  const timezone =
    options?.timezone && isValidZone(options.timezone)
      ? options.timezone
      : planZone ?? DEFAULT_TIMEZONE;

  const planZoneById = new Map<string, string>();
  for (const plan of plans) {
    planZoneById.set(plan.id, isValidZone(plan.timezone) ? plan.timezone : timezone);
  }

  const activeSlots =
    plans.length > 0
      ? await prisma.scheduleSlot.findMany({
          where: {
            scheduleId: { in: plans.map((p) => p.id) },
            controlState: "active",
            episodeId: { not: "" },
            status: { in: ["pending", "scheduling", "scheduled", "published"] },
          },
          select: { scheduleId: true, assignedAt: true },
        })
      : [];

  const dateSet = new Set<string>();
  for (const slot of activeSlots) {
    const slotZone = planZoneById.get(slot.scheduleId) ?? timezone;
    dateSet.add(localParts(slot.assignedAt, slotZone).date);
  }
  for (const job of scheduledPublishJobs) {
    if (job.scheduledFor) {
      dateSet.add(localParts(job.scheduledFor, timezone).date);
    }
  }

  const scheduledDates = Array.from(dateSet).sort();
  const today = todayIn(timezone, now);
  const todayFormatted = formatReminderDate(today);

  const lastScheduledDate =
    scheduledDates.length > 0 ? scheduledDates[scheduledDates.length - 1]! : null;
  const lastScheduledDateFormatted = lastScheduledDate
    ? formatReminderDate(lastScheduledDate)
    : null;

  const followingDate = lastScheduledDate ? addDays(lastScheduledDate, 1) : null;
  const followingDateFormatted = followingDate ? formatReminderDate(followingDate) : null;

  const hasVideosForFollowingDay = followingDate ? dateSet.has(followingDate) : false;

  const due = Boolean(
    enabled &&
      lastScheduledDate !== null &&
      followingDate !== null &&
      today === lastScheduledDate &&
      !hasVideosForFollowingDay,
  );

  const dismissedToday = Boolean(
    due &&
      persistedState.dismissedForLastDate === lastScheduledDate &&
      persistedState.dismissedOnDay === today,
  );

  const activeAlert = due && !dismissedToday;

  const title =
    due && followingDateFormatted
      ? strings.reminderPanel.dueTitle(followingDateFormatted)
      : null;
  const message =
    due && lastScheduledDateFormatted && followingDateFormatted
      ? strings.reminderPanel.dueMessage(lastScheduledDateFormatted, followingDateFormatted)
      : null;

  let statusSummary: string;
  if (due && message) {
    statusSummary = message;
  } else if (!lastScheduledDate || !lastScheduledDateFormatted || !followingDateFormatted) {
    statusSummary = enabled
      ? strings.reminderPanel.noScheduleNote
      : strings.reminderPanel.disabledNote;
  } else if (lastScheduledDate < today) {
    statusSummary = enabled
      ? strings.reminderPanel.pastScheduleNote(lastScheduledDateFormatted)
      : `${strings.reminderPanel.disabledNote} (${strings.reminderPanel.pastScheduleNote(lastScheduledDateFormatted)})`;
  } else if (enabled) {
    statusSummary = strings.reminderPanel.scheduledUpTo(
      lastScheduledDateFormatted,
      followingDateFormatted,
    );
  } else {
    statusSummary = `Reminders are off · Videos scheduled up to ${lastScheduledDateFormatted}.`;
  }

  return {
    enabled,
    timezone,
    today,
    todayFormatted,
    scheduledDates,
    lastScheduledDate,
    lastScheduledDateFormatted,
    followingDate,
    followingDateFormatted,
    hasVideosForFollowingDay,
    due,
    dismissedToday,
    activeAlert,
    title,
    message,
    statusSummary,
  };
}

/**
 * Evaluates schedule reminders across accounts when `scheduleReminder === "on"`
 * and dispatches one notification record (plus optional SMTP email) per
 * `(userId, lastScheduledDate)` when today reaches the last scheduled day with
 * zero videos scheduled for tomorrow.
 */
export async function checkAndDispatchScheduleReminders(options?: {
  now?: Date;
  sendEmail?: typeof sendScheduleReminderEmail;
  scheduleUrl?: string;
}): Promise<DispatchedScheduleReminder[]> {
  const enabled = (await getSetting("scheduleReminder")) === "on";
  if (!enabled) return [];

  const now = options?.now ?? new Date();
  const sendEmailFn = options?.sendEmail ?? sendScheduleReminderEmail;
  const users = await prisma.user.findMany({
    select: { id: true, email: true },
  });

  const dispatched: DispatchedScheduleReminder[] = [];

  for (const user of users) {
    const status = await evaluateScheduleReminder(user.id, { now });
    if (
      !status.due ||
      !status.lastScheduledDate ||
      !status.followingDate ||
      !status.lastScheduledDateFormatted ||
      !status.followingDateFormatted
    ) {
      continue;
    }

    const current = await readReminderState(user.id);
    if (current.notifiedLastDate === status.lastScheduledDate) {
      continue;
    }

    const emailSent = await sendEmailFn(user.email, {
      lastScheduledDateFormatted: status.lastScheduledDateFormatted,
      followingDateFormatted: status.followingDateFormatted,
      scheduleUrl: options?.scheduleUrl,
    });

    await writeReminderState(user.id, {
      ...current,
      notifiedLastDate: status.lastScheduledDate,
      notifiedFollowingDate: status.followingDate,
      notifiedAt: now.toISOString(),
      emailSent,
    });

    console.info(
      `[schedule reminder] Reminder triggered for ${user.email}: scheduled up to ${status.lastScheduledDate}, no videos scheduled for ${status.followingDate}.`,
    );

    dispatched.push({
      userId: user.id,
      email: user.email,
      lastScheduledDate: status.lastScheduledDate,
      followingDate: status.followingDate,
      emailSent,
    });
  }

  return dispatched;
}

const reminderGlobal = globalThis as unknown as {
  bookreelReminderTimer?: ReturnType<typeof setInterval>;
  bookreelReminderBusy?: boolean;
};

/**
 * Lightweight background monitor that checks the user's video schedule every
 * 60 seconds while the server is running so reminders fire automatically on
 * the last scheduled day whenever the Reminder toggle is On.
 */
export function startScheduleReminderMonitor(): void {
  if (process.env.BOOKREEL_TEST_DB_PID || reminderGlobal.bookreelReminderTimer) return;

  const runTick = async () => {
    if (reminderGlobal.bookreelReminderBusy) return;
    reminderGlobal.bookreelReminderBusy = true;
    try {
      await checkAndDispatchScheduleReminders();
    } catch (err) {
      console.error(
        "[schedule reminder]",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      reminderGlobal.bookreelReminderBusy = false;
    }
  };

  reminderGlobal.bookreelReminderTimer = setInterval(() => {
    void runTick();
  }, 60_000);
  reminderGlobal.bookreelReminderTimer.unref?.();
  void runTick();
}
