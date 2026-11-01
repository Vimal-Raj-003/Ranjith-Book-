import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakePage, fakeBrowser, fakeClock } from "./helpers/fake-browser.mjs";
import { runInSession, type BrowserSession } from "../src/lib/publish/browser/engine";
import { browserYouTubePublisher, confirmChannel, YT } from "../src/lib/publish/browser/youtube";
import { browserInstagramPublisher } from "../src/lib/publish/browser/instagram";
import type { PreparedPublish } from "../src/lib/publish/contract";
import { closeLeftOpenWindow } from "../src/lib/publish/browser/live";

const fixture = { episodeId: "fixture", metadata: { title: "Fixture" } } as PreparedPublish;

for (const { name, url, accepted } of [
  { name: "matches the intended channel without a handle redirect", url: "https://studio.youtube.com/channel/UCRYJBrMBdtXHa5rYFbmV_iA", accepted: true },
  { name: "rejects a different channel without falling back to a handle", url: `https://studio.youtube.com/channel/UC${"b".repeat(22)}`, accepted: false },
  { name: "rejects an unreadable channel without navigating", url: "https://studio.youtube.com/", accepted: false },
]) {
  test(`configured channel ID verification ${name}`, async () => {
    const page = new FakePage();
    page.currentUrl = url;
    Object.defineProperty(page, "context", { get: () => assert.fail("Direct ID verification must not open a public handle-probe tab") });
    page.onGoto = () => assert.fail("Direct ID verification must preserve the loaded dashboard");
    const clock = fakeClock();
    const session: BrowserSession = { page, clock, headless: true, finish: async () => assert.fail("Verification must not close the session") };
    const verify = () => confirmChannel(session, "scheduled", { BOOKREEL_YOUTUBE_CHANNEL_ID: " UCRYJBrMBdtXHa5rYFbmV_iA " });
    if (accepted) await assert.doesNotReject(verify);
    else await assert.rejects(verify, /does not match BookReel's configured channel ID/);
    assert.equal(page.url(), url);
    assert.deepEqual(page.actions, [], "verification neither navigates nor selects an upload file");
    assert.equal(clock.elapsed(), 0, "no unnecessary page-load wait");
  });
}

test("a loaded dashboard verifies the configured channel and immediately seeks Create, with a bounded failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-dashboard-test-"));
  const page = new FakePage();
  const channel = `UC${"a".repeat(22)}`;
  page.currentUrl = `https://studio.youtube.com/channel/${channel}`;
  page.def(YT.appShell, { visible: true });
  page.def("body", { text: "Channel dashboard" });
  const env = { BOOKREEL_YOUTUBE_CHANNEL_ID: channel };
  const fake = fakeBrowser(page, { profileRoot: root, env });
  const logs: string[] = [];
  try {
    const outcome = await browserYouTubePublisher({ env, deps: fake.deps, options: { madeForKids: false } }).publish(fixture, { onLog: message => { logs.push(message); } });
    assert.equal(outcome.status, "AWAITING_HUMAN");
    assert.match(outcome.error, /Create/);
    assert.ok(logs.some(log => /Channel verified/.test(log)));
    assert.equal(page.actions.filter(action => action.startsWith("goto:")).length, 0, "no second page load is awaited");
    assert.ok(fake.clock.elapsed() <= 60_000, "the missing selector has a bounded wait");
    assert.equal(page.actions.filter(action => action.startsWith("files:")).length, 0);
  } finally { await closeLeftOpenWindow("youtube"); await fs.rm(root, { recursive: true, force: true }); }
});

test("a different configured channel prevents file selection even for a private upload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-channel-test-"));
  const page = new FakePage();
  page.currentUrl = `https://studio.youtube.com/channel/UC${"a".repeat(22)}`;
  page.def(YT.appShell, { visible: true });
  const env = { BOOKREEL_YOUTUBE_CHANNEL_ID: `UC${"b".repeat(22)}` };
  try {
    const fake = fakeBrowser(page, { profileRoot: root, env });
    const outcome = await browserYouTubePublisher({ env, deps: fake.deps, options: { madeForKids: false } }).publish(fixture);
    assert.equal(outcome.status, "AWAITING_HUMAN");
    assert.match(outcome.error, /does not match/);
    assert.equal(page.touched().length, 0);
  } finally { await closeLeftOpenWindow("youtube"); await fs.rm(root, { recursive: true, force: true }); }
});

test("the job watchdog stops a non-returning automation operation and retains an unknown outcome", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-timeout-test-"));
  try {
    const fake = fakeBrowser(new FakePage(), { profileRoot: root });
    const outcome = await runInSession("youtube", { ...fake.deps, jobTimeoutMs: 10 }, async () => new Promise(() => {}));
    assert.equal(outcome.status, "AWAITING_HUMAN");
    assert.match(outcome.error, /exceeded/);
    assert.equal(fake.context.closed, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the Instagram provider execution gate prevents launch independently of native-schedule eligibility", async () => {
  let launches = 0;
  const provider = browserInstagramPublisher({ env: { BOOKREEL_IG_NATIVE_SCHEDULE: "1" }, options: { confirmPublic: true }, deps: {
    locate: () => "fake", launch: async () => { launches++; throw new Error("Must never launch"); },
  } });
  const outcome = await provider.publish(fixture);
  assert.equal(outcome.status, "REQUIRES_CONNECTION");
  assert.match(outcome.error, /disabled/);
  assert.equal(launches, 0);
});
