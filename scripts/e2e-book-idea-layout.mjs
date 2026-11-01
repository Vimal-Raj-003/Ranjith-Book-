/** Book PDFs layout regression. Uses only an isolated database and synthetic videos. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { PrismaClient } from "@prisma/client";

if (!process.env.BOOKREEL_TEST_DB_PID || !process.env.DATABASE_URL?.includes("/.bookreel/test/run-")) {
  throw new Error("Run with --import ./tests/setup/isolated-db.mjs; never use the application database.");
}
const db = new PrismaClient();
const artifacts = path.resolve(".bookreel/book-idea-layout");
const work = path.resolve(process.env.BOOKREEL_WORK_ROOT);
assert.ok(work.startsWith(path.resolve(".bookreel/test") + path.sep));
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(path.join(work, "renders"), { recursive: true });
const base = "http://127.0.0.1:3016";
const checks = [], errors = [], blockedActions = [];
let server, browser, page, logFd;

try {
  const user = await db.user.create({ data: { email: "layout@example.test" } });
  const book = await db.book.create({ data: { title: "Layout fixture book", rightsStatus: "in-copyright" } });
  const upload = await db.upload.create({ data: { bookId: book.id, userId: user.id, kind: "pdf", status: "DONE" } });
  const ideas = [];
  for (let i = 0; i < 3; i++) {
    ideas.push(await db.contentIdea.create({ data: {
      bookId: book.id, uploadId: upload.id, rank: i + 1, ideaKey: `idea-${i}`,
      title: "Same title deliberately", hook: "One small change makes room for a better day.",
      coreIdea: "Build a useful habit by making its first step simple and repeatable. Make room for the things that matter most, one day at a time.",
      whyItMatters: "A useful explanation", angle: "story", hookPotential: "A familiar problem",
      storyPotential: "A practical example", practicalValue: "An easy first step", visualPotential: "A simple illustration",
      sourcePages: "[]", sourceRefs: "[]", sourceText: "Fixture source text.", scores: "{}", score: 1,
    } }));
  }
  const clip = path.join(work, "renders", "fixture.mp4");
  execFileSync(path.resolve("tools/bin/ffmpeg.exe"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x25164c:s=180x320:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip], { windowsHide: true });
  // Deliberately interleave creation order and give unrelated videos identical titles.
  const episodes = [];
  for (const [index, ideaIndex] of [2, 0, 0].entries()) {
    const episode = await db.episode.create({ data: {
      bookId: book.id, uploadId: upload.id, userId: user.id, contentIdeaId: ideas[ideaIndex].id,
      status: "DONE", title: "Same video title deliberately", durationSec: 2,
      createdAt: new Date(Date.now() - (3 - index) * 1000),
    } });
    const videoPath = path.join(work, "renders", `${episode.id}.mp4`);
    fs.copyFileSync(clip, videoPath);
    await db.episode.update({ where: { id: episode.id }, data: { videoPath } });
    episodes.push(episode);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await db.session.create({ data: { userId: user.id, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } });
  logFd = fs.openSync(path.join(artifacts, "server.log"), "w");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3016"], {
    windowsHide: true, stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BOOKREEL_SCHEDULE_WORKER_ENABLED: "0", BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "0", BOOKREEL_IG_NATIVE_SCHEDULE: "0" },
  });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "isolated server started");
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => localStorage.setItem("bookreel-theme", "dark"));
  await context.addCookies([{ name: "bookreel_session", value: token, url: base, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    // Allow only selection mutations; generation, scheduling and publishing cannot execute.
    const selectionPaths = [`/api/books/${upload.id}/ideas`, ...ideas.map(idea => `/api/books/${upload.id}/ideas/${idea.id}`)];
    if (!["GET", "HEAD"].includes(request.method()) && !(request.method() === "PATCH" && selectionPaths.includes(url.pathname))) {
      blockedActions.push(url.pathname);
      return route.fulfill({ status: 409, json: { error: "Publishing and generation are disabled in this layout test." } });
    }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.getByRole("button", { name: "Book PDFs", exact: true }).click();
  await page.locator("[data-idea-group]").first().waitFor();
  const groups = page.locator("[data-idea-group]");
  assert.deepEqual(await groups.evaluateAll(nodes => nodes.map(node => node.dataset.ideaGroup)), ideas.map(idea => idea.id));
  for (const [index, idea] of ideas.entries()) {
    const group = page.locator(`[data-idea-group="${idea.id}"]`);
    const expected = episodes.filter(episode => episode.contentIdeaId === idea.id).reverse().map(episode => episode.id);
    assert.deepEqual(await group.locator("[data-idea-video]").evaluateAll(nodes => nodes.map(node => node.dataset.ideaVideo)), expected);
    if (!expected.length) {
      assert.equal(await group.getByText("No generated video yet", { exact: true }).count(), 1);
    } else {
      for (const id of expected) {
        const row = group.locator(`[data-idea-video="${id}"]`);
        await row.locator(`video[src="/api/episodes/${id}/video"]`).waitFor();
        assert.equal(await row.getByRole("button", { name: "Publish", exact: true }).isEnabled(), true);
        assert.equal(await row.getByRole("link", { name: "Download video", exact: true }).count(), 1);
      }
    }
    const card = await group.locator(":scope > article").boundingBox();
    assert.ok(card.width > card.height * 3, "idea card is a compact horizontal rectangle");
    if (index < ideas.length - 1) {
      const box = await group.boundingBox(), next = await groups.nth(index + 1).boundingBox();
      assert.ok(next.y >= box.y + box.height, "the next idea follows all videos in the preceding group");
    }
  }
  checks.push("ranked idea groups retain every ID-linked video despite identical titles and interleaved creation order", "multiple videos, inline previews, download and publishing controls", "compact desktop cards and empty placeholder");
  const alternate = page.locator(`[data-idea-video="${episodes[1].id}"]`);
  await alternate.getByRole("button", { name: /^Show .* in the preview$/ }).click();
  assert.equal(await alternate.getByRole("button", { name: "Showing in the preview", exact: true }).isDisabled(), true);
  await alternate.locator("video").evaluate(video => { video.muted = true; void video.play().catch(() => {}); });
  await page.waitForFunction(id => {
    const video = document.querySelector(`[data-idea-video="${id}"] video`);
    return video && video.currentTime > 0;
  }, episodes[1].id, { timeout: 10000 });
  await alternate.locator("video").evaluate(video => video.pause());
  checks.push("preview selection still selects the intended episode and the synthetic video plays");
  const first = groups.first();
  await Promise.all([
    page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/ideas/${ideas[0].id}`)),
    first.getByRole("checkbox").check(),
  ]);
  assert.equal((await db.contentIdea.findUniqueOrThrow({ where: { id: ideas[0].id } })).status, "SELECTED");
  await Promise.all([
    page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/ideas")),
    page.getByRole("button", { name: "Select all", exact: true }).click(),
  ]);
  assert.equal(await groups.locator("input:checked").count(), 3);
  await Promise.all([
    page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/ideas")),
    page.getByRole("button", { name: "Deselect all", exact: true }).click(),
  ]);
  assert.equal(await groups.locator("input:checked").count(), 0);
  await first.getByText("Why it works", { exact: true }).click();
  await first.getByText("A useful explanation", { exact: true }).waitFor({ state: "visible" });
  await first.getByText("Why it works", { exact: true }).click();
  assert.equal(await page.getByRole("region", { name: "Book PDFs", exact: true }).getByRole("link", { name: "Weekly Schedule", exact: true }).getAttribute("href"), "/schedule");
  checks.push("individual and bulk selection persist; disclosures and Weekly Schedule remain available");
  await page.screenshot({ path: path.join(artifacts, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no mobile horizontal overflow");
  assert.equal(await groups.count(), 3);
  await page.screenshot({ path: path.join(artifacts, "mobile.png"), fullPage: true });
  checks.push("390px layout retains every group without horizontal overflow");
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedActions, []);
  assert.equal(await db.publishJob.count(), 0);
  assert.equal(await db.weeklySchedule.count(), 0);
  console.log(JSON.stringify({ passed: true, checks, artifacts, realUploads: 0 }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(artifacts, "failure.txt"), await page.locator("body").innerText().catch(() => "Page unavailable"));
  }
  throw error;
} finally {
  await browser?.close();
  if (server?.pid) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else server.kill("SIGTERM");
    } catch {}
  }
  if (logFd !== undefined) fs.closeSync(logFd);
  await db.$disconnect();
}
