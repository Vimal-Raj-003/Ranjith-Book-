import { localParts, zoneLabel } from "./reference-time";

interface TimedJob {
  status: string;
  nativeSchedule: boolean;
  startAt: string | null;
  publishAt: string | null;
}

/** Show the upload trigger separately from the intended publication time. */
export function jobTiming(job: TimedJob, platform: string, timezone: string): string {
  if (job.status !== "SCHEDULED" && job.status !== "PUBLISHING") return "";

  const when = (iso: string) => {
    const { date, time } = localParts(new Date(iso), timezone);
    return `${date}, ${time} ${zoneLabel(timezone)}`;
  };
  const parts: string[] = [];
  if (job.status === "SCHEDULED" && job.startAt) parts.push(`Upload starts ${when(job.startAt)}.`);
  if (job.publishAt) parts.push(`Target publish time: ${when(job.publishAt)}.`);
  if (job.nativeSchedule) parts.push(`${platform} scheduling is not confirmed yet.`);
  return parts.join(" ");
}
