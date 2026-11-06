import test from "node:test";
import assert from "node:assert/strict";
import { batchCompletion, videoCompletion } from "../src/lib/schedule/board-completion";
import type { JobView, SlotView } from "../src/lib/schedule/board-types";

function job(status: string, platform = "youtube", confirmation: JobView["confirmation"] = null): JobView {
  return { id:platform,status,platform,confirmation,error:null,remoteUrl:null,startAt:null,publishAt:null,startedAt:null,lastAttemptAt:null,updatedAt:"2030-01-01T00:00:00Z",postedAt:null,attempts:1,nativeSchedule:true,platformStatus:null,platformPublishAt:null };
}
const slot = (jobs:SlotView["jobs"], id="video") => ({id,creation:{id},jobs}) as SlotView;
const statuses = ["none","SCHEDULED","PUBLISHING","FAILED","AWAITING_HUMAN","CANCELLED","DRAFT","unverified","scheduled","posted"];
const state = (status:string,platform:string) => status==="none"?null:status==="scheduled"?job("PLATFORM_SCHEDULED",platform,"scheduled"):status==="posted"?job("POSTED",platform,"posted"):status==="unverified"?job("PLATFORM_SCHEDULED",platform):job(status,platform);

test("all 100 platform combinations count only verified outcomes and keep video categories disjoint",()=>{
  for(const yt of statuses)for(const ig of statuses){
    const jobs={youtube:state(yt,"youtube"),instagram:state(ig,"instagram")};
    const n=[yt,ig].filter(s=>s==="scheduled"||s==="posted").length;
    const c=batchCompletion([slot(jobs)]),v=videoCompletion(jobs);
    assert.equal(c.completedVideos,n===2?1:0,`${yt}/${ig}`);
    assert.equal(c.partiallyCompletedVideos,n===1?1:0);
    assert.equal(c.pendingOrFailedVideos,n===0?1:0);
    assert.equal(c.completedVideos+c.partiallyCompletedVideos+c.pendingOrFailedVideos,c.totalVideos);
    assert.equal(c.confirmedScheduledPosts,[yt,ig].filter(s=>s==="scheduled").length);
    assert.equal(c.confirmedPostedPosts,[yt,ig].filter(s=>s==="posted").length);
    if(n===2)assert.equal(v.label,"COMPLETED");
    if(n===1)assert.equal(v.label,`PARTIALLY COMPLETED – ${["scheduled","posted"].includes(yt)?"Instagram":"YouTube"} Pending`);
  }
});
test("failure and attention messages retain the exact platform, status and error beside a partial result",()=>{
  for(const platform of ["youtube","instagram"] as const)for(const status of ["FAILED","AWAITING_HUMAN","REQUIRES_CONNECTION","CANCELLED","HELD"]){
    const jobs={youtube:state("scheduled","youtube"),instagram:state("scheduled","instagram")};
    jobs[platform]={...job(status,platform),sourceStatus:status,error:"Exact platform error"};
    const result=videoCompletion(jobs);
    assert.equal(result.kind,"partial");assert.equal(result.attention.length,1);
    assert.equal(result.attention[0].label,`${platform==="youtube"?"YouTube":"Instagram"} – ${status}`);
    assert.equal(result.attention[0].error,"Exact platform error");
  }
});
test("empty slots do not count and scheduled posts never increment Posted",()=>{
  const completed=slot({youtube:state("scheduled","youtube"),instagram:state("scheduled","instagram")});
  const empty={...completed,id:"empty",creation:null};
  assert.deepEqual(batchCompletion([completed,empty]),{totalVideos:1,completedVideos:1,partiallyCompletedVideos:0,pendingOrFailedVideos:0,confirmedScheduledPosts:2,confirmedPostedPosts:0});
  assert.equal(videoCompletion({youtube:job("PLATFORM_SCHEDULED"),instagram:null}).attention[0].status,"Confirmation missing or publication time differs");
});
