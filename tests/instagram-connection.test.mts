import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright-core";
import { prisma } from "../src/lib/db";
import { requireIsolation } from "./setup/isolation";
import { FakePage, fakeBrowser } from "./helpers/fake-browser.mjs";
import { acquirePlatformLock } from "../src/lib/publish/browser/live";
import { IG } from "../src/lib/publish/browser/instagram";
import { locateChromium, profileDirFor } from "../src/lib/publish/browser/engine";
import { scheduleSwitchIndex } from "../src/lib/publish/browser/instagram-schedule";
import {
  PROBE_CLICKS,
  VERIFICATION_SETTING,
  instagramConnectionView,
  parseCheckRequest,
  readVerification,
  startInstagramCheck,
  type CheckDeps,
} from "../src/lib/publish/browser/instagram-verify";
import {
  STALE_AFTER_MS,
  accountKindFromText,
  carryComposer,
  deriveConnection,
  judgedAgainst,
  nextStep,
  parseVerification,
  type InstagramConnectionView,
  type InstagramVerification,
} from "../src/lib/publish/instagram-connection";
import { InstagramConnectionCard } from "../src/components/InstagramConnection";
import { strings } from "../src/lib/strings";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const EXPECTED = "@between_pages";
const NOW = Date.parse("2026-11-01T06:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function record(over: Partial<InstagramVerification> = {}): InstagramVerification {
  return {
    v: 1,
    checkedAt: iso(NOW - 60_000),
    signedIn: true,
    handle: "between_pages",
    expected: EXPECTED,
    identity: "match",
    igUserId: "1784140000",
    accountKind: "unknown",
    calendar: "not_checked",
    scheduledCount: null,
    composer: "not_checked",
    composerCheckedAt: null,
    reason: null,
    ...over,
  };
}

// ---------------------------------------------------------------- the module stays client-safe

test("the connection rules import nothing but connect.ts, so the browser bundle cannot reach a server module", async () => {
  const source = await fs.readFile(path.join(SRC, "lib/publish/instagram-connection.ts"), "utf8");
  const specs = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(specs, ["./connect"]);
});

// ---------------------------------------------------------------- the four states

test("no look at the account is Not Connected", () => {
  const d = deriveConnection(null, NOW);
  assert.equal(d.state, "not_connected");
  assert.match(d.reason ?? "", /No Instagram account has been verified/);
});

test("signed out, behind a security check, or unreadable is Not Connected, with the reason it was stored with", () => {
  const out = deriveConnection(record({ signedIn: false, identity: "unverified", handle: null, reason: "Press Connect Instagram first." }), NOW);
  assert.equal(out.state, "not_connected");
  assert.equal(out.reason, "Press Connect Instagram first.");

  const unreadable = deriveConnection(record({ identity: "unverified", handle: null }), NOW);
  assert.equal(unreadable.state, "not_connected");
  assert.match(unreadable.reason ?? "", /did not say which account/);
});

test("the WRONG account is Not Connected and names both handles; it can never be Eligible", () => {
  const d = deriveConnection(record({ handle: "someone_else", identity: "mismatch", composer: "offers_schedule", composerCheckedAt: iso(NOW) }), NOW);
  assert.equal(d.state, "not_connected");
  assert.match(d.reason ?? "", /@someone_else/);
  assert.match(d.reason ?? "", /@between_pages/);
});

test("the right account with nothing else known is Connected", () => {
  assert.equal(deriveConnection(record(), NOW).state, "connected");
  assert.equal(deriveConnection(record({ accountKind: "professional", calendar: "readable", scheduledCount: 2 }), NOW).state, "connected");
});

test("Eligible needs the composer to have shown Schedule content, and nothing weaker earns it", () => {
  assert.equal(deriveConnection(record({ composer: "offers_schedule", composerCheckedAt: iso(NOW) }), NOW).state, "eligible");
  // A professional account and a readable calendar are NOT proof; only the composer is.
  assert.equal(deriveConnection(record({ accountKind: "professional", calendar: "readable" }), NOW).state, "connected");
  // A composer that could not be reached proves nothing either way.
  assert.equal(deriveConnection(record({ composer: "unreachable", composerCheckedAt: iso(NOW), reason: "Instagram did not offer a file picker." }), NOW).state, "connected");
});

test("Not Eligible: the composer lacked the row, or the account is positively personal", () => {
  const noRow = deriveConnection(record({ composer: "no_schedule_option", composerCheckedAt: iso(NOW) }), NOW);
  assert.equal(noRow.state, "not_eligible");
  assert.match(noRow.reason ?? "", /did not offer "Schedule content"/);

  const personal = deriveConnection(record({ accountKind: "personal" }), NOW);
  assert.equal(personal.state, "not_eligible");
  assert.match(personal.reason ?? "", /personal account/);
});

test("the composer is direct evidence, so it outranks the account-type heuristic in both directions", () => {
  assert.equal(deriveConnection(record({ accountKind: "personal", composer: "offers_schedule", composerCheckedAt: iso(NOW) }), NOW).state, "eligible");
  assert.equal(deriveConnection(record({ accountKind: "professional", composer: "no_schedule_option", composerCheckedAt: iso(NOW) }), NOW).state, "not_eligible");
});

test("an old look is still shown but flagged stale", () => {
  assert.equal(deriveConnection(record(), NOW).stale, false);
  assert.equal(deriveConnection(record({ checkedAt: iso(NOW - STALE_AFTER_MS - 1) }), NOW).stale, true);
});

test("if the install's expected handle changes, the old match is recomputed, not believed", () => {
  const moved = judgedAgainst(record(), "@new_brand");
  assert.equal(moved?.identity, "mismatch");
  assert.equal(deriveConnection(moved, NOW).state, "not_connected");
  assert.equal(judgedAgainst(record(), "between_pages")?.identity, "match");
  assert.equal(judgedAgainst(null, EXPECTED), null);
});

test("the next step follows the state, and 'done' needs BOTH flags", () => {
  const off = { publish: false, nativeSchedule: false };
  assert.equal(nextStep("not_connected", off), "connect");
  assert.equal(nextStep("connected", off), "check_scheduling");
  assert.equal(nextStep("not_eligible", off), "fix_account");
  assert.equal(nextStep("eligible", off), "set_flags");
  assert.equal(nextStep("eligible", { publish: true, nativeSchedule: false }), "set_flags");
  assert.equal(nextStep("eligible", { publish: true, nativeSchedule: true }), "done");
});

// ---------------------------------------------------------------- reading the account type

test("only the sentences unique to each account type decide it; everything else is unknown", () => {
  assert.equal(accountKindFromText("Edit profile  Switch to professional account  Show account suggestions"), "personal");
  assert.equal(accountKindFromText("Settings  Professional dashboard  Switch to personal account"), "professional");
  assert.equal(accountKindFromText("Account type and tools"), "professional");
  assert.equal(accountKindFromText("Edit profile  Website  Bio  Gender"), "unknown");
  assert.equal(accountKindFromText(""), "unknown");
  assert.equal(accountKindFromText(null), "unknown");
  // The personal sentence wins if both appear: a false "professional" would be the dangerous error.
  assert.equal(accountKindFromText("Switch to professional account ... Professional dashboard"), "personal");
});

// ---------------------------------------------------------------- the stored record

test("a stored record round-trips, and anything malformed reads as no record", () => {
  const good = record({ accountKind: "professional", calendar: "readable", scheduledCount: 3, composer: "offers_schedule", composerCheckedAt: iso(NOW) });
  assert.deepEqual(parseVerification(JSON.stringify(good)), good);

  for (const bad of [null, undefined, "", "not json", "[]", "null", '{"v":2}', JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, signedIn: "yes" }), JSON.stringify({ ...good, identity: "maybe" }), JSON.stringify({ ...good, composer: "yes" }), JSON.stringify({ ...good, checkedAt: "yesterday" })]) {
    assert.equal(parseVerification(bad as string | null | undefined), null, `should reject ${String(bad)}`);
  }
});

test("a composer answer with no time it was seen is not an answer", () => {
  const raw = JSON.stringify(record({ composer: "offers_schedule", composerCheckedAt: null }));
  assert.equal(parseVerification(raw)?.composer, "not_checked");
});

test("a fresh account-only look keeps a still-valid composer answer for the SAME account, and nothing else", () => {
  const eligible = record({ composer: "offers_schedule", composerCheckedAt: iso(NOW - 5_000) });
  const again = record({ checkedAt: iso(NOW) });
  const kept = carryComposer(eligible, again);
  assert.equal(kept.composer, "offers_schedule");
  assert.equal(kept.composerCheckedAt, eligible.composerCheckedAt);
  assert.equal(kept.checkedAt, again.checkedAt, "the account facts are the fresh ones");

  assert.equal(carryComposer(eligible, record({ handle: "other_account" })).composer, "not_checked", "another account");
  assert.equal(carryComposer(eligible, record({ igUserId: "999" })).composer, "not_checked", "same handle, different Instagram id");
  assert.equal(carryComposer(eligible, record({ signedIn: false, identity: "unverified" })).composer, "not_checked", "signed out");
  assert.equal(carryComposer(record({ composer: "unreachable", composerCheckedAt: iso(NOW) }), again).composer, "not_checked", "an unreachable composer is never carried");
  assert.equal(carryComposer(null, again).composer, "not_checked");
});

// ---------------------------------------------------------------- the request

test("verify needs nothing; the Schedule content check is refused without an explicit confirmation", () => {
  assert.equal(parseCheckRequest({ action: "verify" }), "account");
  assert.equal(parseCheckRequest({ action: "check_scheduling", confirm: true }), "scheduling");

  for (const body of [{ action: "check_scheduling" }, { action: "check_scheduling", confirm: false }, { action: "check_scheduling", confirm: "true" }, { action: "check_scheduling", confirm: 1 }]) {
    assert.throws(() => parseCheckRequest(body), (e: Error & { code?: string; status?: number }) => e.code === "needs_confirmation" && e.status === 400, JSON.stringify(body));
  }
  for (const body of [null, undefined, [], "verify", 7]) {
    assert.throws(() => parseCheckRequest(body), (e: Error & { code?: string }) => e.code === "bad_body");
  }
  assert.throws(() => parseCheckRequest({ action: "publish" }), (e: Error & { code?: string }) => e.code === "bad_action");
  assert.throws(() => parseCheckRequest({}), (e: Error & { code?: string }) => e.code === "bad_action");
});

// ---------------------------------------------------------------- the composer check can never commit anything

test("the composer check may click only Create, Post, Next, Advanced settings and Discard -- never Share or Schedule", () => {
  assert.deepEqual(Object.keys(PROBE_CLICKS).sort(), ["advanced", "discard", "newPost", "next", "postItem"]);
  for (const [key, selector] of Object.entries(PROBE_CLICKS)) {
    assert.doesNotMatch(selector, /share/i, `${key} must not be able to reach Share`);
    assert.doesNotMatch(selector, /schedul/i, `${key} must not be able to reach Schedule`);
    assert.notEqual(selector, IG.share, `${key} is the Share button`);
  }
});

test("the verifier imports none of the helpers that press Share/Schedule or turn the switch on, and writes no flag", async () => {
  const source = await fs.readFile(path.join(SRC, "lib/publish/browser/instagram-verify.ts"), "utf8");
  for (const forbidden of ["pressSchedule", "enableScheduleContent", "setReelDate", "setReelTime", "scheduleInstagram", "humanClick", "IG.share"]) {
    assert.ok(!source.includes(forbidden), `instagram-verify.ts must not use ${forbidden}`);
  }
  for (const file of ["lib/publish/browser/instagram-verify.ts", "lib/publish/instagram-connection.ts", "components/InstagramConnection.tsx", "app/api/publish/browser/instagram/route.ts"]) {
    const text = await fs.readFile(path.join(SRC, file), "utf8");
    assert.doesNotMatch(text, /process\.env\.[A-Z_]+\s*=[^=]/, `${file} assigns an environment variable`);
    assert.doesNotMatch(text, /(writeFile|appendFile|writeFileSync)[^\n]*\.env/, `${file} writes an env file`);
    assert.doesNotMatch(text, /type=["']password["']/, `${file} has a password field`);
  }
});

// ---------------------------------------------------------------- the whole verifier against a fake Instagram

function signedInPage(handle = "between_pages"): FakePage {
  const page = new FakePage();
  page.def(IG.appShell, { visible: true });
  page.def(IG.profilePicture, { attrs: { alt: `${handle}'s profile picture` } });
  return page;
}

async function reset(): Promise<void> {
  requireIsolation("these tests write the Setting table and drive a fake browser");
  await prisma.setting.deleteMany({ where: { key: VERIFICATION_SETTING } });
}

const CLIP = "C:/fake/work/instagram-probe/bookreel-schedule-check.mp4";

function depsFor(page: FakePage, extra: Partial<CheckDeps> = {}, env: Record<string, string> = {}) {
  const profileRoot = path.join(os.tmpdir(), "bookreel-ig-verify-test");
  const fake = fakeBrowser(page, { profileRoot, env: { BOOKREEL_PUBLISH_BROWSER_CHANNEL: "chrome", ...env } });
  const deps: CheckDeps = {
    ...fake.deps,
    waitForCompletion: true,
    now: () => NOW,
    readCalendar: async () => ({ userId: "1784140000", items: [{ id: "a", mediaId: "m", caption: "c", publishAt: iso(NOW + 3_600_000) }] }),
    readAccountText: async () => "Settings  Professional dashboard  Switch to personal account",
    placeholder: async () => CLIP,
    ...extra,
  };
  return { deps, fake };
}

/** Wire a fake composer onto `page`, and report what happened to it. */
function composerOn(page: FakePage, opts: { caption?: boolean; advancedReveals?: boolean } = {}) {
  const log: string[] = [];
  page.def(IG.newPost, { visible: true, onClick: () => log.push("newPost") });
  page.def(IG.postItem, { visible: true, onClick: () => log.push("postItem") });
  page.def(IG.fileInput, { visible: false, count: 1, onFiles: (f) => log.push(`file:${f[0]}`) });
  page.def(IG.next, { visible: true, onClick: () => log.push("next") });
  if (opts.caption !== false) page.def(IG.caption, { visible: true });
  // The Share button is on the page, and touching it is a test failure.
  page.def(IG.share, {
    visible: true,
    onClick: () => {
      throw new Error("SHARE WAS CLICKED");
    },
  });
  let revealed = false;
  if (opts.advancedReveals) {
    page.def(PROBE_CLICKS.advanced, { visible: () => !revealed, onClick: () => { revealed = true; log.push("advanced"); } });
  }
  return { log, rowVisible: () => revealed };
}

const noHooks = {
  draftProblem: async () => null,
  afterUpload: async () => {},
  settle: async () => {},
};

test("verify: signed in as the right account is Connected, reads the account, and touches nothing on the page", async () => {
  await reset();
  const page = signedInPage();
  const { deps } = depsFor(page);
  const view = await startInstagramCheck("account", deps);

  assert.equal(view.state, "connected");
  assert.equal(view.handle, "@between_pages");
  assert.equal(view.accountKind, "professional");
  assert.equal(view.calendar, "readable");
  assert.equal(view.scheduledCount, 1);
  assert.equal(view.composer, "not_checked");
  assert.equal(view.check.running, false);
  assert.equal(view.check.error, null);
  assert.deepEqual(page.touched(), [], "the account stage only reads: no click, no fill, no file, no key");

  const saved = await readVerification();
  assert.equal(saved?.signedIn, true);
  assert.equal(saved?.igUserId, "1784140000");
  assert.equal(saved?.checkedAt, iso(NOW));
});

test("verify: never writes a flag, and reports them exactly as the environment has them", async () => {
  await reset();
  const before = { a: process.env.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED, b: process.env.BOOKREEL_IG_NATIVE_SCHEDULE };
  const off = depsFor(signedInPage());
  const v1 = await startInstagramCheck("account", off.deps);
  assert.deepEqual(v1.flags, { publish: false, nativeSchedule: false });

  const on = depsFor(signedInPage(), {}, { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1", BOOKREEL_IG_NATIVE_SCHEDULE: "1" });
  const v2 = await instagramConnectionView(on.deps);
  assert.deepEqual(v2.flags, { publish: true, nativeSchedule: true });
  assert.equal(on.deps.env?.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED, "1", "the env handed in was not modified");
  assert.deepEqual({ a: process.env.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED, b: process.env.BOOKREEL_IG_NATIVE_SCHEDULE }, before, "process.env is untouched");
});

test("verify: Instagram signed out is Not Connected and says to Connect Instagram; the window is closed", async () => {
  await reset();
  const page = new FakePage();
  page.onGoto = (_url, p) => {
    p.currentUrl = "https://www.instagram.com/accounts/login/";
  };
  const { deps, fake } = depsFor(page);
  const view = await startInstagramCheck("account", deps);

  assert.equal(view.state, "not_connected");
  assert.match(view.reason ?? "", /Press Connect Instagram/);
  assert.equal(view.handle, null);
  assert.equal(fake.context.closed, true, "nothing to do in a signed-out window, so it is closed");
  assert.deepEqual(page.touched(), []);
  assert.equal((await readVerification())?.signedIn, false);
});

test("verify: a security check is reported, never touched, and the window is LEFT OPEN for the person", async () => {
  await reset();
  const page = new FakePage();
  page.onGoto = (_url, p) => {
    p.currentUrl = "https://www.instagram.com/challenge/action/abc/";
  };
  const { deps, fake } = depsFor(page);
  const view = await startInstagramCheck("account", deps);

  assert.equal(view.state, "not_connected");
  assert.match(view.reason ?? "", /security check/);
  assert.match(view.reason ?? "", /does not try to get past it/);
  assert.equal(fake.context.closed, false, "the person has to clear it, so the window stays");
  assert.deepEqual(page.touched(), []);
});

test("verify: the wrong account is Not Connected, names both handles, and its calendar is never read", async () => {
  await reset();
  const page = signedInPage("someone_else");
  let calendarReads = 0;
  const { deps } = depsFor(page, { readCalendar: async () => { calendarReads++; return { userId: "1", items: [] }; } });
  const view = await startInstagramCheck("account", deps);

  assert.equal(view.state, "not_connected");
  assert.equal(view.handle, "@someone_else");
  assert.match(view.reason ?? "", /@someone_else/);
  assert.match(view.reason ?? "", /@between_pages/);
  assert.equal(calendarReads, 0, "nothing further is read about an account that is not the right one");
  assert.equal(view.calendar, "not_checked");
});

test("verify: an account Instagram will not name is Not Connected, not guessed at", async () => {
  await reset();
  const page = new FakePage();
  page.def(IG.appShell, { visible: true });
  page.def(IG.profilePicture, { attrs: { alt: null } });
  const { deps } = depsFor(page);
  const view = await startInstagramCheck("account", deps);
  assert.equal(view.state, "not_connected");
  assert.match(view.reason ?? "", /did not say which account is signed in/);
});

test("verify: a positively personal account is Not Eligible without ever opening the composer", async () => {
  await reset();
  const page = signedInPage();
  composerOn(page);
  const { deps } = depsFor(page, { readAccountText: async () => "Edit profile  Switch to professional account" });
  const view = await startInstagramCheck("account", deps);
  assert.equal(view.state, "not_eligible");
  assert.match(view.reason ?? "", /personal account/);
  assert.deepEqual(page.touched(), []);
});

test("the Profile-in-use failure (the sign-in window is still open) says exactly what to close and changes nothing", async () => {
  await reset();
  const page = signedInPage();
  const profileRoot = path.join(os.tmpdir(), "bookreel-ig-verify-test");
  const fake = fakeBrowser(page, { profileRoot, env: { BOOKREEL_PUBLISH_BROWSER_CHANNEL: "chrome" }, launchError: new Error("Opening in existing browser session.") });
  const view = await startInstagramCheck("account", { ...fake.deps, waitForCompletion: true, now: () => NOW });
  assert.match(view.check.error ?? "", /Close the Instagram sign-in window/);
  assert.equal(await readVerification(), null, "a failed attempt records nothing");
  assert.equal(view.state, "not_connected");
});

test("a browser that is not installed is refused before anything starts", async () => {
  await reset();
  const page = signedInPage();
  const { deps } = depsFor(page);
  const fake = fakeBrowser(page, { profileRoot: os.tmpdir(), env: { BOOKREEL_PUBLISH_BROWSER_CHANNEL: "chrome" }, channelInstalled: false });
  await assert.rejects(
    startInstagramCheck("account", { ...deps, ...fake.deps, waitForCompletion: true }),
    (e: Error & { code?: string; status?: number }) => e.code === "browser_unavailable" && e.status === 409,
  );
  assert.equal((await instagramConnectionView(fake.deps)).check.running, false, "the claim on 'running' was released");
});

test("a check cannot start while an Instagram publish holds the window", async () => {
  await reset();
  const release = await acquirePlatformLock("instagram");
  try {
    const { deps } = depsFor(signedInPage());
    await assert.rejects(startInstagramCheck("account", deps), (e: Error & { code?: string }) => e.code === "instagram_busy");
  } finally {
    release();
  }
});

test("two presses start one check: the second is refused while the first runs", async () => {
  await reset();
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const { deps } = depsFor(signedInPage(), { waitForCompletion: false, readCalendar: async () => { await gate; return { userId: "1", items: [] }; } });
  const first = await startInstagramCheck("account", deps);
  assert.equal(first.check.running, true);
  await assert.rejects(startInstagramCheck("account", deps), (e: Error & { code?: string }) => e.code === "check_running");
  open();
  for (let i = 0; i < 200 && (await instagramConnectionView(deps)).check.running; i++) await new Promise((r) => setTimeout(r, 10));
  const done = await instagramConnectionView(deps);
  assert.equal(done.check.running, false);
  assert.equal(done.state, "connected");
});

// ---- the composer check

test("scheduling: Schedule content offered => Eligible, and the page saw exactly Create, Post, file, Next, Next, Escape", async () => {
  await reset();
  const page = signedInPage();
  const composer = composerOn(page);
  const { deps } = depsFor(page, { probe: { ...noHooks, scheduleRowPresent: async () => true } });
  const view = await startInstagramCheck("scheduling", deps);

  assert.equal(view.state, "eligible");
  assert.equal(view.composer, "offers_schedule");
  assert.equal(view.composerCheckedAt, iso(NOW));
  assert.deepEqual(composer.log, ["newPost", "postItem", `file:${CLIP}`, "next", "next"]);
  // The exact, complete list of what touched the page. Share is defined and was never reached.
  assert.deepEqual(page.touched(), [
    `click:${IG.newPost}`,
    `click:${IG.postItem}`,
    `files:${IG.fileInput}=${CLIP}`,
    `click:${IG.next}`,
    `click:${IG.next}`,
    "press:Escape",
  ]);
  assert.equal(view.flags.publish, false, "an Eligible account does not switch anything on");
});

test("scheduling: the last screen reached and no row => Not Eligible (and the Advanced section is looked inside first)", async () => {
  await reset();
  const page = signedInPage();
  const composer = composerOn(page, { advancedReveals: true });
  const { deps } = depsFor(page, { probe: { ...noHooks, scheduleRowPresent: async () => false } });
  const view = await startInstagramCheck("scheduling", deps);

  assert.equal(view.state, "not_eligible");
  assert.equal(view.composer, "no_schedule_option");
  assert.match(view.reason ?? "", /did not offer "Schedule content"/);
  assert.ok(composer.log.includes("advanced"), "it opened Advanced settings to look before saying no");
  assert.ok(page.touched().every((a) => !a.includes(IG.share)), "Share was never touched");
});

test("scheduling: the row is found inside a collapsed Advanced section", async () => {
  await reset();
  const page = signedInPage();
  const composer = composerOn(page, { advancedReveals: true });
  const { deps } = depsFor(page, { probe: { ...noHooks, scheduleRowPresent: async () => composer.rowVisible() } });
  const view = await startInstagramCheck("scheduling", deps);
  assert.equal(view.state, "eligible");
  assert.ok(composer.log.includes("advanced"));
});

test("scheduling: a composer that never reached its last screen is 'unreachable', NEVER 'Not Eligible'", async () => {
  await reset();
  const page = signedInPage();
  composerOn(page, { caption: false });
  const { deps } = depsFor(page, { probe: { ...noHooks, scheduleRowPresent: async () => false } });
  const view = await startInstagramCheck("scheduling", deps);

  assert.equal(view.composer, "unreachable");
  assert.notEqual(view.state, "not_eligible");
  assert.equal(view.state, "connected");
  assert.match(view.check.error ?? "", /did not reach its last screen/);
  assert.match(view.check.error ?? "", /did not find out whether this account can schedule/);
});

test("scheduling: a draft that is already open stops the check before the composer is touched", async () => {
  await reset();
  const page = signedInPage();
  composerOn(page);
  const { deps } = depsFor(page, { probe: { ...noHooks, draftProblem: async () => "Instagram has an open or resumed draft.", scheduleRowPresent: async () => true } });
  const view = await startInstagramCheck("scheduling", deps);
  assert.equal(view.composer, "unreachable");
  assert.ok(!page.touched().some((a) => a.startsWith("click:") || a.startsWith("files:")), "it never clicked Create or loaded a file");
});

test("scheduling: an unreachable retry keeps an earlier definitive answer for the same account", async () => {
  await reset();
  const first = signedInPage();
  composerOn(first);
  await startInstagramCheck("scheduling", depsFor(first, { probe: { ...noHooks, scheduleRowPresent: async () => true } }).deps);
  assert.equal((await readVerification())?.composer, "offers_schedule");

  const second = signedInPage();
  composerOn(second, { caption: false });
  const view = await startInstagramCheck("scheduling", depsFor(second, { probe: { ...noHooks, scheduleRowPresent: async () => false } }).deps);
  assert.equal(view.composer, "offers_schedule", "one failed attempt does not erase a real answer");
  assert.equal(view.state, "eligible");
  assert.match(view.check.error ?? "", /last screen/, "but the failed attempt is still reported");
});

test("re-verifying a good account (account-only) does not throw away its Eligible answer", async () => {
  await reset();
  const first = signedInPage();
  composerOn(first);
  await startInstagramCheck("scheduling", depsFor(first, { probe: { ...noHooks, scheduleRowPresent: async () => true } }).deps);

  const again = signedInPage();
  const view = await startInstagramCheck("account", depsFor(again).deps);
  assert.equal(view.state, "eligible");
  assert.deepEqual(again.touched(), []);

  // ...but if the same window is now a DIFFERENT account, the answer is gone with it.
  const other = signedInPage("someone_else");
  const gone = await startInstagramCheck("account", depsFor(other).deps);
  assert.equal(gone.state, "not_connected");
  assert.equal(gone.composer, "not_checked");
});

test("scheduling: the wrong account is never taken into the composer", async () => {
  await reset();
  const page = signedInPage("someone_else");
  composerOn(page);
  const { deps } = depsFor(page, { probe: { ...noHooks, scheduleRowPresent: async () => true } });
  const view = await startInstagramCheck("scheduling", deps);
  assert.equal(view.state, "not_connected");
  assert.deepEqual(page.touched(), [], "no Create, no file");
});

test("the profile folder used is BookReel's own Instagram profile, never a personal one", async () => {
  await reset();
  const page = signedInPage();
  const { deps, fake } = depsFor(page);
  await startInstagramCheck("account", deps);
  assert.equal(fake.launches.length, 1);
  assert.equal(fake.launches[0].profileDir, profileDirFor("instagram", deps.profileRoot));
  assert.match(fake.launches[0].profileDir.replace(/\\/g, "/"), /browser-profiles\/instagram$/);
});

// ---------------------------------------------------------------- the card

function makeView(over: Partial<InstagramConnectionView> = {}): InstagramConnectionView {
  return {
    state: "not_connected",
    handle: null,
    expected: EXPECTED,
    accountKind: "unknown",
    calendar: "not_checked",
    scheduledCount: null,
    composer: "not_checked",
    checkedAt: null,
    composerCheckedAt: null,
    stale: false,
    reason: "No Instagram account has been verified on this install yet.",
    next: "connect",
    check: { running: false, mode: null, step: null, startedAt: null, finishedAt: null, error: null },
    browser: { ready: true, reason: null, kind: "channel", headless: false },
    flags: { publish: false, nativeSchedule: false },
    ...over,
  };
}

function card(v: InstagramConnectionView | null, props: { loadError?: string | null; busy?: "connect" | "verify" | "schedule" | null; note?: string | null } = {}): string {
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(InstagramConnectionCard, {
      view: v, loadError: props.loadError ?? null, busy: props.busy ?? null, note: props.note ?? null,
      onConnect: noop, onVerify: noop, onCheckScheduling: noop, onReload: noop,
    }),
  );
}

const c = strings.publishCenter.instagramConnect;

test("card: Not Connected shows the button, the steps, and no scheduling check", () => {
  const html = card(makeView());
  assert.match(html, /data-state="not_connected"/);
  assert.ok(html.includes("Not Connected"));
  assert.ok(html.includes("Connect Instagram"));
  assert.ok(html.includes("Verify account"));
  assert.ok(html.includes(c.stepsHeading));
  assert.ok(html.includes("sign in as @between_pages yourself"));
  assert.ok(html.includes("never sees your Instagram password"), "the assurance is on the card, not buried");
  assert.ok(!html.includes("has been verified on this install yet"), "the never-checked state is said once, not twice");
  assert.ok(!html.includes("data-instagram-check-scheduling"), "no scheduling check before the account is connected");
  assert.ok(html.includes(c.flagsOff));
});

test("card: Connected offers the scheduling check, behind a disclosure and an unticked confirmation", () => {
  const html = card(makeView({ state: "connected", handle: "@between_pages", reason: null, accountKind: "professional", calendar: "readable", scheduledCount: 2, checkedAt: new Date(NOW).toISOString(), next: "check_scheduling" }));
  assert.match(html, /data-state="connected"/);
  assert.ok(html.includes("Check Schedule content"));
  assert.ok(html.includes(c.scheduleDisclosureHeading));
  assert.ok(html.includes("never presses Share or Schedule"), "the disclosure says nothing is posted");
  assert.ok(html.includes('data-instagram-check-scheduling="true"'));
  assert.match(html, /aria-disabled="true"[^>]*data-instagram-check-scheduling="true"/, "disabled until confirmed");
  assert.ok(html.includes("Readable (2 scheduled)"));
  assert.ok(html.includes("Professional"));
  assert.ok(!html.includes("Not Connected"));
});

test("card: Eligible for Scheduling tells the operator the two lines to set themselves, and does not set them", () => {
  const html = card(makeView({ state: "eligible", handle: "@between_pages", reason: null, composer: "offers_schedule", next: "set_flags" }));
  assert.match(html, /data-state="eligible"/);
  assert.ok(html.includes("Eligible for Scheduling"));
  assert.ok(html.includes("BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=1"));
  assert.ok(html.includes("BOOKREEL_IG_NATIVE_SCHEDULE=1"));
  assert.ok(html.includes("yourself"));
  assert.ok(html.includes("Offered by Instagram"));

  const on = card(makeView({ state: "eligible", handle: "@between_pages", reason: null, composer: "offers_schedule", next: "done", flags: { publish: true, nativeSchedule: true } }));
  assert.ok(on.includes(c.flagsOn));
  assert.ok(!on.includes("BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=1"));
});

test("card: Not Eligible says why and what to change", () => {
  const html = card(makeView({ state: "not_eligible", handle: "@between_pages", composer: "no_schedule_option", reason: 'Instagram\'s composer did not offer "Schedule content" for @between_pages.', next: "fix_account" }));
  assert.match(html, /data-state="not_eligible"/);
  assert.ok(html.includes("Not Eligible"));
  assert.ok(html.includes("Not offered"));
  assert.ok(html.includes(c.fixAccount));
  assert.ok(!html.includes("BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=1"), "no instruction to switch publishing on for an account that cannot schedule");
});

test("card: a publishing switch that is ON for an account that is not Eligible is called out", () => {
  const html = card(makeView({ state: "connected", handle: "@between_pages", reason: null, flags: { publish: true, nativeSchedule: false } }));
  assert.ok(html.includes(c.flagsBlocked));
});

test("card: while a check runs it says so, shows the step, and disables every button", () => {
  const html = card(makeView({ state: "connected", handle: "@between_pages", reason: null, check: { running: true, mode: "account", step: "Reading the account type", startedAt: null, finishedAt: null, error: null } }));
  assert.ok(html.includes("Checking Instagram…"));
  assert.ok(html.includes("Reading the account type"));
  for (const hook of ['data-instagram-connect="true"', 'data-instagram-verify="true"']) {
    assert.ok(html.includes(`aria-disabled="true"`) && new RegExp(`aria-disabled="true"[^>]*${hook}`).test(html), `${hook} is disabled while running`);
  }
});

test("card: a check that could not finish shows its error as an alert", () => {
  const html = card(makeView({ check: { running: false, mode: "account", step: null, startedAt: null, finishedAt: null, error: "Close the Instagram sign-in window, then verify again." } }));
  assert.match(html, /role="alert"/);
  assert.ok(html.includes("Close the Instagram sign-in window"));
});

test("card: attaching to the operator's own Chrome hides Connect Instagram and says why", () => {
  const html = card(makeView({ browser: { ready: true, reason: null, kind: "attach", headless: false } }));
  assert.ok(!html.includes('data-instagram-connect="true"'), "no Connect Instagram button when attaching");
  assert.ok(html.includes("BOOKREEL_PUBLISH_CHROME_CDP"));
});

test("card: loading and load-failure states", () => {
  assert.match(card(null), /data-instagram-connection="loading"/);
  const failed = card(null, { loadError: "The Instagram connection could not be read." });
  assert.match(failed, /role="alert"/);
  assert.ok(failed.includes("Try again"));
});

test("card: there is nowhere to type a password or a code, in any state", () => {
  for (const v of [makeView(), makeView({ state: "connected" }), makeView({ state: "eligible", composer: "offers_schedule" }), makeView({ state: "not_eligible" })]) {
    const html = card(v);
    assert.doesNotMatch(html, /type="password"/);
    assert.doesNotMatch(html, /type="text"/);
    assert.doesNotMatch(html, /<input(?![^>]*type="checkbox")/, "the only input is the confirmation checkbox");
  }
});

test("card copy: all four state words are exactly the ones the brief names", () => {
  assert.deepEqual(c.stateLabel, {
    not_connected: "Not Connected",
    connected: "Connected",
    eligible: "Eligible for Scheduling",
    not_eligible: "Not Eligible",
  });
});

// ---------------------------------------------------------------- the "Schedule content" detector, in a real Chromium

let browser: Browser | undefined;
const haveBrowser = Boolean(locateChromium());
test.before(async () => {
  if (haveBrowser) browser = await chromium.launch({ executablePath: locateChromium() ?? undefined });
});
test.after(async () => {
  await browser?.close();
});

const composerHtml = (withRow: boolean) => `<!doctype html><html><body><div role="dialog">
  <div><span>Add AI label</span><div role="switch" aria-checked="true"></div></div>
  ${withRow ? '<div><span>Schedule content</span><div role="switch" aria-checked="false"></div></div>' : ""}
  <div role="button">Share</div></div></body></html>`;

test("scheduleSwitchIndex finds the Schedule content switch by its own label, not by position", { skip: !haveBrowser }, async () => {
  const page = await browser!.newPage();
  try {
    await page.setContent(composerHtml(true));
    assert.equal(await scheduleSwitchIndex(page), 1, "the second switch, after Add AI label");
    await page.setContent(composerHtml(false));
    assert.equal(await scheduleSwitchIndex(page), null, "an account whose composer has no row");
    assert.equal(await page.locator('[role="switch"]').first().getAttribute("aria-checked"), "true", "nothing was toggled by looking");
  } finally {
    await page.close();
  }
});

