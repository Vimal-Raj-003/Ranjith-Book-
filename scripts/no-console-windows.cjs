"use strict";
/**
 * Keeps the renderer's child processes off the operator's desktop on Windows.
 *
 * Preloaded (via NODE_OPTIONS --require) into the `hyperframes` process that
 * `src/lib/video/render.ts` spawns, and inherited by every node descendant of
 * it. Does nothing on macOS or Linux.
 *
 * THE BUG THIS WORKS AROUND
 *
 * A render fans out to several `chrome-headless-shell` browsers. Puppeteer
 * spawns each one with BOTH `windowsHide: true` and — from
 * `@puppeteer/browsers`' own default, `opts.detached ??= true` — `detached:
 * true`. Those two options are incompatible on Windows: libuv turns them into
 * CREATE_NO_WINDOW and DETACHED_PROCESS respectively, and CREATE_NO_WINDOW is
 * documented as ignored when combined with DETACHED_PROCESS. The window
 * suppression is silently dropped, every browser allocates its own console,
 * and a dozen black windows land on the desktop mid-render, stealing focus.
 *
 * Puppeteer wants `detached` for process-group isolation so console signals do
 * not propagate. Here the browser is a short-lived child of a render we are
 * already supervising and killing by handle, so trading that isolation for a
 * desktop nobody has to fight is the right way round.
 *
 * WHY A SHIM RATHER THAN A PATCH
 *
 * The offending line is in a transitive dependency of a package we invoke
 * through `npx`, which re-resolves whenever a new version publishes — a patched
 * file on disk would be silently discarded at the worst possible moment.
 * Intercepting the call is version-independent: if upstream fixes the default,
 * this becomes a no-op rather than a conflict.
 */

if (process.platform === "win32") {
  // `require`, not `import`: NODE_OPTIONS --require only accepts CommonJS, and
  // the ESM equivalent could not do this job anyway — Node snapshots a
  // builtin's named exports at first import, so a reassignment here would not
  // be seen by the already-bundled CommonJS caller we are trying to intercept.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const childProcess = require("node:child_process");

  // Only the binaries that actually paint a console window during a render.
  // Deliberately NOT everything: hyperframes detaches genuine background
  // helpers (a telemetry flush, a preview server) that are supposed to outlive
  // their parent, and clearing `detached` on those would change what they do.
  const TARGETS = new Set(["chrome", "chrome-headless-shell", "chromium", "ffmpeg", "ffprobe"]);

  function targeted(command) {
    if (typeof command !== "string") return false;
    const leaf = (command.replace(/["']/g, "").split(/[\\/]/).pop() || "").toLowerCase();
    return TARGETS.has(leaf.replace(/\.exe$/, ""));
  }

  function hide(original) {
    return function (command, args, options) {
      if (!targeted(command)) return original.apply(this, arguments);

      // spawn(command, options) is as legal as spawn(command, args, options),
      // and either may omit options entirely — normalise before touching it,
      // and copy rather than mutate the caller's object.
      let argv = args;
      let opts;
      if (Array.isArray(argv)) {
        opts = options && typeof options === "object" ? { ...options } : {};
      } else {
        opts = argv && typeof argv === "object" ? { ...argv } : {};
        argv = undefined;
      }

      opts.windowsHide = true;
      // The whole point: CREATE_NO_WINDOW above is ignored while this is set.
      if (opts.detached) opts.detached = false;

      return argv === undefined
        ? original.call(this, command, opts)
        : original.call(this, command, argv, opts);
    };
  }

  childProcess.spawn = hide(childProcess.spawn);
  childProcess.spawnSync = hide(childProcess.spawnSync);
}
