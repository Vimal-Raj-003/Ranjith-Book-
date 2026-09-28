#!/usr/bin/env node
/**
 * Builds the empty template database the test suite copies from — run once
 * per `npm test`, before any test file starts.
 *
 * Tests used to share `prisma/dev.db`: the operator's own database. That had
 * two costs. Test runs wrote into (and deleted from) real data, and the test
 * files — which `node --test` runs in parallel, one process each — all
 * contended for one SQLite write lock, so a slow moment surfaced as a Prisma
 * "Socket timeout" in whichever test happened to be waiting.
 *
 * Now `prisma db push` writes the current schema into a fresh file under
 * `.bookreel/test/`, and `tests/setup/isolated-db.mjs` gives every test
 * process its own copy of it. Nothing a test does can reach `dev.db`, and no
 * two test files ever share a database.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), ".bookreel", "test");
const template = path.join(dir, "template.db");

// Copies left by an interrupted earlier run (a killed process never reaches
// its own cleanup) are cleared here, best-effort.
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) {
  try {
    fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* still held open by a live process; the next run clears it */
  }
}

const prismaCli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
try {
  // No --force-reset: the directory was just emptied, so this creates a new
  // file rather than resetting one — nothing exists to lose.
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: `file:${template.replace(/\\/g, "/")}` },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
} catch (err) {
  console.error(`Could not build the test database: ${err.stderr?.toString() || err.message}`);
  process.exit(1);
}
console.log(`test database template ready (${path.relative(process.cwd(), template)})`);
