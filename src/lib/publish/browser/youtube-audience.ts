import type { Page } from "playwright-core";
import { NeedsHuman } from "./engine";

const radios = '[name="VIDEO_MADE_FOR_KIDS_MFK"], [name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]';

/** A channel default is not a new declaration. Require an operator click and
 * Studio's checked-state readback; this function never selects either answer. */
export async function waitForManualAudience(page: Page, log: (message: string) => void, timeoutMs = 180_000): Promise<boolean> {
  const installed = await page.evaluate(selector => {
    const state = window as typeof window & { bookreelAudienceController?: AbortController; bookreelAudienceChoice?: string };
    state.bookreelAudienceController?.abort();
    const controller = new AbortController();
    state.bookreelAudienceController = controller;
    delete state.bookreelAudienceChoice;
    const choices = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
    if (choices.length !== 2) return false;
    // Delegate in the capture phase: Studio may replace the radio nodes after
    // the click. Keep the chosen name, then verify the newly rendered state.
    document.addEventListener("click", event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const choice = event.target.closest(selector);
      if (choice?.getClientRects().length) state.bookreelAudienceChoice = choice.getAttribute("name") ?? undefined;
    }, { signal: controller.signal, capture: true });
    return true;
  }, radios);
  try {
    if (!installed) throw new Error("Studio's two audience choices could not be identified.");
    await page.locator(radios).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
    log("Audience: waiting for you in YouTube Studio. Click Yes or No under Made for Kids (even if already selected). BookReel continues after verifying your choice; the wait is limited to 3 minutes.");
    const selected = await page.waitForFunction(selector => {
      const choices = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
      const checked = choices.filter(el => el.getAttribute("aria-checked") === "true");
      const state = window as typeof window & { bookreelAudienceChoice?: string };
      if (checked.length !== 1 || checked[0].getAttribute("name") !== state.bookreelAudienceChoice) return false;
      return checked[0].getAttribute("name");
    }, radios, { timeout: timeoutMs });
    const name = await selected.jsonValue();
    await selected.dispose();
    const madeForKids = name === "VIDEO_MADE_FOR_KIDS_MFK";
    log(`Audience: verified your Studio selection: ${madeForKids ? "Made for Kids" : "Not made for kids"}.`);
    return madeForKids;
  } catch (error) {
    throw new NeedsHuman("ui", `Audience selection requires your review in YouTube Studio. ${error instanceof Error && !/Timeout/.test(error.message) ? error.message : "No manual selection was verified within the allowed wait."} Nothing was scheduled or published; keep the existing draft and inspect it before retrying.`);
  } finally {
    await page.evaluate(() => {
      const state = window as typeof window & { bookreelAudienceController?: AbortController; bookreelAudienceChoice?: string };
      state.bookreelAudienceController?.abort();
      delete state.bookreelAudienceController;
      delete state.bookreelAudienceChoice;
    }).catch(() => {});
  }
}
