import type { Page } from "playwright-core";
import type { PageLike } from "./engine";
import { isUploadPacingEnabled, pacedFillField } from "./pacing";

/** Deterministic, bounded actions for the adapted platform controls. The
 * existing BookReel launcher and persistent-profile handling remain in engine. */
export const pause = async (minimum = 250, maximum = minimum): Promise<void> => {
  const target = isUploadPacingEnabled()
    ? Math.min(15_000, Math.max(0, Math.round((minimum + maximum) / 2)))
    : Math.min(2_500, Math.max(0, Math.min(minimum, maximum)));
  await new Promise((resolve) => setTimeout(resolve, target));
};
export async function humanClick(page: Page, selector: string): Promise<void> {
  if (isUploadPacingEnabled()) {
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  await page.locator(selector).first().click({ timeout: 15_000 });
}
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await pacedFillField({ page: page as unknown as PageLike, selector, value: text, timeoutMs: 15_000 });
}
export async function readPage(page: Page, minimum = 500, maximum = minimum): Promise<void> {
  const target = isUploadPacingEnabled()
    ? Math.min(15_000, Math.max(0, Math.round((minimum + maximum) / 2)))
    : Math.min(2_500, Math.max(0, Math.min(minimum, maximum)));
  await page.waitForTimeout(target);
}
