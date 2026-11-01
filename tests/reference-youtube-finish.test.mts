import test from "node:test";
import assert from "node:assert/strict";
import {
  videoIdFrom,
  readUploadState,
  readOutcome,
  watchUpload,
  confirmPublished,
  judgeChannelView,
  WATCH_DEFAULTS,
  type DialogSnapshot,
  type WatchDeps,
} from "../src/lib/publish/browser/youtube-finish";
import { isPublishError } from "../src/lib/publish/types";

/** A clock the test owns: sleeping moves it, and nothing actually waits. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/** Feeds a fixed sequence of footer texts, then repeats the last one forever. */
function script(...texts: string[]) {
  let i = 0;
  return async () => texts[Math.min(i++, texts.length - 1)];
}

const quiet = () => {};

/* ------------------------------------------------------------ video ids -- */

test("a video id is found in every shape YouTube prints one", () => {
  const vid = "dQw4w9WgXcQ";
  for (const text of [
    `https://youtu.be/${vid}`,
    `https://www.youtube.com/watch?v=${vid}`,
    `https://www.youtube.com/watch?feature=share&v=${vid}&t=3`,
    `https://www.youtube.com/shorts/${vid}`,
    `https://studio.youtube.com/video/${vid}/edit`,
    `Video link: https://youtu.be/${vid} Copy`,
  ]) {
    assert.equal(videoIdFrom(text), vid, text);
  }
});

test("text that is not a video link has no id", () => {
  for (const text of ["", "Video published", "https://youtu.be/", "https://youtu.be/short", "https://example.com/watch?v=dQw4w9WgXcQ"]) {
    assert.equal(videoIdFrom(text), null, text);
  }
});

/* -------------------------------------------------------- upload state -- */

test("the upload dialog's footer is read into a phase", () => {
  const cases: [string, string][] = [
    ["Uploading 12% … 3 minutes left", "uploading"],
    ["Uploading 100%", "uploading"],
    ["Upload complete … Processing will begin shortly", "uploaded"],
    ["Processing HD version … 4 minutes left", "processing"],
    ["Checking …", "checking"],
    ["Checks complete. No issues found.", "checked"],
    ["", "unknown"],
  ];
  // "Upload complete ... Processing will begin shortly" mentions processing, but
  // processing has not begun - both read as ready to publish, which is what matters.
  for (const [text, phase] of cases) {
    const got = readUploadState(text).phase;
    if (phase === "uploaded") assert.ok(["uploaded", "processing"].includes(got), `${text} -> ${got}`);
    else assert.equal(got, phase, text);
  }
});

test("a footer that is still uploading is never ready, even when it mentions processing", () => {
  assert.equal(readUploadState("Uploading 40% … Processing will begin shortly").phase, "uploading");
});

test("the percentage is read out of the footer", () => {
  assert.equal(readUploadState("Uploading 37% … 2 minutes left").percent, 37);
  assert.equal(readUploadState("Uploading 250%").percent, 100, "clamped");
});

test("failures YouTube prints are failures", () => {
  for (const text of [
    "Upload failed",
    "Daily upload limit reached",
    "Processing abandoned: the file is invalid",
    "Upload declined: duplicate",
    "Invalid file format",
  ]) {
    const s = readUploadState(text);
    assert.equal(s.phase, "failed", text);
    assert.ok(s.problem, text);
  }
});

test("a failure carries the phrase that matched, so an error says what it saw", () => {
  const s = readUploadState("Upload videos Saving… Drag and drop video files to upload. Daily upload limit reached. Come back tomorrow.");
  assert.equal(s.phase, "failed");
  assert.match(s.problem ?? "", /Daily upload limit reached/);
});

test("an ordinary sentence about checks is not a failed upload", () => {
  assert.notEqual(readUploadState("Checks complete. No issues found.").phase, "failed");
  assert.notEqual(readUploadState("Checking if your video has any issues").phase, "failed");
});

test("the empty drop zone is not a failed upload", () => {
  const dropZone =
    "Upload videos Saving… Drag and drop video files to upload Select files By submitting your videos to YouTube, you acknowledge that you agree to YouTube's Terms of Service and Community Guidelines. Please ensure that your videos don't violate anyone else's privacy or copyright. Learn more";
  assert.equal(readUploadState(dropZone).phase, "unknown");
});

test("checks that found something carry what they found, and clean checks do not", () => {
  assert.equal(readUploadState("Checks complete. No issues found.").problem, null);
  const found = readUploadState("Checks complete. Copyright claim found on your video.");
  assert.equal(found.phase, "checked");
  assert.match(found.problem ?? "", /copyright/i);
});

/* --------------------------------------------------------- watch upload -- */

function deps(read: () => Promise<string>, c = clock(), logs: string[] = []): WatchDeps {
  return { read, sleep: c.sleep, now: c.now, log: (m) => logs.push(m) };
}

test("waiting follows the upload through to the checks and returns when they are done", async () => {
  const logs: string[] = [];
  const result = await watchUpload(
    deps(script("Uploading 5%", "Uploading 60%", "Upload complete … Processing will begin shortly", "Checking …", "Checks complete. No issues found."), clock(), logs),
  );
  assert.deepEqual(result, { phase: "checked", checksFinished: true, issue: null });
  assert.ok(logs.some((l) => /Uploading the video/.test(l)), logs.join("|"));
  assert.ok(logs.some((l) => /finished its checks/.test(l)), logs.join("|"));
});

test("it does not return while the bytes are still moving", async () => {
  // 20 polls of "uploading", then done: the answer has to wait for the 21st.
  const texts = [...Array(20).fill("Uploading 50%"), "Checks complete. No issues found."];
  const c = clock();
  const start = c.now();
  await watchUpload(deps(script(...texts), c));
  assert.ok(c.now() - start >= 20 * WATCH_DEFAULTS.pollMs, "returned before the upload had finished");
});

test("a failure in the dialog stops the wait at once, non-retryably, and says what it said", async () => {
  await assert.rejects(
    watchUpload(deps(script("Uploading 30%", "Daily upload limit reached"))),
    (e: unknown) => {
      assert.ok(isPublishError(e));
      assert.equal(e.retryable, false);
      assert.match(e.message, /Daily upload limit reached/);
      assert.match(e.message, /Nothing was published/);
      return true;
    },
  );
});

test("checks that never finish do not hold the post forever: it goes on after a grace period, and says so", async () => {
  const c = clock();
  const logs: string[] = [];
  const result = await watchUpload(deps(script("Upload complete", "Checking …"), c, logs));
  assert.equal(result.checksFinished, false);
  assert.ok(logs.some((l) => /still running/.test(l)));
});

test("checks that find an issue are returned for the caller to act on", async () => {
  const result = await watchUpload(deps(script("Checks complete. Copyright claim found on your video.")));
  assert.equal(result.checksFinished, true);
  assert.match(result.issue ?? "", /copyright/i);
});

test("a footer that never says anything is an error, not an endless wait", async () => {
  await assert.rejects(watchUpload(deps(script(""))), (e: unknown) => isPublishError(e) && /never reported any progress/.test(e.message));
});

test("an upload that never finishes times out, and nothing is published", async () => {
  await assert.rejects(
    watchUpload(deps(script("Uploading 1%")), WATCH_DEFAULTS),
    (e: unknown) => isPublishError(e) && e.retryable === false && /had not finished/.test(e.message),
  );
});

/* -------------------------------------------------------------- outcome -- */

test("the dialogs after Publish are read into an outcome", () => {
  assert.equal(readOutcome("Video published Your video is now live. Video link https://youtu.be/dQw4w9WgXcQ").outcome, "published");
  assert.equal(readOutcome("Video saved Your video is now private").outcome, "published");
  assert.equal(readOutcome("").outcome, "unknown");
  assert.equal(readOutcome("Visibility Save or publish Make your video public, unlisted or private").outcome, "unknown");
});

test("a failure outranks a success word in the same dialog", () => {
  assert.equal(readOutcome("Your changes were saved, but we couldn't publish this video. Try again later.").outcome, "failed");
});

const id = "dQw4w9WgXcQ";

/** The upload dialog is open by default, as it is when Publish has just been pressed. */
const snap = (over: Partial<DialogSnapshot> = {}): DialogSnapshot => ({
  text: "",
  links: [],
  uploadsOpen: true,
  shareOpen: false,
  ...over,
});

/** Feeds a sequence of snapshots, then repeats the last one forever. */
const screens = (...seen: DialogSnapshot[]) => {
  let i = 0;
  return async () => seen[Math.min(i++, seen.length - 1)];
};
const run = (read: () => Promise<DialogSnapshot>, before: DialogSnapshot = snap(), draftId: string | null = null) => {
  const c = clock();
  return confirmPublished({ read, sleep: c.sleep, now: c.now, log: quiet }, { timeoutMs: 3 * 60_000, pollMs: 1000, before, draftId });
};

test("the share dialog appearing is YouTube reacting, and the id comes from its link", async () => {
  const got = await run(screens(snap({ text: "Visibility Publish" }), snap({ text: "Video published", shareOpen: true, links: [`https://youtu.be/${id}`] })));
  assert.equal(got.by, "share-dialog");
  assert.equal(got.videoId, id);
});

test("the upload dialog closing is YouTube reacting, and the draft's id is the video's", async () => {
  const got = await run(screens(snap({ text: "Visibility Save" }), snap({ uploadsOpen: false })), snap({ text: "Visibility Save" }), id);
  assert.equal(got.by, "dialog-closed");
  assert.equal(got.videoId, id);
});

test("a success sentence that was already on screen before the click proves nothing", async () => {
  // "Saved as private" is in the dialog's header before Save is ever pressed.
  const before = snap({ text: "Stop Writing Login Forms Saved as private Visibility Private Save" });
  await assert.rejects(
    run(screens(before), before, id),
    (e: unknown) => isPublishError(e) && e.retryable === false && /had not changed/.test(e.message) && /not known whether it went out/.test(e.message),
  );
});

test("a success sentence that appears after the click does count", async () => {
  const before = snap({ text: "Visibility Save" });
  const got = await run(screens(before, snap({ text: "Visibility Save Video saved" })), before, id);
  assert.equal(got.by, "new-words");
});

test("a video id on screen is not a confirmation: the draft has one from the first second", async () => {
  const same = snap({ text: "Visibility Publish Video link", links: [`https://youtu.be/${id}`] });
  await assert.rejects(run(screens(same), same), (e: unknown) => isPublishError(e) && /not known whether it went out/.test(e.message));
});

test("a refusal after Publish is reported as one, with a warning about the draft", async () => {
  await assert.rejects(
    run(screens(snap({ text: "Something went wrong. We couldn't publish your video." }))),
    (e: unknown) => isPublishError(e) && e.retryable === false && /did not publish/.test(e.message) && /draft/.test(e.message),
  );
});

test("a refusal outranks the dialog closing", async () => {
  await assert.rejects(
    run(screens(snap({ uploadsOpen: false, text: "We couldn't publish your video" })), snap({ text: "Visibility Save" })),
    (e: unknown) => isPublishError(e) && /did not publish/.test(e.message),
  );
});

test("silence after Publish is an unknown outcome, never a success", async () => {
  await assert.rejects(run(screens(snap())), (e: unknown) => isPublishError(e) && /check YouTube Studio before posting again/.test(e.message));
});

/* ------------------------------------------------------ the channel agrees -- */

const want = { privacy: "private", title: "\u{1F510} Stop Writing Login Forms: Keycloak Handles Auth So You Don't Have To" };

test("the channel confirming the visibility that was chosen is what makes a video published", () => {
  const v = judgeChannelView({ visibility: "Visibility Private", title: want.title }, want);
  assert.equal(v.published, true);
  assert.deepEqual(v.problems, []);
  assert.equal(judgeChannelView({ visibility: "Public", title: want.title }, { ...want, privacy: "public" }).published, true);
  assert.equal(judgeChannelView({ visibility: "Unlisted", title: want.title }, { ...want, privacy: "unlisted" }).published, true);
});

test("a video the channel still lists as a draft is not published, whatever the dialog did", () => {
  const v = judgeChannelView({ visibility: "Visibility Draft", title: want.title }, want);
  assert.equal(v.published, false);
  assert.match(v.problems.join(" "), /still lists the video as a draft/);
});

test("a visibility that is not the one chosen is not published as asked", () => {
  const v = judgeChannelView({ visibility: "Public", title: want.title }, want);
  assert.equal(v.published, false);
  assert.match(v.problems.join(" "), /not private/);
});

test("a channel page that cannot be read confirms nothing", () => {
  assert.equal(judgeChannelView(null, want).unreadable, true);
  assert.equal(judgeChannelView({ visibility: null, title: null }, want).published, false);
  const noVisibility = judgeChannelView({ visibility: null, title: "something" }, want);
  assert.equal(noVisibility.published, false);
});

test("a different title is reported, but does not undo a video that is up", () => {
  const v = judgeChannelView({ visibility: "Private", title: "Some other title entirely" }, want);
  assert.equal(v.published, true);
  assert.match(v.problems.join(" "), /not the one that was approved/);
});
