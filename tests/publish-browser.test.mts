import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "../src/lib/db";
import { isAppError } from "../src/lib/errors";
import { RENDER_DIR, WORK_ROOT } from "../src/lib/paths";
import { reapStaleRuns } from "../src/lib/reap";
import { serializeThumbnails, type ThumbSpec } from "../src/lib/thumbnails";
import { thumbsDir, THUMB_KEYS } from "../src/lib/thumbnails/types";
import {
  PUBLISH_STATUSES,
  browserHolds,
  instagramCaption,
  isInFlight,
  isPublishMode,
  isPublished,
  type PublishMetadata,
} from "../src/lib/publish/limits";
import { platformStatus, type PlatformState } from "../src/lib/publish/view";
import type { PreparedPublish, PublishOutcome } from "../src/lib/publish/contract";
import { browserModeFor, browserPublisherFor, hasBrowserPublisher, hasRealPublisher, publisherFor } from "../src/lib/publish/registry";
import { manualHandoff } from "../src/lib/publish/manual";
import { publishView } from "../src/lib/publish/state";
import { studioUrlFor } from "../src/lib/publish/youtube/config";
import { startYouTubePublish } from "../src/lib/publish/youtube/run";
import { startInstagramPublish } from "../src/lib/publish/instagram/run";
import {
  CDP_ENV,
  CHANNEL_ENV,
  MIN_SCHEDULE_LEAD_MS,
  NeedsHuman,
  browserChannel,
  browserOptionProblems,
  browserProblem,
  cdpEndpoint,
  cdpEndpointProblem,
  chromiumProblem,
  desiredVisibility,
  igNativeScheduleEnabled,
  isHeadless,
  isProfileInUse,
  judgePage,
  launchOptionsFor,
  locateBrowserChannel,
  locateChromium,
  openSession,
  profileBusyMessage,
  profileDirFor,
  runInSession,
  type BrowserPublishOptions,
  type BrowserPublisher,
  type PageSnapshot,
} from "../src/lib/publish/browser/engine";
import { acquirePlatformLock, closeLeftOpenWindow, hasLeftOpenWindow, isBrowserJobLive, isPlatformBusy, markLive, unmarkLive } from "../src/lib/publish/browser/live";
import { openSignInWindow, signInArgv, startDetached } from "../src/lib/publish/browser/signin";
import { interruptedMessage, recoverInterruptedBrowserJobs } from "../src/lib/publish/browser/recover";
import { rowFor, startBrowserPublish } from "../src/lib/publish/browser/run";
import {
  YT,
  browserYouTubePublisher,
  channelIdFrom,
  handleFromChannelUrl,
  judgeReadback,
  parseScheduledText,
  sameSchedule,
  studioDateText,
  studioTimeText,
  videoIdFrom,
  visibilityWord,
} from "../src/lib/publish/browser/youtube";
import {
  IG,
  browserInstagramPublisher,
  captionHead,
  handleFromAlt,
  newShortcodes,
  readShareState,
  shortcodeFrom,
} from "../src/lib/publish/browser/instagram";
import * as cardModule from "../src/components/BrowserPublish";
import { ToastHost } from "../src/components/Toast";
import { strings } from "../src/lib/strings";
import { FakePage, fakeBrowser, fakeChrome, fakeSpawner } from "./helpers/fake-browser.mjs";
import { reviewStudioVideo } from "../src/lib/publish/browser/youtube-review";
import { requireIsolation } from "./setup/isolation";

/**
 * The browser-window publishers, tested against SCRIPTED PAGES and never a real
 * site.
 *
 * NOTHING IN THIS FILE OPENS A WINDOW, SIGNS IN, OR TOUCHES YOUTUBE OR INSTAGRAM.
 * The browser is `tests/helpers/fake-browser.mts`: a fake `PageLike` keyed by the
 * same selector strings the publishers use, on a clock that only advances when
 * something sleeps.
 *
 * WHAT THAT PROVES: the decisions. That nothing is recorded as posted without a
 * read-back from the platform's own page; that a sign-in or a security check
 * stops the job without the page being touched; that a wrong account is refused;
 * that a restart hands a job to a person and never re-runs it; that two jobs
 * never post one episode.
 *
 * WHAT IT DOES NOT, and the report says so: that any selector matches today's
 * YouTube Studio or Instagram, or that either site accepts what is sent. No
 * account is signed in anywhere in this build, so no live flow has been seen.
 */

const BROWSER_DIR = fileURLToPath(new URL("../src/lib/publish/browser/", import.meta.url));

/** Comments say things about stealth and challenges; code does them. Only the code is the claim. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

const META: PublishMetadata = {
  title: "Productivity Isn't Hustle",
  description: "What the book actually says about attention.",
  hashtags: ["#focus", "#deepwork"],
  hook: "Most people are busy.",
  tags: ["focus", "attention"],
};

function prepared(platform: "youtube" | "instagram" = "youtube", metadata: PublishMetadata = META): PreparedPublish {
  return {
    platform,
    episodeId: "e1",
    metadata,
    video: { path: "/work/renders/e1.mp4", bytes: 9000, url: "/api/episodes/e1/video", contentType: "video/mp4" },
    poster: { path: "/work/thumbs/e1.jpg", bytes: 12, url: "/api/thumb", contentType: "image/jpeg" },
    preparedAt: new Date(),
    status: "READY",
    handoff: [],
  };
}

/** By name, not `instanceof`: the app reaches this module as both `@/lib/errors` and a relative path. */
const isApp = (err: unknown): err is { code: string; status: number; message: string } => isAppError(err);

async function tempRoot(): Promise<string> {
  requireIsolation("these tests create browser-profile directories under the work root");
  return fs.mkdtemp(path.join(WORK_ROOT, "browser-test-"));
}

/** Close whatever window a previous job left open on a platform, the way a Retry does. */
async function closeLeftOpen(platform: "youtube" | "instagram", root: string): Promise<void> {
  const session = await openSession(platform, fakeBrowser(new FakePage(), { profileRoot: root }).deps);
  await session.finish({ leaveOpen: false });
}

// ------------------------------------------------------------------ a scripted YouTube Studio

// This suite drives only scripted browsers; enable the gate inside its test process.
process.env.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED = "1";

const CHANNEL_ID = `UC${"a".repeat(22)}`;
const VIDEO_ID = "abcdefghijk";

interface YtScript {
  signedOut?: boolean;
  challengeUrl?: boolean;
  /** Text of a dialog laid over the app. */
  dialogText?: string;
  /** What the channel URL redirects to. `null` = it does not redirect at all. */
  handle?: string | null;
  noThumbControl?: boolean;
  nextDisabled?: boolean;
  finalLabel?: string;
  neverSettles?: boolean;
  noVideoLink?: boolean;
  readTitle?: string;
  readVisibility?: string;
  editLoads?: boolean;
  scheduleReadback?: { date: string; time: string };
}

function youtubeSite(o: YtScript = {}) {
  const page = new FakePage();
  const s = {
    stage: "home" as "home" | "menu" | "chooser" | "details" | "elements" | "checks" | "visibility" | "saved",
    title: "",
    description: "",
    kids: null as "yes" | "no" | null,
    vis: null as "private" | "unlisted" | "public" | "scheduled" | null,
    tags: [] as string[],
    tagDraft: "",
    tagsOpen: false,
    thumb: false,
    schedOpen: false,
    datePicker: false,
    dateText: "",
    timeText: "",
    pressed: 0,
  };
  const inDialog = () =>
    ["chooser", "details", "elements", "checks", "visibility"].includes(s.stage) || (s.stage === "saved" && !!o.neverSettles);
  const atDetails = () => s.stage === "details";
  const onEdit = () => page.currentUrl === studioUrlFor(VIDEO_ID) && o.editLoads !== false;
  const loggedIn = () => !page.currentUrl.includes("accounts.google.com");
  const checked = (want: string) => () => (s.kids === want || s.vis === want ? "true" : "false");
  const labelFor = () => o.finalLabel ?? (s.vis === "scheduled" ? "Schedule" : s.vis === "private" ? "Save" : "Publish");

  page.def(YT.appShell, { visible: () => loggedIn() });
  page.def(YT.dialog, { visible: () => !!o.dialogText, text: () => o.dialogText ?? "" });
  page.def("body", { text: "" });
  page.def(YT.createButton, { visible: () => s.stage === "home" && loggedIn(), onClick: () => (s.stage = "menu") });
  page.def(YT.uploadItem, { visible: () => s.stage === "menu", onClick: () => (s.stage = "chooser") });
  page.def(YT.fileInput, { visible: false, count: () => (s.stage === "chooser" ? 1 : 0), onFiles: () => (s.stage = "details") });
  page.def(YT.uploadsDialog, { visible: inDialog });
  // The title box is the SAME selector in the upload dialog and on the video's own page.
  page.def(YT.title, {
    visible: () => atDetails() || onEdit(),
    text: () => (onEdit() ? (o.readTitle ?? s.title) : s.title),
    onFill: (v) => (s.title = v),
  });
  page.def(YT.description, { visible: atDetails, text: () => s.description, onFill: (v) => (s.description = v) });
  page.def(YT.thumbnailInput, {
    visible: false,
    count: () => (!o.noThumbControl && atDetails() ? 1 : 0),
    onFiles: () => (s.thumb = true),
  });
  page.def(YT.thumbnailShown, { visible: () => s.thumb });
  page.def(YT.kidsNo, { visible: atDetails, attrs: { "aria-checked": () => (s.kids === "no" ? "true" : "false") }, onClick: () => (s.kids = "no") });
  page.def(YT.kidsYes, { visible: atDetails, attrs: { "aria-checked": () => (s.kids === "yes" ? "true" : "false") }, onClick: () => (s.kids = "yes") });
  page.def(YT.showMore, { visible: () => atDetails() && !s.tagsOpen, onClick: () => (s.tagsOpen = true) });
  page.def(YT.tagsInput, { visible: () => atDetails() && s.tagsOpen, onFill: (v) => (s.tagDraft = v) });
  page.def(YT.tagsBox, { visible: atDetails, text: () => s.tags.join(" ") });
  page.onPress = (key) => {
    if (key === "Enter" && s.tagDraft) {
      s.tags.push(s.tagDraft);
      s.tagDraft = "";
    }
  };
  page.def(YT.next, {
    visible: () => ["details", "elements", "checks"].includes(s.stage),
    enabled: () => !o.nextDisabled,
    onClick: () => {
      s.stage = s.stage === "details" ? "elements" : s.stage === "elements" ? "checks" : "visibility";
    },
  });
  page.def(YT.visibilityGroup, { visible: () => s.stage === "visibility" });
  for (const v of ["private", "unlisted", "public"] as const) {
    page.def(YT.visibility[v], {
      visible: () => s.stage === "visibility",
      attrs: { "aria-checked": () => (s.vis === v ? "true" : "false") },
      onClick: () => (s.vis = v),
    });
  }
  void checked;
  page.def(YT.scheduleExpand, {
    visible: () => s.stage === "visibility",
    onClick: () => {
      s.schedOpen = true;
      s.vis = "scheduled";
    },
  });
  page.def(YT.dateTrigger, {
    visible: () => s.schedOpen,
    text: () => o.scheduleReadback?.date ?? s.dateText,
    onClick: () => (s.datePicker = true),
  });
  page.def(YT.dateInput, { visible: () => s.datePicker, onFill: (v) => (s.dateText = v) });
  page.def(YT.timeInput, {
    visible: () => s.schedOpen,
    value: () => o.scheduleReadback?.time ?? s.timeText,
    onFill: (v) => (s.timeText = v),
  });
  page.def(YT.done, {
    enabled: () => s.stage === "visibility",
    text: labelFor,
    onClick: () => {
      s.pressed++;
      s.stage = "saved";
    },
  });
  page.def(YT.shareDialog, { visible: () => s.stage === "saved" && !o.neverSettles && s.vis !== "private" });
  if (!o.noVideoLink) {
    page.def(YT.videoLink, {
      visible: () => ["details", "elements", "checks", "visibility", "saved"].includes(s.stage),
      attrs: { href: `https://youtu.be/${VIDEO_ID}` },
      text: `https://youtu.be/${VIDEO_ID}`,
    });
  }
  page.def(YT.editVisibility, {
    visible: onEdit,
    text: () =>
      o.readVisibility ??
      (s.vis === "scheduled"
        ? `Scheduled ${s.dateText}, ${s.timeText}`
        : s.vis === "public"
          ? "Public"
          : s.vis === "unlisted"
            ? "Unlisted"
            : "Private"),
  });

  page.onGoto = (url, p) => {
    if (url === YT.studio) {
      if (o.signedOut) p.currentUrl = "https://accounts.google.com/v3/signin/identifier?service=youtube";
      else if (o.challengeUrl) p.currentUrl = "https://accounts.google.com/signin/v2/challenge/pwd";
      else p.currentUrl = `https://studio.youtube.com/channel/${CHANNEL_ID}`;
    } else if (url.startsWith("https://www.youtube.com/channel/")) {
      if (o.handle !== null) p.currentUrl = `https://www.youtube.com/${o.handle ?? "@betweenpages08-l4d"}`;
    }
  };
  return { page, s };
}

async function publishYouTube(
  script: YtScript,
  options: BrowserPublishOptions,
  root: string,
  env: Record<string, string | undefined> = {},
) {
  const site = youtubeSite(script);
  const fake = fakeBrowser(site.page, { profileRoot: root, env });
  const outcome = await browserYouTubePublisher({ env, options, deps: fake.deps }).publish(prepared("youtube"));
  return { outcome, ...site, ...fake };
}

// ------------------------------------------------------------------ a scripted Instagram

const NEW_CODE = "Cabc12345xyz";

interface IgScript {
  signedOut?: boolean;
  /** Text of a dialog laid over the app before anything is done. */
  dialogText?: string;
  handle?: string | null;
  /** What the page says after Share is pressed. */
  after?: "shared" | "never" | "needs_human" | "failed";
  /** Whether a new reel appears on the profile after sharing. */
  newReel?: boolean;
  /** What the new reel's page says. Defaults to the caption that was typed. */
  reelText?: string;
}

function instagramSite(o: IgScript = {}) {
  const page = new FakePage();
  const s = {
    stage: "home" as "home" | "menu" | "chooser" | "crop" | "edit" | "caption" | "shared",
    caption: "",
    pressed: 0,
  };
  const loggedIn = () => !page.currentUrl.includes("/accounts/login");
  const links = () => (s.stage === "shared" && o.newReel !== false ? [NEW_CODE, "Aold11111", "Aold22222"] : ["Aold11111", "Aold22222"]);
  const dialog = () => {
    if (o.dialogText && s.stage !== "shared") return o.dialogText;
    if (s.pressed > 0) {
      if (o.after === "needs_human") return "Confirm it's you. We detected unusual activity on your account.";
      if (o.after === "failed") return "Something went wrong. Your reel couldn't be shared.";
      if (o.after === "never") return "Sharing";
      return "Your reel has been shared.";
    }
    return "";
  };

  page.def(IG.appShell, { visible: () => loggedIn() });
  page.def(IG.dialog, { visible: () => dialog() !== "", text: dialog });
  page.def("body", { text: () => (page.currentUrl.includes(`/reel/${NEW_CODE}`) ? (o.reelText ?? s.caption) : "some other reel") });
  page.def(IG.notNow, { visible: false });
  page.def(IG.profilePicture, {
    visible: () => loggedIn(),
    attrs: { alt: o.handle === null ? null : `${o.handle ?? "between_pages"}'s profile picture` },
  });
  page.def(IG.reelLinks, { count: () => links().length, items: () => links().map((c) => ({ attrs: { href: `/reel/${c}/` } })) });
  page.def(IG.newPost, { visible: () => s.stage === "home" && loggedIn(), onClick: () => (s.stage = "menu") });
  page.def(IG.postItem, { visible: false });
  page.def(IG.fileInput, { visible: false, count: () => (s.stage === "menu" ? 1 : 0), onFiles: () => (s.stage = "crop") });
  page.def(IG.next, {
    visible: () => s.stage === "crop" || s.stage === "edit",
    onClick: () => (s.stage = s.stage === "crop" ? "edit" : "caption"),
  });
  page.def(IG.coverSelect, { visible: () => s.stage === "edit" });
  page.def(IG.caption, { visible: () => s.stage === "caption", text: () => s.caption, onFill: (v) => (s.caption = v) });
  page.def(IG.share, {
    visible: () => s.stage === "caption",
    onClick: () => {
      s.pressed++;
      if (o.after !== "never" && o.after !== "needs_human" && o.after !== "failed") s.stage = "shared";
    },
  });
  page.onGoto = (url, p) => {
    if (url === IG.home) p.currentUrl = o.signedOut ? "https://www.instagram.com/accounts/login/" : IG.home;
  };
  return { page, s };
}

async function publishInstagram(script: IgScript, options: BrowserPublishOptions, root: string, mediaFailure?: "crop" | "cover") {
  const site = instagramSite(script);
  const fake = fakeBrowser(site.page, { profileRoot: root });
  const outcome = await browserInstagramPublisher({ options, deps: fake.deps, mediaControls: {
    crop: async () => { if (mediaFailure === "crop") throw new Error("Original could not be selected"); site.page.actions.push("crop:Original"); },
    cover: async (_page, file) => { if (mediaFailure === "cover") throw new Error("Selected cover not applied"); site.page.actions.push(`chooser:${file}`); return true; },
  } }).publish(prepared("instagram"));
  return { outcome, ...site, ...fake };
}

// ======================================================================= NO EVASION

test("GUARD: the browser is launched with Playwright's defaults and NO stealth or anti-detection option", () => {
  for (const env of [{}, { BOOKREEL_PUBLISH_HEADLESS: "1" }, { BOOKREEL_PUBLISH_HEADLESS: "true" }]) {
    const options = launchOptionsFor(env);
    // EXACTLY these keys when no channel is asked for. Adding any other --
    // `args`, `userAgent`, `ignoreDefaultArgs`, `executablePath`, a locale, a
    // timezone -- is a decision about how the browser presents itself, and fails
    // here. (`channel` is the one permitted addition, and only when
    // BOOKREEL_PUBLISH_BROWSER_CHANNEL asks for it: see the CHANNEL tests below.)
    // `chromiumSandbox` is the other: it is a SECURITY setting (sandbox ON),
    // never a disguise -- it keeps Playwright from passing `--no-sandbox`.
    assert.deepEqual(Object.keys(options).sort(), ["chromiumSandbox", "headless", "timeout", "viewport"]);
    // The sandbox is ON. Playwright's default (false) would pass `--no-sandbox`,
    // degrading the browser and warning in the window; true removes that flag.
    assert.equal(options.chromiumSandbox, true, "the Chromium sandbox must be enabled, so --no-sandbox is never passed");
    const wire = JSON.stringify(options);
    for (const forbidden of [
      "AutomationControlled",
      "disable-blink-features",
      "enable-automation",
      "no-sandbox",
      "userAgent",
      "ignoreDefaultArgs",
      "args",
      "stealth",
    ]) {
      assert.ok(!wire.includes(forbidden), `the launch options must not contain ${forbidden}`);
    }
  }
  // Headful by default, so a person can sign in and clear any security check.
  assert.equal(launchOptionsFor({}).headless, false);
  assert.equal(launchOptionsFor({ BOOKREEL_PUBLISH_HEADLESS: "1" }).headless, true);
  assert.equal(isHeadless({ BOOKREEL_PUBLISH_HEADLESS: "off" }), false, "an unrecognised value does not hide the window");
  assert.equal(isHeadless({ BOOKREEL_PUBLISH_HEADLESS: " TRUE " }), true);
});

test("GUARD: what openSession actually hands the launcher is those options and a fresh, empty, per-platform profile", async () => {
  const root = await tempRoot();
  try {
    const a = fakeBrowser(new FakePage(), { profileRoot: root });
    const b = fakeBrowser(new FakePage(), { profileRoot: root });
    const sy = await openSession("youtube", a.deps);
    const si = await openSession("instagram", b.deps);

    assert.deepEqual(Object.keys(a.launches[0].options).sort(), ["chromiumSandbox", "headless", "timeout", "viewport"]);
    assert.deepEqual(a.launches[0].options, launchOptionsFor({}));

    // Separate directories per platform, under the work root's browser-profiles.
    assert.notEqual(a.launches[0].profileDir, b.launches[0].profileDir);
    assert.equal(a.launches[0].profileDir, profileDirFor("youtube", root));
    assert.equal(b.launches[0].profileDir, profileDirFor("instagram", root));
    assert.ok(a.launches[0].profileDir.startsWith(path.join(root, "browser-profiles")));
    // Fresh and EMPTY: nothing was copied in from anywhere.
    assert.deepEqual(await fs.readdir(a.launches[0].profileDir), []);
    assert.deepEqual(await fs.readdir(b.launches[0].profileDir), []);
    // And the default root is this app's work root, not another project's directory.
    assert.ok(profileDirFor("youtube").startsWith(WORK_ROOT));
    assert.ok(profileDirFor("youtube").endsWith(path.join("browser-profiles", "youtube")));

    await sy.finish({ leaveOpen: false });
    await si.finish({ leaveOpen: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GUARD: the browser folder has no stealth, no humanised input, no session copying -- in code or in file names", async () => {
  const names = (await fs.readdir(BROWSER_DIR)).filter((n) => n.endsWith(".ts"));
  assert.ok(names.includes("engine.ts") && names.includes("native-instagram.ts") && names.includes("youtube-schedule.ts"));
  for (const name of names) {
    assert.doesNotMatch(name, /human|stealth|evad|jitter|detect|session|cookie|profile-copy/i, `${name}: a module named like that is out of scope`);
  }

  const forbidden: Array<[RegExp, string]> = [
    [/AutomationControlled/i, "the blink-features automation flag"],
    [/disable-blink-features/i, "a Chromium feature-disabling launch flag"],
    [/enable-automation/i, "the automation switch"],
    [/ignoreDefaultArgs/, "overriding Playwright's default arguments"],
    [/\buserAgent\b|user-agent/i, "a spoofed user agent"],
    [/addInitScript|evaluateOnNewDocument/, "an injected page script"],
    [/webdriver/i, "navigator.webdriver patching"],
    [/stealth|puppeteer-extra|playwright-extra/i, "a stealth plugin"],
    [/Math\.random\s*\(/, "randomised timing or movement"],
    [/\.mouse\b/, "pointer movement"],
    [/\bdelay\s*:/, "a typing delay"],
    [/jitter|humaniz|bezier/i, "human imitation"],
    [/storageState|addCookies|\.cookies\s*\(|document\.cookie/, "reading or copying a session"],
    [/reporeel/i, "code or profiles lifted from another project"],
    [/\bargs\s*:/, "extra launch arguments"],
    [/\bexecutablePath\s*:/, "pointing the launch at an arbitrary program instead of a named, installed browser"],
    [/setExtraHTTPHeaders|extraHTTPHeaders/, "spoofed headers"],
    [/solveCaptcha|bypass|2captcha|anti-?captcha/i, "solving or bypassing a challenge"],
    // The attach path talks to a debugging PORT. It never looks inside the operator's Chrome profile.
    [/DevToolsActivePort|User Data|Login Data|Local State/, "reading the operator's Chrome profile"],
  ];
  for (const name of names) {
    const code = withoutComments(await fs.readFile(path.join(BROWSER_DIR, name), "utf8"));
    for (const [pattern, what] of forbidden) {
      assert.doesNotMatch(code, pattern, `${name} contains ${what}`);
    }
  }

  // Exactly one place launches a browser, and it passes the typed options through.
  const launchers: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name) && /launchPersistentContext\s*\(/.test(withoutComments(await fs.readFile(full, "utf8")))) {
        launchers.push(path.relative(path.join(BROWSER_DIR, ".."), full).replace(/\\/g, "/"));
      }
    }
  };
  await walk(path.join(BROWSER_DIR, ".."));
  assert.deepEqual(launchers, ["browser/engine.ts"]);
  const engine = withoutComments(await fs.readFile(path.join(BROWSER_DIR, "engine.ts"), "utf8"));
  assert.match(engine, /launchPersistentContext\(profileDir,\s*options\)/, "the launch passes the typed LaunchOptions and nothing else");

  // `channel` -- WHICH installed browser opens -- is the one permitted addition to those options.
  // It is a closed list, it enters the options in exactly one way, and nothing else is added beside it.
  assert.match(engine, /export type BrowserChannel = "chrome" \| "msedge";/, "a channel is chrome or msedge, never a free string or a path");
  const optionsFn = /export function launchOptionsFor[\s\S]*?\n\}\n/.exec(engine)?.[0] ?? "";
  assert.ok(optionsFn.length > 100, "found launchOptionsFor");
  assert.match(optionsFn, /\.\.\.\(channel \? \{ channel \} : \{\}\)/, "channel is spread in only when asked for");
  assert.deepEqual(
    [...optionsFn.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]),
    ["headless", "viewport", "timeout", "chromiumSandbox"],
    "the other launch options are still exactly these -- channel aside, only the security-enabling chromiumSandbox",
  );
  for (const name of names.filter((n) => n !== "engine.ts")) {
    assert.doesNotMatch(
      withoutComments(await fs.readFile(path.join(BROWSER_DIR, name), "utf8")),
      /\bchannel\s*:/,
      `${name}: only the engine decides launch options`,
    );
  }

  // The attach path: exactly one place attaches, and it passes the endpoint and
  // three connection settings -- no launch option of any kind exists on that path.
  const attachers: string[] = [];
  for (const name of names) {
    if (/connectOverCDP\s*\(/.test(withoutComments(await fs.readFile(path.join(BROWSER_DIR, name), "utf8")))) attachers.push(name);
  }
  assert.deepEqual(attachers, ["engine.ts"]);
  assert.match(
    engine,
    /chromium\.connectOverCDP\(endpoint,\s*\{\s*isLocal: true,\s*noDefaults: true,\s*timeout: 15_000\s*\}\)/,
    "the attach passes: this computer, no changes to the operator's browser settings, a timeout -- and nothing else",
  );
});

test("GUARD: nothing in the browser flows addresses a credential, a code or a challenge field", async () => {
  // The only things the flows ever type into are the platform's own metadata
  // fields. There is no credential, code or answer field anywhere in them.
  for (const name of ["youtube.ts", "instagram.ts"]) {
    const code = withoutComments(await fs.readFile(path.join(BROWSER_DIR, name), "utf8"));
    assert.doesNotMatch(
      code,
      /type=["']?password|name=["']?(username|email|password|passwd|otp|code|verificationCode)\b|#identifierId|#password|#totpPin|recaptcha/i,
      `${name}: no credential or challenge field is addressed`,
    );
  }
});

// ======================================================================= MODE DISPATCH

test("mode dispatch: api is the default, browser is explicit, anything else is the existing behaviour", () => {
  const api = publisherFor("youtube");
  assert.equal(api.capabilities().canSchedule, true, "the API implements native scheduled publishing");
  assert.ok(api.capabilities().requires.some((r) => /Google Cloud/.test(r)));

  // Explicit "api" is the same provider as no mode at all.
  assert.deepEqual(publisherFor("youtube", { mode: "api" }).capabilities(), api.capabilities());
  assert.deepEqual(publisherFor("instagram", { mode: "api" }).capabilities(), publisherFor("instagram").capabilities());
  // An unrecognised mode is NOT a silent upgrade to browser automation.
  assert.deepEqual(publisherFor("youtube", { mode: "carrier-pigeon" as never }).capabilities(), api.capabilities());

  const browser = publisherFor("youtube", { mode: "browser" });
  assert.equal(browser.capabilities().canUpload, true);
  assert.equal(browser.capabilities().canSchedule, true, "Studio can schedule");
  assert.ok(browser.capabilities().requires.some((r) => /Chromium/.test(r)));
  assert.ok(!browser.capabilities().requires.some((r) => /Google Cloud/.test(r)));

  const ig = publisherFor("instagram", { mode: "browser" });
  assert.equal(ig.capabilities().canUpload, true);
  assert.equal(ig.capabilities().canSchedule, false, "Instagram's web uploader is not driven for a schedule, and none is faked");
  assert.equal(publisherFor("instagram").capabilities().canUpload, false, "the API Instagram provider, unconnected, is still the hand-off");

  assert.equal(hasBrowserPublisher("youtube"), true);
  assert.equal(hasBrowserPublisher("instagram"), true);
  // The API providers are still the answer to "is there a real provider", and the
  // hand-off is untouched.
  assert.equal(hasRealPublisher("youtube"), true);
  assert.equal(browserPublisherFor("youtube")?.capabilities().id, "youtube");
  assert.equal(manualHandoff("youtube").capabilities().canUpload, false);
});

test("mode dispatch: the browser provider reports itself unconfigured, rather than falling back to the API, when there is no Chromium", async () => {
  const none = { browser: { deps: { locate: () => null } }, mode: "browser" as const };
  const provider = publisherFor("youtube", none);
  assert.equal(await provider.isConfigured(), false);
  assert.equal(provider.capabilities().canSchedule, true, "it is still the browser provider, not the API one");

  const view = await browserModeFor("youtube", { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, browser: { deps: { locate: () => null } } });
  assert.equal(view?.available, false);
  assert.match(view?.reason ?? "", /No Chromium was found/);
  const ok = await browserModeFor("instagram", { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, browser: { deps: { locate: () => "C:/chrome.exe" } } });
  assert.equal(ok?.available, true);
  assert.equal(ok?.reason, null);
  assert.equal(ok?.canSchedule, false);

  // And publishing through it says nothing was sent -- no window, no launch.
  const page = new FakePage();
  const root = await tempRoot();
  try {
    const fake = fakeBrowser(page, { profileRoot: root, chromium: false });
    const outcome = await browserYouTubePublisher({ options: { madeForKids: false }, deps: fake.deps }).publish(prepared());
    assert.equal(outcome.status, "REQUIRES_CONNECTION");
    assert.equal(fake.launches.length, 0, "no browser was launched");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the status vocabulary names AWAITING_HUMAN and SCHEDULED, and neither is a success or in flight", () => {
  assert.ok((PUBLISH_STATUSES as readonly string[]).includes("AWAITING_HUMAN"));
  assert.ok((PUBLISH_STATUSES as readonly string[]).includes("SCHEDULED"));
  assert.equal(isPublished("AWAITING_HUMAN"), false);
  assert.equal(isPublished("SCHEDULED"), false, "a scheduled post is not live");
  assert.equal(isInFlight("AWAITING_HUMAN"), false);
  assert.equal(isPublishMode("browser"), true);
  assert.equal(isPublishMode("api"), true);
  assert.equal(isPublishMode("BROWSER"), false);
  // Recorded facts: a local re-check may not turn them back into READY.
  const ready = { ready: true, issues: [] };
  assert.equal(platformStatus(ready, true, "AWAITING_HUMAN"), "AWAITING_HUMAN");
  assert.equal(platformStatus(ready, true, "SCHEDULED"), "SCHEDULED");
  assert.equal(platformStatus(ready, false, "AWAITING_HUMAN"), "AWAITING_HUMAN");
  // The routes ask this before starting, so the two routes never both post one episode.
  assert.equal(browserHolds({ mode: "browser", status: "PREPARING" }), true);
  assert.equal(browserHolds({ mode: "browser", status: "AWAITING_HUMAN" }), true);
  assert.equal(browserHolds({ mode: "browser", status: "PUBLISHED" }), false);
  assert.equal(browserHolds({ mode: "api", status: "PREPARING" }), false);
  assert.equal(browserHolds({ mode: null, status: "AWAITING_HUMAN" }), false, "a row from before the column is an API row");
  assert.equal(browserHolds(null), false);
});

// ======================================================================= PURE JUDGEMENT

const shell = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: "https://studio.youtube.com/channel/UC",
  title: "Channel dashboard",
  bodyText: "",
  dialogText: "",
  hasAppShell: true,
  ...over,
});

test("judgePage: a working app, a sign-in and a security check are three different things", () => {
  assert.deepEqual(judgePage("youtube", shell()), { kind: "ok" });
  assert.equal(judgePage("youtube", shell({ url: "https://accounts.google.com/v3/signin/identifier", hasAppShell: false })).kind, "signed_out");
  assert.equal(judgePage("youtube", shell({ url: "https://accounts.google.com/signin/v2/challenge/pwd", hasAppShell: false })).kind, "challenge");
  assert.equal(judgePage("youtube", shell({ url: "https://www.google.com/sorry/index?continue=", hasAppShell: false })).kind, "challenge");
  assert.equal(judgePage("youtube", shell({ hasAppShell: false })).kind, "unknown", "not recognised is not 'fine'");

  // A challenge wins over a sign-in prompt, and over a page that still has its shell.
  assert.equal(judgePage("youtube", shell({ dialogText: "Verify it's you. 2-Step Verification" })).kind, "challenge");
  assert.equal(judgePage("youtube", shell({ hasAppShell: false, bodyText: "Confirm you're not a robot" })).kind, "challenge");
  assert.equal(
    judgePage("youtube", shell({ hasAppShell: false, url: "https://accounts.google.com/v3/signin/identifier", bodyText: "Enter the code we sent" })).kind,
    "challenge",
  );

  const ig = (over: Partial<PageSnapshot>): PageSnapshot => shell({ url: "https://www.instagram.com/", title: "Instagram", ...over });
  assert.deepEqual(judgePage("instagram", ig({})), { kind: "ok" });
  assert.equal(judgePage("instagram", ig({ url: "https://www.instagram.com/accounts/login/", hasAppShell: false })).kind, "signed_out");
  assert.equal(
    judgePage("instagram", ig({ hasAppShell: false, bodyText: "Log into Instagram\nMobile number, username or email\nPassword\nLog in" })).kind,
    "signed_out",
  );
  assert.equal(judgePage("instagram", ig({ url: "https://www.instagram.com/challenge/1234/", hasAppShell: false })).kind, "challenge");
  assert.equal(judgePage("instagram", ig({ dialogText: "Confirm it's you. We detected unusual activity." })).kind, "challenge");
  assert.equal(judgePage("instagram", ig({ dialogText: "Turn on notifications" })).kind, "ok", "an ordinary prompt is not a challenge");
});

test("judgeReadback: only the platform's own page, saying the right thing, can pass", () => {
  const expected = { title: META.title, visibility: "private" as const, scheduledAt: null };
  const ok = judgeReadback(expected, { title: `  ${META.title} `, visibilityText: "Private" });
  assert.deepEqual(ok, { ok: true, visibility: "private", scheduledFor: null });

  const bad = (read: Parameters<typeof judgeReadback>[1], e: Parameters<typeof judgeReadback>[0] = expected) => {
    const v = judgeReadback(e, read);
    assert.equal(v.ok, false);
    return v.ok ? "" : v.problem;
  };
  assert.match(bad({ title: null, visibilityText: "Private" }), /did not show its title/);
  assert.match(bad({ title: "", visibilityText: "Private" }), /did not show its title/);
  assert.match(bad({ title: "Something else", visibilityText: "Private" }), /not the one that was sent/);
  assert.match(bad({ title: META.title, visibilityText: null }), /did not say whether/);
  assert.match(bad({ title: META.title, visibilityText: "Draft" }), /did not say whether/);
  assert.match(bad({ title: META.title, visibilityText: "Public" }), /shows the video as public, not private/);
  assert.match(bad({ title: META.title, visibilityText: "Unlisted" }), /unlisted, not private/);

  const when = new Date(2027, 0, 5, 15, 30);
  const sched = { title: META.title, visibility: "scheduled" as const, scheduledAt: when };
  const good = judgeReadback(sched, { title: META.title, visibilityText: "Scheduled Jan 5, 2027, 3:30 PM" });
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.scheduledFor?.getTime(), when.getTime(), "the time is the one READ BACK");
  assert.match(bad({ title: META.title, visibilityText: "Scheduled" }, sched), /could not be read back/);
  assert.match(bad({ title: META.title, visibilityText: "Scheduled Jan 5, 2027, 4:30 PM" }, sched), /not the time that was asked for/);
  assert.match(bad({ title: META.title, visibilityText: "Private" }, sched), /private, not scheduled/);
});

test("the Studio and Instagram readers are exact about what they accept", () => {
  assert.equal(videoIdFrom("https://youtu.be/abcdefghijk"), "abcdefghijk");
  assert.equal(videoIdFrom("https://www.youtube.com/watch?v=abcdefghijk&t=3"), "abcdefghijk");
  assert.equal(videoIdFrom("https://studio.youtube.com/video/abcdefghijk/edit"), "abcdefghijk");
  assert.equal(videoIdFrom("https://youtu.be/short"), null);
  assert.equal(videoIdFrom(null), null);
  assert.equal(channelIdFrom(`https://studio.youtube.com/channel/${CHANNEL_ID}/videos`), CHANNEL_ID);
  assert.equal(channelIdFrom("https://studio.youtube.com/"), null);
  assert.equal(handleFromChannelUrl("https://www.youtube.com/@betweenpages08-l4d/videos"), "@betweenpages08-l4d");
  assert.equal(handleFromChannelUrl(`https://www.youtube.com/channel/${CHANNEL_ID}`), null);

  assert.equal(visibilityWord("Scheduled for Jan 5"), "scheduled");
  assert.equal(visibilityWord("Private"), "private");
  assert.equal(visibilityWord("Draft"), null);

  const when = new Date(2027, 0, 5, 15, 30);
  assert.equal(studioDateText(when), "Jan 5, 2027");
  assert.equal(studioTimeText(when), "3:30 PM");
  assert.equal(parseScheduledText("Jan 5, 2027, 3:30 PM")?.getTime(), when.getTime());
  assert.equal(parseScheduledText("5 Jan 2027 at 15:30")?.getTime(), when.getTime());
  assert.equal(parseScheduledText("Jan 5, 2027"), null, "no time is no schedule");
  assert.equal(parseScheduledText("soon"), null);
  assert.equal(sameSchedule("Jan 5, 2027", "3:30 PM", when), true);
  assert.equal(sameSchedule("Jan 5, 2027", "3:45 PM", when), false);
  assert.equal(sameSchedule("garbage", "3:30 PM", when), false);

  assert.equal(readShareState("Your reel has been shared.").state, "shared");
  assert.equal(readShareState("Sharing…").state, "sharing");
  assert.equal(readShareState("Confirm it's you to continue").state, "needs_human");
  assert.equal(readShareState("Something went wrong").state, "failed");
  assert.equal(readShareState("").state, "unknown");
  assert.equal(readShareState("Is your reel shared yet? Still sharing").state, "sharing", "only Instagram's own sentence counts as shared");
  assert.equal(shortcodeFrom("/reel/Cabc12345xyz/"), "Cabc12345xyz");
  assert.equal(shortcodeFrom("https://www.instagram.com/p/Cabc12345xyz/?x=1"), "Cabc12345xyz");
  assert.equal(shortcodeFrom("/explore/"), null);
  assert.equal(handleFromAlt("between_pages's profile picture"), "between_pages");
  assert.equal(handleFromAlt("a photo"), null);
  assert.deepEqual(newShortcodes(new Set(["a", "b"]), ["n", "a", "n", "b", "m"]), ["n", "m"]);
  assert.equal(captionHead("  Most   people\nare busy. And more and more and more and more text "), "Most people are busy. And more and more ");
});

test("browserOptionProblems: what must be said in so many words, and what is refused outright", () => {
  const now = Date.now();
  const soon = new Date(now + 60 * 60_000);
  const codes = (platform: "youtube" | "instagram", o: BrowserPublishOptions) => browserOptionProblems(platform, o, now).map((x) => x.code);

  // YouTube: the kids declaration is required and never defaulted.
  assert.deepEqual(codes("youtube", {}), ["bad_options"]);
  assert.deepEqual(codes("youtube", { madeForKids: false }), [], "private needs nothing else");
  assert.deepEqual(codes("youtube", { madeForKids: true, visibility: "unlisted" }), []);
  // Anything that goes live is confirmed.
  assert.deepEqual(codes("youtube", { madeForKids: false, visibility: "public" }), ["needs_confirmation"]);
  assert.deepEqual(codes("youtube", { madeForKids: false, scheduledAt: soon }), ["needs_confirmation"]);
  assert.deepEqual(codes("youtube", { madeForKids: false, visibility: "public", confirmPublic: true }), []);
  assert.deepEqual(codes("youtube", { madeForKids: false, scheduledAt: soon, confirmPublic: true }), []);
  // A schedule too close, or not a date, is refused.
  assert.deepEqual(codes("youtube", { madeForKids: false, scheduledAt: new Date(now + MIN_SCHEDULE_LEAD_MS - 1000), confirmPublic: true }), ["bad_options"]);
  assert.deepEqual(codes("youtube", { madeForKids: false, scheduledAt: new Date("nope"), confirmPublic: true }), ["bad_options"]);
  assert.equal(desiredVisibility({ scheduledAt: soon, visibility: "private" }), "scheduled");
  assert.equal(desiredVisibility({}), "private");

  // Instagram: always public, always confirmed, never scheduled.
  assert.deepEqual(codes("instagram", {}), ["needs_confirmation"]);
  assert.deepEqual(codes("instagram", { confirmPublic: true }), []);
  assert.deepEqual(codes("instagram", { confirmPublic: true, scheduledAt: soon }), ["bad_options"]);
  assert.deepEqual(codes("instagram", { confirmPublic: true, visibility: "private" }), ["bad_options"]);
});

test("igNativeScheduleEnabled: a kill-switch that is off unless it is explicitly turned on", () => {
  assert.equal(igNativeScheduleEnabled({}), false, "unset is off");
  assert.equal(igNativeScheduleEnabled({ BOOKREEL_IG_NATIVE_SCHEDULE: "" }), false);
  assert.equal(igNativeScheduleEnabled({ BOOKREEL_IG_NATIVE_SCHEDULE: "0" }), false);
  assert.equal(igNativeScheduleEnabled({ BOOKREEL_IG_NATIVE_SCHEDULE: "false" }), false);
  assert.equal(igNativeScheduleEnabled({ BOOKREEL_IG_NATIVE_SCHEDULE: "FALSE" }), false, "false is case-insensitive");
  assert.equal(igNativeScheduleEnabled({ BOOKREEL_IG_NATIVE_SCHEDULE: "1" }), true);
  assert.equal(igNativeScheduleEnabled({ BOOKREEL_IG_NATIVE_SCHEDULE: "true" }), true);
});

test("browserOptionProblems: Instagram scheduledAt is refused with the flag off, and validated like YouTube's with it on", () => {
  const now = Date.now();
  const soon = new Date(now + 60 * 60_000);
  const problems = (o: BrowserPublishOptions) => browserOptionProblems("instagram", o, now);
  const codes = (o: BrowserPublishOptions) => problems(o).map((x) => x.code);
  const FLAG = "BOOKREEL_IG_NATIVE_SCHEDULE";
  const saved = process.env[FLAG];
  const setFlag = (value: string | undefined) => {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
  };
  try {
    // Flag OFF: the schedule is refused, and the message names the switch.
    setFlag(undefined);
    const off = problems({ scheduledAt: soon, confirmPublic: true });
    assert.deepEqual(off.map((x) => x.code), ["bad_options"]);
    assert.match(off[0].message, /BOOKREEL_IG_NATIVE_SCHEDULE/);
    assert.match(off[0].message, /Nothing was sent\.$/);
    setFlag("0");
    assert.deepEqual(codes({ scheduledAt: soon, confirmPublic: true }), ["bad_options"], "0 is off");

    // Flag ON: the same checks YouTube's schedule gets.
    setFlag("1");
    assert.deepEqual(codes({ scheduledAt: soon, confirmPublic: true }), []);
    assert.deepEqual(
      codes({ scheduledAt: new Date(now + MIN_SCHEDULE_LEAD_MS - 1000), confirmPublic: true }),
      ["bad_options"],
      "less than the minimum lead",
    );
    assert.deepEqual(codes({ scheduledAt: new Date("nope"), confirmPublic: true }), ["bad_options"], "not a date");
    assert.deepEqual(codes({ scheduledAt: soon }), ["needs_confirmation"], "still must be confirmed");
    assert.deepEqual(codes({ scheduledAt: soon, confirmPublic: true, visibility: "private" }), ["bad_options"], "still no private post");

    // Unchanged either way: an immediate Instagram post, and the YouTube shape.
    assert.deepEqual(codes({ confirmPublic: true }), []);
    setFlag(undefined);
    assert.deepEqual(codes({ confirmPublic: true }), []);
    assert.deepEqual(codes({}), ["needs_confirmation"]);
    assert.deepEqual(browserOptionProblems("youtube", { madeForKids: false, scheduledAt: soon, confirmPublic: true }, now), []);
    assert.deepEqual(
      browserOptionProblems("youtube", { madeForKids: false, scheduledAt: new Date(now + MIN_SCHEDULE_LEAD_MS - 1000), confirmPublic: true }, now).map((x) => x.code),
      ["bad_options"],
    );
  } finally {
    setFlag(saved);
  }
});

// ======================================================================= THE YOUTUBE FLOW

test("YouTube: a private upload is PUBLISHED only after the video's own page reads back the title and visibility", async () => {
  const root = await tempRoot();
  try {
    const r = await publishYouTube({}, { madeForKids: false }, root);
    assert.equal(r.outcome.status, "PUBLISHED");
    if (r.outcome.status !== "PUBLISHED") return;
    assert.equal(r.outcome.externalId, VIDEO_ID, "the id is the one Studio showed");
    assert.equal(r.outcome.visibility, "private");
    assert.equal(r.outcome.scheduledFor, null);
    assert.equal(r.outcome.thumbnail?.applied, true);
    assert.equal(r.outcome.reviewUrl, studioUrlFor(VIDEO_ID));

    // It really did the work, in order, with ordinary actions.
    const a = r.page.actions;
    assert.ok(a.indexOf(`click:${YT.createButton}`) < a.indexOf(`files:${YT.fileInput}=/work/renders/e1.mp4`));
    assert.ok(a.includes(`fill:${YT.title}=${META.title}`));
    assert.ok(a.includes(`fill:${YT.description}=${META.description}`));
    assert.ok(a.includes(`files:${YT.thumbnailInput}=/work/thumbs/e1.jpg`), "the poster was attached");
    assert.ok(a.includes(`click:${YT.kidsNo}`), "the operator's own answer was used");
    assert.ok(!a.includes(`click:${YT.kidsYes}`));
    assert.equal(r.s.tags.join(","), "focus,attention");
    assert.equal(r.s.pressed, 1, "the final button was pressed exactly once");
    // And the read-back happened AFTER the press.
    assert.ok(a.lastIndexOf(`goto:${studioUrlFor(VIDEO_ID)}`) > a.indexOf(`click:${YT.done}`));
    assert.equal(r.context.closed, true, "a finished job closes its window");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a SIGN-IN stops the job with the page untouched, the window left open, and no attempt to log in", async () => {
  const root = await tempRoot();
  try {
    const r = await publishYouTube({ signedOut: true }, { madeForKids: false }, root);
    assert.equal(r.outcome.status, "AWAITING_HUMAN");
    assert.match((r.outcome as { error: string }).error, /sign in/i);
    assert.match((r.outcome as { error: string }).error, /never types or stores your password/);
    assert.deepEqual(r.page.touched(), [], "no click, fill, key or file: the page was only looked at");
    assert.equal(r.context.closed, false, "the window is left open for the person");
    assert.equal(hasLeftOpenWindow("youtube"), true);
    assert.equal(r.s.pressed, 0);
    // The next job on this platform closes the left-open window first, as a Retry does.
    await closeLeftOpen("youtube", root);
    assert.equal(r.context.closed, true);
    assert.equal(hasLeftOpenWindow("youtube"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a SECURITY CHECK stops the job without touching the page, whether it is the address or a dialog", async () => {
  const root = await tempRoot();
  try {
    for (const script of [{ challengeUrl: true }, { dialogText: "Verify it's you — 2-Step Verification. Enter the code." }] satisfies YtScript[]) {
      const r = await publishYouTube(script, { madeForKids: false }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN", JSON.stringify(script));
      const msg = (r.outcome as { error: string }).error;
      assert.match(msg, /security check/i);
      assert.match(msg, /does not try to solve or get past it/);
      assert.deepEqual(r.page.touched(), [], `nothing was clicked, typed or attached (${JSON.stringify(script)})`);
      assert.equal(r.context.closed, false);
      await closeLeftOpen("youtube", root);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a wrong channel is refused before anything is uploaded; an unreadable one only passes for a private upload", async () => {
  const root = await tempRoot();
  try {
    const wrong = await publishYouTube({ handle: "@someone-else" }, { madeForKids: false }, root);
    assert.equal(wrong.outcome.status, "AWAITING_HUMAN");
    // The exact, step-by-step guidance -- no auto-switch, and it does not echo the wrong handle.
    assert.equal(
      (wrong.outcome as { error: string }).error,
      "Wrong YouTube channel. In the open YouTube Studio window, click your profile icon → Switch account → select between_pages (@betweenpages08-l4d). Confirm the channel dashboard, then return to BookReel and click Retry.",
    );
    assert.ok(!wrong.page.actions.some((a) => a.startsWith("files:")), "nothing was uploaded to the wrong channel");

    const unreadablePublic = await publishYouTube({ handle: null }, { madeForKids: false, visibility: "public", confirmPublic: true }, root);
    assert.equal(unreadablePublic.outcome.status, "AWAITING_HUMAN");
    assert.match((unreadablePublic.outcome as { error: string }).error, /did not say which channel/);
    assert.ok(!unreadablePublic.page.actions.some((a) => a.startsWith("files:")));

    const unreadablePrivate = await publishYouTube({ handle: null }, { madeForKids: false }, root);
    assert.equal(unreadablePrivate.outcome.status, "AWAITING_HUMAN", "all uploads require a verified channel");

    // The expected handle is configurable, and a match is by handle, not by title.
    const custom = await publishYouTube({ handle: "@my-brand" }, { madeForKids: false }, root, { BOOKREEL_YOUTUBE_HANDLE: "my-brand" });
    assert.equal(custom.outcome.status, "PUBLISHED");
  } finally {
    await closeLeftOpen("youtube", root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: pressing the button is NOT success -- every way the read-back can fail is AWAITING_HUMAN, with the video recorded as seen, never PUBLISHED", async () => {
  const root = await tempRoot();
  try {
    const cases: Array<[string, YtScript, RegExp]> = [
      ["the title on the video's page is different", { readTitle: "Some other title" }, /not the one that was sent/],
      ["the title is missing", { readTitle: "" }, /did not show its title/],
      ["it reads as public although private was asked", { readVisibility: "Public" }, /public, not private/],
      ["the visibility cannot be read", { readVisibility: "Draft" }, /did not say whether/],
      ["the video's own page will not load", { editLoads: false }, /would not load, so the result cannot be confirmed/],
      ["Studio never finishes (the dialog stays open)", { neverSettles: true }, /never finished/],
    ];
    for (const [why, script, expectedText] of cases) {
      const r = await publishYouTube(script, { madeForKids: false }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN", why);
      const out = r.outcome as { error: string; externalId?: string | null };
      assert.match(out.error, expectedText, why);
      assert.match(out.error, /final button was pressed/, `${why}: it says the button WAS pressed, so a retry is not assumed safe`);
      assert.equal(r.s.pressed, 1, `${why}: the final button was pressed once`);
      assert.equal(out.externalId, VIDEO_ID, `${why}: the id Studio showed is kept so a re-run is refused`);
      assert.equal(r.context.closed, false, `${why}: the window is left open for a person`);
      await closeLeftOpen("youtube", root);
    }

    // No id anywhere: it cannot be confirmed, and it is not invented.
    const noLink = await publishYouTube({ noVideoLink: true }, { madeForKids: false }, root);
    assert.equal(noLink.outcome.status, "AWAITING_HUMAN");
    assert.match((noLink.outcome as { error: string }).error, /never showed the video's link/);
    assert.equal((noLink.outcome as { externalId?: string | null }).externalId, undefined, "no id is made up");
    await closeLeftOpen("youtube", root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a page that is not what was expected stops BEFORE the final button, and the button is never pressed", async () => {
  const root = await tempRoot();
  try {
    const cases: Array<[string, YtScript, RegExp]> = [
      ["Studio keeps Next disabled (a required declaration)", { nextDisabled: true }, /waiting on a required answer this app does not give for you/],
      ["the final button says the wrong word", { finalLabel: "Publish now" }, /final button says "Publish now"/],
    ];
    for (const [why, script, expectedText] of cases) {
      const r = await publishYouTube(script, { madeForKids: false }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN", why);
      assert.match((r.outcome as { error: string }).error, expectedText, why);
      assert.match((r.outcome as { error: string }).error, /Nothing was published/, why);
      assert.equal(r.s.pressed, 0, `${why}: the final button was never pressed`);
      await closeLeftOpen("youtube", root);
    }
    // An existing child-directed declaration must never be overwritten with No.
    const yes = await publishYouTube({}, { madeForKids: true }, root);
    assert.equal(yes.outcome.status, "AWAITING_HUMAN");
    assert.ok(!yes.page.actions.includes(`click:${YT.kidsYes}`));
    assert.ok(!yes.page.actions.includes(`click:${YT.createButton}`));
    assert.ok(!yes.page.actions.includes(`click:${YT.kidsNo}`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a refused thumbnail is its own fact and does not fail an upload that succeeded", async () => {
  const root = await tempRoot();
  try {
    const r = await publishYouTube({ noThumbControl: true }, { madeForKids: false }, root);
    assert.equal(r.outcome.status, "PUBLISHED");
    if (r.outcome.status !== "PUBLISHED") return;
    assert.equal(r.outcome.thumbnail?.applied, false);
    assert.match(r.outcome.thumbnail?.reason ?? "", /offered no custom-thumbnail control/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a schedule is set in Studio, read back, and recorded as SCHEDULED -- never as published", async () => {
  const root = await tempRoot();
  try {
    const when = new Date(Date.now() + 3 * 24 * 3_600_000);
    when.setSeconds(0, 0);
    const r = await publishYouTube({}, { madeForKids: false, scheduledAt: when, confirmPublic: true }, root);
    assert.equal(r.outcome.status, "PUBLISHED", "the outcome type says the platform holds it; the ROW is what says scheduled");
    if (r.outcome.status !== "PUBLISHED") return;
    assert.equal(r.outcome.visibility, "scheduled");
    assert.equal(r.outcome.scheduledFor?.getTime(), when.getTime(), "the time is the one Studio read back");
    assert.ok(r.page.actions.includes(`fill:${YT.dateInput}=${studioDateText(when)}`));
    assert.ok(r.page.actions.includes(`fill:${YT.timeInput}=${studioTimeText(when)}`));

    const row = rowFor(r.outcome);
    assert.equal(row.status, "SCHEDULED");
    assert.equal(row.publishedAt, null, "nothing is published yet");
    assert.equal((row.scheduledFor as Date).getTime(), when.getTime());
    assert.equal(row.externalId, VIDEO_ID);

    // When the video's edit page shows only "Visibility\nScheduled" on YT.editVisibility, readVideoPage
    // reads the date and time from YT.dateTrigger and YT.timeInput inside the visibility popover.
    const rPopover = await publishYouTube(
      { readVisibility: "Visibility\nScheduled" },
      { madeForKids: false, scheduledAt: when, confirmPublic: true },
      root,
    );
    assert.equal(rPopover.outcome.status, "PUBLISHED");
    if (rPopover.outcome.status === "PUBLISHED") {
      assert.equal(rPopover.outcome.visibility, "scheduled");
      assert.equal(rPopover.outcome.scheduledFor?.getTime(), when.getTime());
    }

    // Studio showing a different time than the one typed stops the job BEFORE Schedule is pressed.
    const wrong = await publishYouTube(
      { scheduleReadback: { date: "Dec 1, 2030", time: "9:00 AM" } },
      { madeForKids: false, scheduledAt: when, confirmPublic: true },
      root,
    );
    assert.equal(wrong.outcome.status, "AWAITING_HUMAN");
    assert.match((wrong.outcome as { error: string }).error, /Nothing was published/);
    assert.equal(wrong.s.pressed, 0, "Schedule was not pressed");
    await closeLeftOpen("youtube", root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("YouTube: a publish that was not asked for properly never launches a browser", async () => {
  const root = await tempRoot();
  try {
    const cases: Array<[string, BrowserPublishOptions, RegExp]> = [
      ["no answer to 'made for kids'", {}, /made for kids/],
      ["public without confirming", { madeForKids: false, visibility: "public" }, /public or scheduled post goes live/],
      ["a schedule without confirming", { madeForKids: false, scheduledAt: new Date(Date.now() + 86_400_000) }, /goes live/],
      ["a schedule too soon", { madeForKids: false, scheduledAt: new Date(Date.now() + 60_000), confirmPublic: true }, /15 minutes/],
    ];
    for (const [why, options, expectedText] of cases) {
      const r = await publishYouTube({}, options, root);
      assert.equal(r.outcome.status, "FAILED", why);
      assert.match((r.outcome as { error: string }).error, expectedText, why);
      assert.match((r.outcome as { error: string }).error, /Nothing was sent/, why);
      assert.equal(r.launches.length, 0, `${why}: no window was opened`);
      assert.deepEqual(r.page.actions, []);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ======================================================================= THE INSTAGRAM FLOW

test("Instagram: PUBLISHED needs BOTH Instagram's own 'shared' sentence AND the new reel's link, found and matched to the caption", async () => {
  const root = await tempRoot();
  try {
    const r = await publishInstagram({}, { confirmPublic: true }, root);
    assert.equal(r.outcome.status, "PUBLISHED");
    if (r.outcome.status !== "PUBLISHED") return;
    assert.equal(r.outcome.externalId, NEW_CODE, "the id is the shortcode of the link Instagram now shows");
    assert.equal(r.outcome.externalUrl, `https://www.instagram.com/reel/${NEW_CODE}/`);
    assert.equal(r.outcome.visibility, "public");
    assert.equal(r.s.pressed, 1);

    const caption = instagramCaption(META);
    assert.ok(r.page.actions.includes(`fill:${IG.caption}=${caption}`), "the caption is instagramCaption(metadata)");
    assert.ok(r.page.actions.some((a) => a.startsWith("chooser:")), "the cover went through the file chooser");
    assert.ok(r.page.actions.indexOf("crop:Original") < r.page.actions.indexOf(`click:${IG.next}`));
    assert.equal(r.outcome.thumbnail?.applied,true);
    // The profile was looked at BEFORE sharing, so the new reel could be told apart.
    const a = r.page.actions;
    assert.ok(a.findIndex((x) => x.includes("/reels/")) < a.indexOf(`click:${IG.share}`));
    assert.equal(r.context.closed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram crop or cover failure stops before caption and Share, preserving the draft for review", async () => {
  const root = await tempRoot();
  try {
    for (const failure of ["crop","cover"] as const) {
      const r = await publishInstagram({}, {confirmPublic:true}, root, failure);
      assert.equal(r.outcome.status,"AWAITING_HUMAN");
      assert.equal(r.s.pressed,0);
      assert.equal(r.s.stage,failure === "crop" ? "crop" : "edit");
      assert.equal(r.context.closed,false);
      await closeLeftOpenWindow("instagram");
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("Instagram: a LOG-IN or a SECURITY CHECK stops the job with the page untouched", async () => {
  const root = await tempRoot();
  try {
    for (const script of [{ signedOut: true }, { dialogText: "Confirm it's you. Enter the code we sent you." }] satisfies IgScript[]) {
      const r = await publishInstagram(script, { confirmPublic: true }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN", JSON.stringify(script));
      assert.deepEqual(r.page.touched(), [], `the page was only looked at (${JSON.stringify(script)})`);
      assert.equal(r.context.closed, false, "left open for the person");
      assert.equal(r.s.pressed, 0);
      await closeLeftOpen("instagram", root);
    }
    const out = await publishInstagram({ signedOut: true }, { confirmPublic: true }, root);
    assert.match((out.outcome as { error: string }).error, /log in|sign in/i);
    assert.match((out.outcome as { error: string }).error, /never types or stores your password/);
    await closeLeftOpen("instagram", root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram: the wrong account, or one that cannot be read, is refused before anything is posted", async () => {
  const root = await tempRoot();
  try {
    for (const [handle, expectedText] of [["someone_else", /Wrong Instagram account/], [null, /did not say which account/]] as const) {
      const r = await publishInstagram({ handle }, { confirmPublic: true }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN");
      assert.match((r.outcome as { error: string }).error, expectedText);
      assert.equal(r.s.pressed, 0);
      assert.ok(!r.page.actions.some((a) => a.startsWith("files:")), "nothing was attached");
      await closeLeftOpen("instagram", root);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram: Share pressed but not confirmed, a refusal, a check mid-share, or no link found are all AWAITING_HUMAN -- never PUBLISHED", async () => {
  const root = await tempRoot();
  try {
    const cases: Array<[string, IgScript, RegExp]> = [
      ["Instagram never says it was shared", { after: "never" }, /never said the Reel was shared/],
      ["Instagram reports a problem", { after: "failed" }, /reported a problem sharing/],
      ["Instagram asks to confirm it is you", { after: "needs_human" }, /wants something from you/],
      ["shared, but the new reel's link cannot be found", { newReel: false }, /link could not be found[\s\S]*do NOT try again/],
      ["shared, but the page at the new link is not this caption", { reelText: "an unrelated post" }, /link could not be found/],
    ];
    for (const [why, script, expectedText] of cases) {
      const r = await publishInstagram(script, { confirmPublic: true }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN", why);
      const msg = (r.outcome as { error: string }).error;
      assert.match(msg, expectedText, why);
      assert.equal(r.s.pressed, 1, `${why}: Share was pressed once, and the message accounts for it`);
      assert.match(msg, /(check your profile|already been pressed|do NOT try again)/i, why);
      assert.notEqual(r.outcome.status, "PUBLISHED");
      assert.equal(r.context.closed, false);
      await closeLeftOpen("instagram", root);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Instagram: no schedule is offered or faked, and a post is never made without the confirmation", async () => {
  const root = await tempRoot();
  try {
    const later = new Date(Date.now() + 86_400_000);
    const sched = await publishInstagram({}, { confirmPublic: true, scheduledAt: later }, root);
    assert.equal(sched.outcome.status, "FAILED");
    assert.match((sched.outcome as { error: string }).error, /BOOKREEL_IG_NATIVE_SCHEDULE/);
    assert.equal(sched.launches.length, 0, "no window was opened to 'schedule' it");

    const unconfirmed = await publishInstagram({}, {}, root);
    assert.equal(unconfirmed.outcome.status, "FAILED");
    assert.match((unconfirmed.outcome as { error: string }).error, /publicly, at once/);
    assert.equal(unconfirmed.launches.length, 0);
    assert.deepEqual(unconfirmed.page.actions, []);
    assert.equal(browserPublisherFor("instagram")?.capabilities().canSchedule, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ======================================================================= THE HARNESS: lock and windows

test("the single-window lock: a second job on a platform waits for the first; another platform does not wait", async () => {
  const root = await tempRoot();
  try {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const mk = () => fakeBrowser(new FakePage(), { profileRoot: root });
    const a = mk();
    const b = mk();
    const c = mk();
    const done: PublishOutcome = { status: "FAILED", error: "scripted" };

    const first = runInSession("youtube", a.deps, async () => {
      order.push("a-start");
      await held;
      order.push("a-end");
      return done;
    });
    const second = runInSession("youtube", b.deps, async () => {
      order.push("b-start");
      return done;
    });
    const other = runInSession("instagram", c.deps, async () => {
      order.push("c-start");
      return done;
    });

    await other;
    await until(async () => order.includes("a-start"));
    // Let every queued microtask run: b still must not have started.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.ok(order.includes("c-start"), "Instagram ran while YouTube was held");
    assert.ok(!order.includes("b-start"), "the second YouTube job did not start");
    assert.equal(b.launches.length, 0, "the second window is not even opened until the first is released");
    assert.equal(isPlatformBusy("youtube"), true);

    release();
    await Promise.all([first, second]);
    assert.ok(order.indexOf("b-start") > order.indexOf("a-end"), "the second job ran only after the first had finished");
    assert.equal(a.context.closed, true, "a finished job closes its window");
    assert.equal(isPlatformBusy("youtube"), false);
    assert.equal(isPlatformBusy("instagram"), false);

    // A job that throws still releases the lock, and is an UNKNOWN outcome, not a failure.
    const boom = await runInSession("youtube", mk().deps, async () => {
      throw new Error("kaboom");
    });
    assert.equal(boom.status, "AWAITING_HUMAN", "an exception from a flow that may have pressed the button is NOT 'failed'");
    assert.match((boom as { error: string }).error, /not known how far it got/);
    const after = await acquirePlatformLock("youtube");
    after();
    await closeLeftOpen("youtube", root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a hidden (headless) window cannot be left for a person, so it is closed, and the message says why", async () => {
  const root = await tempRoot();
  try {
    const site = youtubeSite({ signedOut: true });
    const fake = fakeBrowser(site.page, { profileRoot: root, env: { BOOKREEL_PUBLISH_HEADLESS: "1" } });
    const outcome = await browserYouTubePublisher({
      env: { BOOKREEL_PUBLISH_HEADLESS: "1" },
      options: { madeForKids: false },
      deps: fake.deps,
    }).publish(prepared());
    assert.equal(outcome.status, "AWAITING_HUMAN");
    assert.match((outcome as { error: string }).error, /running hidden/);
    assert.equal(fake.context.closed, true, "nobody could use a hidden window, so it is not left open");
    assert.equal(fake.launches[0].options.headless, true);
    assert.equal(hasLeftOpenWindow("youtube"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a browser that will not start is FAILED with nothing opened; a launch is never retried by the harness", async () => {
  const root = await tempRoot();
  try {
    let attempts = 0;
    const outcome = await runInSession(
      "instagram",
      {
        env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" },
        profileRoot: root,
        locate: () => "C:/chrome.exe",
        launch: async () => {
          attempts++;
          throw new Error("profile is locked");
        },
      },
      async () => ({ status: "FAILED", error: "should not run" }),
    );
    assert.equal(outcome.status, "FAILED");
    assert.match((outcome as { error: string }).error, /Chromium would not start: profile is locked/);
    assert.equal(attempts, 1, "one launch attempt, no loop");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Chromium is found the way the rest of the app finds it: Playwright's own lookup", () => {
  const located = locateChromium();
  assert.ok(located === null || typeof located === "string");
  assert.equal(new NeedsHuman("sign_in", "x").name, "NeedsHuman");
});

// ======================================================================= JOBS: dedupe, claim, recovery

interface Seed {
  ownerId: string;
  strangerId: string;
  episodes: string[];
  ownerlessId: string;
  cleanup: () => Promise<void>;
}

async function seed(count = 3): Promise<Seed> {
  requireIsolation("these tests create episodes and write renders and posters");
  const owner = await prisma.user.create({ data: { email: `bw-own-${randomUUID()}@example.test` } });
  const stranger = await prisma.user.create({ data: { email: `bw-str-${randomUUID()}@example.test` } });
  const book = await prisma.book.create({
    data: { title: `BW ${randomUUID()}`, rightsStatus: "in-copyright", bookLink: "https://example.com/buy" },
  });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });

  const make = async (userId: string | null, fill: number) => {
    const episode = await prisma.episode.create({
      data: {
        bookId: book.id,
        uploadId: upload.id,
        userId,
        status: "DONE",
        theme: "marginalia",
        title: "Productivity Isn't Hustle",
        hook: "Most people are busy.",
        cta: "Follow for one page a day",
        description: "What the book says about attention.",
        hashtags: JSON.stringify(["#focus", "#deepwork"]),
        voScript: "Most people are busy.",
        durationSec: 61.5,
      },
    });
    const thumbDir = thumbsDir(episode.id);
    const specs: ThumbSpec[] = THUMB_KEYS.map((key) => ({
      key,
      aspect: key.startsWith("9x16") ? ("9:16" as const) : ("16:9" as const),
      variant: key.split("-")[1] as ThumbSpec["variant"],
      path: path.join(thumbDir, `${key}.jpg`),
      width: 1080,
      height: 1920,
      rev: 1,
    }));
    await fs.mkdir(thumbDir, { recursive: true });
    for (const s of specs) await fs.writeFile(s.path, "poster bytes");
    await fs.mkdir(RENDER_DIR, { recursive: true });
    const renderFile = path.join(RENDER_DIR, `${episode.id}.mp4`);
    await fs.writeFile(renderFile, Buffer.alloc(9000, fill));
    await prisma.episode.update({ where: { id: episode.id }, data: { thumbnails: serializeThumbnails(specs), videoPath: renderFile } });
    return episode.id;
  };

  const episodes: string[] = [];
  for (let i = 0; i < count; i++) episodes.push(await make(owner.id, 7 + i));
  const ownerlessId = await make(null, 5);

  return {
    ownerId: owner.id,
    strangerId: stranger.id,
    episodes,
    ownerlessId,
    cleanup: async () => {
      for (const id of [...episodes, ownerlessId]) {
        await fs.rm(thumbsDir(id), { recursive: true, force: true });
        await fs.rm(path.join(RENDER_DIR, `${id}.mp4`), { force: true });
      }
      await prisma.book.delete({ where: { id: book.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
    },
  };
}

/** A real browser publisher whose `publish` is replaced by a script. `prepare`, `validate` and `isConfigured` are the real ones. */
function scripted(platform: "youtube" | "instagram", publish: (p: PreparedPublish) => Promise<PublishOutcome>): BrowserPublisher {
  const real = browserPublisherFor(platform, { browser: { deps: { locate: () => "C:/chrome.exe" } } }) as BrowserPublisher;
  return { ...real, publish: async (p) => publish(p) };
}

const posted = (id = "MEDIA1"): PublishOutcome => ({
  status: "PUBLISHED",
  externalId: id,
  externalUrl: `https://example.test/${id}`,
  confirmedAt: new Date(),
  visibility: "public",
});

async function row(episodeId: string, platform: "youtube" | "instagram") {
  return prisma.publishJob.findUnique({ where: { episodeId_platform: { episodeId, platform } } });
}

async function until<T>(read: () => Promise<T | null | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const seeds: Seed[] = [];
after(async () => {
  for (const s of seeds) await s.cleanup();
});

const OK_YT = { madeForKids: false, waitForCompletion: true } as const;

test("review deadline persists AWAITING_HUMAN with no upload checkpoint and retains manual retry safeguards", async () => {
  const s = await seed(1);
  seeds.push(s);
  const ep = s.episodes[0];
  await prisma.episode.update({ where: { id: ep }, data: { voScript: "Adults at work can build sustainable routines through small, manageable goals. Daily reflection helps us learn from setbacks and improve our attention." } });
  const root = await tempRoot();
  try {
    const fake = fakeBrowser(new FakePage(), { profileRoot: root });
    const deps = { ...fake.deps, youtubeReview: (input: PreparedPublish) => reviewStudioVideo(input, () => new Promise(() => {}), 20) };
    await startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, env: deps.env, deps });
    const held = await row(ep, "youtube");
    assert.equal(held?.status, "AWAITING_HUMAN");
    assert.match(held?.lastError ?? "", /timed out.*No new file was selected/);
    assert.match(held?.progress ?? "", /420s limit.*before opening Studio/);
    assert.equal(held?.externalId, null);
    assert.equal(held?.remoteDraftId, null);
    assert.equal(held?.publishedAt, null);
    assert.equal(held?.scheduledFor, null);
    assert.equal(fake.launches.length, 0);
    await assert.rejects(startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, env: deps.env, deps }));
    assert.equal((await row(ep, "youtube"))?.attempts, held?.attempts);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a browser job is recorded as mode 'browser', and only the platform's confirmation makes it PUBLISHED", async () => {
  const s = await seed(6);
  seeds.push(s);
  const [published, scheduled, awaiting, noId, thrown, failed] = s.episodes;

  // PUBLISHED: the id the platform showed, the time it confirmed, mode browser.
  await startBrowserPublish(s.ownerId, published, "instagram", {
    confirmPublic: true,
    waitForCompletion: true,
    makePublisher: () => scripted("instagram", async () => posted("CODE1")),
  });
  const a = await row(published, "instagram");
  assert.equal(a?.status, "PUBLISHED");
  assert.equal(a?.mode, "browser");
  assert.equal(a?.externalId, "CODE1");
  assert.ok(a?.publishedAt);
  assert.equal(a?.attempts, 1);

  // SCHEDULED: the platform holds it. Nothing is published yet.
  const when = new Date(Date.now() + 5 * 86_400_000);
  await startBrowserPublish(s.ownerId, scheduled, "youtube", {
    ...OK_YT,
    scheduledAt: when,
    confirmPublic: true,
    makePublisher: () => scripted("youtube", async () => ({ ...posted("VID1"), visibility: "scheduled", scheduledFor: when }) as PublishOutcome),
  });
  const b = await row(scheduled, "youtube");
  assert.equal(b?.status, "SCHEDULED");
  assert.equal(b?.publishedAt, null, "a scheduled post has no published time");
  assert.equal(b?.scheduledFor?.getTime(), when.getTime());
  assert.equal(b?.externalId, "VID1");
  assert.equal(b?.privacyStatus, "scheduled");

  // AWAITING_HUMAN keeps an id the platform showed, and records the reason.
  await startBrowserPublish(s.ownerId, awaiting, "youtube", {
    ...OK_YT,
    makePublisher: () =>
      scripted("youtube", async () => ({ status: "AWAITING_HUMAN", error: "Studio never confirmed it.", externalId: "VID2", externalUrl: null })),
  });
  const c = await row(awaiting, "youtube");
  assert.equal(c?.status, "AWAITING_HUMAN");
  assert.equal(c?.lastError, "Studio never confirmed it.");
  assert.equal(c?.externalId, "VID2");
  assert.equal(c?.publishedAt, null, "an id that was SEEN is not an id that was CONFIRMED");

  // A "success" with no id the platform showed is not a post, whatever the publisher says.
  await startBrowserPublish(s.ownerId, noId, "instagram", {
    confirmPublic: true,
    waitForCompletion: true,
    makePublisher: () => scripted("instagram", async () => ({ status: "PUBLISHED", externalId: "", externalUrl: null, confirmedAt: new Date() }) as PublishOutcome),
  });
  const d = await row(noId, "instagram");
  assert.equal(d?.status, "AWAITING_HUMAN");
  assert.equal(d?.publishedAt, null);
  assert.equal(d?.externalId, null);

  // An exception from the publisher is an unknown outcome, not a failure.
  await startBrowserPublish(s.ownerId, thrown, "instagram", {
    confirmPublic: true,
    waitForCompletion: true,
    makePublisher: () =>
      scripted("instagram", async () => {
        throw new Error("page crashed");
      }),
  });
  const e = await row(thrown, "instagram");
  assert.equal(e?.status, "AWAITING_HUMAN");
  assert.match(e?.lastError ?? "", /page crashed/);
  assert.match(e?.lastError ?? "", /not known how far it got/);

  // A refusal is FAILED: that is the one case a retry is safe.
  await startBrowserPublish(s.ownerId, failed, "instagram", {
    confirmPublic: true,
    waitForCompletion: true,
    makePublisher: () => scripted("instagram", async () => ({ status: "FAILED", error: "could not open Instagram" })),
  });
  assert.equal((await row(failed, "instagram"))?.status, "FAILED");

  // And rowFor is pure: no status without its justification.
  assert.equal(rowFor({ status: "REQUIRES_CONNECTION", error: "no chromium" }).status, "REQUIRES_CONNECTION");
  assert.equal(
    rowFor({ status: "PUBLISHED", externalId: "x", externalUrl: null, confirmedAt: new Date(), scheduledFor: new Date("nope") }).status,
    "AWAITING_HUMAN",
  );
});

test("DEDUPE: a second start for the same episode and platform never runs a second job, however it arrives", async () => {
  const s = await seed();
  seeds.push(s);
  const [ep] = s.episodes;

  let calls = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const slow = () =>
    scripted("instagram", async () => {
      calls++;
      await gate;
      return posted("ONCE");
    });
  const start = () => startBrowserPublish(s.ownerId, ep, "instagram", { confirmPublic: true, makePublisher: slow });

  // Three at once, then one more while it is plainly in flight.
  await Promise.all([start(), start(), start()]);
  assert.equal(isBrowserJobLive("instagram", ep), true);
  const during = await start();
  assert.equal(calls, 1, "exactly one job ran");
  assert.equal((await row(ep, "instagram"))?.attempts, 1, "and exactly one attempt was recorded");
  assert.ok(["PREPARING", "UPLOADING"].includes(during.platforms.find((p) => p.platform === "instagram")!.status));

  // The API route refuses to start on top of it as well.
  await assert.rejects(
    () =>
      startInstagramPublish(s.ownerId, ep, {
        confirmPublic: true,
        fetchImpl: (async () => {
          throw new Error("must not be called");
        }) as typeof fetch,
      }),
    (err: unknown) => isApp(err) && err.code === "browser_job_holds",
  );

  open();
  await until(async () => (await row(ep, "instagram"))?.status === "PUBLISHED");
  await until(async () => !isBrowserJobLive("instagram", ep));

  // Already POSTED: a start is a no-op.
  const again = await start();
  assert.equal(calls, 1);
  assert.equal(again.platforms.find((p) => p.platform === "instagram")!.status, "PUBLISHED");
  assert.equal((await row(ep, "instagram"))?.attempts, 1);
});

test("DEDUPE: SCHEDULED and PUBLISHED rows are never run again, and a recorded video id refuses a retry outright", async () => {
  const s = await seed();
  seeds.push(s);
  const [sched, pub, seen] = s.episodes;
  let calls = 0;
  const publisher = () =>
    scripted("youtube", async () => {
      calls++;
      return posted("NEVER");
    });

  await prisma.publishJob.create({
    data: { episodeId: sched, platform: "youtube", status: "SCHEDULED", mode: "browser", externalId: "V1", scheduledFor: new Date(Date.now() + 86_400_000), attempts: 1 },
  });
  await prisma.publishJob.create({
    data: { episodeId: pub, platform: "youtube", status: "PUBLISHED", mode: "api", externalId: "V2", publishedAt: new Date(), attempts: 1 },
  });
  await prisma.publishJob.create({
    data: { episodeId: seen, platform: "youtube", status: "AWAITING_HUMAN", mode: "browser", externalId: "V3", lastError: "unconfirmed", attempts: 1 },
  });

  for (const ep of [sched, pub]) {
    await startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, makePublisher: publisher });
  }
  assert.equal(calls, 0, "nothing ran for a post the platform already has");
  assert.equal((await row(sched, "youtube"))?.status, "SCHEDULED");
  assert.equal((await row(pub, "youtube"))?.status, "PUBLISHED");

  // An AWAITING_HUMAN row that recorded a video is refused even WITH the acknowledgement.
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, seen, "youtube", { ...OK_YT, acknowledgeRetry: true, makePublisher: publisher }),
    (err: unknown) => isApp(err) && err.code === "already_on_platform" && err.status === 409,
  );
  assert.equal(calls, 0);
  assert.equal((await row(seen, "youtube"))?.attempts, 1);
});

test("RETRY IS A HUMAN ACTION: an AWAITING_HUMAN job runs again only with the acknowledgement, and never by itself", async () => {
  const s = await seed();
  seeds.push(s);
  const [ep] = s.episodes;
  let calls = 0;
  const stops = () =>
    scripted("youtube", async () => {
      calls++;
      return { status: "AWAITING_HUMAN", error: "sign in", externalId: null };
    });

  await startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, makePublisher: stops });
  assert.equal(calls, 1);
  assert.equal((await row(ep, "youtube"))?.status, "AWAITING_HUMAN");

  // Time passes; nothing retries. (There is no timer, queue or loop that could.)
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls, 1, "a job that stopped for a person is not run again by anything");

  // Pressing it again without saying they looked is refused, and sends nothing.
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, makePublisher: stops }),
    (err: unknown) => isApp(err) && err.code === "needs_acknowledgement" && err.status === 409,
  );
  assert.equal(calls, 1);

  // With the acknowledgement it runs, and the attempt count says a person did it.
  await startBrowserPublish(s.ownerId, ep, "youtube", {
    ...OK_YT,
    acknowledgeRetry: true,
    makePublisher: () =>
      scripted("youtube", async () => {
        calls++;
        return posted("VID9");
      }),
  });
  assert.equal(calls, 2);
  const r = await row(ep, "youtube");
  assert.equal(r?.status, "PUBLISHED");
  assert.equal(r?.attempts, 2);
  assert.equal(r?.lastError, null, "a success clears the stop's message");
});

test("a start is refused, with a sentence and before any row, for ownership, the confirmations, and a missing Chromium", async () => {
  const s = await seed();
  seeds.push(s);
  const [ep] = s.episodes;
  let calls = 0;
  const publisher = () =>
    scripted("instagram", async () => {
      calls++;
      return posted();
    });

  // Ownership is the strict rule.
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, s.ownerlessId, "instagram", { confirmPublic: true, makePublisher: publisher }),
    (err: unknown) => isApp(err) && err.status === 403,
  );
  await assert.rejects(
    () => startBrowserPublish(s.strangerId, ep, "instagram", { confirmPublic: true, makePublisher: publisher }),
    (err: unknown) => isApp(err) && err.status === 403,
  );
  // Instagram goes live at once, so it needs the confirmation.
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "instagram", { makePublisher: publisher }),
    (err: unknown) => isApp(err) && err.code === "needs_confirmation" && err.status === 409,
  );
  // YouTube: the kids answer is required.
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "youtube", { makePublisher: () => scripted("youtube", async () => posted()) }),
    (err: unknown) => isApp(err) && err.code === "bad_options" && err.status === 400,
  );
  // No Chromium: a 409 that says nothing was sent, and no row.
  await assert.rejects(
    () => startBrowserPublish(s.ownerId, ep, "instagram", { confirmPublic: true, deps: { locate: () => null } }),
    (err: unknown) => isApp(err) && err.code === "requires_connection" && /No Chromium was found/.test(err.message),
  );
  assert.equal(calls, 0);
  assert.equal(await row(ep, "instagram"), null, "no refusal left a row behind");
  assert.equal(await row(ep, "youtube"), null);
});

test("RESTART: a browser job in flight with nobody running it is handed to a person, never re-run", async () => {
  const s = await seed();
  seeds.push(s);
  const ep = s.episodes;

  await prisma.publishJob.create({ data: { episodeId: ep[0], platform: "youtube", status: "UPLOADING", mode: "browser", attempts: 1 } });
  await prisma.publishJob.create({ data: { episodeId: ep[1], platform: "instagram", status: "PREPARING", mode: "browser", attempts: 1 } });
  await prisma.publishJob.create({ data: { episodeId: ep[2], platform: "instagram", status: "PREPARING", mode: "browser", attempts: 1 } });
  await prisma.publishJob.create({
    data: { episodeId: s.ownerlessId, platform: "youtube", status: "UPLOADING", mode: "api", attempts: 1, uploadedBytes: 5, totalBytes: 10 },
  });

  // One of them is genuinely running in THIS process: it must be left alone.
  assert.equal(markLive("instagram", ep[2]), true);
  try {
    const changed = await recoverInterruptedBrowserJobs();
    assert.ok(changed >= 2);

    const a = await row(ep[0], "youtube");
    assert.equal(a?.status, "AWAITING_HUMAN");
    assert.equal(a?.lastError, interruptedMessage("YouTube"));
    assert.match(a?.lastError ?? "", /unknown/);
    assert.match(a?.lastError ?? "", /not retried automatically/);
    assert.equal((await row(ep[1], "instagram"))?.status, "AWAITING_HUMAN");
    assert.equal((await row(ep[2], "instagram"))?.status, "PREPARING", "a job that IS running here is not interrupted");
    assert.equal((await row(s.ownerlessId, "youtube"))?.status, "UPLOADING", "an API job resumes its own way and is not this module's to touch");

    // It does not auto-retry: asking again is refused until a person says they looked.
    let calls = 0;
    await assert.rejects(
      () =>
        startBrowserPublish(s.ownerId, ep[0], "youtube", {
          ...OK_YT,
          makePublisher: () =>
            scripted("youtube", async () => {
              calls++;
              return posted();
            }),
        }),
      (err: unknown) => isApp(err) && err.code === "needs_acknowledgement",
    );
    assert.equal(calls, 0);

    // Idempotent: a second pass finds nothing more to do.
    assert.equal(await recoverInterruptedBrowserJobs(ep[0]), 0);
    assert.equal((await row(ep[0], "youtube"))?.attempts, 1, "recovery is not an attempt");
  } finally {
    unmarkLive("instagram", ep[2]);
  }

  // Once the live one is gone (the next restart), it is handed over too.
  await recoverInterruptedBrowserJobs(ep[2]);
  assert.equal((await row(ep[2], "instagram"))?.status, "AWAITING_HUMAN");

  // The reaper the episode routes already call does this as well.
  await prisma.publishJob.update({ where: { episodeId_platform: { episodeId: ep[0], platform: "youtube" } }, data: { status: "UPLOADING" } });
  await reapStaleRuns();
  assert.equal((await row(ep[0], "youtube"))?.status, "AWAITING_HUMAN");

  // And the Publish Center never shows a restart's leftovers as "preparing".
  await prisma.publishJob.update({ where: { episodeId_platform: { episodeId: ep[1], platform: "instagram" } }, data: { status: "PREPARING" } });
  const view = await publishView(s.ownerId, ep[1]);
  const ig = view.platforms.find((p) => p.platform === "instagram")!;
  assert.equal(ig.status, "AWAITING_HUMAN");
  assert.equal(ig.job?.mode, "browser");
  assert.match(ig.job?.lastError ?? "", /server stopped or restarted/);
  assert.ok(ig.browser, "the card is told about the browser route");
  assert.equal(ig.browser?.canSchedule, false);
  assert.equal(view.platforms.find((p) => p.platform === "youtube")!.browser?.canSchedule, true);
});

test("the API routes refuse to start on top of a browser job that holds the episode (running, or waiting on a person)", async () => {
  const s = await seed();
  seeds.push(s);
  const [ep] = s.episodes;
  const nope = (async () => {
    throw new Error("the API must not be called");
  }) as typeof fetch;

  for (const status of ["PREPARING", "AWAITING_HUMAN"]) {
    await prisma.publishJob.upsert({
      where: { episodeId_platform: { episodeId: ep, platform: "youtube" } },
      create: { episodeId: ep, platform: "youtube", status, mode: "browser", attempts: 1 },
      update: { status, mode: "browser" },
    });
    await assert.rejects(
      () => startYouTubePublish(s.ownerId, ep, { fetchImpl: nope }),
      (err: unknown) => isApp(err) && err.code === "browser_job_holds" && err.status === 409,
      `youtube, ${status}`,
    );
  }
});

test("API publishers, identity and the hand-off are unchanged by the existence of the browser route", async () => {
  // The default registry answer is the API provider; the hand-off is still the hand-off.
  assert.equal(publisherFor("youtube").capabilities().canSchedule, true);
  assert.equal(publisherFor("instagram").capabilities().canUpload, false, "unconnected Instagram is still the hand-off");
  assert.equal((await manualHandoff("instagram").publish(prepared("instagram"))).status, "REQUIRES_CONNECTION");
  assert.equal(await publisherFor("youtube").isConfigured(), false, "no credentials: not configured, as before");

  const s = await seed(1);
  seeds.push(s);
  const view = await publishView(s.ownerId, s.episodes[0]);
  for (const p of view.platforms) {
    assert.equal(p.status, "REQUIRES_CONNECTION", "the browser route does not make a platform look connected");
    assert.equal(p.configured, false);
    assert.ok(p.handoff.length >= 5, "the hand-off is still offered");
    assert.ok(p.browser, "and the browser route is described beside it");
    assert.equal(typeof p.browser?.available, "boolean");
    assert.equal(p.browser?.reason === null, p.browser?.available);
  }
});

// ======================================================================= THE CARD

const Card = ((cardModule as { default: unknown }).default as { default?: unknown }).default ?? (cardModule as { default: unknown }).default;

function renderCard(platform: "youtube" | "instagram", state: Partial<PlatformState>, owned = true): string {
  const base: PlatformState = {
    platform,
    label: platform === "youtube" ? "YouTube" : "Instagram",
    status: "REQUIRES_CONNECTION",
    capabilities: publisherFor(platform, { mode: "browser" }).capabilities(),
    hasPublisher: true,
    configured: false,
    problems: [],
    variant: [],
    cover: null,
    handoff: [],
    requires: [],
    browser: { available: true, reason: null, canSchedule: platform === "youtube", headless: false },
    job: null,
    ...state,
  };
  return renderToStaticMarkup(
    React.createElement(ToastHost, null, [
      React.createElement(
        Card as React.ComponentType<{ episodeId: string | null; state: PlatformState; owned: boolean; onPublished: (v: Record<string, unknown>) => void }>,
        { key: "card", episodeId: "e1", state: base, owned, onPublished: () => {} },
      ),
    ]),
  );
}

const jobView = (over: Partial<NonNullable<PlatformState["job"]>>): NonNullable<PlatformState["job"]> => ({
  status: "AWAITING_HUMAN",
  externalId: null,
  externalUrl: null,
  attempts: 1,
  lastError: null,
  preparedAt: null,
  publishedAt: null,
  metadata: null,
  uploadedBytes: null,
  totalBytes: null,
  thumbnailStatus: null,
  thumbnailError: null,
  privacyStatus: null,
  reviewUrl: null,
  mode: "browser",
  scheduledFor: null,
  ...over,
});

test("the card says what the route is, recommends the API, and asks for the declaration instead of assuming it", () => {
  const c = strings.publishCenter.browser;
  const html = renderCard("youtube", {});
  assert.match(html, /Publish via browser window/);
  assert.match(html, /real browser window/);
  assert.match(html, /recommended route/);
  assert.match(html, /never types your password and never tries to get past a check/);
  assert.match(html, /terms may not welcome/);
  assert.ok(html.includes(c.kidsLegend));
  assert.ok(!/checked=""/.test(html), "no 'made for kids' answer is pre-selected");
  assert.match(html, /aria-disabled="true"/, "the button is inert until the declaration is made");
  assert.match(html, /type="datetime-local"/, "YouTube Studio can schedule");
  assert.match(html, /Private \(review in Studio\)/, "private is the default");
});

test("Instagram's card has no schedule and says a share is public at once", () => {
  const html = renderCard("instagram", {});
  assert.match(html, /Publish via browser window/);
  assert.ok(!/datetime-local/.test(html), "no schedule is offered");
  assert.match(html, /publicly, at once/);
  assert.match(html, /cannot schedule it/);
  assert.ok(!html.includes(strings.publishCenter.browser.kidsLegend), "Instagram has no kids question");
});

test("an AWAITING_HUMAN job is shown as a stop for a person, with Retry behind an acknowledgement", () => {
  const html = renderCard("youtube", {
    status: "AWAITING_HUMAN",
    job: jobView({ lastError: "YouTube wants you to sign in. Do that in the open browser window, then press Retry." }),
  });
  assert.match(html, /The browser window stopped for you/);
  assert.match(html, /wants you to sign in/, "the reason is shown verbatim");
  assert.match(html, /I looked at the platform/, "the acknowledgement is a box the operator ticks");
  assert.match(html, /Retry in the browser window/);
  assert.match(html, /aria-disabled="true"/, "Retry is inert until the box is ticked");

  // A video the platform showed: no Retry at all.
  const seen = renderCard("youtube", { status: "AWAITING_HUMAN", job: jobView({ externalId: "VID1", lastError: "unconfirmed" }) });
  assert.match(seen, /already seen on the platform/);
  assert.ok(!/Retry in the browser window/.test(seen));
  assert.ok(!/I looked at the platform/.test(seen));
});

test("a scheduled post is shown as scheduled, from the platform's read-back, with no publish button", () => {
  const html = renderCard("youtube", {
    status: "SCHEDULED",
    job: jobView({
      status: "SCHEDULED",
      externalId: "VID1",
      scheduledFor: new Date(2027, 0, 5, 15, 30).toISOString(),
      reviewUrl: "https://studio.youtube.com/video/VID1/edit",
    }),
  });
  assert.match(html, /Scheduled for/);
  assert.match(html, /as the platform read it back/);
  assert.match(html, /VID1/);
  assert.ok(!/Publish via browser window/.test(html), "nothing to publish again");
});

test("an unavailable route says why and offers no button; an episode that is not yours says so", () => {
  const none = renderCard("youtube", { browser: { available: false, reason: "No Chromium was found on this server.", canSchedule: true, headless: false } });
  assert.match(none, /No Chromium was found/);
  assert.ok(!/Publish via browser window/.test(none));
  const notMine = renderCard("youtube", {}, false);
  assert.match(notMine, /does not belong to this account/);
  assert.ok(!/Publish via browser window/.test(notMine));
  const hidden = renderCard("youtube", { browser: { available: true, reason: null, canSchedule: true, headless: true } });
  assert.match(hidden, /BOOKREEL_PUBLISH_HEADLESS is on/);
});

test("the Publish page no longer lays out the Connection and Browser Window cards, but the cards, the routes and the hand-off all still exist", async () => {
  // The wireframe drops the Connection and Browser Window SECTIONS from the page. They are removed from the
  // layout, not from the app: the components, the OAuth routes, the sign-in route and the publish route stay,
  // and the hand-off (post it by hand) is still rendered, folded.
  const source = await fs.readFile(fileURLToPath(new URL("../src/components/PublishCenter.tsx", import.meta.url)), "utf8");
  const code = withoutComments(source);
  assert.doesNotMatch(code, /<YouTubePublish\b/, "no Connection section in the layout");
  assert.doesNotMatch(code, /<InstagramPublish\b/, "no Connection section in the layout");
  assert.doesNotMatch(code, /<BrowserPublish\b/, "no Browser Window section in the layout");
  assert.match(code, /<HandoffCard\b/, "the hand-off block is still rendered");
  assert.match(code, /<PublishFlow\b/, "and the publish buttons are the page's own");

  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const kept of [
    "src/components/YouTubePublish.tsx",
    "src/components/InstagramPublish.tsx",
    "src/components/BrowserPublish.tsx",
    "src/app/api/publish/youtube/route.ts",
    "src/app/api/publish/youtube/connect/route.ts",
    "src/app/api/publish/instagram/route.ts",
    "src/app/api/publish/browser/signin/route.ts",
    "src/app/api/episodes/[id]/publish/browser/route.ts",
    "src/lib/publish/browser/run.ts",
    "src/lib/publish/browser/signin.ts",
  ]) {
    await fs.access(path.join(root, kept));
  }

  const card = withoutComments(await fs.readFile(fileURLToPath(new URL("../src/components/BrowserPublish.tsx", import.meta.url)), "utf8"));
  assert.match(card, /\/publish\/browser/);
  assert.equal([...card.matchAll(/acknowledgeRetry:\s*awaiting && looked/g)].length, 1, "the acknowledgement is sent only from the ticked box");
  assert.doesNotMatch(card, /setInterval|setTimeout/, "nothing in the card retries by itself");
});

// ======================================================================= ATTACHING TO THE OPERATOR'S OWN CHROME
//
// BOOKREEL_PUBLISH_CHROME_CDP makes the engine attach to a Chrome the operator
// started and signed in to, instead of launching one. Everything below runs
// against `fakeChrome`: no Chrome, no socket, no network. What it proves is the
// decisions -- which seam is used, that nothing of the operator's is ever closed,
// that an unreachable Chrome is a REQUIRES_CONNECTION and not a fall back, and
// that the YouTube channel gate is still the gate.

const CDP = "http://127.0.0.1:9222";

async function publishYouTubeViaChrome(
  script: YtScript,
  options: BrowserPublishOptions,
  root: string,
  chromeOptions: { env?: Record<string, string | undefined>; chrome?: "up" | "down" | "no-tab"; endpoint?: string } = {},
) {
  const site = youtubeSite(script);
  const chrome = fakeChrome(site.page, { profileRoot: root, ...chromeOptions });
  const outcome = await browserYouTubePublisher({ env: chrome.deps.env, options, deps: chrome.deps }).publish(prepared("youtube"));
  return { outcome, site, chrome };
}

/** Every outcome must leave the operator's Chrome exactly as it was: attached to, then let go of. */
function assertLetGo(chrome: ReturnType<typeof fakeChrome>, why: string): void {
  assert.equal(chrome.context.closeCalls, 0, `${why}: the operator's browser context was not closed`);
  assert.deepEqual(chrome.operatorTab.actions, [], `${why}: the operator's own tab was never navigated or touched`);
  assert.equal(chrome.launches.length, 0, `${why}: nothing was launched (no fall back to Chromium)`);
  assert.equal(hasLeftOpenWindow("youtube"), false, `${why}: no window is registered for a later job to close`);
  assert.equal(isPlatformBusy("youtube"), false, `${why}: the lock was released`);
}

test("attach: the endpoint is read from BOOKREEL_PUBLISH_CHROME_CDP; unset means launch; only a loopback http address is accepted", () => {
  assert.equal(CDP_ENV, "BOOKREEL_PUBLISH_CHROME_CDP");
  assert.equal(cdpEndpoint({}), null);
  assert.equal(cdpEndpoint({ [CDP_ENV]: "" }), null);
  assert.equal(cdpEndpoint({ [CDP_ENV]: "   " }), null);
  assert.equal(cdpEndpoint({ [CDP_ENV]: ` ${CDP} ` }), CDP);

  for (const ok of [CDP, "http://localhost:9222", "http://[::1]:9222", `${CDP}/`]) {
    assert.equal(cdpEndpointProblem(ok), null, ok);
  }
  // A bare channel name would make Playwright read Chrome's profile directory; a
  // non-loopback address would hand a browser's every session to another machine.
  for (const bad of ["chrome", "msedge", "not a url", "ws://127.0.0.1:9222/devtools/browser/x", "https://127.0.0.1:9222", "http://192.168.1.10:9222", "http://example.com:9222", "http://0.0.0.0:9222"]) {
    assert.notEqual(cdpEndpointProblem(bad), null, bad);
  }
});

test("attach: with an endpoint the engine CONNECTS and opens its own tab; without one it LAUNCHES, exactly as before", async () => {
  const root = await tempRoot();
  try {
    const page = new FakePage();
    const chrome = fakeChrome(page, { profileRoot: root });
    const session = await openSession("youtube", chrome.deps);

    assert.deepEqual(chrome.connects, [{ endpoint: CDP, argCount: 1 }], "it attached to the configured address, passing nothing else");
    assert.equal(chrome.launches.length, 0, "and launched nothing");
    assert.equal(session.page, page, "the job drives the new tab it opened");
    assert.notEqual(session.page, chrome.operatorTab, "never one of the operator's own tabs");
    assert.equal(chrome.context.opened.length, 1);
    assert.equal(session.headless, false);
    assert.deepEqual(await fs.readdir(root), [], "no profile directory was created: there is no profile of ours");
    assert.equal(await session.finish({ leaveOpen: true }), true, "the tab is left in the operator's Chrome");
    assert.equal(chrome.disconnects, 1);
    assertLetGo(chrome, "attach");

    // BOOKREEL_PUBLISH_HEADLESS has no say over a browser this app did not start.
    const hidden = fakeChrome(new FakePage(), { profileRoot: root, env: { BOOKREEL_PUBLISH_HEADLESS: "1" } });
    const s2 = await openSession("youtube", hidden.deps);
    assert.equal(s2.headless, false);
    await s2.finish({ leaveOpen: false });
    assert.equal(hidden.context.closeCalls, 0, "not even a finish that does not ask to leave it open closes the operator's context");
    assert.equal(hidden.disconnects, 1);

    // Unset: the launch path, unchanged. `connect` is never reached.
    const plain = fakeBrowser(new FakePage(), { profileRoot: root });
    let attaches = 0;
    const deps = {
      ...plain.deps,
      connect: async () => {
        attaches++;
        throw new Error("must not attach when no endpoint is configured");
      },
    };
    const launched = await openSession("youtube", deps);
    assert.equal(plain.launches.length, 1, "it launched");
    assert.equal(attaches, 0, "and attached to nothing");
    assert.deepEqual(plain.launches[0].options, launchOptionsFor({}));
    assert.equal(await launched.finish({ leaveOpen: false }), false);
    assert.equal(plain.context.closed, true, "a launched window is still closed when the job ends");

    // The bundled-Chromium question is only asked in launch mode.
    assert.match(chromiumProblem({ env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, locate: () => null }) ?? "", /No Chromium was found/);
    assert.equal(chromiumProblem({ env: { [CDP_ENV]: CDP }, locate: () => null }), null, "no Chromium is needed when Chrome is attached to");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("attach: whatever the outcome, the job only DISCONNECTS -- the operator's browser, context and tabs are never closed", async () => {
  const root = await tempRoot();
  try {
    const cases: Array<[string, YtScript, BrowserPublishOptions, string]> = [
      ["published", {}, { madeForKids: false }, "PUBLISHED"],
      ["a sign-in is needed", { signedOut: true }, { madeForKids: false }, "AWAITING_HUMAN"],
      ["a security check is on screen", { challengeUrl: true }, { madeForKids: false }, "AWAITING_HUMAN"],
      ["the wrong channel is signed in", { handle: "@someone-else" }, { madeForKids: false }, "AWAITING_HUMAN"],
      ["the read-back disagrees after the button", { readVisibility: "Public" }, { madeForKids: false }, "AWAITING_HUMAN"],
    ];
    for (const [why, script, options, expected] of cases) {
      const r = await publishYouTubeViaChrome(script, options, root);
      assert.equal(r.outcome.status, expected, why);
      assert.equal(r.chrome.connects.length, 1, why);
      assert.equal(r.chrome.disconnects, 1, `${why}: the connection was dropped, once`);
      assertLetGo(r.chrome, why);
    }

    // A site that cannot be opened at all: FAILED, and still only a disconnect.
    const site = youtubeSite({});
    site.page.gotoError = (url) => (url === YT.studio ? new Error("net::ERR_NAME_NOT_RESOLVED") : null);
    const unreachableSite = fakeChrome(site.page, { profileRoot: root });
    const failed = await browserYouTubePublisher({
      env: unreachableSite.deps.env,
      options: { madeForKids: false },
      deps: unreachableSite.deps,
    }).publish(prepared());
    assert.equal(failed.status, "FAILED");
    assert.equal(unreachableSite.disconnects, 1);
    assertLetGo(unreachableSite, "Studio unreachable");

    // An exception out of the flow is AWAITING_HUMAN, and still only a disconnect.
    const boom = fakeChrome(new FakePage(), { profileRoot: root });
    const thrown = await runInSession("youtube", boom.deps, async () => {
      throw new Error("kaboom");
    });
    assert.equal(thrown.status, "AWAITING_HUMAN");
    assert.equal(boom.disconnects, 1);
    assertLetGo(boom, "an exception");

    // A Retry attaches again and opens a new tab; the stop before it left nothing for it to close.
    const retrySite = youtubeSite({ signedOut: true });
    const retry = fakeChrome(retrySite.page, { profileRoot: root });
    const provider = browserYouTubePublisher({ env: retry.deps.env, options: { madeForKids: false }, deps: retry.deps });
    assert.equal((await provider.publish(prepared())).status, "AWAITING_HUMAN");
    assert.equal((await provider.publish(prepared())).status, "AWAITING_HUMAN");
    assert.equal(retry.connects.length, 2);
    assert.equal(retry.disconnects, 2);
    assert.equal(retry.context.opened.length, 2, "each job opened its own tab");
    assertLetGo(retry, "a retry");

    // Hidden-window setting: irrelevant here, so a sign-in is asked of the person, not blamed on the setting.
    const h = await publishYouTubeViaChrome({ signedOut: true }, { madeForKids: false }, root, { env: { BOOKREEL_PUBLISH_HEADLESS: "1" } });
    const msg = (h.outcome as { error: string }).error;
    assert.match(msg, /sign in/i);
    assert.match(msg, /never types or stores your password/);
    assert.doesNotMatch(msg, /running hidden|BOOKREEL_PUBLISH_HEADLESS/);
    assert.deepEqual(h.site.page.touched(), [], "the sign-in page was only looked at");
    assertLetGo(h.chrome, "headless set");

    assert.deepEqual(await fs.readdir(root), [], "no profile directory was ever created");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("attach: an unreachable Chrome is REQUIRES_CONNECTION with the steps -- never a crash, never a quiet fall back to Chromium", async () => {
  const root = await tempRoot();
  try {
    const refused = await publishYouTubeViaChrome({}, { madeForKids: false }, root, { chrome: "down" });
    assert.equal(refused.outcome.status, "REQUIRES_CONNECTION");
    const text = (refused.outcome as { error: string }).error;
    assert.match(text, /Could not attach to Chrome at http:\/\/127\.0\.0\.1:9222/);
    assert.match(text, /--remote-debugging-port=9222/);
    assert.match(text, /--user-data-dir=/);
    assert.match(text, /quit Chrome completely/);
    assert.match(text, /Nothing was sent/);
    assert.equal(refused.chrome.connects.length, 1, "one attach attempt, no loop");
    assert.equal(refused.chrome.launches.length, 0, "and NO launch of a bundled Chromium");
    assert.deepEqual(refused.site.page.actions, [], "no page was touched");
    assert.equal(refused.chrome.disconnects, 0, "nothing was attached, so nothing to drop");
    assert.equal(isPlatformBusy("youtube"), false);

    // The port in the instructions is the configured one.
    const other = await publishYouTubeViaChrome({}, { madeForKids: false }, root, { chrome: "down", endpoint: "http://127.0.0.1:9333" });
    assert.match((other.outcome as { error: string }).error, /--remote-debugging-port=9333/);

    // Attached, but no tab could be opened: the same, and the connection is still dropped.
    const noTab = await publishYouTubeViaChrome({}, { madeForKids: false }, root, { chrome: "no-tab" });
    assert.equal(noTab.outcome.status, "REQUIRES_CONNECTION");
    assert.match((noTab.outcome as { error: string }).error, /could not open a tab/);
    assert.equal(noTab.chrome.disconnects, 1);
    assert.equal(noTab.chrome.context.closeCalls, 0);

    // An address that is not this computer is refused before any connection is made.
    const remote = await publishYouTubeViaChrome({}, { madeForKids: false }, root, { endpoint: "http://192.168.1.10:9222" });
    assert.equal(remote.outcome.status, "REQUIRES_CONNECTION");
    assert.match((remote.outcome as { error: string }).error, /only this computer is allowed/);
    assert.equal(remote.chrome.connects.length, 0);
    assert.equal(remote.chrome.launches.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("attach: 'is it available' means 'does the operator's Chrome answer', not 'is a Chromium installed'", async () => {
  const root = await tempRoot();
  try {
    const up = fakeChrome(new FakePage(), { profileRoot: root });
    const down = fakeChrome(new FakePage(), { profileRoot: root, chrome: "down" });

    // Configured with NO bundled Chromium at all (`locate` finds none).
    const provider = browserYouTubePublisher({ env: up.deps.env, deps: up.deps });
    assert.equal(await provider.isConfigured(), true);
    assert.deepEqual(up.probes, [`${CDP}/json/version`], "it asked the debugging port, and nothing else");
    assert.equal(await browserInstagramPublisher({ env: up.deps.env, deps: up.deps }).isConfigured(), true);
    assert.equal(await browserProblem("youtube", up.deps), null);

    assert.equal(await browserYouTubePublisher({ env: down.deps.env, deps: down.deps }).isConfigured(), false);
    const problem = (await browserProblem("youtube", down.deps)) ?? "";
    assert.match(problem, /Could not reach a Chrome with remote debugging at http:\/\/127\.0\.0\.1:9222/);
    assert.match(problem, /--remote-debugging-port=9222/);
    assert.match(problem, /--user-data-dir=/);
    assert.match(problem, /Chrome 136/);
    assert.match(problem, /Nothing was sent/);

    // Something answering on the port that is not Chrome's debugging endpoint is not Chrome.
    for (const reply of [new Response("{}", { status: 200 }), new Response("nope", { status: 500 }), new Response("<html>", { status: 200 })]) {
      const odd = { ...up.deps, fetchImpl: (async () => reply) as unknown as typeof fetch };
      assert.match((await browserProblem("youtube", odd)) ?? "", /Could not reach a Chrome/);
    }
    // And the launch-mode answer is the old one.
    assert.match((await browserProblem("youtube", { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, locate: () => null })) ?? "", /No Chromium was found/);
    assert.equal(await browserProblem("youtube", { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, locate: () => "C:/chrome.exe" }), null);

    // The browser provider stays the browser provider: no silent swap to the API one.
    const asked = publisherFor("youtube", { mode: "browser", env: down.deps.env, browser: { deps: down.deps } });
    assert.equal(await asked.isConfigured(), false);
    assert.equal(asked.capabilities().canSchedule, true);

    // What the card is told.
    const viewUp = await browserModeFor("youtube", { env: up.deps.env, browser: { deps: up.deps } });
    assert.deepEqual(viewUp, { available: true, reason: null, canSchedule: true, headless: false, attach: { endpoint: CDP } });
    const hidden = fakeChrome(new FakePage(), { profileRoot: root, env: { BOOKREEL_PUBLISH_HEADLESS: "1" } });
    const viewHidden = await browserModeFor("instagram", { env: hidden.deps.env, browser: { deps: hidden.deps } });
    assert.equal(viewHidden?.headless, false, "the headless setting is not the operator's Chrome's business");
    assert.equal(viewHidden?.available, true);
    const viewDown = await browserModeFor("youtube", { env: down.deps.env, browser: { deps: down.deps } });
    assert.equal(viewDown?.available, false);
    assert.match(viewDown?.reason ?? "", /Could not reach a Chrome with remote debugging at http:\/\/127\.0\.0\.1:9222/);
    assert.deepEqual(viewDown?.attach, { endpoint: CDP });
    const launchView = await browserModeFor("youtube", { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, browser: { deps: { locate: () => "C:/chrome.exe" } } });
    assert.equal(launchView?.attach, undefined, "launch mode carries no attach");

    // What the provider says it needs.
    const needs = publisherFor("youtube", { mode: "browser", env: up.deps.env }).capabilities().requires.join(" | ");
    assert.match(needs, /BOOKREEL_PUBLISH_CHROME_CDP/);
    assert.doesNotMatch(needs, /A Chromium on this server/);
    assert.match(publisherFor("youtube", { mode: "browser", env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } }).capabilities().requires.join(" | "), /A Chromium on this server/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("attach: the YouTube channel gate holds -- a wrong channel is refused, an unreadable one only passes for a private upload", async () => {
  const root = await tempRoot();
  try {
    const wrong = await publishYouTubeViaChrome({ handle: "@someone-else" }, { madeForKids: false }, root);
    assert.equal(wrong.outcome.status, "AWAITING_HUMAN");
    assert.match((wrong.outcome as { error: string }).error, /Wrong YouTube channel/);
    assert.match((wrong.outcome as { error: string }).error, /Switch account → select between_pages \(@betweenpages08-l4d\)/);
    assert.ok(!wrong.site.page.actions.some((a) => a.startsWith("files:")), "nothing was uploaded to the wrong channel");
    assert.equal(wrong.site.s.pressed, 0);
    assertLetGo(wrong.chrome, "wrong channel");

    for (const visibility of ["public", "unlisted"] as const) {
      const unreadable = await publishYouTubeViaChrome({ handle: null }, { madeForKids: false, visibility, confirmPublic: true }, root);
      assert.equal(unreadable.outcome.status, "AWAITING_HUMAN", visibility);
      assert.match((unreadable.outcome as { error: string }).error, /did not say which channel/);
      assert.ok(!unreadable.site.page.actions.some((a) => a.startsWith("files:")), `${visibility}: nothing was uploaded`);
      assert.equal(unreadable.site.s.pressed, 0);
      assertLetGo(unreadable.chrome, `unreadable, ${visibility}`);
    }
    const when = new Date(Date.now() + 2 * 86_400_000);
    const scheduled = await publishYouTubeViaChrome({ handle: null }, { madeForKids: false, scheduledAt: when, confirmPublic: true }, root);
    assert.equal(scheduled.outcome.status, "AWAITING_HUMAN", "a schedule is public-at-a-time, so it is held to the same rule");
    assert.equal(scheduled.site.s.pressed, 0);

    const unreadablePrivate = await publishYouTubeViaChrome({ handle: null }, { madeForKids: false }, root);
    assert.equal(unreadablePrivate.outcome.status, "AWAITING_HUMAN", "all uploads require a verified channel");
    assertLetGo(unreadablePrivate.chrome, "unreadable, private");

    const right = await publishYouTubeViaChrome({}, { madeForKids: false, visibility: "unlisted" }, root);
    assert.equal(right.outcome.status, "PUBLISHED", "the expected channel passes");
    const custom = await publishYouTubeViaChrome({ handle: "@my-brand" }, { madeForKids: false }, root, { env: { BOOKREEL_YOUTUBE_HANDLE: "my-brand" } });
    assert.equal(custom.outcome.status, "PUBLISHED", "the expected handle is still configurable");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("attach: a start is refused with a 409 and the steps, before any row, when the operator's Chrome cannot be reached", async () => {
  const s = await seed(2);
  seeds.push(s);
  const [ep] = s.episodes;
  const root = await tempRoot();
  try {
    const down = fakeChrome(new FakePage(), { profileRoot: root, chrome: "down" });
    await assert.rejects(
      () => startBrowserPublish(s.ownerId, ep, "youtube", { madeForKids: false, env: down.deps.env, deps: down.deps }),
      (err: unknown) =>
        isApp(err) &&
        err.code === "requires_connection" &&
        err.status === 409 &&
        /Could not reach a Chrome with remote debugging/.test(err.message) &&
        /--remote-debugging-port=9222/.test(err.message) &&
        !/No Chromium was found/.test(err.message),
    );
    assert.equal(down.launches.length, 0, "no bundled Chromium was tried instead");
    assert.equal(down.connects.length, 0, "and nothing was attached");
    assert.equal(await row(ep, "youtube"), null, "no refusal left a row behind");

    // The view the Publish Center polls says the same, and says it is attaching.
    const view = await publishView(s.ownerId, ep, { env: down.deps.env, browser: { deps: down.deps } });
    for (const p of view.platforms) {
      assert.equal(p.browser?.available, false);
      assert.deepEqual(p.browser?.attach, { endpoint: CDP });
    }
    const up = fakeChrome(new FakePage(), { profileRoot: root });
    const ok = await publishView(s.ownerId, ep, { env: up.deps.env, browser: { deps: up.deps } });
    for (const p of ok.platforms) {
      assert.equal(p.browser?.available, true, "available with no Chromium installed");
      assert.equal(p.browser?.headless, false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GUARD: attaching adds no stealth, no launch option and no profile access, and its disconnect closes no context", async () => {
  // Behaviour: the attach is handed the address and nothing else; nothing is launched.
  const root = await tempRoot();
  try {
    const chrome = fakeChrome(new FakePage(), { profileRoot: root });
    const session = await openSession("youtube", chrome.deps);
    assert.deepEqual(chrome.connects, [{ endpoint: CDP, argCount: 1 }]);
    assert.equal(chrome.launches.length, 0);
    await session.finish({ leaveOpen: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  // Source: the attach path is typed so that it cannot close what it attached to.
  const engine = withoutComments(await fs.readFile(path.join(BROWSER_DIR, "engine.ts"), "utf8"));
  assert.match(
    engine,
    /interface AttachedBrowser\s*\{\s*context:\s*Pick<ContextLike,\s*"pages"\s*\|\s*"newPage">;\s*disconnect\(\):\s*Promise<void>;\s*\}/,
    "the attached context is only what a job needs: it has no close",
  );
  const attachBody = engine.slice(engine.indexOf("async function attachSession"), engine.indexOf("export async function openSession"));
  assert.ok(attachBody.length > 200, "found the attach path");
  assert.doesNotMatch(attachBody, /\.close\s*\(/, "the attach path never calls close on anything");
  assert.doesNotMatch(attachBody, /closeLeftOpenWindow|leaveWindowOpen|forgetWindow/, "it neither registers nor closes a window");
  // The one disconnect: a single closure, in the single place that attaches.
  assert.equal([...engine.matchAll(/\bbrowser\.close\s*\(/g)].length, 1, "exactly one `browser.close()`: the disconnect inside connectChrome");
  assert.match(engine, /const disconnect = \(\) => browser\.close\(\);/);
  // And `context.close()` exists only in the LAUNCH branch of openSession.
  const launchPath = engine.slice(engine.indexOf("export async function openSession"), engine.indexOf("export async function runInSession"));
  assert.equal(
    [...launchPath.matchAll(/\bcontext\.close\s*\(/g)].length,
    [...engine.matchAll(/\bcontext\.close\s*\(/g)].length,
    "every context.close() is inside openSession's launch branch",
  );
});

test("the card, when the server attaches to your own Chrome, says so and lists the steps; it keeps the password and sign-in promises", () => {
  const attach = { endpoint: CDP };
  const up = renderCard("youtube", { browser: { available: true, reason: null, canSchedule: true, headless: false, attach } });
  assert.match(up, /Attaches to your own Chrome/);
  assert.match(up, /at http:\/\/127\.0\.0\.1:9222/);
  assert.match(up, /never types or stores your password/);
  assert.match(up, /never reads or copies your Chrome profile/);
  assert.match(up, /do it in that tab, then press Retry/, "the sign-in / security-check pause is still the person's");
  assert.match(up, /remote-debugging-port=9222/);
  assert.match(up, /--user-data-dir=/);
  assert.match(up, /Chrome 136/);
  assert.match(up, /@betweenpages08-l4d/);
  assert.match(up, /BookReel stops if it is a different one/, "the channel gate is explained");
  assert.match(up, /recommended route/, "the API is still the recommended route");
  assert.match(up, /Publish via browser window/);
  assert.doesNotMatch(up, /Opens a real browser window/, "not the bundled-Chromium copy");
  assert.doesNotMatch(up, /<details[^>]*open=""/, "the steps are folded away while Chrome is reachable");

  const ig = renderCard("instagram", { browser: { available: true, reason: null, canSchedule: false, headless: false, attach } });
  assert.match(ig, /sign in to Instagram yourself/);

  const down = renderCard("youtube", {
    browser: { available: false, reason: "Could not reach a Chrome with remote debugging at http://127.0.0.1:9222.", canSchedule: true, headless: false, attach },
  });
  assert.match(down, /Could not reach a Chrome with remote debugging/, "the connect error is shown");
  assert.match(down, /remote-debugging-port=9222/, "with the steps");
  assert.match(down, /<details[^>]*open=""/, "open, because they are what is needed now");
  assert.doesNotMatch(down, /Publish via browser window/, "and there is nothing to press");

  // A channel mismatch is shown verbatim, as for every stop, and Retry is behind the box.
  const mismatch = renderCard("youtube", {
    browser: { available: true, reason: null, canSchedule: true, headless: false, attach },
    status: "AWAITING_HUMAN",
    job: jobView({ lastError: "Wrong YouTube channel. In the open YouTube Studio window, click your profile icon → Switch account → select between_pages (@betweenpages08-l4d). Confirm the channel dashboard, then return to BookReel and click Retry." }),
  });
  assert.match(mismatch, /Wrong YouTube channel/);
  assert.match(mismatch, /I looked at the platform/);

  // Not configured: the copy is the existing bundled-Chromium copy, and no attach text appears.
  const plain = renderCard("youtube", {});
  assert.match(plain, /real browser window/);
  assert.doesNotMatch(plain, /Attaches to your own Chrome|remote-debugging-port/);
});

// ======================================================================= THE INSTALLED CHROME (a channel)
//
// BOOKREEL_PUBLISH_BROWSER_CHANNEL=chrome makes the LAUNCH path open the browser
// installed on this computer instead of the bundled Chromium, on the same
// dedicated, BookReel-created profile. The one thing that changes is the `channel`
// launch option. Everything below runs against `fakeBrowser`: no Chrome is
// started, no window opens, nothing touches Google. What it proves is the
// decisions -- what is passed to the launcher, that a missing Chrome is a message
// and not a crash or a quiet fall back, that attaching still outranks it, and that
// the channel gate still stops an upload.

const CHANNEL_CHROME = { [CHANNEL_ENV]: "chrome", BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" };
const TODAYS_OPTIONS = { headless: false, viewport: { width: 1366, height: 900 }, timeout: 60_000, chromiumSandbox: true };
const NOT_INSTALLED = /Google Chrome is not installed, or Playwright could not find it; install Chrome or unset BOOKREEL_PUBLISH_BROWSER_CHANNEL\. Nothing was opened\./;

async function publishYouTubeViaChannel(
  script: YtScript,
  options: BrowserPublishOptions,
  root: string,
  env: Record<string, string | undefined> = CHANNEL_CHROME,
) {
  const site = youtubeSite(script);
  // `chromium: false`: no bundled Chromium exists, so nothing can be launched by accident.
  const fake = fakeBrowser(site.page, { profileRoot: root, env, chromium: false });
  const outcome = await browserYouTubePublisher({ env, options, deps: fake.deps }).publish(prepared("youtube"));
  return { outcome, ...site, ...fake };
}

test("channel: the setting is exactly chrome or msedge; launchOptionsFor adds `channel` only then and is otherwise byte-identical to today", () => {
  assert.equal(CHANNEL_ENV, "BOOKREEL_PUBLISH_BROWSER_CHANNEL");

  // Unset, empty or anything else: no `channel` key at all, and the same bytes as before.
  const notAChannel: Array<string | undefined> = [
    undefined, "", "   ", "chromium", "firefox", "chrome-beta", "chrome-canary", "msedge-dev", "true", "1",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "../chrome",
    "chrome --disable-blink-features=AutomationControlled", "chrome,msedge",
  ];
  for (const value of notAChannel) {
    const env = value === undefined ? {} : { [CHANNEL_ENV]: value };
    assert.equal(browserChannel(env), null, JSON.stringify(value));
    const options = launchOptionsFor(env);
    assert.equal("channel" in options, false, `${JSON.stringify(value)}: no channel key`);
    assert.deepEqual(options, TODAYS_OPTIONS);
    assert.equal(JSON.stringify(options), JSON.stringify(TODAYS_OPTIONS), `${JSON.stringify(value)}: byte-identical to the default options`);
  }
  assert.equal(JSON.stringify(launchOptionsFor({})), JSON.stringify(TODAYS_OPTIONS));

  // The two accepted values, however they are cased or padded.
  for (const [value, expected] of [["chrome", "chrome"], ["msedge", "msedge"], [" Chrome ", "chrome"], ["MSEDGE", "msedge"]] as const) {
    assert.equal(browserChannel({ [CHANNEL_ENV]: value }), expected, value);
    const options = launchOptionsFor({ [CHANNEL_ENV]: value });
    assert.deepEqual(options, { ...TODAYS_OPTIONS, channel: expected });
    assert.deepEqual(Object.keys(options).sort(), ["channel", "chromiumSandbox", "headless", "timeout", "viewport"]);
  }
  // The other settings still apply on top of it.
  assert.deepEqual(launchOptionsFor({ ...CHANNEL_CHROME, BOOKREEL_PUBLISH_HEADLESS: "1" }), { ...TODAYS_OPTIONS, headless: true, channel: "chrome" });
});

test("GUARD: with a channel the launch options are the same three plus `channel` -- still no stealth, no flags, no user agent, no scripts", async () => {
  const forbidden = ["AutomationControlled", "disable-blink-features", "enable-automation", "userAgent", "ignoreDefaultArgs", "args", "stealth", "executablePath", "addInitScript", "webdriver"];
  for (const value of ["chrome", "msedge", " Chrome "]) {
    for (const headless of [undefined, "1"]) {
      const options = launchOptionsFor({ [CHANNEL_ENV]: value, BOOKREEL_PUBLISH_HEADLESS: headless });
      // EXACTLY these keys. `channel` is a choice of real, installed browser and `chromiumSandbox` is a security
      // setting (sandbox ON, so no `--no-sandbox`); anything else would be presentation and fails.
      assert.deepEqual(Object.keys(options).sort(), ["channel", "chromiumSandbox", "headless", "timeout", "viewport"]);
      assert.ok(options.channel === "chrome" || options.channel === "msedge", "channel is only ever chrome or msedge");
      const wire = JSON.stringify(options);
      for (const word of forbidden) assert.ok(!wire.includes(word), `the launch options must not contain ${word}`);
    }
  }
  // A hostile value is not "almost a channel": it is no channel, and brings no option with it.
  for (const hostile of [
    "chrome --disable-blink-features=AutomationControlled",
    "chrome\n--user-agent=x",
    "--enable-automation",
    "chrome;args",
    "C:\\chrome.exe",
  ]) {
    const options = launchOptionsFor({ [CHANNEL_ENV]: hostile });
    assert.deepEqual(Object.keys(options).sort(), ["chromiumSandbox", "headless", "timeout", "viewport"], hostile);
    assert.ok(!JSON.stringify(options).includes("blink"), hostile);
  }

  // What openSession really hands the launcher, for each platform and each channel: those options, a fresh profile.
  const root = await tempRoot();
  try {
    for (const channel of ["chrome", "msedge"] as const) {
      for (const platform of ["youtube", "instagram"] as const) {
        const fake = fakeBrowser(new FakePage(), { profileRoot: root, env: { [CHANNEL_ENV]: channel }, chromium: false });
        const session = await openSession(platform, fake.deps);
        assert.equal(fake.launches.length, 1);
        assert.deepEqual(Object.keys(fake.launches[0].options).sort(), ["channel", "chromiumSandbox", "headless", "timeout", "viewport"]);
        assert.deepEqual(fake.launches[0].options, { ...TODAYS_OPTIONS, channel });
        await session.finish({ leaveOpen: false });
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("channel: the launch hands `channel` to the launcher on the dedicated empty profile; unset, the launch is the bundled one, unchanged", async () => {
  const root = await tempRoot();
  try {
    // No bundled Chromium exists at all (`locate` finds none) and it does not matter: the installed Chrome is what is asked for.
    const chrome = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    assert.equal(chromiumProblem(chrome.deps), null);
    const session = await openSession("youtube", chrome.deps);
    assert.equal(chrome.launches.length, 1);
    assert.deepEqual(chrome.launches[0].options, { ...launchOptionsFor({}), channel: "chrome" });
    // The dedicated, BookReel-created, per-platform profile -- empty, under the work root, nowhere near a personal one.
    assert.equal(chrome.launches[0].profileDir, profileDirFor("youtube", root));
    assert.ok(chrome.launches[0].profileDir.startsWith(path.join(root, "browser-profiles")));
    assert.deepEqual(await fs.readdir(chrome.launches[0].profileDir), [], "nothing was copied into it");
    assert.equal(session.headless, false, "a visible window, so a person can sign in");

    // BookReel owns this window: it is left open for a person, then closed by the next job -- as for any launched window.
    assert.equal(await session.finish({ leaveOpen: true }), true);
    assert.equal(chrome.context.closed, false);
    assert.equal(hasLeftOpenWindow("youtube"), true);
    await closeLeftOpenWindow("youtube");
    assert.equal(chrome.context.closed, true);
    assert.equal(hasLeftOpenWindow("youtube"), false);

    // ...and closed at the end of a job that does not ask for it to stay.
    const done = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    const s2 = await openSession("youtube", done.deps);
    assert.equal(await s2.finish({ leaveOpen: false }), false);
    assert.equal(done.context.closed, true);

    // A hidden window cannot be left for a person: it is closed, whatever was asked.
    const hidden = fakeBrowser(new FakePage(), { profileRoot: root, env: { ...CHANNEL_CHROME, BOOKREEL_PUBLISH_HEADLESS: "1" }, chromium: false });
    const s3 = await openSession("youtube", hidden.deps);
    assert.equal(hidden.launches[0].options.headless, true);
    assert.equal(await s3.finish({ leaveOpen: true }), false);
    assert.equal(hidden.context.closed, true);

    // The default (no channel): the bundled launch, exactly as before, with no channel passed.
    const plain = fakeBrowser(new FakePage(), { profileRoot: root });
    const s4 = await openSession("youtube", plain.deps);
    assert.deepEqual(plain.launches[0].options, launchOptionsFor({}));
    assert.equal("channel" in plain.launches[0].options, false);
    assert.deepEqual(plain.launches[0].options, TODAYS_OPTIONS);
    await s4.finish({ leaveOpen: false });

    // msedge is passed through as itself.
    const edge = fakeBrowser(new FakePage(), { profileRoot: root, env: { [CHANNEL_ENV]: "msedge" }, chromium: false });
    const s5 = await openSession("instagram", edge.deps);
    assert.equal(edge.launches[0].options.channel, "msedge");
    assert.equal(edge.launches[0].profileDir, profileDirFor("instagram", root));
    await s5.finish({ leaveOpen: false });
  } finally {
    await closeLeftOpenWindow("youtube");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("channel: the installed browser is looked for in Playwright's own places, by its program file only", async () => {
  const root = await tempRoot();
  try {
    if (process.platform === "win32") {
      assert.equal(locateBrowserChannel("chrome", {}), null, "an empty environment names no install location");
      assert.equal(locateBrowserChannel("chrome", { LOCALAPPDATA: root }), null, "nothing there yet");
      const exe = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
      await fs.mkdir(path.dirname(exe), { recursive: true });
      await fs.writeFile(exe, "");
      assert.equal(locateBrowserChannel("chrome", { LOCALAPPDATA: root }), exe);
      assert.equal(locateBrowserChannel("chrome", { PROGRAMFILES: root }), exe, "also under Program Files");
      assert.equal(locateBrowserChannel("msedge", { LOCALAPPDATA: root }), null, "Edge is a different program");
    } else {
      const found = locateBrowserChannel("chrome");
      assert.ok(found === null || typeof found === "string");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("channel: Chrome not installed is REQUIRES_CONNECTION with a clear message -- no crash, no fallback to Chromium, none to attaching", async () => {
  const root = await tempRoot();
  try {
    const workDone: string[] = [];
    const work = async (): Promise<PublishOutcome> => {
      workDone.push("ran");
      return { status: "FAILED", error: "must not run" };
    };

    // (a) Known absent before anything is tried -- and a bundled Chromium being present does not rescue it.
    const absent = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, channelInstalled: false });
    let attaches = 0;
    const deps = {
      ...absent.deps,
      connect: async () => {
        attaches++;
        throw new Error("must not attach: no endpoint is configured");
      },
    };
    assert.match(chromiumProblem(deps) ?? "", NOT_INSTALLED);
    assert.match((await browserProblem("youtube", deps)) ?? "", NOT_INSTALLED);
    assert.equal(await browserYouTubePublisher({ env: deps.env, deps }).isConfigured(), false);
    assert.equal(await browserInstagramPublisher({ env: deps.env, deps }).isConfigured(), false);
    const pre = await runInSession("youtube", deps, work);
    assert.equal(pre.status, "REQUIRES_CONNECTION");
    assert.match((pre as { error: string }).error, NOT_INSTALLED);
    assert.deepEqual(workDone, [], "no page work was attempted");
    assert.equal(absent.launches.length, 0, "no launch of anything -- not the bundled Chromium either");
    assert.equal(attaches, 0, "and no attach");
    assert.equal(isPlatformBusy("youtube"), false, "the lock was released");

    // The same through a publisher, which is what the job runner calls.
    const viaPublisher = await browserYouTubePublisher({ env: deps.env, options: { madeForKids: false }, deps }).publish(prepared("youtube"));
    assert.equal(viaPublisher.status, "REQUIRES_CONNECTION");
    assert.match((viaPublisher as { error: string }).error, NOT_INSTALLED);

    // (b) Looked installed, but the launch itself throws (Playwright's own words are kept, first line only).
    const playwrightSays =
      "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\nRun \"npx playwright install chrome\"";
    const throwing = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, launchError: new Error(playwrightSays) });
    let attaches2 = 0;
    const throwingDeps = {
      ...throwing.deps,
      connect: async () => {
        attaches2++;
        throw new Error("must not attach");
      },
    };
    const post = await runInSession("youtube", throwingDeps, work);
    assert.equal(post.status, "REQUIRES_CONNECTION", "a connection to make, not a crash and not a FAILED that invites a blind retry");
    const text = (post as { error: string }).error;
    assert.match(text, /^Google Chrome did not start \(browserType\.launchPersistentContext: Chromium distribution 'chrome' is not found/);
    assert.match(text, NOT_INSTALLED);
    assert.doesNotMatch(text, /npx playwright install/, "only the first line of Playwright's message is shown");
    assert.deepEqual(workDone, [], "no page work was attempted");
    assert.equal(throwing.launches.length, 1, "one attempt, with the channel -- no second try on the bundled Chromium");
    assert.equal(throwing.launches[0].options.channel, "chrome");
    assert.equal(attaches2, 0, "no attach");
    assert.equal(hasLeftOpenWindow("youtube"), false);
    assert.equal(isPlatformBusy("youtube"), false);

    // A thrown non-Error is still a message, not a crash.
    const odd = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME });
    odd.deps.launch = async () => {
      throw "boom";
    };
    const oddOutcome = await runInSession("youtube", odd.deps, work);
    assert.equal(oddOutcome.status, "REQUIRES_CONNECTION");
    assert.match((oddOutcome as { error: string }).error, /Google Chrome did not start \(boom\)/);

    // Edge names itself.
    const noEdge = fakeBrowser(new FakePage(), { profileRoot: root, env: { [CHANNEL_ENV]: "msedge" }, channelInstalled: false });
    assert.match(chromiumProblem(noEdge.deps) ?? "", /Microsoft Edge is not installed, or Playwright could not find it; install Edge or unset BOOKREEL_PUBLISH_BROWSER_CHANNEL\. Nothing was opened\./);

    // Without a channel the failure is the old one, in the old words.
    const bundled = fakeBrowser(new FakePage(), { profileRoot: root, launchError: new Error("spawn failed") });
    const old = await runInSession("youtube", bundled.deps, work);
    assert.equal(old.status, "FAILED");
    assert.match((old as { error: string }).error, /^Chromium would not start: spawn failed\./);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("channel: a start is refused with a 409 and the message, before any row, when the installed Chrome is not there", async () => {
  const s = await seed(2);
  seeds.push(s);
  const [ep] = s.episodes;
  const root = await tempRoot();
  try {
    const absent = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, channelInstalled: false });
    await assert.rejects(
      () => startBrowserPublish(s.ownerId, ep, "youtube", { madeForKids: false, env: absent.deps.env, deps: absent.deps }),
      (err: unknown) =>
        isApp(err) && err.code === "requires_connection" && err.status === 409 && NOT_INSTALLED.test(err.message) && !/No Chromium was found/.test(err.message),
    );
    assert.equal(absent.launches.length, 0);
    assert.equal(await row(ep, "youtube"), null, "no refusal left a row behind");

    // The view the Publish Center polls says what it is and why it is unavailable.
    const view = await publishView(s.ownerId, ep, { env: absent.deps.env, browser: { deps: absent.deps } });
    for (const p of view.platforms) {
      assert.equal(p.browser?.available, false);
      assert.equal(p.browser?.channel, "chrome");
      assert.match(p.browser?.reason ?? "", NOT_INSTALLED);
      assert.equal(p.browser?.attach, undefined);
    }
    const present = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    const ok = await publishView(s.ownerId, ep, { env: present.deps.env, browser: { deps: present.deps } });
    for (const p of ok.platforms) {
      assert.equal(p.browser?.available, true, "available with no bundled Chromium at all");
      assert.equal(p.browser?.channel, "chrome");
      assert.equal(p.browser?.reason, null);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("channel: attaching to your own Chrome takes precedence when both settings are present; neither set is the bundled Chromium", async () => {
  const root = await tempRoot();
  try {
    const both = fakeChrome(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME });
    assert.equal(both.deps.env?.[CDP_ENV], CDP);
    assert.equal(both.deps.env?.[CHANNEL_ENV], "chrome");
    const deps: typeof both.deps = {
      ...both.deps,
      locateChannel: () => {
        throw new Error("the channel must not even be consulted when an endpoint is configured");
      },
    };

    assert.equal(chromiumProblem(deps), null);
    assert.equal(await browserProblem("youtube", deps), null);
    const session = await openSession("youtube", deps);
    assert.deepEqual(both.connects, [{ endpoint: CDP, argCount: 1 }], "it attached");
    assert.equal(both.launches.length, 0, "and launched nothing, channel or not");
    assert.equal(session.headless, false);
    assert.equal(await session.finish({ leaveOpen: false }), true);
    assert.equal(both.disconnects, 1);
    assert.equal(both.context.closeCalls, 0, "the operator's browser is still never closed");
    assertLetGo(both, "both settings");

    // What the card is told and what the provider says it needs: attach, with no channel.
    const view = await browserModeFor("youtube", { env: deps.env, browser: { deps } });
    assert.deepEqual(view, { available: true, reason: null, canSchedule: true, headless: false, attach: { endpoint: CDP } });
    const needs = publisherFor("youtube", { mode: "browser", env: deps.env }).capabilities().requires.join(" | ");
    assert.match(needs, /BOOKREEL_PUBLISH_CHROME_CDP/);
    assert.doesNotMatch(needs, /BOOKREEL_PUBLISH_BROWSER_CHANNEL/);

    // An unreachable Chrome is REQUIRES_CONNECTION with the attach steps -- it is not quietly launched via the channel.
    const down = await publishYouTubeViaChrome({}, { madeForKids: false }, root, { env: CHANNEL_CHROME, chrome: "down" });
    assert.equal(down.outcome.status, "REQUIRES_CONNECTION");
    assert.match((down.outcome as { error: string }).error, /Could not attach to Chrome at http:\/\/127\.0\.0\.1:9222/);
    assert.equal(down.chrome.launches.length, 0, "no launch via the channel");

    // Neither set: the bundled Chromium, exactly as before.
    const neither = fakeBrowser(new FakePage(), { profileRoot: root });
    await (await openSession("youtube", neither.deps)).finish({ leaveOpen: false });
    assert.equal("channel" in neither.launches[0].options, false);
    assert.match(chromiumProblem({ env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, locate: () => null, locateChannel: () => "C:/chrome.exe" }) ?? "", /No Chromium was found/, "a channel-capable machine is not channel mode");
    const plainView = await browserModeFor("youtube", { env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" }, browser: { deps: { locate: () => "C:/chrome.exe" } } });
    assert.deepEqual(plainView, { available: true, reason: null, canSchedule: true, headless: false });
    assert.match(publisherFor("youtube", { mode: "browser", env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1" } }).capabilities().requires.join(" | "), /A Chromium on this server/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("channel: the view and the provider's needs say it is the installed Chrome on a BookReel profile", async () => {
  const present = { env: CHANNEL_CHROME, browser: { deps: { locateChannel: () => "C:/chrome.exe", locate: () => null } } };
  assert.deepEqual(await browserModeFor("youtube", present), { available: true, reason: null, canSchedule: true, headless: false, channel: "chrome" });
  assert.deepEqual(await browserModeFor("instagram", present), { available: true, reason: null, canSchedule: false, headless: false, channel: "chrome" });
  const hidden = await browserModeFor("youtube", { ...present, env: { ...CHANNEL_CHROME, BOOKREEL_PUBLISH_HEADLESS: "1" } });
  assert.equal(hidden?.headless, true, "the hidden-window warning still applies to a launched Chrome");

  const missing = await browserModeFor("youtube", { env: CHANNEL_CHROME, browser: { deps: { locateChannel: () => null } } });
  assert.equal(missing?.available, false);
  assert.match(missing?.reason ?? "", NOT_INSTALLED);
  assert.equal(missing?.channel, "chrome");

  for (const platform of ["youtube", "instagram"] as const) {
    const needs = publisherFor(platform, { mode: "browser", env: CHANNEL_CHROME }).capabilities().requires.join(" | ");
    assert.match(needs, /Google Chrome installed on this computer \(BOOKREEL_PUBLISH_BROWSER_CHANNEL\)/);
    assert.match(needs, /dedicated BookReel profile, never your personal one/);
    assert.match(needs, /never types or stores your password or copies cookies/);
    assert.doesNotMatch(needs, /A Chromium on this server|BOOKREEL_PUBLISH_CHROME_CDP/);
  }
});

test("channel: the YouTube channel gate still stops an upload -- a wrong channel is refused, an unreadable one only passes for a private upload", async () => {
  const root = await tempRoot();
  try {
    const wrong = await publishYouTubeViaChannel({ handle: "@someone-else" }, { madeForKids: false }, root);
    assert.equal(wrong.outcome.status, "AWAITING_HUMAN");
    assert.match((wrong.outcome as { error: string }).error, /Wrong YouTube channel/);
    assert.match((wrong.outcome as { error: string }).error, /Switch account → select between_pages/);
    assert.match((wrong.outcome as { error: string }).error, /@betweenpages08-l4d/);
    assert.equal(wrong.launches[0].options.channel, "chrome", "it was the installed Chrome that was opened");
    assert.ok(!wrong.page.actions.some((a) => a.startsWith("files:")), "nothing was uploaded to the wrong channel");
    assert.equal(wrong.s.pressed, 0, "and the final button was never pressed");
    assert.equal(wrong.context.closed, false, "the window is left open for the person to switch channel");
    assert.equal(hasLeftOpenWindow("youtube"), true);
    await closeLeftOpenWindow("youtube");

    for (const visibility of ["public", "unlisted"] as const) {
      const unreadable = await publishYouTubeViaChannel({ handle: null }, { madeForKids: false, visibility, confirmPublic: true }, root);
      assert.equal(unreadable.outcome.status, "AWAITING_HUMAN", visibility);
      assert.match((unreadable.outcome as { error: string }).error, /did not say which channel/);
      assert.ok(!unreadable.page.actions.some((a) => a.startsWith("files:")), `${visibility}: nothing was uploaded`);
      assert.equal(unreadable.s.pressed, 0);
      await closeLeftOpenWindow("youtube");
    }
    const when = new Date(Date.now() + 2 * 86_400_000);
    const scheduled = await publishYouTubeViaChannel({ handle: null }, { madeForKids: false, scheduledAt: when, confirmPublic: true }, root);
    assert.equal(scheduled.outcome.status, "AWAITING_HUMAN", "a schedule is public-at-a-time, so it is held to the same rule");
    assert.equal(scheduled.s.pressed, 0);
    await closeLeftOpenWindow("youtube");

    // Sign-in and security checks are still the person's, in this mode too: the page is only looked at.
    const signedOut = await publishYouTubeViaChannel({ signedOut: true }, { madeForKids: false }, root);
    assert.equal(signedOut.outcome.status, "AWAITING_HUMAN");
    assert.match((signedOut.outcome as { error: string }).error, /never types or stores your password/);
    assert.deepEqual(signedOut.page.touched(), [], "no click, fill, key or file: the sign-in page was only looked at");
    await closeLeftOpenWindow("youtube");
    const check = await publishYouTubeViaChannel({ challengeUrl: true }, { madeForKids: false }, root);
    assert.equal(check.outcome.status, "AWAITING_HUMAN");
    assert.match((check.outcome as { error: string }).error, /does not try to solve or get past it/);
    assert.deepEqual(check.page.touched(), []);
    await closeLeftOpenWindow("youtube");

    // Only the expected channel gets through, and a finished job closes its own window.
    const right = await publishYouTubeViaChannel({}, { madeForKids: false, visibility: "unlisted" }, root);
    assert.equal(right.outcome.status, "PUBLISHED", "the expected channel passes");
    assert.equal(right.context.closed, true);
  } finally {
    await closeLeftOpenWindow("youtube");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the card, when the server opens your installed Chrome, says so; it keeps the password and sign-in promises and the honest limit", () => {
  const channel = "chrome" as const;
  const up = renderCard("youtube", { browser: { available: true, reason: null, canSchedule: true, headless: false, channel } });
  assert.match(up, /Opens your installed Google Chrome/);
  assert.match(up, /dedicated BookReel profile/);
  assert.match(up, /not your personal Google Chrome profile/);
  assert.match(up, /Sign in yourself the first time/);
  assert.match(up, /never types or stores your password/);
  assert.match(up, /never copies cookies/);
  assert.match(up, /never reuses your personal profile/);
  assert.match(up, /never tries to get past a check/);
  assert.match(up, /@betweenpages08-l4d/);
  assert.match(up, /BookReel stops if it is a different one/, "the channel gate is explained");
  assert.match(up, /may refuse a sign-in typed into it/, "the limit is stated, not hidden");
  assert.match(up, /BOOKREEL_PUBLISH_CHROME_CDP/, "and the honest alternative is named");
  assert.match(up, /recommended route/, "the API is still the recommended route");
  assert.match(up, /Publish via browser window/);
  assert.doesNotMatch(up, /Opens a real browser window/, "not the bundled-Chromium copy");
  assert.doesNotMatch(up, /Attaches to your own Chrome|remote-debugging-port/, "not the attach copy");

  const ig = renderCard("instagram", { browser: { available: true, reason: null, canSchedule: false, headless: false, channel } });
  assert.match(ig, /Opens your installed Google Chrome/);
  assert.doesNotMatch(ig, /@betweenpages08-l4d/, "the YouTube channel line is YouTube's");

  const edge = renderCard("youtube", { browser: { available: true, reason: null, canSchedule: true, headless: false, channel: "msedge" } });
  assert.match(edge, /Opens your installed Microsoft Edge/);

  const missing = renderCard("youtube", {
    browser: { available: false, reason: "Google Chrome is not installed, or Playwright could not find it; install Chrome or unset BOOKREEL_PUBLISH_BROWSER_CHANNEL. Nothing was opened.", canSchedule: true, headless: false, channel },
  });
  assert.match(missing, /Google Chrome is not installed, or Playwright could not find it/, "the reason is shown");
  assert.doesNotMatch(missing, /Publish via browser window/, "and there is nothing to press");

  // Attaching outranks a channel, so a view carrying both reads as attaching.
  const both = renderCard("youtube", { browser: { available: true, reason: null, canSchedule: true, headless: false, channel, attach: { endpoint: CDP } } });
  assert.match(both, /Attaches to your own Chrome/);
  assert.doesNotMatch(both, /Opens your installed/);

  // Neither: the existing bundled-Chromium copy, untouched.
  const plain = renderCard("youtube", {});
  assert.match(plain, /real browser window/);
  assert.doesNotMatch(plain, /Opens your installed|may refuse a sign-in typed into it|Sign in to YouTube/);
});

// ======================================================================= SIGN IN ONCE, THEN REUSE
//
// Google refuses a sign-in in a browser an automation tool started, so the sign-in
// is done ONCE in a PLAIN Chrome (an ordinary process, with only the dedicated
// profile on its command line) and the automated publish later opens Chrome on that
// same, already-signed-in profile. Everything below runs against fakes: a
// `fakeSpawner` that starts nothing, `fakeBrowser`, scripted pages. No Chrome is
// started, nothing is signed in, nothing touches Google.

const INSTALLED_CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const INSTALLED_EDGE = "C:/Program Files/Microsoft/Edge/Application/msedge.exe";

/** What would make a Chrome a different kind of browser from an ordinary one. None may be a switch on the sign-in command line. */
const NOT_PLAIN = [
  "enable-automation",
  "remote-debugging",
  "disable-blink-features",
  "AutomationControlled",
  "user-agent",
  "headless",
  "no-sandbox",
  "disable-",
  "enable-",
  "proxy",
  "load-extension",
  "http",
];

/** The switch names on a command line (what is before any `=`), which is what "plain" is a statement about. */
const switchNames = (argv: readonly string[]): string[] => argv.map((a) => a.split("=")[0]);

function signInDeps(root: string, over: Parameters<typeof openSignInWindow>[1] = {}) {
  const fake = fakeSpawner();
  return {
    fake,
    deps: { env: CHANNEL_CHROME, profileRoot: root, locateChannel: () => INSTALLED_CHROME, spawner: fake.spawner, ...over },
  };
}

test("sign-in: opens a PLAIN Chrome on the dedicated profile -- the whole command line is --user-data-dir, and nothing else", async () => {
  const root = await tempRoot();
  try {
    const { fake, deps } = signInDeps(root);
    const result = await openSignInWindow("youtube", deps);
    assert.equal(result.ok, true);

    const profile = profileDirFor("youtube", root);
    assert.deepEqual(fake.spawns, [{ executable: INSTALLED_CHROME, argv: [`--user-data-dir=${profile}`] }]);
    const { argv } = fake.spawns[0];
    assert.equal(argv.length, 1, "exactly one argument");
    assert.deepEqual(argv, signInArgv(profile));
    assert.deepEqual(switchNames(argv), ["--user-data-dir"]);
    for (const word of NOT_PLAIN) assert.ok(!switchNames(argv).join(" ").includes(word), `the sign-in window must not be started with ${word}`);

    // The dedicated BookReel profile: under the work root, empty (nothing copied in), and not a personal Chrome directory.
    assert.ok(profile.startsWith(path.join(root, "browser-profiles")));
    assert.deepEqual(await fs.readdir(profile), []);
    assert.doesNotMatch(profile, /Google[\\/]Chrome[\\/]User Data/i);
    assert.ok(profileDirFor("youtube").startsWith(WORK_ROOT), "by default it is this app's own work root");

    // The sentence for the person: where to go, who to sign in as, and the promise.
    assert.match(result.message, /normal Google Chrome window/);
    assert.match(result.message, /studio\.youtube\.com/);
    assert.match(result.message, /@betweenpages08-l4d/);
    assert.match(result.message, /not your personal one/);
    assert.match(result.message, /never types or stores your password/);

    // The same profile the publishing window launches on -- that is what makes the session reusable.
    const publish = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    const session = await openSession("youtube", publish.deps);
    assert.equal(publish.launches[0].profileDir, profile, "one profile: signed in to once, reused by the publish");
    assert.equal(publish.launches[0].options.channel, "chrome");
    assert.equal(argv[0], `--user-data-dir=${publish.launches[0].profileDir}`);
    await session.finish({ leaveOpen: false });

    // Instagram has a profile of its own; Edge opens Edge. Neither ever shares the YouTube one.
    const ig = signInDeps(root);
    await openSignInWindow("instagram", ig.deps);
    assert.deepEqual(ig.fake.spawns[0].argv, [`--user-data-dir=${profileDirFor("instagram", root)}`]);
    assert.notEqual(ig.fake.spawns[0].argv[0], argv[0]);
    const edge = signInDeps(root, { env: { [CHANNEL_ENV]: "msedge" }, locateChannel: () => INSTALLED_EDGE });
    const edgeResult = await openSignInWindow("youtube", edge.deps);
    assert.equal(edge.fake.spawns[0].executable, INSTALLED_EDGE);
    assert.deepEqual(edge.fake.spawns[0].argv, [`--user-data-dir=${profile}`]);
    assert.match(edgeResult.message, /normal Microsoft Edge window/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sign-in: Chrome not found, the wrong mode, a busy profile or a failed start are each a sentence -- nothing opened, nothing thrown", async () => {
  const root = await tempRoot();
  try {
    // Chrome is not installed: "Chrome not found", no spawn, and not even the profile directory is made.
    const absent = signInDeps(root, { locateChannel: () => null });
    const notFound = await openSignInWindow("youtube", absent.deps);
    assert.ok(!notFound.ok && notFound.code === "chrome_not_found");
    assert.match(notFound.message, /^Chrome not found: /);
    assert.match(notFound.message, /no sign-in window was opened/);
    assert.deepEqual(absent.fake.spawns, []);
    await assert.rejects(fs.stat(profileDirFor("youtube", root)), "nothing was created either");
    const noEdge = signInDeps(root, { env: { [CHANNEL_ENV]: "msedge" }, locateChannel: () => null });
    assert.match((await openSignInWindow("youtube", noEdge.deps)).message, /^Chrome not found: Microsoft Edge is not installed/);

    // Not in channel mode: the saved session would belong to a different browser, so it says to set the channel.
    for (const env of [{}, { [CHANNEL_ENV]: "firefox" }, { [CHANNEL_ENV]: "" }]) {
      const plain = signInDeps(root, { env, locateChannel: () => INSTALLED_CHROME });
      const r = await openSignInWindow("youtube", plain.deps);
      assert.ok(!r.ok && r.code === "no_channel", JSON.stringify(env));
      assert.match(r.message, /BOOKREEL_PUBLISH_BROWSER_CHANNEL=chrome and restart/);
      assert.deepEqual(plain.fake.spawns, []);
    }

    // Attaching to the operator's own Chrome outranks a channel: they sign in to their own Chrome; nothing is opened.
    const attach = signInDeps(root, {
      env: { ...CHANNEL_CHROME, [CDP_ENV]: CDP },
      locateChannel: () => {
        throw new Error("the installed Chrome must not even be looked for when attaching");
      },
    });
    const attached = await openSignInWindow("youtube", attach.deps);
    assert.ok(!attached.ok && attached.code === "attach_mode");
    assert.match(attached.message, /your own Chrome/);
    assert.deepEqual(attach.fake.spawns, []);

    // A publish holds the profile: a second Chrome on it would open INSIDE that automated window, so it is refused.
    const release = await acquirePlatformLock("youtube");
    try {
      const busy = signInDeps(root);
      const r = await openSignInWindow("youtube", busy.deps);
      assert.ok(!r.ok && r.code === "busy");
      assert.match(r.message, /YouTube publish is running/);
      assert.deepEqual(busy.fake.spawns, []);
      // Another platform's profile is a different directory, so it is not held.
      assert.equal((await openSignInWindow("instagram", signInDeps(root).deps)).ok, true);
    } finally {
      release();
    }
    assert.equal((await openSignInWindow("youtube", signInDeps(root).deps)).ok, true, "free again once the publish let go");

    // The operating system refuses to start it: a message, not a throw -- whether an Error or anything else is thrown.
    for (const failure of [new Error("spawn EACCES\nstack..."), "boom"]) {
      const refusing = signInDeps(root, { spawner: fakeSpawner({ fail: failure }).spawner });
      const r = await openSignInWindow("youtube", refusing.deps);
      assert.ok(!r.ok && r.code === "spawn_failed", String(failure));
      assert.match(r.message, /^Google Chrome would not open \((spawn EACCES|boom)\)\. Nothing was signed in\.$/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sign-in: a window an earlier publish left open is closed BEFORE the plain Chrome starts, so it is never handed to an automated one", async () => {
  const root = await tempRoot();
  try {
    // A publish stopped for a person and left its (BookReel-owned) Chrome open on this profile.
    const left = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    const session = await openSession("youtube", left.deps);
    assert.equal(await session.finish({ leaveOpen: true }), true);
    assert.equal(hasLeftOpenWindow("youtube"), true);

    let closedWhenSpawned: boolean | null = null;
    const fake = fakeSpawner({ onSpawn: () => (closedWhenSpawned = left.context.closed) });
    const result = await openSignInWindow("youtube", {
      env: CHANNEL_CHROME,
      profileRoot: root,
      locateChannel: () => INSTALLED_CHROME,
      spawner: fake.spawner,
    });
    assert.equal(result.ok, true);
    assert.equal(closedWhenSpawned, true, "the automated window had already been closed when the plain Chrome was started");
    assert.equal(hasLeftOpenWindow("youtube"), false);
    assert.equal(fake.spawns.length, 1);
  } finally {
    await closeLeftOpenWindow("youtube");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sign-in: the real spawner starts a program detached and reports one that cannot start as a rejection, never a crash", async () => {
  const root = await tempRoot();
  try {
    // A harmless program (this very Node, doing nothing): started and let go of. No browser is involved.
    await startDetached(process.execPath, ["-e", "0"]);
    // A program that is not there: the asynchronous 'error' event must become a rejection (unhandled, it would end the process).
    await assert.rejects(startDetached(path.join(root, "no-such-chrome.exe"), []), /ENOENT|spawn/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sign-in: the route is POST-only, signed-in users only, takes nothing but the platform name, and answers in sentences", async () => {
  const file = fileURLToPath(new URL("../src/app/api/publish/browser/signin/route.ts", import.meta.url));
  const code = withoutComments(await fs.readFile(file, "utf8"));
  assert.match(code, /export const runtime = "nodejs";/, "it starts a process on the server, so never the edge");
  assert.match(code, /export const dynamic = "force-dynamic";/);
  assert.match(code, /export async function POST\(req: Request\)/);
  assert.doesNotMatch(code, /export (async )?function (GET|PUT|PATCH|DELETE)/);
  // Authenticated before the body is even read.
  assert.ok(code.indexOf("await requireUser()") > -1 && code.indexOf("await requireUser()") < code.indexOf("req.json()"));
  assert.doesNotMatch(code, /currentUser/);
  // The caller can name a platform and nothing else: no path, program or argument can come from the request.
  assert.deepEqual([...new Set([...code.matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]))], ["platform"]);
  assert.match(code, /isPlatformId\(body\.platform\)/);
  assert.match(code, /openSignInWindow\(body\.platform\)/);
  assert.doesNotMatch(code, /spawn|child_process|exec\(/, "the route itself starts nothing: signin.ts does");
  assert.match(code, /if \(!result\.ok\) throw new AppError\(result\.code, result\.message, 409\);/);
  assert.match(code, /NextResponse\.json\(\{ ok: true, message: result\.message \}\)/);
});

test("reuse: a signed-in profile goes straight to Studio -- Google's sign-in page is never visited and no credential field is touched", async () => {
  const root = await tempRoot();
  try {
    const r = await publishYouTubeViaChannel({}, { madeForKids: false }, root);
    assert.equal(r.outcome.status, "PUBLISHED");
    const gotos = r.page.actions.filter((a) => a.startsWith("goto:"));
    assert.equal(gotos[0], `goto:${YT.studio}`, "the very first thing it does is open Studio");
    assert.ok(!gotos.some((g) => /accounts\.google\.com|signin|ServiceLogin/i.test(g)), "no visit to a sign-in page");
    assert.ok(!r.page.actions.some((a) => /password|identifier|email|passwd/i.test(a)), "no credential field was addressed");
    // The installed Chrome, on the SAME profile the sign-in window uses.
    assert.equal(r.launches[0].options.channel, "chrome");
    assert.equal(r.launches[0].profileDir, profileDirFor("youtube", root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reuse: if the saved session is gone, the stop points at the Sign in button -- in channel mode only; the other modes keep their own words", async () => {
  const root = await tempRoot();
  try {
    const out = await publishYouTubeViaChannel({ signedOut: true }, { madeForKids: false }, root);
    assert.equal(out.outcome.status, "AWAITING_HUMAN");
    const text = (out.outcome as { error: string }).error;
    assert.match(text, /Sign in to YouTube/, "it names the button");
    assert.match(text, /normal Google Chrome window/);
    assert.match(text, /close that window, then press Retry/);
    assert.match(text, /never types or stores your password/);
    assert.match(text, /Google refuses a sign-in in a window that an automation tool opened/);
    assert.doesNotMatch(text, /Do that in the open browser window/, "not told to sign in inside the automated window");
    assert.deepEqual(out.page.touched(), [], "the sign-in page was only looked at: nothing clicked, typed or attached");
    assert.equal(hasLeftOpenWindow("youtube"), true);
    await closeLeftOpenWindow("youtube");

    // A hidden publishing window does not change that: the sign-in never happens in it.
    const hidden = await publishYouTubeViaChannel({ signedOut: true }, { madeForKids: false }, root, {
      ...CHANNEL_CHROME,
      BOOKREEL_PUBLISH_HEADLESS: "1",
    });
    assert.match((hidden.outcome as { error: string }).error, /Sign in to YouTube/);
    assert.doesNotMatch((hidden.outcome as { error: string }).error, /running hidden/);

    // Edge names itself.
    const edge = await publishYouTubeViaChannel({ signedOut: true }, { madeForKids: false }, root, { [CHANNEL_ENV]: "msedge" });
    assert.match((edge.outcome as { error: string }).error, /normal Microsoft Edge window/);
    await closeLeftOpenWindow("youtube");

    // The bundled Chromium and an attached Chrome: the existing sentence, unchanged.
    const keeps = /sign in yourself\. Do that in the open browser window, then press Retry\./;
    const bundled = await publishYouTube({ signedOut: true }, { madeForKids: false }, root);
    assert.match((bundled.outcome as { error: string }).error, keeps);
    assert.doesNotMatch((bundled.outcome as { error: string }).error, /Sign in to YouTube/);
    await closeLeftOpenWindow("youtube");
    const attached = await publishYouTubeViaChrome({ signedOut: true }, { madeForKids: false }, root);
    assert.match((attached.outcome as { error: string }).error, keeps);
    assert.doesNotMatch((attached.outcome as { error: string }).error, /Sign in to YouTube/);

    // Instagram has no such block and no such button: its words are unchanged in channel mode too.
    const ig = instagramSite({ signedOut: true });
    const igFake = fakeBrowser(ig.page, { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    const igOut = await browserInstagramPublisher({ env: CHANNEL_CHROME, options: { confirmPublic: true }, deps: igFake.deps }).publish(
      prepared("instagram"),
    );
    assert.match((igOut as { error: string }).error, /Do that in the open browser window/);
    assert.doesNotMatch((igOut as { error: string }).error, /Sign in to/);
  } finally {
    await closeLeftOpenWindow("youtube");
    await closeLeftOpenWindow("instagram");
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- the profile is open elsewhere

const PLAYWRIGHT_BUSY = [
  "browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n\n<launched> pid=4242\nOpening in existing browser session.\n<process did exit: exitCode=0, signal=null>",
  "browserType.launchPersistentContext: Target page, context or browser has been closed",
  "Failed to create a ProcessSingleton for your profile directory",
  "SingletonLock: File exists",
  "The user data directory is already in use. The profile appears to be in use by another process",
];

test("profile busy: isProfileInUse recognises a profile held by another Chrome, and nothing that is an install problem", () => {
  for (const message of PLAYWRIGHT_BUSY) assert.equal(isProfileInUse(new Error(message)), true, message.split("\n")[0]);
  assert.equal(isProfileInUse("Opening in existing browser session."), true, "a thrown string is read too");
  for (const other of [
    "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "spawn EACCES",
    "boom",
    "net::ERR_INTERNET_DISCONNECTED",
    "Timeout 60000ms exceeded.",
  ]) {
    assert.equal(isProfileInUse(new Error(other)), false, other);
  }
  const message = profileBusyMessage("youtube", "chrome");
  assert.match(message, /^Close the YouTube sign-in window, then publish\./);
  assert.match(profileBusyMessage("youtube", "msedge"), /Microsoft Edge could not open the BookReel profile/);
  assert.match(message, /Nothing was opened and nothing was posted\.$/);
});

test("profile preflight: another owner stops before launch, then retries normally once released", async () => {
  const root = await tempRoot();
  try {
    const fake = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME });
    let held = true;
    const deps = { ...fake.deps, profileWindow: { waitForWindow: async (profile: string) => {
      assert.equal(profile, profileDirFor('youtube', root));
      return held ? { state: 'none' as const, holders: [123] } : { state: 'none' as const, holders: [] };
    } } };
    const blocked = await runInSession('youtube', deps, async () => { throw new Error('must not run'); });
    assert.equal(blocked.status, 'FAILED');
    assert.equal(fake.launches.length, 0, 'no launch can forward about:blank to the existing browser');
    assert.equal(isPlatformBusy('youtube'), false);
    held = false;
    const session = await openSession('youtube', deps);
    assert.equal(fake.launches.length, 1);
    await session.finish({ leaveOpen: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("profile busy: a launch that finds the profile in use says to close the sign-in window -- FAILED, one attempt, no lock file touched, no fall back", async () => {
  const root = await tempRoot();
  try {
    const profile = profileDirFor("youtube", root);
    await fs.mkdir(profile, { recursive: true });
    const locks = ["SingletonLock", "lockfile"].map((n) => path.join(profile, n));
    for (const lock of locks) await fs.writeFile(lock, "held");

    for (const message of PLAYWRIGHT_BUSY) {
      const workDone: string[] = [];
      const fake = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, launchError: new Error(message) });
      let attaches = 0;
      const deps = {
        ...fake.deps,
        connect: async () => {
          attaches++;
          throw new Error("must not attach");
        },
      };
      const outcome = await runInSession("youtube", deps, async () => {
        workDone.push("ran");
        return { status: "FAILED", error: "must not run" };
      });
      assert.equal(outcome.status, "FAILED", message.split("\n")[0]);
      const text = (outcome as { error: string }).error;
      assert.match(text, /^Close the YouTube sign-in window, then publish\./);
      assert.doesNotMatch(text, /not installed|did not start|Chromium would not start/, "not mistaken for an install problem");
      assert.deepEqual(workDone, [], "no page work was attempted");
      assert.equal(fake.launches.length, 1, "one attempt, with the channel -- no second try, no bundled Chromium");
      assert.equal(fake.launches[0].options.channel, "chrome");
      assert.equal(attaches, 0);
      assert.equal(hasLeftOpenWindow("youtube"), false);
      assert.equal(isPlatformBusy("youtube"), false, "the lock was released");
    }

    // The same through the publisher the job runner calls.
    const viaPublisher = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, launchError: new Error(PLAYWRIGHT_BUSY[0]) });
    const published = await browserYouTubePublisher({
      env: CHANNEL_CHROME,
      options: { madeForKids: false },
      deps: viaPublisher.deps,
    }).publish(prepared("youtube"));
    assert.equal(published.status, "FAILED");
    assert.match((published as { error: string }).error, /^Close the YouTube sign-in window, then publish\./);

    // BookReel only reports it: it did not remove the profile's lock files, and has no code that could.
    for (const lock of locks) assert.equal((await fs.stat(lock)).isFile(), true, `${path.basename(lock)} is still there`);
    for (const name of await fs.readdir(BROWSER_DIR)) {
      if (!name.endsWith(".ts")) continue;
      assert.doesNotMatch(
        withoutComments(await fs.readFile(path.join(BROWSER_DIR, name), "utf8")),
        /\bunlink(Sync)?\b|\brmSync\b|\.rm\s*\(|\brmdir(Sync)?\b|\bremoveSync\b/,
        `${name}: nothing in the browser folder deletes files`,
      );
    }

    // The default (bundled) mode is untouched by this: the same launch error keeps its old words there.
    const bundled = fakeBrowser(new FakePage(), { profileRoot: root, launchError: new Error(PLAYWRIGHT_BUSY[0]) });
    const old = await runInSession("youtube", bundled.deps, async () => ({ status: "FAILED", error: "must not run" }));
    assert.equal(old.status, "FAILED");
    assert.match((old as { error: string }).error, /^Chromium would not start: /);
    assert.doesNotMatch((old as { error: string }).error, /sign-in window/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("profile busy: the job row says FAILED with the message the card shows, and closing the sign-in window then publishing works", async () => {
  const s = await seed(1);
  seeds.push(s);
  const [ep] = s.episodes;
  const root = await tempRoot();
  try {
    const busy = fakeBrowser(new FakePage(), {
      profileRoot: root,
      env: CHANNEL_CHROME,
      chromium: false,
      launchError: new Error(PLAYWRIGHT_BUSY[0]),
    });
    await startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, env: busy.deps.env, deps: busy.deps });
    const failed = await row(ep, "youtube");
    assert.equal(failed?.status, "FAILED");
    assert.match(failed?.lastError ?? "", /^Close the YouTube sign-in window, then publish\./);
    assert.equal(failed?.externalId, null);
    assert.equal(failed?.publishedAt, null);

    // The Publish Center shows a FAILED job's message and leaves the button there, so this is visible and retryable.
    const view = await publishView(s.ownerId, ep, { env: busy.deps.env, browser: { deps: busy.deps } });
    const yt = view.platforms.find((p) => p.platform === "youtube");
    assert.equal(yt?.status, "FAILED");
    assert.match(yt?.job?.lastError ?? "", /Close the YouTube sign-in window, then publish\./);
    assert.equal(yt?.browser?.available, true);

    // The sign-in window is closed; the next attempt launches, signed in, and runs the flow.
    const site = youtubeSite({});
    const open = fakeBrowser(site.page, { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    await startBrowserPublish(s.ownerId, ep, "youtube", { ...OK_YT, env: open.deps.env, deps: open.deps });
    const after = await row(ep, "youtube");
    assert.equal(after?.attempts, 2, "a plain retry: the FAILED row was claimed again");
    assert.equal(open.launches.length, 1);
    assert.equal(after?.status, "PUBLISHED");
  } finally {
    await closeLeftOpenWindow("youtube");
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- no evasion, on every path

test("GUARD: no evasion on ANY path -- bundled, installed Chrome, the sign-in window and CDP attach hide nothing and add no flag", async () => {
  const root = await tempRoot();
  try {
    // 1. Bundled Chromium: Playwright's defaults, three options.
    const bundled = fakeBrowser(new FakePage(), { profileRoot: root });
    await (await openSession("youtube", bundled.deps)).finish({ leaveOpen: false });
    assert.deepEqual(Object.keys(bundled.launches[0].options).sort(), ["chromiumSandbox", "headless", "timeout", "viewport"]);

    // 2. The installed Chrome, launched: the same three plus `channel`, which only names WHICH browser.
    const chrome = fakeBrowser(new FakePage(), { profileRoot: root, env: CHANNEL_CHROME, chromium: false });
    await (await openSession("youtube", chrome.deps)).finish({ leaveOpen: false });
    assert.deepEqual(Object.keys(chrome.launches[0].options).sort(), ["channel", "chromiumSandbox", "headless", "timeout", "viewport"]);

    // 3. The sign-in window: an ordinary process whose whole command line is the profile.
    const { fake, deps } = signInDeps(root);
    await openSignInWindow("youtube", deps);
    assert.deepEqual(fake.spawns[0].argv, [`--user-data-dir=${profileDirFor("youtube", root)}`]);
    assert.deepEqual(switchNames(fake.spawns[0].argv), ["--user-data-dir"]);
    for (const word of NOT_PLAIN) assert.ok(!switchNames(fake.spawns[0].argv).join(" ").includes(word), `sign-in argv has no ${word}`);

    // 4. Attaching: the endpoint and nothing else; nothing launched, nothing spawned.
    const cdp = fakeChrome(new FakePage(), { profileRoot: root });
    await (await openSession("youtube", cdp.deps)).finish({ leaveOpen: false });
    assert.deepEqual(cdp.connects, [{ endpoint: CDP, argCount: 1 }]);
    assert.equal(cdp.launches.length, 0);

    for (const options of [bundled.launches[0].options, chrome.launches[0].options]) {
      const wire = JSON.stringify(options);
      for (const word of ["AutomationControlled", "disable-blink-features", "enable-automation", "userAgent", "ignoreDefaultArgs", "args", "stealth", "executablePath"]) {
        assert.ok(!wire.includes(word), `launch options must not contain ${word}`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  // Source, comments aside, across the whole folder: the sign-in module is the ONLY one that starts a process...
  const names = (await fs.readdir(BROWSER_DIR)).filter((n) => n.endsWith(".ts"));
  const starters: string[] = [];
  for (const name of names) {
    const code = withoutComments(await fs.readFile(path.join(BROWSER_DIR, name), "utf8"));
    if (/child_process|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(code)) starters.push(name);
  }
  // The one other process this folder starts is NOT a browser: the read-only window probe (window-probe.ts) asks Windows
  // whether the sign-in window is on the person's screen. Allowed by name, and held to the same bar as the sign-in module:
  // PowerShell and nothing else, one call, no shell, none of the evasion patterns below. (Its script is pinned to
  // look-only in tests/signin-window.test.mts.)
  assert.deepEqual(starters, ["signin.ts", "window-probe.ts"]);
  const probeSource = withoutComments(await fs.readFile(path.join(BROWSER_DIR, "window-probe.ts"), "utf8"));
  assert.equal([...probeSource.matchAll(/(?<![.\w])execFile\s*\(/g)].length, 1, "exactly one process start in the probe");
  assert.match(probeSource, /execFile\(\s*"powershell\.exe"/, "the only program the probe starts is PowerShell -- never a browser");
  assert.doesNotMatch(probeSource, /(?<![.\w])(spawn|spawnSync|exec|execSync|execFileSync|fork)\s*\(/, "no other way to start anything");
  assert.doesNotMatch(probeSource, /\bshell\s*:/, "no shell: nothing in the arguments is interpreted");
  assert.doesNotMatch(probeSource, /chromium\.|playwright/i, "and it is not Playwright");
  for (const pattern of [/enable-automation/i, /remote-debugging/i, /disable-blink-features|AutomationControlled/i, /user-agent|userAgent/i, /addInitScript|webdriver|stealth/i, /storageState|cookie|password/i]) {
    assert.doesNotMatch(probeSource, pattern, `window-probe.ts contains ${pattern}`);
  }

  // ...the sign-in window itself starts one way: no shell, detached, no stdio, let go of...
  const signin = withoutComments(await fs.readFile(path.join(BROWSER_DIR, "signin.ts"), "utf8"));
  assert.equal([...signin.matchAll(/(?<![.\w])spawn\s*\(/g)].length, 1, "exactly one spawn call");
  assert.match(signin, /spawn\(executable,\s*\[\.\.\.argv\],\s*\{\s*detached: true,\s*stdio: "ignore"\s*\}\)/);
  assert.match(signin, /child\.unref\(\)/);
  assert.doesNotMatch(signin, /\bshell\s*:/, "no shell: nothing in the path or arguments is interpreted");
  assert.doesNotMatch(signin, /\benv\s*:/, "and it is handed no special environment");
  assert.doesNotMatch(signin, /chromium\.|playwright/i, "and it is not Playwright");

  // ...and the only command-line switch anywhere in it is --user-data-dir.
  assert.deepEqual([...new Set(signin.match(/--[a-z][\w-]*/g) ?? [])], ["--user-data-dir"]);
  assert.match(signin, /return \[`--user-data-dir=\$\{profileDir\}`\];/);
  const signinWithoutPromise = signin.replace('"BookReel never types or stores your password."', '""');
  for (const [pattern, what] of [
    [/enable-automation/i, "the automation switch"],
    [/remote-debugging/i, "a debugging port"],
    [/disable-blink-features|AutomationControlled/i, "hiding automation"],
    [/user-agent|userAgent/i, "a spoofed user agent"],
    [/addInitScript|webdriver|stealth/i, "an injected script or patch"],
    [/storageState|cookie|password/i, "reading or typing a credential"],
  ] as Array<[RegExp, string]>) {
    assert.doesNotMatch(signinWithoutPromise, pattern, `signin.ts contains ${what}`);
  }
});

test("the card, in channel mode on YouTube, offers 'Sign in to YouTube' and says what it opens and what it never does; nowhere else", () => {
  const channel = "chrome" as const;
  const view = { available: true, reason: null, canSchedule: true, headless: false, channel };
  const up = renderCard("youtube", { browser: view });
  assert.match(up, /<span class="truncate">Sign in to YouTube<\/span>/, "the button");
  assert.match(up, /normal Google Chrome on a dedicated BookReel profile \(not your personal Google Chrome\)/);
  assert.match(up, /sign in with the Google account that manages your channel and pick the channel @betweenpages08-l4d/);
  assert.match(up, /close that window and publish/);
  assert.match(up, /never types or stores your password and never copies cookies/);
  assert.match(up, /Close the sign-in window before you publish/);
  assert.match(up, /Publish via browser window/, "the publish flow is still there");
  assert.match(up, /Is this video made for kids\?/, "and so is the declaration it asks for");
  assert.match(up, /Private \(review in Studio\)/);

  // The AWAITING_HUMAN stop is shown as before, with the sign-in sentence the server wrote and the Retry behind its box.
  const stopped = renderCard("youtube", {
    status: "AWAITING_HUMAN",
    browser: view,
    job: jobView({ lastError: 'YouTube wants you to sign in. Press "Sign in to YouTube" in the Publish panel. Nothing was published.' }),
  });
  assert.match(stopped, /Press &quot;Sign in to YouTube&quot; in the Publish panel/);
  assert.match(stopped, /I looked at the platform/);
  assert.match(stopped, /<span class="truncate">Sign in to YouTube<\/span>/, "the button is next to the stop");

  const edge = renderCard("youtube", { browser: { ...view, channel: "msedge" } });
  assert.match(edge, /normal Microsoft Edge on a dedicated BookReel profile/);

  // Not offered: Instagram, the bundled Chromium, an attached Chrome, an unavailable route, a settled post, someone else's episode.
  const notOffered: Array<[string, string]> = [
    ["instagram, channel mode", renderCard("instagram", { browser: { ...view, canSchedule: false } })],
    ["the bundled Chromium", renderCard("youtube", {})],
    ["an attached Chrome", renderCard("youtube", { browser: { ...view, attach: { endpoint: CDP } } })],
    ["Chrome not installed", renderCard("youtube", { browser: { ...view, available: false, reason: "Google Chrome is not installed." } })],
    [
      "a scheduled post",
      renderCard("youtube", {
        status: "SCHEDULED",
        browser: view,
        job: jobView({ status: "SCHEDULED", externalId: "VID1", scheduledFor: new Date(2027, 0, 5, 15, 30).toISOString() }),
      }),
    ],
    ["an episode that is not yours", renderCard("youtube", { browser: view }, false)],
  ];
  for (const [why, html] of notOffered) assert.doesNotMatch(html, /Sign in to YouTube/, why);
});

test("the card's sign-in button posts the platform name and nothing else, and no password field exists anywhere in it", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../src/components/BrowserPublish.tsx", import.meta.url)), "utf8");
  assert.match(source, /fetch\("\/api\/publish\/browser\/signin",\s*\{\s*method: "POST",[\s\S]*?body: JSON\.stringify\(\{ platform: state\.platform \}\),/);
  assert.doesNotMatch(source, /type=["']password|autoComplete|<input[^>]*name=["'](password|email|username)/i);
});
