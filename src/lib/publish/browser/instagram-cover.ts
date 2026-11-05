import path from "node:path";
import { stat } from "node:fs/promises";
import type { Page } from "playwright-core";
import type { PublishLog } from "../types";

const INPUT = 'input[type="file"][accept*="image"]';
const AREA = '[data-bookreel-cover="1"]';

/** Upload exactly the requested file; no automatic-frame fallback is permitted. */
export async function applyReelCover(page: Page, coverFile: string, log: PublishLog, timeoutMs = 30_000): Promise<boolean> {
  const file = await stat(coverFile);
  if (!file.isFile() || !file.size) throw new Error("The selected Instagram thumbnail is missing or empty.");
  const dialog = page.locator('div[role="dialog"]:visible').last();
  const input = dialog.locator(INPUT).first();
  try { await input.waitFor({ state: "attached", timeout: timeoutMs }); }
  catch { throw new Error("Instagram's current browser composer does not offer custom cover upload. Nothing was submitted; an automatic thumbnail was not used."); }
  // Identify the cover picker. In the live composer its preview is an overlay
  // beside the video, outside this header; frame-strip images are not evidence.
  const marked = await input.evaluate(el => {
    for (const stale of document.querySelectorAll('[data-bookreel-cover]')) stale.removeAttribute('data-bookreel-cover');
    let root = el.parentElement;
    while (root && root.getAttribute('role') !== 'dialog') {
      if (/cover photo/i.test(root.textContent || '') && root.getClientRects().length) {
        root.setAttribute('data-bookreel-cover','1'); return true;
      }
      root = root.parentElement;
    }
    return false;
  });
  if (!marked) throw new Error("Instagram's Cover photo preview could not be identified. The selected thumbnail cannot be verified; nothing was submitted.");
  const preview = () => dialog.evaluate((root, area) => {
    const urls: string[] = [];
    const regions = Array.from(root.querySelectorAll(area));
    for (const video of root.querySelectorAll('video')) {
      if (video.getClientRects().length && video.parentElement) regions.push(video.parentElement);
    }
    for (const el of regions.flatMap(region => [region, ...region.querySelectorAll('*')])) {
      if (!(el as HTMLElement).getClientRects().length) continue;
      if (el instanceof HTMLImageElement && el.complete && el.naturalWidth && /^(blob:|data:image)/.test(el.src)) urls.push(el.src);
      const bg = getComputedStyle(el).backgroundImage;
      const url = bg.match(/^url\(["']?((?:blob:|data:image)[^"')]+)["']?\)$/)?.[1];
      if (url) urls.push(url);
    }
    return [...new Set(urls)];
  }, AREA);
  const before = await preview();
  const picker = page.locator(AREA).getByText(/^Select from computer$/i).first();
  if (await picker.isVisible()) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: timeoutMs }),
      picker.click({ timeout: timeoutMs }),
    ]);
    await chooser.setFiles(coverFile);
  } else {
    await input.setInputFiles(coverFile);
  }
  const attached = await input.evaluate((el, expected) => {
    const files = (el as HTMLInputElement).files;
    return files?.length === 1 && files[0].name === expected.name && files[0].size === expected.size;
  }, { name: path.basename(coverFile), size: file.size });
  if (!attached) throw new Error("Instagram did not retain the exact selected thumbnail file. Nothing was submitted.");
  const deadline = Date.now() + timeoutMs;
  do {
    for (const url of (await preview()).filter(url => !before.includes(url))) {
      // Read only local object/data URLs from the preview. A changed URL alone
      // can be an automatically generated video frame: require the exact file.
      const matches = await input.evaluate(async (el, previewUrl) => {
        const selected = (el as HTMLInputElement).files?.[0];
        if (!selected) return false;
        try {
          const expected = new Uint8Array(await selected.arrayBuffer());
          const actual = new Uint8Array(await (await fetch(previewUrl)).arrayBuffer());
          return expected.length === actual.length && expected.every((byte, i) => byte === actual[i]);
        } catch { return false; }
      }, url);
      if (matches) {
        log("Cover: applied selected thumbnail " + path.basename(coverFile) + " and verified exact preview bytes");
        return true;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  throw new Error("Instagram did not update the Cover photo preview with the selected thumbnail. Nothing was submitted; an automatic thumbnail was not used.");
}
