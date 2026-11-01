/** Additive SQLite upgrade; preserves every account, session, job and schedule. */
import path from "node:path";
import fs from "node:fs/promises";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());
const { prisma } = await import("../src/lib/db");
const additions: Record<string, Record<string, string>> = {
  PublishJob: { remoteDraftId: "TEXT", progress: "TEXT", workerPid: "INTEGER", heartbeatAt: "DATETIME", optionsJson: "TEXT", retryAt: "DATETIME" },
  WeeklySchedule: { workflowVersion: "INTEGER NOT NULL DEFAULT 1", windowsJson: "TEXT", seed: "INTEGER NOT NULL DEFAULT 1", endInclusive: "BOOLEAN NOT NULL DEFAULT false", instagramOffsetMinutes: "INTEGER NOT NULL DEFAULT 0" },
  ScheduleSlot: { payloadJson: "TEXT" },
};
try {
  const databases = await prisma.$queryRawUnsafe<{ name: string; file: string }[]>("PRAGMA database_list");
  const database = databases.find(item => item.name === "main")?.file;
  if (!database || path.relative(process.cwd(), database).startsWith("..") || path.isAbsolute(path.relative(process.cwd(), database))) throw new Error("This upgrade only operates on BookReel's SQLite database inside the workspace.");
  const changes: string[] = [];
  for (const [table, columns] of Object.entries(additions)) {
    const existing = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table}")`);
    if (!existing.length) throw new Error(`Missing ${table}; initialize the BookReel schema before this upgrade.`);
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.some(item => item.name === column)) changes.push(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
    }
  }
  console.log(`${changes.length} additive publishing-workflow columns pending.`);
  for (const sql of changes) console.log(sql);
  if (process.argv.includes("--apply") && changes.length) {
    const backup = path.join(process.cwd(), ".bookreel", "backups", `before-publishing-workflow-${Date.now()}.db`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    await prisma.$transaction(async tx => { for (const sql of changes) await tx.$executeRawUnsafe(sql); }, { timeout: 30_000 });
    console.log(`Upgrade complete. Backup: ${path.relative(process.cwd(), backup)}`);
    console.log("Historical schedules retain workflowVersion=1. No job or schedule was activated.");
  }
} finally { await prisma.$disconnect(); }
