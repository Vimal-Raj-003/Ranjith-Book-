#!/usr/bin/env node
/**
 * Re-voice, re-time and re-render a finished episode's EXACT approved script,
 * as a new episode of the same idea — without writing (or re-grounding) a
 * new script.
 *
 *   node --import tsx scripts/rerender-episode.mjs <episodeId>
 *
 * For comparing a pipeline change (e.g. word timing) on identical narration.
 * The original episode and its video are left untouched; the copy gets its
 * own `ideaKey` suffix, so a failure releasing "its" reservation can never
 * release the original's claim on the idea.
 *
 * Two fields are not stored on an episode and are rebuilt: `hookKeywords`,
 * from the accent spans in the original's rendered composition; and
 * `takeaway`, which is left empty (it only feeds a thumbnail's sub-line, which
 * falls back to the call to action).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db.ts";
import { runEpisode } from "../src/lib/pipeline.ts";

const id = process.argv[2];
if (!id) {
  console.error("usage: node --import tsx scripts/rerender-episode.mjs <episodeId>");
  process.exit(2);
}
const src = await prisma.episode.findUniqueOrThrow({ where: { id } });
if (src.status !== "DONE" || !src.script) throw new Error(`Episode ${id} has no finished script to re-render.`);

let hookKeywords = [];
if (src.projectPath) {
  const html = await fs.readFile(path.join(src.projectPath, "index.html"), "utf8").catch(() => "");
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  hookKeywords = [...new Set([...html.matchAll(/<span class="hook-key">([^<]*)<\/span>/g)].map((m) => decode(m[1])))];
}
const bookLinkLine = /\n+[^\n]*https?:\/\/\S+\s*$/;

const copy = await prisma.episode.create({
  data: {
    bookId: src.bookId,
    uploadId: src.uploadId,
    userId: src.userId,
    kind: src.kind,
    format: src.format,
    contentIdeaId: src.contentIdeaId,
    ideaKey: `${src.ideaKey ?? src.id}--rerender-${Date.now()}`,
    title: src.title,
    theme: src.theme,
    status: "QUEUED",
    step: "Queued",
    notes: JSON.stringify([`Re-render of episode ${src.id}: same approved script, voiced and timed again.`]),
  },
});
console.log(`re-rendering ${src.id} as ${copy.id} (hook keywords: ${hookKeywords.join(", ") || "none"})`);

const approvedScript = {
  pkg: {
    title: src.title ?? "",
    hook: src.hook ?? "",
    hookKeywords,
    ideaKey: copy.ideaKey,
    beats: JSON.parse(src.script),
    cta: src.cta ?? "",
    // The book link is appended in code on every run; strip the one already there.
    description: (src.description ?? "").replace(bookLinkLine, ""),
    hashtags: src.hashtags ? JSON.parse(src.hashtags) : [],
    takeaway: [],
  },
  report: src.verification ? JSON.parse(src.verification) : null,
  revised: src.revised,
};

const t0 = Date.now();
let failed = null;
try {
  await runEpisode(copy.id, { approvedScript });
} catch (err) {
  failed = err;
}
const done = await prisma.episode.findUniqueOrThrow({ where: { id: copy.id } });
console.log(`${done.status} after ${Math.round((Date.now() - t0) / 1000)} s — ${done.videoPath ?? done.error}`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
