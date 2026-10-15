import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as elapsedModule from "../src/components/AnalysisElapsed";
import { formatElapsed, analysisElapsedMs, shouldTick, isTerminalStatus } from "../src/components/AnalysisElapsed";
import { analysisView } from "../src/lib/analysis/view";
import { prisma } from "../src/lib/db";
import { requireIsolatedDatabase } from "./setup/isolation";

/**
 * The elapsed clock on the Book-PDF analysis panel.
 *
 * The clock is derived from the Upload row's own timestamps (`startedAt`, else
 * `createdAt`, is the start; `updatedAt`, last written by the terminal status, is
 * the finish), so the arithmetic is pure and tested here without a browser. What a browser is
 * needed for -- that it ticks once a second while running, that a terminal run
 * has no interval at all, and that a refresh does not reset it -- was verified
 * in the browser pass, not here: no DOM is installed in this runner.
 *
 * The API-shape tests write Book and Upload rows, so they fail closed
 * unless `npm test` has given this process its own database.
 */
const COMPONENTS = fileURLToPath(new URL("../src/components/", import.meta.url));

const T0 = Date.parse("2026-10-04T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

test("the clock always reads HH:MM:SS, hours zero-padded, from the first second to the last", () => {
  assert.equal(formatElapsed(0), "00:00:00");
  assert.equal(formatElapsed(999), "00:00:00", "sub-second rounds down: a clock never runs ahead");
  assert.equal(formatElapsed(1000), "00:00:01");
  assert.equal(formatElapsed(59_999), "00:00:59");
  assert.equal(formatElapsed(60_000), "00:01:00", "the minute boundary");
  assert.equal(formatElapsed(84_000), "00:01:24", "the spec's example: Total elapsed 00:01:24");
  assert.equal(formatElapsed(3_599_999), "00:59:59", "one millisecond under the hour keeps its zero hours");
  assert.equal(formatElapsed(3_600_000), "01:00:00", "the hour boundary");
  assert.equal(formatElapsed(3_600_000 + 84_000), "01:01:24");
  assert.equal(formatElapsed(10 * 3_600_000 + 5_000), "10:00:05");
  for (const ms of [0, 1000, 84_000, 3_599_999, 3_600_000, 10 * 3_600_000 + 5_000]) {
    assert.match(formatElapsed(ms), /^\d{2}:\d{2}:\d{2}$/, `${ms} ms has the one shape`);
  }
});

test("the formatter never shows a negative or NaN reading", () => {
  assert.equal(formatElapsed(-1), "00:00:00");
  assert.equal(formatElapsed(-86_400_000), "00:00:00");
  assert.equal(formatElapsed(Number.NaN), "00:00:00");
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), "00:00:00");
});

test("while running, elapsed is now minus createdAt, and moves with now", () => {
  const base = { status: "RUNNING", createdAt: iso(0), updatedAt: iso(5_000) };
  assert.equal(analysisElapsedMs({ ...base, now: T0 + 84_000 }), 84_000);
  assert.equal(analysisElapsedMs({ ...base, now: T0 + 85_000 }), 85_000, "one tick later, one second more");
  // updatedAt is bumped on every step and progress write; it must not be what a running clock counts to.
  assert.equal(analysisElapsedMs({ ...base, now: T0 + 600_000 }), 600_000);
  for (const status of ["QUEUED", "RUNNING"]) {
    assert.equal(analysisElapsedMs({ ...base, status, now: T0 + 1_000 }), 1_000, `${status} is a live status`);
  }
});

test("a step change does not reset the clock: elapsed is keyed to createdAt, not step", () => {
  // The same row seen at the start of three different steps, with updatedAt
  // advancing each time. Only `now` and `createdAt` matter.
  const at = (offset: number, updatedOffset: number) =>
    analysisElapsedMs({ status: "RUNNING", createdAt: iso(0), updatedAt: iso(updatedOffset), now: T0 + offset });
  assert.equal(at(10_000, 1_000), 10_000);
  assert.equal(at(70_000, 65_000), 70_000, "ten seconds after a step began, the clock did not restart");
  assert.equal(at(190_000, 185_000), 190_000);
});

test("once DONE, FAILED or CANCELLED, elapsed is updatedAt minus createdAt and no longer depends on now", () => {
  for (const status of ["DONE", "FAILED", "CANCELLED"]) {
    const row = { status, createdAt: iso(0), updatedAt: iso(252_000) };
    assert.equal(analysisElapsedMs({ ...row, now: T0 + 252_000 }), 252_000, `${status}: the final duration`);
    assert.equal(analysisElapsedMs({ ...row, now: T0 + 9_999_999 }), 252_000, `${status}: frozen, however late it is read`);
    assert.equal(analysisElapsedMs({ ...row, now: T0 }), 252_000, `${status}: or however early`);
    assert.equal(isTerminalStatus(status), true);
  }
  assert.equal(isTerminalStatus("RUNNING"), false);
  assert.equal(isTerminalStatus("QUEUED"), false);
  assert.equal(isTerminalStatus(undefined), false);
});

test("a run that flips from RUNNING to terminal between polls lands on the recorded duration", () => {
  const running = { status: "RUNNING", createdAt: iso(0), updatedAt: iso(240_000) };
  // The last tick before the next poll reads past the real finish...
  assert.equal(analysisElapsedMs({ ...running, now: T0 + 253_000 }), 253_000);
  // ...and the poll that reports DONE replaces it with the server's own number.
  assert.equal(analysisElapsedMs({ ...running, status: "DONE", updatedAt: iso(252_000), now: T0 + 253_000 }), 252_000);
});

test("clock skew is clamped to zero, never shown negative", () => {
  // Terminal, with updatedAt before createdAt.
  assert.equal(analysisElapsedMs({ status: "DONE", createdAt: iso(10_000), updatedAt: iso(0), now: T0 }), 0);
  assert.equal(formatElapsed(analysisElapsedMs({ status: "FAILED", createdAt: iso(10_000), updatedAt: iso(0), now: T0 })!), "00:00:00");
  // Running, with this browser's clock behind the server's.
  assert.equal(analysisElapsedMs({ status: "RUNNING", createdAt: iso(10_000), updatedAt: iso(10_000), now: T0 }), 0);
});

test("a missing or unparseable createdAt shows nothing at all", () => {
  for (const createdAt of [undefined, null, "", "not a date", "NaN"]) {
    for (const status of ["RUNNING", "DONE"]) {
      assert.equal(
        analysisElapsedMs({ status, createdAt, updatedAt: iso(5_000), now: T0 }),
        null,
        `${status} with createdAt ${JSON.stringify(createdAt)}`,
      );
    }
    assert.equal(shouldTick("RUNNING", createdAt), false, "and it does not start an interval for a clock it cannot draw");
  }
  // A finished run whose finish is unknown has nothing true to say either; it must not fall back to ticking.
  assert.equal(analysisElapsedMs({ status: "DONE", createdAt: iso(0), updatedAt: null, now: T0 + 1_000 }), null);
  assert.equal(analysisElapsedMs({ status: "FAILED", createdAt: iso(0), updatedAt: "garbage", now: T0 + 1_000 }), null);
});

test("only a running upload with a start gets a tick", () => {
  assert.equal(shouldTick("RUNNING", iso(0)), true);
  assert.equal(shouldTick("QUEUED", iso(0)), true);
  for (const status of ["DONE", "FAILED", "CANCELLED"]) {
    assert.equal(shouldTick(status, iso(0)), false, `${status} has no interval: it is a fixed number`);
  }
});

test("the clock counts from startedAt when there is one, so a retry is not charged for the time since upload", () => {
  // Uploaded at T0; this run (a retry) was started 17 minutes later and ran for 6 seconds.
  const retry = { createdAt: iso(0), startedAt: iso(1_020_000), updatedAt: iso(1_026_000) };
  assert.equal(analysisElapsedMs({ ...retry, status: "FAILED", now: T0 + 9_999_999 }), 6_000, "terminal: updatedAt - startedAt");
  assert.equal(formatElapsed(6_000), "00:00:06", "not 00:17:06");
  // Still running 40 s into the retry.
  assert.equal(analysisElapsedMs({ ...retry, status: "RUNNING", now: T0 + 1_020_000 + 40_000 }), 40_000, "running: now - startedAt");
  assert.equal(analysisElapsedMs({ ...retry, status: "QUEUED", now: T0 + 1_020_000 }), 0, "the moment it starts it reads zero");
  // The upload's own age is not an input once startedAt is known.
  assert.equal(
    analysisElapsedMs({ ...retry, createdAt: iso(-86_400_000), status: "FAILED", now: T0 }),
    6_000,
    "moving createdAt changes nothing",
  );
});

test("a null or missing startedAt falls back to createdAt: legacy rows and an older server keep working", () => {
  for (const startedAt of [null, undefined, "", "not a date"]) {
    assert.equal(
      analysisElapsedMs({ status: "DONE", createdAt: iso(0), startedAt, updatedAt: iso(84_000), now: T0 }),
      84_000,
      `terminal, startedAt ${JSON.stringify(startedAt)}`,
    );
    assert.equal(
      analysisElapsedMs({ status: "RUNNING", createdAt: iso(0), startedAt, updatedAt: iso(0), now: T0 + 84_000 }),
      84_000,
      `running, startedAt ${JSON.stringify(startedAt)}`,
    );
    assert.equal(shouldTick("RUNNING", iso(0), startedAt), true, "and it still ticks");
  }
  // The pre-column call shape, with no startedAt argument at all, is unchanged.
  assert.equal(analysisElapsedMs({ status: "DONE", createdAt: iso(0), updatedAt: iso(84_000), now: T0 }), 84_000);
  assert.equal(shouldTick("RUNNING", iso(0)), true);
});

test("a recorded startedAt is enough to draw the clock, and a missing start of both kinds still draws nothing", () => {
  assert.equal(analysisElapsedMs({ status: "RUNNING", createdAt: null, startedAt: iso(0), updatedAt: null, now: T0 + 5_000 }), 5_000);
  assert.equal(shouldTick("RUNNING", null, iso(0)), true);
  assert.equal(analysisElapsedMs({ status: "RUNNING", createdAt: null, startedAt: null, updatedAt: iso(0), now: T0 }), null);
  assert.equal(shouldTick("RUNNING", null, null), false);
  // Skew still clamps with startedAt: a start after the finish is zero, not negative.
  assert.equal(analysisElapsedMs({ status: "FAILED", createdAt: iso(0), startedAt: iso(60_000), updatedAt: iso(0), now: T0 }), 0);
});

// The component under test is a CJS/ESM default-export wrapper when loaded through tsx.
const AnalysisElapsed = ((elapsedModule as { default: unknown }).default as { default?: unknown }).default ??
  (elapsedModule as { default: unknown }).default;

function render(
  props: { status: string; createdAt: string | null; startedAt?: string | null; updatedAt: string | null },
  now?: number,
): string {
  const realNow = Date.now;
  if (now != null) Date.now = () => now;
  try {
    return renderToStaticMarkup(React.createElement(AnalysisElapsed as React.ComponentType<typeof props>, props));
  } finally {
    Date.now = realNow;
  }
}

test("the component draws the label and the reading, frozen for a terminal run and live for a running one", () => {
  const done = render({ status: "DONE", createdAt: iso(0), updatedAt: iso(84_000) }, T0 + 99_000_000);
  assert.match(done, /role="timer"/);
  assert.match(done, />Total elapsed</);
  assert.match(done, />00:01:24</, "DONE shows updatedAt - createdAt, not the time since");
  // The label and the reading are two boxes in a flex row; as TEXT (what a reader
  // of the DOM gets) they must still be separated: "Total elapsed 00:01:24", not "Total elapsed00:01:24".
  assert.equal(done.replace(/<[^>]+>/g, ""), "Total elapsed 00:01:24");

  const failed = render({ status: "FAILED", createdAt: iso(0), updatedAt: iso(3_600_000 + 84_000) }, T0);
  assert.match(failed, />01:01:24</, "an hour or more reads HH:MM:SS");

  const running = render({ status: "RUNNING", createdAt: iso(0), updatedAt: iso(1_000) }, T0 + 84_000);
  assert.match(running, />00:01:24</, "RUNNING shows now - createdAt");

  const retried = render({ status: "FAILED", createdAt: iso(0), startedAt: iso(1_020_000), updatedAt: iso(1_026_000) }, T0);
  assert.equal(retried.replace(/<[^>]+>/g, ""), "Total elapsed 00:00:06", "a retry shows its own run, not the time since the upload");
  assert.equal(
    render({ status: "RUNNING", createdAt: iso(0), startedAt: null, updatedAt: iso(0) }, T0 + 84_000).replace(/<[^>]+>/g, ""),
    "Total elapsed 00:01:24",
    "a null startedAt counts from createdAt",
  );

  const nothing = render({ status: "RUNNING", createdAt: null, updatedAt: null }, T0);
  assert.equal(nothing, "", "no createdAt renders nothing: no 00:00 and no NaN");
  assert.equal(render({ status: "DONE", createdAt: "garbage", updatedAt: iso(0) }), "");
});

test("the analysis panel mounts the clock in its header, and the DONE title row keeps the final time", async () => {
  const src = await fs.readFile(path.join(COMPONENTS, "BookAnalysis.tsx"), "utf8");
  // The header slot is the Panel's `actions`, which `.panel-head` lays out at the right-hand end.
  const panel = src.match(/<Panel\s[^>]*?title=\{strings\.books\.runHeading\}[\s\S]*?>\s*\n\s*<div aria-live/);
  assert.ok(panel, "the run panel is still the 'Analysing the book' panel");
  assert.match(
    panel[0],
    /actions=\{\s*<AnalysisElapsed\s+status=\{view\.status\}\s+createdAt=\{view\.createdAt\}\s+startedAt=\{view\.startedAt\}\s+updatedAt=\{view\.updatedAt\}\s*\/>\s*\}/,
  );
  assert.match(
    src,
    /\{!live && \(\s*<AnalysisElapsed[\s\S]*?startedAt=\{view\.startedAt\}/,
    "the panel is not drawn once DONE, so the final duration is shown beside the title, from the same three timestamps",
  );
  // One timer, off the poll's timestamps -- no second source of truth in this file.
  assert.doesNotMatch(src, /setInterval/, "BookAnalysis owns no interval: the clock's lives in AnalysisElapsed");
  // A Retry restarts the clock at once rather than showing the failed run's number until the next poll.
  assert.match(src, /status: "QUEUED", error: null, startedAt: new Date\(\)\.toISOString\(\)/);
});

test("the clock is one interval, cleaned up, and derived from server timestamps rather than an independent count", async () => {
  const src = await fs.readFile(path.join(COMPONENTS, "AnalysisElapsed.tsx"), "utf8");
  assert.equal((src.match(/setInterval\(/g) ?? []).length, 1, "exactly one interval");
  assert.match(src, /return \(\) => \{[^}]*clearInterval\(id\);/, "cleared on unmount and when it stops being needed");
  assert.match(src, /setInterval\([^)]*,\s*1000\)/, "once a second");
  assert.doesNotMatch(src, /fetch\(/, "no per-second request");
  assert.doesNotMatch(src, /useRef/, "no counter that outlives the props it is derived from");
});

/** A PDF upload row with explicit timestamps, and its book, removed afterwards. */
async function withUpload<T>(
  times: { createdAt: Date; updatedAt: Date; startedAt?: Date | null },
  status: string,
  run: (upload: { id: string }) => Promise<T>,
): Promise<T> {
  requireIsolatedDatabase("these tests create books and uploads");
  const book = await prisma.book.create({ data: { title: `Elapsed ${randomUUID()}`, rightsStatus: "in-copyright" } });
  try {
    const upload = await prisma.upload.create({
      data: { bookId: book.id, kind: "pdf", status, step: status === "DONE" ? "Done" : "Analyzing the book", ...times },
    });
    return await run(upload);
  } finally {
    // Always clean up, even when an assertion throws: the cascade takes the upload with it.
    await prisma.book.delete({ where: { id: book.id } });
  }
}

/** What `GET /api/books/[id]` builds its body from, read the way that route reads it. */
async function viewOf(id: string) {
  const row = await prisma.upload.findUniqueOrThrow({
    where: { id },
    include: {
      book: true,
      ideas: { include: { episodes: { select: { id: true, status: true, createdAt: true } } } },
      pages: { select: { id: true, pageIndex: true, pageLabel: true } },
    },
  });
  return analysisView(row);
}

test("GET /api/books/[id], the poll BookAnalysis makes, carries createdAt, startedAt and updatedAt as ISO strings", async () => {
  // A retried run: uploaded at T0, this run started at T0 + 10 min, failed 6 s later.
  const times = { createdAt: new Date(T0), startedAt: new Date(T0 + 600_000), updatedAt: new Date(T0 + 606_000) };
  await withUpload(times, "FAILED", async ({ id }) => {
    const view = await viewOf(id);
    assert.equal(view.createdAt, "2026-10-04T10:00:00.000Z");
    assert.equal(view.startedAt, "2026-10-04T10:10:00.000Z");
    assert.equal(view.updatedAt, "2026-10-04T10:10:06.000Z");
    assert.equal(JSON.parse(JSON.stringify(view)).startedAt, view.startedAt, "it survives JSON the way the route sends it");
    // The clock reads the run's own six seconds, not ten minutes and six seconds since the upload.
    assert.equal(
      formatElapsed(analysisElapsedMs({ status: view.status, createdAt: view.createdAt, startedAt: view.startedAt, updatedAt: view.updatedAt, now: Date.now() })!),
      "00:00:06",
    );
  });
});

test("a legacy row, with no startedAt, comes through as null and the clock counts from createdAt", async () => {
  const times = { createdAt: new Date(T0), updatedAt: new Date(T0 + 84_000) };
  await withUpload(times, "DONE", async ({ id }) => {
    const row = await prisma.upload.findUniqueOrThrow({ where: { id } });
    assert.equal(row.startedAt, null, "the column is nullable and a row made without it holds null");
    const view = await viewOf(id);
    assert.equal(view.startedAt, null, "null on the wire, not undefined and not an invented date");
    assert.equal(JSON.parse(JSON.stringify(view)).startedAt, null, "and it is still there after JSON");
    assert.equal(view.updatedAt, "2026-10-04T10:01:24.000Z");
    assert.equal(
      formatElapsed(analysisElapsedMs({ status: view.status, createdAt: view.createdAt, startedAt: view.startedAt, updatedAt: view.updatedAt, now: Date.now() })!),
      "00:01:24",
      "the same duration it read before the column existed, now in the one HH:MM:SS shape",
    );
  });
});

test("the analyze route records startedAt in the same update that resets the run, and never touches createdAt", async () => {
  // `POST /api/books/[id]/analyze` is the single start path: `PdfUpload` calls it for the first
  // run and `BookAnalysis`'s Try again calls it for every retry, so the run pipeline needs no change.
  // It reads `cookies()`, so, like the other routes here, it is pinned at the source.
  const route = await fs.readFile(
    fileURLToPath(new URL("../src/app/api/books/[id]/analyze/route.ts", import.meta.url)),
    "utf8",
  );
  const update = route.match(/prisma\.upload\.update\(\{[^;]*\}\);/)?.[0] ?? "";
  assert.ok(update, "the route resets the upload in one update");
  assert.match(update, /status: "QUEUED"/, "the same update that resets the run...");
  assert.match(update, /startedAt: new Date\(\)/, "...stamps when this run started");
  assert.doesNotMatch(route, /createdAt\s*:/, "createdAt is the upload and orders 'Your books': a retry must not rewrite it");
  assert.ok(
    route.indexOf("startedAt") < route.indexOf("runBookAnalysis(id)"),
    "it is written before the run is launched, so the first poll already has it",
  );

  // Both callers go through that one route, which is why the run itself is untouched.
  for (const [file, what] of [["PdfUpload.tsx", "the first start"], ["BookAnalysis.tsx", "a retry"]] as const) {
    const src = await fs.readFile(path.join(COMPONENTS, file), "utf8");
    assert.match(src, /\/api\/books\/\$\{uploadId\}\/analyze`, \{ method: "POST" \}/, `${what} goes through the analyze route`);
  }
  const run = await fs.readFile(fileURLToPath(new URL("../src/lib/analysis/run.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(run, /startedAt/, "runBookAnalysis does not own the stamp");
});
