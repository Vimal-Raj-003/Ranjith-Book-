/** Adapted from RepoReel: platform logic only; no accounts, sessions or data. */
import path from "node:path";
import type { Page } from "playwright-core";
import { pause } from "./actions";
import type { PublishLog } from "../types";

/**
 * Put the chosen thumbnail on the reel, on the screen that actually offers it.
 *
 * Instagram's create flow has three screens after the file is chosen: crop,
 * then one headed "Cover photo", then the caption screen with Share. The cover
 * screen is the only one with an image file input — `accept="image/jpeg,image/png"`
 * behind a "Select from computer" button — and it is gone by the time the
 * caption box exists. An earlier attempt looked for the control after both
 * Next clicks, which is the caption screen: it has no file input at all, so an
 * optional step found nothing and moved on without a word, and every reel took
 * whatever frame Instagram picked.
 *
 * Nothing here can fail the post. The reel is uploaded and captioned by this
 * point, a person reviews it before Share, and Instagram's own frame is a worse
 * cover rather than a lost post.
 */

/** The input itself. Hidden behind the button, which `setInputFiles` does not mind. */
const IMAGE_INPUT = 'input[type="file"][accept*="image"]';

/** The visible control, used only to say in the log that the screen was reached. */
const PICKER_BUTTON =
  'div[role="button"]:has-text("Select from computer"), button:has-text("Select from computer")';

/** Wait for the cover screen, which arrives a few seconds after the crop Next. */
async function waitForCoverScreen(page: Page, log: PublishLog): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const found = await page.locator(IMAGE_INPUT).count().catch(() => 0);
    if (found > 0) return true;
    await page.waitForTimeout(2500);
  }
  log("Cover: no cover control on this screen — Instagram will choose its own frame");
  return false;
}

export async function applyReelCover(
  page: Page,
  coverFile: string,
  log: PublishLog,
): Promise<boolean> {
  log(`Cover: selected thumbnail ${path.basename(coverFile)}`);

  try {
    if (!(await waitForCoverScreen(page, log))) return false;

    const hasButton = (await page.locator(PICKER_BUTTON).count().catch(() => 0)) > 0;
    log(`Cover: cover control found${hasButton ? ' ("Select from computer")' : " (file input)"}`);

    const before = await coverSignature(page);

    // Through the button and its file chooser, not by writing to the hidden
    // input. Instagram ignores an input set programmatically — the file lands
    // on the element and nothing else happens, which is what made the first
    // attempt look like it had worked. The chooser is the path a person takes,
    // and it is the one their handler listens to.
    let attached = false;
    if (hasButton) {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null),
        page.locator(PICKER_BUTTON).first().click({ timeout: 15_000 }).catch(() => {}),
      ]);
      if (chooser) {
        await chooser.setFiles(coverFile);
        attached = true;
        log("Cover: selected thumbnail uploaded through the file chooser");
      } else {
        log("Cover: the button opened no file chooser; falling back to the input");
      }
    }

    if (!attached) {
      await page.locator(IMAGE_INPUT).first().setInputFiles(coverFile);
      log("Cover: selected thumbnail attached to the file input");
    }

    await pause(4000, 6000);

    // Verify by what the screen shows, not by the upload having been accepted.
    // The cover strip redraws when Instagram takes the image, so the signature
    // of what is rendered has to differ from before.
    const after = await coverSignature(page);
    // A preview that was *replaced* keeps the same counts, so the counts alone
    // missed it - the first live run reported a failure with the right cover on
    // screen. A new blob address is the upload being taken.
    const fresh = after.urls.filter((u) => !before.urls.includes(u));
    const changed = fresh.length > 0 || after.images !== before.images || after.blobs !== before.blobs;

    if (changed) {
      log(`Cover: preview verified — the cover redrew (images ${before.images}->${after.images}, previews ${before.blobs}->${after.blobs})`);
      return true;
    }

    log(
      `Cover: verification FAILED — nothing on screen changed (images ${after.images}, previews ${after.blobs}); Instagram will use its own frame`,
    );
    return false;
  } catch (err) {
    log(`Cover: could not apply it (${err instanceof Error ? err.message : String(err)}) — continuing`);
    return false;
  }
}

/**
 * What the cover area is currently showing.
 *
 * Counted rather than inspected, because the preview is a CSS background on a
 * div rather than an `img` with a readable source — the first verification
 * looked for a `blob:` image src and could never have found one, so it reported
 * failure whatever happened. Both numbers are non-zero before the cover is
 * touched, since the video preview uses the same mechanism; it is the change
 * that means something, not the value.
 */
async function coverSignature(page: Page): Promise<{ images: number; blobs: number; urls: string[] }> {
  return page
    .evaluate(() => {
      const urls: string[] = [];
      for (const el of document.querySelectorAll("*")) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.includes("blob:") ? /blob:[^"')]+/.exec(bg) : null;
        if (m) urls.push(m[0]);
      }
      for (const img of document.querySelectorAll("img")) {
        if (img.src.startsWith("blob:")) urls.push(img.src);
      }
      return { images: document.querySelectorAll("img").length, blobs: urls.length, urls };
    })
    .catch(() => ({ images: -1, blobs: -1, urls: [] as string[] }));
}
