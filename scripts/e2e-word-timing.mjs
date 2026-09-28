#!/usr/bin/env node
/**
 * How accurate is word timing on a real narration?
 *
 *   node --import tsx scripts/e2e-word-timing.mjs [episodeId] [model ...]
 *
 * Re-voices a finished episode's approved script with Pocket TTS, times it
 * with each speech model given (default: base.en), and scores the result
 * against the recording's measured silences (tests/helpers/audio-truth.mts):
 * raw recogniser output, and after `snapToSound`. The ground truth uses a
 * looser silence setting (-38 dB / 0.12 s) than the correction does
 * (-35 dB / 0.15 s), so the corrected score is not simply the correction
 * grading itself — but both use the same physical signal, so the RAW numbers
 * are the independent measure of the recogniser.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "../src/lib/db.ts";
import { synthesizeVoiceover } from "../src/lib/media/tts.ts";
import { beatTexts } from "../src/lib/content/schema.ts";
import { timeBeat } from "../src/lib/media/word-timing.ts";
import { measureTiming, summarize } from "../tests/helpers/audio-truth.mts";

const [idArg, ...models] = process.argv.slice(2);
const episode = idArg && !idArg.includes(".")
  ? await prisma.episode.findUniqueOrThrow({ where: { id: idArg } })
  : await prisma.episode.findFirstOrThrow({ where: { kind: "idea", status: "DONE" }, orderBy: { createdAt: "desc" } });
const pkgBeats = JSON.parse(episode.script);
const texts = beatTexts({ beats: pkgBeats });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-timing-"));
console.log(`episode ${episode.id}: ${texts.length} beats, ${texts.join(" ").split(/\s+/).length} words`);

const voice = await synthesizeVoiceover(texts, dir);
console.log(`voice ${voice.totalDuration.toFixed(1)} s`);

const fmt = (s) => `mean ${s.mean.toFixed(3)} · median ${s.median.toFixed(3)} · p90 ${s.p90.toFixed(3)} · max ${s.max.toFixed(3)}`;
for (const model of models.length ? models : ["base.en"]) {
  process.env.BOOKREEL_ALIGN_MODEL = model;
  const { timeNarration } = await import("../src/lib/media/narration-timing.ts");
  const t0 = Date.now();
  const timing = await timeNarration(voice, dir);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = JSON.parse(await fs.readFile(path.join(dir, "align-out.json"), "utf8"));
  const raw = voice.beats.flatMap((b, i) => timeBeat(b.index, b.text, out.windows[i].words, { start: b.start, end: b.end }).words);
  const recognised = timing.perBeat.reduce((n, b) => n + b.matched, 0) / timing.words.length;

  console.log(`\n=== ${model} (${secs} s to time ${voice.totalDuration.toFixed(0)} s of audio) — source ${timing.source}, ${Math.round(recognised * 100)}% of words recognised`);
  for (const [label, words] of [["raw recogniser", raw], ["after silence correction", timing.words]]) {
    const acc = await measureTiming(voice.audioPath, voice.totalDuration, timing.beats, words);
    console.log(`  ${label}:`);
    console.log(`    beat onset error   ${fmt(summarize(acc.onsetErrors))}`);
    console.log(`    beat end error     ${fmt(summarize(acc.offsetErrors))}`);
    console.log(`    resume after pause ${fmt(summarize(acc.resumeErrors))} (${acc.internalPauses} pauses)`);
    console.log(`    words spanning a measured pause: ${acc.straddles.length}${acc.straddles.length ? " — " + acc.straddles.slice(0, 3).join("; ") : ""}`);
    console.log(`    out of bounds: ${acc.outOfBounds}`);
  }
}
await fs.rm(dir, { recursive: true, force: true });
await prisma.$disconnect();
