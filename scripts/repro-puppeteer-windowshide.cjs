#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports --
 * CommonJS on purpose. This file is meant to be runnable standalone against an
 * arbitrary project's node_modules (an npx cache, a puppeteer checkout), which
 * needs `require`/`createRequire` to resolve from a directory it does not live
 * in. It is a reproduction to hand upstream, not application code.
 */
/**
 * Minimal reproduction — Windows only.
 *
 * `puppeteer.launch()` leaves a visible black console window on the desktop for
 * every browser it starts, even though it asks for `windowsHide: true`.
 *
 *   node scripts/repro-puppeteer-windowshide.cjs [path-to-chrome-headless-shell]
 *
 * WHY IT HAPPENS
 *
 * `@puppeteer/browsers` spawns the browser with both options set:
 *
 *   packages/browsers/src/launch.ts
 *     opts.detached ??= true;                       // <- the default
 *     ...
 *     childProcess.spawn(executablePath, args, {
 *       detached: opts.detached,
 *       windowsHide: true,
 *       ...
 *     });
 *
 * libuv maps `windowsHide` to CREATE_NO_WINDOW and `detached` to
 * DETACHED_PROCESS. Win32 documents CREATE_NO_WINDOW as ignored when it is
 * combined with DETACHED_PROCESS, so the window suppression is silently
 * dropped: the browser starts with no console to inherit, allocates its own,
 * and that one is visible. No error, no warning — the option is simply not
 * honoured.
 *
 * `detached` is set for process-group isolation so console signals do not
 * propagate to the browser. On Windows it costs the very suppression the
 * neighbouring line is asking for.
 *
 * THE FIX (one line, packages/browsers/src/launch.ts):
 *
 *   - opts.detached ??= true;
 *   + opts.detached ??= process.platform !== 'win32';
 *
 * MEASURED, in this repository, on a real multi-browser render:
 *
 *   stock       16 visible chrome-headless-shell windows
 *   patched      0
 *
 * NOTE ON SCOPE: `@puppeteer/browsers`' own `launch()` called directly does NOT
 * reproduce this — only `puppeteer-core`'s `launch()` does, which is why this
 * script drives the latter. Whatever puppeteer-core adds on top (its default
 * argument set and stdio wiring) is part of the trigger; the flag interaction
 * alone is not sufficient. Worth knowing before trying to reduce this further.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

if (process.platform !== "win32") {
  console.log(`Windows-only reproduction (running on ${process.platform}).`);
  process.exit(0);
}

/** Browsers with a visible top-level window — the black boxes on the desktop. */
function visibleShells() {
  const ps =
    "@(Get-Process chrome-headless-shell -ErrorAction SilentlyContinue |" +
    " Where-Object { $_.MainWindowHandle -ne 0 }).Count";
  try {
    return Number(
      execFileSync("powershell", ["-NoProfile", "-Command", ps], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
    );
  } catch {
    return -1;
  }
}

function findChrome() {
  if (process.argv[2]) return process.argv[2];
  const roots = [
    path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell"),
    path.join(os.homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const build of fs.readdirSync(root)) {
      const exe = path.join(root, build, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    console.log("No chrome-headless-shell found. Install one, or pass its path as an argument:");
    console.log("  npx @puppeteer/browsers install chrome-headless-shell@stable");
    process.exit(2);
  }

  // Resolve from the CURRENT DIRECTORY as well as from this file: the script is
  // often run against a project it does not live inside (an npx cache, say),
  // and require() alone only ever looks beside the script.
  let puppeteer;
  for (const from of [__filename, path.join(process.cwd(), "index.js")]) {
    try {
      puppeteer = require(require("node:module").createRequire(from).resolve("puppeteer-core"));
      break;
    } catch {
      /* try the next resolution root */
    }
  }
  if (!puppeteer) {
    console.log("puppeteer-core is not resolvable from this file or from the current directory.");
    console.log("Run this from inside a project that depends on it.");
    process.exit(2);
  }

  console.log(`chrome : ${chrome}`);
  console.log(`node   : ${process.version}\n`);

  const before = visibleShells();
  console.log(`visible chrome-headless-shell windows BEFORE launch: ${before}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome,
    args: ["--no-sandbox"],
  });
  await sleep(2500);

  const after = visibleShells();
  console.log(`visible chrome-headless-shell windows AFTER  launch: ${after}`);
  await browser.close();

  const leaked = after - before;
  console.log("");
  if (leaked > 0) {
    console.log(`REPRODUCED: headless launch put ${leaked} visible console window(s) on the desktop.`);
    console.log("Expected 0 — the launch asks for windowsHide: true.");
    process.exit(1);
  }
  console.log("NOT REPRODUCED: no visible window appeared (already patched, or fixed upstream).");
})();
