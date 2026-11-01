/** Additive local migration. No records, statuses, credentials or jobs are rewritten. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import nextEnv from "@next/env";
import {PrismaClient} from "@prisma/client";

nextEnv.loadEnvConfig(process.cwd(),true,{info(){},error(){}});
const db=new PrismaClient();
const additions={WeeklySchedule:{boardGrid:"BOOLEAN NOT NULL DEFAULT false",name:"TEXT NOT NULL DEFAULT ''",youtubePrivacy:"TEXT NOT NULL DEFAULT 'public'",activatedAt:"DATETIME"},ScheduleSlot:{controlState:"TEXT NOT NULL DEFAULT 'active'"}};
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const tables=["Book","Upload","Episode","ContentIdea","PublishJob","WeeklySchedule","ScheduleSlot"];
try{
  const originals=new Map(),statements=[];
  for(const table of tables){const columns=(await db.$queryRawUnsafe(`PRAGMA table_info(${quote(table)})`)).map(c=>c.name);originals.set(table,columns);}
  for(const [table,columns] of Object.entries(additions))for(const [name,definition] of Object.entries(columns))if(!originals.get(table).includes(name))statements.push(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(name)} ${definition}`);
  const exists=await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name='PublishAttempt'");
  if(!exists.length)statements.push('CREATE TABLE "PublishAttempt" ("id" TEXT NOT NULL PRIMARY KEY,"jobId" TEXT NOT NULL,"attempt" INTEGER NOT NULL,"episodeId" TEXT NOT NULL,"platform" TEXT NOT NULL,"status" TEXT NOT NULL,"message" TEXT,"externalUrl" TEXT,"scheduledFor" DATETIME,"startedAt" DATETIME NOT NULL,"finishedAt" DATETIME)');
  statements.push('CREATE UNIQUE INDEX IF NOT EXISTS "PublishAttempt_jobId_attempt_key" ON "PublishAttempt"("jobId","attempt")','CREATE INDEX IF NOT EXISTS "PublishAttempt_episodeId_idx" ON "PublishAttempt"("episodeId")');
  if(!process.argv.includes("--apply")){console.log(JSON.stringify({mode:"preview",statements},null,2));process.exitCode=0;}
  else{
    const fingerprint=async()=>{const result={};for(const [table,columns] of originals){if(!columns.length)continue;const rows=await db.$queryRawUnsafe(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY "id"`);result[table]={rows:rows.length,sha256:crypto.createHash("sha256").update(JSON.stringify(rows,(_k,v)=>typeof v==="bigint"?v.toString():v)).digest("hex")};}return result;};
    const before=await fingerprint();
    const dir=path.resolve(".bookreel/backups");fs.mkdirSync(dir,{recursive:true});const backup=path.join(dir,`before-weekly-board-${Date.now()}.db`);
    await db.$executeRawUnsafe("VACUUM INTO ?",backup);
    await db.$transaction(async tx=>{for(const sql of statements)await tx.$executeRawUnsafe(sql);},{timeout:30000});
    const after=await fingerprint();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error("Original data fingerprint changed. Keep the backup and inspect before starting the application.");
    const report={applied:true,backup,originalRowsUnchanged:true,tables:after,statements:statements.length};
    fs.writeFileSync(path.resolve(".bookreel/weekly-migration.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }
}finally{await db.$disconnect();}
