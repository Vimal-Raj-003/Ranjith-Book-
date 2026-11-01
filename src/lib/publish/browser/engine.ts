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
 *    three in `LaunchOptions` -- plus, only when the operator asks for it, WHICH
 *    installed browser to open (`channel`: "chrome" or "msedge", see below) -- and
 *    nothing else: no extra Chromium flags, no user-agent, no injected scripts.
 *    `tests/publish-browser.test.mts` asserts that, on the real launch options and
 *    on the source of this folder, so a future edit that adds one fails a test
 *    instead of passing review.
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
 * THE OTHER WAY IN: ATTACHING TO THE OPERATOR'S OWN CHROME. When
 * `BOOKREEL_PUBLISH_CHROME_CDP` names a loopback address, nothing is launched at
 * all: the operator starts their own Chrome with remote debugging on, signs in to
 * it themselves, and this file `connectOverCDP`s to it and opens one new tab. Same
 * rules, plus the ones that matter for a browser that is not ours:
 *  - It takes NO launch options -- there is no launch. It does not read, copy or
 *    even locate the Chrome profile; it only talks to the port the operator opened.
 *  - It NEVER closes the operator's browser, context or tabs. `finish` drops the
 *    connection and nothing else (see `connectChrome` for what that is, exactly),
 *    and the attached context is typed so that it has no `close` to call.
 *  - It never falls back to a bundled Chromium. If the port cannot be reached the
 *    job is REQUIRES_CONNECTION, with the steps to start Chrome that way.
 * Unset (the default), none of this code runs and the launch path above is used.
 *
 * THE THIRD WAY: THE REAL INSTALLED CHROME, ON A PROFILE OF OUR OWN. When
 * `BOOKREEL_PUBLISH_BROWSER_CHANNEL` is `chrome` (or `msedge`) the LAUNCH path is
 * unchanged except for one option: `channel`, which makes Playwright open the
 * browser installed on this computer instead of its bundled Chromium build. That
 * is a choice of WHICH real browser, not a disguise -- Playwright still starts it
 * as an automated browser, with its own flags, and this file does nothing to
 * change that. The profile is still the empty, BookReel-created directory under
 * the work root: never the operator's personal Chrome profile, never copied from
 * it. If that browser is not installed the job is REQUIRES_CONNECTION, never a
 * quiet fall back to the bundled Chromium (or to attaching).
 *
 * SIGN IN ONCE, THEN REUSE. Google refuses a sign-in typed into a browser an
 * automation tool started, and this app does not hide that it is one. So the
 * sign-in is never done in the automated window: `signin.ts` opens a PLAIN Chrome
 * (an ordinary operating-system process, not Playwright, with nothing but the
 * profile directory on its command line) on the very same dedicated profile; the
 * operator signs in there by hand and closes it; and this file's launch then opens
 * Chrome on that profile ALREADY SIGNED IN, lands on Studio, and never visits
 * Google's sign-in page. One profile, one sign-in -- nothing is typed, copied or
 * read. The cost is that a profile can be open in only one Chrome at a time, so a
 * launch while the sign-in window is still open is REQUIRES_CONNECTION saying to
 * close it (`profileBusyMessage`); no lock file is touched.
 *
 * PRECEDENCE: if BOTH `BOOKREEL_PUBLISH_CHROME_CDP` and
 * `BOOKREEL_PUBLISH_BROWSER_CHANNEL` are set, ATTACHING WINS. It is the more
 * operator-controlled route (the operator launched, and owns, that browser), and
 * every check for "which mode am I in" asks `cdpEndpoint` first. Neither set (the
 * default) is the bundled Chromium, exactly as before.
 *
 * TESTABILITY. Everything the publishers touch goes through the small `PageLike`
 * / `ContextLike` shapes below, and the clock, the launcher and the attacher are
 * injectable, so the confirmation gating can be driven against a scripted page
 * with no browser and no sleeping. The real objects are cast to these shapes at
 * exactly two places (`launchContext`, `connectChrome`).
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
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
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
 * The installed browsers that may be opened instead of Playwright's bundled
 * Chromium. A closed list on purpose: the value goes to Playwright as `channel`,
 * so it is only ever one of these two names -- never a path, never a free string.
 */
export type BrowserChannel = "chrome" | "msedge";

/**
 * The ONLY options the browser is launched with.
 *
 * `headless` is the operator's choice, `viewport` is a window size so Studio's
 * dialogs lay out normally, and `timeout` bounds the launch itself. `channel` is
 * present ONLY when the operator set `BOOKREEL_PUBLISH_BROWSER_CHANNEL`: it picks
 * WHICH real browser opens (the installed Chrome or Edge rather than the bundled
 * Chromium build), and says nothing about how that browser presents itself.
 * Anything else would be a decision about how the browser presents itself, and
 * the answer to that is always "as Playwright does by default".
 */
export interface LaunchOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  timeout: number;
  /**
   * TRUE: run Chrome WITH its own security sandbox. Playwright's default is to
   * DISABLE it (it passes `--no-sandbox`), which weakens the browser and shows a
   * yellow "unsupported command-line flag: --no-sandbox" banner. Turning the
   * sandbox ON is a SECURITY setting, not a disguise -- it makes the window a
   * normal, sandboxed browser and removes that flag. Always true here.
   */
  chromiumSandbox: boolean;
  channel?: BrowserChannel;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** `BOOKREEL_PUBLISH_HEADLESS=1` hides the window. Unset (the default) shows it, which a sign-in needs. */
export function isHeadless(env: EnvLike = process.env): boolean {
  return TRUTHY.has((env.BOOKREEL_PUBLISH_HEADLESS ?? "").trim().toLowerCase());
}

/** The kill-switch for scheduling an Instagram post from the browser window. Off unless it is set. */
export const IG_NATIVE_SCHEDULE_ENV = "BOOKREEL_IG_NATIVE_SCHEDULE";

/**
 * Is Instagram's own scheduler allowed to be driven? `BOOKREEL_IG_NATIVE_SCHEDULE`
 * set to anything other than empty, `0` or `false` (any case) turns it on. Unset is
 * off, so merging this cannot cause a real schedule until the operator opts in.
 */
export function igNativeScheduleEnabled(env: EnvLike = process.env): boolean {
  const raw = (env[IG_NATIVE_SCHEDULE_ENV] ?? "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false";
}

/** Setting this to `chrome` (or `msedge`) launches that installed browser instead of the bundled Chromium. */
export const CHANNEL_ENV = "BOOKREEL_PUBLISH_BROWSER_CHANNEL";

/**
 * The installed browser asked for, or null (the default: the bundled Chromium).
 * Anything that is not exactly `chrome` or `msedge` -- a path, `chrome-beta`,
 * `firefox`, a typo -- is null: it is ignored, never passed on.
 *
 * This only reads the setting. Which MODE is in force is decided by the callers,
 * who ask `cdpEndpoint` first: attaching wins over a channel.
 */
export function browserChannel(env: EnvLike = process.env): BrowserChannel | null {
  const raw = (env[CHANNEL_ENV] ?? "").trim().toLowerCase();
  return raw === "chrome" || raw === "msedge" ? raw : null;
}

/** How a person would name it, in messages. */
export function channelName(channel: BrowserChannel): string {
  return channel === "chrome" ? "Google Chrome" : "Microsoft Edge";
}

export function launchOptionsFor(env: EnvLike = process.env): LaunchOptions {
  const channel = browserChannel(env);
  return {
    headless: isHeadless(env),
    viewport: { width: 1366, height: 900 },
    timeout: 60_000,
    // Run WITH the sandbox. Playwright would otherwise pass `--no-sandbox` (its
    // default), which degrades security and shows a warning banner in the window.
    // See the LaunchOptions doc above: this is a security setting, never a disguise.
    chromiumSandbox: true,
    // Absent, not undefined, when unset: the default options are byte-for-byte what they always were.
    ...(channel ? { channel } : {}),
  };
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

/** Where each installed browser lives, relative to a Program Files-style prefix on Windows and absolute elsewhere. */
const CHANNEL_EXECUTABLE: Record<BrowserChannel, Partial<Record<NodeJS.Platform, string>>> = {
  chrome: {
    linux: "/opt/google/chrome/chrome",
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    win32: "\\Google\\Chrome\\Application\\chrome.exe",
  },
  msedge: {
    linux: "/opt/microsoft/msedge/msedge",
    darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    win32: "\\Microsoft\\Edge\\Application\\msedge.exe",
  },
};

/**
 * Where the installed browser for a channel is, or null when it is not there.
 *
 * Looks in the same places Playwright looks for `channel: "chrome"` / `"msedge"`,
 * so "found" here and "launchable" there agree. It only asks whether the browser's
 * program file exists; it opens nothing and reads nothing from the browser's
 * profile (it does not even know where that is).
 */
export function locateBrowserChannel(channel: BrowserChannel, env: EnvLike = process.env): string | null {
  const suffix = CHANNEL_EXECUTABLE[channel][process.platform];
  if (!suffix) return null;
  const prefixes =
    process.platform === "win32"
      ? [
          env.LOCALAPPDATA,
          env.PROGRAMFILES,
          env["PROGRAMFILES(X86)"],
          env.HOMEDRIVE ? `${env.HOMEDRIVE}\\Program Files` : undefined,
          env.HOMEDRIVE ? `${env.HOMEDRIVE}\\Program Files (x86)` : undefined,
        ].filter((p): p is string => Boolean(p))
      : [""];
  for (const prefix of prefixes) {
    const candidate = path.join(prefix, suffix);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable is as good as absent.
    }
  }
  return null;
}

/** The one sentence for "the chosen browser cannot be opened", used before a launch and after a failed one. */
function channelMissing(channel: BrowserChannel): string {
  const short = channel === "chrome" ? "Chrome" : "Edge";
  return (
    `${channelName(channel)} is not installed, or Playwright could not find it; install ${short} or unset ${CHANNEL_ENV}. ` +
    "Nothing was opened."
  );
}

/**
 * Does a failed launch look like "the profile is already open in another Chrome"?
 *
 * A Chrome started on a profile another Chrome process holds does not fail loudly:
 * it hands its command line to that process and exits at once, which Playwright
 * reports as "Opening in existing browser session" or as the browser having been
 * closed straight away (the wording differs by platform and version, so both are
 * recognised). It is only asked in channel mode, after the installed Chrome was
 * found to exist, which is what makes "closed straight away" a reliable hint: the
 * usual cause is the sign-in window (`signin.ts`) still being open on the profile.
 */
const PROFILE_IN_USE =
  /opening in existing browser session|singletonlock|process_?singleton|profile.{0,40}(in use|locked)|(in use|locked).{0,40}profile|user data dir.{0,40}in use|target page, context or browser has been closed|browser has been closed/i;

export function isProfileInUse(err: unknown): boolean {
  return PROFILE_IN_USE.test(err instanceof Error ? err.message : String(err));
}

/** The sentence for "the dedicated profile is open elsewhere": what to close, and that nothing happened. */
export function profileBusyMessage(platform: PlatformId, channel: BrowserChannel): string {
  return (
    `Close the ${PLATFORM_LABELS[platform]} sign-in window, then publish. ` +
    `${channelName(channel)} could not open the BookReel profile, most likely because another ${channelName(channel)} window ` +
    "is still using it (the sign-in window, or one an earlier publish left open). Nothing was opened and nothing was posted."
  );
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
  youtubeReview?: typeof import("./youtube-review").reviewStudioVideo;
  /** Test seam; production watchdog is 45 minutes, including platform processing. */
  jobTimeoutMs?: number;
  youtubeSchedule?: import("./native-controls").YouTubeScheduleControls;
  env?: EnvLike;
  clock?: Clock;
  /** Where Chromium is. Default: Playwright's own lookup. */
  locate?: () => string | null;
  /** Where the installed Chrome/Edge is, in channel mode. Default: the standard install locations. */
  locateChannel?: (channel: BrowserChannel) => string | null;
  /** Start a persistent context on `profileDir`. Default: Playwright's `launchPersistentContext`. */
  launch?: (profileDir: string, options: LaunchOptions) => Promise<ContextLike>;
  /** Attach to the operator's running Chrome at `endpoint`. Default: Playwright's `connectOverCDP`. */
  connect?: (endpoint: string) => Promise<AttachedBrowser>;
  /** Asks the endpoint whether Chrome is there (`/json/version`). Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Root for the profile directories. Default: the work root. */
  profileRoot?: string;
}

async function launchContext(profileDir: string, options: LaunchOptions): Promise<ContextLike> {
  const context = await chromium.launchPersistentContext(profileDir, options);
  return context as unknown as ContextLike;
}

/**
 * The sentence that explains a missing browser, or null when one is present --
 * or when none is needed because the operator's own Chrome is attached to instead
 * (`browserProblem` is the question to ask in that case).
 *
 * "A browser" is the bundled Chromium by default; with
 * `BOOKREEL_PUBLISH_BROWSER_CHANNEL` set it is the installed Chrome/Edge instead,
 * and the bundled one is irrelevant. Attaching outranks a channel.
 */
export function chromiumProblem(deps: BrowserDeps = {}): string | null {
  const env = deps.env ?? process.env;
  if (cdpEndpoint(env)) return null;
  const channel = browserChannel(env);
  if (channel) return (deps.locateChannel ?? locateBrowserChannel)(channel) ? null : channelMissing(channel);
  const located = (deps.locate ?? locateChromium)();
  return located
    ? null
    : "No Chromium was found on this server, so there is no browser to open. " +
        "Install one with `npx playwright-core install chromium`, then try again. Nothing was sent.";
}

// ----------------------------------------------------------------- attaching to the operator's Chrome

/** Setting this to the address of a Chrome the operator started themselves switches the engine from launching to attaching. */
export const CDP_ENV = "BOOKREEL_PUBLISH_CHROME_CDP";

/** The configured endpoint, or null when attaching is not configured (the default: launch Chromium). */
export function cdpEndpoint(env: EnvLike = process.env): string | null {
  const raw = (env[CDP_ENV] ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * Is this an address this app may attach to? A plain `http://` loopback address,
 * and nothing else.
 *
 * Loopback only because the debugging port hands over the WHOLE browser (every
 * tab, every signed-in session): it is meant to be reached from the same machine
 * and from nowhere else. And an `http://` address only, so a bare name such as
 * `chrome` (which Playwright would resolve by reading Chrome's profile directory)
 * can never be what is attached to -- this app does not look inside the profile.
 */
export function cdpEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `${CDP_ENV} is set to "${endpoint}", which is not an address. Use something like http://127.0.0.1:9222.`;
  }
  if (url.protocol !== "http:") {
    return `${CDP_ENV} must be an http:// address on this computer, such as http://127.0.0.1:9222 (it is "${endpoint}").`;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return `${CDP_ENV} points at ${url.hostname}, but Chrome's debugging port gives full control of the browser, so only this computer is allowed (127.0.0.1).`;
  }
  return null;
}

/** The steps that make Chrome attachable, as one sentence (the card lists the same steps). */
export function chromeAttachHelp(platform: PlatformId, endpoint: string): string {
  let port = "9222";
  try {
    port = new URL(endpoint).port || port;
  } catch {
    // The default port in the example is as good as any when the address itself is wrong.
  }
  return (
    "To use your own Chrome: (1) quit Chrome completely; (2) start it again with remote debugging on its own profile folder, " +
    `for example chrome.exe --remote-debugging-port=${port} --user-data-dir="%LOCALAPPDATA%\\bookreel-chrome" ` +
    "(Chrome 136 and later ignore remote debugging on its default profile, so the --user-data-dir is required); " +
    `(3) sign in to ${PLATFORM_LABELS[platform]} yourself in that Chrome, on the account this install publishes to; ` +
    `(4) keep it open and try again. Nothing was sent.`
  );
}

/**
 * Why the operator's Chrome cannot be used right now, or null when it answers.
 *
 * A short sentence, with no steps in it (`browserProblem` adds those): the card
 * shows this beside its own list of steps.
 */
export async function cdpProblem(endpoint: string, deps: BrowserDeps = {}): Promise<string | null> {
  const bad = cdpEndpointProblem(endpoint);
  if (bad) return bad;
  const unreachable = `Could not reach a Chrome with remote debugging at ${endpoint}.`;
  try {
    const url = new URL("json/version", endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return unreachable;
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown } | null;
    return typeof body?.webSocketDebuggerUrl === "string" ? null : unreachable;
  } catch {
    return unreachable;
  }
}

/**
 * Can a browser be had for this platform right now? The one question every
 * caller asks before offering or starting a browser job.
 *
 * Launch mode (the default): is a Chromium installed. Attach mode: does the
 * operator's own Chrome answer on its debugging port -- whether a bundled
 * Chromium is installed is irrelevant there, and never consulted.
 */
export async function browserProblem(platform: PlatformId, deps: BrowserDeps = {}): Promise<string | null> {
  const endpoint = cdpEndpoint(deps.env ?? process.env);
  if (!endpoint) return chromiumProblem(deps);
  const problem = await cdpProblem(endpoint, deps);
  return problem ? `${problem} ${chromeAttachHelp(platform, endpoint)}` : null;
}

/**
 * The operator's Chrome, attached to.
 *
 * `context` is deliberately only what a job needs -- it has no `close`, so no
 * code written against it can close the operator's browser by accident.
 * `disconnect` drops the connection and leaves Chrome and every tab as they are.
 */
export interface AttachedBrowser {
  context: Pick<ContextLike, "pages" | "newPage">;
  disconnect(): Promise<void>;
}

/** The attach attempt failed or was refused: the job is REQUIRES_CONNECTION, with the steps. */
class CdpUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpUnavailable";
  }
}

/** By name, not `instanceof`, like `isNeedsHuman`. */
function isCdpUnavailable(err: unknown): err is CdpUnavailable {
  return err instanceof Error && err.name === "CdpUnavailable";
}

/**
 * The ONE place a running Chrome is attached to. No launch options exist here: the
 * only things passed are that Chrome is on this computer (so a local video file can
 * be handed over by path, not copied through the socket), that Playwright should
 * not change the operator's browser-wide settings, and how long to wait.
 *
 * DISCONNECTING. Playwright has no separate `disconnect()`; for a browser obtained
 * from `connectOverCDP`, `browser.close()` IS the disconnect -- in the installed
 * playwright-core it ends the DevTools socket and nothing more (it does not send
 * Chrome `Browser.close`, and no tab or window is closed). It is called here, in
 * this closure, and nowhere else; the session never calls `close` on a context.
 */
async function connectChrome(endpoint: string): Promise<AttachedBrowser> {
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true, noDefaults: true, timeout: 15_000 });
  const disconnect = () => browser.close();
  const context = browser.contexts()[0];
  if (!context) {
    await disconnect().catch(() => {});
    throw new Error("Chrome answered, but exposed no browser to attach to");
  }
  return { context: context as unknown as AttachedBrowser["context"], disconnect };
}

// ----------------------------------------------------------------- the session

export interface BrowserSession {
  page: PageLike;
  headless: boolean;
  /**
   * The installed browser this session was launched as (`BOOKREEL_PUBLISH_BROWSER_CHANNEL`), or
   * null/absent for the bundled Chromium and for an attached Chrome. It only changes what a
   * "you are signed out" stop tells the person to do (see `humanSentence`).
   */
  channel?: BrowserChannel | null;
  clock: Clock;
  /**
   * End the job. `leaveOpen` keeps the window up for a person -- only possible
   * when it is visible; a hidden window is closed, because nobody could use it.
   * Returns whether the window really was left open.
   *
   * When the operator's own Chrome is attached to, this only disconnects: the
   * tab this job opened stays in their Chrome (so a sign-in can be finished in
   * it, and a result can be looked at), and nothing of theirs is ever closed.
   */
  finish(options: { leaveOpen: boolean }): Promise<boolean>;
}

/**
 * Attach to the operator's running Chrome and open one new tab for this job.
 *
 * A NEW tab, never one of theirs: navigating a tab they are using away to Studio
 * would be taking something that is not ours. No window is registered with
 * `live.ts` either -- there is no profile to free for a next job, and nothing here
 * may be closed by `closeLeftOpenWindow`.
 */
async function attachSession(platform: PlatformId, endpoint: string, deps: BrowserDeps): Promise<BrowserSession> {
  const refused = cdpEndpointProblem(endpoint);
  if (refused) throw new CdpUnavailable(`${refused} ${chromeAttachHelp(platform, endpoint)}`);

  let attached: AttachedBrowser;
  try {
    attached = await (deps.connect ?? connectChrome)(endpoint);
  } catch (err) {
    throw new CdpUnavailable(
      `Could not attach to Chrome at ${endpoint} (${err instanceof Error ? err.message : String(err)}). ` +
        chromeAttachHelp(platform, endpoint),
    );
  }

  let page: PageLike;
  try {
    page = await attached.context.newPage();
  } catch (err) {
    await attached.disconnect().catch(() => {});
    throw new CdpUnavailable(
      `Attached to Chrome at ${endpoint} but could not open a tab in it (${err instanceof Error ? err.message : String(err)}). ` +
        chromeAttachHelp(platform, endpoint),
    );
  }

  return {
    page,
    // The operator's Chrome is whatever it is, and a person is looking at it: the headless setting is not theirs to hide.
    headless: false,
    channel: null,
    clock: deps.clock ?? realClock,
    finish: async () => {
      await attached.disconnect().catch(() => {});
      return true;
    },
  };
}

/**
 * Open the platform's window. Any window a previous job left open is closed first
 * (the profile can only be open once), which is also what a Retry is: the person
 * has done their part in that window, and the profile on disk carries it.
 *
 * With `BOOKREEL_PUBLISH_CHROME_CDP` set this is not a launch at all: see
 * `attachSession` (and it outranks `BOOKREEL_PUBLISH_BROWSER_CHANNEL`). Unset,
 * everything below is unchanged -- the one difference a channel makes is the
 * `channel` field already inside `options`, which `launchOptionsFor` put there.
 * The launched window belongs to this app and its dedicated profile, so `finish`
 * may close it (or leave it for a person) exactly as it does for the bundled Chromium.
 */
export async function openSession(platform: PlatformId, deps: BrowserDeps = {}): Promise<BrowserSession> {
  const env = deps.env ?? process.env;
  const endpoint = cdpEndpoint(env);
  if (endpoint) return attachSession(platform, endpoint, deps);

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
    channel: options.channel ?? null,
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
 *
 * Attached to the operator's own Chrome, the lock still serializes the platform's
 * jobs, but releasing it closes nothing: `finish` only disconnects. If that Chrome
 * cannot be reached the outcome is REQUIRES_CONNECTION, with the steps to start it.
 */
export async function runInSession(
  platform: PlatformId,
  deps: BrowserDeps,
  work: (session: BrowserSession) => Promise<PublishOutcome>,
): Promise<PublishOutcome> {
  const release = await acquirePlatformLock(platform);
  let session: BrowserSession | null = null;
  let leaveOpen = false;
  let timedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const problem = chromiumProblem(deps);
    if (problem) return { status: "REQUIRES_CONNECTION", error: problem };

    try {
      session = await openSession(platform, deps);
      session.page.setDefaultTimeout?.(15_000);
      session.page.setDefaultNavigationTimeout?.(45_000);
    } catch (err) {
      // The operator's Chrome could not be attached to: a connection to make, not a crash, and never a quiet fall back to Chromium.
      if (isCdpUnavailable(err)) return { status: "REQUIRES_CONNECTION", error: err.message };
      // The installed Chrome/Edge that was asked for would not open (most often: it is not installed). Also a
      // connection to make, not a crash -- and never a quiet fall back to the bundled Chromium or to attaching.
      const channel = browserChannel(deps.env ?? process.env);
      if (channel && !cdpEndpoint(deps.env ?? process.env)) {
        // The profile is open in another Chrome (most often the sign-in window): say to close it, which is not an install problem.
        // FAILED, not REQUIRES_CONNECTION: the Publish Center shows a FAILED job's message, whereas a recorded
        // REQUIRES_CONNECTION is recomputed away by `platformStatus` and its message would never be seen.
        // Nothing was opened or posted, so a plain retry (the button is still there) is safe.
        if (isProfileInUse(err)) return { status: "FAILED", error: profileBusyMessage(platform, channel) };
        const why = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim().slice(0, 200);
        return {
          status: "REQUIRES_CONNECTION",
          error: `${channelName(channel)} did not start${why ? ` (${why})` : ""}. ${channelMissing(channel)}`,
        };
      }
      return {
        status: "FAILED",
        error:
          `Chromium would not start: ${err instanceof Error ? err.message : String(err)}. ` +
          "Nothing was opened and nothing was posted.",
      };
    }

    try {
      const activeSession = session;
      const outcome = await Promise.race([
        work(session),
        new Promise<PublishOutcome>((resolve) => {
          watchdog = setTimeout(() => {
            timedOut = true;
            // Closing/disconnecting cancels pending automation before any retry
            // is possible. The persisted uncertainty marker remains intact.
            void activeSession.finish({ leaveOpen: false }).catch(() => {});
            resolve({ status: "AWAITING_HUMAN", error: `The ${PLATFORM_LABELS[platform]} job exceeded its bounded execution time. Automation stopped; inspect the saved draft or schedule before retrying.` });
          }, deps.jobTimeoutMs ?? 45 * 60_000);
        }),
      ]);
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
    if (watchdog) clearTimeout(watchdog);
    if (session && !timedOut) await session.finish({ leaveOpen }).catch(() => {});
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
    if (
      !snap.hasAppShell &&
      ((/\blog in\b/i.test(snap.title) && /\b(log in|sign up)\b/i.test(snap.bodyText)) ||
        /\b(log into instagram|mobile number, username or email)\b/i.test(snap.bodyText))
    ) {
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
  options: { headless: boolean; detail?: string; channel?: BrowserChannel | null },
): string {
  const label = PLATFORM_LABELS[platform];
  const where = options.headless
    ? "The browser is running hidden (BOOKREEL_PUBLISH_HEADLESS), so there is no window to do it in: unset that setting, restart, and try again."
    : "Do that in the open browser window, then press Retry.";
  if (reason === "sign_in") {
    // YouTube in channel mode: Google refuses a sign-in typed into this automated window, so the person
    // signs in once in a plain Chrome on the same profile (the Sign in button) and this window reuses it.
    if (platform === "youtube" && options.channel) {
      return (
        `${label} wants you to sign in. This app never types or stores your password, and Google refuses a sign-in in a window that an automation tool opened. ` +
        `Sign in once in a normal ${channelName(options.channel)} window instead: press "Sign in to ${label}" in the Publish panel, ` +
        "sign in there, pick the channel, close that window, then press Retry."
      );
    }
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
    throw new NeedsHuman("sign_in", humanSentence(platform, "sign_in", { headless: session.headless, channel: session.channel }));
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
  /** Internal durable origin; set only after an explicit Publish-now confirmation. */
  queueOrigin?: "operator-immediate";
  /** Only the runner supplies these durable recovery facts. */
  resumeDraftId?: string | null;
  timezone?: string;
  /** YouTube: `private` unless asked otherwise. Instagram has no private post. */
  visibility?: "private" | "unlisted" | "public";
  /** YouTube only: schedule through Studio. Instagram's web uploader cannot. */
  scheduledAt?: Date | null;
  /**
   * Existing operator answer. A true value requires human review and is never
   * overwritten with No. Browser uploads additionally review the video script.
   */
  madeForKids?: boolean;
  /** Require content review; "studio" remains readable for older saved options. */
  audienceMode?: "review" | "studio";
  /** The caller's explicit acknowledgement that this goes out publicly. */
  confirmPublic?: boolean;
}

export interface BrowserHooks extends PublishHooks {
  /** Persist approved generated tags before any upload. */
  onMetadata?: (metadata: import("../limits").PublishMetadata) => Promise<void>;
  onLog?: (message: string) => void | Promise<void>;
  /** Must be durable before a file is chosen or a final button is pressed. */
  onCheckpoint?: (draftId: string) => void | Promise<void>;
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
 *  - YouTube needs an explicit answer or the content-review path. Neither a
 *    missing answer nor an existing false answer bypasses browser content review.
 *  - Instagram has no private post, so asking for one is refused rather than
 *    quietly turned into an immediate public one. An Instagram SCHEDULE is
 *    refused unless `BOOKREEL_IG_NATIVE_SCHEDULE` is on; when it is, the time is
 *    held to the same rules as a YouTube schedule.
 */
export function browserOptionProblems(
  platform: PlatformId,
  options: BrowserPublishOptions,
  now: number = Date.now(),
  env: EnvLike = process.env,
): OptionProblem[] {
  const problems: OptionProblem[] = [];
  const scheduleAsked = options.scheduledAt !== undefined && options.scheduledAt !== null;
  const validDate = options.scheduledAt instanceof Date && !Number.isNaN(options.scheduledAt.getTime());

  if (platform === "instagram") {
    if (scheduleAsked) {
      if (!igNativeScheduleEnabled(env)) {
        problems.push({
          code: "bad_options",
          message:
            "Scheduling an Instagram post is switched off. Set BOOKREEL_IG_NATIVE_SCHEDULE=1 to allow it, " +
            "or post now instead. Nothing was sent.",
        });
      } else if (!validDate) {
        problems.push({ code: "bad_options", message: "The scheduled time is not a valid date. Nothing was sent." });
      } else if ((options.scheduledAt as Date).getTime() < now + 20 * 60_000) {
        problems.push({
          code: "bad_options",
          message: "Pick a time at least 20 minutes from now to schedule an Instagram post. Nothing was sent.",
        });
      }
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

  if (typeof options.madeForKids !== "boolean" && options.audienceMode !== "studio" && options.audienceMode !== "review") {
    problems.push({
      code: "bad_options",
      message:
        "Say whether this video is made for kids, or use the Weekly Schedule content-review workflow. " +
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
