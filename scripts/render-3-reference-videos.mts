import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { AUDIO_OFFSET, buildComposition, OUTRO_TAIL } from "../src/lib/video/composition/build";
import { bookThemeById, type BookThemeId } from "../src/lib/video/composition/themes";
import { synthesizeVoiceover } from "../src/lib/media/tts";
import { timeNarration } from "../src/lib/media/narration-timing";
import { generateCinematicScoreWav } from "../src/lib/media/cinematic-score";
import { generateSfxTrack } from "../src/lib/media/sfx-synth";
import { generateEpisodeVisuals } from "../src/lib/video/visual-engine";
import { releaseComfyVramSafely } from "../src/lib/video/visual-engine/comfyui";
import { renderProject } from "../src/lib/video/render";
import type { Beat, ContentPackage } from "../src/lib/content/schema";
import type { Scene } from "../src/lib/video/scenes/types";
import type { SweepStep, CameraKey } from "../src/lib/video/sweep";

const TARGETS: ReadonlyArray<{ id: string; slug: string; themeId: BookThemeId; musicStyle: string }> = [
  { id: "cmwrjxim90003n6n4xqzhlgg7", slug: "reference-1-blueprint-choices", themeId: "blueprint", musicStyle: "terminal" },
  { id: "cmwrjxite0007n6n43usikgag", slug: "reference-2-marginalia-reveal", themeId: "marginalia", musicStyle: "editorial" },
  { id: "cmwrjxiar0001n6n4dd44aozt", slug: "reference-3-quiet-automatism", themeId: "spotlight", musicStyle: "spotlight" },
];

function mapTime(t: number, oldTotal: number, newTotal: number): number {
  if (oldTotal <= 0) return t;
  return Math.max(0, Math.min(newTotal, +(t * (newTotal / oldTotal)).toFixed(3)));
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, ".bookreel", "renders", "reference");
  await fs.mkdir(outDir, { recursive: true });

  try {
    for (const target of TARGETS) {
      const ep = await prisma.episode.findUnique({
        where: { id: target.id },
        include: { book: true },
      });
      if (!ep || !ep.projectPath || !ep.scenePlan || !ep.visualPlan) {
        throw new Error(`Episode missing required render data: ${target.id}`);
      }

      console.log(`\n=== Preparing ${target.slug} (${ep.title}) ===`);
      const origProj = ep.projectPath;
      const origHtml = await fs.readFile(path.join(origProj, "index.html"), "utf8");
      const pageMatches = [
        ...origHtml.matchAll(/<div class="page" style="top:(\d+)px;width:(\d+)px;height:(\d+)px;"><img src="([^"]+)"/g),
      ].map((m) => {
        const rawSrc = m[4];
        const baseSrc = rawSrc.replace(/@2x(?=\.jpg$)/i, "");
        const hiCandidate = baseSrc.replace(/\.jpg$/i, "@2x.jpg");
        const numMatch = /page-(\d+)/.exec(baseSrc);
        return {
          src: baseSrc,
          hiSrc: hiCandidate,
          width: Number(m[2]),
          height: Number(m[3]),
          pageIndex: numMatch ? Number(numMatch[1]) : 0,
        };
      });

      const parsedScript = JSON.parse(ep.script ?? "[]") as ContentPackage | Beat[];
      const rawBeats: Beat[] = Array.isArray(parsedScript) ? parsedScript : parsedScript.beats ?? [];
      const hashtags: string[] = (() => {
        try {
          const h = JSON.parse(ep.hashtags ?? "[]");
          return Array.isArray(h) ? h : [];
        } catch {
          return [];
        }
      })();

      const pkg: ContentPackage = Array.isArray(parsedScript)
        ? {
            ideaKey: ep.ideaKey ?? "idea",
            title: ep.title ?? "BookReel",
            hook: ep.hook ?? "",
            beats: rawBeats,
            takeaway: [ep.cta ?? ""],
            cta: ep.cta ?? "",
            description: ep.description ?? "",
            hashtags,
          }
        : {
            ...parsedScript,
            title: ep.title || parsedScript.title,
            hook: ep.hook || parsedScript.hook,
            cta: ep.cta || parsedScript.cta,
          };

      const refProj = path.join(cwd, ".bookreel", "projects", target.slug);
      const workDir = path.join(cwd, ".bookreel", "work", target.slug);
      await fs.rm(refProj, { recursive: true, force: true });
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.cp(origProj, refProj, { recursive: true });
      await fs.mkdir(workDir, { recursive: true });

      // 1. Fresh 100% single-speaker Studio Neural voiceover + faster-whisper word alignment
      const beatTexts = pkg.beats.map((b) => b.voiceover);
      console.log(`  [1/4] Synthesizing unified studio voiceover (${beatTexts.length} beats)...`);
      const voice = await synthesizeVoiceover(beatTexts, workDir, "charles");
      const timing = await timeNarration(voice, workDir);
      await fs.copyFile(voice.audioPath, path.join(refProj, "assets", "voice.wav"));

      const oldDuration = Number(ep.durationSec ?? voice.totalDuration);
      const totalDuration = voice.totalDuration;
      const duration = AUDIO_OFFSET + totalDuration + OUTRO_TAIL;
      console.log(`  [Voice OK] duration=${totalDuration.toFixed(2)}s timingSource=${timing.source} words=${timing.words.length}`);

      // 2. Remap sweeps, camera, and scenes onto the freshly timed single-voice clock
      const origVPlan = JSON.parse(ep.visualPlan) as { sweeps: SweepStep[][]; camera: CameraKey[] };
      const sweeps: SweepStep[][] = origVPlan.sweeps.map((beatSteps, bi) => {
        const bAudio = timing.beats[bi];
        if (!beatSteps.length || !bAudio) return [];
        const oldMin = beatSteps[0].start;
        const oldMax = Math.max(oldMin + 0.05, beatSteps[beatSteps.length - 1].end);
        const newSpan = Math.max(0.15, bAudio.speechEnd - bAudio.speechStart);
        return beatSteps.map((st) => ({
          box: st.box,
          start: +(bAudio.speechStart + ((st.start - oldMin) / (oldMax - oldMin)) * newSpan).toFixed(3),
          end: +(bAudio.speechStart + ((st.end - oldMin) / (oldMax - oldMin)) * newSpan).toFixed(3),
        }));
      });
      const camera: CameraKey[] = origVPlan.camera.map((ck) => ({
        t: mapTime(ck.t, oldDuration, totalDuration),
        y: ck.y,
      }));

      const origScenes = JSON.parse(ep.scenePlan) as Scene[];
      const mappedScenes: Scene[] = [];
      for (let si = 0; si < origScenes.length; si++) {
        const s = origScenes[si];
        const start = si === 0 ? 0 : mappedScenes[si - 1].end;
        const end = si === origScenes.length - 1 ? totalDuration : mapTime(s.end, oldDuration, totalDuration);
        const safeEnd = Math.max(start + 0.6, end);
        const sceneWords = timing.words
          .filter((w) => w.start >= start - 0.08 && w.start < safeEnd + 0.05)
          .map((w) => ({ word: w.word, start: w.start, end: w.end }));
        const wasOldMotion =
          s.kind === "icon-concept" ||
          s.kind === "steps" ||
          s.kind === "timeline" ||
          s.kind === "growth-curve" ||
          s.kind === "comparison" ||
          s.kind === "stat";
        mappedScenes.push({
          ...s,
          kind: wasOldMotion ? "kinetic-text" : s.kind,
          icons: undefined,
          items: undefined,
          steps: undefined,
          curve: undefined,
          left: undefined,
          right: undefined,
          stat: undefined,
          start,
          end: safeEnd,
          words: sceneWords.length > 0 ? sceneWords : s.words,
          // Clear old plates so generateEpisodeVisuals builds fresh, story-matched Hi-Res cinema plates!
          cine: s.cine ? { ...s.cine, plate: undefined } : undefined,
          bgImageSrc: undefined,
        });
      }

      // 3. Generate fresh story-matched AI Visual Director + Hi-Res ComfyUI 2.5D cinema plates + animated comparison/example cards
      const theme = bookThemeById(target.themeId);
      console.log(`  [2/4] Directing story-matched visuals & Hi-Res ComfyUI plates (theme=${theme.id})...`);
      const visualOut = await generateEpisodeVisuals({
        episodeId: target.slug,
        bookTitle: ep.book.title,
        author: ep.book.authorVerified ? ep.book.author : null,
        archetype: ep.book.archetype,
        pkg,
        scenes: mappedScenes,
        theme,
        engine: "hybrid-cinematic",
        localAnalysisOnly: false,
        offlineReferences: true,
      });

      for (const asset of visualOut.projectAssets) {
        await fs.copyFile(asset.from, path.join(refProj, "assets", asset.to));
      }
      await releaseComfyVramSafely().catch(() => false);
      console.log(`  [Visuals OK] copied ${visualOut.projectAssets.length} plate/depth assets`);

      // 4. Generate ducked cinematic music bed + Earshot foley SFX
      console.log(`  [3/4] Synthesizing ducked cinematic score + Earshot SFX...`);
      const musicPath = path.join(refProj, "assets", "music.wav");
      const hasMusic = await generateCinematicScoreWav(duration, musicPath, {
        style: target.musicStyle,
        voicePath: voice.audioPath,
        voiceOffsetSec: AUDIO_OFFSET,
        targetMeanDb: -25,
      }).then(() => true, () => false);

      const allStrokes = sweeps.flatMap((steps) => steps.map((st) => ({ start: st.start, end: st.end })));
      const speechSpans = timing.words.map((w) => ({ start: w.start, end: w.end }));
      const sfxOut = await generateSfxTrack({
        durationSec: duration,
        audioOffsetSec: AUDIO_OFFSET,
        scenes: visualOut.scenes,
        strokes: allStrokes,
        speechSpans,
        outPath: path.join(refProj, "assets", "sfx.wav"),
      });

      // 5. Build upgraded composition & render MP4
      const upgradedHtml = buildComposition({
        pkg,
        beats: timing.beats,
        captions: timing.captions,
        pages: pageMatches,
        sweeps,
        camera,
        theme,
        totalDuration,
        music: hasMusic,
        sfx: sfxOut.cues.length > 0,
        viralCaptions: true,
        bookTitle: ep.book.title,
        author: ep.book.authorVerified ? ep.book.author : null,
        bookLink: ep.book.bookLink,
        scenes: visualOut.scenes,
      });

      await fs.writeFile(path.join(refProj, "index.html"), upgradedHtml, "utf8");

      const outMp4 = path.join(outDir, `${target.slug}.mp4`);
      const t0 = Date.now();
      console.log(
        `  [4/4 Render START] ${target.slug} (${totalDuration.toFixed(1)}s, quality=high, theme=${theme.id}, sfxCues=${sfxOut.cues.length}, earshotSyncOk=${sfxOut.syncReport.ok})`,
      );
      await renderProject(refProj, outMp4, "high", "local", 1);
      const stat = await fs.stat(outMp4);
      console.log(
        `  [Render DONE] ${outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
