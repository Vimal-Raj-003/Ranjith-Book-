import type { Page } from "playwright-core";
import type { PageLike } from "./engine";
import type { PublishMetadata } from "../limits";
import { applySchedule, readScheduledFromChannel } from "./youtube-schedule";
import { waitForUpload } from "./youtube-finish";
import { applyVideoSettings, closePreviewPlayer, setYouTubeTags } from "./youtube-settings";
import type { EnvLike } from "../youtube/secrets";
import { judgeScheduledView, parseOffset, studioTargetAtOffset, gmtLabel } from "../native-schedule";

// The receipt uses the zone verified by this page's scheduling picker. Never
// infer it from the server's timezone or from the requested time alone.
const verifiedZones = new WeakMap<PageLike, number>();

export async function confirmScheduleReceipt(page: Page, id: string, title: string, at: Date, offset?: number): Promise<{ok:boolean;problem?:string} | null> {
  const dialog = page.getByRole("dialog", {name:"Video scheduled",exact:true});
  if (!(await dialog.isVisible().catch(()=>false))) return null;
  if (offset === undefined) return null;
  const receipt = await dialog.evaluate((root, expectedTitle) => {
    return {text:(root as HTMLElement).innerText,
      titleMatches:[...root.querySelectorAll("*")].some(el=>(el.textContent??"").normalize("NFKC").replace(/\s+/g," ").trim()===expectedTitle.normalize("NFKC").replace(/\s+/g," ").trim()),
      links:[...root.querySelectorAll("a[href]")].map(a=>a.getAttribute("href")??"")};
  }, title);
  const matchingId = receipt.links.some(link=>/(?:youtu\.be\/|[?&]v=|\/shorts\/)([\w-]{11})(?![\w-])/.exec(link)?.[1]===id);
  const verdict = judgeScheduledView({title, text:`${receipt.text} ${gmtLabel(offset)}`}, {title,target:studioTargetAtOffset(at,offset)});
  const ok = matchingId && receipt.titleMatches && verdict.scheduled && verdict.timeConfirmed;
  return {ok,problem:ok?undefined:"Studio's scheduling receipt did not match the approved video ID, exact title, date and time."};
}

/** Injection seam for orchestration tests; production uses the RepoReel controls. */
export interface YouTubeScheduleControls {
  tags?(page: PageLike, tags: string[], log: (message: string) => void): Promise<void>;
  details?(page: PageLike, env: EnvLike, log: (message: string) => void): Promise<void>;
  apply(page: PageLike, at: Date, log: (message: string) => void): Promise<void>;
  confirm(page: PageLike, id: string, title: string, at: Date): Promise<{ ok: boolean; problem?: string }>;
  uploadComplete(page: PageLike, log: (message: string) => void): Promise<void>;
  inspectRetry(page: PageLike, id: string, metadata: PublishMetadata, episodeId: string, at: Date): Promise<"confirmed" | "draft">;
}

export const youtubeScheduleControls: YouTubeScheduleControls = {
  async tags(page, tags, log) { await setYouTubeTags(page as unknown as Page, tags, log); },
  async details(like, env, log) {
    const page = like as unknown as Page;
    await closePreviewPlayer(page, log);
    const options = { language: "English", category: env.BOOKREEL_YOUTUBE_VIDEO_CATEGORY ?? "", location: "Chennai, Tamil Nadu", aiDisclosure: true };
    const result = await applyVideoSettings(page, options, log);
    const missing = [!result.aiUse && "AI disclosure: Yes", !result.language && "Video language: English", !result.location && "Video location: exact Chennai, Tamil Nadu autocomplete selection", options.category && !result.category && "configured category"].filter(Boolean);
    if (missing.length) throw new Error(`Studio Details settings could not be verified: ${missing.join("; ")}. Review the saved draft; no final publishing button was pressed.`);
  },
  async apply(page, at, log) {
    verifiedZones.delete(page);
    const result = await applySchedule(page as unknown as Page, at, log);
    if (!result.ok || !result.zoneVerified) throw new Error(result.problems.join(" ") || "Studio's scheduling time zone could not be verified.");
    if (result.target) verifiedZones.set(page,result.target.offsetMinutes);
  },
  async confirm(page, id, title, at) {
    const receipt = await confirmScheduleReceipt(page as unknown as Page,id,title,at,verifiedZones.get(page));
    if (receipt && !receipt.ok) return receipt;
    // The submission dialog can show the requested time while Studio has saved
    // a different date. Always re-open this same video and verify persisted state
    // before declaring success; never retry the upload on a mismatch.
    const view = await readScheduledFromChannel(page as unknown as Page, id);
    const offset = parseOffset(view?.text ?? "");
    if (!view || offset === null) return { ok: false, problem: "Studio did not confirm the saved schedule and time zone." };
    const verdict = judgeScheduledView(view, { title, target: studioTargetAtOffset(at, offset) });
    const exactTitle = (view.title ?? "").normalize("NFKC").replace(/\s+/g, " ").trim() === title.normalize("NFKC").replace(/\s+/g, " ").trim();
    return { ok: verdict.scheduled && verdict.timeConfirmed && exactTitle, problem: verdict.problems.join(" ") || (!exactTitle ? "Studio did not show the exact approved title." : undefined) };
  },
  async uploadComplete(page, log) {
    const result = await waitForUpload(page as unknown as Page, log);
    if (result.issue) throw new Error(result.issue);
  },
  async inspectRetry(like, id, metadata, episodeId, at) {
    const page = like as unknown as Page;
    const view = await readScheduledFromChannel(page, id);
    if (!view) throw new Error("The earlier YouTube upload could not be read. Inspect Studio; no second file was selected.");
    const clean = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
    const title = clean(view.title ?? "");
    const description = await page.locator("#description-textarea #textbox").first().innerText({ timeout: 5_000 }).catch(() => null);
    const exactTitle = title === clean(metadata.title);
    const exactDescription = description !== null && clean(description) === clean(metadata.description);
    if (/\bscheduled\b/i.test(view.text ?? "")) {
      const offset = parseOffset(view.text ?? "");
      if (offset === null) throw new Error("The existing schedule has no readable timezone. Inspect Studio before retrying.");
      const verdict = judgeScheduledView(view, { title: metadata.title, target: studioTargetAtOffset(at, offset) });
      if (!verdict.timeConfirmed || !exactTitle || !exactDescription) throw new Error("The existing YouTube schedule's full copy or time differs. It was left unchanged.");
      return "confirmed";
    }
    const ownFilename = title.toLowerCase().includes(episodeId.toLowerCase());
    const approvedPartial = description !== null && clean(metadata.description).startsWith(clean(description));
    const draft = /\bdraft\b/i.test(view.text ?? "") && (exactTitle || ownFilename) && approvedPartial;
    const privateVideo = /^\s*private\b/i.test(view.text ?? "") && exactTitle && exactDescription;
    if (!draft && !privateVideo) throw new Error("The earlier upload is not a verified draft of the approved BookReel content. No second upload was started.");
    const edit = page.getByRole("button", { name: /edit draft/i }).first();
    if (await edit.isVisible().catch(() => false)) {
      await edit.click({ timeout: 10_000 });
      await page.waitForSelector("ytcp-uploads-dialog #title-textarea #textbox", { timeout: 15_000 }).catch(() => {});
      await page.evaluate(() => {
        if (!document.querySelector("ytcp-uploads-dialog #title-textarea #textbox")) return;
        for (const el of document.querySelectorAll("ytcp-video-metadata-editor, #title-textarea, #description-textarea, #toggle-button, #tags-container, ytcp-chip-bar, [name='VIDEO_MADE_FOR_KIDS_NOT_MFK'], [name='VIDEO_MADE_FOR_KIDS_MFK']")) {
          if (!el.closest("ytcp-uploads-dialog")) el.remove();
        }
      }).catch(() => {});
    }
    return "draft";
  },
};
