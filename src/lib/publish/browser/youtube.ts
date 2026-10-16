/**
 * SERVER-ONLY. YouTube, through YouTube Studio's own web uploader, behind the one
 * `Publisher` contract.
 *
 * THIS IS THE OPTIONAL ROUTE. The official YouTube Data API publisher
 * (`youtube/publisher.ts`) is the default and the recommended one; this exists
 * for an operator who has no Google Cloud project and would rather sign in to
 * Studio in a window. It is selected explicitly, per publish, and is never a
 * fallback for the API.
 *
 * THE FLOW, as an operator would do it by hand:
 *
 *   1. open studio.youtube.com                         (sign-in / security check -> AWAITING_HUMAN)
 *   2. confirm WHICH channel is signed in              (wrong channel -> AWAITING_HUMAN)
 *   3. Create -> Upload videos -> attach the render
 *   4. title, description, thumbnail, audience, tags   (each read back)
 *   5. Next x3 to Visibility; choose private/unlisted/public, or Schedule
 *   6. press the final button                          <- the point of no return
 *   7. open the video's own Studio page and READ IT BACK
 *
 * ONLY STEP 7 CAN PRODUCE A POSTED RESULT. The outcome is PUBLISHED only when the
 * video's own page reads back the title that was sent and the visibility that was
 * asked for, and the id came from the platform's own page. A click that "seemed
 * to work", a dialog that closed, a timeout, a page that would not load: all
 * AWAITING_HUMAN. Nothing in this file writes a posted result from anything but
 * the read-back (`judgeReadback`), and the id it writes is one Studio showed.
 *
 * WHAT IT WILL NOT DO. It never answers a sign-in, CAPTCHA, two-step prompt or
 * any verification: `assertNoWall` stops the job the moment one is on screen,
 * touching nothing. It never answers "made for kids" itself -- that is a legal
 * declaration, so the request has to carry the operator's answer (the API path
 * leaves it unset for the same reason). And if Studio keeps Next disabled because
 * some other required declaration is unanswered, it stops rather than guessing
 * one.
 *
 * UNVERIFIED AGAINST THE LIVE SITE. Studio's markup changes, and the selectors
 * below are the conventional ones, not ones proven on a signed-in account in this
 * build. The failure mode is designed to be safe: a selector that does not match
 * stops the job (AWAITING_HUMAN, window open, nothing published) rather than
 * clicking something else.
 */
import { PLATFORM_LABELS, PLATFORM_LIMITS } from "../limits";
import { PublishRefused } from "../contract";
import type {
  PlatformCapabilities,
  PreparedPublish,
  PublishOutcome,
  PublishRequest,
  PublishValidation,
} from "../contract";
import { handoffSteps } from "../manual";
import { judgeIdentity } from "../connect";
import { expectedHandle } from "../identity";
import { studioUrlFor, watchUrlFor } from "../youtube/config";
import { uploadTags, youTubePublisher } from "../youtube/publisher";
import type { EnvLike } from "../youtube/secrets";
import {
  NeedsHuman,
  assertNoWall,
  browserOptionProblems,
  chromiumProblem,
  clickOn,
  desiredVisibility,
  fillIn,
  finishStop,
  isNeedsHuman,
  isShown,
  readText,
  runInSession,
  snapshotOf,
  squash,
  judgePage,
  humanSentence,
  waitPresent,
  waitShown,
  waitUntil,
  type BrowserDeps,
  type BrowserHooks,
  type BrowserPublishOptions,
  type BrowserPublisher,
  type BrowserSession,
} from "./engine";

/** Studio's selectors, in one place so the first real run has one table to adjust. */
export const YT = {
  studio: "https://studio.youtube.com/",
  /** The signed-in shell. Its presence is what "Studio loaded and you are in" means. */
  appShell: "#create-icon, ytcp-app",
  dialog: "ytcp-uploads-dialog, ytcp-dialog, tp-yt-paper-dialog",
  createButton: "#create-icon",
  uploadItem: "#text-item-0",
  uploadsDialog: "ytcp-uploads-dialog",
  fileInput: 'ytcp-uploads-dialog input[type="file"], input[type="file"]',
  title: "#title-textarea #textbox",
  description: "#description-textarea #textbox",
  thumbnailInput: "input#file-loader",
  thumbnailShown: "ytcp-thumbnails-compact-editor-custom-thumbnail-image-editor, #custom-thumbnail img, ytcp-thumbnails-compact-editor-custom-thumbnail-image",
  kidsNo: '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
  kidsYes: '[name="VIDEO_MADE_FOR_KIDS_MFK"]',
  showMore: "#toggle-button",
  tagsInput: "#tags-container #text-input, ytcp-chip-bar #text-input",
  tagsBox: "#tags-container, ytcp-chip-bar",
  next: "#next-button",
  visibilityGroup: "#privacy-radios, tp-yt-paper-radio-group#privacy-radios",
  visibility: {
    private: '[name="PRIVATE"]',
    unlisted: '[name="UNLISTED"]',
    public: '[name="PUBLIC"]',
  },
  scheduleExpand: "#second-container-expand-button",
  dateTrigger: "#datepicker-trigger",
  dateInput: "ytcp-date-picker input, tp-yt-paper-dialog ytcp-date-picker input",
  timeInput: "#time-of-day-container input, ytcp-time-of-day-picker input",
  done: "#done-button",
  videoLink: ".video-url-fadeable a, ytcp-video-info a, ytcp-video-share-dialog a[href*='youtu']",
  shareDialog: "ytcp-video-share-dialog",
  editTitle: "#title-textarea #textbox",
  editVisibility: "ytcp-video-metadata-visibility, #visibility-text, ytcp-video-metadata-editor-sidepanel .visibility",
} as const;

// ----------------------------------------------------------------- pure readers

/** The 11-character id in a youtu.be, watch, shorts or Studio URL; null for anything else. */
export function videoIdFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /(?:youtu\.be\/|[?&]v=|\/video\/|\/shorts\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(text);
  return m ? m[1] : null;
}

/** The channel id in a Studio or channel URL. */
export function channelIdFrom(url: string | null | undefined): string | null {
  const m = /\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(url ?? "");
  return m ? m[1] : null;
}

/** The `@handle` YouTube redirected a channel URL to, or null when it did not. */
export function handleFromChannelUrl(url: string | null | undefined): string | null {
  const m = /youtube\.com\/(@[^/?#]+)/i.exec(url ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export type StudioVisibility = "scheduled" | "private" | "unlisted" | "public";

/** Which visibility a Studio label says. "Scheduled" wins: a scheduled video is also described as private until then. */
export function visibilityWord(text: string | null | undefined): StudioVisibility | null {
  const t = (text ?? "").toLowerCase();
  if (/\bscheduled\b/.test(t)) return "scheduled";
  if (/\bprivate\b/.test(t)) return "private";
  if (/\bunlisted\b/.test(t)) return "unlisted";
  if (/\bpublic\b/.test(t)) return "public";
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Narrow and no-break spaces that newer ICU puts before AM/PM become plain spaces. */
const plainSpaces = (s: string): string => s.replace(/\s/g, " ");

/** "Oct 20, 2026": what Studio's date field is typed with. English UI assumed; a read-back catches anything else. */
export function studioDateText(when: Date): string {
  return plainSpaces(when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
}

/** "3:00 PM". */
export function studioTimeText(when: Date): string {
  return plainSpaces(when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
}

/**
 * A local date and time out of the words Studio shows ("Oct 20, 2026, 3:00 PM",
 * "20 Oct 2026 at 15:00"). Null when either half cannot be found, which is a
 * reason to stop, not to guess.
 */
export function parseScheduledText(text: string | null | undefined): Date | null {
  const t = plainSpaces(text ?? "");
  let year: number;
  let month: number;
  let day: number;
  const us = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t);
  const eu = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(t);
  if (us && MONTHS.includes(us[1].slice(0, 3).toLowerCase())) {
    month = MONTHS.indexOf(us[1].slice(0, 3).toLowerCase());
    day = Number(us[2]);
    year = Number(us[3]);
  } else if (eu && MONTHS.includes(eu[2].slice(0, 3).toLowerCase())) {
    month = MONTHS.indexOf(eu[2].slice(0, 3).toLowerCase());
    day = Number(eu[1]);
    year = Number(eu[3]);
  } else {
    return null;
  }
  const time = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(t);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const meridiem = time[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return new Date(year, month, day, hour, minute, 0, 0);
}

/** Does the schedule Studio is showing equal the one that was meant? To the minute. */
export function sameSchedule(dateText: string, timeText: string, intended: Date): boolean {
  const shown = parseScheduledText(`${dateText} ${timeText}`);
  return shown !== null && Math.abs(shown.getTime() - intended.getTime()) < 60_000;
}

export interface StudioReadback {
  title: string | null;
  visibilityText: string | null;
}

export type ReadbackVerdict =
  | { ok: true; visibility: StudioVisibility; scheduledFor: Date | null }
  | { ok: false; problem: string };

/**
 * THE GATE. Is what the video's own Studio page says what was sent?
 *
 * This is the only thing in the YouTube browser publisher that can lead to a
 * posted result, and it is pure so the cases that must NOT pass are tested one by
 * one: a missing title, a different title, an unreadable visibility, the wrong
 * visibility, a scheduled video with no readable or a different time.
 */
export function judgeReadback(
  expected: { title: string; visibility: StudioVisibility; scheduledAt: Date | null },
  read: StudioReadback,
): ReadbackVerdict {
  if (read.title === null || squash(read.title) === "") {
    return { ok: false, problem: "Studio's page for the video did not show its title." };
  }
  if (squash(read.title) !== squash(expected.title)) {
    return { ok: false, problem: `Studio shows the title "${squash(read.title).slice(0, 120)}", not the one that was sent.` };
  }
  const seen = visibilityWord(read.visibilityText);
  if (seen === null) {
    return { ok: false, problem: "Studio's page for the video did not say whether it is private, unlisted, public or scheduled." };
  }
  if (seen !== expected.visibility) {
    return { ok: false, problem: `Studio shows the video as ${seen}, not ${expected.visibility} as asked.` };
  }
  if (seen === "scheduled") {
    const when = parseScheduledText(read.visibilityText);
    if (!when) return { ok: false, problem: "Studio says the video is scheduled but its time could not be read back." };
    if (!expected.scheduledAt || Math.abs(when.getTime() - expected.scheduledAt.getTime()) >= 60_000) {
      return { ok: false, problem: `Studio has the video scheduled for ${when.toLocaleString()}, not the time that was asked for.` };
    }
    return { ok: true, visibility: seen, scheduledFor: when };
  }
  return { ok: true, visibility: seen, scheduledFor: null };
}

/** Words that mean Studio will not take the upload at all. */
const BLOCKED_TEXT =
  /(upload limit|daily upload limit|can['’]?t upload|cannot upload|verify your (phone|account|identity)|verification (is )?required|temporarily unavailable|not available in your country)/i;

/** The word the final button must say for each choice. A different word is a page that did not take the choice. */
const FINAL_LABEL: Record<StudioVisibility, RegExp> = {
  private: /^save$/i,
  unlisted: /^(publish|save)$/i,
  public: /^publish$/i,
  scheduled: /^schedule$/i,
};

// ----------------------------------------------------------------- the publisher

export interface BrowserYouTubeContext {
  env?: EnvLike;
  /** What THIS publish asks for. Absent fields are the safe ones (private, nothing scheduled). */
  options?: BrowserPublishOptions;
  deps?: BrowserDeps;
}

export function browserYouTubePublisher(ctx: BrowserYouTubeContext = {}): BrowserPublisher {
  const env = ctx.env ?? process.env;
  const platform = "youtube" as const;
  const deps: BrowserDeps = { env, ...ctx.deps };
  // The request-level checks are the API publisher's, verbatim: same limits, same
  // tag budget, same refusal of < and >. It is pure, so no user or credential is needed.
  const requestChecks = youTubePublisher({ userId: null, env });

  const capabilities = (): PlatformCapabilities => ({
    id: platform,
    label: PLATFORM_LABELS[platform],
    canUpload: true,
    canSetThumbnail: true,
    // Studio's own "Schedule" control. The API path does not offer this.
    canSchedule: true,
    // It reads the video's own page back before saying anything succeeded.
    canReportBack: true,
    limits: PLATFORM_LIMITS[platform],
    requires: [
      "A Chromium on this server (found automatically; install with `npx playwright-core install chromium` if missing)",
      "A one-time sign-in to YouTube Studio by you, in the browser window this app opens -- it never types or stores your password",
      "That window left visible (BOOKREEL_PUBLISH_HEADLESS unset), so you can sign in and clear any security check yourself",
      "A verified channel, for the custom thumbnail only -- the video uploads either way",
    ],
  });

  const validate = (request: PublishRequest): PublishValidation => requestChecks.validate(request);

  const isConfigured = async (): Promise<boolean> => chromiumProblem(deps) === null;

  return {
    capabilities,
    isConfigured,
    validate,

    prepare: async (request): Promise<PreparedPublish> => {
      const verdict = validate(request);
      if (!verdict.ok) throw new PublishRefused(verdict.problems);
      return {
        platform,
        episodeId: request.episodeId,
        metadata: request.metadata,
        video: request.video,
        poster: request.poster,
        preparedAt: new Date(),
        status: (await isConfigured()) ? "READY" : "REQUIRES_CONNECTION",
        // The handoff is offered in every state, exactly as for the API provider.
        handoff: handoffSteps(platform, request),
      };
    },

    publish: async (prepared, hooks: BrowserHooks = {}): Promise<PublishOutcome> => {
      const options = ctx.options ?? {};
      const problems = browserOptionProblems(platform, options);
      if (problems.length > 0) return { status: "FAILED", error: problems.map((p) => p.message).join(" ") };
      return runInSession(platform, deps, (session) => youtubeFlow(session, prepared, options, hooks, env));
    },
  };
}

// ----------------------------------------------------------------- the flow

/** Wait for Studio to be a working, signed-in app -- or stop, touching nothing, if it is a wall. */
async function settleSignedIn(session: BrowserSession): Promise<void> {
  const selectors = { appShell: YT.appShell, dialog: YT.dialog };
  const verdict = await waitUntil(
    session.clock,
    async () => {
      const v = judgePage("youtube", await snapshotOf(session.page, selectors));
      return v.kind === "unknown" ? null : v;
    },
    { timeoutMs: 45_000, pollMs: 1_000 },
  );
  if (!verdict) {
    throw new NeedsHuman(
      "ui",
      "YouTube Studio did not finish loading, so it cannot be told whether you are signed in. Look at the open window.",
    );
  }
  if (verdict.kind === "signed_out") {
    throw new NeedsHuman("sign_in", humanSentence("youtube", "sign_in", { headless: session.headless }));
  }
  if (verdict.kind === "challenge") {
    throw new NeedsHuman("challenge", humanSentence("youtube", "challenge", { headless: session.headless, detail: verdict.why }));
  }
}

/**
 * Which channel is this? Read from YouTube's own redirect, with no selector: the
 * channel id is in Studio's address, and `youtube.com/channel/<id>` redirects to
 * `youtube.com/@handle`.
 *
 * A DIFFERENT handle always stops the job. A handle that cannot be read stops
 * anything that is not private -- a private upload can be deleted, a public or
 * scheduled one on the wrong channel cannot be unseen.
 */
async function confirmChannel(
  session: BrowserSession,
  visibility: StudioVisibility,
  env: EnvLike,
): Promise<void> {
  const { page } = session;
  const channelId = channelIdFrom(page.url());
  let handle: string | null = null;
  if (channelId) {
    try {
      await page.goto(`https://www.youtube.com/channel/${channelId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      handle = handleFromChannelUrl(page.url());
    } catch {
      handle = null;
    }
    await page.goto(YT.studio, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settleSignedIn(session);
  }

  const expected = expectedHandle("youtube", env);
  const verdict = judgeIdentity(handle, expected);
  if (verdict === "match") return;
  if (verdict === "mismatch") {
    throw new NeedsHuman(
      "mismatch",
      `Wrong YouTube channel. This window is signed in to ${handle}, but this install publishes to ${expected}. ` +
        "Nothing was published. Switch to the right channel in the open window (or sign in as the right account), then press Retry.",
    );
  }
  if (visibility !== "private") {
    throw new NeedsHuman(
      "mismatch",
      `YouTube did not say which channel this window is signed in to, so it cannot be checked against ${expected}. ` +
        "A public, unlisted or scheduled post is not made without that check. Nothing was published. " +
        "Publish it as private instead, or open the channel in the window and press Retry.",
    );
  }
}

/** A video id the page is showing, from any link that carries one. */
async function seenVideoId(session: BrowserSession): Promise<string | null> {
  const { page } = session;
  const href = await page.locator(YT.videoLink).first().getAttribute("href", { timeout: 2_000 }).catch(() => null);
  return videoIdFrom(href) ?? videoIdFrom(await readText(page, YT.videoLink));
}

async function readAriaChecked(session: BrowserSession, selector: string): Promise<boolean> {
  const value = await session.page.locator(selector).first().getAttribute("aria-checked", { timeout: 3_000 }).catch(() => null);
  return value === "true";
}

async function setAudience(session: BrowserSession, madeForKids: boolean): Promise<void> {
  const choice = madeForKids ? YT.kidsYes : YT.kidsNo;
  await clickOn(session, choice, madeForKids ? "the \"made for kids\" option" : "the \"not made for kids\" option");
  if (!(await readAriaChecked(session, choice))) {
    throw new NeedsHuman("mismatch", "The audience (made for kids) choice did not take on the page. Nothing was published.");
  }
}

async function setTags(session: BrowserSession, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  if (!(await isShown(session.page, YT.tagsInput)) && (await isShown(session.page, YT.showMore))) {
    await session.page.locator(YT.showMore).first().click({ timeout: 15_000 });
  }
  for (const tag of tags) {
    await fillIn(session, YT.tagsInput, "the tags box", tag);
    await session.page.keyboard.press("Enter");
  }
  const shown = (await readText(session.page, YT.tagsBox)).toLowerCase();
  const missing = tags.filter((t) => !shown.includes(t.toLowerCase()));
  if (missing.length > 0) {
    throw new NeedsHuman(
      "mismatch",
      `${missing.length} of the ${tags.length} tags did not show on the page (for example "${missing[0]}"). Nothing was published.`,
    );
  }
}

/** Attach the poster. Separate from the video's outcome: a refused thumbnail never fails an upload. */
async function setThumbnail(
  session: BrowserSession,
  file: string | null,
): Promise<{ applied: boolean; reason: string | null }> {
  if (!file) return { applied: false, reason: "This episode had no poster to set." };
  if (!(await waitPresent(session, YT.thumbnailInput, 8_000))) {
    return {
      applied: false,
      reason: "Studio offered no custom-thumbnail control (the channel may not be verified), so no thumbnail was set.",
    };
  }
  try {
    await session.page.locator(YT.thumbnailInput).first().setInputFiles(file);
  } catch (err) {
    return { applied: false, reason: `The poster could not be attached: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (await waitShown(session, YT.thumbnailShown, 15_000)) return { applied: true, reason: null };
  return {
    applied: false,
    reason: "The poster was attached but Studio did not show it as the chosen thumbnail, so it is not counted as applied. Check it in Studio.",
  };
}

async function setSchedule(session: BrowserSession, when: Date): Promise<void> {
  await clickOn(session, YT.scheduleExpand, "the Schedule section");
  await clickOn(session, YT.dateTrigger, "the schedule date field");
  await fillIn(session, YT.dateInput, "the schedule date box", studioDateText(when));
  await session.page.keyboard.press("Enter");
  await fillIn(session, YT.timeInput, "the schedule time box", studioTimeText(when));
  await session.page.keyboard.press("Enter");

  const dateText = await readText(session.page, YT.dateTrigger);
  const timeText = squash(await session.page.locator(YT.timeInput).first().inputValue({ timeout: 3_000 }).catch(() => ""));
  if (!sameSchedule(dateText, timeText, when)) {
    throw new NeedsHuman(
      "mismatch",
      `Studio shows the schedule as "${dateText} ${timeText}", not ${studioDateText(when)} ${studioTimeText(when)}. Nothing was published.`,
    );
  }
}

async function chooseVisibility(session: BrowserSession, visibility: StudioVisibility, when: Date | null): Promise<void> {
  if (visibility === "scheduled") {
    await setSchedule(session, when as Date);
    return;
  }
  const selector = YT.visibility[visibility];
  await clickOn(session, selector, `the ${visibility} option`);
  if (!(await readAriaChecked(session, selector))) {
    throw new NeedsHuman("mismatch", `The ${visibility} choice did not take on the page. Nothing was published.`);
  }
}

async function finalButton(session: BrowserSession): Promise<{ enabled: boolean; label: string }> {
  const button = session.page.locator(YT.done).first();
  if ((await button.count().catch(() => 0)) === 0) return { enabled: false, label: "" };
  const [enabled, label] = await Promise.all([
    button.isEnabled().catch(() => false),
    button.innerText({ timeout: 2_000 }).then(squash).catch(() => ""),
  ]);
  return { enabled, label };
}

/** Read the video's own Studio page. Null when it would not load. */
async function readVideoPage(session: BrowserSession, videoId: string): Promise<StudioReadback | null> {
  const { page } = session;
  try {
    await page.goto(studioUrlFor(videoId), { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch {
    return null;
  }
  if (!(await waitShown(session, YT.editTitle, 45_000))) return null;
  // Studio fills the visibility label in a moment after the title.
  await waitShown(session, YT.editVisibility, 15_000);
  return {
    title: await readText(page, YT.editTitle),
    visibilityText: await readText(page, YT.editVisibility),
  };
}

async function youtubeFlow(
  session: BrowserSession,
  prepared: PreparedPublish,
  options: BrowserPublishOptions,
  hooks: BrowserHooks,
  env: EnvLike,
): Promise<PublishOutcome> {
  const { page } = session;
  const visibility = desiredVisibility(options);
  const scheduledAt = visibility === "scheduled" ? (options.scheduledAt as Date) : null;
  const wall = { appShell: YT.appShell, dialog: YT.dialog };
  let committed = false;
  let videoId: string | null = null;

  try {
    await hooks.onStage?.("PREPARING");

    // 1. Open Studio. Failing to reach it at all is the one failure that is
    //    certainly harmless: nothing has been touched.
    try {
      await page.goto(YT.studio, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (err) {
      return {
        status: "FAILED",
        error: `Could not open YouTube Studio: ${err instanceof Error ? err.message : String(err)}. Nothing was uploaded.`,
      };
    }
    await settleSignedIn(session);
    await confirmChannel(session, visibility, env);

    // 2. Create -> Upload videos -> attach the render.
    await clickOn(session, YT.createButton, "the Create button");
    await clickOn(session, YT.uploadItem, "the \"Upload videos\" menu item");
    if (!(await waitPresent(session, YT.fileInput, 30_000))) {
      throw new NeedsHuman("ui", "The upload dialog did not offer a file picker.");
    }
    await page.locator(YT.fileInput).first().setInputFiles(prepared.video.path);
    await hooks.onStage?.("UPLOADING");
    await assertNoWall("youtube", session, wall);

    // 3. The Details step: either the title box, or a reason Studio will not go on.
    const reachedDetails = await waitShown(session, YT.title, 120_000);
    if (!reachedDetails) {
      const dialog = await readText(page, YT.dialog);
      if (BLOCKED_TEXT.test(dialog)) {
        throw new NeedsHuman("blocked", `YouTube will not take the upload: "${dialog.slice(0, 160)}".`);
      }
      throw new NeedsHuman("ui", "Studio did not reach the video details step.");
    }
    await assertNoWall("youtube", session, wall);
    videoId = await seenVideoId(session);

    // 4. Title and description, each filled whole and read back.
    await fillIn(session, YT.title, "the title box", prepared.metadata.title);
    if (squash(await readText(page, YT.title)) !== squash(prepared.metadata.title)) {
      throw new NeedsHuman("mismatch", "The title on the page is not the one that was typed. Nothing was published.");
    }
    await fillIn(session, YT.description, "the description box", prepared.metadata.description);
    if (squash(await readText(page, YT.description)) !== squash(prepared.metadata.description)) {
      throw new NeedsHuman("mismatch", "The description on the page is not the one that was typed. Nothing was published.");
    }

    const thumbnail = await setThumbnail(session, prepared.poster?.path ?? null);
    await setAudience(session, options.madeForKids === true);
    await setTags(session, uploadTags(prepared.metadata));

    // 5. Next until Visibility. A Next that stays disabled is Studio waiting on
    //    something this app does not answer for the operator.
    for (let step = 0; step < 4 && !(await isShown(page, YT.visibilityGroup)); step++) {
      const ready = await waitUntil(
        session.clock,
        async () => (await page.locator(YT.next).first().isEnabled()) === true,
        { timeoutMs: 60_000, pollMs: 1_000 },
      );
      if (!ready) {
        throw new NeedsHuman(
          "blocked",
          "Studio kept Next disabled: it is waiting on a required answer this app does not give for you (for example an " +
            "altered-content or audience declaration). Answer it in the open window and finish there.",
        );
      }
      await page.locator(YT.next).first().click({ timeout: 15_000 });
      await session.clock.sleep(1_500);
      await assertNoWall("youtube", session, wall);
    }
    if (!(await waitShown(session, YT.visibilityGroup, 30_000))) {
      throw new NeedsHuman("ui", "Studio never reached the Visibility step.");
    }
    videoId = videoId ?? (await seenVideoId(session));

    // 6. Visibility, then the point of no return.
    await chooseVisibility(session, visibility, scheduledAt);

    const ready = await waitUntil(session.clock, async () => (await finalButton(session)).enabled || null, {
      timeoutMs: 10 * 60_000,
      pollMs: 2_000,
    });
    if (!ready) {
      throw new NeedsHuman("blocked", "Studio kept the final button disabled (the upload may still be processing).");
    }
    const final = await finalButton(session);
    if (!FINAL_LABEL[visibility].test(final.label)) {
      throw new NeedsHuman(
        "ui",
        `The final button says "${final.label || "nothing"}", not what a ${visibility} post needs, so it was not pressed.`,
      );
    }
    await assertNoWall("youtube", session, wall);

    await page.locator(YT.done).first().click({ timeout: 15_000 });
    committed = true;

    // 7. Wait for Studio to finish the save before leaving the page: navigating
    //    away mid-save could drop it. The share dialog (public/unlisted/scheduled)
    //    carries the link; either that or the upload dialog closing means it settled.
    const settled = await waitUntil(
      session.clock,
      async () => (await isShown(page, YT.shareDialog)) || !(await isShown(page, YT.uploadsDialog)) || null,
      { timeoutMs: 3 * 60_000, pollMs: 1_000 },
    );
    if (!settled) {
      throw new NeedsHuman(
        "unconfirmed",
        `The final button was pressed but Studio never finished: the upload dialog is still open. It is not known whether the video was ${
          visibility === "scheduled" ? "scheduled" : "saved"
        }. Look at the open window, and check YouTube Studio before trying again.`,
        { externalId: videoId },
      );
    }
    videoId = (await seenVideoId(session)) ?? videoId;
    if (!videoId) {
      throw new NeedsHuman(
        "unconfirmed",
        "The final button was pressed and the dialog closed, but Studio never showed the video's link, so the result cannot be confirmed. " +
          "Check YouTube Studio before trying again: the video is probably there.",
      );
    }

    // 8. THE CONFIRMATION: the video's own page, read back.
    const read = await readVideoPage(session, videoId);
    if (!read) {
      throw new NeedsHuman(
        "unconfirmed",
        `The final button was pressed, but the video's own Studio page (${studioUrlFor(videoId)}) would not load, so the result cannot be confirmed. ` +
          "The video is probably there. Check YouTube Studio before trying again.",
        { externalId: videoId, externalUrl: watchUrlFor(videoId) },
      );
    }
    const verdict = judgeReadback({ title: prepared.metadata.title, visibility, scheduledAt }, read);
    if (!verdict.ok) {
      throw new NeedsHuman(
        "mismatch",
        `The final button was pressed, but ${verdict.problem} It is NOT recorded as posted. Check YouTube Studio before trying again.`,
        { externalId: videoId, externalUrl: watchUrlFor(videoId) },
      );
    }

    return {
      status: "PUBLISHED",
      externalId: videoId,
      externalUrl: watchUrlFor(videoId),
      confirmedAt: new Date(),
      thumbnail,
      reviewUrl: studioUrlFor(videoId),
      visibility: verdict.visibility,
      scheduledFor: verdict.scheduledFor,
    };
  } catch (err) {
    if (isNeedsHuman(err)) return finishStop("youtube", err, committed);
    // Anything else: the page did something this flow did not expect.
    const what = err instanceof Error ? err.message : String(err);
    return finishStop(
      "youtube",
      new NeedsHuman("ui", `YouTube Studio did something unexpected (${what}).`, {
        externalId: committed ? videoId : null,
      }),
      committed,
    );
  }
}

