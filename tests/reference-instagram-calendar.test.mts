import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { locateChromium as findChromium } from "../src/lib/publish/browser/engine";
import { parseInstagramCalendar, judgeInstagramCalendar, readInstagramCalendar, verifyInstagramCalendar,
  instagramScheduleTimeProblem, instagramDraftProblem, sameInstagramCaption } from "../src/lib/publish/browser/instagram-calendar";
import { zonedInstant } from "../src/lib/schedule/reference-time";

const caption = "A tool worth trying.\n\nhttps://github.com/acme/tool\n#opensource";
const at = zonedInstant("2026-10-29", "05:11", "Asia/Kolkata");
const identity = { caption, repoUrl: "https://github.com/acme/tool", publishAt: at };
const row = (over: Record<string, unknown> = {}) => ({ id: "123", media: { id: "456_789" },
  caption_text: caption, scheduled_publish_time: at.getTime() / 1000, ...over });
const response = (items: unknown[] = [row()], userId = "789") => ({ data: { viewer: { xdt_user: { id: userId, all_scheduled_ig_content: items } } } });

test("reads the actual calendar response shape with a remote ID, full caption and UTC publication instant", () => {
  const calendar = parseInstagramCalendar(response())!;
  assert.equal(calendar.userId, "789");
  assert.equal(calendar.items[0].publishAt, "2026-10-28T23:41:00.000Z");
  assert.equal(calendar.items[0].mediaId, "456_789");
  assert.equal(judgeInstagramCalendar(calendar, identity).kind, "confirmed");
});

test("the pre-submit footer cannot confirm scheduling", () => {
  assert.equal(parseInstagramCalendar("Your reel will be shared with your followers in their feeds."), null);
  assert.equal(judgeInstagramCalendar(parseInstagramCalendar(response([]))!, identity).kind, "clear");
});

test("unknown, partial and malformed calendars never count as an empty checked calendar", () => {
  for (const raw of [null, {}, { data: { viewer: null } }, response([row({ media: null })]),
    response([row({ scheduled_publish_time: null })]), response([row({ caption_text: null })]),
    response([row({ scheduled_publish_time: 1e99 })]), response([row(), row({ id: null })])]) {
    assert.equal(parseInstagramCalendar(raw), null);
  }
  assert.equal(parseInstagramCalendar(response([]))?.items.length, 0, "a verified complete empty list is different");
});

test("a different time, caption or duplicate copy blocks upload and cannot be adopted", () => {
  for (const items of [[row({ scheduled_publish_time: at.getTime()/1000 + 60 })],
    [row({ caption_text: "Different copy for https://github.com/acme/tool" })], [row(), row({ id: "124" })]]) {
    assert.equal(judgeInstagramCalendar(parseInstagramCalendar(response(items))!, identity).kind, "blocked");
  }
});

test("an uncertain earlier upload cannot be uploaded again unless the calendar confirms it", () => {
  const expected = { ...identity, remoteContainerId: "instagram-upload-unconfirmed" };
  assert.equal(judgeInstagramCalendar(parseInstagramCalendar(response([]))!, expected).kind, "blocked");
  assert.equal(judgeInstagramCalendar(parseInstagramCalendar(response())!, expected).kind, "confirmed");
});

test("the 30-minute gap is checked against actual scheduled content without moving either post", () => {
  const other = (offset: number) => parseInstagramCalendar(response([row({ caption_text: "Other repo", scheduled_publish_time: at.getTime()/1000 + offset })]))!;
  assert.equal(judgeInstagramCalendar(other(29 * 60), identity).kind, "blocked");
  assert.equal(judgeInstagramCalendar(other(30 * 60), identity).kind, "clear");
  assert.equal(judgeInstagramCalendar(other(-29 * 60), identity).kind, "blocked");
});

test("scheduling rejects passed/missing/too-near times rather than sharing immediately", () => {
  const now = new Date(at.getTime() - 20 * 60_000);
  assert.equal(instagramScheduleTimeProblem(at, now, "Asia/Kolkata"), null);
  for (const target of [null, new Date(NaN), now, new Date(now.getTime() + 19 * 60_000)]) {
    assert.match(instagramScheduleTimeProblem(target, now, "Asia/Kolkata")!, /Instagram/);
  }
  assert.equal(sameInstagramCaption("a".repeat(80) + " changed", "a".repeat(80) + " original"), false);
});

let browser: Browser;
test.before(async () => { browser = await chromium.launch({ executablePath: (await findChromium()) ?? undefined }); });
test.after(async () => { await browser?.close(); });

async function fixture(body: unknown) {
  const context = await browser.newContext();
  await context.route("https://www.instagram.com/scheduled_content/", route => route.fulfill({
    contentType: "text/html", body: '<!doctype html><p>Scheduled content</p><script>fetch("/graphql/query/")</script>',
  }));
  await context.route("https://www.instagram.com/graphql/query/", route => route.fulfill({ json: body }));
  return context;
}

test("verifies the calendar through its read response without touching the composer", async () => {
  const context = await fixture(response());
  try {
    const composer = await context.newPage();
    await composer.setContent('<div role="dialog">Your reel will be shared with your followers.</div>');
    const item = await verifyInstagramCalendar(composer, identity, { timeoutMs: 0, userId: "789" });
    assert.equal(item.id, "123");
    assert.equal(item.publishAt, at.toISOString());
    assert.match(await composer.locator("body").innerText(), /Your reel will be shared/);
    assert.equal(context.pages().length, 1, "the read-only verification tab is closed");
  } finally { await context.close(); }
});

test("a wrong calendar time or changed account cannot produce a success", async () => {
  for (const body of [response([row({ scheduled_publish_time: at.getTime()/1000 + 60 })]), response([row()], "other-account")]) {
    const context = await fixture(body);
    try {
      await assert.rejects(verifyInstagramCalendar(await context.newPage(), identity, { timeoutMs: 0, userId: "789" }), /differs|changed/);
    } finally { await context.close(); }
  }
});

test("a missing calendar is actionable and does not count instructional text as success", async () => {
  const context = await fixture({ data: null });
  try { await assert.rejects(readInstagramCalendar(await context.newPage(), 300), /could not be read/); }
  finally { await context.close(); }
});

test("resumed web drafts and exposed draft lists stop a new upload", async () => {
  const page = await browser.newPage();
  try {
    for (const content of ['<video></video>', '<textarea>Earlier caption</textarea>', '<button>Drafts (2)</button>']) {
      await page.setContent(`<div role="dialog">${content}</div>`);
      assert.ok(await instagramDraftProblem(page));
    }
    await page.setContent('<div role="dialog"><input type="file"></div>');
    assert.equal(await instagramDraftProblem(page), null);
  } finally { await page.close(); }
});
