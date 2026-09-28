#!/usr/bin/env node
/**
 * Where the model time goes, from .bookreel/logs/model-calls.jsonl
 * (written by src/lib/content/cli-metrics.ts on every CLI call).
 *
 *   node scripts/profile-model-calls.mjs [episodeId]
 *
 * Per kind of call: count, wall and API time, input and output tokens, and
 * how much of the output was reasoning rather than the returned answer
 * (answer tokens estimated at ~4 characters each).
 */
import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), ".bookreel", "logs", "model-calls.jsonl");
if (!fs.existsSync(file)) {
  console.log("No model calls recorded yet.");
  process.exit(0);
}
const only = process.argv[2];
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => !only || r.episodeId === only || r.uploadId === only);
const by = new Map();
for (const r of rows) {
  if (!by.has(r.kind)) by.set(r.kind, []);
  by.get(r.kind).push(r);
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`${rows.length} calls${only ? ` for ${only}` : ""}\n`);
console.log("kind".padEnd(18), "n".padStart(3), "wall s".padStart(8), "api s".padStart(8), "in tok".padStart(9), "out tok".padStart(9), "reasoning".padStart(10), "cost $".padStart(8), "failed".padStart(7));
for (const [kind, rs] of [...by.entries()].sort((a, b) => b[1].reduce((s, r) => s + r.wallMs, 0) - a[1].reduce((s, r) => s + r.wallMs, 0))) {
  const out = rs.map((r) => r.outputTokens ?? 0);
  const answer = rs.map((r) => (r.resultChars ?? 0) / 4);
  const reasoning = out.reduce((a, b) => a + b, 0) ? 1 - answer.reduce((a, b) => a + b, 0) / out.reduce((a, b) => a + b, 0) : 0;
  const input = rs.map((r) => (r.inputTokens ?? 0) + (r.cacheCreateTokens ?? 0) + (r.cacheReadTokens ?? 0));
  console.log(
    kind.padEnd(18),
    String(rs.length).padStart(3),
    (mean(rs.map((r) => r.wallMs)) / 1000).toFixed(1).padStart(8),
    (mean(rs.map((r) => r.apiMs ?? 0)) / 1000).toFixed(1).padStart(8),
    Math.round(mean(input)).toString().padStart(9),
    Math.round(mean(out)).toString().padStart(9),
    `${Math.round(Math.max(0, reasoning) * 100)}%`.padStart(10),
    rs.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(3).padStart(8),
    String(rs.filter((r) => !r.ok).length).padStart(7),
  );
}
