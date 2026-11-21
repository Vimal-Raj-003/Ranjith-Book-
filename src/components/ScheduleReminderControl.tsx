"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { useToast } from "./Toast";

const NextLink = ((Link as unknown as { default?: typeof Link }).default ?? Link);

export const REMINDER_SYNC_EVENT = "bookreel:reminder-changed";
const DESKTOP_NOTIFIED_STORAGE_KEY = "bookreel.reminder.desktop-notified";

export interface ScheduleReminderClientStatus {
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

export function broadcastReminderSync(detail?: { enabled?: boolean }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REMINDER_SYNC_EVENT, { detail }));
}

export function requestReminderBrowserPermission() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {
      // Permission prompt dismissed or blocked by browser policy; in-app alerts still work.
    });
  }
}

function BellIcon({ ringing = false }: { ringing?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={ringing ? "animate-pulse" : undefined}
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function useScheduleReminderController(options?: { notifyEffects?: boolean }) {
  const notifyEffects = options?.notifyEffects ?? true;
  const toast = useToast();
  const [status, setStatus] = useState<ScheduleReminderClientStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const announcedRef = useRef<string | null>(null);

  const triggerClientNotifications = useCallback(
    (next: ScheduleReminderClientStatus) => {
      if (!notifyEffects || !next.activeAlert || !next.lastScheduledDate || !next.message) return;
      const dedupeKey = `${next.lastScheduledDate}:${next.today}`;

      if (announcedRef.current !== dedupeKey) {
        announcedRef.current = dedupeKey;
        toast.show(next.message, "warn");
      }

      if (typeof window === "undefined") return;
      try {
        const prev = window.localStorage.getItem(DESKTOP_NOTIFIED_STORAGE_KEY);
        if (prev === dedupeKey) return;
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(next.title ?? "BookReel Schedule Reminder", {
            body: next.message,
            tag: `bookreel-schedule-reminder-${dedupeKey}`,
          });
          window.localStorage.setItem(DESKTOP_NOTIFIED_STORAGE_KEY, dedupeKey);
        }
      } catch {
        // Storage or Notification unavailable; in-app banner & toast remain active.
      }
    },
    [notifyEffects, toast],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/reminders", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ScheduleReminderClientStatus;
      setStatus(data);
      triggerClientNotifications(data);
    } catch {
      // Transient offline / reload state.
    }
  }, [triggerClientNotifications]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await refresh();
    };
    void load();

    const interval = setInterval(() => {
      void load();
    }, 30_000);

    const onFocus = () => {
      void load();
    };
    const onSync = (event: Event) => {
      const custom = event as CustomEvent<{ enabled?: boolean }>;
      if (typeof custom.detail?.enabled === "boolean") {
        const nextEnabled = custom.detail.enabled;
        setStatus((prev) => (prev ? { ...prev, enabled: nextEnabled } : prev));
      }
      void load();
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener(REMINDER_SYNC_EVENT, onSync);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(REMINDER_SYNC_EVENT, onSync);
    };
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        requestReminderBrowserPermission();
      }
      setSaving(true);
      setStatus((prev) => (prev ? { ...prev, enabled } : prev));
      try {
        const res = await fetch("/api/reminders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
          toast.show(strings.inspector.saveFailed, "error");
          await refresh();
          return;
        }
        const updated = (await res.json()) as ScheduleReminderClientStatus;
        setStatus(updated);
        broadcastReminderSync({ enabled: updated.enabled });
        triggerClientNotifications(updated);
      } catch {
        toast.show(strings.inspector.saveFailed, "error");
        await refresh();
      } finally {
        setSaving(false);
      }
    },
    [refresh, toast, triggerClientNotifications],
  );

  const dismissToday = useCallback(async () => {
    if (!status?.lastScheduledDate) return;
    setSaving(true);
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dismissForDate: status.lastScheduledDate }),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as ScheduleReminderClientStatus;
      setStatus(updated);
      broadcastReminderSync({ enabled: updated.enabled });
    } finally {
      setSaving(false);
    }
  }, [status?.lastScheduledDate]);

  return { status, saving, refresh, setEnabled, dismissToday };
}

export function ScheduleReminderAlertBanner({
  status,
  saving = false,
  onDismiss,
  showScheduleLink = true,
}: {
  status: ScheduleReminderClientStatus | null;
  saving?: boolean;
  onDismiss: () => void;
  showScheduleLink?: boolean;
}) {
  if (!status?.activeAlert || !status.message) return null;

  return (
    <div
      role="alert"
      data-reminder-alert="due"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-card)] border px-4 py-3"
      style={{
        borderColor: "color-mix(in srgb, var(--amber) 52%, var(--line))",
        background: "color-mix(in srgb, var(--amber) 10%, var(--slab))",
      }}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: "color-mix(in srgb, var(--amber) 20%, transparent)",
            color: "var(--amber)",
          }}
        >
          <BellIcon ringing />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="font-mono text-[10.5px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--amber)" }}
            >
              {strings.reminderPanel.heading}
            </span>
            {status.title && (
              <p className="font-display text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
                {status.title}
              </p>
            )}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: "var(--ink)" }}>
            {status.message}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {showScheduleLink && (
          <NextLink
            href="/schedule"
            className="inline-flex items-center rounded-[var(--r-control)] px-3 py-1.5 text-[12px] font-semibold"
            style={{ background: "var(--amber)", color: "var(--on-accent)" }}
          >
            {strings.reminderPanel.openSchedule}
          </NextLink>
        )}
        <button
          type="button"
          aria-disabled={saving}
          onClick={() => {
            if (!saving) onDismiss();
          }}
          className="rounded-[var(--r-control)] border px-2.5 py-1.5 font-mono text-[11.5px]"
          style={{ borderColor: "var(--line-2)", color: "var(--mute)" }}
        >
          {strings.reminderPanel.dismissToday}
        </button>
      </div>
    </div>
  );
}

export function ReminderTopButton({
  status,
  saving = false,
  onToggleEnabled,
  showScheduleLink = true,
}: {
  status: ScheduleReminderClientStatus | null;
  saving?: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  showScheduleLink?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const groupLabelId = useId();
  const enabled = status?.enabled ?? false;
  const activeAlert = status?.activeAlert ?? false;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-flex items-center">
      <button
        type="button"
        data-reminder-button="top"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-[var(--r-control)] border px-3 py-1.5 text-[12.5px] font-medium transition-colors"
        style={{
          borderColor: activeAlert
            ? "color-mix(in srgb, var(--amber) 65%, var(--line))"
            : enabled
              ? "color-mix(in srgb, var(--cyan) 45%, var(--line))"
              : "var(--line)",
          background: activeAlert
            ? "color-mix(in srgb, var(--amber) 12%, var(--slab))"
            : "var(--slab)",
          color: "var(--ink)",
        }}
      >
        <span style={{ color: activeAlert ? "var(--amber)" : enabled ? "var(--cyan)" : "var(--mute)" }}>
          <BellIcon ringing={activeAlert} />
        </span>
        <span>{strings.reminderPanel.button}</span>
        <span
          data-reminder-badge={enabled ? "on" : "off"}
          className="rounded-full px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase leading-none"
          style={{
            background: enabled
              ? "color-mix(in srgb, var(--cyan) 18%, transparent)"
              : "var(--slab-2)",
            color: enabled ? "var(--cyan)" : "var(--mute)",
          }}
        >
          {enabled ? strings.reminderPanel.on : strings.reminderPanel.off}
        </span>
        {activeAlert && (
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ background: "var(--amber)", boxShadow: "0 0 8px var(--amber)" }}
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={strings.reminderPanel.heading}
          data-reminder-popover="open"
          className="absolute right-0 top-full z-50 mt-2 w-[320px] rounded-[var(--r-card)] border p-3.5 shadow-2xl"
          style={{
            borderColor: "var(--line-2)",
            background: "var(--slab)",
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <span
                id={groupLabelId}
                className="font-display text-[13.5px] font-semibold"
                style={{ color: "var(--ink)" }}
              >
                {strings.reminderPanel.toggleLabel}
              </span>
              <p className="text-[11px]" style={{ color: "var(--mute-2)" }}>
                {enabled ? "Active · automatic daily check" : "Paused"}
              </p>
            </div>

            <div
              role="group"
              aria-labelledby={groupLabelId}
              className="inline-flex rounded-[var(--r-control)] border p-0.5"
              style={{ borderColor: "var(--line)", background: "var(--void)" }}
            >
              <button
                type="button"
                data-reminder-toggle="on"
                aria-pressed={enabled}
                aria-disabled={saving}
                onClick={() => {
                  if (!saving && !enabled) onToggleEnabled(true);
                }}
                className="rounded-[6px] px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors"
                style={{
                  background: enabled ? "var(--cyan)" : "transparent",
                  color: enabled ? "var(--on-accent)" : "var(--mute)",
                }}
              >
                {strings.reminderPanel.on}
              </button>
              <button
                type="button"
                data-reminder-toggle="off"
                aria-pressed={!enabled}
                aria-disabled={saving}
                onClick={() => {
                  if (!saving && enabled) onToggleEnabled(false);
                }}
                className="rounded-[6px] px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors"
                style={{
                  background: !enabled ? "var(--slab-2)" : "transparent",
                  color: !enabled ? "var(--ink)" : "var(--mute)",
                }}
              >
                {strings.reminderPanel.off}
              </button>
            </div>
          </div>

          <div
            className="mt-3 rounded-[var(--r-control)] border p-2.5 text-[11.5px] leading-relaxed"
            style={{
              borderColor: activeAlert
                ? "color-mix(in srgb, var(--amber) 45%, var(--line))"
                : "var(--line)",
              background: activeAlert
                ? "color-mix(in srgb, var(--amber) 8%, var(--void))"
                : "var(--void)",
              color: activeAlert ? "var(--ink)" : "var(--mute)",
            }}
          >
            {status ? (
              <>
                <div className="mb-1.5 flex items-center justify-between gap-2 font-mono text-[10.5px]">
                  <span style={{ color: "var(--mute-2)" }}>Last scheduled date</span>
                  <span style={{ color: "var(--ink)" }}>
                    {status.lastScheduledDateFormatted ?? "None yet"}
                  </span>
                </div>
                {status.followingDateFormatted && (
                  <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[10.5px]">
                    <span style={{ color: "var(--mute-2)" }}>Following day</span>
                    <span style={{ color: status.due ? "var(--amber)" : "var(--mute)" }}>
                      {status.followingDateFormatted}{" "}
                      {status.hasVideosForFollowingDay ? "(scheduled)" : "(0 videos)"}
                    </span>
                  </div>
                )}
                <p>{status.statusSummary}</p>
              </>
            ) : (
              <p>{strings.reminderPanel.hint}</p>
            )}
          </div>

          {showScheduleLink && (
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-[11px]" style={{ color: "var(--mute-2)" }}>
                Automatic schedule check
              </span>
              <NextLink
                href="/schedule"
                onClick={() => setOpen(false)}
                className="font-mono text-[11.5px] font-medium underline underline-offset-4"
                style={{ color: "var(--cyan)" }}
              >
                Open Weekly Schedule
              </NextLink>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent top-of-workspace bar for Studio / Book PDFs / Library / Free Books:
 * surfaces the Reminder button + On/Off toggle at the top of the application and
 * displays the automatic reminder alert banner whenever today is the user's last
 * scheduled day with zero videos scheduled for tomorrow.
 */
export default function ScheduleReminderTopBar() {
  const { status, saving, setEnabled, dismissToday } = useScheduleReminderController();

  return (
    <div className="flex flex-col gap-2.5" data-reminder-topbar>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <NextLink
          href="/schedule"
          className="inline-flex items-center rounded-[var(--r-control)] border px-3 py-1.5 font-mono text-[11.5px]"
          style={{ borderColor: "var(--line)", background: "var(--slab)", color: "var(--mute)" }}
        >
          {strings.schedule.button}
        </NextLink>
        <ReminderTopButton
          status={status}
          saving={saving}
          onToggleEnabled={(next) => void setEnabled(next)}
          showScheduleLink
        />
      </div>

      <ScheduleReminderAlertBanner
        status={status}
        saving={saving}
        onDismiss={() => void dismissToday()}
        showScheduleLink
      />
    </div>
  );
}
