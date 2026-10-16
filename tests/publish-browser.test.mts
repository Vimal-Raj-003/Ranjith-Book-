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
  MIN_SCHEDULE_LEAD_MS,
  NeedsHuman,
  browserOptionProblems,
  desiredVisibility,
  isHeadless,
  judgePage,
  launchOptionsFor,
  locateChromium,
  openSession,
  profileDirFor,
  runInSession,
  type BrowserPublishOptions,
  type BrowserPublisher,
  type PageSnapshot,
} from "../src/lib/publish/browser/engine";
import { acquirePlatformLock, hasLeftOpenWindow, isBrowserJobLive, isPlatformBusy, markLive, unmarkLive } from "../src/lib/publish/browser/live";
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
import { FakePage, fakeBrowser } from "./helpers/fake-browser.mjs";
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

async function publishInstagram(script: IgScript, options: BrowserPublishOptions, root: string) {
  const site = instagramSite(script);
  const fake = fakeBrowser(site.page, { profileRoot: root });
  const outcome = await browserInstagramPublisher({ options, deps: fake.deps }).publish(prepared("instagram"));
  return { outcome, ...site, ...fake };
}

// ======================================================================= NO EVASION

test("GUARD: the browser is launched with Playwright's defaults and NO stealth or anti-detection option", () => {
  for (const env of [{}, { BOOKREEL_PUBLISH_HEADLESS: "1" }, { BOOKREEL_PUBLISH_HEADLESS: "true" }]) {
    const options = launchOptionsFor(env);
    // EXACTLY these three keys. Adding any other -- `args`, `userAgent`,
    // `ignoreDefaultArgs`, `channel`, a locale, a timezone -- is a decision about
    // how the browser presents itself, and fails here.
    assert.deepEqual(Object.keys(options).sort(), ["headless", "timeout", "viewport"]);
    const wire = JSON.stringify(options);
    for (const forbidden of [
      "AutomationControlled",
      "disable-blink-features",
      "enable-automation",
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

    assert.deepEqual(Object.keys(a.launches[0].options).sort(), ["headless", "timeout", "viewport"]);
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
  assert.deepEqual([...names].sort(), ["engine.ts", "instagram.ts", "live.ts", "recover.ts", "run.ts", "youtube.ts"]);
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
    [/pressSequentially|keyboard\.type|keyboard\.insertText|\.type\(/, "per-keystroke typing"],
    [/\bdelay\s*:/, "a typing delay"],
    [/jitter|humaniz|bezier/i, "human imitation"],
    [/storageState|addCookies|\.cookies\s*\(|document\.cookie/, "reading or copying a session"],
    [/reporeel/i, "code or profiles lifted from another project"],
    [/\bargs\s*:/, "extra launch arguments"],
    [/setExtraHTTPHeaders|extraHTTPHeaders/, "spoofed headers"],
    [/solveCaptcha|bypass|2captcha|anti-?captcha/i, "solving or bypassing a challenge"],
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
  assert.equal(api.capabilities().canSchedule, false, "the API provider does not offer a schedule");
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

  const view = browserModeFor("youtube", { browser: { deps: { locate: () => null } } });
  assert.equal(view?.available, false);
  assert.match(view?.reason ?? "", /No Chromium was found/);
  const ok = browserModeFor("instagram", { browser: { deps: { locate: () => "C:/chrome.exe" } } });
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
    assert.match((wrong.outcome as { error: string }).error, /Wrong YouTube channel/);
    assert.match((wrong.outcome as { error: string }).error, /@someone-else/);
    assert.ok(!wrong.page.actions.some((a) => a.startsWith("files:")), "nothing was uploaded to the wrong channel");

    const unreadablePublic = await publishYouTube({ handle: null }, { madeForKids: false, visibility: "public", confirmPublic: true }, root);
    assert.equal(unreadablePublic.outcome.status, "AWAITING_HUMAN");
    assert.match((unreadablePublic.outcome as { error: string }).error, /did not say which channel/);
    assert.ok(!unreadablePublic.page.actions.some((a) => a.startsWith("files:")));

    const unreadablePrivate = await publishYouTube({ handle: null }, { madeForKids: false }, root);
    assert.equal(unreadablePrivate.outcome.status, "PUBLISHED", "a private upload can be deleted, so it may proceed");

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
      const r = await publishYouTube(script, { madeForKids: true }, root);
      assert.equal(r.outcome.status, "AWAITING_HUMAN", why);
      assert.match((r.outcome as { error: string }).error, expectedText, why);
      assert.match((r.outcome as { error: string }).error, /Nothing was published/, why);
      assert.equal(r.s.pressed, 0, `${why}: the final button was never pressed`);
      await closeLeftOpen("youtube", root);
    }
    // "made for kids" is the operator's own answer, passed through as given.
    const yes = await publishYouTube({}, { madeForKids: true }, root);
    assert.ok(yes.page.actions.includes(`click:${YT.kidsYes}`));
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
    // The profile was looked at BEFORE sharing, so the new reel could be told apart.
    const a = r.page.actions;
    assert.ok(a.findIndex((x) => x.includes("/reels/")) < a.indexOf(`click:${IG.share}`));
    assert.equal(r.context.closed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
    assert.match((sched.outcome as { error: string }).error, /cannot schedule/);
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
        env: {},
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
  assert.equal(publisherFor("youtube").capabilities().canSchedule, false);
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

test("the Publish Center keeps the API card, the hand-off AND the browser option side by side", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../src/components/PublishCenter.tsx", import.meta.url)), "utf8");
  const code = withoutComments(source);
  assert.match(code, /<YouTubePublish\b/);
  assert.match(code, /<InstagramPublish\b/);
  assert.match(code, /<BrowserPublish\b/);
  assert.match(code, /state\.handoff\.length > 0/, "the hand-off block is still rendered");

  const card = withoutComments(await fs.readFile(fileURLToPath(new URL("../src/components/BrowserPublish.tsx", import.meta.url)), "utf8"));
  assert.match(card, /\/publish\/browser/);
  assert.equal([...card.matchAll(/acknowledgeRetry:\s*awaiting && looked/g)].length, 1, "the acknowledgement is sent only from the ticked box");
  assert.doesNotMatch(card, /setInterval|setTimeout/, "nothing in the card retries by itself");
});
