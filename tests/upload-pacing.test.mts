import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UPLOAD_PACE_MS,
  MAX_UPLOAD_PACE_MS,
  MIN_UPLOAD_PACE_MS,
  UPLOAD_PACE_RING_MS,
  ensureUploadDuration,
  formatPaceDuration,
  isUploadPacingEnabled,
  nextUploadDurationMs,
  pacedFillField,
  resetUploadPaceLoopForTests,
  splitPacedTokens,
  targetUploadDurationMs,
} from "../src/lib/publish/browser/pacing";
import { FakePage } from "./helpers/fake-browser.mjs";

test("upload pacing loops and shuffles across 2m 45s (165,000 ms) to 3m 45s (225,000 ms) with distinct consecutive durations", () => {
  assert.equal(MIN_UPLOAD_PACE_MS, 165_000); // 2m 45s
  assert.equal(MAX_UPLOAD_PACE_MS, 225_000); // 3m 45s
  assert.equal(DEFAULT_UPLOAD_PACE_MS, 180_000);
  assert.equal(targetUploadDurationMs({}), 0, "NODE_TEST_CONTEXT disables wall-clock sleeps by default");
  assert.equal(isUploadPacingEnabled({ BOOKREEL_UPLOAD_PACE_MS: "loop" }), true);
  assert.equal(isUploadPacingEnabled({ BOOKREEL_UPLOAD_PACE_MS: "0" }), false);

  resetUploadPaceLoopForTests();
  const drawn: number[] = [];
  for (let i = 0; i < 36; i++) {
    const ms = nextUploadDurationMs({ BOOKREEL_UPLOAD_PACE_MS: "loop" });
    assert.ok(
      ms >= MIN_UPLOAD_PACE_MS && ms <= MAX_UPLOAD_PACE_MS,
      `video ${i + 1} duration ${ms}ms (${formatPaceDuration(ms)}) must stay within 2m 45s .. 3m 45s`,
    );
    if (i > 0) {
      assert.notEqual(ms, drawn[i - 1], `video ${i + 1} (${ms}ms) must not repeat video ${i} (${drawn[i - 1]}ms)`);
    }
    drawn.push(ms);
  }

  // First three videos follow distinct varied timings: 3m 00s, 3m 30s, 2m 55s.
  assert.equal(formatPaceDuration(drawn[0]), "3m 00s");
  assert.equal(formatPaceDuration(drawn[1]), "3m 30s");
  assert.equal(formatPaceDuration(drawn[2]), "2m 55s");

  // Both boundary extremes (2m 45s and 3m 45s) are included in each loop pass.
  const pass1 = drawn.slice(0, UPLOAD_PACE_RING_MS.length);
  const pass2 = drawn.slice(UPLOAD_PACE_RING_MS.length, UPLOAD_PACE_RING_MS.length * 2);
  const pass3 = drawn.slice(UPLOAD_PACE_RING_MS.length * 2, UPLOAD_PACE_RING_MS.length * 3);
  assert.ok(pass1.includes(165_000) && pass1.includes(225_000), "pass 1 spans full 2m 45s to 3m 45s range");
  assert.equal(new Set(pass1).size, UPLOAD_PACE_RING_MS.length, "pass 1 visits every distinct slot");
  assert.equal(new Set(pass2).size, UPLOAD_PACE_RING_MS.length, "pass 2 visits every distinct slot");
  assert.notDeepEqual(pass1, pass2, "pass 2 shuffles into a fresh order");
  assert.notDeepEqual(pass2, pass3, "pass 3 shuffles into another fresh order");

  // Production server mode (without BOOKREEL_TEST_DB_PID / NODE_TEST_CONTEXT) automatically uses the 2m 45s – 3m 45s loop.
  resetUploadPaceLoopForTests();
  const prevTestPid = process.env.BOOKREEL_TEST_DB_PID;
  const prevNodeCtx = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.BOOKREEL_TEST_DB_PID;
    delete process.env.NODE_TEST_CONTEXT;
    const prod1 = nextUploadDurationMs({});
    const prod2 = nextUploadDurationMs({});
    const prod3 = nextUploadDurationMs({});
    assert.deepEqual([prod1, prod2, prod3], [180_000, 210_000, 175_000]);
  } finally {
    if (prevTestPid !== undefined) process.env.BOOKREEL_TEST_DB_PID = prevTestPid;
    if (prevNodeCtx !== undefined) process.env.NODE_TEST_CONTEXT = prevNodeCtx;
  }
});

test("pacedFillField enters title and multi-line description word-by-word with calm pauses instead of instant paste", async () => {
  const copy = "Why Deep Focus Wins.\n\nRead slowly, build daily habits! #books #focus";
  const tokens = splitPacedTokens(copy);
  assert.ok(tokens.length >= 10, `expected progressive word tokens, got ${tokens.length}`);
  assert.equal(tokens.join(""), copy);

  const page = new FakePage();
  const snapshots: string[] = [];
  let current = "";
  page.def("#caption", {
    visible: true,
    text: () => current,
    onFill: (v) => {
      current = v;
      snapshots.push(v);
    },
  });

  let fakeNow = 1_000;
  const clock = {
    now: () => fakeNow,
    sleep: async (ms: number) => {
      fakeNow += ms;
    },
  };

  await pacedFillField({
    page,
    selector: "#caption",
    value: copy,
    clock,
    targetMs: 210_000,
  });

  assert.equal(current, copy, "final text matches approved copy byte-for-byte");
  assert.ok(snapshots.length > 8, "field populated progressively word-by-word rather than a single 0ms paste");
  assert.equal(snapshots[0], "", "clears field first before typing progressively");
  assert.ok(fakeNow - 1_000 >= 5_000, `typing 10 words + punctuation took ${fakeNow - 1_000}ms of calm cadence`);
});

test("ensureUploadDuration reaches each video's varied target duration (e.g. 3m 30s or 2m 55s) while respecting schedule lead cutoff", async () => {
  let fakeNow = 10_000;
  const logs: string[] = [];
  const clock = {
    now: () => fakeNow,
    sleep: async (ms: number) => {
      fakeNow += ms;
    },
  };

  const startedAtMs = fakeNow;
  fakeNow += 112_000;
  const waited = await ensureUploadDuration({
    clock,
    startedAtMs,
    targetMs: 210_000, // 3m 30s
    platformLabel: "Instagram",
    log: (msg) => logs.push(msg),
    scheduledAt: new Date(fakeNow + 2 * 3600_000),
    minScheduleLeadMs: 20 * 60_000,
  });

  assert.equal(waited, 98_000);
  assert.equal(fakeNow - startedAtMs, 210_000, "total single-video upload span matches 3m 30s (210s)");
  assert.ok(logs.some((l) => l.includes("3m 30s upload pace")));

  // Near-cutoff safety check: clamp wait so the 20-minute Instagram cutoff is never breached.
  const tightStart = fakeNow;
  fakeNow += 60_000;
  const tightWaited = await ensureUploadDuration({
    clock,
    startedAtMs: tightStart,
    targetMs: 225_000, // 3m 45s
    platformLabel: "Instagram",
    scheduledAt: new Date(fakeNow + 21 * 60_000 + 15_000),
    minScheduleLeadMs: 20 * 60_000,
  });
  assert.equal(tightWaited, 15_000, "clamped wait to preserve 21-minute schedule lead margin");
});

import { isPerVideoPostUploadHold } from "../src/lib/schedule/activate";

test("isPerVideoPostUploadHold continues queue on isolated per-video errors and stops on systemic account/browser errors", () => {
  // Isolated per-video errors (even before checkpoint) do NOT stop subsequent videos:
  for (const lastError of [
    "Audience and tag review timed out after 420 seconds; provider cancellation requested. No new file was selected.",
    "YouTube Studio did something unexpected (The schedule's time shows 00:00, not 05:51.). Nothing was published.",
    "YouTube Studio did something unexpected (Studio Details settings could not be verified: Video location: exact Chennai, Tamil Nadu autocomplete selection.).",
    "Instagram did something unexpected (Instagram did not offer an accessible crop/expand control. Original could not be selected; Next was not pressed.).",
    "The selected Instagram thumbnail is unavailable. Select a thumbnail before retrying; nothing was uploaded.",
  ]) {
    assert.equal(
      isPerVideoPostUploadHold({ status: "AWAITING_HUMAN", externalId: null, remoteDraftId: null, lastError }),
      true,
      `expected per-video continuation for: ${lastError}`,
    );
  }

  // Systemic errors ALWAYS stop the queue:
  for (const lastError of [
    "YouTube wants you to sign in. This app never types or stores your password.",
    "YouTube asked you to sign in. Sign in in the window, then retry.",
    "Instagram wants you to sign in.",
    "YouTube Studio did not finish loading, so it cannot be told whether you are signed in.",
    "Schedule content is unavailable.",
    "Something unexpected stopped the YouTube browser job (page crashed).",
    "YouTube Studio did something unexpected (page.waitForTimeout: Target page, context or browser has been closed).",
  ]) {
    assert.equal(
      isPerVideoPostUploadHold({ status: "AWAITING_HUMAN", externalId: "draft123", remoteDraftId: "draft123", lastError }),
      false,
      `expected systemic stop for: ${lastError}`,
    );
  }
});
