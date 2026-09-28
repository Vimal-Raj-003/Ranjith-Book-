#!/usr/bin/env node
/**
 * Audit every stored ContentIdea against the page text it cites.
 *   node --import tsx scripts/audit-ideas.mjs
 * For each idea: sourcePages and sourceText are present; every ref is inside
 * the book and inside its page; the words the refs point at are exactly the
 * stored sourceText; sourcePages equals the refs' pages. Per book: 14–20
 * ideas (or fewer with the explanatory note), unique keys and titles.
 */
import { prisma } from "../src/lib/db.ts";
import { wordsOf } from "../src/lib/ingest/vision.ts";

const uploads = await prisma.upload.findMany({
  where: { kind: "pdf", status: "DONE" },
  include: { book: true, ideas: { orderBy: { rank: "asc" } }, pages: { orderBy: { pageIndex: "asc" } } },
});
let bad = 0;
for (const u of uploads) {
  const words = u.pages.map((p) => wordsOf(JSON.parse(p.visionText)));
  const problems = [];
  for (const i of u.ideas) {
    const refs = JSON.parse(i.sourceRefs);
    const pages = JSON.parse(i.sourcePages);
    if (!pages.length || !i.sourceText.trim() || !refs.length) problems.push(`#${i.rank} missing source`);
    const inRange = refs.every((r) => r.pageIndex >= 0 && r.pageIndex < words.length && r.startWord >= 0 && r.endWord < words[r.pageIndex].length && r.startWord <= r.endWord);
    if (!inRange) { problems.push(`#${i.rank} ref out of range`); continue; }
    const cited = refs.map((r) => words[r.pageIndex].slice(r.startWord, r.endWord + 1).join(" ")).join(" ");
    if (cited !== i.sourceText.replace(/\n\n/g, " ")) problems.push(`#${i.rank} sourceText differs from cited words`);
    const refPages = [...new Set(refs.map((r) => r.pageIndex))].sort((a, b) => a - b);
    if (JSON.stringify(refPages) !== JSON.stringify(pages)) problems.push(`#${i.rank} sourcePages differ from refs`);
  }
  const notes = JSON.parse(u.notes ?? "[]");
  if (u.ideas.length > 20) problems.push(`${u.ideas.length} ideas (>20)`);
  if (u.ideas.length < 14 && !notes.some((n) => /fewer than 14/.test(n))) problems.push(`${u.ideas.length} ideas with no explanation`);
  if (new Set(u.ideas.map((i) => i.ideaKey)).size !== u.ideas.length) problems.push("duplicate keys");
  if (new Set(u.ideas.map((i) => i.title.toLowerCase())).size !== u.ideas.length) problems.push("duplicate titles");
  bad += problems.length;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${u.book.title} — ${u.pageCount} pages, ${u.ideas.length} ideas${problems.length ? "\n     " + problems.join("\n     ") : ""}`);
}
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
