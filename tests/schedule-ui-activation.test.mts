import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { locateChromium } from "../src/lib/publish/browser/engine";
import type { JobView, ScheduleView } from "../src/lib/schedule/board-types";
import { batchCompletion } from "../src/lib/schedule/board-completion";

// Mount the actual client component with intercepted GET fixtures. No server,
// database, session, schedule creation or activation is involved.
let browser: Browser;
let script: string;
test.before(async () => {
  script = (await build({ stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import ScheduleBoard from "./src/components/schedule/ScheduleBoard"; createRoot(document.getElementById("root")).render(<ScheduleBoard/>);', loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env": "{}" } })).outputFiles[0].text;
  browser = await chromium.launch({ executablePath: locateChromium() ?? undefined });
});
test.after(async () => { await browser?.close(); });

for (const scenario of ["valid-null-audience", "validation-error", "conflict", "empty", "completion", "failed-completion", "uncertain-completion", "mixed-completion"] as const) {
  test(`Weekly Schedule UI: ${scenario}`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    if(scenario==="failed-completion")await context.addInitScript(()=>localStorage.setItem("bookreel.completed-schedules-hidden",JSON.stringify(["fixture-draft"])));
    const mutations: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const creation = { id: "fixture-video", title: "Fixture video", owner: "", repo: "Fixture book", format: "vertical", hasPlatformCopy: true, hasThumbnail: true };
    const view = { id: "fixture-draft", name: "Fixture draft", status: "DRAFT", timezone: "Asia/Kolkata", startDate: "2030-10-28", days: 1, windows: [{start:"05:00",end:"06:00"},{start:"13:00",end:"14:00"},{start:"21:00",end:"23:30"}], endInclusive: false, seed: 73, leadMinutes: 20, instagramOffsetMinutes: 0, youtubePrivacy: "public", youtubeChannel: "@fixture", youtubeNative: true, minGapMinutes: 30, missGraceMinutes: 45, activatedAt: null, madeForKids: null, instagramEnabled: false, workerEnabled: false, workflowVersion: 2, candidates: [creation], unavailable: [], releasable: 0, profiles: { youtube: true, instagram: false }, counts: { slots: 1, withVideo: scenario === "empty" ? 0 : 1, jobs: 0, posted: 0, scheduledOnPlatform: 0, failed: 0, waiting: 0 }, issues: scenario === "validation-error" ? [{key:"fixture-slot",severity:"error",message:"The publishing time is too close."}] : [], slots: [{id:"fixture-slot",day:0,position:1,localDate:"2030-10-28",localTime:"05:30",scheduledAt:"2030-10-28T00:00:00Z",status:"PLANNED",creation:scenario === "empty" ? null : creation,jobs:{youtube:null,instagram:null},issues:[],conflicts:scenario === "conflict" ? [{platform:"youtube",kind:"needs-review",message:"An existing upload needs review.",jobId:"prior-upload",releasable:false}] : []}] };
    const live=view as unknown as ScheduleView;
    if(scenario.includes("completion")){
      live.status="ACTIVE";live.instagramEnabled=true;live.slots[0].status="ACTIVE";
      const queued=(platform:string):JobView=>({id:platform,platform,status:"SCHEDULED",confirmation:null,error:null,remoteUrl:null,startAt:null,publishAt:live.slots[0].scheduledAt,startedAt:null,lastAttemptAt:null,updatedAt:new Date().toISOString(),postedAt:null,attempts:1,nativeSchedule:true,platformStatus:null,platformPublishAt:null});
      live.slots[0].jobs={youtube:queued("youtube"),instagram:queued("instagram")};
      if(scenario==="failed-completion"){
        live.slots[0].jobs.youtube={...queued("youtube"),status:"FAILED",error:"YouTube upload failed"};
        live.slots[0].jobs.instagram={...queued("instagram"),status:"AWAITING_HUMAN",error:"Instagram requires review"};
      }
      if(scenario==="uncertain-completion"){
        for(const platform of ["youtube","instagram"] as const)live.slots[0].jobs[platform]={...queued(platform),status:"PLATFORM_SCHEDULED",platformPublishAt:live.slots[0].scheduledAt,error:"Platform confirmation was not verified"};
      }
      if(scenario==="mixed-completion"){
        live.slots.push({...live.slots[0],id:"pending-slot",position:2,creation:{...creation,id:"pending-video"},jobs:{youtube:queued("pending-youtube"),instagram:queued("pending-instagram")}});
        for(const platform of ["youtube","instagram"] as const)live.slots[0].jobs[platform]={...queued(platform),status:"PLATFORM_SCHEDULED",confirmation:"scheduled",platformPublishAt:live.slots[0].scheduledAt,error:"Outdated processing message"};
      }
    }
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "GET") { mutations.push(request.method()+" "+url.pathname); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({contentType:"text/html",body:'<div id="root"></div>'});
      if (url.pathname === "/api/schedule-board") {
        const counts=batchCompletion(live.slots),completed=counts.totalVideos>0&&counts.completedVideos===counts.totalVideos;
        return route.fulfill({json:{schedules:[{id:view.id,name:view.name,status:live.status,startDate:view.startDate,days:1,slots:live.slots.length,withVideo:counts.totalVideos,completed,completedAt:completed?"2030-10-27T08:00:00Z":null,timezone:"Asia/Kolkata"}]}});
      }
      if (url.pathname === "/api/schedule-board/fixture-draft") return route.fulfill({json:{schedule:view}});
      if (url.pathname === "/api/schedule-board/videos") return route.fulfill({json:{items:[],total:0,page:1,pageSize:12,pages:1,selectableIds:[],engines:{youtube:{api:false,account:"@fixture"},instagram:{api:false,account:"@fixture"}}}});
      return route.abort();
    });
    try {
      await page.goto("http://schedule-fixture.test/");
      await page.addScriptTag({content:script});
      if(["failed-completion","uncertain-completion","mixed-completion"].includes(scenario)){
        await page.locator('[data-slot="fixture-slot"]').waitFor();
        assert.equal(await page.locator('[data-batch-completed]').count(),0);
        assert.equal(await page.getByRole('button',{name:'Done',exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'Cancel schedule',exact:true}).isVisible(),true);
        assert.equal(await page.locator('[data-schedule-retry]').isVisible(),true);
        if(scenario==="mixed-completion"){
          const done=page.locator('[data-slot="fixture-slot"]');
          assert.equal(await done.locator('[data-video-completion="completed"]').count(),1);
          assert.equal(await done.getByRole('button',{name:'Cancel',exact:true}).count(),0);
          assert.equal(await done.locator('[data-job-note]').count(),0);
          assert.equal(await page.locator('[data-slot="pending-slot"]').getByRole('button',{name:'Cancel',exact:true}).isVisible(),true);
          assert.match(await page.locator('[data-counts]').innerText(),/2 total videos.*1 fully completed.*1 pending\/failed.*2 confirmed scheduled posts/);
        }else{
          assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isVisible(),true);
          assert.equal(await page.locator('[data-video-completion="completed"]').count(),0);
          assert.equal(await page.locator('[data-job-note]').count(),2);
          if(scenario==="failed-completion"){
            assert.equal(await page.locator('[data-platform-retry="youtube"]').isEnabled(),true);
            assert.match(await page.locator('[data-slot]').innerText(),/YouTube[\s\S]*FAILED[\s\S]*YouTube upload failed/);
            assert.match(await page.locator('[data-slot]').innerText(),/Instagram[\s\S]*AWAITING_HUMAN[\s\S]*Instagram requires review/);
          }else assert.equal(await page.getByText('Confirmation needed',{exact:true}).count(),2);
        }
        assert.deepEqual(mutations,[]);assert.deepEqual(errors,[]);return;
      }
      if(scenario==="completion"){
        await page.locator('[data-video-completion="pending"]').waitFor();
        assert.equal(await page.locator('[data-batch-completed]').count(),0);
        assert.equal(await page.getByRole('button',{name:'Cancel schedule',exact:true}).isVisible(),true);
        assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isVisible(),true);
        assert.match(await page.locator('[data-counts]').innerText(),/1 total videos.*0 fully completed.*1 pending\/failed.*0 confirmed scheduled posts/);
        live.slots[0].jobs.youtube={...live.slots[0].jobs.youtube!,status:"PLATFORM_SCHEDULED",confirmation:"scheduled",platformStatus:"scheduled",platformPublishAt:live.slots[0].scheduledAt,error:"Reading the saved video status"};
        await page.getByText('PARTIALLY COMPLETED – Instagram Pending',{exact:true}).waitFor({timeout:5000});
        assert.match(await page.locator('[data-counts]').innerText(),/1 partially completed.*0 pending\/failed.*1 confirmed scheduled posts/);
        assert.equal(await page.getByRole('button',{name:'Cancel schedule',exact:true}).isVisible(),true);
        assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isVisible(),true);
        live.slots[0].jobs.instagram={...live.slots[0].jobs.instagram!,status:"FAILED",error:"Instagram date verification failed"};
        await page.getByText('Instagram – FAILED: Instagram date verification failed',{exact:true}).waitFor({timeout:5000});
        await page.locator('[data-platform="instagram"]').getByRole('button',{name:'Details',exact:true}).click();
        live.slots[0].jobs.instagram={...live.slots[0].jobs.instagram!,status:"PLATFORM_SCHEDULED",confirmation:"scheduled",error:"Pressing Schedule",platformStatus:"scheduled",platformPublishAt:live.slots[0].scheduledAt};
        await page.locator('[data-video-completion="completed"]').waitFor({timeout:5000});
        assert.match(await page.locator('[data-counts]').innerText(),/1 fully completed.*0 partially completed.*0 pending\/failed.*2 confirmed scheduled posts/);
        assert.doesNotMatch(await page.locator('[data-counts]').innerText(),/posted/);
        assert.equal(await page.locator('[data-slot]').count(),1);
        assert.equal(await page.locator('[data-batch-completed]').isVisible(),true);
        assert.equal(await page.getByRole('button',{name:'Cancel schedule',exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'Pause',exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'Retry',exact:true}).count(),0);
        assert.equal(await page.locator('[data-job-note]').count(),0);
        assert.equal(await page.locator('[data-slot] pre').count(),0);
        assert.doesNotMatch(await page.locator('[data-slot]').innerText(),/Pressing Schedule|Reading the saved video status|Instagram date verification failed/);
        assert.match(await page.locator('[data-platform="youtube"]').innerText(),/YouTube publishes it.*28 Oct.*05:30 IST/);
        assert.match(await page.locator('[data-platform="instagram"]').innerText(),/Instagram publishes it.*28 Oct.*05:30 IST/);
        await page.getByRole('button',{name:'Done',exact:true}).click();
        assert.equal(await page.locator('[data-slot]').count(),0,"Done hides the entire completed table");
        assert.equal(await page.getByRole('region',{name:'Schedule summary'}).count(),0);
        assert.equal(await page.getByRole('combobox',{name:'Schedule',exact:true}).locator('option[value="fixture-draft"]').count(),0);
        await page.getByRole('button',{name:'Library',exact:true}).click();
        const entry=page.locator('[data-completed-history]').getByRole('button',{name:/Fixture draft/});await entry.waitFor();
        assert.match(await entry.innerText(),/1 day.*1 video.*27 Oct 2030.*13:30 IST/);
        await entry.click();
        await page.locator('[data-history-details="true"] [data-slot]').waitFor();
        assert.equal(await page.locator('[data-history-details]').getAttribute('disabled'),'');
        assert.equal(await page.getByRole('button',{name:'Done',exact:true}).count(),0);
        assert.match(await page.locator('[data-history-details]').innerText(),/Fixture video/);
        assert.match(await page.locator('[data-platform="youtube"]').innerText(),/Scheduled on YouTube[\s\S]*YouTube publishes it.*28 Oct.*05:30 IST/);
        assert.match(await page.locator('[data-platform="instagram"]').innerText(),/Scheduled on Instagram[\s\S]*Instagram publishes it.*28 Oct.*05:30 IST/);
        await page.getByRole('button',{name:'Back to Library',exact:true}).click();
        await page.locator('[data-completed-history]').waitFor();
        await page.reload();await page.addScriptTag({content:script});
        await page.getByRole('combobox',{name:'Schedule',exact:true}).getByText('No active schedules',{exact:true}).waitFor({state:'attached'});
        assert.equal(await page.locator('[data-slot]').count(),0,"Done remains hidden after reload");
        await page.getByRole('button',{name:'Library',exact:true}).click();
        await page.locator('[data-completed-history]').getByRole('button',{name:/Fixture draft/}).waitFor();
        await page.locator('[data-completed-history]').getByRole('button',{name:/Fixture draft/}).click();
        await page.locator('[data-history-details]').waitFor();
        await page.getByRole('button',{name:'New schedule',exact:true}).click();
        await page.getByRole('button',{name:'Draw the week',exact:true}).waitFor();
        assert.equal(await page.locator('[data-history-details]').count(),0,"New schedule leaves read-only history");
        assert.deepEqual(mutations,[]);assert.deepEqual(errors,[]);return;
      }
      const activate = page.getByRole("button",{name:"Activate",exact:true});
      await activate.waitFor();
      assert.equal(await page.getByRole('button',{name:'Done',exact:true}).count(),0);
      assert.equal(await page.locator('[data-batch-completed]').count(),0,"empty or draft schedules are not completed");
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
