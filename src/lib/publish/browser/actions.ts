import type { Page } from "playwright-core";

/** Deterministic, bounded actions for the adapted platform controls. The
 * existing BookReel launcher and persistent-profile handling remain in engine. */
export const pause = async (minimum = 250, maximum = minimum): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, Math.min(2_500, Math.max(0, Math.min(minimum, maximum)))));
};
export async function humanClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().click({ timeout: 15_000 });
}
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).first().fill(text, { timeout: 15_000 });
}
export async function readPage(page: Page, minimum = 500, maximum = minimum): Promise<void> {
  await page.waitForTimeout(Math.min(2_500, Math.max(0, Math.min(minimum, maximum))));
}
