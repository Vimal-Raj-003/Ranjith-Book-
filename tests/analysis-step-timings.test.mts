import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as railModule from "../src/components/PipelineRail";
import {
  analysisStepTimings,
  beginStep,
  endRun,
  parseStepTimings,
  type StoredStepTiming,
} from "../src/lib/analysis/step-timings";
import { analysisView } from "../src/lib/analysis/view";
import { ANALYSIS_STEPS } from "../src/lib/pipeline-steps";
import { prisma } from "../src/lib/db";
import { requireIsolatedDatabase } from "./setup/isolation";

/**
 * Per-stage timings for the PDF analysis.
 *
 * `PipelineRail` already draws a stage's duration when it is handed
 * `steps: StepTiming[]` -- finished stages frozen, the running one ticking from its
 * `startedAt`, stages not reached blank. The analysis never passed it any, because the
 * Upload row recorded no stage timestamps. These tests pin the recording (pure, and
 * through the database), the translation into the rail's shape, and -- by rendering the
 * real rail -- that what comes out is what gets drawn.
 *
 * What needs a browser (the +1/s tick of the running stage on a live page, a refresh not
 * resetting it) was verified in the browser pass; no DOM is installed in this runner.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Working copies are CRLF (core.autocrlf); the patterns below are written for LF.
const read = async (rel: string) => (await fs.readFile(path.join(ROOT, rel), "utf8")).split("\r\n").join("\n");

const T0 = Date.parse("2026-10-04T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const iso = (offsetMs: number) => at(offsetMs).toISOString();

const [S1, S2, S3, S4, S5] = ANALYSIS_STEPS;

/** The run as `Reporter` would have recorded it: each stage opened in turn at the given offsets. */
function recorded(starts: [string, number][], endAt?: number): StoredStepTiming[] {
  let t: StoredStepTiming[] = [];
  for (const [step, offset] of starts) t = beginStep(t, step, at(offset));
  return endAt == null ? t : endRun(t, at(endAt));
}

// --- recording -------------------------------------------------------------

test("beginStep opens the stage and closes the previous one at the very same instant", () => {
  const one = beginStep([], S1, at(0));
  assert.deepEqual(one, [{ step: S1, startedAt: iso(0), endedAt: null }]);

  const two = beginStep(one, S2, at(12_400));
  assert.deepEqual(two, [
    { step: S1, startedAt: iso(0), endedAt: iso(12_400) },
    { step: S2, startedAt: iso(12_400), endedAt: null },
  ]);
  assert.equal(two[0].endedAt, two[1].startedAt, "stages run one after another: no gap and no overlap to guess at");
});

test("beginStep is pure, and beginning the stage already open does not add a second entry", () => {
  const before = [{ step: S1, startedAt: iso(0), endedAt: null }];
  const frozen = JSON.stringify(before);
  const next = beginStep(before, S2, at(5_000));
  assert.equal(JSON.stringify(before), frozen, "the input is not mutated");
  assert.notEqual(next, before);

  const again = beginStep(before, S1, at(9_000));
  assert.deepEqual(again, before, "re-reporting the open stage changes nothing, including its start");
});

test("endRun closes the open stage once and leaves closed stages alone", () => {
  const running = recorded([[S1, 0], [S2, 10_000]]);
  const ended = endRun(running, at(25_000));
  assert.deepEqual(ended, [
    { step: S1, startedAt: iso(0), endedAt: iso(10_000) },
    { step: S2, startedAt: iso(10_000), endedAt: iso(25_000) },
  ]);
  assert.deepEqual(endRun(ended, at(99_000)), ended, "ending an ended run does not move any end");
  assert.deepEqual(endRun([], at(0)), [], "a run that never began a stage has nothing to close");
});

test("parseStepTimings reads the column and never throws on what is not valid", () => {
  const good = recorded([[S1, 0], [S2, 10_000]], 20_000);
  assert.deepEqual(parseStepTimings(JSON.stringify(good)), good);
  for (const raw of [null, undefined, "", "not json", "{", "{}", "null", "42", '"x"', "[1, 2]", '[{"step": 5}]']) {
    assert.deepEqual(parseStepTimings(raw as string | null | undefined), [], `${JSON.stringify(raw)} reads as no history`);
  }
  // One bad entry does not take the good ones with it; a missing endedAt is "still open".
  const mixed = JSON.stringify([{ step: S1, startedAt: iso(0), endedAt: iso(5_000) }, { step: S2 }, { step: S3, startedAt: "garbage" }, { step: S4, startedAt: iso(5_000) }]);
  assert.deepEqual(parseStepTimings(mixed), [
    { step: S1, startedAt: iso(0), endedAt: iso(5_000) },
    { step: S4, startedAt: iso(5_000), endedAt: null },
  ]);
});

// --- the rail's shape ------------------------------------------------------

test("a live run: finished stages carry a measured duration, the running one carries its start, the rest are absent", () => {
  const stored = recorded([[S1, 0], [S2, 12_400], [S3, 72_400]]);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "RUNNING", step: S3 });
  assert.deepEqual(steps, [
    { step: S1, position: 0, status: "DONE", startedAt: iso(0), durationMs: 12_400 },
    { step: S2, position: 1, status: "DONE", startedAt: iso(12_400), durationMs: 60_000 },
    { step: S3, position: 2, status: "RUNNING", startedAt: iso(72_400), durationMs: null },
  ]);
  const named: string[] = steps.map((s) => s.step);
  assert.equal(named.includes(S4) || named.includes(S5), false, "stages not reached are omitted, not zeroed");
});

test("a DONE run: every stage frozen with its measured duration, the last one closed by the terminal write", () => {
  const stored = recorded([[S1, 0], [S2, 12_000], [S3, 20_000], [S4, 50_000], [S5, 170_000]], 200_000);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "DONE", step: "Done" });
  assert.deepEqual(steps.map((s) => [s.step, s.status, s.durationMs]), [
    [S1, "DONE", 12_000],
    [S2, "DONE", 8_000],
    [S3, "DONE", 30_000],
    [S4, "DONE", 120_000],
    [S5, "DONE", 30_000],
  ]);
  assert.equal(steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0), 200_000, "the stages add up to the run: nothing lost, nothing invented");
});

test("a FAILED run: the stage it died in is FAILED with the time it ran, earlier stages DONE", () => {
  const stored = recorded([[S1, 0], [S2, 10_000], [S3, 25_000]], 31_500);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "FAILED", step: S3 });
  assert.deepEqual(steps.map((s) => [s.step, s.status, s.durationMs]), [
    [S1, "DONE", 10_000],
    [S2, "DONE", 15_000],
    [S3, "FAILED", 6_500],
  ]);
});

test("a stage left open by a run that is over (died, or reaped) gets no duration rather than a guessed one", () => {
  const stored = recorded([[S1, 0], [S2, 10_000]]);
  for (const status of ["FAILED", "DONE", "CANCELLED"]) {
    const steps = analysisStepTimings(JSON.stringify(stored), { status, step: S2 });
    assert.deepEqual(steps.map((s) => s.step), [S1], `${status}: only the stage that was seen to end is timed`);
    assert.equal(steps[0].durationMs, 10_000);
  }
});

test("a resumed run times only the stages it ran; the skipped ones are blank, not invented", () => {
  // Pages were stored by an earlier run, so extraction and OCR never started this time.
  const stored = recorded([[S3, 0], [S4, 4_000], [S5, 44_000]], 60_000);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "DONE", step: "Done" });
  assert.deepEqual(steps.map((s) => s.step), [S3, S4, S5]);
});

test("legacy and empty: null, undefined or an empty history is an empty list", () => {
  for (const raw of [null, undefined, "", "[]"]) {
    for (const status of ["RUNNING", "DONE", "FAILED", "QUEUED"]) {
      assert.deepEqual(analysisStepTimings(raw, { status, step: S3 }), [], `${JSON.stringify(raw)} / ${status}`);
    }
  }
});

test("stages that are not in the list, repeated stages and unreadable ends are ignored; a backwards clock is zero", () => {
  const stored = [
    { step: "A step since renamed", startedAt: iso(0), endedAt: iso(1_000) },
    { step: S1, startedAt: iso(1_000), endedAt: iso(3_000) },
    { step: S1, startedAt: iso(3_000), endedAt: iso(9_000) },
    { step: S2, startedAt: iso(9_000), endedAt: "garbage" },
    { step: S3, startedAt: iso(20_000), endedAt: iso(10_000) },
  ];
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "DONE", step: "Done" });
  assert.deepEqual(steps.map((s) => [s.step, s.durationMs]), [[S1, 2_000], [S3, 0]]);
});

test("the output is in ANALYSIS_STEPS order whatever order it was stored in", () => {
  const stored = [
    { step: S3, startedAt: iso(20_000), endedAt: iso(30_000) },
    { step: S1, startedAt: iso(0), endedAt: iso(20_000) },
  ];
  assert.deepEqual(analysisStepTimings(JSON.stringify(stored), { status: "DONE", step: "Done" }).map((s) => s.step), [S1, S3]);
});

// --- what the real rail draws from it --------------------------------------

const PipelineRail = ((railModule as { default: unknown }).default as { default?: unknown }).default ??
  (railModule as { default: unknown }).default;

type RailProps = React.ComponentProps<typeof railModule.default>;

/** The real `PipelineRail`, server-rendered with `Date.now` held at `now`; returns each stage row's text. */
function rows(props: RailProps, now: number): { markup: string; rows: string[]; headline: string } {
  // `headline` is all the text on the rail, so it contains the one-line summary as well as the rows.
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const markup = renderToStaticMarkup(React.createElement(PipelineRail as React.ComponentType<RailProps>, props));
    const text = (html: string) => html.replace(/<[^>]+>/g, "");
    const li = [...markup.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
    return { markup, rows: li, headline: text(markup) };
  } finally {
    Date.now = realNow;
  }
}

test("the rail draws it: finished stages frozen, the running stage ticking one second per second, pending blank", () => {
  const stored = recorded([[S1, 0], [S2, 12_400], [S3, 72_400]]);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "RUNNING", step: S3 });
  const props: RailProps = { step: S3, status: "RUNNING", steps, stepList: ANALYSIS_STEPS, expanded: true };

  const first = rows(props, T0 + 72_400 + 15_000);
  assert.equal(first.rows.length, 5, "all five task names stay visible");
  assert.match(first.rows[0], new RegExp(`^${S1}.*12\\.4s$`));
  assert.match(first.rows[1], new RegExp(`^${S2}.*1m 00s$`));
  assert.match(first.rows[2], new RegExp(`^${S3}15\\.0s$`), "the running stage reads now - its own startedAt");
  assert.equal(first.rows[3], S4, "a stage not reached has no duration, and no placeholder");
  assert.equal(first.rows[4], S5);
  assert.match(first.headline, /Analyzing the book\s*· 15\.0s/, "and the headline line carries the same figure");

  // One second later (what the rail's own 1 s interval does): only the running figure moves.
  const second = rows(props, T0 + 72_400 + 16_000);
  assert.match(second.rows[2], /16\.0s$/, "+1 s");
  assert.equal(second.rows[0], first.rows[0], "a finished stage is frozen: it does not move with the clock");
  assert.equal(second.rows[1], first.rows[1]);
  // A reload at a much later moment: derived from the stored start, so it continues rather than restarting at zero.
  assert.match(rows(props, T0 + 72_400 + 125_000).rows[2], /2m 05s$/);
  // `expanded` opens the stage list, so the figures are on screen without a click; without it the rail is
  // exactly as an episode card has always drawn it: collapsed.
  assert.match(first.markup, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(rows({ ...props, expanded: undefined }, T0).markup, /<details[^>]*\bopen\b/, "the default is unchanged");
});

test("the rail never draws a negative duration: a stage that began after the rail's last tick reads 0ms, not -2000ms", async () => {
  // `now` in the rail is refreshed once a second (and not at all while nothing runs), so the first render of a
  // stage that has just begun can be handed a `startedAt` slightly in its future.
  const steps = analysisStepTimings(JSON.stringify(recorded([[S1, 2_000]])), { status: "RUNNING", step: S1 });
  const out = rows({ step: S1, status: "RUNNING", steps, stepList: ANALYSIS_STEPS }, T0);
  assert.match(out.rows[0], new RegExp(`^${S1}0ms$`));
  assert.doesNotMatch(out.markup, /-\d+ms/);
  // ...and the rail catches its clock up the moment a run begins, rather than a second later.
  const src = await read("src/components/PipelineRail.tsx");
  assert.match(src, /const catchUp = setTimeout\(tick, 0\);/);
  assert.match(src, /clearTimeout\(catchUp\);\s*\n\s*clearInterval\(id\);/, "and cleans both up");
  assert.equal((src.match(/setInterval\(/g) ?? []).length, 1, "still the one 1 s interval");
});

test("the rail, legacy: no timings (null history, or none passed) draws the five names and no numbers, and does not throw", () => {
  const none = analysisStepTimings(null, { status: "RUNNING", step: S3 });
  assert.deepEqual(none, []);
  for (const steps of [none, undefined]) {
    const out = rows({ step: S3, status: "RUNNING", steps, stepList: ANALYSIS_STEPS }, T0 + 99_000);
    assert.deepEqual(out.rows, [...ANALYSIS_STEPS], "task names only");
    assert.doesNotMatch(out.markup, /\d+(\.\d)?s\b/, "no seconds figure anywhere");
  }
});

test("the rail, DONE: every stage has its frozen duration, whatever the time is now", () => {
  const stored = recorded([[S1, 0], [S2, 12_000], [S3, 20_000], [S4, 50_000], [S5, 170_000]], 200_000);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "DONE", step: "Done" });
  const props: RailProps = { step: "Done", status: "DONE", steps, stepList: ANALYSIS_STEPS };
  const a = rows(props, T0 + 201_000);
  const b = rows(props, T0 + 99_000_000);
  assert.deepEqual(a.rows, b.rows, "frozen");
  assert.match(a.rows[0], /12\.0s$/);
  assert.match(a.rows[1], /8\.0s$/);
  assert.match(a.rows[2], /30\.0s$/);
  assert.match(a.rows[3], /2m 00s$/);
  assert.match(a.rows[4], /30\.0s$/);
  assert.doesNotMatch(a.markup, />running</, "nothing is left saying it is still running");
});

test("the rail, FAILED: the stage that failed shows how long it ran, not 'running'", () => {
  const stored = recorded([[S1, 0], [S2, 10_000], [S3, 25_000]], 31_500);
  const steps = analysisStepTimings(JSON.stringify(stored), { status: "FAILED", step: S3 });
  const out = rows({ step: S3, status: "FAILED", error: "boom", steps, stepList: ANALYSIS_STEPS }, T0 + 9_000_000);
  assert.match(out.rows[2], /6\.5s$/);
  assert.doesNotMatch(out.markup, />running</);
});

// --- the write sites -------------------------------------------------------

test("Reporter.step writes the history in the same update that moves the step, and nothing writes it per second", async () => {
  const src = await read("src/lib/analysis/run.ts");
  const step = src.match(/async step\([\s\S]*?\n  \}\n/)?.[0] ?? "";
  assert.ok(step, "Reporter.step is still there");
  assert.match(step, /beginStep\(this\.timings, step, new Date\(\)\)/, "this stage begins now, the previous one ends now");
  assert.match(step, /data: \{ step, progress: null, stepTimings: JSON\.stringify\(this\.timings\) \}/, "one update: step and history together");
  assert.equal((step.match(/prisma\.upload\.update\(/g) ?? []).length, 1, "a single write per stage transition");

  // progress() runs about once a second and beat() once a minute: neither carries the history.
  const progress = src.match(/async progress\([\s\S]*?\n  \}\n/)?.[0] ?? "";
  const beat = src.match(/async beat\([\s\S]*?\n  \}\n/)?.[0] ?? "";
  assert.ok(progress && beat);
  assert.doesNotMatch(progress, /stepTimings|timings/);
  assert.doesNotMatch(beat, /stepTimings|timings/);

  // Every `stepTimings` write in the file: the stage transition, the start-of-run clear, DONE, FAILED.
  assert.equal((src.match(/stepTimings:/g) ?? []).length, 4);
  assert.equal((src.match(/stepTimings: report\.finish\(\)/g) ?? []).length, 2, "DONE and FAILED each close the last stage");
  const done = src.match(/status: "DONE",[\s\S]*?\}\);/)?.[0] ?? "";
  assert.match(done, /stepTimings: report\.finish\(\)/, "the DONE write ends the last stage");
  const failed = src.match(/status: "FAILED",[\s\S]*?\.catch\(/)?.[0] ?? "";
  assert.match(failed, /stepTimings: report\.finish\(\)/, "and so does the FAILED write");
  assert.doesNotMatch(src, /setInterval\([^)]*timings/i, "the only interval is the heartbeat");
});

test("the analyze route clears the history in the same update that resets the run, so a retry measures fresh", async () => {
  const route = await read("src/app/api/books/[id]/analyze/route.ts");
  const update = route.match(/prisma\.upload\.update\(\{[^;]*\}\);/)?.[0] ?? "";
  assert.ok(update);
  assert.match(update, /status: "QUEUED"/);
  assert.match(update, /stepTimings: null/, "cleared with the status, step, progress and startedAt resets");
  assert.equal((route.match(/prisma\.upload\.update\(/g) ?? []).length, 1, "still one update");
});

test("BookAnalysis hands the rail the stage timings and does the drawing in none of its own", async () => {
  const src = await read("src/components/BookAnalysis.tsx");
  assert.match(src, /steps=\{view\.stepTimings\}/, "the live panel passes them");
  assert.match(src, /stepTimings: \[\]/, "and a Retry empties them at once, as the route does");
  // One interval already lives in AnalysisElapsed and one in PipelineRail; this file adds none, and no fetch per second.
  assert.doesNotMatch(src, /setInterval/);
  // The DONE view has no run panel; it keeps the times behind a disclosure, and only when there are some.
  assert.match(src, /\{!live && \(view\.stepTimings\?\.length \?\? 0\) > 0 && \(\s*<Disclosure/);
});

// --- through the database --------------------------------------------------

/** A PDF upload and its book, removed afterwards. */
async function withUpload<T>(
  data: { status: string; step: string; stepTimings?: string | null },
  run: (upload: { id: string }) => Promise<T>,
): Promise<T> {
  requireIsolatedDatabase("these tests create books and uploads");
  const book = await prisma.book.create({ data: { title: `Timings ${randomUUID()}`, rightsStatus: "in-copyright" } });
  try {
    const upload = await prisma.upload.create({ data: { bookId: book.id, kind: "pdf", ...data } });
    return await run(upload);
  } finally {
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

test("the column round-trips: what Reporter would write is what GET /api/books/[id] sends, as the rail's shape", async () => {
  // Replay a run through the same two pure steps Reporter uses, persisting after each, as it does.
  await withUpload({ status: "RUNNING", step: "Queued" }, async ({ id }) => {
    let timings: StoredStepTiming[] = [];
    for (const [step, offset] of [[S1, 0], [S2, 12_400], [S3, 72_400]] as const) {
      timings = beginStep(timings, step, at(offset));
      await prisma.upload.update({ where: { id }, data: { step, progress: null, stepTimings: JSON.stringify(timings) } });
    }
    const live = await viewOf(id);
    assert.deepEqual(live.stepTimings, [
      { step: S1, position: 0, status: "DONE", startedAt: iso(0), durationMs: 12_400 },
      { step: S2, position: 1, status: "DONE", startedAt: iso(12_400), durationMs: 60_000 },
      { step: S3, position: 2, status: "RUNNING", startedAt: iso(72_400), durationMs: null },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(live)).stepTimings, live.stepTimings, "it survives JSON the way the route sends it");

    // The terminal write closes the open stage in the same update as the status.
    timings = endRun(timings, at(100_000));
    await prisma.upload.update({ where: { id }, data: { status: "DONE", step: "Done", stepTimings: JSON.stringify(timings) } });
    const done = await viewOf(id);
    assert.deepEqual(done.stepTimings?.map((s) => [s.step, s.status, s.durationMs]), [
      [S1, "DONE", 12_400],
      [S2, "DONE", 60_000],
      [S3, "DONE", 27_600],
    ]);

    // A retry clears it (what the analyze route does): the next read has no history, not the old run's.
    await prisma.upload.update({ where: { id }, data: { status: "QUEUED", step: "Queued", stepTimings: null } });
    assert.deepEqual((await viewOf(id)).stepTimings, []);
  });
});

test("a legacy row, with a null stepTimings, comes through as an empty list and the view does not throw", async () => {
  await withUpload({ status: "DONE", step: "Done" }, async ({ id }) => {
    const row = await prisma.upload.findUniqueOrThrow({ where: { id } });
    assert.equal(row.stepTimings, null, "the column is nullable and a row made without it holds null");
    const view = await viewOf(id);
    assert.deepEqual(view.stepTimings, [], "an empty list: no history is invented");
    assert.equal(JSON.parse(JSON.stringify(view)).stepTimings.length, 0);
  });
});

test("a corrupt stepTimings value is read as no history rather than failing the poll", async () => {
  for (const bad of ["{not json", '{"a":1}', "[null]", "garbage"]) {
    await withUpload({ status: "RUNNING", step: S2, stepTimings: bad }, async ({ id }) => {
      assert.deepEqual((await viewOf(id)).stepTimings, [], bad);
    });
  }
});
