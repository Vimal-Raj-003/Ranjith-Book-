# puppeteer: `detached: true` silently cancels `windowsHide: true` on Windows

Upstream report for **puppeteer/puppeteer**, package `@puppeteer/browsers`.
Everything below was measured on this machine; the numbers are real runs, not
estimates.

| | |
|---|---|
| `@puppeteer/browsers` | 3.2.1 |
| `puppeteer-core` | 25.8.0 |
| Node | v22.22.0 |
| OS | Windows 11 Pro 10.0.22621, x64 |
| Browser | `chrome-headless-shell` 152.0.7977.30 |

## Symptom

Every headless browser `puppeteer.launch()` starts leaves a **visible black
console window** on the desktop. They steal focus while they appear, which on a
tool that renders video by fanning out to a dozen browsers means a dozen windows
thrown across whatever the user was doing.

"Headless" is about the browser painting no page. It was never a promise about a
console window — but `windowsHide: true` *is*, and it is being requested and
silently dropped.

## Cause

`packages/browsers/src/launch.ts` sets both options on the same spawn:

```js
opts.detached ??= true;                    // ~line 157
...
this.#browserProcess = childProcess.spawn(this.#executablePath, this.#args, {
  detached: opts.detached,
  windowsHide: true,                       // asked for, then dropped
  env,
  stdio,
});
```

libuv maps these onto two Win32 creation flags:

- `windowsHide: true` → `CREATE_NO_WINDOW`
- `detached: true` → `DETACHED_PROCESS`

Win32 documents `CREATE_NO_WINDOW` as **ignored when combined with
`DETACHED_PROCESS`**. So the suppression never takes effect. The browser starts
with no console to inherit, allocates its own, and that one is visible. No error,
no warning — the two options are individually valid and quietly incompatible.

`detached` is there for process-group isolation, so console signals do not
propagate to the browser. On Windows that costs the exact suppression the
neighbouring line is asking for.

## The patch

```diff
--- a/packages/browsers/src/launch.ts
+++ b/packages/browsers/src/launch.ts
@@
-        // `detached: true` makes child process a leader of a new process group,
-        // making it possible to isolate process trees and prevent console signal propagation.
-        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
-        opts.detached ??= true;
+        // `detached: true` makes child process a leader of a new process group,
+        // making it possible to isolate process trees and prevent console signal propagation.
+        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
+        //
+        // NOT on Windows, where it is actively harmful: libuv maps `detached`
+        // to DETACHED_PROCESS and `windowsHide` to CREATE_NO_WINDOW, and Win32
+        // ignores CREATE_NO_WINDOW when DETACHED_PROCESS is also set. Defaulting
+        // this to true there silently cancels the `windowsHide: true` set a few
+        // lines below, and every browser lands a visible console window on the
+        // user's desktop. An explicit `detached: true` from a caller is still
+        // honoured.
+        opts.detached ??= process.platform !== 'win32';
```

One line. It only changes a **default**, so a caller that explicitly passes
`detached: true` still gets it.

## Reproduction

`scripts/repro-puppeteer-windowshide.cjs` in this repository. Counts browsers
holding a visible top-level window (`MainWindowHandle != 0`) before and after a
single `puppeteer.launch()`:

```
$ node scripts/repro-puppeteer-windowshide.cjs

# stock @puppeteer/browsers 3.2.1
visible chrome-headless-shell windows BEFORE launch: 8
visible chrome-headless-shell windows AFTER  launch: 11
REPRODUCED: headless launch put 3 visible console window(s) on the desktop.

# with the patch above
visible chrome-headless-shell windows BEFORE launch: 0
visible chrome-headless-shell windows AFTER  launch: 0
NOT REPRODUCED: no visible window appeared.
```

And on a real multi-browser video render in this project, counting distinct
browser processes that acquired a window:

| build | shim | windows |
|---|---|---|
| stock | off | **16** |
| patched | off | **0** |
| stock | on (see below) | **0** |

Renders produced byte-comparable output in every arm — this changes where the
console goes, not what is rendered.

## What did NOT reproduce it

Worth recording so nobody re-treads it:

- `child_process.spawn` of `node`, `cmd.exe` or `powershell.exe` with
  `{detached: true, windowsHide: true}` — **no window**. Those never call
  `AllocConsole`, so having no console costs them nothing. The child has to be
  one that allocates a console when it finds itself without one; Chrome does.
- `@puppeteer/browsers`' own `launch()` called **directly** — **no window**,
  on both stock and patched. Only `puppeteer-core`'s `launch()` reproduces it.
  Whatever puppeteer-core adds on top (its default argument set and stdio
  wiring) is part of the trigger; the flag interaction alone is not sufficient.

That last point is the open question in this report. The patch is empirically
solid — it is the single variable between 16 windows and 0, at both the unit and
render level — but the full mechanism is not isolated to the two flags alone, and
a maintainer who knows puppeteer-core's launch path will see the missing piece
faster than more black-box bisection will find it.

## Local workaround, for anyone who lands here first

Patching a transitive dependency is not durable when the package is reached
through `npx`, which re-resolves whenever a new version publishes — this project
watched `hyperframes` move `0.8.12 → 0.8.17` mid-investigation, which would have
discarded a patched file at the worst possible moment.

`scripts/no-console-windows.cjs` here does it without touching any file on disk:
preloaded into the renderer via `NODE_OPTIONS --require`, it intercepts
`child_process.spawn` and clears `detached` for browser and ffmpeg binaries so
`windowsHide` can take effect. Version-independent, and a no-op once upstream
fixes the default.
