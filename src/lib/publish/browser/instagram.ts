/**
 * SERVER-ONLY. Instagram, through instagram.com's own web uploader, behind the one
 * `Publisher` contract.
 *
 * THIS IS THE OPTIONAL ROUTE. Meta's Content Publishing API publisher
 * (`instagram/publisher.ts`) is the default and the recommended one. This is for
 * an operator who has no Meta app and would rather sign in to Instagram in a
 * window. It is selected explicitly, per publish, and is never a fallback.
 *
 * THE FLOW:
 *
 *   1. open instagram.com                           (log-in / security check -> AWAITING_HUMAN)
 *   2. read WHICH account is signed in              (wrong or unreadable -> AWAITING_HUMAN)
 *   3. note the account's existing reels            (so the new one can be told apart afterwards)
 *   4. New post -> attach the render -> Next -> cover -> Next
 *   5. caption = `instagramCaption(metadata)`, read back
 *   6. press Share                                  <- the point of no return, and PUBLIC
 *   7. wait for Instagram's own "shared" sentence, then FIND THE NEW REEL'S LINK
 *
 * ONLY STEP 7 CAN PRODUCE A POSTED RESULT, and it needs BOTH halves: Instagram's
 * own confirmation that the Reel was shared, and the reel's own link -- a link
 * that was not on the profile before Share and whose page carries the caption
 * that was sent. The shortcode in that link is the id. "Shared" with no link
 * found is AWAITING_HUMAN ("it is up, do NOT retry"), because the contract's
 * PUBLISHED needs an id the platform showed and an id this code invented would be
 * worse than none.
 *
 * NO SCHEDULING, and none is faked. Instagram's web uploader offers a schedule
 * only to some accounts; this flow does not drive it, and `browserOptionProblems`
 * refuses a request that asks for one rather than posting it immediately.
 *
 * WHAT IT WILL NOT DO. It never answers a log-in, CAPTCHA, "confirm it's you",
 * two-step prompt or "suspicious activity" screen: `assertNoWall` stops the job
 * the moment one is on screen, touching nothing. A Reel is public the instant it
 * is shared, so the options must carry `confirmPublic: true` -- checked here as
 * well as in the route.
 *
 * UNVERIFIED AGAINST THE LIVE SITE. Instagram's markup is obfuscated and changes
 * often; the selectors below are the conventional ones, not ones proven on a
 * signed-in account in this build. A selector that does not match stops the job
 * (AWAITING_HUMAN, window open, nothing posted) rather than clicking something
 * else.
 */
import { instagramCaption, PLATFORM_LABELS, PLATFORM_LIMITS } from "../limits";
import { PublishRefused } from "../contract";
import type {
  PlatformCapabilities,
  PreparedPublish,
  PublishOutcome,
  PublishRequest,
  PublishValidation,
} from "../contract";
import { handoffSteps, manualHandoff } from "../manual";
import { judgeIdentity } from "../connect";
import { expectedHandle } from "../identity";
import type { EnvLike } from "../youtube/secrets";
import {
  NeedsHuman,
  assertNoWall,
  browserOptionProblems,
  chromiumProblem,
  clickOn,
  fillIn,
  finishStop,
  humanSentence,
  isNeedsHuman,
  isShown,
  judgePage,
  readText,
  runInSession,
  snapshotOf,
  squash,
  waitPresent,
  waitShown,
  waitUntil,
  type BrowserDeps,
  type BrowserHooks,
  type BrowserPublishOptions,
  type BrowserPublisher,
  type BrowserSession,
} from "./engine";

/** Instagram's selectors, in one place so the first real run has one table to adjust. */
export const IG = {
  home: "https://www.instagram.com/",
  /** The signed-in shell: the Create control. */
  appShell: 'svg[aria-label="New post"], svg[aria-label="Home"]',
  dialog: 'div[role="dialog"]',
  newPost: 'svg[aria-label="New post"]',
  postItem: 'svg[aria-label="Post"]',
  fileInput: 'input[type="file"]',
  next: 'div[role="button"]:text-is("Next"), button:text-is("Next")',
  coverSelect: 'div[role="button"]:text-is("Select from computer"), button:text-is("Select from computer")',
  caption: 'div[aria-label="Write a caption..."][contenteditable="true"], div[contenteditable="true"][aria-label*="caption" i]',
  share: 'div[role="button"]:text-is("Share"), button:text-is("Share")',
  notNow: 'button:text-is("Not Now"), div[role="button"]:text-is("Not Now")',
  profilePicture: 'img[alt$="\'s profile picture"]',
  reelLinks: 'a[href*="/reel/"], a[href*="/p/"]',
} as const;

// ----------------------------------------------------------------- pure readers

export type ShareState = "shared" | "sharing" | "needs_human" | "failed" | "unknown";

/** Instagram's own sentence that the Reel is up. Nothing else counts as "shared". */
const SHARED = /(your (reel|post|video) (has been|was|is now) shared|^\s*(reel|post) shared\b(?!\s*\?))/i;
const NEEDS_HUMAN =
  /(confirm (that )?(it['’]?s|this is) you|confirm your identity|verify (your )?(identity|account|phone)|suspicious|security check|unusual activity|action blocked|temporarily blocked|we restrict certain activity|checkpoint|log in again|session (has )?expired|captcha|not a robot)/i;
const FAILED = /((couldn['’]?t|could not|unable to|failed to|can['’]?t) (be )?(share|post|upload)|something went wrong|try again later|we ran into a problem|there was a problem)/i;
const SHARING = /(sharing|uploading|processing|posting|please wait)/i;

/**
 * What the dialog on screen says about the Reel. "Shared" is checked first and
 * only on Instagram's own sentence; a person being needed outranks a plain
 * failure because it says what to do.
 */
export function readShareState(raw: string): { state: ShareState; text: string } {
  const text = squash(raw);
  if (SHARED.test(text)) return { state: "shared", text };
  if (NEEDS_HUMAN.test(text)) return { state: "needs_human", text };
  if (FAILED.test(text)) return { state: "failed", text };
  if (SHARING.test(text)) return { state: "sharing", text };
  return { state: "unknown", text };
}

/** The shortcode in a reel or post link; null for anything else. */
export function shortcodeFrom(href: string | null | undefined): string | null {
  const m = /\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,})/.exec(href ?? "");
  return m ? m[1] : null;
}

/** `between_pages's profile picture` -> `between_pages`. */
export function handleFromAlt(alt: string | null | undefined): string | null {
  const m = /^(.+?)['’]s profile picture$/i.exec((alt ?? "").trim());
  return m ? m[1].trim() : null;
}

/** Shortcodes present now that were not before. Order kept: newest first on a profile. */
export function newShortcodes(before: ReadonlySet<string>, now: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of now) {
    if (before.has(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** The opening of the caption a page must show for it to be the Reel that was just sent. Empty means "no text to match". */
export function captionHead(caption: string): string {
  return squash(caption).slice(0, 40);
}

// ----------------------------------------------------------------- the publisher

export interface BrowserInstagramContext {
  env?: EnvLike;
  /** What THIS publish asks for. Instagram needs `confirmPublic: true`; nothing else applies. */
  options?: BrowserPublishOptions;
  deps?: BrowserDeps;
}

export function browserInstagramPublisher(ctx: BrowserInstagramContext = {}): BrowserPublisher {
  const env = ctx.env ?? process.env;
  const platform = "instagram" as const;
  const deps: BrowserDeps = { env, ...ctx.deps };
  // The request-level checks are the hand-off's: the same ones the API publisher
  // uses, so an episode that can be handed off can be posted this way.
  const handoff = manualHandoff(platform);

  const capabilities = (): PlatformCapabilities => ({
    id: platform,
    label: PLATFORM_LABELS[platform],
    canUpload: true,
    // The cover picker is driven, but Instagram gives no read-back for it, so
    // this app does not claim to have set one.
    canSetThumbnail: false,
    // Instagram's web uploader does not schedule for most accounts, and this flow
    // does not fake it.
    canSchedule: false,
    // It waits for Instagram's own "shared" sentence and finds the new reel's link.
    canReportBack: true,
    limits: PLATFORM_LIMITS[platform],
    requires: [
      "A Chromium on this server (found automatically; install with `npx playwright-core install chromium` if missing)",
      "A one-time log-in to Instagram by you, in the browser window this app opens -- it never types or stores your password",
      "That window left visible (BOOKREEL_PUBLISH_HEADLESS unset), so you can log in and clear any security check yourself",
      "The signed-in account's @handle matching the expected one, read from Instagram's own page",
    ],
  });

  const validate = (request: PublishRequest): PublishValidation => handoff.validate(request);
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
        handoff: handoffSteps(platform, request),
      };
    },

    publish: async (prepared, hooks: BrowserHooks = {}): Promise<PublishOutcome> => {
      const options = ctx.options ?? {};
      const problems = browserOptionProblems(platform, options);
      if (problems.length > 0) return { status: "FAILED", error: problems.map((p) => p.message).join(" ") };
      return runInSession(platform, deps, (session) => instagramFlow(session, prepared, hooks, env));
    },
  };
}

// ----------------------------------------------------------------- the flow

async function settleSignedIn(session: BrowserSession): Promise<void> {
  const selectors = { appShell: IG.appShell, dialog: IG.dialog };
  const verdict = await waitUntil(
    session.clock,
    async () => {
      const v = judgePage("instagram", await snapshotOf(session.page, selectors));
      return v.kind === "unknown" ? null : v;
    },
    { timeoutMs: 45_000, pollMs: 1_000 },
  );
  if (!verdict) {
    throw new NeedsHuman(
      "ui",
      "Instagram did not finish loading, so it cannot be told whether you are logged in. Look at the open window.",
    );
  }
  if (verdict.kind === "signed_out") {
    throw new NeedsHuman("sign_in", humanSentence("instagram", "sign_in", { headless: session.headless }));
  }
  if (verdict.kind === "challenge") {
    throw new NeedsHuman("challenge", humanSentence("instagram", "challenge", { headless: session.headless, detail: verdict.why }));
  }
}

/** Dismiss the routine "Not Now" prompts (notifications, saving a log-in). Never anything that asks for a code. */
async function dismissRoutinePrompts(session: BrowserSession): Promise<void> {
  for (let i = 0; i < 2; i++) {
    if (!(await isShown(session.page, IG.notNow))) return;
    await session.page.locator(IG.notNow).first().click({ timeout: 10_000 }).catch(() => {});
    await session.clock.sleep(800);
  }
}

/** Every reel or post shortcode currently linked from the profile's reels page. */
async function profileShortcodes(session: BrowserSession, handle: string): Promise<string[]> {
  const { page } = session;
  await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/reels/`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  // A profile with no reels has no links to wait for, so this is bounded and a
  // timeout is "none", provided the page itself is the signed-in app.
  await waitPresent(session, IG.reelLinks, 15_000);
  const total = Math.min(await page.locator(IG.reelLinks).count(), 30);
  const codes: string[] = [];
  for (let i = 0; i < total; i++) {
    const code = shortcodeFrom(await page.locator(IG.reelLinks).nth(i).getAttribute("href", { timeout: 2_000 }).catch(() => null));
    if (code) codes.push(code);
  }
  return codes;
}

/**
 * The new Reel's link: not on the profile before Share, and its page shows the
 * caption that was sent. The grid can lag a few seconds behind Share, so this
 * looks a handful of times, then gives up -- which is AWAITING_HUMAN, not a guess.
 */
async function findNewReel(
  session: BrowserSession,
  handle: string,
  before: ReadonlySet<string>,
  head: string,
): Promise<{ code: string; url: string } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const fresh = newShortcodes(before, await profileShortcodes(session, handle).catch(() => []));
    for (const code of fresh.slice(0, 3)) {
      const url = `https://www.instagram.com/reel/${code}/`;
      try {
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch {
        continue;
      }
      await session.clock.sleep(1_500);
      const body = (await readText(session.page, "body")).toLowerCase();
      if (head === "" || body.includes(head.toLowerCase())) return { code, url };
    }
    await session.clock.sleep(10_000);
  }
  return null;
}

async function instagramFlow(
  session: BrowserSession,
  prepared: PreparedPublish,
  hooks: BrowserHooks,
  env: EnvLike,
): Promise<PublishOutcome> {
  const { page } = session;
  const wall = { appShell: IG.appShell, dialog: IG.dialog };
  const caption = instagramCaption(prepared.metadata);
  let committed = false;

  try {
    await hooks.onStage?.("PREPARING");

    // 1. Open Instagram. Failing to reach it at all is certainly harmless.
    try {
      await page.goto(IG.home, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (err) {
      return {
        status: "FAILED",
        error: `Could not open Instagram: ${err instanceof Error ? err.message : String(err)}. Nothing was posted.`,
      };
    }
    await settleSignedIn(session);
    await dismissRoutinePrompts(session);

    // 2. WHICH account? A Reel is public the instant it is shared, so an account
    //    that cannot be read is treated like a wrong one.
    const alt = await page.locator(IG.profilePicture).first().getAttribute("alt", { timeout: 5_000 }).catch(() => null);
    const handle = handleFromAlt(alt);
    const expected = expectedHandle("instagram", env);
    const verdict = judgeIdentity(handle, expected);
    if (verdict === "mismatch") {
      throw new NeedsHuman(
        "mismatch",
        `Wrong Instagram account. This window is logged in as @${handle}, but this install publishes to ${expected}. ` +
          "Nothing was posted. Log in as the right account in the open window, then press Retry.",
      );
    }
    if (verdict !== "match" || !handle) {
      throw new NeedsHuman(
        "mismatch",
        `Instagram did not say which account this window is logged in to, so it cannot be checked against ${expected}. ` +
          "A public post is not made without that check. Nothing was posted. Look at the open window, then press Retry.",
      );
    }

    // 3. What is on the profile NOW, so the new Reel can be told apart afterwards.
    let before: Set<string>;
    try {
      before = new Set(await profileShortcodes(session, handle));
    } catch (err) {
      throw new NeedsHuman(
        "ui",
        `The account's reels page would not load (${err instanceof Error ? err.message : String(err)}), so the new Reel could not be found afterwards.`,
      );
    }
    await assertNoWall("instagram", session, wall);

    // 4. New post -> the render.
    await page.goto(IG.home, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settleSignedIn(session);
    await clickOn(session, IG.newPost, "the New post button");
    if (await waitShown(session, IG.postItem, 4_000)) await page.locator(IG.postItem).first().click({ timeout: 10_000 });
    if (!(await waitPresent(session, IG.fileInput, 30_000))) {
      throw new NeedsHuman("ui", "Instagram's new-post dialog did not offer a file picker.");
    }
    await page.locator(IG.fileInput).first().setInputFiles(prepared.video.path);
    await hooks.onStage?.("UPLOADING");
    await assertNoWall("instagram", session, wall);

    // 5. Crop -> Edit (the cover) -> caption.
    await clickOn(session, IG.next, "the first Next button", 120_000);
    await session.clock.sleep(1_500);
    if (prepared.poster && (await waitShown(session, IG.coverSelect, 20_000))) {
      // Through the file chooser, the way the control is meant to be used.
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 15_000 }),
          page.locator(IG.coverSelect).first().click({ timeout: 15_000 }),
        ]);
        await chooser.setFiles(prepared.poster.path);
      } catch {
        // The cover is a nicety: Instagram takes a frame of the video without one.
      }
    }
    await clickOn(session, IG.next, "the second Next button", 60_000);
    await session.clock.sleep(1_500);

    await fillIn(session, IG.caption, "the caption box", caption, 60_000);
    if (squash(await readText(page, IG.caption)) !== squash(caption)) {
      throw new NeedsHuman("mismatch", "The caption on the page is not the one that was typed. Nothing was posted.");
    }
    await assertNoWall("instagram", session, wall);

    // 6. SHARE: public, at once, and not takeable back from here.
    if (!(await waitShown(session, IG.share, 30_000)) || !(await page.locator(IG.share).first().isEnabled())) {
      throw new NeedsHuman("ui", "Instagram's Share button was not available.");
    }
    await page.locator(IG.share).first().click({ timeout: 15_000 });
    committed = true;

    // 7a. Instagram's own sentence that it was shared. A stop is RECORDED here and
    //     thrown after the wait: `waitUntil` swallows what its reader throws.
    let last = "";
    const hold: { stop: NeedsHuman | null } = { stop: null };
    const shared = await waitUntil(
      session.clock,
      async () => {
        const reading = readShareState(await readText(page, IG.dialog));
        last = reading.text;
        if (reading.state === "shared") return reading;
        if (reading.state === "needs_human") {
          hold.stop = new NeedsHuman(
            "challenge",
            `Instagram wants something from you before it will share this Reel ("${reading.text.slice(0, 160)}"). This app does not answer it: do it in the open window.`,
          );
          return reading;
        }
        if (reading.state === "failed") {
          hold.stop = new NeedsHuman(
            "unconfirmed",
            `Instagram reported a problem sharing the Reel ("${reading.text.slice(0, 160)}"). It is not known whether it went out. Check your profile before trying again.`,
          );
          return reading;
        }
        return null;
      },
      { timeoutMs: 10 * 60_000, pollMs: 3_000 },
    );
    if (hold.stop) throw hold.stop;
    if (!shared) {
      throw new NeedsHuman(
        "unconfirmed",
        `Share was pressed, but Instagram never said the Reel was shared${last ? ` (the page says: "${last.slice(0, 120)}")` : ""}. ` +
          "It is not known whether it went out. Check your profile before trying again.",
      );
    }

    // 7b. The Reel's own link: new, and carrying this caption.
    const found = await findNewReel(session, handle, before, captionHead(caption));
    if (!found) {
      throw new NeedsHuman(
        "unconfirmed",
        "Instagram said the Reel was shared, but its link could not be found on the profile, so it is NOT recorded as posted by this app. " +
          "It is almost certainly up: check your profile, and do NOT try again.",
      );
    }

    return {
      status: "PUBLISHED",
      externalId: found.code,
      externalUrl: found.url,
      confirmedAt: new Date(),
      reviewUrl: found.url,
      visibility: "public",
      thumbnail: {
        applied: false,
        reason: "Instagram gives no read-back for the cover, so it is not counted as applied. Check it on the Reel.",
      },
    };
  } catch (err) {
    if (isNeedsHuman(err)) return finishStop("instagram", err, committed);
    const what = err instanceof Error ? err.message : String(err);
    return finishStop("instagram", new NeedsHuman("ui", `Instagram did something unexpected (${what}).`), committed);
  }
}
