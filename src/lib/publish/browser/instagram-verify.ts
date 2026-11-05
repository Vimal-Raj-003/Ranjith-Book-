/**
 * SERVER-ONLY. Look at Instagram through BookReel's own Instagram profile and
 * record what it says: who is signed in, what kind of account it is, and whether
 * the New-reel composer offers "Schedule content".
 *
 * WHAT THIS WILL NEVER DO
 *  - Type, read, copy or store a password, a code or a cookie. The login is the
 *    person's, made by hand in a plain Chrome window (`signin.ts`); this only
 *    reuses the profile that window left signed in.
 *  - Get past a log-in, a security check or a "confirm it's you" screen. It stops
 *    and says so (`judgePage` in `engine.ts` is the same recogniser the publisher
 *    uses).
 *  - Share, schedule or post anything. The composer check's clicks are a CLOSED
 *    list (`PROBE_CLICKS`): Create, Post, Next, Advanced settings, Discard. There
 *    is no code path from here to Share or Schedule, and
 *    `tests/instagram-connection.test.mts` fails if one is added.
 *  - Turn on a publishing flag. The two flags are the operator's, in `.env.local`;
 *    this file only READS them to report them.
 *
 * TWO STAGES, because they cost different things:
 *  - `account`    opens instagram.com, reads the signed-in handle from Instagram's
 *                 own page, reads the account type and the account's scheduled-
 *                 content calendar. Uploads nothing.
 *  - `scheduling` does that, then opens Create -> Reel, loads a short blank
 *                 placeholder clip BookReel generated (never one of the person's
 *                 videos) to reach the final screen, looks for the "Schedule
 *                 content" row, and discards the draft. The person must confirm
 *                 this stage; the route refuses without it.
 *
 * Instagram's markup is obfuscated and changes. The composer selectors here are
 * the same ones the publisher's native-schedule flow uses; the stage is
 * UNVERIFIED against the live site until it has run once on a signed-in account.
 * When the last screen is not reached the answer is `unreachable`, never "no".
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { WORK_ROOT } from "@/lib/paths";
import { getSetting, setSetting } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { judgeIdentity, normaliseHandle, displayHandle } from "../connect";
import { publishingEnabled } from "../execution";
import { expectedHandle } from "../identity";
import {
  accountKindFromText,
  carryComposer,
  deriveConnection,
  judgedAgainst,
  nextStep,
  parseVerification,
  type CheckProgress,
  type ComposerCheck,
  type InstagramConnectionView,
  type InstagramVerification,
} from "../instagram-connection";
import {
  browserChannel,
  browserProblem,
  cdpEndpoint,
  clickOn,
  igNativeScheduleEnabled,
  isHeadless,
  isNeedsHuman,
  isProfileInUse,
  isShown,
  openSession,
  profileDirFor,
  readBody,
  waitPresent,
  waitShown,
  type BrowserDeps,
  type BrowserSession,
  type NeedsHuman,
} from "./engine";
import { acquirePlatformLock, isPlatformBusy } from "./live";
import { IG, dismissRoutinePrompts, handleFromAlt, settleSignedIn } from "./instagram";
import { chooseOriginalCrop } from "./instagram-crop";
import { instagramDraftProblem, readInstagramCalendar, type InstagramCalendar } from "./instagram-calendar";
import { dismissPrompts } from "./instagram-prompts";
import { scheduleSwitchIndex } from "./instagram-schedule";
import { windowsProbe, type WindowProbe } from "./window-probe";

/** The `Setting` row the last look is kept in. Not in `SETTING_KEYS`, so `PUT /api/settings` cannot write it. */
export const VERIFICATION_SETTING = "instagramBrowserVerification";

const ACCOUNT_SETTINGS_URL = "https://www.instagram.com/accounts/edit/";
const ADVANCED = 'div[role="button"]:text-is("Advanced settings"), button:text-is("Advanced settings"), span:text-is("Advanced settings")';
const DISCARD = 'button:text-is("Discard"), div[role="button"]:text-is("Discard")';

/**
 * Every selector the composer check is allowed to click. CLOSED on purpose: Share
 * and Schedule are not in it, and nothing else may be added without the test that
 * pins this list noticing.
 */
export const PROBE_CLICKS = {
  newPost: IG.newPost,
  postItem: IG.postItem,
  next: IG.next,
  advanced: ADVANCED,
  discard: DISCARD,
} as const;
type ProbeClick = keyof typeof PROBE_CLICKS;

/** A run that could not reach a conclusion. The stored record is left as it was. */
class CheckFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckFailed";
  }
}

// ----------------------------------------------------------------- stored record

export async function readVerification(): Promise<InstagramVerification | null> {
  return parseVerification(await getSetting(VERIFICATION_SETTING));
}

async function saveVerification(v: InstagramVerification): Promise<void> {
  await setSetting(VERIFICATION_SETTING, JSON.stringify(v));
}

// ----------------------------------------------------------------- progress (memory only)

/**
 * On `globalThis` for the reason `live.ts` is: route handlers and hot reloads can
 * each get their own copy of a module, and the card must see ONE running check.
 */
const g = globalThis as unknown as { bookreelIgCheck?: CheckProgress };
const progress: CheckProgress = (g.bookreelIgCheck ??= {
  running: false,
  mode: null,
  step: null,
  startedAt: null,
  finishedAt: null,
  error: null,
});

// ----------------------------------------------------------------- deps (tests replace these)

/** What the composer check does to the page. Replaced in tests; production passes nothing. */
export interface ProbeHooks {
  /** An open or resumed draft in any Instagram tab: the check must not touch someone's work. */
  draftProblem(session: BrowserSession): Promise<string | null>;
  /** Clear Instagram's "Not Now" modals and set the frame to Original, right after the file loads. */
  afterUpload(session: BrowserSession, log: (m: string) => void): Promise<void>;
  /** Clear "Not Now" modals on the final screen, before looking for the row. */
  settle(session: BrowserSession, log: (m: string) => void): Promise<void>;
  /** Is the "Schedule content" row, with its switch, on screen? Read only; nothing is toggled. */
  scheduleRowPresent(session: BrowserSession): Promise<boolean>;
}

export interface CheckDeps extends BrowserDeps {
  /** Read-only profile ownership check before launching Chrome. Null disables it in fixtures. */
  profileWindow?: Pick<WindowProbe, "waitForWindow"> | null;
  /** The account's scheduled-content calendar. Default: Instagram's own `/scheduled_content/` response. */
  readCalendar?: (session: BrowserSession) => Promise<InstagramCalendar>;
  /** The words on Instagram's settings page. Default: open `/accounts/edit/` and read the page. */
  readAccountText?: (session: BrowserSession) => Promise<string>;
  probe?: Partial<ProbeHooks>;
  /** The blank clip the composer check loads. Default: one ffmpeg makes under the work root. */
  placeholder?: () => Promise<string>;
  now?: () => number;
  /** Tests: resolve only when the background check has finished. */
  waitForCompletion?: boolean;
}

const asPage = (session: BrowserSession): Page => session.page as unknown as Page;

const defaultCalendar = async (session: BrowserSession): Promise<InstagramCalendar> => {
  const reader = await asPage(session).context().newPage();
  reader.setDefaultTimeout(15_000);
  try {
    return await readInstagramCalendar(reader);
  } finally {
    await reader.close().catch(() => {});
  }
};

const defaultAccountText = async (session: BrowserSession): Promise<string> => {
  try {
    await session.page.goto(ACCOUNT_SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await session.clock.sleep(2_500);
    return await readBody(session.page);
  } catch {
    return "";
  }
};

const defaultProbe: ProbeHooks = {
  draftProblem: async (session) => {
    for (const tab of asPage(session).context().pages()) {
      if (!tab.url().startsWith("https://www.instagram.com/")) continue;
      const problem = await instagramDraftProblem(tab);
      if (problem) return problem;
    }
    return null;
  },
  afterUpload: async (session, log) => {
    await dismissPrompts(asPage(session), log);
    await chooseOriginalCrop(asPage(session), log);
  },
  settle: async (session, log) => {
    await dismissPrompts(asPage(session), log);
  },
  scheduleRowPresent: async (session) => (await scheduleSwitchIndex(asPage(session))) !== null,
};

// ----------------------------------------------------------------- the placeholder clip

/**
 * A 4-second dark clip with silent audio, made once under the work root. It exists
 * only so the composer will advance to its last screen; it is never shared.
 */
export async function makePlaceholderClip(): Promise<string> {
  const dir = path.join(WORK_ROOT, "instagram-probe");
  const file = path.join(dir, "bookreel-schedule-check.mp4");
  try {
    if ((await fs.promises.stat(file)).size > 0) return file;
  } catch {
    /* not made yet */
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const { ffmpeg } = await import("@/lib/media/ffmpeg");
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x16161a:s=720x1280:r=30:d=4",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "4", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
    file,
  ]);
  return file;
}

// ----------------------------------------------------------------- stage 1: the account

const NOT_SIGNED_IN =
  "Instagram is not signed in on BookReel's Instagram profile. Press Connect Instagram, sign in by hand in the window " +
  "that opens, close that window, then press Verify account.";
const SECURITY_CHECK =
  "Instagram is showing a security check or verification in the open window. BookReel does not try to get past it: " +
  "complete it yourself, close the window, then press Verify account.";

/** Facts, never a guess: what the stop means for the record. */
function stoppedAt(base: InstagramVerification, err: NeedsHuman): { v: InstagramVerification; leaveOpen: boolean } | null {
  if (err.reason === "sign_in") return { v: { ...base, reason: NOT_SIGNED_IN }, leaveOpen: false };
  if (err.reason === "challenge") return { v: { ...base, reason: SECURITY_CHECK }, leaveOpen: true };
  return null;
}

async function lookAtAccount(
  session: BrowserSession,
  deps: CheckDeps,
  expected: string,
  log: (m: string) => void,
): Promise<{ v: InstagramVerification; leaveOpen: boolean }> {
  const stamp = () => new Date((deps.now ?? Date.now)()).toISOString();
  const base: InstagramVerification = {
    v: 1,
    checkedAt: stamp(),
    signedIn: false,
    handle: null,
    expected,
    identity: "unverified",
    igUserId: null,
    accountKind: "unknown",
    calendar: "not_checked",
    scheduledCount: null,
    composer: "not_checked",
    composerCheckedAt: null,
    reason: null,
  };

  log("Opening Instagram");
  try {
    await session.page.goto(IG.home, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err) {
    throw new CheckFailed(`Could not open Instagram (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`);
  }

  log("Checking that Instagram is signed in");
  try {
    await settleSignedIn(session);
  } catch (err) {
    if (!isNeedsHuman(err)) throw err;
    const stop = stoppedAt(base, err);
    // "Instagram did not finish loading" is not a fact about the account: report it, record nothing.
    if (!stop) throw new CheckFailed(err.message);
    return stop;
  }
  await dismissRoutinePrompts(session);

  log("Reading which account is signed in");
  const alt = await session.page.locator(IG.profilePicture).first().getAttribute("alt", { timeout: 5_000 }).catch(() => null);
  const handle = handleFromAlt(alt);
  const identity = judgeIdentity(handle, expected);
  const signedIn: InstagramVerification = { ...base, signedIn: true, handle: handle ? normaliseHandle(handle) : null, identity };
  if (identity === "unverified") {
    return {
      v: {
        ...signedIn,
        reason: `Instagram did not say which account is signed in, so it cannot be checked against ${displayHandle(expected)}.`,
      },
      leaveOpen: false,
    };
  }
  // The wrong account: stop here. Nothing further is read about an account that is not the one this install publishes to.
  if (identity === "mismatch") return { v: signedIn, leaveOpen: false };

  log("Reading the account type");
  const text = await (deps.readAccountText ?? defaultAccountText)(session);
  const accountKind = accountKindFromText(text);

  log("Reading the account's scheduled-content calendar");
  let calendar: InstagramVerification["calendar"] = "unreadable";
  let igUserId: string | null = null;
  let scheduledCount: number | null = null;
  try {
    const found = await (deps.readCalendar ?? defaultCalendar)(session);
    calendar = "readable";
    igUserId = found.userId;
    scheduledCount = found.items.length;
  } catch {
    /* unreadable is a fact too: login, a challenge, a schema change, or no calendar for this account */
  }

  return { v: { ...signedIn, accountKind, calendar, igUserId, scheduledCount }, leaveOpen: false };
}

// ----------------------------------------------------------------- stage 2: the composer

const safeClick = (session: BrowserSession, key: ProbeClick, what: string, timeoutMs?: number) =>
  clickOn(session, PROBE_CLICKS[key], what, timeoutMs);

/**
 * Walk Create -> Reel -> Next -> Next with the blank clip and LOOK for "Schedule
 * content". Then leave without sharing.
 *
 * `no_schedule_option` is claimed only when the final screen was positively
 * reached (the caption box was on screen) and the row was absent after a wait and
 * after opening "Advanced settings". Any earlier failure is `unreachable`, which
 * says nothing about the account.
 */
export async function probeComposer(
  session: BrowserSession,
  clipPath: string,
  hooks: ProbeHooks,
  log: (m: string) => void,
): Promise<{ composer: ComposerCheck; reason: string | null }> {
  const unreachable = (why: string) => ({
    composer: "unreachable" as const,
    reason: `${why} Nothing was shared or scheduled, and BookReel did not find out whether this account can schedule.`,
  });
  const page = session.page;
  try {
    log("Checking for a draft that is already open");
    const draft = await hooks.draftProblem(session);
    if (draft) return unreachable(`${draft}`);

    await page.goto(IG.home, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settleSignedIn(session);
    await dismissRoutinePrompts(session);

    log("Opening Create");
    await safeClick(session, "newPost", "Create", 30_000);
    if (await page.locator(PROBE_CLICKS.postItem).first().isVisible().catch(() => false)) {
      await page.locator(PROBE_CLICKS.postItem).first().click({ timeout: 10_000 });
    }
    const draftNow = await hooks.draftProblem(session);
    if (draftNow) return unreachable(draftNow);
    if (!(await waitPresent(session, IG.fileInput, 30_000))) return unreachable("Instagram did not offer a file picker.");

    log("Loading BookReel's blank placeholder clip (nothing is shared)");
    await page.locator(IG.fileInput).first().setInputFiles(clipPath, { timeout: 60_000 });
    await hooks.afterUpload(session, log);

    log("Moving to the last screen");
    await safeClick(session, "next", "Next to Cover", 120_000);
    await safeClick(session, "next", "Next to Caption", 60_000);

    if (!(await waitShown(session, IG.caption, 30_000))) {
      return unreachable("Instagram's composer did not reach its last screen.");
    }
    await hooks.settle(session, log);

    log('Looking for "Schedule content"');
    for (let i = 0; i < 8; i++) {
      if (await hooks.scheduleRowPresent(session)) return { composer: "offers_schedule", reason: null };
      await session.clock.sleep(1_000);
    }
    // The row can sit in a collapsed "Advanced settings" section on some layouts. Opening it only reveals text.
    if (await isShown(page, PROBE_CLICKS.advanced)) {
      log('Opening "Advanced settings" to look inside');
      await safeClick(session, "advanced", "Advanced settings", 10_000).catch(() => {});
      await session.clock.sleep(1_000);
      for (let i = 0; i < 4; i++) {
        if (await hooks.scheduleRowPresent(session)) return { composer: "offers_schedule", reason: null };
        await session.clock.sleep(1_000);
      }
    }
    return { composer: "no_schedule_option", reason: null };
  } catch (err) {
    return unreachable(`${err instanceof Error ? err.message.split("\n")[0] : String(err)}.`);
  } finally {
    await leaveComposer(session, log);
  }
}

/** Close the composer without sharing: Escape, then "Discard" if Instagram asks. The window is closed after, regardless. */
async function leaveComposer(session: BrowserSession, log: (m: string) => void): Promise<void> {
  try {
    await session.page.keyboard.press("Escape");
    await session.clock.sleep(800);
    if (await isShown(session.page, PROBE_CLICKS.discard)) {
      log("Discarding the placeholder draft");
      await safeClick(session, "discard", "Discard", 8_000);
    }
  } catch {
    /* the window is closed next; a draft that cannot be discarded here dies with it */
  }
}

// ----------------------------------------------------------------- a whole check

export type CheckMode = "account" | "scheduling";

/**
 * What a POST asks for, or the reason it is refused. `verify` reads the account
 * and uploads nothing. `check_scheduling` loads a blank clip into Instagram's
 * composer, so it is refused unless the body says the person confirmed that --
 * the same rule the publish routes apply to anything that cannot be taken back
 * from here.
 */
export function parseCheckRequest(body: unknown): CheckMode {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("bad_body", "Expected a JSON object.", 400);
  }
  const { action, confirm } = body as Record<string, unknown>;
  if (action === "verify") return "account";
  if (action === "check_scheduling") {
    if (confirm !== true) {
      throw new AppError(
        "needs_confirmation",
        "Checking for Schedule content loads a blank placeholder clip into Instagram's composer. Confirm that is what you want. Nothing was opened.",
        400,
      );
    }
    return "scheduling";
  }
  throw new AppError("bad_action", "Say what to do: verify or check_scheduling.", 400);
}

async function runCheck(mode: CheckMode, deps: CheckDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const expected = expectedHandle("instagram", env);
  const stamp = () => new Date((deps.now ?? Date.now)()).toISOString();
  const log = (m: string) => {
    progress.step = m;
  };

  const release = await acquirePlatformLock("instagram");
  let session: BrowserSession | null = null;
  let leaveOpen = false;
  let timedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    // Plain Chrome owns the sign-in profile until the person closes it. A
    // second launch can forward Playwright's about:blank startup tab into that
    // window and exit, so openSession never returns and goto is never reached.
    // Refuse before launching; never close the person's window or edit its profile.
    const probe = deps.profileWindow !== undefined
      ? deps.profileWindow
      : process.platform === "win32" && !deps.launch ? windowsProbe : null;
    if (probe && browserChannel(env) && !cdpEndpoint(env)) {
      log("Checking whether BookReel's Instagram profile is already open");
      const found = await probe.waitForWindow(profileDirFor("instagram", deps.profileRoot), 0)
        .catch(() => ({ state: "unknown" as const }));
      if (found.state === "window" || (found.state === "none" && found.holders.length > 0)) {
        throw new CheckFailed(
          "BookReel's Instagram profile is already open in Chrome. Close the Chrome window opened by Connect Instagram, " +
          "then press Verify account again. Verification needs to reopen that same profile to navigate to Instagram. " +
          "No browser was opened or closed, and nothing was changed.",
        );
      }
    }
    log("Opening BookReel's Instagram window");
    try {
      session = await openSession("instagram", deps);
      session.page.setDefaultTimeout?.(15_000);
      session.page.setDefaultNavigationTimeout?.(45_000);
    } catch (err) {
      if (isProfileInUse(err)) {
        throw new CheckFailed(
          "Close the Instagram sign-in window, then verify again. Chrome could not open BookReel's Instagram profile, " +
            "most likely because that window is still using it. Nothing was changed.",
        );
      }
      throw new CheckFailed(`The browser would not open (${(err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200)}). Nothing was changed.`);
    }

    const active = session;
    const work = (async () => {
      const previous = await readVerification();
      const look = await lookAtAccount(active, deps, expected, log);
      leaveOpen = look.leaveOpen && !isHeadless(env);
      let v = look.v;

      if (mode === "scheduling" && v.signedIn && v.identity === "match") {
        const clip = await (deps.placeholder ?? makePlaceholderClip)();
        const probe = await probeComposer(active, clip, { ...defaultProbe, ...deps.probe }, log);
        if (probe.composer === "unreachable") {
          // An unreachable composer proves nothing: keep a still-valid earlier answer for the same account.
          const carried = carryComposer(previous, { ...v, composer: "not_checked" });
          v =
            carried.composer !== "not_checked"
              ? { ...carried, reason: probe.reason }
              : { ...v, composer: "unreachable", composerCheckedAt: stamp(), reason: probe.reason };
          progress.error = probe.reason;
        } else {
          v = { ...v, composer: probe.composer, composerCheckedAt: stamp() };
        }
      } else {
        v = carryComposer(previous, v);
      }
      await saveVerification(v);
    })();

    await Promise.race([
      work,
      new Promise<void>((_, reject) => {
        watchdog = setTimeout(() => {
          timedOut = true;
          void active.finish({ leaveOpen: false }).catch(() => {});
          reject(new CheckFailed("The Instagram check took too long, so BookReel closed the window. Nothing was changed."));
        }, deps.jobTimeoutMs ?? 4 * 60_000);
      }),
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (session && !timedOut) await session.finish({ leaveOpen }).catch(() => {});
    release();
  }
}

/**
 * Start a check in the background and return the view at once; the card polls
 * `instagramConnectionView` for progress. One at a time, and never while an
 * Instagram publish holds the window.
 */
export async function startInstagramCheck(mode: CheckMode, deps: CheckDeps = {}): Promise<InstagramConnectionView> {
  if (progress.running) throw new AppError("check_running", "An Instagram check is already running. Wait for it to finish.", 409);
  if (isPlatformBusy("instagram")) {
    throw new AppError("instagram_busy", "An Instagram job is using BookReel's Instagram window right now. Wait for it to finish, then verify.", 409);
  }
  // Claimed before the first await, so two quick presses cannot both start.
  progress.running = true;
  progress.mode = mode;
  progress.step = "Starting";
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;
  progress.error = null;
  try {
    const problem = await browserProblem("instagram", deps);
    if (problem) throw new AppError("browser_unavailable", problem, 409);
  } catch (err) {
    progress.running = false;
    progress.mode = null;
    progress.step = null;
    throw err;
  }

  const done = runCheck(mode, deps)
    .catch((err: unknown) => {
      progress.error = err instanceof CheckFailed ? err.message : `The Instagram check stopped unexpectedly (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`;
    })
    .finally(() => {
      progress.running = false;
      progress.step = null;
      progress.finishedAt = new Date().toISOString();
    });
  if (deps.waitForCompletion) await done;
  return instagramConnectionView(deps);
}

// ----------------------------------------------------------------- the view

export interface ViewDeps extends BrowserDeps {
  now?: () => number;
}

/** What the Publish panel draws. Reads the last look and the flags; opens no browser. */
export async function instagramConnectionView(deps: ViewDeps = {}): Promise<InstagramConnectionView> {
  const env = deps.env ?? process.env;
  const expected = expectedHandle("instagram", env);
  const stored = judgedAgainst(await readVerification(), expected);
  const derived = deriveConnection(stored, (deps.now ?? Date.now)());
  const flags = { publish: publishingEnabled("instagram", env), nativeSchedule: igNativeScheduleEnabled(env) };
  const problem = await browserProblem("instagram", deps).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
  const attach = cdpEndpoint(env) !== null;
  return {
    state: derived.state,
    handle: stored?.handle ? displayHandle(stored.handle) : null,
    expected: displayHandle(expected),
    accountKind: stored?.accountKind ?? "unknown",
    calendar: stored?.calendar ?? "not_checked",
    scheduledCount: stored?.scheduledCount ?? null,
    composer: stored?.composer ?? "not_checked",
    checkedAt: stored?.checkedAt ?? null,
    composerCheckedAt: stored?.composerCheckedAt ?? null,
    stale: derived.stale,
    reason: derived.reason,
    next: nextStep(derived.state, flags),
    check: { ...progress },
    browser: {
      ready: problem === null,
      reason: problem,
      kind: attach ? "attach" : browserChannel(env) ? "channel" : "bundled",
      headless: attach ? false : isHeadless(env),
    },
    flags,
  };
}
