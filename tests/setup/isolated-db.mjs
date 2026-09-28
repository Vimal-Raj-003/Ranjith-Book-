/**
 * Preloaded into every test process (`--import`, which `node --test` passes on
 * to the process it starts for each test file). Gives that process its own
 * copy of the empty template database built by `scripts/test-db.mjs`, and
 * points `DATABASE_URL` at it before `src/lib/db.ts` is ever evaluated.
 *
 * One database per test file means test files can still run in parallel —
 * they simply never share a SQLite write lock, and never touch `dev.db`.
 * Tests inside one file run one after another, as they always have.
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), ".bookreel", "test");
const template = path.join(dir, "template.db");

// Keyed by pid, not a plain flag: the `node --test` runner process preloads
// this too, and its environment is inherited by every test process it starts.
// A flag would make them all skip and share the runner's copy.
if (process.env.BOOKREEL_TEST_DB_PID !== String(process.pid)) {
  if (!fs.existsSync(template)) {
    throw new Error("No test database template. Run the suite with `npm test`, which builds it first.");
  }
  const copy = path.join(dir, `run-${process.pid}.db`);
  fs.copyFileSync(template, copy);
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, "/")}`;

  // Its own working directory too, for the same reason: several test files
  // create and clean up uploads at once, and a test asserting "this failed
  // upload left nothing behind" was reading a directory another file had
  // legitimately just created. Only work PRODUCTS move — the downloaded
  // caches stay shared (see CACHE_ROOT in src/lib/paths.ts), so nothing is
  // re-downloaded and the alignment environment is still found.
  const work = path.join(dir, `work-${process.pid}`);
  fs.mkdirSync(work, { recursive: true });
  process.env.BOOKREEL_WORK_ROOT = work;

  process.env.BOOKREEL_TEST_DB_PID = String(process.pid);

  process.on("exit", () => {
    for (const f of [copy, `${copy}-journal`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* Windows may still hold it; scripts/test-db.mjs clears it next run */
      }
    }
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* same */
    }
  });
}
