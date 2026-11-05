/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page, Response } from "playwright-core";
import { formatLocal } from "../../schedule/reference-time";

export interface ScheduledReel {
  id: string;
  mediaId: string;
  caption: string;
  publishAt: string;
}

export interface InstagramCalendar {
  userId: string;
  items: ScheduledReel[];
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The complete list used by Instagram's own /scheduled_content/ calendar, not a write API. */
export function parseInstagramCalendar(value: unknown): InstagramCalendar | null {
  const data = object(object(value)?.data);
  const user = object(object(data?.viewer)?.xdt_user);
  if (!user || typeof user.id !== "string" || !Array.isArray(user.all_scheduled_ig_content)) return null;
  const items: ScheduledReel[] = [];
  for (const raw of user.all_scheduled_ig_content) {
    const row = object(raw);
    const media = object(row?.media);
    const seconds = row?.scheduled_publish_time;
    if (!row || typeof row.id !== "string" || typeof row.caption_text !== "string" ||
        typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 ||
        typeof media?.id !== "string") return null; // Never treat an unreadable item as an empty calendar.
    const at = new Date(seconds * 1000);
    if (!Number.isFinite(at.getTime())) return null;
    items.push({ id: row.id, mediaId: media.id, caption: row.caption_text, publishAt: at.toISOString() });
  }
  return { userId: user.id, items };
}

const squash = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
export const sameInstagramCaption = (a: string, b: string) => squash(a) === squash(b);

/** A conservative preparation margin, checked before uploading and again before Schedule. */
export function instagramScheduleTimeProblem(at: Date | null, now: Date, zone: string): string | null {
  if (!at || !Number.isFinite(at.getTime())) return "This Instagram job has no valid future publication time. Nothing was uploaded or shared.";
  if (at.getTime() - now.getTime() < 20 * 60_000) return `Instagram's intended time, ${formatLocal(at, zone)}, is less than 20 minutes away or has passed. Choose a later time explicitly; nothing will be shared immediately.`;
  return null;
}
const repos = (text: string) => [...text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/gi)]
  .map(m => m[1].replace(/[.,;:!?]+$/, "").replace(/\.git$/i, "").toLowerCase());

export interface InstagramScheduleIdentity {
  caption: string;
  repoUrl: string;
  publishAt: Date;
  remoteContainerId?: string | null;
  minGapMinutes?: number;
}

export type CalendarVerdict =
  | { kind: "confirmed"; item: ScheduledReel }
  | { kind: "clear" }
  | { kind: "blocked"; reason: string; safeToContinue?: true };

/** A calendar spacing refusal occurs before selecting a file; other videos can proceed. */
export function isPreUploadSpacingConflict(job: {platform:string;lastError:string|null;externalId:string|null;remoteDraftId:string|null;sessionUrlEnc:string|null} | null): boolean {
  return !!job && job.platform === "instagram" && !job.externalId && !job.remoteDraftId && !job.sessionUrlEnc &&
    /^Another Instagram post is within \d+ minutes of this time\. Nothing was uploaded or rescheduled\.$/.test(job.lastError??"");
}

/** Adopt only exact copy + exact instant; related or uncertain remote uploads block a retry. */
export function judgeInstagramCalendar(calendar: InstagramCalendar, expected: InstagramScheduleIdentity): CalendarVerdict {
  const source = new Set(repos(expected.repoUrl));
  const related = calendar.items.filter(item => item.id === expected.remoteContainerId ||
    squash(item.caption) === squash(expected.caption) || repos(item.caption).some(repo => source.has(repo)));
  if (related.length) {
    const exact = related.filter(item => squash(item.caption) === squash(expected.caption) &&
      new Date(item.publishAt).getTime() === expected.publishAt.getTime());
    if (related.length === 1 && exact.length === 1) return { kind: "confirmed", item: exact[0] };
    return { kind: "blocked", reason: "Instagram already has scheduled content for this video or repository, but its caption, time, or number of copies differs. Inspect Scheduled content before retrying; nothing was uploaded or changed." };
  }
  if (expected.remoteContainerId) return { kind: "blocked", reason: "An earlier upload may have left a draft or an unconfirmed schedule. Check Instagram's drafts and Scheduled content before retrying; no second upload was started." };
  const gap = (expected.minGapMinutes ?? 30) * 60_000;
  if (calendar.items.some(item => Math.abs(new Date(item.publishAt).getTime() - expected.publishAt.getTime()) < gap)) {
    return { kind: "blocked", safeToContinue:true, reason: `Another Instagram post is within ${expected.minGapMinutes ?? 30} minutes of this time. Nothing was uploaded or rescheduled.` };
  }
  return { kind: "clear" };
}

/** Observe the calendar's own read response; unknown schemas, login pages and timeouts fail closed. */
export async function readInstagramCalendar(page: Page, timeoutMs = 30_000): Promise<InstagramCalendar> {
  let resolve!: (calendar: InstagramCalendar | null) => void;
  const result = new Promise<InstagramCalendar | null>(done => { resolve = done; });
  const listener = async (response: Response) => {
    if (new URL(response.url()).hostname !== "www.instagram.com" || !/graphql|scheduled/i.test(response.url())) return;
    try {
      const parsed = parseInstagramCalendar(await response.json());
      if (parsed) resolve(parsed);
    } catch { /* A non-calendar response cannot verify scheduling. */ }
  };
  const timeout = setTimeout(() => resolve(null), timeoutMs);
  page.on("response", listener);
  try {
    await page.goto("https://www.instagram.com/scheduled_content/", { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const calendar = await result;
    if (!calendar) throw new Error("Instagram's complete scheduled calendar could not be read. Check login/challenges and Scheduled content; no scheduling confirmation can be recorded.");
    return calendar;
  } finally {
    clearTimeout(timeout);
    page.off("response", listener);
  }
}

/** A separate read-only tab leaves the upload/composer intact while Instagram accepts the schedule. */
export async function verifyInstagramCalendar(
  page: Page,
  expected: InstagramScheduleIdentity,
  opts: { timeoutMs?: number; pollMs?: number; userId?: string } = {},
): Promise<ScheduledReel> {
  const reader = await page.context().newPage();
  try {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    do {
      const calendar = await readInstagramCalendar(reader);
      if (opts.userId && calendar.userId !== opts.userId) throw new Error("The Instagram account changed during scheduling. Check the open browser; no success was recorded.");
      // Spacing is a pre-upload guard. After submission, a newly created row
      // can appear before its caption; it must not conflict with its own slot.
      // Continue polling for the exact caption/time receipt without writing again.
      const verdict = judgeInstagramCalendar(calendar, {...expected,minGapMinutes:0});
      if (verdict.kind === "confirmed") return verdict.item;
      if (verdict.kind === "blocked") throw new Error(verdict.reason);
      if (Date.now() >= deadline) break;
      await reader.waitForTimeout(opts.pollMs ?? 3000);
    } while (Date.now() < deadline);
    throw new Error("Schedule was pressed, but Instagram's calendar did not confirm this caption and exact publication time. Check Scheduled content and drafts before retrying; another upload was not started.");
  } finally {
    await reader.close().catch(() => {});
  }
}

/** Detect a resumed web draft before choosing another file. Mobile-only drafts are not exposed here. */
export async function instagramDraftProblem(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
      if (!(dialog as HTMLElement).getClientRects().length) continue;
      const selected = [...dialog.querySelectorAll('input[type="file"]')].some(input => (input as HTMLInputElement).files?.length);
      const caption = [...dialog.querySelectorAll('[contenteditable="true"],textarea')].some(input => ((input as HTMLTextAreaElement).value || (input as HTMLElement).innerText || "").trim());
      if (selected || caption || dialog.querySelector("video")) return "Instagram has an open or resumed draft. Inspect it before retrying; another file was not uploaded.";
      if ([...dialog.querySelectorAll('button,[role="button"],[role="tab"]')].some(el => /^drafts(?:\s*\(\d+\))?$/i.test((el.textContent || "").trim()))) {
        return "Instagram offers a drafts list in this composer. Check that list for this video before retrying; no new upload was started.";
      }
    }
    return null;
  });
}
