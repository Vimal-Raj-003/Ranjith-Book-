/** Full-page editing adapter. Uses the existing schedule tables and execution engine. */
import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { loadPublishRequest } from "@/lib/publish/state";
import { publishingEnabled } from "@/lib/publish/execution";
import { generatePlan, DEFAULT_WINDOWS, checkSlots, checkAgainst, checkOrder, type TimeWindow } from "./plan";
import { DEFAULT_TIMEZONE, addDays, todayIn, zonedInstant, localParts } from "./reference-time";
import { boardView, ownedPlan, planWindows, platformState, platforms, toTime } from "./board-read";
import { activateSchedule, type ActivateOptions } from "./store";
import { runSchedule } from "./activate";

export const refuse = (message:string,status=400):never=>{throw new AppError("schedule_refused",message,status);};
type Body=Record<string,unknown>;
async function cancelUnstarted(tx:Prisma.TransactionClient,scheduleId:string,position?:number) {
  const rows=await tx.scheduleSlot.findMany({where:{scheduleId,...(position===undefined?{}:{position})}});
  const ids=rows.flatMap(r=>r.publishJobId?[r.publishJobId]:[]);
  await tx.publishJob.updateMany({where:{id:{in:ids},status:"QUEUED",externalId:null,remoteDraftId:null,sessionUrlEnc:null},data:{status:"CANCELLED",lastError:"Cancelled by the operator before upload."}});
  const cancelled=await tx.publishJob.findMany({where:{id:{in:ids},status:"CANCELLED",externalId:null,remoteDraftId:null,sessionUrlEnc:null},select:{id:true}});
  // A later job for the same episode must not become this cancelled slot's result.
  await tx.scheduleSlot.updateMany({where:{scheduleId,publishJobId:{in:cancelled.map(j=>j.id)}},data:{publishJobId:null,status:"skipped",note:"Cancelled before upload."}});
  return {stillScheduled:await tx.publishJob.count({where:{id:{in:ids},status:"SCHEDULED"}}),stillRunning:await tx.publishJob.count({where:{id:{in:ids},status:{in:["PREPARING","UPLOADING"]}}})};
}
function settings(body:Body) {
  const startDate=String(body.startDate||addDays(todayIn(DEFAULT_TIMEZONE),1));
  const days=body.days===undefined?7:Number(body.days), seed=body.seed===undefined||body.seed===""?randomInt(1,2147483647):Number(body.seed);
  const windows=(body.windows??DEFAULT_WINDOWS) as TimeWindow[],endInclusive=body.endInclusive===true;
  if(!Number.isInteger(seed))refuse("The seed must be a whole number.");
  const offset=Number(body.instagramOffsetMinutes??0);
  if(!Number.isInteger(offset)||offset<0||offset>180)refuse("Instagram delay must be a whole number from 0 to 180 minutes.");
  const privacy=String(body.youtubePrivacy??"public");
  if(!["public","private","unlisted"].includes(privacy))refuse("Choose public, unlisted or private visibility.");
  if(body.madeForKids!==undefined&&body.madeForKids!==null&&typeof body.madeForKids!=="boolean")refuse("Choose the audience answer, or leave it unanswered.");
  let plan;try{plan=generatePlan({startDate,days,windows,timezone:DEFAULT_TIMEZONE,seed,endInclusive});}catch(e){return refuse(e instanceof Error?e.message:"Invalid schedule settings.");}
  return {startDate,days,seed,windows,endInclusive,offset,privacy,plan,name:(String(body.name??"").trim()||`Week of ${startDate}`).slice(0,80),madeForKids:typeof body.madeForKids==="boolean"?body.madeForKids:null};
}

export async function createBoardPlan(userId:string,body:Body) {
  const s=settings(body);
  if(!Array.isArray(body.creationIds)||body.creationIds.some(id=>typeof id!=="string"))refuse("Choose videos from Generated videos (an empty selection creates an empty draft).");
  const ids=[...new Set((body.creationIds as string[]).map(id=>id.trim()).filter(Boolean))];
  const selected:string[]=[],warnings=[...s.plan.warnings];
  const existingPlans=await prisma.weeklySchedule.findMany({where:{userId,status:{not:"cancelled"}},select:{id:true}});
  for(const id of ids){
    const e=await prisma.episode.findFirst({where:{id,userId,status:"DONE"},include:{publishJobs:true}});
    const busy=e?.publishJobs.find(j=>publishingEnabled(j.platform as "youtube"|"instagram")&&!platformState(j.platform as "youtube"|"instagram",j).canPublish);
    const reserved=await prisma.scheduleSlot.findFirst({where:{episodeId:id,scheduleId:{in:existingPlans.map(s=>s.id)},platform:{in:platforms.filter(p=>publishingEnabled(p))},controlState:{not:"cancelled"}}});
    if(!e||busy||reserved){warnings.push(`${e?.title??"A selected video"}: ${reserved?"already in another schedule":busy?"already has a post or needs review":"not a finished video you own"}. Nothing was put in its place.`);continue;}
    try{await loadPublishRequest(userId,id,"youtube");selected.push(id);}catch(e){warnings.push(e instanceof Error?e.message:"The video is unavailable.");}
  }
  if(!ids.length)warnings.push("No videos are selected in Generated Videos, so every slot is empty. Tick videos in order, then draw the week again.");
  if(selected.length>s.plan.times.length)warnings.push(`${selected.length-s.plan.times.length} selected videos did not fit in this draw.`);
  const saved=await prisma.$transaction(async tx=>{
    const schedule=await tx.weeklySchedule.create({data:{userId,uploadId:"",boardGrid:true,name:s.name,weekStart:new Date(`${s.startDate}T00:00:00Z`),days:s.days,timeSlots:JSON.stringify(s.windows.map(w=>w.start)),timezone:DEFAULT_TIMEZONE,windowsJson:JSON.stringify(s.windows),seed:s.seed,endInclusive:s.endInclusive,instagramOffsetMinutes:s.offset,youtubePrivacy:s.privacy,madeForKids:s.madeForKids,status:"draft"}});
    await tx.scheduleSlot.createMany({data:s.plan.times.flatMap((t,i)=>platforms.map(platform=>({scheduleId:schedule.id,episodeId:selected[i]??"",platform,position:i,assignedAt:new Date(t.scheduledAt.getTime()+(platform==="instagram"?s.offset*60000:0))})))});
    return schedule;
  });
  return {id:saved.id,warnings};
}

export async function updateBoardSettings(userId:string,id:string,body:Body) {
  const s=await ownedPlan(userId,id);if(s.status!=="draft")refuse("Only a draft's settings can be changed.",409);
  const next=settings({startDate:s.weekStart.toISOString().slice(0,10),days:s.days,windows:planWindows(s),seed:s.seed,endInclusive:s.endInclusive,name:s.name,youtubePrivacy:s.youtubePrivacy,instagramOffsetMinutes:s.instagramOffsetMinutes,madeForKids:s.madeForKids,...body});
  if(await prisma.scheduleSlot.count({where:{scheduleId:id,publishJobId:{not:null}}}))refuse("A post in this draft is already armed. Its saved publishing settings cannot be overwritten.",409);
  await prisma.$transaction(async tx=>{
    await tx.weeklySchedule.update({where:{id},data:{name:next.name,youtubePrivacy:next.privacy,instagramOffsetMinutes:next.offset,madeForKids:next.madeForKids}});
    if(next.offset!==s.instagramOffsetMinutes){const slots=await tx.scheduleSlot.findMany({where:{scheduleId:id,platform:"instagram"}});for(const slot of slots)await tx.scheduleSlot.update({where:{id:slot.id},data:{assignedAt:new Date(slot.assignedAt.getTime()+(next.offset-s.instagramOffsetMinutes)*60000)}});}
  });
}

export async function redrawBoard(userId:string,id:string,body:Body) {
  const s=await ownedPlan(userId,id);if(s.status!=="draft")refuse("Only a draft can be redrawn.",409);
  if(await prisma.scheduleSlot.count({where:{scheduleId:id,publishJobId:{not:null}}}))refuse("An armed post cannot be redrawn. Reschedule it after checking the platform.",409);
  const next=settings({startDate:s.weekStart.toISOString().slice(0,10),days:s.days,windows:planWindows(s),endInclusive:s.endInclusive,...body});
  const slots=await prisma.scheduleSlot.findMany({where:{scheduleId:id}});
  await prisma.$transaction(async tx=>{for(const slot of slots){const t=next.plan.times[slot.position];if(t)await tx.scheduleSlot.update({where:{id:slot.id},data:{assignedAt:new Date(t.scheduledAt.getTime()+(slot.platform==="instagram"?s.instagramOffsetMinutes*60000:0))}});}await tx.weeklySchedule.update({where:{id},data:{seed:next.seed}});});
  return {warnings:next.plan.warnings};
}

export async function editBoardSlot(userId:string,id:string,slotId:string,body:Body,force=false) {
  const s=await ownedPlan(userId,id);if(s.status==="cancelled")refuse("This schedule is cancelled.",409);
  const rows=await prisma.scheduleSlot.findMany({where:{scheduleId:id}}), row=rows.find(r=>r.id===slotId);
  if(!row)refuse("Slot not found.",404);
  const group=rows.filter(r=>r.position===row!.position);
  const anchor=group.find(r=>r.platform==="youtube")??row!;
  const jobs=await prisma.publishJob.findMany({where:{id:{in:group.flatMap(r=>r.publishJobId?[r.publishJobId]:[])}}});
  if(jobs.some(j=>["SCHEDULED","PUBLISHED","UPLOADING","PREPARING"].includes(j.status)||j.externalId||j.remoteDraftId||j.sessionUrlEnc))refuse("A platform already holds or may hold this upload. Check or change it on the platform first; no local time or video was changed.",409);
  if(body.creationId!==undefined&&s.status!=="draft")refuse("A video can only be changed in a draft.",409);
  if(s.status==="draft"&&rows.some(r=>r.publishJobId))refuse("A draft with an existing publishing job must be reconciled before changing its video assignments or times.",409);
  let episodeId=row!.episodeId;
  if(body.creationId!==undefined){if(body.creationId!==null&&typeof body.creationId!=="string")refuse("Choose a video or the empty option.");episodeId=String(body.creationId??"");if(episodeId&&episodeId!==row!.episodeId){const v=await boardView(userId,id);if(!v.candidates.some(c=>c.id===episodeId&&!c.problems.length)&&!v.slots.some(t=>t.creation?.id===episodeId))refuse("This video is unavailable or belongs to another schedule.",409);}}
  const local=localParts(anchor.assignedAt,s.timezone);
  let at:Date;try{at=zonedInstant(String(body.localDate??local.date),String(body.localTime??local.time),s.timezone);}catch(e){return refuse(e instanceof Error?e.message:"Invalid date or time.");}
  if(s.status!=="draft"){
    if(at.getTime()<Date.now()+20*60000)refuse("Choose a future time at least 20 minutes away.",409);
    const t={...toTime(anchor,s),scheduledAt:at,localDate:localParts(at,s.timezone).date,localTime:localParts(at,s.timezone).time};
    const mates=rows.filter(r=>r.platform==="youtube"&&r.position!==anchor.position&&r.episodeId&&r.controlState!=="cancelled").map(r=>toTime(r,s));
    const plans=await prisma.weeklySchedule.findMany({where:{userId,id:{not:id},status:{in:["draft","active","paused"]}}});
    const foreign=await prisma.scheduleSlot.findMany({where:{scheduleId:{in:plans.map(p=>p.id)},platform:"youtube",episodeId:{not:""},controlState:{not:"cancelled"}}});
    const issues=checkSlots([t],{now:new Date(),timezone:s.timezone,windows:force?[]:planWindows(s),endInclusive:s.endInclusive,minGapMinutes:30,minAheadMinutes:20});
    issues.push(...checkAgainst([t],[...mates,...foreign.map(r=>toTime(r,plans.find(p=>p.id===r.scheduleId)!))],30));
    if(!force)issues.push(...checkOrder(t,mates));
    if(issues.some(i=>i.severity==="error"))refuse(issues.filter(i=>i.severity==="error").map(i=>i.message).join(" "),409);
  }
  await prisma.$transaction(async tx=>{
    const current=await tx.weeklySchedule.findUnique({where:{id}});
    if(!current||current.updatedAt.getTime()!==s.updatedAt.getTime()||current.status!==s.status)refuse("The schedule changed while you were editing. Refresh and try again.",409);
    for(const r of group){const fresh=await tx.scheduleSlot.findUnique({where:{id:r.id}});if(!fresh||fresh.updatedAt.getTime()!==r.updatedAt.getTime())refuse("This slot changed while you were editing. Refresh and try again.",409);}
    const mate=episodeId?rows.find(r=>r.episodeId===episodeId&&r.position!==row!.position):null;
    if(mate)await tx.scheduleSlot.updateMany({where:{scheduleId:id,position:mate.position},data:{episodeId:row!.episodeId}});
    for(const r of group){const assignedAt=new Date(at.getTime()+(r.platform==="instagram"?s.instagramOffsetMinutes*60000:0));await tx.scheduleSlot.update({where:{id:r.id},data:{episodeId,assignedAt,status:"pending",note:null,controlState:r.controlState==="cancelled"?"active":r.controlState}});if(r.publishJobId){const prior=jobs.find(j=>j.id===r.publishJobId);const updated=await tx.publishJob.updateMany({where:{id:r.publishJobId,updatedAt:prior?.updatedAt,status:{in:["QUEUED","FAILED","HELD","REQUIRES_CONNECTION","CANCELLED","AWAITING_HUMAN"]},externalId:null,remoteDraftId:null,sessionUrlEnc:null},data:{status:"QUEUED",lastError:null,progress:null,retryAt:null,optionsJson:JSON.stringify({scheduledAt:s.youtubePrivacy==="public"||r.platform==="instagram"?assignedAt.toISOString():null,visibility:s.youtubePrivacy,madeForKids:s.madeForKids,audienceMode:s.boardGrid?"review":undefined,timezone:s.timezone})}});if(updated.count!==1)refuse("This upload started or changed while you were editing. Inspect its current status before changing the time.",409);}}
  });
}

export async function boardAction(userId:string,id:string,action:string,body:Body,options:ActivateOptions={}) {
  const s=await ownedPlan(userId,id);
  if(action==="redraw")return redrawBoard(userId,id,body);
  if(action==="activate"){
    const v=await boardView(userId,id);const errors=[...v.issues,...v.slots.flatMap(t=>t.issues)].filter(i=>i.severity==="error");if(errors.length)refuse(errors.map(i=>i.message).join(" "),409);
    if(v.slots.some(t=>t.conflicts.length))refuse("Resolve the existing-post conflicts before activating.",409);
    return activateSchedule(userId,id,options);
  }
  if(action==="pause"||action==="cancel"){
    if(action==="pause"&&s.status!=="active")refuse("Only an activated schedule can be paused. Drafts must use Activate first.",409);
    return prisma.$transaction(async tx=>{
      const changed=await tx.weeklySchedule.updateMany({where:{id,status:s.status,updatedAt:s.updatedAt},data:{status:action==="pause"?"paused":"cancelled"}});if(!changed.count)refuse("The schedule changed. Refresh before changing its state.",409);
      if(action==="cancel")return cancelUnstarted(tx,id);
      return {stillScheduled:0,stillRunning:0};
    });
  }
  if(action==="resume"){
    if(s.status!=="paused"||s.workflowVersion<2)refuse("Only an explicitly activated, paused schedule can resume. Historical plans require review and explicit activation.",409);
    await prisma.weeklySchedule.update({where:{id},data:{status:"active"}});
    // Use the same queue pass: missed timestamps are held, never replayed in a burst.
    void Promise.all(platforms.map(platform=>runSchedule(id,{...options,platform,automatic:true})));
    return {};
  }
  if(action==="delete"){
    if(!["draft","cancelled"].includes(s.status))refuse("Cancel this schedule before deleting it.",409);
    const busy=await prisma.publishJob.count({where:{status:{in:["PREPARING","UPLOADING"]},id:{in:(await prisma.scheduleSlot.findMany({where:{scheduleId:id}})).flatMap(r=>r.publishJobId?[r.publishJobId]:[])}}});if(busy)refuse("An upload is still running; its plan cannot be deleted.",409);
    await prisma.$transaction([prisma.scheduleSlot.deleteMany({where:{scheduleId:id}}),prisma.weeklySchedule.delete({where:{id}})]);return {};
  }
  if(action==="release-queued"){
    if(body.confirmed!==true)refuse("Confirm cancellation of the unstarted posts.");
    const view=await boardView(userId,id);const ids=view.slots.flatMap(t=>t.conflicts.filter(c=>c.releasable).map(c=>c.jobId));
    const result=await prisma.publishJob.updateMany({where:{id:{in:ids},status:"QUEUED",externalId:null,remoteDraftId:null,sessionUrlEnc:null},data:{status:"CANCELLED",lastError:"Cancelled before upload by the schedule operator."}});return {cancelled:result.count,left:[]};
  }
  return refuse("Unknown schedule action.",404);
}

export async function boardSlotAction(userId:string,id:string,slotId:string,action:string,options:ActivateOptions={}) {
  const s=await ownedPlan(userId,id);if(s.status==="cancelled")refuse("This schedule is cancelled.",409);
  const row=await prisma.scheduleSlot.findFirst({where:{id:slotId,scheduleId:id}});if(!row)refuse("Slot not found.",404);
  if(action==="start-now"){
    if(s.status!=="active"||s.workflowVersion<2)refuse("Activate the schedule explicitly before arming or recovering an individual post.",409);
    if(row!.controlState==="cancelled")refuse("Bring this cancelled post back at a new time first.",409);
    const target=new Date(Math.max(row!.assignedAt.getTime(),Date.now()+25*60000));const local=localParts(target,s.timezone);
    await editBoardSlot(userId,id,slotId,{localDate:local.date,localTime:local.time},true);
    return activateSchedule(userId,id,{...options,onlyPositions:[row!.position]});
  }
  if(!["pause","resume","cancel"].includes(action))refuse("Unknown slot action.",404);
  if(action==="resume"&&(s.status!=="active"||s.workflowVersion<2))refuse("Explicitly activate or resume the schedule first.",409);
  const cancelled=await prisma.$transaction(async tx=>{
    await tx.scheduleSlot.updateMany({where:{scheduleId:id,position:row!.position},data:{controlState:action==="pause"?"paused":action==="cancel"?"cancelled":"active"}});
    return action==="cancel"?cancelUnstarted(tx,id,row!.position):null;
  });
  if(cancelled)return cancelled;
  if(action==="resume")void Promise.all(platforms.map(platform=>runSchedule(id,{...options,platform,automatic:true,onlyPositions:[row!.position]})));
  const group=await prisma.scheduleSlot.findMany({where:{scheduleId:id,position:row!.position}});
  return {stillScheduled:await prisma.publishJob.count({where:{id:{in:group.flatMap(r=>r.publishJobId?[r.publishJobId]:[])},status:"SCHEDULED"}})};
}
