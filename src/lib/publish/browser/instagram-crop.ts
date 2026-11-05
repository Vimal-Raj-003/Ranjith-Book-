import type { Page } from "playwright-core";
import type { PublishLog } from "../types";

const OPENERS = '[aria-label="Select crop" i], [aria-label="Crop" i], [aria-label="Expand" i]';
const ORIGINAL = 'button:text-is("Original"), [role="button"]:text-is("Original"), [role="menuitem"]:text-is("Original"), span:text-is("Original")';

/** Never advance to Next with Instagram's default framing. */
export async function chooseOriginalCrop(page: Page, log: PublishLog, timeoutMs = 30_000): Promise<void> {
  const dialog = page.locator('div[role="dialog"]:visible').last();
  await dialog.getByRole('heading', { name: 'Crop', exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
  const video = dialog.locator('video').first();
  if (await video.count()) {
    const deadline = Date.now() + timeoutMs;
    while (!(await video.evaluate(el => (el as HTMLVideoElement).readyState >= 2 && (el as HTMLVideoElement).videoWidth > 0 && (el as HTMLVideoElement).videoHeight > 0))) {
      if (Date.now() >= deadline || await video.evaluate(el => Boolean((el as HTMLVideoElement).error))) {
        throw new Error('Instagram crop video did not become ready; Next was not pressed.');
      }
      await page.waitForTimeout(100);
    }
  }
  const option = dialog.locator(ORIGINAL).filter({ visible: true }).first();
  if (!(await option.isVisible())) {
    // The accessible name is on an SVG inside the bottom-left button. Click
    // its nearest interactive ancestor, never the media-gallery button on the right.
    const opener = dialog.locator(OPENERS).filter({ visible: true }).first()
      .locator('xpath=ancestor-or-self::*[self::button or @role="button"][1]');
    try {
      await opener.waitFor({ state: "visible", timeout: timeoutMs });
      await opener.click({ timeout: timeoutMs });
      log("Crop: opened the aspect-ratio menu");
    } catch (error) {
      throw new Error(`Instagram did not offer an accessible crop/expand control. Original could not be selected; Next was not pressed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await option.waitFor({ state: "visible", timeout: timeoutMs });
    await option.click({ timeout: timeoutMs });
  } catch {
    throw new Error("Instagram did not accept Original in the crop menu. Next was not pressed; inspect the open draft before retrying.");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const selected = await dialog.evaluate(root => {
      const labels = Array.from(root.querySelectorAll('span,button,[role="button"],[role="menuitem"]'));
      const original = labels.find(el => el.textContent?.trim() === 'Original' && el.getClientRects().length);
      if (!original) return false;
      const control = original.closest('[aria-selected],[aria-checked],[aria-pressed]') ?? original;
      const states = ['aria-selected','aria-checked','aria-pressed'].map(attr => control.getAttribute(attr));
      if (states.includes('false')) return false;
      if (states.includes('true')) return true;
      // Live Instagram has no aria-selected: its selected label AND icon are
      // white, and all three alternative ratios use --ig-secondary-text.
      const label = original.querySelector('span') ?? original;
      const row = original.closest('button,[role="button"],[role="menuitem"]');
      const icon = row?.querySelector('svg');
      if (!icon || getComputedStyle(label).color !== 'rgb(255, 255, 255)' || getComputedStyle(icon).color !== 'rgb(255, 255, 255)') return false;
      return ['1:1','9:16','16:9'].every(text => {
        const other = labels.find(el => el.textContent?.trim() === text && el.getClientRects().length);
        if (!other) return false;
        const style = getComputedStyle(other.querySelector('span') ?? other);
        const secondary = style.getPropertyValue('--ig-secondary-text').trim().replace(/\s/g, '');
        return secondary !== '' && style.color.replace(/\s/g, '') === `rgb(${secondary})`;
      });
    });
    if (selected) { log("Crop: verified Original is selected"); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error("Instagram reports Original as unselected or its selection could not be verified. Next was not pressed.");
}
