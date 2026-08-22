import fs from "node:fs";
import path from "node:path";

/**
 * How to spawn `npx` as a child process.
 *
 * Node 18.20 / 20.12 stopped resolving `.cmd` shims for spawn and execFile
 * unless `shell: true` is passed, and on Windows npm installs npx only as
 * `npx.cmd` — so spawning "npx" there fails with ENOENT. Running npm's own
 * `npx-cli.js` under the current node binary sidesteps both the shim and the
 * shell quoting that `shell: true` would drag in around asset paths.
 *
 * Everywhere else "npx" is already a real executable, so nothing changes.
 */
export function npxCommand(args: string[]): [string, string[]] {
  if (process.platform !== "win32") return ["npx", args];

  const cli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npx-cli.js",
  );
  return fs.existsSync(cli) ? [process.execPath, [cli, ...args]] : ["npx.cmd", args];
}
