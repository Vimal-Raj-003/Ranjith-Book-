import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { locateChromium } from "../src/lib/publish/browser/engine";

// Mount the actual client component with intercepted GET fixtures. No server,
// database, session, schedule creation or activation is involved.
let browser: Browser;
let script: string;
test.before(async () => {
  script = (await build({ stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import ScheduleBoard from "./src/components/schedule/ScheduleBoard"; createRoot(document.getElementById("root")).render(<ScheduleBoard/>);', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env": "{}" } })).outputFiles[0].text;
  browser = await chromium.launch({ executablePath: locateChromium() ?? undefined });
});
test.after(async () => { await browser?.close(); });

for (const scenario of ["valid-null-audience", "validation-error", "conflict", "empty"] as const) {
  test(`Weekly Schedule UI: ${scenario}`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const mutations: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const creation = { id: "fixture-video", title: "Fixture video", owner: "", repo: "Fixture book", format: "vertical", hasPlatformCopy: true, hasThumbnail: true };
    const view = { id: "fixture-draft", name: "Fixture draft", status: "DRAFT", timezone: "Asia/Kolkata", startDate: "2030-10-28", days: 1, windows: [{start:"05:00",end:"06:00"},{start:"13:00",end:"14:00"},{start:"21:00",end:"23:30"}], endInclusive: false, seed: 73, leadMinutes: 20, instagramOffsetMinutes: 0, youtubePrivacy: "public", youtubeChannel: "@fixture", youtubeNative: true, minGapMinutes: 30, missGraceMinutes: 45, activatedAt: null, madeForKids: null, instagramEnabled: false, workerEnabled: false, workflowVersion: 2, candidates: [creation], unavailable: [], releasable: 0, profiles: { youtube: true, instagram: false }, counts: { slots: 1, withVideo: scenario === "empty" ? 0 : 1, jobs: 0, posted: 0, scheduledOnPlatform: 0, failed: 0, waiting: 0 }, issues: scenario === "validation-error" ? [{key:"fixture-slot",severity:"error",message:"The publishing time is too close."}] : [], slots: [{id:"fixture-slot",day:0,position:1,localDate:"2030-10-28",localTime:"05:30",scheduledAt:"2030-10-28T00:00:00Z",status:"PLANNED",creation:scenario === "empty" ? null : creation,jobs:{youtube:null,instagram:null},issues:[],conflicts:scenario === "conflict" ? [{platform:"youtube",kind:"needs-review",message:"An existing upload needs review.",jobId:"prior-upload",releasable:false}] : []}] };
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "GET") { mutations.push(request.method()+" "+url.pathname); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({contentType:"text/html",body:'<div id="root"></div>'});
      if (url.pathname === "/api/schedule-board") return route.fulfill({json:{schedules:[{id:view.id,name:view.name,status:"DRAFT",startDate:view.startDate,days:1,slots:1,withVideo:view.counts.withVideo}]}});
      if (url.pathname === "/api/schedule-board/fixture-draft") return route.fulfill({json:{schedule:view}});
      if (url.pathname === "/api/schedule-board/videos") return route.fulfill({json:{items:[],total:0,page:1,pageSize:12,pages:1,selectableIds:[],engines:{youtube:{api:false,account:"@fixture"},instagram:{api:false,account:"@fixture"}}}});
      return route.abort();
    });
    try {
      await page.goto("http://schedule-fixture.test/");
      await page.addScriptTag({content:script});
      const activate = page.getByRole("button",{name:"Activate",exact:true});
      await activate.waitFor();
      assert.equal(await activate.isDisabled(), scenario !== "valid-null-audience");
      assert.equal(await page.getByText("YouTube audience",{exact:true}).count(),0);
      assert.equal(await page.getByRole("combobox",{name:/YouTube audience/i}).count(),0);
      await page.getByRole("button",{name:"New schedule",exact:true}).click();
      await page.getByRole("button",{name:"Draw the week",exact:true}).waitFor();
      assert.equal(await page.getByText("YouTube audience",{exact:true}).count(),0);
      assert.equal(await page.getByRole("combobox",{name:/YouTube audience/i}).count(),0);
      assert.deepEqual(mutations,[]);
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  });
}
