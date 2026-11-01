/** Explicit page actions delegate to BookReel's existing publishing implementations. */
import { prisma } from "@/lib/db";
import { publishingEnabled } from "@/lib/publish/execution";
import { startBrowserPublish } from "@/lib/publish/browser/run";
import { startYouTubePublish } from "@/lib/publish/youtube/run";
import { recordAttempt } from "@/lib/publish/history";
import { loadPublishRequest } from "@/lib/publish/state";
import { runImmediateQueue } from "@/lib/publish/immediate-queue";
import { recoverInterruptedBrowserJobs } from "@/lib/publish/browser/recover";
import { runSchedule, type RunScheduleOptions } from "./activate";
import { verifyKnown } from "./confirm";
import { generatedVideos, json, ownedPlan, platformState, platforms } from "./board-read";
import { refuse } from "./board-store";
import type { BulkItem, BulkResult, Platform } from "./board-types";

export async function jobAction(userId:string,id:string,action:string,body:Record<string,unknown>={},options:RunScheduleOptions={}) {
  await recoverInterruptedBrowserJobs();
  const job=await prisma.publishJob.findFirst({where:{id,episode:{userId}}});if(!job)refuse("Post not found.",404);
  const j=job!, platform=j.platform as Platform;
  const slot=await prisma.scheduleSlot.findFirst({where:{publishJobId:id}});
  const plan=slot?await ownedPlan(userId,slot.scheduleId):null;
  if(action==="cancel"){
    if(["UPLOADING","PREPARING"].includes(j.status))refuse("This upload is running. Its real outcome must be checked before cancelling.",409);
    if(["SCHEDULED","PUBLISHED"].includes(j.status)&&body.removedOnPlatform!==true)refuse("Cancelling here cannot remove a video on the platform. Delete it there first, then confirm its removal.",409);
    await recordAttempt(j.episodeId,platform);
    const removed=body.removedOnPlatform===true;
    await prisma.publishJob.updateMany({where:{id,updatedAt:j.updatedAt},data:{status:"CANCELLED",retryAt:null,lastError:removed?"Operator confirmed deletion on the platform.":"Cancelled locally; any existing remote upload must still be checked.",...(removed?{externalId:null,externalUrl:null,remoteDraftId:null,sessionUrlEnc:null,scheduledFor:null,publishedAt:null}:{})}});
    if(slot)await prisma.scheduleSlot.updateMany({where:{publishJobId:id},data:{controlState:"cancelled",note:"Cancelled by the operator; this does not remove a remote post."}});
    return {};
  }
  if(!publishingEnabled(platform,options.env??process.env))refuse("Instagram publishing execution is disabled. YouTube is independent.",409);
  if(action==="confirm"){
    if(j.status==="SCHEDULED"||j.status==="PUBLISHED")return {alreadyConfirmed:true};
    const saved=json<{scheduledAt?:string}>(j.optionsJson,{}), remoteId=j.externalId??j.remoteDraftId, at=slot?.assignedAt??(saved.scheduledAt?new Date(saved.scheduledAt):null);
    if(platform!=="youtube"||!remoteId||!at)refuse("This post has no verifiable native YouTube receipt. Inspect the platform and the job details; it has not been marked as published.",409);
    const title=json<{title?:string}>(j.metadata,{}).title;
    if(!title)refuse("The saved upload title is missing; confirmation cannot be matched safely.",409);
    const candidate={userId,mode:j.mode??"browser",remoteId:remoteId!,title:title!,at:at!};
    const ok=await (options.verifyKnownSchedule??(c=>verifyKnown(c,options.env??process.env)))(candidate);
    if(!ok)refuse("The platform did not confirm this video's exact scheduled time. Its status remains unchanged.",409);
    const changed=await prisma.publishJob.updateMany({where:{id,updatedAt:j.updatedAt},data:{status:"SCHEDULED",externalId:remoteId!,externalUrl:`https://youtu.be/${remoteId}`,scheduledFor:at!,publishedAt:null,lastError:null}});
    if(changed.count&&slot)await prisma.scheduleSlot.update({where:{id:slot.id},data:{status:"scheduled",note:"Confirmed by a read-only platform check."}});
    await recordAttempt(j.episodeId,platform);return {confirmed:changed.count===1};
  }
  if(action!=="retry")refuse("Unknown post action.",404);
  const isPreUpload=!j.externalId&&!j.remoteDraftId&&!j.sessionUrlEnc;
  const canRetryPreUpload=isPreUpload&&["CANCELLED","AWAITING_HUMAN"].includes(j.status);
  if((!["FAILED","REQUIRES_CONNECTION"].includes(j.status)&&!canRetryPreUpload)||!isPreUpload)refuse("Only a failed or unstarted pre-upload post can be retried. An uncertain upload must be inspected first.",409);
  if(plan&&slot){
    if(plan.status!=="active"||slot.controlState!=="active")refuse("Resume the active schedule and this slot before retrying.",409);
    // A known remote object must be reconciled, not treated as an absent video.
    if(j.externalId)refuse("The platform already supplied a video ID. Confirm or remove that video before retrying.",409);
    await prisma.scheduleSlot.update({where:{id:slot.id},data:{status:"pending",note:null}});
    const work=runSchedule(plan.id,{...options,platform,onlyPositions:[slot.position],acknowledgeRetry:canRetryPreUpload||options.acknowledgeRetry});
    if(options.makePublisher)await work;else void work;
  }else{
    const saved=json<{scheduledAt?:string;visibility?:"private"|"unlisted"|"public";madeForKids?:boolean;timezone?:string}>(j.optionsJson,{});
    if(j.mode==="api"&&platform==="youtube")await startYouTubePublish(userId,j.episodeId,{scheduledAt:saved.scheduledAt?new Date(saved.scheduledAt):undefined,madeForKids:saved.madeForKids,env:options.env,fetchImpl:options.fetchImpl});
    else await startBrowserPublish(userId,j.episodeId,platform,{...saved,scheduledAt:saved.scheduledAt?new Date(saved.scheduledAt):undefined,confirmPublic:true,acknowledgeRetry:canRetryPreUpload||options.acknowledgeRetry,env:options.env,deps:options.deps,makePublisher:options.makePublisher});
  }
  return {started:true};
}

export async function retryBoardPlan(userId:string,id:string,options:RunScheduleOptions={}) {
  const plan=await ownedPlan(userId,id);if(plan.status!=="active")refuse("Only an active schedule can retry failed posts.",409);
  const slots=await prisma.scheduleSlot.findMany({where:{scheduleId:id,controlState:"active",publishJobId:{not:null}}});
  const issues:{key:string;severity:"error";message:string}[]=[];let started=0,scheduled=0,failed=0,awaitingReview=0,skipped=0;
  for(const slot of slots){
    const job=await prisma.publishJob.findUnique({where:{id:slot.publishJobId!}});
    if(!job||!publishingEnabled(slot.platform as Platform,options.env??process.env)){skipped++;continue;}
    const isPreUpload=!job.externalId&&!job.remoteDraftId&&!job.sessionUrlEnc;
    if(!isPreUpload){
      if(["AWAITING_HUMAN","CANCELLED","FAILED"].includes(job.status)){awaitingReview++;continue;}
      skipped++;continue;
    }
    if(!["FAILED","REQUIRES_CONNECTION","CANCELLED","AWAITING_HUMAN"].includes(job.status)){skipped++;continue;}
    try{await jobAction(userId,job.id,"retry",{},options);started++;if(options.makePublisher){const after=await prisma.publishJob.findUnique({where:{id:job.id}});if(after?.status==="SCHEDULED")scheduled++;else if(after?.status==="AWAITING_HUMAN")awaitingReview++;else if(after?.status==="FAILED")failed++;}}catch(e){failed++;issues.push({key:"schedule",severity:"error",message:e instanceof Error?e.message:"Retry failed."});}
  }
  return {started,scheduled,failed,awaitingReview,skipped,issues};
}

export async function bulkPublish(userId:string,body:Record<string,unknown>,options:RunScheduleOptions={}):Promise<BulkResult> {
  if(body.confirmed!==true)refuse("Review the summary and confirm before publishing.");
  if(!Array.isArray(body.creationIds)||!body.creationIds.length||body.creationIds.length>50||body.creationIds.some(v=>typeof v!=="string"))refuse("Publish at most 50 selected videos at a time.");
  if(!Array.isArray(body.platforms)||!body.platforms.length||body.platforms.some(p=>!platforms.includes(p as Platform)))refuse("Choose YouTube, Instagram or both.");
  const ids=[...new Set(body.creationIds as string[])], wanted=body.platforms as Platform[],items:BulkItem[]=[];
  const videos=(await generatedVideos(userId,{ids})).items;
  const privacy=String(body.youtubePrivacy??"private");if(!["private","unlisted","public"].includes(privacy))refuse("Invalid YouTube visibility.");
  for(const id of ids)for(const platform of platforms.filter(p=>wanted.includes(p))){
    const item:BulkItem={creationId:id,platform,outcome:"rejected",jobId:null,message:null,code:null,kind:null};items.push(item);
    try{
      if(!publishingEnabled(platform,options.env??process.env))refuse("Instagram execution is disabled; YouTube proceeds independently.",409);
      const v=videos.find(v=>v.id===id);if(!v||!v.file.ok)refuse(v?.file.problem??"Video not found or not finished.",409);
      const existing=await prisma.publishJob.findUnique({where:{episodeId_platform:{episodeId:id,platform}}});
      const state=platformState(platform,existing??undefined);if(!state.canPublish){item.outcome="skipped";item.jobId=existing?.id??null;item.message=state.blockedReason;item.kind=state.blockedKind;continue;}
      if(body.publishNow!==true){
        if(!v!.schedule)refuse("No assigned weekly-schedule time. Add the video to a schedule or use Publish now.",409);
        const s=await ownedPlan(userId,v!.schedule!.id);
        if(s.status!=="active")refuse("Activate this draft explicitly before scheduling its posts. Paused plans must be resumed.",409);
        if(platform==="youtube"&&s.youtubePrivacy!=="public")refuse("Only public YouTube plans use native scheduling; private/unlisted posts wait for their assigned time.",409);
        const slot=await prisma.scheduleSlot.findFirst({where:{scheduleId:s.id,episodeId:id,platform,controlState:"active"}});if(!slot)refuse("This platform's slot is cancelled or paused.",409);
        if(slot!.assignedAt.getTime()<Date.now()+20*60000)refuse("The assigned time is past or too near. Reschedule the slot first.",409);
        const work=runSchedule(s.id,{...options,platform,onlyPositions:[slot!.position]});
        if(options.makePublisher)await work;else void work;
      }else{
        if(platform==="youtube"&&typeof body.madeForKids!=="boolean")refuse("Answer whether these YouTube videos are made for kids.");
        const engine=(body.engines as Record<string,unknown>|undefined)?.[platform];
        if(platform==="youtube"&&engine==="api"&&privacy!=="private")refuse("BookReel's immediate YouTube API upload saves Private videos. Choose the browser for Unlisted or Public.",409);
        const {request}=await loadPublishRequest(userId,id,platform);
        const data={status:"QUEUED",mode:platform==="youtube"&&engine==="api"?"api":"browser",lastError:null,metadata:JSON.stringify(request.metadata),optionsJson:JSON.stringify({queueOrigin:"operator-immediate",confirmPublic:true,visibility:privacy,madeForKids:body.madeForKids,frozenRequest:request})};
        if(existing){await recordAttempt(id,platform);const claimed=await prisma.publishJob.updateMany({where:{id:existing.id,updatedAt:existing.updatedAt,externalId:null,remoteDraftId:null,sessionUrlEnc:null,status:{notIn:["QUEUED","PREPARING","UPLOADING","AWAITING_HUMAN","SCHEDULED","PUBLISHED"]}},data});if(!claimed.count)refuse("Another request already claimed this post.",409);}
        else await prisma.publishJob.create({data:{episodeId:id,platform,...data}});
      }
      const job=await prisma.publishJob.findUnique({where:{episodeId_platform:{episodeId:id,platform}}});
      if(!job)refuse("No publishing job was created. The platform was not reported as scheduled.",409);
      item.outcome="started";item.jobId=job!.id;item.message=body.publishNow===true?"Publishing requested; awaiting platform confirmation.":"Scheduling requested for the persisted slot time; awaiting platform confirmation.";
    }catch(e){item.message=e instanceof Error?e.message:"The post could not be started.";}
  }
  if(body.publishNow===true){const work=runImmediateQueue(options,items.filter(i=>i.outcome==="started").flatMap(i=>i.jobId?[i.jobId]:[]));if(options.makePublisher)await work;else void work.catch(e=>console.error("[publish-now queue]",e instanceof Error?e.message:String(e)));}
  return {items,started:items.filter(i=>i.outcome==="started").length,skipped:items.filter(i=>i.outcome==="skipped").length,rejected:items.filter(i=>i.outcome==="rejected").length};
}
