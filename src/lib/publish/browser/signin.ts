/**
 * SERVER-ONLY. The one-time sign-in window: a PLAIN Chrome, on BookReel's own
 * profile, for a person to sign in to by hand -- once.
 *
 * WHY IT EXISTS. Google refuses a sign-in in any browser an automation tool
 * started ("This browser or app may not be secure"), and BookReel does not hide
 * that its publishing window is automated (see `engine.ts`). The honest way round
 * it is not to sign in there at all: the person signs in ONCE, in an ordinary
 * Chrome, on the same dedicated profile directory the publishing window later
 * opens. The session lives in that profile, so the publishing window starts
 * already signed in, lands on Studio, and never visits Google's sign-in page.
 *
 * WHAT "PLAIN" MEANS HERE, and why it is tested rather than promised:
 *  - It is an ordinary operating-system process (`child_process.spawn`), not
 *    Playwright. Nothing drives it, nothing is attached to it, nothing is
 *    injected into it.
 *  - Its whole command line is `--user-data-dir=<the dedicated profile>`. No
 *    debugging port, no automation switch, no Chromium feature flag, no user
 *    agent, no URL: any of those would make it a different kind of browser, and
 *    the point is that it is a normal one. `signInArgv` is the only place that
 *    line is built, and `tests/publish-browser.test.mts` asserts it.
 *  - It is detached and unreferenced, so it is the person's window from the
 *    moment it opens: it outlives this request, and closing it is theirs to do.
 *
 * WHAT IT DOES NOT DO. It does not type, read, copy or store a password or a
 * cookie; it does not look inside the profile (it only creates the empty
 * directory, as the publishing window would); it does not use the person's
 * personal Chrome profile; and it does not remove a profile lock -- a profile can
 * be open in one Chrome at a time, so while this window is open the publishing
 * window cannot start, and says so (`profileBusyMessage`).
 *
 * WHEN IT IS OFFERED. Only in channel mode (`BOOKREEL_PUBLISH_BROWSER_CHANNEL`):
 * that is the mode whose publishing window is the same installed Chrome on the
 * same profile, which is what makes the saved session usable. With an attached
 * Chrome (`BOOKREEL_PUBLISH_CHROME_CDP`) the person already signs in to their own
 * Chrome; with the bundled Chromium the profile belongs to a different browser.
 *
 * "OPENED" MEANS "ON THE PERSON'S SCREEN". The operating system reporting the
 * process as started proves nothing about that: a Chrome started from a server that
 * itself runs on a hidden Windows desktop (a sandbox's) is running, has a window,
 * and is invisible -- and so is every Chrome that later press hands its command
 * line to. So on Windows this refuses to start Chrome from a hidden desktop
 * (`hidden_desktop`, nothing opened), and after starting it waits to SEE a window
 * of the profile (`no_window` when none appears). `window-probe.ts` only looks; it
 * never closes, moves or targets anything, and does not route around a sandbox.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { PLATFORM_LABELS, type PlatformId } from "../limits";
import { expectedHandle } from "../identity";
import type { EnvLike } from "../youtube/secrets";
import {
  CDP_ENV,
  CHANNEL_ENV,
  browserChannel,
  cdpEndpoint,
  channelName,
  locateBrowserChannel,
  profileDirFor,
  type BrowserChannel,
} from "./engine";
import { closeLeftOpenWindow, isPlatformBusy } from "./live";
import { isInteractiveDesktop, windowsProbe, type WindowProbe, type WindowSighting } from "./window-probe";

/**
 * Start a program and let go of it. Resolves once the operating system has started
 * it; rejects if it could not be started. Replaceable, so tests start nothing.
 */
export type Spawner = (executable: string, argv: readonly string[]) => Promise<void>;

export interface SignInDeps {
  env?: EnvLike;
  /** Root for the profile directories. Default: the work root. */
  profileRoot?: string;
  /** Where the installed Chrome/Edge is. Default: the standard install locations. */
  locateChannel?: (browser: BrowserChannel) => string | null;
  /** Start the program. Default: a detached `child_process.spawn`. */
  spawner?: Spawner;
  /**
   * How to tell the window is on the person's screen. Default: the real Windows probe when the real
   * spawner is used; NONE when a spawner is injected (a stand-in opens no window, so there is nothing
   * to look for). Pass `null` for none, or a probe to exercise the check.
   */
  windows?: WindowProbe | null;
}

export type SignInRefusal =
  | "attach_mode"
  | "no_channel"
  | "chrome_not_found"
  | "busy"
  | "hidden_desktop"
  | "spawn_failed"
  | "no_window";

/** How long to look for the window after starting Chrome. A cold start on a fresh profile can take a few seconds. */
export const WINDOW_WAIT_MS = 12_000;

export type SignInResult = { ok: true; message: string } | { ok: false; code: SignInRefusal; message: string };

/**
 * The ENTIRE command line of the sign-in window: the dedicated profile, and nothing else.
 * (`--profile-directory=Default` would be equivalent -- it is what Chrome picks anyway -- so it is left out.)
 */
export function signInArgv(profileDir: string): string[] {
  return [`--user-data-dir=${profileDir}`];
}

/** The real spawner: a detached, unreferenced process with no stdio, so it is the person's window and not ours. */
export const startDetached: Spawner = (executable, argv) =>
  new Promise<void>((resolve, reject) => {
    // No shell, so nothing in the path or the argument is ever interpreted.
    const child = spawn(executable, [...argv], { detached: true, stdio: "ignore" });
    // `spawn` reports a program that cannot start as an 'error' event, later; unhandled, that would end the server.
    child.once("error", reject);
    child.once("spawn", () => resolve());
    child.unref();
  });

const SITE: Record<PlatformId, string> = { youtube: "studio.youtube.com", instagram: "instagram.com" };

const refused = (code: SignInRefusal, message: string): SignInResult => ({ ok: false, code, message });

/**
 * Open the sign-in window for a platform, or say plainly why not. Never throws:
 * every way this can go wrong is a sentence for the person, with nothing opened.
 */
export async function openSignInWindow(platform: PlatformId, deps: SignInDeps = {}): Promise<SignInResult> {
  const env = deps.env ?? process.env;
  const label = PLATFORM_LABELS[platform];

  if (cdpEndpoint(env)) {
    return refused(
      "attach_mode",
      `BookReel is set to use your own Chrome (${CDP_ENV}), so sign in to ${label} in that Chrome instead. Nothing was opened.`,
    );
  }
  const channel = browserChannel(env);
  if (!channel) {
    return refused(
      "no_channel",
      `Signing in once and reusing it needs your installed Chrome: set ${CHANNEL_ENV}=chrome and restart BookReel, then try again. Nothing was opened.`,
    );
  }
  const browser = channelName(channel);
  const executable = (deps.locateChannel ?? ((c: BrowserChannel) => locateBrowserChannel(c, env)))(channel);
  if (!executable) {
    return refused(
      "chrome_not_found",
      `Chrome not found: ${browser} is not installed in its standard location on the computer running BookReel, so no sign-in window was opened. ` +
        `Install it (or unset ${CHANNEL_ENV}) and try again.`,
    );
  }
  // A publish holds the profile, and a second Chrome on a held profile would open INSIDE that automated window.
  if (isPlatformBusy(platform)) {
    return refused(
      "busy",
      `A ${label} publish is running and has the BookReel profile open, so a sign-in window cannot be opened on it now. Let it finish, then try again. Nothing was opened.`,
    );
  }

  // A real start can be checked; a stand-in spawner opens nothing, so it has nothing to look for.
  const probe = deps.windows !== undefined ? deps.windows : deps.spawner || process.platform !== "win32" ? null : windowsProbe;

  // Before anything is started: a Chrome opened from a hidden desktop is invisible to the person, and a profile has ONE
  // Chrome, so it would also swallow every later press. Refuse here, with nothing opened and nothing left holding the profile.
  const desktop = probe ? await probe.desktop().catch(() => null) : null;
  if (desktop && !isInteractiveDesktop(desktop)) {
    return refused(
      "hidden_desktop",
      `BookReel is running on a hidden Windows desktop ("${desktop}") rather than yours, so a ${browser} window opened from here would be invisible to you. ` +
        "That usually means the BookReel server was started by a coding assistant's sandbox, not from your own terminal. " +
        `Nothing was opened. Stop the BookReel server and start it again from a normal PowerShell or Command Prompt window on your desktop ` +
        "(in the BookReel folder, the way you normally start it, for example npx next dev), then press Connect again.",
    );
  }

  const profileDir = profileDirFor(platform, deps.profileRoot);
  try {
    // A window an earlier publish left open for a person is BookReel's own, on this same profile: it must go first,
    // or the plain Chrome below would be handed to it and open inside an automated browser, which defeats the point.
    await closeLeftOpenWindow(platform);
    await fs.promises.mkdir(profileDir, { recursive: true });
    await (deps.spawner ?? startDetached)(executable, signInArgv(profileDir));
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim().slice(0, 200);
    return refused("spawn_failed", `${browser} would not open${why ? ` (${why})` : ""}. Nothing was signed in.`);
  }

  // The OS says it started. Now look for the window: success is only claimed for one the person can see.
  const sighting: WindowSighting = probe
    ? await probe.waitForWindow(profileDir, WINDOW_WAIT_MS).catch((): WindowSighting => ({ state: "unknown" }))
    : { state: "unknown" };
  if (sighting.state === "none") {
    const holders = sighting.holders;
    return refused(
      "no_window",
      `${browser} was started, but no ${browser} window appeared on your screen within ${WINDOW_WAIT_MS / 1000} seconds. ` +
        (holders.length > 0
          ? `A ${browser} that is already running (process ${holders.join(", ")}) has BookReel's ${label} profile open without a window you can see, ` +
            "and it took this one over. Close it in Task Manager (end that chrome.exe and its child processes), then press Connect again. "
          : `${browser} may have closed straight away. `) +
        "Nothing was signed in.",
    );
  }

  const handle = expectedHandle(platform, env);
  const confirmed = sighting.state === "window";
  return {
    ok: true,
    message:
      `A normal ${browser} window is ${confirmed ? "open" : "opening"} on BookReel's own ${label} profile (not your personal one). ` +
      `In it, open ${SITE[platform]}, sign in to the account that publishes to ${handle}` +
      `${platform === "youtube" ? " and pick that channel" : ""}, then close the window and publish. ` +
      "BookReel never types or stores your password." +
      (probe && !confirmed ? ` BookReel could not confirm the window is on your screen; if you do not see ${browser}, start BookReel from a normal terminal and try again.` : ""),
  };
}
