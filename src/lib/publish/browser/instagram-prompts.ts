/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import type { Page } from "playwright-core";
import { humanClick, pause } from "./actions";
import type { PublishLog } from "../types";

/**
 * Instagram's interruptions: the modals that sit on top of the whole site and
 * swallow every click until they are answered.
 *
 * The first real run against the live site stopped on one - "Turn on
 * Notifications", with Turn On and Not Now - and reported that the page had
 * changed and the file picker could not be found. The page had not changed: a
 * modal was in front of it. Instagram throws these up after a login, on a timer
 * and between steps ("Save your login info?", "Add Instagram to your home
 * screen"), so they are cleared before the flow starts and again before it
 * reaches for the create button.
 *
 * Only the answer that declines is ever pressed, and only on a button whose whole
 * text is that answer. Turn On, Allow and Save are never touched.
 */

const MARK = "data-bookreel-prompt";

/** Whole-text matches, so "Not Now" is pressed and a post titled "Not now" is not. */
const DECLINE = ["not now", "not now."];

/** The visible decline button of any open dialog, tagged so the click can be aimed at it. */
async function findDecline(page: Page): Promise<string | null> {
  return page
    .evaluate(
      ({ mark, words }) => {
        for (const stale of document.querySelectorAll(`[${mark}]`)) stale.removeAttribute(mark);
        for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
          if ((dialog as HTMLElement).offsetParent === null && (dialog as HTMLElement).getClientRects().length === 0) continue;
          for (const b of dialog.querySelectorAll('button, [role="button"]')) {
            const text = ((b as HTMLElement).innerText || b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (words.includes(text)) {
              b.setAttribute(mark, "1");
              return ((dialog as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
            }
          }
        }
        return null;
      },
      { mark: MARK, words: DECLINE },
    )
    .catch(() => null);
}

/** Answer "Not Now" to whatever is in front of the page. Returns how many were cleared. */
export async function dismissPrompts(page: Page, log: PublishLog): Promise<number> {
  let cleared = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const heading = await findDecline(page);
    if (heading === null) break;

    log(`Dismissing a prompt: "${heading}"`);
    try {
      await humanClick(page, `[${MARK}="1"]`);
    } catch {
      break;
    }
    cleared++;
    await pause(700, 1400);
  }
  return cleared;
}
