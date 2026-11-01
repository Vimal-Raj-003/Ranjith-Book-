/** Isolated full-page interaction test. All activation/publishing requests are intercepted. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {spawn,execFileSync} from "node:child_process";
import {chromium} from "playwright-core";
import sharp from "sharp";
import {PrismaClient} from "@prisma/client";

if(!process.env.BOOKREEL_TEST_DB_PID || !process.env.DATABASE_URL?.includes("/.bookreel/test/run-"))throw new Error("Run with --import ./tests/setup/isolated-db.mjs; never use the application database.");
const db=new PrismaClient(),artifacts=path.resolve(".bookreel/weekly-ui"),work=path.resolve(process.env.BOOKREEL_WORK_ROOT);
assert.ok(work.startsWith(path.resolve(".bookreel/test")+path.sep));
fs.mkdirSync(artifacts,{recursive:true});fs.mkdirSync(path.join(work,"renders"),{recursive:true});
const port=3015,base=`http://127.0.0.1:${port}`,checks=[];
let server,browser,page,logFd,fixtureView=null,bulkBody=null;
const errors=[];
try{
  const user=await db.user.create({data:{email:`fixture-${crypto.randomUUID()}@example.test`}});
  const book=await db.book.create({data:{title:"The Art of Attention",rightsStatus:"in-copyright",bookLink:"https://example.test/book"}});
  const upload=await db.upload.create({data:{bookId:book.id,userId:user.id,kind:"pdf",status:"DONE"}});
  const clip=path.join(work,"renders","fixture.mp4");
  execFileSync(path.resolve("tools/bin/ffmpeg.exe"),["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=0x25164c:s=180x320:d=45","-c:v","libx264","-pix_fmt","yuv420p","-y",clip],{windowsHide:true});
  const ids=[];
  for(let i=0;i<14;i++){
    const e=await db.episode.create({data:{bookId:book.id,uploadId:upload.id,userId:user.id,status:"DONE",title:`Attention, idea ${i+1}`,description:"A fixture idea from a book about attention.",hook:"Make room for one good idea.",cta:"Read one page today.",hashtags:'["#books"]',durationSec:45}});
    const render=path.join(work,"renders",`${e.id}.mp4`);fs.copyFileSync(clip,render);await db.episode.update({where:{id:e.id},data:{videoPath:render}});
    const dir=path.join(work,"thumbs",e.id);fs.mkdirSync(dir,{recursive:true});const thumbs=[];
    for(const aspect of ["9:16","16:9"])for(const variant of ["quote","bold","split"]){const key=`${aspect==="9:16"?"9x16":"16x9"}-${variant}`,file=path.join(dir,`${key}.jpg`),width=aspect==="9:16"?180:320,height=aspect==="9:16"?320:180;
      const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#16102d"/><rect x="8" y="8" width="${width-16}" height="${height-16}" fill="none" stroke="${variant==="quote"?"#00d9ff":variant==="bold"?"#ff2bd6":"#35f2a0"}" stroke-width="3"/><text x="18" y="55" fill="white" font-size="18">ATTENTION</text><text x="18" y="85" fill="#b5add5" font-size="14">Idea ${i+1}</text></svg>`);
      await sharp(svg).jpeg().toFile(file);thumbs.push({key,aspect,variant,path:file,width,height,rev:1});}
    await db.episode.update({where:{id:e.id},data:{thumbnails:JSON.stringify(thumbs)}});ids.push(e.id);
  }
  const token=crypto.randomBytes(32).toString("base64url");await db.session.create({data:{userId:user.id,tokenHash:crypto.createHash("sha256").update(token).digest("hex"),expiresAt:new Date(Date.now()+3600000)}});
  logFd=fs.openSync(path.join(artifacts,"server.log"),"w");
  server=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{cwd:process.cwd(),windowsHide:true,stdio:["ignore",logFd,logFd],env:{...process.env,BOOKREEL_SCHEDULE_WORKER_ENABLED:"0",BOOKREEL_INSTAGRAM_PUBLISH_ENABLED:"0",BOOKREEL_IG_NATIVE_SCHEDULE:"0",NEXT_TELEMETRY_DISABLED:"1"}});
  const deadline=Date.now()+120000;let ready=false;
  while(Date.now()<deadline){try{const r=await fetch(base,{signal:AbortSignal.timeout(1500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  assert.ok(ready,"isolated app started");
  browser=await chromium.launch({headless:true,channel:"chrome"});
  const context=await browser.newContext({viewport:{width:1364,height:1024}});
  await context.addCookies([{name:"bookreel_session",value:token,url:base,httpOnly:true,sameSite:"Lax"}]);
  page=await context.newPage();page.setDefaultTimeout(20000);page.on("pageerror",e=>errors.push(e.message));page.on("dialog",d=>d.accept());
  const intercepted=[];
  await context.route("**/*",route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.route("**/api/schedule-board**",async route=>{
    const url=new URL(route.request().url()),method=route.request().method(),pathname=url.pathname;
    if(method==="POST"&&/\/(activate|retry|resume|pause|cancel|bulk|confirm|start-now)$/.test(pathname)){
      intercepted.push(pathname);
      if(pathname.endsWith("/bulk"))bulkBody=JSON.parse(route.request().postData());
      if(pathname.endsWith("/activate")){
        const id=pathname.split("/").at(-2),r=await context.request.get(`${base}/api/schedule-board/${id}`),body=await r.json();fixtureView=body.schedule;fixtureView.status="ACTIVE";fixtureView.counts.jobs=2;fixtureView.counts.scheduledOnPlatform=2;
        fixtureView.slots=fixtureView.slots.map((s,i)=>({...s,status:s.creation?"ACTIVE":"SKIPPED",jobs:{youtube:s.creation?{id:`fixture-job-${i}`,platform:"youtube",status:"PLATFORM_SCHEDULED",error:null,remoteUrl:null,startAt:new Date().toISOString(),publishAt:s.scheduledAt,startedAt:new Date().toISOString(),lastAttemptAt:new Date().toISOString(),updatedAt:new Date().toISOString(),postedAt:null,attempts:1,nativeSchedule:true,platformStatus:"scheduled",platformPublishAt:s.scheduledAt}:null,instagram:null}}));
      }else if(fixtureView&&pathname.endsWith("/pause"))fixtureView.status="PAUSED";
      else if(fixtureView&&pathname.endsWith("/resume"))fixtureView.status="ACTIVE";
      else if(fixtureView&&pathname.endsWith("/cancel"))fixtureView.status="CANCELLED";
      await route.fulfill({json:{schedule:fixtureView,stillScheduled:2,items:[],started:0,skipped:0,rejected:0}});return;
    }
    if(method==="GET"&&fixtureView&&pathname===`/api/schedule-board/${fixtureView.id}`){await route.fulfill({json:{schedule:fixtureView}});return;}
    if(method==="GET"&&fixtureView&&pathname==="/api/schedule-board"){const response=await context.request.get(`${base}/api/schedule-board`),body=await response.json();body.schedules=body.schedules.map(s=>s.id===fixtureView.id?{...s,status:fixtureView.status}:s);await route.fulfill({json:body});return;}
    await route.continue();
  });
  await page.goto(`${base}/schedule`,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Weekly schedule",exact:true}).waitFor();
  await page.locator("[data-video]").first().waitFor();
  assert.notEqual(await page.evaluate(()=>getComputedStyle(document.documentElement).overflowY),"hidden","desktop page supports normal scrolling");
  await page.mouse.wheel(0,400);await page.waitForFunction(()=>scrollY>0);await page.evaluate(()=>scrollTo(0,0));checks.push("desktop page scrolls independently of the studio shell");
  await page.locator("[data-video]").first().waitFor();assert.equal(await page.locator("[data-video]").count(),12);checks.push("gallery pagination: 12 of 14 videos");
  await page.locator(`[data-video="${ids[12]}"] input[type=checkbox]`).check();await page.locator(`[data-video="${ids[13]}"] input[type=checkbox]`).check();
  await page.getByLabel("Name",{exact:true}).fill("Fixture weekly journey");await page.getByLabel("Days",{exact:true}).fill("2");await page.getByLabel("Seed (optional)",{exact:true}).fill("37");await page.getByLabel("YouTube audience",{exact:true}).selectOption("no");
  await page.getByRole("button",{name:"First day (IST)",exact:true}).click();await page.getByRole("dialog",{name:"First day (IST)"}).waitFor();await page.screenshot({path:path.join(artifacts,"date-picker.png")});await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(),0);checks.push("calendar dialog opens and Escape restores the page");
  const futureDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()+3*86400000));
  await page.getByRole("button",{name:"First day (IST)",exact:true}).click();await page.locator(`[data-date="${futureDate}"]`).click();
  await page.getByRole("button",{name:"Slot 1 start",exact:true}).click();await page.getByRole("dialog",{name:"Slot 1 start"}).waitFor();await page.getByRole("button",{name:/^Use time/}).click();checks.push("time dialog applies its selected 24-hour value");
  await page.getByRole("button",{name:"Draw the week",exact:true}).click();await page.getByText("Fixture weekly journey",{exact:true}).waitFor();
  let plan=await db.weeklySchedule.findFirstOrThrow({where:{userId:user.id}}),slots=await db.scheduleSlot.findMany({where:{scheduleId:plan.id,platform:"youtube"},orderBy:{position:"asc"}});
  assert.equal(slots.length,6);assert.deepEqual(slots.slice(0,2).map(s=>s.episodeId),[ids[12],ids[13]]);assert.equal(await db.publishJob.count(),0);checks.push("Draw persists selection order and all empty cells without creating publishing jobs");
  await page.getByRole("combobox",{name:"Video",exact:true}).first().selectOption(ids[13]);
  await page.waitForResponse(r=>r.request().method()==="GET"&&r.url().endsWith(`/api/schedule-board/${plan.id}`));
  slots=await db.scheduleSlot.findMany({where:{scheduleId:plan.id,platform:"youtube"},orderBy:{position:"asc"}});assert.deepEqual(slots.slice(0,2).map(s=>s.episodeId),[ids[13],ids[12]]);checks.push("video dropdown swaps saved slots");
  await page.getByRole("button",{name:"Time",exact:true}).first().click();await page.getByRole("button",{name:"Set minute to 15",exact:true}).click();await page.getByRole("button",{name:/^Use time/}).click();
  await Promise.all([page.waitForResponse(r=>r.request().method()==="GET"&&r.url().endsWith(`/api/schedule-board/${plan.id}`)),page.getByRole("button",{name:"Save time",exact:true}).click()]);
  const moved=await db.scheduleSlot.findFirstOrThrow({where:{scheduleId:plan.id,platform:"youtube",position:0}});assert.equal(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(moved.assignedAt),"05:15");checks.push("calendar selection and Save time persist exact IST instants");
  await page.getByLabel("Seed",{exact:true}).fill("38");await Promise.all([page.waitForResponse(r=>r.request().method()==="GET"&&r.url().endsWith(`/api/schedule-board/${plan.id}`)),page.getByRole("button",{name:"Draw the times again",exact:true}).click()]);
  assert.equal((await db.weeklySchedule.findUniqueOrThrow({where:{id:plan.id}})).seed,38);assert.deepEqual((await db.scheduleSlot.findMany({where:{scheduleId:plan.id,platform:"youtube"},orderBy:{position:"asc"},take:2})).map(s=>s.episodeId),[ids[13],ids[12]]);checks.push("confirmed redraw changes times while preserving video order");
  await page.getByLabel("Saved YouTube audience").selectOption("yes");await page.getByRole("button",{name:"Save settings",exact:true}).click();
  await page.waitForResponse(r=>r.request().method()==="GET"&&r.url().endsWith(`/api/schedule-board/${plan.id}`));assert.equal((await db.weeklySchedule.findUniqueOrThrow({where:{id:plan.id}})).madeForKids,true);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(artifacts,"desktop-draft.png"),fullPage:true});
  await page.getByRole("button",{name:"Preview",exact:true}).first().click();await page.locator("video").first().waitFor();checks.push("generated video preview opens");
  await page.getByRole("button",{name:"History",exact:true}).first().click();await page.getByText("No attempt history has been recorded yet.",{exact:false}).waitFor();checks.push("history distinguishes missing records from confirmed outcomes");
  await page.getByRole("button",{name:"Publish Selected Videos",exact:true}).click();await page.getByRole("dialog").waitFor();await page.getByRole("radio",{name:"YouTube and Instagram",exact:true}).click();assert.equal(await page.getByRole("radio",{name:"Instagram (disabled)",exact:true}).isDisabled(),true);
  assert.equal(await page.locator("[data-confirm]").isDisabled(),true);await page.getByLabel("Publishing audience").selectOption("no");assert.equal(await page.getByRole("button",{name:"Publish now",exact:true}).isEnabled(),true);await page.screenshot({path:path.join(artifacts,"publish-dialog.png")});await page.getByRole("button",{name:"Cancel",exact:true}).click();checks.push("bulk dialog separates draft scheduling, immediate publishing, audience and disabled Instagram");
  await page.reload({waitUntil:"domcontentloaded"});await page.getByText("Fixture weekly journey",{exact:true}).waitFor();await page.getByText("Selected: 2 videos",{exact:true}).first().waitFor();checks.push("saved draft and ordered selection survive reload");
  await page.getByRole("button",{name:"New schedule",exact:true}).click();assert.equal(await page.getByLabel("Name",{exact:true}).first().inputValue(),"Fixture weekly journey");await page.getByRole("button",{name:"Close",exact:true}).click();checks.push("new-form configuration survives reopening");
  await page.getByRole("button",{name:"Publish Selected Videos",exact:true}).click();await page.getByRole("radio",{name:"YouTube",exact:true}).click();await page.getByLabel("Publishing audience").selectOption("no");await page.getByRole("button",{name:"Publish now",exact:true}).click();await page.getByRole("dialog").waitFor({state:"hidden"});assert.equal(bulkBody.publishNow,true);assert.equal(bulkBody.confirmed,true);assert.equal(bulkBody.madeForKids,false);assert.equal(bulkBody.engines.youtube,"browser");assert.equal(await db.publishJob.count(),0);checks.push("Publish now submits reviewed settings through mocked transport only");
  page.removeAllListeners("dialog");page.once("dialog",d=>d.dismiss());await page.getByRole("button",{name:"Activate",exact:true}).click();assert.ok(!intercepted.some(p=>p.endsWith("/activate")));page.on("dialog",d=>d.accept());checks.push("cancelling the activation confirmation sends no request");
  await page.getByRole("button",{name:"Activate",exact:true}).click();await page.locator('[data-job-status="PLATFORM_SCHEDULED"]').first().waitFor();assert.equal(await db.publishJob.count(),0,"activation was intercepted; the actual database still has no uploads");
  await page.screenshot({path:path.join(artifacts,"desktop-active-fixture.png"),fullPage:true});await page.getByRole("button",{name:"Pause",exact:true}).first().click();await page.getByRole("button",{name:"Resume",exact:true}).first().waitFor();await page.getByRole("button",{name:"Resume",exact:true}).first().click();checks.push("activation confirmation, confirmed-status rendering and pause/resume use mocked transport only");
  fixtureView=null;await page.setViewportSize({width:390,height:844});await page.goto(`${base}/schedule`,{waitUntil:"domcontentloaded"});await page.getByText("Fixture weekly journey",{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"no mobile horizontal overflow");await page.screenshot({path:path.join(artifacts,"mobile-draft.png"),fullPage:true});await page.screenshot({path:path.join(artifacts,"mobile-viewport.png")});checks.push("390px mobile layout has no horizontal overflow");
  assert.deepEqual(errors,[]);assert.ok(intercepted.some(p=>p.endsWith("/activate")));assert.equal(await db.publishJob.count(),0);assert.equal((await db.weeklySchedule.findUniqueOrThrow({where:{id:plan.id}})).status,"draft");
  fs.writeFileSync(path.join(artifacts,"results.json"),JSON.stringify({passed:true,checks,publishingRequestsIntercepted:intercepted.length,realUploads:0,realScheduleActivations:0},null,2));console.log(JSON.stringify({passed:true,checks,artifacts},null,2));
}catch(error){
  if(page){await page.screenshot({path:path.join(artifacts,"failure.png"),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(artifacts,"failure.txt"),await page.locator("body").innerText().catch(()=>"Page unavailable"));}throw error;
}finally{
  await browser?.close();
  if(server?.pid){try{if(process.platform==="win32")execFileSync("taskkill",["/PID",String(server.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else server.kill("SIGTERM");}catch{}}
  if(logFd!==undefined)fs.closeSync(logFd);await db.$disconnect();
}
