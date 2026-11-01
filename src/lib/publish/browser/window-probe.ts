/**
 * SERVER-ONLY. Is the sign-in window actually ON THE PERSON'S SCREEN?
 *
 * WHY IT EXISTS. `child_process.spawn` reports success the moment the operating
 * system has created the process. It says nothing about whether a window appeared
 * where the person can see it, and on Windows there are two ordinary ways it does
 * not:
 *
 *  - THE WRONG DESKTOP. A Windows session can hold several desktops, and only one
 *    (`Default`) is on the screen. A program starts on the desktop of the process
 *    that started it, so a BookReel server that was itself started from a sandbox
 *    (a coding assistant's command runner puts its children on a private desktop
 *    such as `exebox-...`) opens Chrome on THAT desktop: the window exists, is
 *    "visible", and the person can never see it. Every later press of Connect is
 *    handed to that same invisible Chrome (a profile has one Chrome), so it stays
 *    invisible.
 *  - NO WINDOW. A Chrome that hands its command line to an instance that already
 *    holds the profile, or that closes straight away, also leaves nothing on screen.
 *
 * In both, the old code said "a window is opening". This module is how it stops
 * saying that when it is not true.
 *
 * WHAT IT DOES NOT DO. It only LOOKS. It starts no browser, closes nothing, sends
 * no keystroke or window message, and never opens, switches to or targets another
 * desktop: it asks which desktop THIS process is on, and which visible browser
 * windows are on that same desktop. So it cannot move a window, and it does not
 * route around a sandbox -- when the server is on a hidden desktop the answer is a
 * sentence telling the person to start it from their own terminal.
 *
 * It is a short PowerShell script (the only way to ask Windows these questions
 * from Node without a native add-on). The profile path reaches it in an environment
 * variable and is never spliced into the script text, so no path can become code.
 * Off Windows there is no such thing as a hidden desktop and nothing here runs.
 */
import { execFile } from "node:child_process";

export type WindowSighting =
  /** A visible browser window of the dedicated profile is on this desktop. */
  | { state: "window"; title: string }
  /** None appeared. `holders` are browser processes that already hold the profile (and so swallowed the launch). */
  | { state: "none"; holders: number[] }
  /** The question could not be asked (no PowerShell, a timeout, odd output). Never read as "no window". */
  | { state: "unknown" };

export interface WindowProbe {
  /** The name of the desktop this process, and so anything it starts, lives on; null when that cannot be told. */
  desktop(): Promise<string | null>;
  /** Wait up to `ms` for a visible browser window whose process holds `profileDir`. */
  waitForWindow(profileDir: string, ms: number): Promise<WindowSighting>;
}

/** The desktop a person is looking at. Others in the session (a sandbox's, the lock screen's) are not on the screen. */
export function isInteractiveDesktop(name: string): boolean {
  return name.trim().toLowerCase() === "default";
}

const MODE_ENV = "BOOKREEL_PROBE_MODE";
const PROFILE_ENV = "BOOKREEL_PROBE_PROFILE";
const WAIT_ENV = "BOOKREEL_PROBE_WAIT_MS";

/**
 * The whole script. Read-only by construction: it calls GetThreadDesktop and
 * GetUserObjectInformation (a name), EnumWindows (a list) and Get-CimInstance (a
 * list of processes). `tests/signin-window.test.mts` pins that it contains nothing
 * that closes, starts, posts to or switches to anything.
 */
export const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class BookReelWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder buf, int len, out int needed);

  public static string Desktop() {
    IntPtr d = GetThreadDesktop(GetCurrentThreadId());
    if (d == IntPtr.Zero) return "";
    var sb = new StringBuilder(256); int need;
    return GetUserObjectInformation(d, 2, sb, 512, out need) ? sb.ToString() : "";
  }

  // "pid<TAB>title" for each visible top-level Chrome/Edge window on THIS desktop.
  public static List<string> BrowserWindows() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      res.Add(pid + "\t" + t);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

if ($env:${MODE_ENV} -eq 'desktop') {
  Write-Output ('desktop|' + [BookReelWin]::Desktop())
  exit 0
}

$profileDir = $env:${PROFILE_ENV}
$deadline = [DateTime]::UtcNow.AddMilliseconds([int]$env:${WAIT_ENV})
$holders = @()
do {
  $holders = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -notlike '*--type=*') -and ($_.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |
    ForEach-Object { [int]$_.ProcessId })
  if ($holders.Count -gt 0) {
    foreach ($w in [BookReelWin]::BrowserWindows()) {
      $parts = $w.Split([char[]]@([char]9), 2)
      if ($holders -contains [int]$parts[0]) {
        Write-Output ('window|' + $parts[0] + '|' + $parts[1])
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 400
} while ([DateTime]::UtcNow -lt $deadline)
Write-Output ('none|' + ($holders -join ','))
`;

/** `desktop|<name>` -> the name; anything else, or an empty name, is "cannot tell". */
export function parseDesktop(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("desktop|"));
  const name = line ? line.slice("desktop|".length).trim() : "";
  return name ? name : null;
}

/** `window|<pid>|<title>`, `none|<pid,pid>`, or nothing usable (-> unknown, never "none"). */
export function parseSighting(stdout: string): WindowSighting {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("window|")) {
      // The title may itself contain "|": only the first two separators are ours.
      const title = line.split("|").slice(2).join("|");
      return { state: "window", title };
    }
    if (line.startsWith("none|")) {
      const holders = line
        .slice("none|".length)
        .split(",")
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      return { state: "none", holders };
    }
  }
  return { state: "unknown" };
}

/** Run the script; its stdout, or null when it could not run at all (no PowerShell, killed, non-zero exit). */
function runScript(env: Record<string, string>, timeoutMs: number): Promise<string | null> {
  const encoded = Buffer.from(PROBE_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 16, env: { ...process.env, ...env } },
        (err, stdout) => resolve(err ? null : String(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Compiling the helper takes a moment; this is on top of however long the caller waits for a window. */
const STARTUP_ALLOWANCE_MS = 20_000;

/** The real probe. Windows only: elsewhere there is no hidden desktop and nothing to ask. */
export const windowsProbe: WindowProbe = {
  async desktop() {
    if (process.platform !== "win32") return null;
    const out = await runScript({ [MODE_ENV]: "desktop" }, STARTUP_ALLOWANCE_MS);
    return out === null ? null : parseDesktop(out);
  },
  async waitForWindow(profileDir, ms) {
    if (process.platform !== "win32") return { state: "unknown" };
    const out = await runScript({ [MODE_ENV]: "window", [PROFILE_ENV]: profileDir, [WAIT_ENV]: String(ms) }, ms + STARTUP_ALLOWANCE_MS);
    return out === null ? { state: "unknown" } : parseSighting(out);
  },
};
