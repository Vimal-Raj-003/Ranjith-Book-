export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ startScheduleWorker }, { startScheduleReminderMonitor }] = await Promise.all([
      import("./lib/schedule/worker"),
      import("./lib/schedule/reminder"),
    ]);
    startScheduleWorker();
    startScheduleReminderMonitor();
  }
}
