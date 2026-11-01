import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { boardView, generatedVideos, listBoardPlans } from "@/lib/schedule/board-read";
import { boardAction, boardSlotAction, createBoardPlan, editBoardSlot, refuse, updateBoardSettings } from "@/lib/schedule/board-store";
import { bulkPublish, jobAction, retryBoardPlan } from "@/lib/schedule/board-publish";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=180;
type Context={params:Promise<{path?:string[]}>};

async function handle(req:Request,ctx:Context) {
  try {
    const user=await requireUser(), parts=(await ctx.params).path??[], [id,action,slotId,slotAction]=parts;
    const url=new URL(req.url);
    if(req.method==="GET"){
      if(!id)return NextResponse.json({schedules:await listBoardPlans(user.id)});
      if(id==="videos")return NextResponse.json(await generatedVideos(user.id,{ids:url.searchParams.has("ids")?url.searchParams.get("ids")!.split(","):undefined,page:Number(url.searchParams.get("page")||1),pageSize:Number(url.searchParams.get("pageSize")||12),q:url.searchParams.get("q")??undefined}));
      if(id==="history"){
        const episodeId=url.searchParams.get("episodeId");if(!episodeId||!await prisma.episode.findFirst({where:{id:episodeId,userId:user.id},select:{id:true}}))refuse("Video not found.",404);
        const attempts=await prisma.publishAttempt.findMany({where:{episodeId:episodeId!},orderBy:{startedAt:"desc"},take:100});
        return NextResponse.json({attempts});
      }
      return NextResponse.json({schedule:await boardView(user.id,id)});
    }
    const raw:unknown=await req.json().catch(()=>({}));if(!raw||typeof raw!=="object"||Array.isArray(raw))refuse("Expected a JSON object.");const body=raw as Record<string,unknown>;
    if(req.method==="POST"){
      if(!id)return NextResponse.json(await createBoardPlan(user.id,body));
      if(id==="bulk")return NextResponse.json(await bulkPublish(user.id,body));
      if(id==="jobs"&&action&&slotId)return NextResponse.json(await jobAction(user.id,action,slotId,body));
      if(action==="slots"&&slotId&&slotAction)return NextResponse.json(await boardSlotAction(user.id,id,slotId,slotAction));
      if(action==="retry")return NextResponse.json(await retryBoardPlan(user.id,id));
      if(action)return NextResponse.json(await boardAction(user.id,id,action,body));
    }
    if(req.method==="PATCH"){
      if(action==="slots"&&slotId)await editBoardSlot(user.id,id,slotId,body);
      else await updateBoardSettings(user.id,id,body);
      return NextResponse.json({schedule:await boardView(user.id,id)});
    }
    if(req.method==="DELETE")return NextResponse.json(await boardAction(user.id,id,"delete",{}));
    return NextResponse.json({error:"Unknown schedule operation."},{status:404});
  }catch(error){return NextResponse.json(errorBody(error),{status:errorStatus(error)});}
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
export const DELETE=handle;
