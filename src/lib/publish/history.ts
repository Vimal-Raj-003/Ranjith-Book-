import { prisma } from "@/lib/db";

/** One receipt per actual attempt, updated at completion; never stores credentials. */
export async function recordAttempt(episodeId:string,platform:string):Promise<void> {
  const job=await prisma.publishJob.findUnique({where:{episodeId_platform:{episodeId,platform}}});
  if(!job || job.attempts<1)return;
  const done=!["PREPARING","UPLOADING","QUEUED"].includes(job.status);
  const data={episodeId,platform,status:job.status,message:job.lastError||job.progress,externalUrl:job.externalUrl,scheduledFor:job.scheduledFor,finishedAt:done?new Date():null};
  await prisma.publishAttempt.upsert({where:{jobId_attempt:{jobId:job.id,attempt:job.attempts}},create:{jobId:job.id,attempt:job.attempts,startedAt:job.preparedAt??job.createdAt,...data},update:data});
}
