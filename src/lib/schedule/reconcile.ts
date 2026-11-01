import { prisma } from "@/lib/db";

/** Holding an unstarted queue item is not a platform-success transition. */
export async function holdMissedQueueItem(jobId:string|null,note:string):Promise<void> {
  if(!jobId)return;
  await prisma.publishJob.updateMany({where:{id:jobId,status:"QUEUED"},data:{status:"HELD",lastError:note,retryAt:null}});
}
