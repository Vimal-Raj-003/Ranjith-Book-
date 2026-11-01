/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import { humanClick, pause } from "./actions";
import type { PublishLog } from "../types";

/**
 * Put Instagram's crop screen on "Original".
 *
 * Instagram opens the crop step on a square by default, so a 9:16 reel arrives
 * there already cropped to 1:1 and two thirds of the frame — which is where the
 * words are — is about to be thrown away. "Original" is the only option that
 * publishes what was actually rendered.
 *
 * Written as a function rather than as `Step`s because the step engine cannot
 * express this. Its actions are unconditional, and asking it for an option that
 * is already chosen would click it off again; worse, a missing selector there
 * spends an AI repair call, and this menu is legitimately absent on some
 * screens. Nothing here can throw into the publish flow: a post that reaches
 * the human for review beats one abandoned over a crop control, and the human
 * sees the frame before pressing Share either way.
 */

/** The crop control, which is an icon button rather than anything with a name. */
const OPENERS = [
  'svg[aria-label="Select crop"]',
  'svg[aria-label="Crop"]',
  'button:has(svg[aria-label="Select crop"])',
  'div[role="button"]:has(svg[aria-label="Select crop"])',
  '[aria-label="Select crop"]',
  '[aria-label="Crop"]',
];

/**
 * The option itself. Exact-text matching first: "Original" is a substring of
 * nothing else here, but `:has-text` also matches an ancestor that merely
 * contains it, which on this menu is the whole list.
 */
const OPTIONS = [
  'div[role="button"]:text-is("Original")',
  'div[role="menuitem"]:text-is("Original")',
  'button:text-is("Original")',
  'span:text-is("Original")',
  'div[role="button"]:has-text("Original")',
  'button:has-text("Original")',
];

/** The first selector that matches something, or null. */
async function firstMatch(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return selector;
  }
  return null;
}

/**
 * Whether the option is already chosen, when the page says so plainly.
 *
 * `null` means "no opinion" rather than "no": Instagram marks the active
 * option by styling more often than by ARIA, and guessing from styling would
 * be the kind of brittle inference that breaks on a theme change. An unknown
 * state is treated as not-selected, because clicking "Original" when it is
 * already "Original" is harmless, while skipping it when it is not is the
 * entire bug.
 */
async function looksSelected(page: Page, selector: string): Promise<boolean | null> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const node = el.closest("[aria-selected],[aria-checked],[aria-pressed]") ?? el;
      for (const attr of ["aria-selected", "aria-checked", "aria-pressed"]) {
        const value = node.getAttribute(attr);
        if (value === "true") return true;
        if (value === "false") return false;
      }
      return null;
    })
    .catch(() => null);
}

export async function chooseOriginalCrop(page: Page, log: PublishLog): Promise<void> {
  try {
    // The option is sometimes on the page already, with the menu closed.
    let option = await firstMatch(page, OPTIONS);

    if (!option) {
      const opener = await firstMatch(page, OPENERS);
      if (!opener) {
        log("Crop: no crop control on this screen — leaving the framing as Instagram set it");
        return;
      }
      log("Crop: opening the frame-size menu");
      await humanClick(page, opener);
      await pause(500, 1100);
      option = await firstMatch(page, OPTIONS);
    }

    if (!option) {
      log('Crop: the frame-size menu opened but had no "Original" option — leaving the framing alone');
      return;
    }

    const already = await looksSelected(page, option);
    if (already === true) {
      log('Crop: "Original" is already selected — not clicking it again');
      // The menu was opened to look; close it so it cannot swallow the Next click.
      await page.keyboard.press("Escape").catch(() => {});
      await pause(300, 700);
      return;
    }

    log(`Crop: selecting "Original"${already === null ? " (the page does not say which is active)" : ""}`);
    await humanClick(page, option);
    await pause(500, 1100);
    log('Crop: "Original" selected');
  } catch (err) {
    // Never fatal. The reel is otherwise complete and a person reviews it.
    log(`Crop: could not set "Original" (${err instanceof Error ? err.message : String(err)}) — continuing`);
  }
}
