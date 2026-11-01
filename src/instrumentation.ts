export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduleWorker } = await import("./lib/schedule/worker");
    startScheduleWorker();
  }
}
