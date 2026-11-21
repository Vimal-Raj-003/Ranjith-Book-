import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma, setSetting } from "../src/lib/db";
import { SETTING_FALLBACKS, isSettingKey, validateSetting } from "../src/lib/settings/keys";
import { zonedInstant } from "../src/lib/schedule/reference-time";
import {
  checkAndDispatchScheduleReminders,
  clearScheduleReminderDismissal,
  dismissScheduleReminderForToday,
  evaluateScheduleReminder,
  formatReminderDate,
} from "../src/lib/schedule/reminder";
import * as inspectorModule from "../src/components/Inspector";
import { ToastHost } from "../src/components/Toast";
import {
  ReminderTopButton,
  ScheduleReminderAlertBanner,
} from "../src/components/ScheduleReminderControl";
import { strings } from "../src/lib/strings";
import { requireIsolatedDatabase } from "./setup/isolation";

function unwrap(mod: unknown): React.ComponentType<Record<string, unknown>> {
  const d = (mod as { default: unknown }).default as { default?: unknown };
  return (d?.default ?? d) as React.ComponentType<Record<string, unknown>>;
}
const Inspector = unwrap(inspectorModule);

after(async () => {
  await prisma.$disconnect();
});

test("scheduleReminder setting key validates strictly as on/off and defaults to off", () => {
  assert.equal(isSettingKey("scheduleReminder"), true);
  assert.equal(SETTING_FALLBACKS.scheduleReminder, "off");
  assert.equal(validateSetting("scheduleReminder", "on"), "on");
  assert.equal(validateSetting("scheduleReminder", "off"), "off");
  assert.equal(validateSetting("scheduleReminder", "yes"), null);
  assert.equal(validateSetting("scheduleReminder", true), null);
});

test("Settings Inspector and Top Reminder controls render On/Off toggle and due alert banner", () => {
  const openHtml = renderToStaticMarkup(
    React.createElement(ToastHost, null, React.createElement(Inspector, { episode: null })),
  );
  assert.match(openHtml, /reminder-group/, "Settings rail includes the Reminder group");
  assert.match(openHtml, /data-settings-reminder="on"/, "Settings rail includes Reminder On button");
  assert.match(openHtml, /data-settings-reminder="off"/, "Settings rail includes Reminder Off button");

  const foldedHtml = renderToStaticMarkup(
    React.createElement(
      ToastHost,
      null,
      React.createElement(Inspector, { episode: null, collapsed: true, onToggleCollapsed: () => {} }),
    ),
  );
  assert.ok(
    foldedHtml.includes(`aria-label="${strings.layout.openSettingsFor(strings.reminderPanel.summaryUnknown)}"`),
    "Folded Settings rail includes the Reminder chip",
  );

  const topButtonHtml = renderToStaticMarkup(
    React.createElement(ReminderTopButton, {
      status: null,
      onToggleEnabled: () => {},
    }),
  );
  assert.match(topButtonHtml, /data-reminder-button="top"/);
  assert.match(topButtonHtml, /Reminder/);

  const bannerHtml = renderToStaticMarkup(
    React.createElement(ScheduleReminderAlertBanner, {
      status: {
        enabled: true,
        timezone: "Asia/Kolkata",
        today: "2026-11-16",
        todayFormatted: "16 Nov 2026",
        scheduledDates: ["2026-11-15", "2026-11-16"],
        lastScheduledDate: "2026-11-16",
        lastScheduledDateFormatted: "16 Nov 2026",
        followingDate: "2026-11-17",
        followingDateFormatted: "17 Nov 2026",
        hasVideosForFollowingDay: false,
        due: true,
        dismissedToday: false,
        activeAlert: true,
        title: strings.reminderPanel.dueTitle("17 Nov 2026"),
        message: strings.reminderPanel.dueMessage("16 Nov 2026", "17 Nov 2026"),
        statusSummary: strings.reminderPanel.dueMessage("16 Nov 2026", "17 Nov 2026"),
      },
      onDismiss: () => {},
    }),
  );
  assert.match(bannerHtml, /data-reminder-alert="due"/);
  assert.match(bannerHtml, /16 Nov 2026/);
  assert.match(bannerHtml, /17 Nov 2026/);
});

test("automatic schedule monitoring triggers reminder on the 16th when no videos are scheduled for the 17th", async () => {
  requireIsolatedDatabase();

  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { email: `reminder-${suffix}@example.com` },
  });

  const book = await prisma.book.create({
    data: { title: "Reminder Test Book" },
  });
  const upload = await prisma.upload.create({
    data: { userId: user.id, bookId: book.id, status: "DONE" },
  });
  const ep15 = await prisma.episode.create({
    data: { userId: user.id, bookId: book.id, uploadId: upload.id, title: "Day 15 Video", status: "DONE" },
  });
  const ep16 = await prisma.episode.create({
    data: { userId: user.id, bookId: book.id, uploadId: upload.id, title: "Day 16 Video", status: "DONE" },
  });
  const ep17 = await prisma.episode.create({
    data: { userId: user.id, bookId: book.id, uploadId: upload.id, title: "Day 17 Video", status: "DONE" },
  });

  const schedule = await prisma.weeklySchedule.create({
    data: {
      userId: user.id,
      uploadId: upload.id,
      boardGrid: true,
      name: "Mid-November Schedule",
      timezone: "Asia/Kolkata",
      weekStart: new Date("2026-11-15T00:00:00.000Z"),
      days: 2,
      timeSlots: JSON.stringify(["09:00"]),
      status: "active",
      workflowVersion: 2,
    },
  });

  await prisma.scheduleSlot.createMany({
    data: [
      {
        scheduleId: schedule.id,
        episodeId: ep15.id,
        platform: "youtube",
        position: 0,
        assignedAt: zonedInstant("2026-11-15", "09:00", "Asia/Kolkata"),
        status: "scheduled",
        controlState: "active",
      },
      {
        scheduleId: schedule.id,
        episodeId: ep16.id,
        platform: "youtube",
        position: 1,
        assignedAt: zonedInstant("2026-11-16", "09:00", "Asia/Kolkata"),
        status: "scheduled",
        controlState: "active",
      },
    ],
  });

  assert.equal(formatReminderDate("2026-11-16"), "16 Nov 2026");
  assert.equal(formatReminderDate("2026-11-17"), "17 Nov 2026");

  // 1. Toggle OFF on the 16th: detects lastScheduledDate = 2026-11-16, but does NOT fire reminder.
  await setSetting("scheduleReminder", "off");
  const on16WhileOff = await evaluateScheduleReminder(user.id, {
    now: zonedInstant("2026-11-16", "10:00", "Asia/Kolkata"),
  });
  assert.equal(on16WhileOff.enabled, false);
  assert.equal(on16WhileOff.lastScheduledDate, "2026-11-16");
  assert.equal(on16WhileOff.followingDate, "2026-11-17");
  assert.equal(on16WhileOff.due, false);
  assert.equal(on16WhileOff.activeAlert, false);

  const sentWhileOff = await checkAndDispatchScheduleReminders({
    now: zonedInstant("2026-11-16", "10:00", "Asia/Kolkata"),
    sendEmail: async () => true,
  });
  assert.equal(sentWhileOff.length, 0);

  // 2. Toggle ON, checked on the 15th (day BEFORE lastScheduledDate): not due yet.
  await setSetting("scheduleReminder", "on");
  const on15WhileOn = await evaluateScheduleReminder(user.id, {
    now: zonedInstant("2026-11-15", "14:00", "Asia/Kolkata"),
  });
  assert.equal(on15WhileOn.enabled, true);
  assert.equal(on15WhileOn.lastScheduledDate, "2026-11-16");
  assert.equal(on15WhileOn.followingDate, "2026-11-17");
  assert.equal(on15WhileOn.hasVideosForFollowingDay, false);
  assert.equal(on15WhileOn.due, false);

  // 3. Toggle ON, checked on the 16th itself (lastScheduledDate, 0 videos on 17th): FIRES!
  const on16WhileOn = await evaluateScheduleReminder(user.id, {
    now: zonedInstant("2026-11-16", "10:30", "Asia/Kolkata"),
  });
  assert.equal(on16WhileOn.enabled, true);
  assert.equal(on16WhileOn.today, "2026-11-16");
  assert.equal(on16WhileOn.lastScheduledDate, "2026-11-16");
  assert.equal(on16WhileOn.followingDate, "2026-11-17");
  assert.equal(on16WhileOn.hasVideosForFollowingDay, false);
  assert.equal(on16WhileOn.due, true);
  assert.equal(on16WhileOn.activeAlert, true);
  assert.match(on16WhileOn.message ?? "", /16 Nov 2026/);
  assert.match(on16WhileOn.message ?? "", /17 Nov 2026/);

  // 4. Background dispatcher sends once on the 16th and deduplicates repeat ticks.
  const emailedTo: string[] = [];
  const firstPass = await checkAndDispatchScheduleReminders({
    now: zonedInstant("2026-11-16", "10:30", "Asia/Kolkata"),
    sendEmail: async (to, info) => {
      emailedTo.push(`${to}:${info.lastScheduledDateFormatted}->${info.followingDateFormatted}`);
      return true;
    },
  });
  assert.ok(firstPass.some((d) => d.userId === user.id && d.lastScheduledDate === "2026-11-16" && d.followingDate === "2026-11-17"));
  assert.deepEqual(
    emailedTo.filter((entry) => entry.startsWith(user.email)),
    [`${user.email}:16 Nov 2026->17 Nov 2026`],
  );

  const secondPassSameDay = await checkAndDispatchScheduleReminders({
    now: zonedInstant("2026-11-16", "18:00", "Asia/Kolkata"),
    sendEmail: async () => {
      throw new Error("Should not send duplicate reminder for same lastScheduledDate");
    },
  });
  assert.equal(secondPassSameDay.filter((d) => d.userId === user.id).length, 0);

  // 5. Per-day dismissal hides activeAlert, and re-enabling clears dismissal.
  await dismissScheduleReminderForToday(user.id, "2026-11-16", {
    now: zonedInstant("2026-11-16", "11:00", "Asia/Kolkata"),
    timezone: "Asia/Kolkata",
  });
  const afterDismiss = await evaluateScheduleReminder(user.id, {
    now: zonedInstant("2026-11-16", "11:05", "Asia/Kolkata"),
  });
  assert.equal(afterDismiss.due, true);
  assert.equal(afterDismiss.dismissedToday, true);
  assert.equal(afterDismiss.activeAlert, false);

  await clearScheduleReminderDismissal(user.id);
  const afterReenable = await evaluateScheduleReminder(user.id, {
    now: zonedInstant("2026-11-16", "11:10", "Asia/Kolkata"),
  });
  assert.equal(afterReenable.activeAlert, true);

  // 6. User schedules a video for the 17th -> reminder on the 16th clears, and next reminder fires on the 17th for the 18th!
  await prisma.scheduleSlot.create({
    data: {
      scheduleId: schedule.id,
      episodeId: ep17.id,
      platform: "youtube",
      position: 2,
      assignedAt: zonedInstant("2026-11-17", "09:00", "Asia/Kolkata"),
      status: "scheduled",
      controlState: "active",
    },
  });

  const on16AfterScheduling17 = await evaluateScheduleReminder(user.id, {
    now: zonedInstant("2026-11-16", "12:00", "Asia/Kolkata"),
  });
  assert.equal(on16AfterScheduling17.lastScheduledDate, "2026-11-17");
  assert.equal(on16AfterScheduling17.followingDate, "2026-11-18");
  assert.equal(on16AfterScheduling17.due, false);
  assert.equal(on16AfterScheduling17.activeAlert, false);

  const on17Pass = await checkAndDispatchScheduleReminders({
    now: zonedInstant("2026-11-17", "09:30", "Asia/Kolkata"),
    sendEmail: async () => true,
  });
  assert.ok(
    on17Pass.some(
      (d) =>
        d.userId === user.id &&
        d.lastScheduledDate === "2026-11-17" &&
        d.followingDate === "2026-11-18",
    ),
  );
});
