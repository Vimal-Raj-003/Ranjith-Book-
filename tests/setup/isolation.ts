/**
 * The guard that keeps a bare `tsx --test <file>` from writing into the
 * operator's live install.
 *
 * `npm test` preloads `tests/setup/isolated-db.mjs`, which gives each test
 * process its own copy of the template database and its own work root. A bare
 * `npx tsx --test tests/thumbnails.test.mts` does NOT: `DATABASE_URL` is
 * `dev.db` and `WORK_ROOT` is `.bookreel/`, so a test that creates rows creates
 * them in the operator's real library and a test that writes a fixture poster
 * writes it beside their real ones.
 *
 * Both of those have already happened during one workstream. A bare run poisoned
 * `.bookreel/voice-preview/` with eleven files the browser could not play (a
 * preview cache never re-synthesises a hit, so they stayed), and another wrote a
 * fixture into the live `.bookreel/thumbs`. Neither failed; both looked fine.
 *
 * So the rule is: a test file that can write under the work root, or that writes
 * to the database, asserts isolation first and FAILS CLOSED.
 *
 * What it checks is where THIS process's environment actually points -- the
 * preload names the copies it made after the pid (`run-<pid>.db`,
 * `work-<pid>`) -- rather than whether some variable is set. A stale or
 * inherited `BOOKREEL_TEST_DB_PID`, `BOOKREEL_WORK_ROOT` or `DATABASE_URL` from
 * a parent process therefore cannot satisfy it. That matters: the `node --test`
 * runner preloads this same module, and every test process inherits its
 * environment, so a plain boolean flag would have been true everywhere.
 *
 * This module is NOT a test file (`npm test` collects `tests/*.test.mts`), and
 * it is deliberately one copy rather than one per test file: four hand-rolled
 * copies of a safety check is how the check ends up subtly different in the
 * file that needed it. `tests/voice-preview.test.mts` owns the self-test that
 * proves each branch of it throws.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { WORK_ROOT } from "../../src/lib/paths";

const normal = (p: string) => p.replace(/\\/g, "/");

const DEFAULT_WHAT = "these tests write under the work root";
const DEFAULT_WHAT_DB = "these tests write to the database";

const hintFor = (what: string) =>
  `${what}: run them through \`npm test\`, which gives each test process its own`;

/** Throws unless `seen` describes the isolated environment the preload builds for process `pid`. */
export function assertIsolatedWorkRoot(
  seen: { dbPid: string | undefined; workRoot: string },
  pid: number = process.pid,
  cwd: string = process.cwd(),
  what: string = DEFAULT_WHAT,
): void {
  const hint = hintFor(what);
  assert.equal(seen.dbPid, String(pid), `no isolated environment for this process: ${hint}`);
  const own = path.join(cwd, ".bookreel", "test", `work-${pid}`);
  assert.equal(
    normal(seen.workRoot),
    normal(own),
    `the work root is not this process's own (${seen.workRoot}): ${hint}`,
  );
}

/**
 * The same, for the database.
 *
 * Separate from the work root because the hazard is separate: `poster-edit`
 * creates Book, Upload and Episode rows and never touches a file the operator
 * would notice, so a bare run leaves real rows in their real library and says
 * nothing.
 */
export function assertIsolatedDatabase(
  seen: { dbPid: string | undefined; databaseUrl: string | undefined },
  pid: number = process.pid,
  cwd: string = process.cwd(),
  what: string = DEFAULT_WHAT_DB,
): void {
  const hint = hintFor(what);
  assert.equal(seen.dbPid, String(pid), `no isolated environment for this process: ${hint}`);
  const own = `file:${normal(path.join(cwd, ".bookreel", "test", `run-${pid}.db`))}`;
  assert.equal(
    normal(seen.databaseUrl ?? ""),
    own,
    `the database is not this process's own copy (${seen.databaseUrl ?? "unset"}): ${hint}`,
  );
}

/** The work-root guard, pointed at the real environment. Call before anything that can touch `WORK_ROOT`. */
export function requireIsolatedWorkRoot(what: string = DEFAULT_WHAT): void {
  assertIsolatedWorkRoot({ dbPid: process.env.BOOKREEL_TEST_DB_PID, workRoot: WORK_ROOT }, process.pid, process.cwd(), what);
}

/** The database guard, pointed at the real environment. Call before the first write. */
export function requireIsolatedDatabase(what: string = DEFAULT_WHAT_DB): void {
  assertIsolatedDatabase(
    { dbPid: process.env.BOOKREEL_TEST_DB_PID, databaseUrl: process.env.DATABASE_URL },
    process.pid,
    process.cwd(),
    what,
  );
}

/** Both, for a file that writes rows AND files. */
export function requireIsolation(what: string): void {
  requireIsolatedDatabase(what);
  requireIsolatedWorkRoot(what);
}
