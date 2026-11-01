import type { Page } from "playwright-core";
import type { PreparedPublish, PublishOutcome } from "../contract";
import { NeedsHuman, clickOn, waitPresent, type BrowserSession, type BrowserHooks, type BrowserPublishOptions } from "./engine";
import { applyReelCover } from "./instagram-cover";
import { chooseOriginalCrop } from "./instagram-crop";
import { enableAiLabel, fillNativeInstagramCaption } from "./instagram-settings";
import { dismissPrompts } from "./instagram-prompts";
import { instagramDraftProblem, instagramScheduleTimeProblem, judgeInstagramCalendar, readInstagramCalendar, verifyInstagramCalendar } from "./instagram-calendar";
import { enableScheduleContent, reelScheduleTarget, setReelDate, setReelTime, readReelSchedule, judgeReelSchedule, pressSchedule } from "./instagram-schedule";

/** Called ONLY after BookReel's strict active-account check. No Graph API writes. */
export async function scheduleInstagram(
  session: BrowserSession, prepared: PreparedPublish, caption: string,
  options: BrowserPublishOptions, hooks: BrowserHooks,
  selectors: { newPost: string; postItem: string; fileInput: string; next: string; caption: string },
  onCommit: () => void,
): Promise<PublishOutcome> {
  const page = session.page as unknown as Page;
  const log = (message: string) => { void Promise.resolve(hooks.onLog?.(message)).catch(() => {}); };
  const at = options.scheduledAt!;
  const zone = options.timezone ?? "Asia/Kolkata";
  const timeProblem = instagramScheduleTimeProblem(at, new Date(), zone);
  if (timeProblem) throw new NeedsHuman("ui", timeProblem);
  log("Instagram 2. Inspecting open drafts and the account's complete scheduled-content calendar");
  for (const tab of page.context().pages()) {
    if (!tab.url().startsWith("https://www.instagram.com/")) continue;
    const draft = await instagramDraftProblem(tab);
    if (draft) throw new NeedsHuman("unconfirmed", draft);
  }
  const reader = await page.context().newPage();
  reader.setDefaultTimeout(15_000);
  let calendar;
  try { calendar = await readInstagramCalendar(reader); }
  finally { await reader.close().catch(() => {}); }
  const expected = { caption, repoUrl: "", publishAt: at, remoteContainerId: options.resumeDraftId };
  const preflight = judgeInstagramCalendar(calendar, expected);
  const result = (item: { id: string; mediaId: string; publishAt: string }): PublishOutcome => ({
    status: "PUBLISHED", externalId: item.id, externalUrl: "https://www.instagram.com/scheduled_content/",
    confirmedAt: new Date(), scheduledFor: new Date(item.publishAt), visibility: "scheduled",
  });
  if (preflight.kind === "confirmed") {
    await hooks.onCheckpoint?.(preflight.item.id);
    return result(preflight.item);
  }
  if (preflight.kind === "blocked") throw new NeedsHuman("unconfirmed", preflight.reason);

  log("Instagram 3. Opening Create and uploading the approved render");
  await clickOn(session, selectors.newPost, "New post", 30_000);
  const submenu = page.locator(selectors.postItem).first();
  if (await submenu.isVisible().catch(() => false)) await submenu.click({ timeout: 10_000 });
  const draft = await instagramDraftProblem(page);
  if (draft) throw new NeedsHuman("unconfirmed", draft);
  if (!(await waitPresent(session, selectors.fileInput, 30_000))) throw new NeedsHuman("ui", "Instagram did not offer a file picker.");
  // Commit the uncertainty marker BEFORE bytes leave the machine.
  await hooks.onCheckpoint?.("instagram-upload-unconfirmed");
  await page.locator(selectors.fileInput).first().setInputFiles(prepared.video.path, { timeout: 60_000 });
  await hooks.onStage?.("UPLOADING");
  await chooseOriginalCrop(page, log);
  await clickOn(session, selectors.next, "Next to Cover", 120_000);
  if (prepared.poster) await applyReelCover(page, prepared.poster.path, log);
  await clickOn(session, selectors.next, "Next to Caption", 60_000);
  log("Instagram 4. Filling and verifying the complete caption and AI disclosure");
  await fillNativeInstagramCaption(page, selectors.caption, caption);
  const ai = await enableAiLabel(page, log);
  const text = await page.locator('div[role="dialog"]').last().innerText({ timeout: 5_000 });
  if (/add ai label/i.test(text) && !ai) throw new NeedsHuman("ui", "Instagram offered an AI label but it did not read back enabled.");
  const field = page.locator(selectors.caption).first();
  const read = await field.inputValue({ timeout: 3_000 }).catch(() => field.innerText({ timeout: 3_000 }));
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  if (squash(read) !== squash(caption)) throw new NeedsHuman("mismatch", "The complete Instagram caption differs from the approved copy.");

  log("Instagram 5. Selecting and reading back native Schedule content");
  const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const target = reelScheduleTarget(at, browserZone);
  if (!(await enableScheduleContent(page, log))) throw new NeedsHuman("ui", "This Instagram account/session does not offer Schedule content. A professional account with native scheduling eligibility is required; nothing was shared.");
  await setReelDate(page, target, log);
  await setReelTime(page, target, log);
  const verdict = judgeReelSchedule(await readReelSchedule(page), target);
  if (!verdict.ok) throw new NeedsHuman("mismatch", verdict.problems.join(" "));
  await dismissPrompts(page, log);
  const late = instagramScheduleTimeProblem(at, new Date(), zone);
  if (late) throw new NeedsHuman("ui", late);
  log("Instagram 6. Pressing Schedule once, then reading the calendar's UTC receipt");
  onCommit();
  await pressSchedule(page, log);
  const confirmed = await verifyInstagramCalendar(page, expected, { userId: calendar.userId });
  await hooks.onCheckpoint?.(confirmed.id);
  return result(confirmed);
}
