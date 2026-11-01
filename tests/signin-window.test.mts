import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openSignInWindow, signInArgv, WINDOW_WAIT_MS, type Spawner } from "../src/lib/publish/browser/signin";
import {
  PROBE_SCRIPT,
  isInteractiveDesktop,
  parseDesktop,
  parseSighting,
  windowsProbe,
  type WindowProbe,
  type WindowSighting,
} from "../src/lib/publish/browser/window-probe";
import { profileDirFor } from "../src/lib/publish/browser/engine";
import { InstagramConnectionCard } from "../src/components/InstagramConnection";
import type { InstagramConnectionView } from "../src/lib/publish/instagram-connection";
import { strings } from "../src/lib/strings";

/**
 * "A window is opening" used to be said as soon as the operating system had created the process. On Windows
 * that proves nothing about the screen: a Chrome started from a server on a hidden desktop (a sandbox's) is
 * running, has a window, and is invisible to the person -- and every later press is handed to that same
 * invisible Chrome. These tests pin the two guards: refuse to start Chrome from a hidden desktop, and never say
 * "open" for a window that was not seen. The real probe is also run against this machine.
 */

const CHANNEL_CHROME = { BOOKREEL_PUBLISH_BROWSER_CHANNEL: "chrome" };
const INSTALLED_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "bookreel-signin-window-"));
}

function fakeSpawner() {
  const spawns: { executable: string; argv: readonly string[] }[] = [];
  const spawner: Spawner = async (executable, argv) => {
    spawns.push({ executable, argv });
  };
  return { spawns, spawner };
}

function fakeProbe(desktop: string | null, sighting: WindowSighting | Error) {
  const calls = { desktop: 0, waited: [] as { profileDir: string; ms: number }[] };
  const probe: WindowProbe = {
    async desktop() {
      calls.desktop++;
      return desktop;
    },
    async waitForWindow(profileDir, ms) {
      calls.waited.push({ profileDir, ms });
      if (sighting instanceof Error) throw sighting;
      return sighting;
    },
  };
  return { probe, calls };
}

async function signIn(
  root: string,
  probe: WindowProbe | null,
  platform: "youtube" | "instagram" = "instagram",
) {
  const fake = fakeSpawner();
  const result = await openSignInWindow(platform, {
    env: CHANNEL_CHROME,
    profileRoot: root,
    locateChannel: () => INSTALLED_CHROME,
    spawner: fake.spawner,
    windows: probe,
  });
  return { result, fake };
}

// ------------------------------------------------------------------ the hidden-desktop refusal

test("hidden desktop: nothing is started, and the sentence names the desktop and what to do", async () => {
  const root = await tempRoot();
  try {
    const { probe, calls } = fakeProbe("exebox-AB7JMIAWROJ56LF66PMNPUJFVL", { state: "window", title: "should never be asked" });
    const { result, fake } = await signIn(root, probe);

    assert.ok(!result.ok && result.code === "hidden_desktop");
    assert.deepEqual(fake.spawns, [], "no Chrome was started: an invisible one would hold the profile and swallow every later press");
    assert.deepEqual(calls.waited, [], "it never even looked for a window");
    await assert.rejects(fs.stat(profileDirFor("instagram", root)), "not even the profile directory was made");

    assert.match(result.message, /exebox-AB7JMIAWROJ56LF66PMNPUJFVL/, "it says WHICH desktop, so the cause can be checked");
    assert.match(result.message, /invisible to you/);
    assert.match(result.message, /Nothing was opened\./);
    assert.match(result.message, /normal PowerShell or Command Prompt/);
    assert.match(result.message, /press Connect again/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("hidden desktop: any desktop other than Default is refused; Default (in any case) and 'cannot tell' go ahead", async () => {
  assert.equal(isInteractiveDesktop("Default"), true);
  assert.equal(isInteractiveDesktop("default"), true);
  assert.equal(isInteractiveDesktop(" Default "), true);
  for (const hidden of ["exebox-AB7JMIAWROJ56LF66PMNPUJFVL", "Winlogon", "Screen-saver", "Default2", ""]) {
    assert.equal(isInteractiveDesktop(hidden), false, hidden);
  }

  const root = await tempRoot();
  try {
    for (const hidden of ["Winlogon", "bookreel-test-desktop"]) {
      const { result, fake } = await signIn(root, fakeProbe(hidden, { state: "window", title: "x" }).probe);
      assert.ok(!result.ok && result.code === "hidden_desktop", hidden);
      assert.deepEqual(fake.spawns, []);
    }
    // "Cannot tell" (no PowerShell, a timeout) is not "hidden": it goes on, and the window check below still applies.
    const unknown = await signIn(root, fakeProbe(null, { state: "window", title: "New Tab - Google Chrome" }).probe);
    assert.equal(unknown.result.ok, true);
    assert.equal(unknown.fake.spawns.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ "open" means "seen"

test("a window that was SEEN: success is said as 'open', the command line is still just the dedicated profile", async () => {
  const root = await tempRoot();
  try {
    const { probe, calls } = fakeProbe("Default", { state: "window", title: "New Tab - Google Chrome" });
    const { result, fake } = await signIn(root, probe);

    assert.equal(result.ok, true);
    assert.ok(result.ok);
    const profile = profileDirFor("instagram", root);
    assert.deepEqual(fake.spawns, [{ executable: INSTALLED_CHROME, argv: signInArgv(profile) }]);
    assert.deepEqual(fake.spawns[0].argv, [`--user-data-dir=${profile}`], "the dedicated profile and nothing else");
    assert.doesNotMatch(profile, /Google[\\/]Chrome[\\/]User Data/i, "never the personal profile");
    assert.deepEqual(calls.waited, [{ profileDir: profile, ms: WINDOW_WAIT_MS }], "it looked for a window of THAT profile");

    assert.match(result.message, /A normal Google Chrome window is open on BookReel's own Instagram profile \(not your personal one\)/);
    assert.match(result.message, /@between_pages/);
    assert.match(result.message, /never types or stores your password/);
    assert.doesNotMatch(result.message, /could not confirm/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("no window appeared: the launch is an error, not 'opening' -- and a Chrome already holding the profile is named", async () => {
  const root = await tempRoot();
  try {
    const held = await signIn(root, fakeProbe("Default", { state: "none", holders: [35888] }).probe);
    assert.ok(!held.result.ok && held.result.code === "no_window");
    assert.equal(held.fake.spawns.length, 1, "a start WAS attempted; the error is about what the person can see");
    assert.match(held.result.message, /no Google Chrome window appeared on your screen within 12 seconds/);
    assert.match(held.result.message, /process 35888/, "the stuck Chrome is named so it can be closed");
    assert.match(held.result.message, /Task Manager/);
    assert.match(held.result.message, /Nothing was signed in\.$/);
    assert.doesNotMatch(held.result.message, /is opening|is open/);

    const closed = await signIn(root, fakeProbe("Default", { state: "none", holders: [] }).probe);
    assert.ok(!closed.result.ok && closed.result.code === "no_window");
    assert.match(closed.result.message, /may have closed straight away/);
    assert.doesNotMatch(closed.result.message, /process \d/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a probe that cannot answer is never read as 'no window' -- success is kept but honest, and nothing throws", async () => {
  const root = await tempRoot();
  try {
    for (const sighting of [{ state: "unknown" } as WindowSighting, new Error("powershell exploded")]) {
      const { result } = await signIn(root, fakeProbe("Default", sighting).probe);
      assert.ok(result.ok, String(sighting instanceof Error ? sighting.message : sighting.state));
      assert.match(result.message, /window is opening on BookReel's own Instagram profile/);
      assert.match(result.message, /could not confirm the window is on your screen/);
    }
    // A probe that fails while asking the DESKTOP is "cannot tell" too.
    const throwing: WindowProbe = {
      desktop: async () => {
        throw new Error("boom");
      },
      waitForWindow: async () => ({ state: "window", title: "x" }),
    };
    assert.equal((await signIn(root, throwing)).result.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the same guard serves YouTube's sign-in window, and a stand-in spawner without a probe behaves exactly as before", async () => {
  const root = await tempRoot();
  try {
    const hidden = await signIn(root, fakeProbe("exebox-X", { state: "window", title: "x" }).probe, "youtube");
    assert.ok(!hidden.result.ok && hidden.result.code === "hidden_desktop");

    const seen = await signIn(root, fakeProbe("Default", { state: "window", title: "x" }).probe, "youtube");
    assert.ok(seen.result.ok);
    assert.match(seen.result.message, /studio\.youtube\.com/);
    assert.match(seen.result.message, /and pick that channel/);

    // No probe given and a spawner injected (every existing test): no real PowerShell is run, and the wording is unchanged.
    const fake = fakeSpawner();
    const plain = await openSignInWindow("youtube", {
      env: CHANNEL_CHROME,
      profileRoot: root,
      locateChannel: () => INSTALLED_CHROME,
      spawner: fake.spawner,
    });
    assert.ok(plain.ok);
    assert.match(plain.message, /window is opening on/);
    assert.doesNotMatch(plain.message, /could not confirm/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the earlier refusals still come first and still open nothing (Chrome missing, wrong mode)", async () => {
  const root = await tempRoot();
  try {
    const { probe, calls } = fakeProbe("exebox-X", { state: "none", holders: [] });
    const fake = fakeSpawner();
    const missing = await openSignInWindow("instagram", {
      env: CHANNEL_CHROME,
      profileRoot: root,
      locateChannel: () => null,
      spawner: fake.spawner,
      windows: probe,
    });
    assert.ok(!missing.ok && missing.code === "chrome_not_found");
    const noChannel = await openSignInWindow("instagram", {
      env: {},
      profileRoot: root,
      locateChannel: () => INSTALLED_CHROME,
      spawner: fake.spawner,
      windows: probe,
    });
    assert.ok(!noChannel.ok && noChannel.code === "no_channel");
    assert.equal(calls.desktop, 0, "the screen is not even asked about when the launch is refused for another reason");
    assert.deepEqual(fake.spawns, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the probe itself

test("probe output: desktop and window lines are parsed; garbage is 'cannot tell', never 'no window'", () => {
  assert.equal(parseDesktop("desktop|Default\r\n"), "Default");
  assert.equal(parseDesktop("noise\ndesktop|exebox-AB7\n"), "exebox-AB7");
  assert.equal(parseDesktop("desktop|\n"), null);
  assert.equal(parseDesktop(""), null);
  assert.equal(parseDesktop("Exception: nope"), null);

  assert.deepEqual(parseSighting("window|35888|New Tab - Google Chrome\r\n"), { state: "window", title: "New Tab - Google Chrome" });
  assert.deepEqual(parseSighting("window|1|Inbox | a | b"), { state: "window", title: "Inbox | a | b" }, "a title may contain the separator");
  assert.deepEqual(parseSighting("none|35888,40012\n"), { state: "none", holders: [35888, 40012] });
  assert.deepEqual(parseSighting("none|\n"), { state: "none", holders: [] });
  assert.deepEqual(parseSighting("none|abc,,-3,7"), { state: "none", holders: [7] }, "only real process ids survive");
  for (const junk of ["", "   ", "Add-Type : error CS1002", "windows|1|x"]) {
    assert.deepEqual(parseSighting(junk), { state: "unknown" }, JSON.stringify(junk));
  }
});

test("probe script: it only LOOKS -- nothing that closes, starts, posts to, or switches to anything, and no spliced path", () => {
  for (const verb of [
    "Stop-Process",
    "taskkill",
    "CloseMainWindow",
    "Kill(",
    "Start-Process",
    "CreateProcess",
    "ShellExecute",
    "PostMessage",
    "SendMessage",
    "SendKeys",
    "SetForegroundWindow",
    "ShowWindow",
    "SetThreadDesktop",
    "SwitchDesktop",
    "OpenDesktop",
    "OpenInputDesktop",
    "CreateDesktop",
    "EnumDesktop",
    "Invoke-Expression",
    "iex ",
    "Invoke-WebRequest",
    "DownloadString",
  ]) {
    assert.ok(!PROBE_SCRIPT.includes(verb), `the probe script must not contain ${verb}`);
  }
  // The profile path (and the mode, and the wait) arrive in the environment; none is written into the script.
  assert.match(PROBE_SCRIPT, /\$env:BOOKREEL_PROBE_PROFILE/);
  assert.match(PROBE_SCRIPT, /\$env:BOOKREEL_PROBE_MODE/);
  assert.doesNotMatch(PROBE_SCRIPT, /browser-profiles|Ranjith|\.bookreel/i);
  // It asks about THIS process's desktop and THIS desktop's windows -- the two calls that cannot reach another one.
  assert.match(PROBE_SCRIPT, /GetThreadDesktop\(GetCurrentThreadId\(\)\)/);
  assert.match(PROBE_SCRIPT, /EnumWindows\(/);
});

test(
  "the REAL probe on this machine: it knows its own desktop, and finds no window for a profile nobody has open",
  { skip: process.platform !== "win32" ? "Windows only" : false },
  async () => {
    const desktop = await windowsProbe.desktop();
    assert.ok(typeof desktop === "string" && desktop.length > 0, `a desktop name, got ${JSON.stringify(desktop)}`);

    const root = await tempRoot();
    try {
      const unused = path.join(root, "browser-profiles", "nobody-has-this-open");
      const seen = await windowsProbe.waitForWindow(unused, 800);
      assert.deepEqual(seen, { state: "none", holders: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

// ------------------------------------------------------------------ the card

const c = strings.publishCenter.instagramConnect;

function view(): InstagramConnectionView {
  return {
    state: "not_connected",
    handle: null,
    expected: "@between_pages",
    accountKind: "unknown",
    calendar: "not_checked",
    scheduledCount: null,
    composer: "not_checked",
    checkedAt: null,
    composerCheckedAt: null,
    stale: false,
    reason: null,
    next: "connect",
    check: { running: false, mode: null, step: null, startedAt: null, finishedAt: null, error: null },
    browser: { ready: true, reason: null, kind: "channel", headless: false },
    flags: { publish: false, nativeSchedule: false },
  };
}

function card(connectError?: string | null, note: string | null = null): string {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(InstagramConnectionCard, {
      view: view(),
      loadError: null,
      busy: null,
      note,
      ...(connectError === undefined ? {} : { connectError }),
      onConnect: noop,
      onVerify: noop,
      onCheckScheduling: noop,
      onReload: noop,
    }),
  );
}

test("card: a launch that opened nothing is an alert ON the card, with the reason -- and not a success note", () => {
  const why = 'BookReel is running on a hidden Windows desktop ("exebox-AB7") rather than yours. Nothing was opened.';
  const html = card(why);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-instagram-connect-error="true"/);
  assert.ok(html.includes(c.connectErrorHeading));
  assert.ok(html.includes("exebox-AB7"));
  assert.ok(html.includes("Nothing was opened."));
  assert.ok(html.includes("Connect Instagram"), "the button is still there to try again");

  // No error: no alert, and a missing prop is the same as null.
  for (const html2 of [card(null), card(undefined)]) {
    assert.doesNotMatch(html2, /data-instagram-connect-error/);
    assert.ok(!html2.includes(c.connectErrorHeading));
  }
  // The success note and the error are different things and render separately.
  const noted = card(null, "A normal Google Chrome window is open on BookReel's own Instagram profile.");
  assert.ok(noted.includes("window is open"));
  assert.doesNotMatch(noted, /data-instagram-connect-error/);
});

test("card container: a refused launch is kept on the card and cleared on the next try", async () => {
  const src = await fs.readFile(new URL("../src/components/InstagramConnection.tsx", import.meta.url), "utf8");
  // set from the route's own sentence on a refusal, in the failure path ...
  assert.match(src, /const why = data\.error \?\? strings\.publishCenter\.browser\.signIn\.failed;[\s\S]*?setConnectError\(why\);/);
  // ... cleared at the start of the next Connect and of a Verify/Check, and passed to the card.
  assert.ok((src.match(/setConnectError\(null\)/g) ?? []).length >= 2);
  assert.match(src, /connectError=\{connectError\}/);
  // The success toast is only reachable after the route said ok.
  assert.match(src, /setNote\(data\.message \?\? c\.afterConnect\);\s*toast\.show\(strings\.publishCenter\.browser\.signIn\.opened, "ok"\);/);
});
