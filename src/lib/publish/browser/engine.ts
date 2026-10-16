/**
 * SERVER-ONLY. The small harness both browser publishers stand on: where the
 * profile lives, how Chromium is launched, how "you are signed out" and "a
 * security check is on screen" are told apart from a working page, and how a
 * window is closed -- or deliberately left open for a person.
 *
 * THIS FILE IS DELIBERATELY BORING, and the boring is the point.
 *
 * WHAT IT IS: a Playwright persistent context launched with Playwright's own
 * defaults, headful unless `BOOKREEL_PUBLISH_HEADLESS` says otherwise, on a
 * profile directory this app creates EMPTY and a person signs in to by hand.
 * Every action the publishers take is an ordinary `goto`, `click`, `fill` or
 * `setInputFiles`.
 *
 * WHAT IT IS NOT, and will not become:
 *  - It does not hide that a browser is automated. The launch options are the
 *    three in `LaunchOptions` and nothing else -- no extra Chromium flags, no
 *    user-agent, no injected scripts. `tests/publish-browser.test.mts` asserts
 *    that, on the real launch options and on the source of this folder, so a
 *    future edit that adds one fails a test instead of passing review.
 *  - It does not imitate a person. No randomised delays, no cursor paths, no
 *    per-keystroke typing. A form field is `fill`ed.
 *  - It does not answer a sign-in, a CAPTCHA, a two-step prompt or any other
 *    security check. When `judgePage` sees one it returns `challenge` or
 *    `signed_out`, the publisher stops WITHOUT touching the page, and the job
 *    becomes AWAITING_HUMAN with the window left open. Whatever has to be
 *    typed, ticked or solved there is typed, ticked and solved by the person.
 *  - It does not carry a credential. The only thing that persists a sign-in is
 *    the Chromium profile directory, which holds what Chromium itself stores
 *    when a human signs in. This app never reads it, copies it or sends it.
 *
 * TESTABILITY. Everything the publishers touch goes through the small `PageLike`
 * / `ContextLike` shapes below, and the clock and the launcher are injectable, so
 * the confirmation gating can be driven against a scripted page with no browser
 * and no sleeping. The real objects are cast to these shapes at exactly one
 * place (`launchContext`).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { WORK_ROOT } from "@/lib/paths";
import { PLATFORM_LABELS, type PlatformId } from "../limits";
import type { PublishHooks, PublishOutcome, Publisher } from "../contract";
import type { EnvLike } from "../youtube/secrets";
import { acquirePlatformLock, closeLeftOpenWindow, forgetWindow, leaveWindowOpen } from "./live";

// ----------------------------------------------------------------- the page shapes

export interface LocatorLike {
  first(): LocatorLike;
  nth(index: number): LocatorLike;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  setInputFiles(files: string | string[], options?: { timeout?: number }): Promise<void>;
  innerText(options?: { timeout?: number }): Promise<string>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
}

export interface FileChooserLike {
  setFiles(files: string | string[]): Promise<void>;
}

export interface PageLike {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): LocatorLike;
  keyboard: { press(key: string): Promise<unknown> };
  waitForEvent(event: "filechooser", options?: { timeout?: number }): Promise<FileChooserLike>;
}

export interface ContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
}

// ----------------------------------------------------------------- launching

/**
 * The ONLY options the browser is launched with.
 *
 * `headless` is the operator's choice, `viewport` is a window size so Studio's
 * dialogs lay out normally, and `timeout` bounds the launch itself. Anything
 * else would be a decision about how the browser presents itself, and the answer
 * to that is always "as Playwright does by default".
 */
export interface LaunchOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  timeout: number;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** `BOOKREEL_PUBLISH_HEADLESS=1` hides the window. Unset (the default) shows it, which a sign-in needs. */
export function isHeadless(env: EnvLike = process.env): boolean {
  return TRUTHY.has((env.BOOKREEL_PUBLISH_HEADLESS ?? "").trim().toLowerCase());
}

export function launchOptionsFor(env: EnvLike = process.env): LaunchOptions {
  return { headless: isHeadless(env), viewport: { width: 1366, height: 900 }, timeout: 60_000 };
}

/**
 * One profile per platform, under the work root, created empty.
 *
 * Separate directories because the two platforms must never share a sign-in
 * store, and because two Chromium instances cannot share one directory (which is
 * what the per-platform lock in `live.ts` is for). Nothing here is ever copied
 * from anywhere: a profile starts empty and fills only when a person signs in.
 */
export function profileDirFor(platform: PlatformId, root: string = WORK_ROOT): string {
  return path.join(root, "browser-profiles", platform);
}

/** Where Playwright keeps the Chromium it would launch, or null when it is not installed. */
export function locateChromium(): string | null {
  try {
    const exe = chromium.executablePath();
    return exe && fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Everything a test needs to replace. Production passes nothing. */
export interface BrowserDeps {
  env?: EnvLike;
  clock?: Clock;
  /** Where Chromium is. Default: Playwright's own lookup. */
  locate?: () => string | null;
  /** Start a persistent context on `profileDir`. Default: Playwright's `launchPersistentContext`. */
  launch?: (profileDir: string, options: LaunchOptions) => Promise<ContextLike>;
  /** Root for the profile directories. Default: the work root. */
  profileRoot?: string;
}

async function launchContext(profileDir: string, options: LaunchOptions): Promise<ContextLike> {
  const context = await chromium.launchPersistentContext(profileDir, options);
  return context as unknown as ContextLike;
}

/** The sentence that explains a missing Chromium, or null when one is present. */
export function chromiumProblem(deps: BrowserDeps = {}): string | null {
  const located = (deps.locate ?? locateChromium)();
  return located
    ? null
    : "No Chromium was found on this server, so there is no browser to open. " +
        "Install one with `npx playwright-core install chromium`, then try again. Nothing was sent.";
}

// ----------------------------------------------------------------- the session

export interface BrowserSession {
  page: PageLike;
  headless: boolean;
  clock: Clock;
  /**
   * End the job. `leaveOpen` keeps the window up for a person -- only possible
   * when it is visible; a hidden window is closed, because nobody could use it.
   * Returns whether the window really was left open.
   */
  finish(options: { leaveOpen: boolean }): Promise<boolean>;
}

/**
 * Open the platform's window. Any window a previous job left open is closed first
 * (the profile can only be open once), which is also what a Retry is: the person
 * has done their part in that window, and the profile on disk carries it.
 */
export async function openSession(platform: PlatformId, deps: BrowserDeps = {}): Promise<BrowserSession> {
  const env = deps.env ?? process.env;
  const options = launchOptionsFor(env);
  const profileDir = profileDirFor(platform, deps.profileRoot);

  await closeLeftOpenWindow(platform);
  await fs.promises.mkdir(profileDir, { recursive: true });

  const context = await (deps.launch ?? launchContext)(profileDir, options);
  const handle = { close: () => context.close() };
  context.on("close", () => forgetWindow(platform, handle));
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    page,
    headless: options.headless,
    clock: deps.clock ?? realClock,
    finish: async ({ leaveOpen }) => {
      if (leaveOpen && !options.headless) {
        leaveWindowOpen(platform, handle);
        return true;
      }
      forgetWindow(platform, handle);
      await context.close().catch(() => {});
      return false;
    },
  };
}

/**
 * Run one browser job under the platform's lock, and close up afterwards.
 *
 * The outcome decides the window's fate: AWAITING_HUMAN leaves it open for the
 * person; everything else closes it. Anything unexpected that escapes `work`
 * becomes AWAITING_HUMAN too, never FAILED -- an exception somewhere in a flow
 * that may already have pressed the final button is exactly the case where the
 * real outcome is unknown, and "failed" invites a retry that could post twice.
 */
export async function runInSession(
  platform: PlatformId,
  deps: BrowserDeps,
  work: (session: BrowserSession) => Promise<PublishOutcome>,
): Promise<PublishOutcome> {
  const release = await acquirePlatformLock(platform);
  let session: BrowserSession | null = null;
  let leaveOpen = false;
  try {
    const problem = chromiumProblem(deps);
    if (problem) return { status: "REQUIRES_CONNECTION", error: problem };

    try {
      session = await openSession(platform, deps);
    } catch (err) {
      return {
        status: "FAILED",
        error:
          `Chromium would not start: ${err instanceof Error ? err.message : String(err)}. ` +
          "Nothing was opened and nothing was posted.",
      };
    }

    try {
      const outcome = await work(session);
      leaveOpen = outcome.status === "AWAITING_HUMAN";
      return outcome;
    } catch (err) {
      leaveOpen = true;
      return {
        status: "AWAITING_HUMAN",
        error:
          `Something unexpected stopped the ${PLATFORM_LABELS[platform]} browser job ` +
          `(${err instanceof Error ? err.message : String(err)}). It is not known how far it got, ` +
          `so check ${PLATFORM_LABELS[platform]} before trying again: it may or may not have been posted.`,
      };
    }
  } finally {
    if (session) await session.finish({ leaveOpen }).catch(() => {});
    release();
  }
}

// ----------------------------------------------------------------- waiting and reading

/** Poll `read` until it returns something truthy or the time is up. Never throws on a failed read. */
export async function waitUntil<T>(
  clock: Clock,
  read: () => Promise<T | null | false | undefined>,
  options: { timeoutMs: number; pollMs?: number },
): Promise<T | null> {
  const pollMs = options.pollMs ?? 1_000;
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (clock.now() >= deadline) return null;
    await clock.sleep(pollMs);
  }
}

export const squash = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

export async function isShown(page: PageLike, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false);
}

export async function readText(page: PageLike, selector: string, timeoutMs = 3_000): Promise<string> {
  return squash(await page.locator(selector).first().innerText({ timeout: timeoutMs }).catch(() => ""));
}

/** Text of the page, capped: enough to recognise a screen, never an unbounded dump into a log. */
export async function readBody(page: PageLike): Promise<string> {
  return (await readText(page, "body")).slice(0, 4_000);
}

/** Wait for an element to be on screen. */
export async function waitShown(session: BrowserSession, selector: string, timeoutMs: number): Promise<boolean> {
  return (await waitUntil(session.clock, () => isShown(session.page, selector), { timeoutMs, pollMs: 500 })) === true;
}

/** Wait for an element to exist, visible or not -- a file input is hidden by design. */
export async function waitPresent(session: BrowserSession, selector: string, timeoutMs: number): Promise<boolean> {
  const found = await waitUntil(
    session.clock,
    async () => (await session.page.locator(selector).first().count()) > 0,
    { timeoutMs, pollMs: 500 },
  );
  return found === true;
}

/** Click something that must be there. An ordinary click: no cursor path, no delay. */
export async function clickOn(session: BrowserSession, selector: string, what: string, timeoutMs = 20_000): Promise<void> {
  if (!(await waitShown(session, selector, timeoutMs))) {
    throw new NeedsHuman("ui", `Could not find ${what} on the page. The site's layout may have changed.`);
  }
  await session.page.locator(selector).first().click({ timeout: timeoutMs });
}

/** Fill a field that must be there. An ordinary `fill`: the whole value at once. */
export async function fillIn(
  session: BrowserSession,
  selector: string,
  what: string,
  value: string,
  timeoutMs = 20_000,
): Promise<void> {
  if (!(await waitShown(session, selector, timeoutMs))) {
    throw new NeedsHuman("ui", `Could not find ${what} on the page. The site's layout may have changed.`);
  }
  await session.page.locator(selector).first().fill(value, { timeout: timeoutMs });
}

// ----------------------------------------------------------------- a person is needed

/**
 * Why a job stopped for a person.
 *
 *  - `sign_in`      the platform is asking for a login. Nothing was done.
 *  - `challenge`    a CAPTCHA, verification, two-step or "confirm it is you" is on
 *                   screen. Nothing was done, and nothing will be attempted.
 *  - `unconfirmed`  the final button was pressed and the platform never said what
 *                   happened. The post may exist.
 *  - `mismatch`     something read back differently from what was sent.
 *  - `blocked`      the platform refused to go on (a limit, a required declaration).
 *  - `ui`           the page did not look as expected before anything was posted.
 */
export type HumanReason = "sign_in" | "challenge" | "unconfirmed" | "mismatch" | "blocked" | "ui";

export class NeedsHuman extends Error {
  readonly reason: HumanReason;
  /** A video id the platform itself showed, when one was seen before the stop. */
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  constructor(reason: HumanReason, message: string, seen: { externalId?: string | null; externalUrl?: string | null } = {}) {
    super(message);
    this.name = "NeedsHuman";
    this.reason = reason;
    this.externalId = seen.externalId ?? null;
    this.externalUrl = seen.externalUrl ?? null;
  }
}

/** By name, not `instanceof`: see `isAppError` in lib/errors.ts for why. */
export function isNeedsHuman(err: unknown): err is NeedsHuman {
  return err instanceof Error && err.name === "NeedsHuman";
}

/** The AWAITING_HUMAN outcome for a stop, carrying any id the platform showed. */
export function awaiting(err: NeedsHuman): PublishOutcome {
  return {
    status: "AWAITING_HUMAN",
    error: err.message,
    ...(err.externalId ? { externalId: err.externalId } : {}),
    ...(err.externalUrl ? { externalUrl: err.externalUrl } : {}),
  };
}

// ----------------------------------------------------------------- recognising a screen

/**
 * What a page looks like, reduced to the facts `judgePage` decides on.
 * `dialogText` is the first open dialog's words: a security prompt on Instagram
 * arrives as a dialog over an otherwise normal page.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  bodyText: string;
  dialogText: string;
  /** The signed-in application shell is on screen (the Create button, the nav). */
  hasAppShell: boolean;
}

export type PageVerdict =
  | { kind: "ok" }
  | { kind: "signed_out"; why: string }
  | { kind: "challenge"; why: string }
  /** Neither a working app nor a recognised wall -- still loading, or not understood. */
  | { kind: "unknown" };

/**
 * Words a security check uses. Matching one is ENOUGH to stop: a false positive
 * costs a person one look at a window, a false negative would mean the harness
 * carried on typing into a screen asking whether it is a robot.
 */
const CHALLENGE_TEXT =
  /(captcha|i['’]?m not a robot|not a robot|verify (that )?it['’]?s you|confirm (that )?(it['’]?s|this is) you|confirm you['’]?re (a )?human|prove you['’]?re (human|not a robot)|2-?step verification|two-?factor|two-?step|security (check|code|key)|enter (the |your )?(security |confirmation |login |6-digit )?code|unusual (activity|traffic|login)|suspicious (activity|login)|account (has been )?(locked|suspended|disabled|restricted|temporarily)|checkpoint|we (detected|noticed) (an )?(unusual|suspicious)|help us confirm|verify your (identity|phone|account))/i;

const CHALLENGE_URL: Record<PlatformId, RegExp> = {
  youtube: /(\/signin\/(v2\/)?challenge|\/signin\/rejected|\/speedbump|\/interstitial|\/sorry\/|recaptcha|captcha|\/deniedsignin)/i,
  instagram: /(\/challenge\/|\/accounts\/suspended|\/accounts\/disabled|\/auth_platform\/|\/accounts\/login\/two_factor|\/accounts\/onetap\/?\?.*challenge)/i,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Decide what a screen is. Order matters and is the safe order: a security check
 * outranks a sign-in prompt (it says more about what the person has to do), and
 * both outrank "looks fine".
 *
 * Pure, so every branch can be tested without a browser.
 */
export function judgePage(platform: PlatformId, snap: PageSnapshot): PageVerdict {
  const host = hostOf(snap.url);
  const route = pathOf(snap.url);

  if (CHALLENGE_URL[platform].test(snap.url)) {
    return { kind: "challenge", why: "the page address is a verification step" };
  }
  if (snap.dialogText && CHALLENGE_TEXT.test(snap.dialogText)) {
    return { kind: "challenge", why: squashWhy(snap.dialogText) };
  }
  // On a page that is NOT the working app, the body is the prompt itself.
  if (!snap.hasAppShell && CHALLENGE_TEXT.test(`${snap.title} ${snap.bodyText}`)) {
    return { kind: "challenge", why: squashWhy(snap.bodyText || snap.title) };
  }

  if (platform === "youtube") {
    if (host === "accounts.google.com" || host.endsWith(".accounts.google.com")) {
      return { kind: "signed_out", why: "Google's sign-in page is showing" };
    }
    if (!snap.hasAppShell && /^sign in\b/i.test(snap.title)) return { kind: "signed_out", why: "the page is a sign-in page" };
  } else {
    if (route.startsWith("/accounts/login") || route.startsWith("/accounts/emailsignup")) {
      return { kind: "signed_out", why: "Instagram's log-in page is showing" };
    }
    if (!snap.hasAppShell && /\blog in\b/i.test(snap.title) && /\b(log in|sign up)\b/i.test(snap.bodyText)) {
      return { kind: "signed_out", why: "Instagram is asking for a log-in" };
    }
  }

  return snap.hasAppShell ? { kind: "ok" } : { kind: "unknown" };
}

function squashWhy(text: string): string {
  return squash(text).slice(0, 160);
}

/** Read what `judgePage` needs from a live page. */
export async function snapshotOf(
  page: PageLike,
  selectors: { appShell: string; dialog: string },
): Promise<PageSnapshot> {
  const [title, bodyText, dialogText, hasAppShell] = await Promise.all([
    page.title().catch(() => ""),
    readBody(page),
    readText(page, selectors.dialog),
    isShown(page, selectors.appShell),
  ]);
  return { url: page.url(), title, bodyText, dialogText: dialogText.slice(0, 1_000), hasAppShell };
}

/**
 * The sentences a stop for a person uses, so the server and the card agree.
 *
 * They say what the PERSON does and what this app will not. What was or was not
 * posted is added by `finishStop`, because only the flow knows whether the final
 * button had been pressed.
 */
export function humanSentence(
  platform: PlatformId,
  reason: "sign_in" | "challenge",
  options: { headless: boolean; detail?: string },
): string {
  const label = PLATFORM_LABELS[platform];
  const where = options.headless
    ? "The browser is running hidden (BOOKREEL_PUBLISH_HEADLESS), so there is no window to do it in: unset that setting, restart, and try again."
    : "Do that in the open browser window, then press Retry.";
  if (reason === "sign_in") {
    return `${label} wants you to sign in. This app never types or stores your password: sign in yourself. ${where}`;
  }
  const detail = options.detail ? ` (${options.detail})` : "";
  return (
    `${label} is showing a security check or verification${detail}. This app does not try to solve or get past it: ` +
    `complete it yourself. ${where}`
  );
}

/**
 * Turn a stop into the AWAITING_HUMAN outcome, saying truthfully what is known.
 *
 * `committed` is whether the final Publish/Share/Save button had been pressed. If
 * not, nothing is on the platform and a retry is safe (a half-filled draft may
 * remain). If so, it MAY be on the platform, and the sentence says to look before
 * doing anything again. Reasons whose message already says this (`unconfirmed`,
 * `mismatch`) are left alone.
 */
export function finishStop(platform: PlatformId, err: NeedsHuman, committed: boolean): PublishOutcome {
  if (err.reason === "unconfirmed" || err.reason === "mismatch") return awaiting(err);
  const label = PLATFORM_LABELS[platform];
  const tail = committed
    ? ` The final button had already been pressed, so ${label} may already have it: check ${label} before trying again.`
    : platform === "youtube"
      ? " Nothing was published (an unfinished draft may be left in Studio)."
      : " Nothing was posted.";
  return awaiting(new NeedsHuman(err.reason, `${err.message}${tail}`, { externalId: err.externalId, externalUrl: err.externalUrl }));
}

/**
 * Look at the current page and stop for a person if it is a sign-in or a
 * security check. Called at every point a wall could appear: after the first
 * load, after the file is attached, and right before the final button.
 *
 * It only READS. It clicks nothing and fills nothing, so there is no code path
 * from "a challenge is on screen" to "something was done about it".
 */
export async function assertNoWall(
  platform: PlatformId,
  session: BrowserSession,
  selectors: { appShell: string; dialog: string },
): Promise<void> {
  const verdict = judgePage(platform, await snapshotOf(session.page, selectors));
  if (verdict.kind === "signed_out") {
    throw new NeedsHuman("sign_in", humanSentence(platform, "sign_in", { headless: session.headless }));
  }
  if (verdict.kind === "challenge") {
    throw new NeedsHuman("challenge", humanSentence(platform, "challenge", { headless: session.headless, detail: verdict.why }));
  }
}

// ----------------------------------------------------------------- the publisher shape

/**
 * What a browser publish is told beyond the request. Every field is the
 * operator's explicit choice for THIS publish; none has a silent default that
 * posts publicly or declares anything on their behalf.
 */
export interface BrowserPublishOptions {
  /** YouTube: `private` unless asked otherwise. Instagram has no private post. */
  visibility?: "private" | "unlisted" | "public";
  /** YouTube only: schedule through Studio. Instagram's web uploader cannot. */
  scheduledAt?: Date | null;
  /**
   * YouTube only: the operator's answer to "is this made for kids". Required, and
   * never defaulted -- it is a legal declaration (the API path leaves it unset for
   * the same reason), so it is asked, not assumed.
   */
  madeForKids?: boolean;
  /** The caller's explicit acknowledgement that this goes out publicly. */
  confirmPublic?: boolean;
}

export interface BrowserHooks extends PublishHooks {
  /** Which stage the job is in, for the row. Real stages only, never a percentage. */
  onStage?: (stage: "PREPARING" | "UPLOADING") => void | Promise<void>;
}

export interface BrowserPublisher extends Omit<Publisher, "publish"> {
  publish(prepared: Parameters<Publisher["publish"]>[0], hooks?: BrowserHooks): Promise<PublishOutcome>;
}

// ----------------------------------------------------------------- what may be asked for

export interface OptionProblem {
  /** `needs_confirmation` is a 409 ("say so in as many words"); `bad_options` is a 400. */
  code: "needs_confirmation" | "bad_options";
  message: string;
}

/** Studio will not take a time closer than this, and a post "scheduled" for the next minute is a post. */
export const MIN_SCHEDULE_LEAD_MS = 15 * 60_000;

/** The YouTube visibility these options ask for. A schedule is public-at-a-time, whatever else was said. */
export function desiredVisibility(options: BrowserPublishOptions): "scheduled" | "private" | "unlisted" | "public" {
  if (options.scheduledAt) return "scheduled";
  return options.visibility ?? "private";
}

/**
 * Is this publish asking for something it may not, or leaving out something it
 * must say?
 *
 * Checked in `run.ts` BEFORE any row is written, and again inside each browser
 * publisher, so a second caller cannot skip it by going around the route.
 *
 *  - A public or scheduled YouTube post, and ANY Instagram post, must carry
 *    `confirmPublic: true`: they cannot be taken back from here.
 *  - YouTube's "made for kids" is the operator's own declaration and must be
 *    supplied, never defaulted.
 *  - Instagram's web uploader has no schedule and no private post, so asking for
 *    one is refused rather than quietly turned into an immediate public one.
 */
export function browserOptionProblems(
  platform: PlatformId,
  options: BrowserPublishOptions,
  now: number = Date.now(),
): OptionProblem[] {
  const problems: OptionProblem[] = [];
  const scheduleAsked = options.scheduledAt !== undefined && options.scheduledAt !== null;
  const validDate = options.scheduledAt instanceof Date && !Number.isNaN(options.scheduledAt.getTime());

  if (platform === "instagram") {
    if (scheduleAsked) {
      problems.push({
        code: "bad_options",
        message:
          "Instagram's web uploader cannot schedule a post for most accounts, so there is no schedule option here. " +
          "Nothing was sent.",
      });
    }
    if (options.visibility !== undefined && options.visibility !== "public") {
      problems.push({
        code: "bad_options",
        message: "Instagram has no private or unlisted post: a share is public, at once. Nothing was sent.",
      });
    }
    if (options.confirmPublic !== true) {
      problems.push({
        code: "needs_confirmation",
        message:
          "Sharing from the browser window puts the Reel on the account publicly, at once, and it cannot be taken back from here. " +
          "Confirm that is what you want. Nothing was sent.",
      });
    }
    return problems;
  }

  if (typeof options.madeForKids !== "boolean") {
    problems.push({
      code: "bad_options",
      message:
        "Say whether this video is made for kids. YouTube requires an answer and it is a declaration only you can make, " +
        "so this app never assumes one. Nothing was sent.",
    });
  }
  if (options.visibility !== undefined && !["private", "unlisted", "public"].includes(options.visibility)) {
    problems.push({ code: "bad_options", message: "Visibility must be private, unlisted or public. Nothing was sent." });
  }
  if (scheduleAsked) {
    if (!validDate) {
      problems.push({ code: "bad_options", message: "The scheduled time is not a valid date. Nothing was sent." });
    } else if ((options.scheduledAt as Date).getTime() < now + MIN_SCHEDULE_LEAD_MS) {
      problems.push({
        code: "bad_options",
        message: "Pick a time at least 15 minutes from now to schedule a YouTube post. Nothing was sent.",
      });
    }
  }
  const goesPublic = desiredVisibility(options) === "public" || desiredVisibility(options) === "scheduled";
  if (goesPublic && options.confirmPublic !== true) {
    problems.push({
      code: "needs_confirmation",
      message:
        "A public or scheduled post goes live on the channel without a review step, and it cannot be taken back from here. " +
        "Confirm that is what you want, or publish it as private and finish in Studio. Nothing was sent.",
    });
  }
  return problems;
}
