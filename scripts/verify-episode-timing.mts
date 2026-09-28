/**
 * Verify an episode's word timing end to end: stored timings, subtitles,
 * the SRT against the narration's measured speech onsets, highlight strokes on
 * spoken-word boundaries, and the MP4's format.
 *
 *   npx tsx scripts/verify-episode-timing.mts <episodeId>
 */
import { execFileSync } from "node:child_process";
import { prisma } from "../src/lib/db";
import { FFPROBE, detectSilences } from "../src/lib/media/ffmpeg";
import { AUDIO_OFFSET } from "../src/lib/video/composition/build";
import type { Beat } from "../src/lib/content/schema";
import type { BeatTimingSummary } from "../src/lib/media/narration-timing";
const id = process.argv[2];
const ep = await prisma.episode.findUniqueOrThrow({ where: { id } });
const beats = JSON.parse(ep.script!) as Beat[];
const t = JSON.parse(ep.wordTimings!) as { model: string; perBeat: BeatTimingSummary[]; words: unknown[] };
const words = t.words as { w: string; s: number; e: number; b: number; i: number; src: string }[];
const voiceDur = ep.durationSec!;
const by = (src: string) => words.filter((w) => w.src === src).length;
console.log(`timingSource=${ep.timingSource} model=${t.model} words=${words.length} (audio ${by("audio")}, interpolated ${by("interpolated")}, estimated ${by("estimated")})`);
console.log(`script words=${beats.reduce((n, b) => n + b.voiceover.split(/\s+/).filter(Boolean).length, 0)} · perBeat matched: ${t.perBeat.map((p) => `${p.matched}/${p.total}`).join(" ")}`);
const oob = words.filter((w) => w.s < 0 || w.e > voiceDur + 1e-3 || w.e < w.s);
console.log(`timestamps inside the ${voiceDur.toFixed(2)} s voice track: ${oob.length === 0 ? "all" : oob.length + " OUTSIDE"}; monotonic: ${words.every((w, k) => k === 0 || w.s >= words[k - 1].e - 1e-3)}`);

// Captions come from word times.
const caps = JSON.parse(ep.captions!) as { text: string; start: number; end: number; beatIndex: number; words: { word: string; start: number; end: number }[] }[];
const starts = new Set(words.map((w) => w.s.toFixed(3)));
const capFromWords = caps.filter((c) => starts.has(c.start.toFixed(3))).length;
const sizes = caps.map((c) => c.words.length);
console.log(`captions: ${caps.length} lines, ${capFromWords}/${caps.length} start exactly on a timed word; words per line: ${[1,2,3,4].map((n) => `${n}w×${sizes.filter((s) => s === n).length}`).join(" ")}`);

// SRT: in the video's clock, ordered, non-overlapping, inside the video.
const srt = ep.srt!;
const cues = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)].map((m) => [+m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000, +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000]);
const mp4 = ep.videoPath!;
const vdur = parseFloat(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString());
const offsetOk = cues.every((c, k) => Math.abs(c[0] - (caps[k].start + AUDIO_OFFSET)) < 0.002);
console.log(`SRT: ${cues.length} cues; = caption time + ${AUDIO_OFFSET}s offset: ${offsetOk}; ordered & non-overlapping: ${cues.every((c, k) => c[1] > c[0] && (k === 0 || c[0] >= cues[k - 1][1] - 1e-3))}; last cue ends ${cues.at(-1)![1].toFixed(2)} s of a ${vdur.toFixed(2)} s video`);

// End to end: the narration exactly as mixed into the MP4 (the MP4's own
// audio carries the music bed under it, so it has no silences to measure).
// Its speech onsets after each long pause, shifted by the lead-in, against the SRT.
const rawQuiet = await detectSilences(ep.audioPath!, -38, 0.12);
// A pause the detector reports as two back-to-back silences (split at a clip join) is one pause.
const mergedQuiet: { start: number; end: number }[] = [];
for (const q of rawQuiet) { const l = mergedQuiet.at(-1); if (l && q.start - l.end < 0.03) l.end = q.end; else mergedQuiet.push({ ...q }); }
const quiet = mergedQuiet.filter((q) => q.end - q.start >= 0.45);
const across = caps.filter((c) => mergedQuiet.some((q) => q.end - q.start >= 0.28 && q.start > c.words[0].end - 0.01 && q.end < c.words.at(-1)!.start + 0.01));
console.log(`subtitle lines shown across a measured pause between their own words: ${across.length}`);
const onsets = quiet.map((q) => q.end + AUDIO_OFFSET).filter((x) => x > AUDIO_OFFSET + 0.3 && x < AUDIO_OFFSET + voiceDur - 0.3);
const errs = onsets.map((o) => Math.min(...cues.map((c) => Math.abs(c[0] - o)))).sort((a, b) => a - b);
console.log(`narration: ${onsets.length} speech onsets after pauses >= 0.45 s; nearest SRT cue start: median ${errs[Math.floor(errs.length / 2)]?.toFixed(3)} s, p90 ${errs[Math.floor(errs.length * 0.9)]?.toFixed(3)} s, max ${errs.at(-1)?.toFixed(3)} s`);
const aud = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration", "-of", "csv=p=0", mp4]).toString().trim().replace(/\s+/g, " ");
const vid = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height,r_frame_rate,codec_name", "-of", "csv=p=0", mp4]).toString().trim();
console.log(`MP4: video ${vid} · audio ${aud}`);

// Highlights: every stroke on a spoken-word boundary of its beat.
const vp = JSON.parse(ep.visualPlan!);
let strokes = 0, onBoundary = 0;
vp.sweeps.forEach((steps: { start: number; end: number }[], bi: number) => {
  const bounds = new Set(words.filter((w) => w.b === bi).flatMap((w) => [w.s.toFixed(3), w.e.toFixed(3)]));
  for (const s of steps) { strokes++; if (bounds.has(s.start.toFixed(3)) && bounds.has(s.end.toFixed(3))) onBoundary++; }
});
console.log(`highlights: ${strokes} strokes, ${onBoundary} start AND end exactly on a spoken-word boundary of their beat`);

// Beat timing: speech windows are first/last word.
const beatOk = beats.every((_: unknown, bi: number) => { const bw = words.filter((w) => w.b === bi); return bw.length > 0; });
console.log(`beats: ${beats.length}, every beat timed: ${beatOk}; notes: ${ep.notes}`);
await prisma.$disconnect();
