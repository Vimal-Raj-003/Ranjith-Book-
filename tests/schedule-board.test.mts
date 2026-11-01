import test,{after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID,randomBytes} from "node:crypto";
import {prisma} from "../src/lib/db";
import {RENDER_DIR} from "../src/lib/paths";
import {serializeThumbnails,type ThumbSpec} from "../src/lib/thumbnails";
import {thumbsDir,THUMB_KEYS} from "../src/lib/thumbnails/types";
import {browserPublisherFor} from "../src/lib/publish/registry";
import type {BrowserPublisher,BrowserPublishOptions} from "../src/lib/publish/browser/engine";
import {createBoardPlan,updateBoardSettings,redrawBoard,editBoardSlot,boardAction,boardSlotAction} from "../src/lib/schedule/board-store";
import {boardView,generatedVideos,listBoardPlans} from "../src/lib/schedule/board-read";
import {bulkPublish,jobAction,retryBoardPlan} from "../src/lib/schedule/board-publish";
import {scheduleRetryCandidate} from "../src/lib/schedule/board-retry";
import {isSqliteLockError} from "../src/lib/publish/browser/run";
import {STUDIO_REVIEW_TIMEOUT_MS} from "../src/lib/publish/browser/youtube-review";
import {processScheduleQueue} from "../src/lib/schedule/worker";
import {runSchedule} from "../src/lib/schedule/activate";
import {addDays,todayIn,DEFAULT_TIMEZONE} from "../src/lib/schedule/reference-time";
import {toggle,parseStored,schedulePlanFor,planFor} from "../src/lib/schedule/video-selection";
import {requireIsolation} from "./setup/isolation";
import {createSession} from "../src/lib/publish/youtube/upload";
import {storeGrant} from "../src/lib/publish/youtube/accounts";
import {YOUTUBE_SCOPES} from "../src/lib/publish/youtube/config";

process.env.BOOKREEL_INSTAGRAM_PUBLISH_ENABLED="0";
process.env.BOOKREEL_SCHEDULE_WORKER_ENABLED="0";
const day=()=>addDays(todayIn(DEFAULT_TIMEZONE),4);
after(()=>prisma.$disconnect());
async function fixture(n=3){
  requireIsolation("weekly page tests use only their isolated database and fixture files");
  const user=await prisma.user.create({data:{email:`board-${randomUUID()}@example.test`}});
  const book=await prisma.book.create({data:{title:"Fixture Book",rightsStatus:"in-copyright",bookLink:"https://example.test/book"}});
  const uploads=await Promise.all([0,1].map(()=>prisma.upload.create({data:{userId:user.id,bookId:book.id,status:"DONE",kind:"pdf"}})));
  const ids:string[]=[];
  for(let i=0;i<n;i++){
    const e=await prisma.episode.create({data:{userId:user.id,bookId:book.id,uploadId:uploads[i%2].id,status:"DONE",title:`Fixture video ${i+1}`,description:"A book's idea about attention.",hook:"Read one page.",cta:"Follow for another idea.",hashtags:'["#books"]',durationSec:45}});
    const dir=thumbsDir(e.id);await fs.mkdir(dir,{recursive:true});await fs.mkdir(RENDER_DIR,{recursive:true});
    const thumbs:ThumbSpec[]=THUMB_KEYS.map(key=>({key,aspect:key.startsWith("9x16")?"9:16":"16:9",variant:key.split("-")[1] as ThumbSpec["variant"],path:path.join(dir,`${key}.jpg`),width:1080,height:1920,rev:1}));
    for(const t of thumbs)await fs.writeFile(t.path,"fixture poster");const video=path.join(RENDER_DIR,`${e.id}.mp4`);await fs.writeFile(video,Buffer.alloc(9000));
    await prisma.episode.update({where:{id:e.id},data:{videoPath:video,thumbnails:serializeThumbnails(thumbs)}});ids.push(e.id);
  }
  return {userId:user.id,ids};
}
function publisher(answer?:"failed"|"human"){
  const calls:{id:string;platform:string;options:BrowserPublishOptions}[]=[];
  const makePublisher=(platform:never,options:BrowserPublishOptions):BrowserPublisher=>{
    const real=browserPublisherFor(platform,{browser:{deps:{locate:()=>"fixture-browser"}}}) as BrowserPublisher;
    return {...real,publish:async prepared=>{calls.push({id:prepared.episodeId,platform,options});
      if(answer==="failed")return {status:"FAILED",error:"Fixture transient failure"};
      if(answer==="human")return {status:"AWAITING_HUMAN",error:"Fixture asks for review"};
      return {status:"PUBLISHED",externalId:`fixture-${prepared.episodeId}`,externalUrl:"https://example.test/video",confirmedAt:new Date(),visibility:options.scheduledAt?"scheduled":options.visibility??"private",scheduledFor:options.scheduledAt??undefined};}};
  };
  return {calls,options:{makePublisher:makePublisher as never,waitForCompletion:true,env:{BOOKREEL_INSTAGRAM_PUBLISH_ENABLED:"0"}}};
}
const draw=(f:Awaited<ReturnType<typeof fixture>>,extra:Record<string,unknown>={})=>createBoardPlan(f.userId,{startDate:day(),days:2,seed:73,creationIds:f.ids,madeForKids:false,...extra});

test("activation freezes voiceover and visual script evidence for browser audience review",async()=>{
  const f=await fixture(1),p=publisher();
  const voScript="A synthetic adult workplace script for audience review.";
  const script=JSON.stringify([{narration:voScript,visual:"Book pages and workplace notes"}]);
  await prisma.episode.update({where:{id:f.ids[0]},data:{voScript,script}});
  const d=await draw(f,{madeForKids:null});
  await boardAction(f.userId,d.id,"activate",{},p.options);
  assert.equal(p.calls.length,1,"only the mocked publisher may execute");
  const slot=await prisma.scheduleSlot.findFirstOrThrow({where:{scheduleId:d.id,platform:"youtube",episodeId:f.ids[0]}});
  const frozen=JSON.parse(slot.payloadJson!);
  assert.equal(frozen.sourceText,voScript+"\n\n"+script);
  const browser=browserPublisherFor("youtube",{browser:{deps:{locate:()=>"fixture-browser"}}}) as BrowserPublisher;
  assert.equal((await browser.prepare(frozen)).sourceText,frozen.sourceText);
  await prisma.episode.update({where:{id:f.ids[0]},data:{voScript:"A later edit"}});
  assert.equal(JSON.parse((await prisma.scheduleSlot.findUniqueOrThrow({where:{id:slot.id}})).payloadJson!).sourceText,frozen.sourceText);
});

test("legacy explicit-audience activation preserves API scheduling and duplicate protection",async()=>{
  const f=await fixture(2), draft=await draw(f);
  const first=await prisma.episode.findUniqueOrThrow({where:{id:f.ids[0]}});
  await prisma.episode.updateMany({where:{id:{in:f.ids}},data:{uploadId:first.uploadId}});
  await prisma.weeklySchedule.update({where:{id:draft.id},data:{boardGrid:false,uploadId:first.uploadId!}});
  const env={GOOGLE_CLIENT_ID:"fixture-client",GOOGLE_CLIENT_SECRET:"fixture-secret",GOOGLE_OAUTH_REDIRECT_URI:"http://localhost:3001/api/publish/youtube/callback",BOOKREEL_TOKEN_KEY:randomBytes(32).toString("base64"),BOOKREEL_YOUTUBE_CHANNEL_ID:"UCfixture1234567890123456",BOOKREEL_INSTAGRAM_PUBLISH_ENABLED:"0"};
  await storeGrant(f.userId,{accessToken:"fixture-access",refreshToken:"fixture-refresh",expiresAt:new Date(Date.now()+3600000),scope:YOUTUBE_SCOPES.join(" ")},env);
  await prisma.platformAccount.update({where:{userId_provider:{userId:f.userId,provider:"youtube"}},data:{externalAccountId:env.BOOKREEL_YOUTUBE_CHANNEL_ID,externalAccountName:"@betweenpages08-l4d"}});
  const uploads:{privacyStatus:string;publishAt:string;selfDeclaredMadeForKids:boolean}[]=[];
  let identities=0;
  const fetchImpl:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes("/channels?")){identities++;return Response.json({items:[{id:env.BOOKREEL_YOUTUBE_CHANNEL_ID,snippet:{customUrl:"@betweenpages08-l4d",title:"Fixture"}}]});}
    if(url.includes("/upload/youtube/v3/videos")){
      assert.ok(identities>0,"verify channel before choosing a file");
      uploads.push(JSON.parse(String(init?.body)).status);
      return new Response(null,{status:200,headers:{location:`https://upload.example.test/${uploads.length}`}});
    }
    if(url.includes("/thumbnails/set"))return Response.json({});
    if(url.startsWith("https://upload.example.test/")){const n=Number(url.split("/").pop());return Response.json({id:`fixture000${n}`,snippet:{channelId:env.BOOKREEL_YOUTUBE_CHANNEL_ID},status:{privacyStatus:"private",publishAt:uploads[n-1].publishAt}});}
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const options={env,fetchImpl,waitForCompletion:true,deps:{launch:async()=>{throw new Error("API-ready plan must not open a browser");}}};
  await boardAction(f.userId,draft.id,"activate",{},options);
  const slots=await prisma.scheduleSlot.findMany({where:{scheduleId:draft.id,platform:"youtube",episodeId:{in:f.ids}},orderBy:{position:"asc"}});
  const jobs=await prisma.publishJob.findMany({where:{episodeId:{in:f.ids},platform:"youtube"}});
  assert.equal(uploads.length,2);
  assert.deepEqual(uploads.map(u=>u.publishAt),slots.map(s=>s.assignedAt.toISOString()));
  assert.ok(uploads.every(u=>u.privacyStatus==="private"&&u.selfDeclaredMadeForKids===false));
  assert.ok(jobs.every(j=>j.mode==="api"&&j.status==="SCHEDULED"&&j.externalId&&j.scheduledFor&&!j.publishedAt));
  await runSchedule(draft.id,options);
  assert.equal(uploads.length,2,"persisted receipts prevent a second upload");
  assert.equal(await prisma.publishJob.count({where:{episodeId:{in:f.ids},platform:"instagram",status:{not:"QUEUED"}}}),0);
  await prisma.weeklySchedule.delete({where:{id:draft.id}});
  await prisma.publishJob.deleteMany({where:{episodeId:{in:f.ids}}});
});

test("empty 31-day draw persists all 93 cells; no draft is processed by the worker",async()=>{
  const jobsBefore=await prisma.publishJob.count();
  const f=await fixture(0),p=publisher();const draft=await draw(f,{days:31});const v=await boardView(f.userId,draft.id);
  assert.equal(v.slots.length,93);assert.equal(v.counts.withVideo,0);assert.equal(v.slots.at(-1)?.localDate,addDays(day(),30));assert.equal(v.status,"DRAFT");
  await processScheduleQueue(p.options);assert.equal(p.calls.length,0);assert.equal(await prisma.publishJob.count(),jobsBefore);
  assert.ok(draft.warnings.some(w=>/No videos/.test(w)));
});
test("generation discovery, cross-book ordered selection, empty cells and IST timestamps survive rereads",async()=>{
  const f=await fixture(),ids=[f.ids[2],f.ids[0],f.ids[1]];const d=await draw(f,{creationIds:ids});const v=await boardView(f.userId,d.id);
  assert.deepEqual(v.slots.slice(0,3).map(s=>s.creation?.id),ids);assert.equal(v.slots.length,6);assert.equal(v.slots[3].creation,null);
  assert.equal(v.timezone,"Asia/Kolkata");assert.equal(v.instagramEnabled,false);assert.deepEqual((await boardView(f.userId,d.id)).slots,v.slots);
  const gallery=await generatedVideos(f.userId);assert.equal(gallery.items.length,3);assert.equal(gallery.items[0].thumbnail?.options.length,6);assert.equal(gallery.items[0].platforms.instagram.canPublish,false);
  assert.equal((await listBoardPlans(f.userId))[0].id,d.id);
});
test("settings persist audience, visibility and offset; redraw preserves order; reassignment swaps cells",async()=>{
  const f=await fixture();const d=await draw(f),before=await boardView(f.userId,d.id);
  await updateBoardSettings(f.userId,d.id,{name:"My saved week",youtubePrivacy:"unlisted",instagramOffsetMinutes:25,madeForKids:true});
  await redrawBoard(f.userId,d.id,{seed:87});let v=await boardView(f.userId,d.id);assert.equal(v.name,"My saved week");assert.equal(v.madeForKids,true);assert.equal(v.youtubePrivacy,"unlisted");
  assert.deepEqual(v.slots.map(s=>s.creation?.id),before.slots.map(s=>s.creation?.id));assert.notEqual(v.slots[0].localTime,before.slots[0].localTime);
  await editBoardSlot(f.userId,d.id,v.slots[0].id,{creationId:f.ids[1]});v=await boardView(f.userId,d.id);assert.equal(v.slots[0].creation?.id,f.ids[1]);assert.equal(v.slots[1].creation?.id,f.ids[0]);
  const pair=await prisma.scheduleSlot.findMany({where:{scheduleId:d.id,position:0}});assert.equal(pair.find(s=>s.platform==="instagram")!.assignedAt.getTime()-pair.find(s=>s.platform==="youtube")!.assignedAt.getTime(),25*60000);
});
test("invalid dates/settings and another owner's modifications are refused before writes",async()=>{
  const f=await fixture(1),d=await draw(f);
  for(const body of [{days:32},{days:0},{seed:1.5},{instagramOffsetMinutes:181},{startDate:"2027-02-30"},{youtubePrivacy:"unknown"}])await assert.rejects(draw(f,body));
  await assert.rejects(updateBoardSettings("someone-else",d.id,{name:"changed"}),/not found/i);
  await assert.rejects(boardAction("someone-else",d.id,"delete",{}),/not found/i);assert.equal((await boardView(f.userId,d.id)).name,`Week of ${day()}`);
});
test("missing board audience uses content review without a default; disabled Instagram never blocks YouTube",async()=>{
  const f=await fixture(2),d=await draw(f,{madeForKids:null}),p=publisher();
  await boardAction(f.userId,d.id,"activate",{},p.options);
  assert.ok(p.calls.every(c=>c.options.madeForKids===undefined&&c.options.audienceMode==="review"));
  assert.equal((await prisma.weeklySchedule.findUniqueOrThrow({where:{id:d.id}})).madeForKids,null);
  const v=await boardView(f.userId,d.id);assert.equal(v.status,"ACTIVE");assert.equal(v.counts.scheduledOnPlatform,2);assert.equal(p.calls.length,2);assert.ok(p.calls.every(c=>c.platform==="youtube"));
  await runSchedule(d.id,p.options);assert.equal(p.calls.length,2,"confirmed uploads are never repeated");
  assert.equal(await prisma.publishAttempt.count({where:{episodeId:{in:f.ids},status:"SCHEDULED"}}),2);
});
test("a connected API account cannot bypass browser audience review",async()=>{
  const f=await fixture(1),d=await draw(f,{madeForKids:null});
  const env={GOOGLE_CLIENT_ID:"fixture",GOOGLE_CLIENT_SECRET:"fixture",GOOGLE_OAUTH_REDIRECT_URI:"http://localhost:3001/api/publish/youtube/callback",BOOKREEL_TOKEN_KEY:randomBytes(32).toString("base64"),BOOKREEL_INSTAGRAM_PUBLISH_ENABLED:"0"};
  await storeGrant(f.userId,{accessToken:"fixture",refreshToken:"fixture",expiresAt:new Date(Date.now()+3600000),scope:YOUTUBE_SCOPES.join(" ")},env);
  let browsers=0,apiCalls=0;
  await boardAction(f.userId,d.id,"activate",{}, {env,waitForCompletion:true,fetchImpl:async()=>{apiCalls++;throw new Error("No API upload allowed");},deps:{locate:()=>"fixture",launch:async()=>{browsers++;throw new Error("Fixture stops before browser launch");}}});
  const job=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});
  assert.equal(job.mode,"browser");assert.equal(JSON.parse(job.optionsJson!).audienceMode,"review");
  assert.equal(apiCalls,0);assert.equal(browsers,0,"missing review evidence stops before Chrome opens");
  assert.equal(job.status,"AWAITING_HUMAN");assert.match(job.lastError??"",/stored video script/);
});

test("existing board answers remain stored but are never silently applied after removing the control",async()=>{
  for(const madeForKids of [true,false]){
    const f=await fixture(1),d=await draw(f,{madeForKids}),p=publisher();
    await boardAction(f.userId,d.id,"activate",{},p.options);
    assert.equal(p.calls[0].options.audienceMode,"review");assert.equal(p.calls[0].options.madeForKids,madeForKids);
    assert.equal((await prisma.weeklySchedule.findUniqueOrThrow({where:{id:d.id}})).madeForKids,madeForKids);
  }
});

test("native confirmation is not inferred from a manual click or elapsed time",async()=>{
  const f=await fixture(1),d=await draw(f),p=publisher("human");await boardAction(f.userId,d.id,"activate",{},p.options);
  const job=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});
  await prisma.publishJob.update({where:{id:job.id},data:{remoteDraftId:"abcdefghijk"}});
  await assert.rejects(jobAction(f.userId,job.id,"confirm",{},{verifyKnownSchedule:async()=>false}),/did not confirm/);
  assert.equal((await prisma.publishJob.findUniqueOrThrow({where:{id:job.id}})).status,"AWAITING_HUMAN");
  await jobAction(f.userId,job.id,"confirm",{},{verifyKnownSchedule:async()=>true});assert.equal((await boardView(f.userId,d.id)).counts.scheduledOnPlatform,1);assert.equal(p.calls.length,1);
});
test("pause and cancel preserve confirmed remote receipts and block local rescheduling",async()=>{
  const f=await fixture(1),d=await draw(f),p=publisher();await boardAction(f.userId,d.id,"activate",{},p.options);const v=await boardView(f.userId,d.id);
  await assert.rejects(editBoardSlot(f.userId,d.id,v.slots[0].id,{localTime:"05:40"}),/platform/i);
  await boardAction(f.userId,d.id,"pause",{},p.options);await processScheduleQueue(p.options);assert.equal(p.calls.length,1);
  const result=await boardAction(f.userId,d.id,"cancel",{},p.options);assert.equal((result as {stillScheduled:number}).stillScheduled,1);assert.equal((await boardView(f.userId,d.id)).counts.scheduledOnPlatform,1);
});
test("failed retry records a second attempt and never retries confirmed work",async()=>{
  const f=await fixture(1),d=await draw(f),failure=publisher("failed");await boardAction(f.userId,d.id,"activate",{},failure.options);
  const job=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});
  const ok=publisher();await jobAction(f.userId,job.id,"retry",{},ok.options);assert.equal(ok.calls.length,1);
  await assert.rejects(jobAction(f.userId,job.id,"retry",{},ok.options),/Only a failed/);
  assert.equal(await prisma.publishAttempt.count({where:{jobId:job.id}}),2);
});
test("a draft cannot be armed by bulk Schedule or Start Now",async()=>{
  const f=await fixture(1),d=await draw(f),v=await boardView(f.userId,d.id),p=publisher();
  const result=await bulkPublish(f.userId,{creationIds:f.ids,platforms:["youtube"],confirmed:true,publishNow:false},p.options);
  assert.equal(result.rejected,1);assert.match(result.items[0].message!,/Activate/);assert.equal(p.calls.length,0);
  await assert.rejects(boardSlotAction(f.userId,d.id,v.slots[0].id,"start-now",p.options),/Activate/);
});
test("bulk Publish now persists independent jobs, runs in order and skips disabled Instagram",async()=>{
  const f=await fixture(2),p=publisher();const result=await bulkPublish(f.userId,{creationIds:f.ids,platforms:["youtube","instagram"],confirmed:true,publishNow:true,youtubePrivacy:"private",madeForKids:false},p.options);
  assert.equal(result.started,2);assert.equal(result.rejected,2);assert.deepEqual(p.calls.map(c=>c.id),f.ids);assert.ok(p.calls.every(c=>!c.options.scheduledAt));
  const again=await bulkPublish(f.userId,{creationIds:f.ids,platforms:["youtube"],confirmed:true,publishNow:true,madeForKids:false},p.options);assert.equal(again.skipped,2);assert.equal(p.calls.length,2);
});
test("private plans wait for the assigned instant; restart holds missed posts instead of publishing a burst",async()=>{
  const f=await fixture(1),d=await draw(f,{youtubePrivacy:"private"}),p=publisher();await boardAction(f.userId,d.id,"activate",{},p.options);assert.equal(p.calls.length,0);
  await prisma.scheduleSlot.updateMany({where:{scheduleId:d.id,platform:"youtube"},data:{assignedAt:new Date(Date.now()-46*60000)}});
  await processScheduleQueue(p.options);assert.equal(p.calls.length,0);
  const j=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});assert.equal(j.status,"HELD");assert.match(j.lastError!,/Missed/);
});
test("selection order is stable; disabled platforms and inactive plans have separate preview reasons",()=>{
  let set=toggle(new Set(),"b",true);set=toggle(set,"a",true);assert.deepEqual([...parseStored(JSON.stringify([...set]))],["b","a"]);
  const videos=[{id:"a",title:"A",selectable:true,file:{ok:true,problem:null},schedule:{slotAt:new Date(Date.now()+86400000).toISOString(),youtubePrivacy:"public",status:"DRAFT"},platforms:{youtube:{canPublish:true,blockedReason:null},instagram:{canPublish:false,blockedReason:"Disabled",blockedKind:"disabled"}}}];
  assert.equal(schedulePlanFor(videos,["youtube"]).posts,0);assert.equal(planFor(videos,["youtube","instagram"]).posts,1);
});

test("a missing generated asset is an explicit draft error even when an existing job makes the video unavailable",async()=>{
  const f=await fixture(1),d=await draw(f);const e=await prisma.episode.findUniqueOrThrow({where:{id:f.ids[0]}});await fs.unlink(e.videoPath!);
  await prisma.publishJob.create({data:{episodeId:e.id,platform:"youtube",mode:"browser",status:"FAILED",externalId:"fixture-known"}});
  const view=await boardView(f.userId,d.id);assert.ok(view.slots[0].issues.some(i=>i.severity==="error"&&/no longer on disk|missing/.test(i.message)));
  const p=publisher();await assert.rejects(boardAction(f.userId,d.id,"activate",{},p.options),/no longer on disk|missing/);assert.equal(p.calls.length,0);
});

test("paused and cancelled slots remain inert when the active plan is retried",async()=>{
  const f=await fixture(2),d=await draw(f),view=await boardView(f.userId,d.id),p=publisher();
  await boardSlotAction(f.userId,d.id,view.slots[0].id,"pause",p.options);await boardSlotAction(f.userId,d.id,view.slots[1].id,"cancel",p.options);
  await prisma.weeklySchedule.update({where:{id:d.id},data:{status:"active",workflowVersion:2}});await runSchedule(d.id,p.options);assert.equal(p.calls.length,0);
});

test("private API uploads honour an explicit audience answer and never invent one",async()=>{
  const bodies:Record<string,unknown>[]=[];
  const fetcher=async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)).status);return new Response(null,{status:200,headers:{location:"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture"}});};
  const snippet={title:"Fixture",description:"Fixture",tags:[],categoryId:"27"};
  await createSession("fixture-token",snippet,10,"video/mp4",fetcher,undefined,false);
  await createSession("fixture-token",snippet,10,"video/mp4",fetcher);
  assert.deepEqual(bodies,[{privacyStatus:"private",selfDeclaredMadeForKids:false},{privacyStatus:"private"}]);
});

test("eligible-video discovery follows generation completion and checks the actual rendered asset",async()=>{
  const f=await fixture(1);await prisma.episode.update({where:{id:f.ids[0]},data:{status:"RENDERING"}});
  assert.equal((await generatedVideos(f.userId)).items[0].selectable,false);assert.deepEqual((await generatedVideos(f.userId)).selectableIds,[]);
  await prisma.episode.update({where:{id:f.ids[0]},data:{status:"DONE"}});
  let videos=await generatedVideos(f.userId);assert.equal(videos.items[0].selectable,true);
  await prisma.episode.update({where:{id:f.ids[0]},data:{videoPath:null}});
  videos=await generatedVideos(f.userId);assert.equal(videos.items[0].selectable,false);assert.equal(videos.items[0].file.ok,false);
});

test("bulk Schedule recovers eligible failed posts in an explicitly active plan",async()=>{
  const f=await fixture(2),d=await draw(f),failed=publisher("failed");await boardAction(f.userId,d.id,"activate",{},failed.options);
  const recovered=publisher();const result=await bulkPublish(f.userId,{creationIds:f.ids,platforms:["youtube"],confirmed:true,publishNow:false},recovered.options);
  assert.equal(result.started,2);assert.deepEqual(recovered.calls.map(c=>c.id),f.ids);
  assert.equal((await boardView(f.userId,d.id)).counts.scheduledOnPlatform,2);
});

test("the existing worker recovers only explicitly approved immediate jobs and never repeats confirmed ones",async()=>{
  const f=await fixture(3),p=publisher();
  for(let i=0;i<3;i++)await prisma.publishJob.create({data:{episodeId:f.ids[i],platform:"youtube",mode:"browser",status:"QUEUED",optionsJson:JSON.stringify({queueOrigin:"operator-immediate",confirmPublic:i<2,madeForKids:false,visibility:"private"})}});
  await processScheduleQueue(p.options);assert.deepEqual(p.calls.filter(c=>f.ids.includes(c.id)).map(c=>c.id),f.ids.slice(0,2));
  await processScheduleQueue(p.options);assert.equal(p.calls.filter(c=>f.ids.includes(c.id)).length,2);
  const unapproved=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[2],platform:"youtube"}}});assert.equal(unapproved.status,"QUEUED");
});

test("Pause and Resume cannot bypass a draft's explicit Activate step",async()=>{
  const f=await fixture(1),d=await draw(f),p=publisher();
  await assert.rejects(boardAction(f.userId,d.id,"pause",{},p.options),/Activate/);
  assert.equal((await prisma.weeklySchedule.findUniqueOrThrow({where:{id:d.id}})).status,"draft");
  await prisma.weeklySchedule.update({where:{id:d.id},data:{status:"paused"}});
  await assert.rejects(boardAction(f.userId,d.id,"resume",{},p.options),/explicitly activated/);
  assert.equal(p.calls.length,0);assert.equal(await prisma.publishJob.count({where:{episodeId:{in:f.ids}}}),0);
});

test("pausing shows held jobs; cancellation releases unstarted reservations without uploading",async()=>{
  const f=await fixture(1),d=await draw(f,{youtubePrivacy:"private"}),p=publisher();await boardAction(f.userId,d.id,"activate",{},p.options);
  await boardAction(f.userId,d.id,"pause",{},p.options);const paused=await boardView(f.userId,d.id);assert.equal(paused.slots[0].jobs.youtube?.status,"DRAFT");assert.match(paused.slots[0].jobs.youtube!.error!,/Paused/);
  await boardAction(f.userId,d.id,"cancel",{},p.options);
  const job=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});assert.equal(job.status,"CANCELLED");
  assert.equal((await boardView(f.userId,d.id)).slots[0].status,"CANCELLED");assert.equal((await generatedVideos(f.userId)).items[0].selectable,true);assert.equal(p.calls.length,0);
});

test("slot cancellation releases only its unstarted job and leaves other queued slots intact",async()=>{
  const f=await fixture(2),d=await draw(f,{youtubePrivacy:"private"}),p=publisher();await boardAction(f.userId,d.id,"activate",{},p.options);const view=await boardView(f.userId,d.id);
  await boardSlotAction(f.userId,d.id,view.slots[0].id,"cancel",p.options);
  const first=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}}),second=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[1],platform:"youtube"}}});
  assert.equal(first.status,"CANCELLED");assert.equal(second.status,"QUEUED");assert.equal(p.calls.length,0);await boardAction(f.userId,d.id,"cancel",{},p.options);
});

test("recovery of CANCELLED and pre-upload AWAITING_HUMAN jobs works only when externalId, remoteDraftId, and sessionUrlEnc are all null",async()=>{
  assert.equal(STUDIO_REVIEW_TIMEOUT_MS,420_000,"mandatory 420-second AI audience/tag review timeout remains active");
  const f=await fixture(3),d=await draw(f,{madeForKids:null}),human=publisher("human");
  await boardAction(f.userId,d.id,"activate",{},human.options);
  const j0=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});
  const j1=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[1],platform:"youtube"}}});
  const j2=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[2],platform:"youtube"}}});
  // j0: pre-upload AWAITING_HUMAN (all remote fields null)
  await prisma.publishJob.update({where:{id:j0.id},data:{status:"AWAITING_HUMAN",externalId:null,remoteDraftId:null,sessionUrlEnc:null,lastError:"Audience and tag review timed out"}});
  // j1: unstarted CANCELLED on an active slot (all remote fields null)
  await prisma.publishJob.update({where:{id:j1.id},data:{status:"CANCELLED",externalId:null,remoteDraftId:null,sessionUrlEnc:null,lastError:"Cancelled before upload"}});
  // j2: post-upload AWAITING_HUMAN with remoteDraftId (must NEVER be auto-retried or rescheduled)
  await prisma.publishJob.update({where:{id:j2.id},data:{status:"AWAITING_HUMAN",externalId:null,remoteDraftId:"youtube-upload-unconfirmed",sessionUrlEnc:null}});

  const v1=await boardView(f.userId,d.id);
  assert.equal(v1.slots[0].jobs.youtube?.preUpload,true);
  assert.equal(v1.slots[1].jobs.youtube?.preUpload,true);
  assert.equal(v1.slots[2].jobs.youtube?.preUpload,false);
  assert.equal(scheduleRetryCandidate(v1.slots[0].jobs.youtube!),true);
  assert.equal(scheduleRetryCandidate(v1.slots[1].jobs.youtube!),true);
  assert.equal(scheduleRetryCandidate(v1.slots[2].jobs.youtube!),false);

  // Refuses retry and reschedule when remoteDraftId, externalId, or sessionUrlEnc is present
  const ok=publisher();
  await assert.rejects(jobAction(f.userId,j2.id,"retry",{},ok.options),/Only a failed/);
  await assert.rejects(editBoardSlot(f.userId,d.id,v1.slots[2].id,{localTime:"05:50"},true),/platform already holds/i);
  await assert.rejects(boardSlotAction(f.userId,d.id,v1.slots[2].id,"start-now",ok.options),/platform already holds/i);
  await prisma.publishJob.update({where:{id:j2.id},data:{remoteDraftId:null,sessionUrlEnc:"enc-session"}});
  await assert.rejects(jobAction(f.userId,j2.id,"retry",{},ok.options),/Only a failed/);
  await prisma.publishJob.update({where:{id:j2.id},data:{sessionUrlEnc:null,externalId:"knownVid123"}});
  await assert.rejects(jobAction(f.userId,j2.id,"retry",{},ok.options),/Only a failed/);
  await prisma.publishJob.update({where:{id:j2.id},data:{externalId:null,remoteDraftId:"youtube-upload-unconfirmed"}});

  // Reschedule and Start Now work for pre-upload AWAITING_HUMAN (j0), and retryBoardPlan recovers j1 while holding j2
  await editBoardSlot(f.userId,d.id,v1.slots[0].id,{localTime:"05:52"},true);
  assert.equal((await prisma.publishJob.findUniqueOrThrow({where:{id:j0.id}})).status,"QUEUED");
  await prisma.publishJob.update({where:{id:j0.id},data:{status:"AWAITING_HUMAN",lastError:"Audience and tag review timed out"}});
  const summary=await retryBoardPlan(f.userId,d.id,ok.options);
  assert.equal(summary.started,2,"both pre-upload AWAITING_HUMAN and CANCELLED jobs are accepted");
  assert.equal(summary.scheduled,2);
  assert.equal(summary.awaitingReview,1,"post-upload job with remoteDraftId remains held for human inspection");
  assert.ok(ok.calls.every(c=>c.options.audienceMode==="review"),"mandatory audience review is preserved on recovery");
});

test("activating a new schedule recovers unstarted CANCELLED jobs and non-critical SQLite progress lock errors do not abort uploads",async()=>{
  assert.equal(isSqliteLockError(Object.assign(new Error("Operations timed out"),{code:"P1008"})),true);
  assert.equal(isSqliteLockError(new Error("SQLITE_BUSY: database is locked")),true);
  assert.equal(isSqliteLockError(new Error("Invalid column name")),false);

  const f=await fixture(1);
  // Pre-existing CANCELLED job from an earlier cancelled schedule (all remote fields null)
  await prisma.publishJob.create({data:{episodeId:f.ids[0],platform:"youtube",mode:"browser",status:"CANCELLED",lastError:"Cancelled before upload"}});
  await prisma.publishJob.create({data:{episodeId:f.ids[0],platform:"instagram",mode:"browser",status:"CANCELLED",lastError:"Cancelled before upload"}});
  const d=await draw(f,{madeForKids:null});

  let logCalls=0;
  const origUpdateMany=prisma.publishJob.updateMany.bind(prisma.publishJob);
  const makePublisher=(platform:never,options:BrowserPublishOptions):BrowserPublisher=>{
    const real=browserPublisherFor(platform,{browser:{deps:{locate:()=>"fixture-browser"}}}) as BrowserPublisher;
    return {
      ...real,
      publish:async(prepared,hooks)=>{
        // Simulate concurrent un-awaited progress logs colliding with a transient SQLite P1008 lock
        void hooks?.onLog?.("1. Opening Studio");
        void hooks?.onLog?.("2. Verifying channel");
        await hooks?.onLog?.("3. Reviewing script");
        await hooks?.onMetadata?.({...prepared.metadata,tags:["productivity","focus"]});
        return {status:"PUBLISHED",externalId:`fixture-${prepared.episodeId}`,externalUrl:"https://example.test/video",confirmedAt:new Date(),visibility:"scheduled",scheduledFor:options.scheduledAt??new Date()};
      },
    };
  };
  (prisma.publishJob as unknown as {updateMany:typeof origUpdateMany}).updateMany=(async(args:unknown)=>{
    const data=(args as {data?:Record<string,unknown>})?.data;
    if(data&&typeof data.progress==="string"){
      logCalls++;
      throw Object.assign(new Error("Operations timed out"),{code:"P1008"});
    }
    return origUpdateMany(args as Parameters<typeof origUpdateMany>[0]);
  }) as unknown as typeof origUpdateMany;
  try{
    await boardAction(f.userId,d.id,"activate",{},{makePublisher:makePublisher as never,waitForCompletion:true,env:{BOOKREEL_INSTAGRAM_PUBLISH_ENABLED:"0"}});
  }finally{
    (prisma.publishJob as unknown as {updateMany:typeof origUpdateMany}).updateMany=origUpdateMany;
  }
  assert.ok(logCalls>=3,"progress log writes were attempted and hit simulated P1008 lock");
  const ytJob=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"youtube"}}});
  const igJob=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f.ids[0],platform:"instagram"}}});
  assert.equal(ytJob.status,"SCHEDULED","non-critical progress log lock did not interrupt the active upload");
  assert.equal(igJob.status,"QUEUED","unstarted CANCELLED Instagram job was reset to QUEUED so UI shows Disabled instead of Cancelled");

  // Verify critical database errors (e.g., onCheckpoint failing with a fatal DB error) remain visible
  const f2=await fixture(1),d2=await draw(f2,{madeForKids:null});
  const origUpdate=prisma.publishJob.update.bind(prisma.publishJob);
  const failCheckpointPublisher=(platform:never,options:BrowserPublishOptions):BrowserPublisher=>{
    const real=browserPublisherFor(platform,{browser:{deps:{locate:()=>"fixture-browser"}}}) as BrowserPublisher;
    return {
      ...real,
      publish:async(prepared,hooks)=>{
        await hooks?.onCheckpoint?.("youtube-upload-unconfirmed");
        return {status:"PUBLISHED",externalId:`fixture-${prepared.episodeId}`,externalUrl:"https://example.test/video",confirmedAt:new Date(),visibility:"scheduled",scheduledFor:options.scheduledAt??new Date()};
      },
    };
  };
  (prisma.publishJob as unknown as {update:typeof origUpdate}).update=(async(args:unknown)=>{
    const data=(args as {data?:Record<string,unknown>})?.data;
    if(data&&"remoteDraftId" in data)throw new Error("Simulated critical checkpoint database failure");
    return origUpdate(args as Parameters<typeof origUpdate>[0]);
  }) as unknown as typeof origUpdate;
  try{
    await boardAction(f2.userId,d2.id,"activate",{},{makePublisher:failCheckpointPublisher as never,waitForCompletion:true,env:{BOOKREEL_INSTAGRAM_PUBLISH_ENABLED:"0"}});
  }finally{
    (prisma.publishJob as unknown as {update:typeof origUpdate}).update=origUpdate;
  }
  const criticalJob=await prisma.publishJob.findUniqueOrThrow({where:{episodeId_platform:{episodeId:f2.ids[0],platform:"youtube"}}});
  assert.equal(criticalJob.status,"AWAITING_HUMAN");
  assert.match(criticalJob.lastError??"",/Simulated critical checkpoint database failure/);
});
