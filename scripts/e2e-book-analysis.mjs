#!/usr/bin/env node
/**
 * End-to-end: a real PDF through the real book analysis — PyMuPDF, OCR, the
 * embedding model and the configured CLI provider — then an independent check
 * of what came out.
 *
 *   npm run e2e:book -- <file.pdf> ["Book title"]
 *
 * Makes real model calls (about one per 3,500 words, plus one to rank). The
 * upload is kept afterwards, so its ideas can be opened in the app under
 * Book PDFs.
 *
 * Checks, independent of the code that produced them:
 *   - every idea's cited words exist on its cited pages, verbatim;
 *   - 14–20 ideas (or fewer, with a note saying why);
 *   - no two ideas share a key or a title;
 *   - page numbers are inside the book;
 *   - wall time and peak memory, for the long-PDF budget.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createPdfUpload } from "../src/lib/pdf/create-pdf-upload.ts";
import { runBookAnalysis } from "../src/lib/analysis/run.ts";
import { wordsOf } from "../src/lib/ingest/vision.ts";
import { prisma } from "../src/lib/db.ts";

const [file, titleArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run e2e:book -- <file.pdf> ["Book title"]');
  process.exit(2);
}
const title = titleArg || `${path.basename(file, ".pdf")} (e2e ${new Date().toISOString().slice(0, 16)})`;

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 500);

const t0 = Date.now();
const body = Readable.toWeb(fs.createReadStream(file));
const { uploadId } = await createPdfUpload({ title, body }, null);
console.log(`upload ${uploadId} — "${title}"`);

let last = "";
const watch = setInterval(async () => {
  const u = await prisma.upload.findUnique({ where: { id: uploadId }, select: { step: true, progress: true } });
  const line = `${u?.step} ${u?.progress ? JSON.parse(u.progress).label : ""}`;
  if (line !== last) console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);
  last = line;
}, 2000);

let failed = null;
try {
  await runBookAnalysis(uploadId);
} catch (err) {
  failed = err;
}
clearInterval(watch);
clearInterval(sampler);

const upload = await prisma.upload.findUniqueOrThrow({
  where: { id: uploadId },
  include: { ideas: { orderBy: { rank: "asc" } }, pages: { orderBy: { pageIndex: "asc" } }, sections: { orderBy: { index: "asc" } } },
});
const seconds = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\nstatus ${upload.status} after ${seconds}s, peak RSS ${(peakRss / 1024 / 1024).toFixed(0)}MB`);
if (failed) {
  console.log(`error: ${upload.error}`);
  process.exit(1);
}
console.log("stats", upload.stats);
for (const n of JSON.parse(upload.notes ?? "[]")) console.log(`note: ${n}`);
console.log(`\nsections (${upload.sections.length}):`);
for (const s of upload.sections) console.log(`  ${s.skip ? "skip" : "    "} p${s.startPage + 1}-${s.endPage + 1} [${s.source}] ${s.title}`);

const words = upload.pages.map((p) => wordsOf(JSON.parse(p.visionText)));
const problems = [];
console.log(`\nideas (${upload.ideas.length}):`);
for (const idea of upload.ideas) {
  const refs = JSON.parse(idea.sourceRefs);
  const pages = JSON.parse(idea.sourcePages);
  console.log(`\n#${idea.rank} [${idea.score}] ${idea.title}`);
  console.log(`   hook: ${idea.hook}`);
  console.log(`   idea: ${idea.coreIdea}`);
  console.log(`   pages: ${pages.map((p) => p + 1).join(", ")} · ${idea.sectionTitle ?? "?"} · ${idea.angle}`);
  const cited = refs.map((r) => words[r.pageIndex].slice(r.startWord, r.endWord + 1).join(" ")).join(" ");
  const stored = idea.sourceText.replace(/\n\n/g, " ");
  if (cited !== stored) problems.push(`#${idea.rank}: cited words differ from stored source text`);
  for (const r of refs) {
    if (r.pageIndex < 0 || r.pageIndex >= upload.pages.length) problems.push(`#${idea.rank}: page ${r.pageIndex} outside the book`);
    else if (r.startWord < 0 || r.endWord >= words[r.pageIndex].length || r.endWord < r.startWord) problems.push(`#${idea.rank}: bad word range`);
  }
  console.log(`   quote: "${idea.sourceText.split("\n\n")[0].slice(0, 160)}"`);
}
const keys = new Set(upload.ideas.map((i) => i.ideaKey));
const titles = new Set(upload.ideas.map((i) => i.title.toLowerCase()));
if (keys.size !== upload.ideas.length) problems.push("duplicate idea keys");
if (titles.size !== upload.ideas.length) problems.push("duplicate idea titles");
const notes = JSON.parse(upload.notes ?? "[]");
if (upload.ideas.length > 20) problems.push(`${upload.ideas.length} ideas, more than 20`);
if (upload.ideas.length < 14 && !notes.some((n) => /fewer than 14/.test(n))) problems.push("fewer than 14 ideas with no note explaining it");

console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join("\n  ")}` : "\nall checks passed");
await prisma.$disconnect();
process.exit(problems.length ? 1 : 0);
