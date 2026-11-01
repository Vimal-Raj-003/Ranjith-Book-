/** Orchestration fixture. The production Playwright controls are separately
 * tested by reference-*-schedule/settings tests against local DOM fixtures. */
import { YT, studioDateText, studioTimeText, judgeReadback } from "../../src/lib/publish/browser/youtube";
import type { YouTubeScheduleControls } from "../../src/lib/publish/browser/native-controls";

export const scriptedYouTubeSchedule: YouTubeScheduleControls = {
  async apply(page, at) {
    await page.locator(YT.visibility.public).first().click();
    await page.locator(YT.scheduleExpand).first().click();
    await page.locator(YT.dateTrigger).first().click();
    await page.locator(YT.dateInput).first().fill(studioDateText(at));
    await page.keyboard.press("Enter");
    await page.locator(YT.timeInput).first().fill(studioTimeText(at));
    await page.keyboard.press("Tab");
    const readDate = await page.locator(YT.dateTrigger).first().innerText();
    const readTime = await page.locator(YT.timeInput).first().inputValue();
    const check = judgeReadback({ title: "fixture", scheduledAt: at, visibility: "scheduled" }, { title: "fixture", visibilityText: `Scheduled ${readDate}, ${readTime}` });
    if (!check.ok) throw new Error(`Nothing was published. ${check.problem}`);
  },
  async confirm(page, id, title, at) {
    await page.goto(`https://studio.youtube.com/video/${id}/edit`);
    let visibilityText = await page.locator(YT.editVisibility).first().innerText();
    if (/scheduled/i.test(visibilityText) && !/\d/.test(visibilityText)) visibilityText += ` ${await page.locator(YT.dateTrigger).first().innerText()}, ${await page.locator(YT.timeInput).first().inputValue()}`;
    const result = judgeReadback({ title, scheduledAt: at, visibility: "scheduled" }, {
      title: await page.locator(YT.editTitle).first().innerText(), visibilityText,
    });
    return { ok: result.ok, problem: result.ok ? undefined : result.problem };
  },
  async uploadComplete() { /* Upload readiness is scripted by the fake final button. */ },
  async inspectRetry() { throw new Error("This fixture has not verified an existing draft."); },
};
