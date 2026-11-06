import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { locateChromium, type ContextLike } from "../src/lib/publish/browser/engine";
import { browserYouTubePublisher } from "../src/lib/publish/browser/youtube";
import type { PreparedPublish } from "../src/lib/publish/contract";
import { detailsFixture, fixtureTags } from "./helpers/youtube-details-fixture.mjs";
import { NeedsHuman } from "../src/lib/publish/browser/engine";
import { confirmScheduleReceipt } from "../src/lib/publish/browser/native-controls";

// Real browser and production controls, but every URL is fulfilled locally.
// The synthetic file never leaves this isolated context or reaches YouTube.
const chrome = await locateChromium();
let browser: Browser;
test.before(async () => { if (chrome) browser = await chromium.launch({ executablePath: chrome }); });
test.after(async () => { await browser?.close(); });
const channel = "UCfixture1234567890123456";
const video = "fixture1234";
const title = "Fixture scheduled video";
const description = "Approved fixture description.";
const at = new Date("2030-10-28T00:09:00Z"); // 05:39 Asia/Kolkata.

function uploadFixture(zone = "(GMT+0530) Local Time", failure = "", immediate = false) {
  return `<!doctype html><style>
    [hidden]{display:none!important} body{font:16px sans-serif}
    ytcp-uploads-dialog{display:block;position:fixed;inset:40px;z-index:20;background:white;padding:20px;overflow:auto}
    tp-yt-iron-overlay-backdrop{position:fixed;inset:0;z-index:30}
    tp-yt-paper-dialog{display:block;position:fixed;right:50px;top:50px;background:white;z-index:40;padding:20px}
    button,input{padding:10px;margin:10px} [contenteditable]{border:1px solid gray;min-height:25px}
  </style><button id="create-icon" onclick="document.querySelector('#text-item-0').hidden=false">Create</button>
  <a href="https://youtube.com/shorts/WRONGID1234">Unrelated dashboard video</a>
  <button id="text-item-0" hidden onclick="document.querySelector('ytcp-uploads-dialog').hidden=false">Upload videos</button>
  <ytcp-uploads-dialog hidden><div id="dialog">Upload dialog remains mounted</div><input type="file" onchange="console.log('fixture:file-selected');document.querySelector('#details').hidden=false;document.querySelector('#video-link-new').hidden=false">
    <div id="details" hidden>
      <div id="title-textarea"><div id="textbox" contenteditable="true"></div></div>
      <div id="description-textarea"><div id="textbox" contenteditable="true"></div></div>
      <button name="VIDEO_MADE_FOR_KIDS_NOT_MFK" aria-checked="false" onclick="this.setAttribute('aria-checked','true');document.querySelector('[name=VIDEO_MADE_FOR_KIDS_MFK]').setAttribute('aria-checked','false');console.log('fixture:audience-no')">No, not made for kids</button>
      <button name="VIDEO_MADE_FOR_KIDS_MFK" aria-checked="false" onclick="this.setAttribute('aria-checked','true');document.querySelector('[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]').setAttribute('aria-checked','false');console.log('fixture:audience-yes')">Yes, made for kids</button>
      <button id="next-button" onclick="document.querySelector('#visibility').hidden=false;document.querySelector('#details').hidden=true">Next</button>
      ${detailsFixture(failure)}
    </div>
    <a id="video-link-new" href="https://youtube.com/shorts/${video}" hidden>Video link</a>
    <div id="visibility" hidden><div id="privacy-radios"><button name="PUBLIC" onclick="this.setAttribute('aria-checked','true')">Public</button><button name="PRIVATE" onclick="this.setAttribute('aria-checked','true')">Private</button></div>
      <button id="second-container-expand-button">Schedule</button>
      <button id="date-trigger" onclick="openPicker('calendar')">27 Oct 2030</button>
      <input id="time" aria-label="Time" value="00:00">
      <button id="zone-trigger" onclick="openPicker('zone')">Time zone</button>
      <p>Upload complete. Checks complete. No issues found.</p>
      <button id="done-button" onclick="if(!${immediate}&&(document.querySelector('#date-trigger').textContent!=='28 Oct 2030'||document.querySelector('#time').value!=='05:39'))throw new Error('Wrong schedule submitted');console.log('fixture:scheduled');document.querySelector('ytcp-uploads-dialog').hidden=true">${immediate ? "Save" : "Schedule"}</button>
    </div>
  </ytcp-uploads-dialog>
  <tp-yt-iron-overlay-backdrop id="scrim" opened class="opened" hidden></tp-yt-iron-overlay-backdrop>
  <tp-yt-paper-dialog id="zone" role="listbox" hidden><div role="option" aria-selected="true">${zone}</div></tp-yt-paper-dialog>
  <tp-yt-paper-dialog id="calendar" hidden><input aria-label="Date" value="27 Oct 2030" onkeydown="if(event.key==='Enter'){document.querySelector('#date-trigger').textContent=this.value;closePicker()}"></tp-yt-paper-dialog>
  <script>
    function closePicker(){for(const id of ['scrim','calendar','zone'])document.getElementById(id).hidden=true}
    function openPicker(id){closePicker();document.getElementById(id).hidden=false;document.getElementById('scrim').hidden=false}
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){console.log('fixture:escape');closePicker()}})
  </script>`;
}

test("a scheduling receipt requires the exact video, title, date and previously verified timezone",{skip:!chrome},async()=>{
  const page=await browser.newPage();
  try {
    await page.setContent(`<div role="dialog" aria-label="Video scheduled"><h2>Video scheduled</h2><p>Your video will be set to public on 28 October 2030 at 05:39</p><p>${title}</p><a href="https://youtube.com/shorts/${video}?feature=share">Video link</a></div>`);
    assert.equal((await confirmScheduleReceipt(page,video,title,at,330))?.ok,true);
    assert.equal((await confirmScheduleReceipt(page,"WRONGID1234",title,at,330))?.ok,false);
    assert.equal((await confirmScheduleReceipt(page,video,"Different title",at,330))?.ok,false);
    assert.equal((await confirmScheduleReceipt(page,video,title,new Date(at.getTime()+86400000),330))?.ok,false);
    assert.equal((await confirmScheduleReceipt(page,video,title,at,0))?.ok,false);
    assert.equal(await confirmScheduleReceipt(page,video,title,at),null);
  } finally {await page.close();}
});

for (const scenario of ["scheduled", "receipt-open", "receipt-saved-mismatch", "wrong-receipt", "wrong-confirmation", "unknown-zone", "resume-draft", "resume-child", "review-audience", "ai", "language", "location", "tags", "audience", "uncertain", "child-directed", "private", "private-language"] as const) {
  test(`production Studio flow: ${scenario}`, { skip: !chrome, timeout: 60000 }, async () => {
    const wrongConfirmation = scenario === "wrong-confirmation" || scenario === "wrong-receipt" || scenario === "receipt-saved-mismatch", unknownZone = scenario === "unknown-zone", resume = scenario.startsWith("resume-");
    const failure = scenario === "private-language" ? "language" : scenario;
    const immediate = scenario.startsWith("private");
    const settingsFailure = ["ai", "language", "location", "tags", "audience"].includes(failure);
    const reviewFailure = scenario === "uncertain" || scenario === "child-directed" || scenario === "resume-child";
    let reviewCalls = 0;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-studio-fixture-"));
    const file = path.join(directory, "synthetic.mp4");
    await fs.writeFile(file, "synthetic fixture; never sent to a platform");
    const events: string[] = [], checkpoints: string[] = [], logs: string[] = [], errors: string[] = [];
    const context = await browser.newContext({ timezoneId: "Asia/Kolkata" });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      assert.equal(url.hostname, "studio.youtube.com", "no account discovery or external services");
      assert.equal(route.request().method(), "GET", "no upload network requests");
      const saved = events.includes("fixture:scheduled");
      const html = url.pathname === `/video/${video}/edit`
        ? saved
          ? `<div id="title-textarea"><div id="textbox">${title}</div></div><ytcp-video-metadata-visibility>${immediate ? "Private" : `Scheduled 28 Oct 2030, ${wrongConfirmation ? "06:39" : "05:39"} (GMT+05:30)`}</ytcp-video-metadata-visibility>`
          : uploadFixture() + `<ytcp-video-metadata-visibility>Private</ytcp-video-metadata-visibility><script>document.querySelector('ytcp-uploads-dialog').hidden=false;document.querySelector('#details').hidden=false;document.querySelector('#title-textarea #textbox').textContent=${JSON.stringify(title)};document.querySelector('#description-textarea #textbox').textContent=${JSON.stringify(description)};${scenario === "resume-child" ? "document.querySelector('[name=VIDEO_MADE_FOR_KIDS_MFK]').setAttribute('aria-checked','true');" : ""}</script>`
        : uploadFixture(unknownZone ? "Unknown zone" : "(GMT+0530) Local Time", failure, immediate);
      const receipt = scenario === "receipt-open" || scenario === "wrong-receipt" || scenario === "receipt-saved-mismatch";
      const body = receipt && !route.request().url().includes(`/video/${video}/edit`) ? html.replace("document.querySelector('ytcp-uploads-dialog').hidden=true", "document.getElementById('receipt').hidden=false") +
        `<div id="receipt" role="dialog" aria-label="Video scheduled" hidden><h2>Video scheduled</h2><p>Your video will be set to public on 28 October 2030 at ${scenario === "wrong-receipt" ? "06:39" : "05:39"}</p><p>${title}</p><a href="https://youtube.com/shorts/${video}?feature=share">Video link</a></div>` : html;
      await route.fulfill({ contentType: "text/html", body });
    });
    const page = await context.newPage();
    page.on("console", message => { if (message.text().startsWith("fixture:")) events.push(message.text()); });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`https://studio.youtube.com/channel/${channel}`);
    const publisher = browserYouTubePublisher({
      env: { BOOKREEL_YOUTUBE_CHANNEL_ID: channel, BOOKREEL_PUBLISH_HEADLESS: "1" },
      options: { scheduledAt: immediate ? undefined : at, timezone: "Asia/Kolkata", visibility: immediate ? "private" : "public", confirmPublic: true, audienceMode: "review", ...(resume ? { resumeDraftId: video } : {}) },
      deps: { youtubeReview: async () => { reviewCalls++; if (reviewFailure) throw new NeedsHuman("ui", `Audience needs human review: ${scenario}`); return { tags: fixtureTags, reason: "The synthetic script addresses general audience daily habits." }; }, profileRoot: directory, jobTimeoutMs: 45000, locate: () => chrome!, launch: async () => context as unknown as ContextLike },
    });
    try {
      const prepared: PreparedPublish = { episodeId: "fixture-episode", platform: "youtube", video: { path: file, bytes: 48, contentType: "video/mp4", url: "/fixture.mp4" }, poster: null, metadata: { title, description, hashtags: [], hook: "" }, preparedAt: new Date(), status: "READY", handoff: [] };
      if (scenario === "audience") await page.locator('[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').evaluate(el => el.removeAttribute("onclick"));
      let persistedTags: string[] | undefined;
      const result = await publisher.publish(prepared,
        { onMetadata: async meta => { persistedTags = meta.tags; assert.ok(!events.includes("fixture:file-selected")); }, onLog: async line => { logs.push(line); }, onCheckpoint: async id => { checkpoints.push(id); } });
      assert.equal(events.filter(e => e === "fixture:file-selected").length, resume || reviewFailure ? 0 : 1, JSON.stringify(result) + logs.join("\n"));
      assert.equal(events.filter(e => e === "fixture:scheduled").length, unknownZone || settingsFailure || reviewFailure ? 0 : 1, JSON.stringify(result) + logs.join("\n"));
      if (!immediate && !settingsFailure && !reviewFailure) assert.ok(events.includes("fixture:escape"), "timezone dropdown was dismissed automatically");
      assert.deepEqual(errors, []);
      assert.ok(!events.includes("fixture:audience-yes"), "no automatic child-directed declaration");
      if (scenario === "resume-child") { assert.equal(reviewCalls, 0); assert.ok(!events.includes("fixture:audience-no")); }
      if (reviewFailure) { assert.deepEqual(checkpoints, []); assert.equal(persistedTags, undefined); }
      else { assert.deepEqual(persistedTags, fixtureTags); assert.ok(checkpoints.includes(video), "the Shorts draft ID was persisted before scheduling"); }
      assert.ok(!checkpoints.includes("WRONGID1234"));
      assert.equal(result.status, wrongConfirmation || unknownZone || settingsFailure || reviewFailure ? "AWAITING_HUMAN" : "PUBLISHED", JSON.stringify(result) + logs.join("\n"));
      if (settingsFailure && result.status === "AWAITING_HUMAN") {
        const expected = { ai: /AI disclosure/, language: /Video language/, location: /Video location/, tags: /Tags could not be verified/, audience: /audience.*choice did not take/ };
        assert.match(result.error, expected[failure as keyof typeof expected]);
      }
      if (!settingsFailure && !reviewFailure) {
        assert.ok(logs.some(line => line.includes('verified "Yes"')));
        assert.ok(logs.some(line => line.includes('verified "English"')));
        assert.ok(logs.some(line => line.includes('verified "Chennai"')));
        assert.ok(logs.some(line => line.includes("exact committed chips")));
        assert.ok(events.includes("fixture:audience-no"));
      }
      if (unknownZone) assert.ok(logs.some(line => line.includes("fields were left unchanged")));
      if (result.status === "PUBLISHED") {
        assert.equal(result.visibility, immediate ? "private" : "scheduled");
        assert.equal(result.externalId, video);
        if (!immediate) assert.equal(new Date(result.scheduledFor!).toISOString(), at.toISOString());
      }
    } finally { await context.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
}
