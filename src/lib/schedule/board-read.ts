/** RepoReel page contracts over BookReel's existing jobs and slots. Read-only. */
import fs from "node:fs/promises";
import path from "node:path";
import type { PublishJob, ScheduleSlot, WeeklySchedule } from "@prisma/client";
import { prisma } from "@/lib/db";
import { publishingReadiness } from "@/lib/publish/state";
import { AppError } from "@/lib/errors";
import { RENDER_DIR, WORK_ROOT } from "@/lib/paths";
import { publishingEnabled } from "@/lib/publish/execution";
import { expectedHandle } from "@/lib/publish/identity";
import { parseThumbnails } from "@/lib/thumbnails";
import { connectionFor } from "@/lib/publish/youtube/accounts";
import { checkAgainst, checkSlots, DEFAULT_WINDOWS, type SlotTime, type TimeWindow } from "./plan";
import { localParts } from "./reference-time";
import type { Candidate, GeneratedVideo, JobSummary, JobView, Platform, PlatformState, ScheduleView, SlotView, VideoPage } from "./board-types";

export const platforms: Platform[] = ["youtube", "instagram"];
export const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
export const planName = (s: WeeklySchedule) => s.name || `Week of ${s.weekStart.toISOString().slice(0, 10)}`;
export const planWindows = (s: WeeklySchedule): TimeWindow[] => json(s.windowsJson, DEFAULT_WINDOWS);
export const perDay = (s: WeeklySchedule) => Math.max(1, json<string[]>(s.timeSlots, []).length);
export async function ownedPlan(userId: string, id: string) {
  const s = await prisma.weeklySchedule.findFirst({ where: { id, userId } });
  if (!s) throw new AppError("not_found", "Schedule not found.", 404);
  return s;
}
export const toTime = (slot: ScheduleSlot, s: WeeklySchedule): SlotTime => ({key: slot.id, day: Math.floor(slot.position / perDay(s)), position: slot.position % perDay(s) + 1, localDate: localParts(slot.assignedAt,s.timezone).date, localTime: localParts(slot.assignedAt,s.timezone).time, scheduledAt: slot.assignedAt});

export function jobStatus(job: PublishJob): string {
  return ({QUEUED: "SCHEDULED", PREPARING: "PUBLISHING", UPLOADING: "PUBLISHING", PUBLISHED: "POSTED", SCHEDULED: "PLATFORM_SCHEDULED", REQUIRES_CONNECTION: "FAILED", READY: "DRAFT", HELD: "DRAFT"} as Record<string,string>)[job.status] ?? job.status;
}
export function jobView(job: PublishJob, slot?: ScheduleSlot, plan?: WeeklySchedule): JobView {
  const options = json<{scheduledAt?: string}>(job.optionsJson, {});
  const native = !!options.scheduledAt || (!!slot && (job.platform === "instagram" || plan?.youtubePrivacy === "public"));
  const paused=job.status==="QUEUED"&&(plan?.status==="paused"||slot?.controlState==="paused");
  const preUpload = !(job.externalId || job.remoteDraftId || job.sessionUrlEnc);
  return {id: job.id, platform: job.platform, status: paused?"DRAFT":jobStatus(job), error: paused?"Paused locally. Resume the activated schedule and slot to continue.":job.lastError || job.progress, remoteUrl: job.externalUrl,
    startAt: job.retryAt?.toISOString() ?? (native ? job.createdAt : slot?.assignedAt)?.toISOString() ?? null,
    publishAt: options.scheduledAt ?? slot?.assignedAt.toISOString() ?? null, startedAt: job.preparedAt?.toISOString() ?? null,
    lastAttemptAt: job.preparedAt?.toISOString() ?? null, updatedAt: job.updatedAt.toISOString(), postedAt: job.publishedAt?.toISOString() ?? null,
    attempts: job.attempts, nativeSchedule: native, platformStatus: job.status === "SCHEDULED" ? "scheduled" : job.privacyStatus,
    platformPublishAt: job.scheduledFor?.toISOString() ?? null, preUpload};
}
export function platformState(platform: Platform, job: PublishJob | undefined, slot?: ScheduleSlot, plan?: WeeklySchedule): PlatformState {
  const enabled = publishingEnabled(platform);
  const protectedRemote = !!(job?.externalId || job?.remoteDraftId || job?.sessionUrlEnc);
  const blocked = !!job && (protectedRemote || ["QUEUED","PREPARING","UPLOADING","SCHEDULED","PUBLISHED","AWAITING_HUMAN","HELD"].includes(job.status));
  const kind = !enabled ? "disabled" : job?.status === "SCHEDULED" ? "platform-scheduled" : job?.status === "PUBLISHED" ? "posted" : job?.status === "AWAITING_HUMAN" || protectedRemote ? "waiting-on-you" : job?.status === "QUEUED" ? (slot ? "scheduled-post" : "immediate-queued") : "immediate-publishing";
  const reason = !enabled ? "Instagram publishing is disabled. YouTube can proceed independently." : blocked ? `${platform === "youtube" ? "YouTube" : "Instagram"}: ${job?.status === "PUBLISHED" ? "already published" : job?.status === "SCHEDULED" ? "already scheduled on the platform" : protectedRemote ? "an upload already exists; inspect it before retrying" : job?.status === "AWAITING_HUMAN" ? "waiting for your review" : "a post is already queued or running"}.` : null;
  const view = job ? jobView(job, slot, plan) : null;
  const summary: JobSummary | null = view && job ? {id: job.id, mode: job.mode ?? "api", status: view.status, scheduledAt: view.startAt, publishAt: view.publishAt, remoteUrl: view.remoteUrl, error: view.error, attempts: job.attempts, postedAt: view.postedAt, createdAt: job.createdAt.toISOString(), nativeSchedule: view.nativeSchedule, slotId: slot?.id ?? null, platformStatus: view.platformStatus, platformPublishAt: view.platformPublishAt} : null;
  const status = !job ? (enabled ? "none" : "disabled") : ({QUEUED: "queued", PREPARING: "publishing", UPLOADING: "publishing", PUBLISHED: "published", SCHEDULED: "scheduled-on-platform", AWAITING_HUMAN: "needs-you", FAILED: "failed", REQUIRES_CONNECTION: "failed", CANCELLED: "cancelled", HELD: "held"} as const)[job.status as "QUEUED"] ?? "held";
  return {platform, status:job?.status==="QUEUED"&&view?.status==="DRAFT"?"held":status, job: summary, canPublish: enabled && !blocked, blockedReason: reason, blockedKind: reason ? kind : null, executionEnabled: enabled};
}

export async function generatedVideos(userId: string, opts: {ids?: string[]; page?: number; pageSize?: number; q?: string} = {}): Promise<VideoPage & {engines: Record<Platform,{api:boolean;account:string|null}>}> {
  const episodes = await prisma.episode.findMany({where:{userId,status:"DONE",videoPath:{not:null}, ...(opts.ids ? {id:{in:opts.ids.slice(0,100)}} : {})},include:{book:true,publishJobs:true},orderBy:{createdAt:"desc"}});
  // This is the publish picker, not episode history. Filter before pagination
  // and selection counts, using the same assets/readiness rules as publishing.
  const checked = await Promise.all(episodes.map(async e => {
    const ready = await publishingReadiness(e);
    const render = ready.ready ? await fs.stat(path.join(RENDER_DIR, `${e.id}.mp4`)).catch(()=>null) : null;
    return {episode:e,ready,hasRender:!!render?.isFile() && render.size>0};
  }));
  const eligible = checked.filter(e=>e.ready.ready && e.hasRender);
  const schedules = await prisma.weeklySchedule.findMany({where:{userId,status:{not:"cancelled"}}});
  const allSlots = await prisma.scheduleSlot.findMany({where:{scheduleId:{in:schedules.map(s=>s.id)},episodeId:{in:eligible.map(e=>e.episode.id)},controlState:{not:"cancelled"}},orderBy:{assignedAt:"asc"}});
  const items: GeneratedVideo[] = await Promise.all(eligible.map(async ({episode:e,ready}) => {
    const slot = allSlots.find(s=>s.episodeId===e.id && s.platform === "youtube") ?? allSlots.find(s=>s.episodeId===e.id);
    const plan = schedules.find(s=>s.id===slot?.scheduleId);
    const states = Object.fromEntries(platforms.map(p=>[p,platformState(p,e.publishJobs.find(j=>j.platform===p),allSlots.find(s=>s.episodeId===e.id && s.platform===p),plan)])) as Record<Platform,PlatformState>;
    const file = {ok:e.status==="DONE" && (ready.videoBytes??0)>0,bytes:ready.videoBytes,problem:e.status!=="DONE" ? "Video generation has not completed." : !ready.videoBytes ? "The generated video file is missing or empty." : null};
    const selectable = ready.ready && platforms.some(p=>states[p].canPublish);
    const thumbs = parseThumbnails(e);
    const real = (await Promise.all(thumbs.map(async t=>(await fs.stat(t.path).catch(()=>null))?.size ? t : null))).filter(t=>t!==null);
    const selected = real.find(t=>t.key===e.thumbChoice) ?? real.find(t=>t.aspect===e.format) ?? real[0];
    const url = (key:string,rev:number)=>`/api/episodes/${e.id}/thumbnail/${encodeURIComponent(key)}?v=${rev}`;
    return {id:e.id,title:e.title||e.book.title,repo:e.book.title,repoUrl:"",format:e.format==="9:16"?"vertical":"landscape",createdAt:e.createdAt.toISOString(),durationSec:e.durationSec,status:e.status,detail:e.error||e.step,file,
      thumbnailUrl:selected?url(selected.key,selected.rev):"",thumbnail:e.status==="DONE"?{shape:e.format==="9:16"?"vertical":"landscape",selected:selected?.key??null,options:real.map(t=>({id:t.key,name:`${t.variant} · ${t.aspect}`,why:`BookReel ${t.variant} poster`,preview:t.aspect==="9:16"?"vertical":"landscape",url:url(t.key,t.rev)})),message:real.length<2?"Only one thumbnail available":null}:null,
      videoUrl:file.ok?`/api/episodes/${e.id}/video`:null,platforms:states,selectable,reason:!ready.ready?ready.issues.map(i=>i.message).join(" "):!selectable?states.youtube.blockedReason:null,
      schedule:slot&&plan?{id:plan.id,name:planName(plan),status:plan.status.toUpperCase(),timezone:plan.timezone,youtubePrivacy:plan.youtubePrivacy,slotAt:slot.assignedAt.toISOString(),localDate:localParts(slot.assignedAt,plan.timezone).date,localTime:localParts(slot.assignedAt,plan.timezone).time}:null};
  }));
  const size = Math.min(48,Math.max(1,Math.floor(opts.pageSize||12)));
  const matches = items.filter(v=>!opts.q || `${v.title} ${v.repo}`.toLocaleLowerCase().includes(opts.q.toLocaleLowerCase()));
  const pages = Math.max(1,Math.ceil(matches.length/size)), page=Math.min(pages,Math.max(1,Math.floor(opts.page||1)));
  const connection = await connectionFor(userId);
  return {items:opts.ids?items:matches.slice((page-1)*size,page*size),total:matches.length,page,pageSize:size,pages,selectableIds:items.filter(v=>v.selectable).map(v=>v.id),engines:{youtube:{api:connection.connected,account:expectedHandle("youtube",process.env)},instagram:{api:false,account:expectedHandle("instagram",process.env)}}};
}

export async function listBoardPlans(userId:string) {
  const plans = await prisma.weeklySchedule.findMany({where:{userId},orderBy:{createdAt:"desc"}});
  const slots = await prisma.scheduleSlot.findMany({where:{scheduleId:{in:plans.map(s=>s.id)}}});
  return plans.map(s=>{const cells=slots.filter(t=>t.scheduleId===s.id);return {id:s.id,name:planName(s),status:s.status.toUpperCase(),startDate:s.weekStart.toISOString().slice(0,10),days:s.days,slots:new Set(cells.map(t=>t.position)).size,withVideo:new Set(cells.filter(t=>t.episodeId).map(t=>t.position)).size};});
}

export async function boardView(userId:string,id:string):Promise<ScheduleView> {
  const s = await ownedPlan(userId,id);
  const [rows,jobs,otherPlans] = await Promise.all([
    prisma.scheduleSlot.findMany({where:{scheduleId:id},orderBy:{position:"asc"}}),
    prisma.publishJob.findMany({where:{episode:{userId}}}),prisma.weeklySchedule.findMany({where:{userId,id:{not:id},status:{in:["draft","active","paused"]}}})]);
  // Candidates span the entire library, not only the first gallery page.
  const episodeRows = await prisma.episode.findMany({where:{userId,status:"DONE"},include:{book:true}});
  const foreign = await prisma.scheduleSlot.findMany({where:{scheduleId:{in:otherPlans.map(p=>p.id)},controlState:{not:"cancelled"},episodeId:{not:""}}});
  const ready = new Map(await Promise.all(episodeRows.map(async e=>[e.id,await publishingReadiness(e)] as const)));
  const candidates:Candidate[]=[], unavailable:ScheduleView["unavailable"]=[];
  for (const e of episodeRows) {
    const existing = jobs.find(j=>j.episodeId===e.id && publishingEnabled(j.platform as Platform) && !platformState(j.platform as Platform,j).canPublish);
    const reserved = foreign.find(t=>t.episodeId===e.id && publishingEnabled(t.platform as Platform));
    if(existing||reserved){unavailable.push({id:e.id,title:e.title||e.book.title,repo:e.book.title,kind:reserved?"in-schedule":platformState(existing!.platform as Platform,existing!).blockedKind!,message:reserved?"In another saved schedule.":platformState(existing!.platform as Platform,existing!).blockedReason!});continue;}
    candidates.push({id:e.id,title:e.title||e.book.title,owner:"",repo:e.book.title,format:e.format==="9:16"?"vertical":"landscape",createdAt:e.createdAt.toISOString(),hasPlatformCopy:!!e.igCaption,hasThumbnail:!!e.thumbnails,problems:ready.get(e.id)!.issues.map(i=>i.message)});
  }
  const cells = [...new Set(rows.map(r=>r.position))].map(position=>rows.filter(r=>r.position===position));
  const slots:SlotView[] = cells.map(group=>{
    const row=group.find(r=>r.platform==="youtube")??group[0], e=episodeRows.find(e=>e.id===row.episodeId);
    const t=toTime(row,s);
    const conflicts:SlotView["conflicts"]=[];
    const slotJobs=Object.fromEntries(platforms.map(p=>{
      const sr=group.find(r=>r.platform===p);
      const job=jobs.find(j=>j.id===sr?.publishJobId);
      const other=jobs.find(j=>j.episodeId===row.episodeId && j.platform===p && j.id!==job?.id);
      if(s.status==="draft"&&other&&publishingEnabled(p)){const state=platformState(p,other);if(!state.canPublish) conflicts.push({platform:p,kind:state.blockedKind!,message:state.blockedReason!,jobId:other.id,releasable:other.status==="QUEUED"&&!other.remoteDraftId&&!other.sessionUrlEnc&&!other.externalId&&!foreign.some(f=>f.publishJobId===other.id)});}
      return [p,job?jobView(job,sr,s):null];
    })) as SlotView["jobs"];
    return {id:row.id,day:t.day,position:t.position,localDate:t.localDate,localTime:t.localTime,scheduledAt:row.assignedAt.toISOString(),status:!row.episodeId?"SKIPPED":row.controlState==="cancelled"||s.status==="cancelled"?"CANCELLED":row.controlState==="paused"||s.status==="paused"?"PAUSED":s.status==="draft"?"PLANNED":"ACTIVE",creation:e?{id:e.id,title:e.title||e.book.title,owner:"",repo:e.book.title,format:e.format==="9:16"?"vertical":"landscape",hasPlatformCopy:!!e.igCaption,hasThumbnail:!!e.thumbnails}:null,jobs:slotJobs,issues:[],conflicts};
  });
  const times=rows.filter(r=>r.episodeId&&r.platform==="youtube"&&r.controlState!=="cancelled").map(r=>toTime(r,s));
  const issues = s.status==="draft" ? checkSlots(times,{now:new Date(),timezone:s.timezone,windows:s.boardGrid?planWindows(s):[],endInclusive:s.endInclusive,minGapMinutes:30,minAheadMinutes:15}) : [];
  if(s.status==="draft"){
    issues.push(...checkAgainst(times,foreign.filter(f=>f.platform==="youtube").map(f=>toTime(f,otherPlans.find(p=>p.id===f.scheduleId)!)),30));
    for(const cell of slots){cell.issues=issues.filter(i=>i.key===cell.id);const assigned=rows.find(r=>r.id===cell.id);if(assigned?.episodeId&&!cell.creation)cell.issues.push({key:cell.id,severity:"error",message:"The assigned video is no longer available. Choose another video or an empty slot."});else if(cell.creation)cell.issues.push(...ready.get(cell.creation.id)!.issues.map(i=>({key:cell.id,severity:"error" as const,message:i.message})));}
    const empty=slots.filter(t=>!t.creation).length;if(empty)issues.push({key:"schedule",severity:"warning",message:`${empty} slots have no video and will be skipped when this is activated.`});
    issues.push({key:"schedule",severity:"warning",message:s.youtubePrivacy==="public"?"YouTube visibility is Public: activating uploads each video ahead and schedules its future publication on YouTube.":`YouTube visibility is ${s.youtubePrivacy}: the worker uploads at each assigned time; it does not create a public native schedule.`});
  }
  const allJobs=slots.flatMap(t=>Object.values(t.jobs)).filter((j):j is JobView=>!!j);
  const present=async(p:string)=> (await fs.readdir(path.join(WORK_ROOT,"browser-profiles",p)).catch(()=>[])).length>0;
  return {id:s.id,name:planName(s),timezone:s.timezone,status:s.status.toUpperCase(),startDate:s.weekStart.toISOString().slice(0,10),days:s.days,windows:planWindows(s),endInclusive:s.endInclusive,seed:s.seed,leadMinutes:20,instagramOffsetMinutes:s.instagramOffsetMinutes,youtubePrivacy:s.youtubePrivacy,youtubeChannel:expectedHandle("youtube",process.env),youtubeNative:s.youtubePrivacy==="public",minGapMinutes:30,missGraceMinutes:45,activatedAt:s.activatedAt?.toISOString()??null,slots,issues,candidates,unavailable,releasable:slots.flatMap(t=>t.conflicts).filter(c=>c.releasable).length,profiles:{youtube:await present("youtube"),instagram:await present("instagram")},counts:{slots:slots.length,withVideo:slots.filter(t=>t.creation).length,jobs:allJobs.length,posted:allJobs.filter(j=>j.status==="POSTED").length,scheduledOnPlatform:allJobs.filter(j=>j.status==="PLATFORM_SCHEDULED").length,failed:allJobs.filter(j=>j.status==="FAILED").length,waiting:allJobs.filter(j=>j.status==="AWAITING_HUMAN").length},madeForKids:s.madeForKids,instagramEnabled:publishingEnabled("instagram"),workerEnabled:process.env.BOOKREEL_SCHEDULE_WORKER_ENABLED==="1",workflowVersion:s.workflowVersion};
}
