/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import { humanType, pause } from "./actions";
import type { PublishLog } from "../types";

/**
 * Two settings on Instagram's final New Reel screen: the AI label, and the
 * location.
 *
 * Neither control names itself. The screen carries two `[role="switch"]`
 * elements with no `aria-label` between them, so the AI one cannot be picked by
 * attribute or by index — index would silently flip whichever switch Instagram
 * happens to render first, and that is a different setting on a different day.
 * It is found instead by walking up from its own text to the nearest ancestor
 * holding exactly one switch, which is the relationship the layout actually
 * guarantees.
 *
 * The caller blocks submission when Instagram offers the AI disclosure but
 * its enabled state cannot be verified. Location remains optional.
 */

const LOCATION_INPUT = 'input[aria-label="Add location"], input[placeholder="Add location"]';

/** Blur instead of Escape: Escape opens Instagram's destructive discard dialog. */
export async function fillNativeInstagramCaption(page: Page, selector: string, caption: string): Promise<void> {
  const field = page.locator(selector).first();
  await field.fill(caption);
  await field.blur();
}

/** Where the AI label's own switch sits among all the switches on the page. */
async function aiLabelSwitchIndex(page: Page): Promise<number | null> {
  return page
    .evaluate(() => {
      const all = [...document.querySelectorAll('[role="switch"]')];
      const label = [...document.querySelectorAll("span,div,label")].find(
        (el) => el.children.length === 0 && el.getClientRects().length > 0 &&
          /^\s*add ai label\s*$/i.test(el.textContent ?? ""),
      );
      if (!label) return null;

      // The nearest ancestor that contains this row's switch and no other.
      let node: HTMLElement | null = label.parentElement;
      for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
        const found = node.querySelectorAll('[role="switch"]');
        if (found.length === 1) return all.indexOf(found[0]);
      }
      return null;
    })
    .catch(() => null);
}

const isOn = async (page: Page, index: number): Promise<boolean> =>
  (await page.locator('[role="switch"]').nth(index).getAttribute("aria-checked").catch(() => null)) === "true";

export async function enableAiLabel(page: Page, log: PublishLog): Promise<boolean> {
  try {
    // Resolve the labelled switch again after each render. Use an actionable
    // locator click: wheel scrolling and raw pointer coordinates can move the
    // dialog's inner pane away from the switch before the click lands.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const index = await aiLabelSwitchIndex(page);
      if (index === null || index < 0) {
        log("AI label: no toggle on this screen \u2014 leaving it as it is");
        return false;
      }

      if (await isOn(page, index)) {
        log(attempt === 1 ? "AI label: already ON \u2014 not touching it" : "AI label: verified ON");
        return true;
      }

      log(attempt === 1 ? "AI label: OFF \u2014 turning it on" : "AI label: still OFF \u2014 trying once more");
      await page.locator('[role="switch"]').nth(index).click({ timeout: 10_000 });
      const deadline = Date.now() + 5000;
      do {
        const current = await aiLabelSwitchIndex(page);
        if (current !== null && await isOn(page, current)) {
          log("AI label: verified ON");
          return true;
        }
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
    }

    log("AI label: verification FAILED \u2014 still OFF");
    return false;
  } catch (err) {
    log(`AI label: could not set it (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

/**
 * Pick a location from Instagram's own suggestions.
 *
 * Typing the text is not setting a location: the field holds free text until a
 * suggestion is clicked, and an unclicked one is discarded on Share. So the
 * suggestion has to be matched exactly — "Chennai, Tamil Nadu" and not the
 * dozens of Chennai businesses that share the prefix — and clicked.
 */
export async function setLocation(page: Page, wanted: string, log: PublishLog): Promise<boolean> {
  try {
    const field = page.locator(LOCATION_INPUT).first();
    if ((await field.count().catch(() => 0)) === 0) {
      log("Location: no location field on this screen");
      return false;
    }

    const current = (await field.inputValue().catch(() => "")).trim();
    if (current.toLowerCase() === wanted.toLowerCase()) {
      log(`Location: already set to "${current}" — not changing it`);
      return true;
    }

    log(`Location: searching for "${wanted}"`);
    await humanType(page, LOCATION_INPUT, wanted);
    await pause(2500, 4000);

    // What Instagram is offering. Logged whether or not one matches, because a
    // near-miss list is the only way to tell a wrong query from a wrong click.
    const options = await page
      .evaluate(() => {
        const rows = [...document.querySelectorAll('div[role="button"],li,button,[role="option"]')];
        return rows
          .map((r) => (r.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 1 && t.length < 80);
      })
      .catch(() => [] as string[]);

    const shortlist = options.filter((o) => o.toLowerCase().includes("chennai")).slice(0, 8);
    log(`Location: suggestions offered: ${shortlist.length ? shortlist.join(" | ") : "(none matched Chennai)"}`);

    // Exact match only. A business in Chennai is not the city, and both are
    // in this list. `exact` compares the whole trimmed text, so a row reading
    // "Chennai, Tamil Nadu" matches and "Chennai Central" does not.
    //
    // Inside the dialog, and visible. Searched page-wide, the first match was the
    // "Chennai, Tamil Nadu" location link on a post in the feed behind the modal:
    // present, exact, and impossible to click.
    const exact = page.locator('div[role="dialog"]').getByText(wanted, { exact: true }).locator("visible=true").first();

    if ((await exact.count().catch(() => 0)) === 0) {
      log(`Location: no suggestion exactly matching "${wanted}" — leaving the field unset`);
      return false;
    }

    await exact.click({ timeout: 10_000 });
    await pause(1500, 2500);

    const after = (await field.inputValue().catch(() => "")).trim();
    const ok = after.toLowerCase() === wanted.toLowerCase();
    log(ok ? `Location: verified "${after}"` : `Location: verification FAILED — the field reads "${after}"`);
    return ok;
  } catch (err) {
    log(`Location: could not set it (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
