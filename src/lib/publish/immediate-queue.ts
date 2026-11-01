/** Explicit Publish-now jobs, consumed by the same opt-in schedule worker. No timer here. */
import { prisma } from "@/lib/db";
import { startBrowserPublish } from "./browser/run";
import { startYouTubePublish } from "./youtube/run";
import { publishingEnabled } from "./execution";
import type { PublishRequest } from "./contract";
import type { RunScheduleOptions } from "@/lib/schedule/activate";

const globals=globalThis as unknown as {bookreelImmediateLanes?:Set<string>};
const lanes=(globals.bookreelImmediateLanes??=new Set());
export async function runImmediateQueue(options:RunScheduleOptions={},onlyIds?:string[]):Promise<void> {
  await Promise.all((["youtube","instagram"] as const).map(async platform=>{
    if(lanes.has(platform)||!publishingEnabled(platform,options.env??process.env))return;
    lanes.add(platform);
    try {
      const jobs=await prisma.publishJob.findMany({where:{platform,...(onlyIds?{id:{in:onlyIds}}:{}),OR:[{status:"QUEUED"},{status:"FAILED",mode:"api",retryAt:{lte:new Date()}}]},include:{episode:{select:{userId:true}}},orderBy:{createdAt:"asc"}});
      for(const job of jobs){
        let saved:{queueOrigin?:string;confirmPublic?:boolean;madeForKids?:boolean;visibility?:"private"|"unlisted"|"public";frozenRequest?:PublishRequest};try{saved=JSON.parse(job.optionsJson??"{}");}catch{continue;}
        if(saved.queueOrigin!=="operator-immediate"||saved.confirmPublic!==true||!job.episode.userId)continue;
        // A changed/cancelled row is never reclaimed from a stale list snapshot.
        const current=await prisma.publishJob.findUnique({where:{id:job.id}});if(!current||!["QUEUED","FAILED"].includes(current.status)||current.externalId)continue;
        try {
          if(platform==="youtube"&&job.mode==="api")await startYouTubePublish(job.episode.userId,job.episodeId,{...options,queueOrigin:"operator-immediate",madeForKids:saved.madeForKids,frozenRequest:saved.frozenRequest,waitForCompletion:true});
          else await startBrowserPublish(job.episode.userId,job.episodeId,platform,{...options,...saved,queueOrigin:"operator-immediate",waitForCompletion:true});
        }catch(error){await prisma.publishJob.updateMany({where:{id:job.id,status:"QUEUED"},data:{status:"FAILED",lastError:error instanceof Error?error.message:"The queued post could not start."}});}
        const after=await prisma.publishJob.findUnique({where:{id:job.id}});
        if(after?.status==="AWAITING_HUMAN"||after?.status==="REQUIRES_CONNECTION")break;
      }
    }finally{lanes.delete(platform);}
  }));
}
