/**
 * 100% Local BookReel ("YT Book") 7-IN-1 COMPLETE OMNI ULTRA REFERENCE RUNNER.
 *
 * Combines ALL 7 video models into ONE cohesive, museum-grade 1080×1920 reference video
 * (`ultra-master-7-in-1.mp4`) using episode `cmwqeq5td000tn6w08pfg1ik6`
 * ("How Scientists Once Tried To Measure Your Will" — 9 beats):
 *
 *   - Beat 0 [Model 7 · Magnates 2.5D Dark Cinema]   : Chiaroscuro 1900s Lab Study 2.5D Plate + Frosted Hook Card
 *   - Beat 1 [Model 4 · 3-in-1 Trifecta Proof]       : Spotlighted @2x Archival Book Scan (p.15) + Marker Sweep + Shutter-Snap
 *   - Beat 2 [Model 3 · Neon Neuro Lab (Ultra-Pro)]  : Bioluminescent Indigo Lab + Two-Glass Spring & Electric Timer Rig
 *   - Beat 3 [Model 1 · VisionOS Bento (Ultra-Pro)]  : Apple VisionOS Frosted Glass Bento + Circuit-Break Millisecond Telemetry Rig
 *   - Beat 4 [Model 2 · Investigative Dossier]       : Dark War-Room + Stamped Manila Verbatim Protocol Quote Card (p.70)
 *   - Beat 5 [Model 6 · Vox Paper-Cutout Explainer]  : Warm Cream Paper Grid + Hard-Shadow 4-Phase Paper-Cutout Checklist
 *   - Beat 6 [Model 5 · Dan Koe Minimalist Vector]   : Pitch-Black Ruled Grid + Live-Drawing Geometric Volition Vector Diagram
 *   - Beat 7 [Model 4 · 3-in-1 Trifecta Comparison]  : Tactile Ivory Dual-Icon Comparison Card over Blurred Dark Cinema Plate
 *   - Beat 8 [Model 7 · Magnates Live 3D Sculpture]  : Live Three.js 3D Brass Chronometer (`HEROES.clock`) + Payoff Riser -> CTA
 *
 * Strictly 100% local (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, zero Gemini / external calls),
 * 100% single-speaker Studio Voice (`charles`), and 20% ducked BGM.
 */
process.env.BOOKREEL_VISUAL_LOCAL_ONLY = "1";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../src/lib/db";
import { AUDIO_OFFSET, buildComposition, OUTRO_TAIL } from "../src/lib/video/composition/build";
import { bookThemeById } from "../src/lib/video/composition/themes";
import { synthesizeVoiceover } from "../src/lib/media/tts";
import { timeNarration } from "../src/lib/media/narration-timing";
import { generateCinematicScoreWav } from "../src/lib/media/cinematic-score";
import { generateSfxTrack } from "../src/lib/media/sfx-synth";
import { generateEpisodeVisuals } from "../src/lib/video/visual-engine";
import { releaseComfyVramSafely } from "../src/lib/video/visual-engine/comfyui";
import { iconPaths, resolveIcon } from "../src/lib/video/scenes/icons";
import { renderProject } from "../src/lib/video/render";
import type { Beat, ContentPackage } from "../src/lib/content/schema";
import type { Scene, SceneIcon } from "../src/lib/video/scenes/types";
import type { SweepStep, CameraKey } from "../src/lib/video/sweep";

const EPISODE_ID = "cmwqeq5td000tn6w08pfg1ik6";
const SLUG = "ultra-master-7-in-1";

function mapTime(t: number, oldTotal: number, newTotal: number): number {
  if (oldTotal <= 0) return t;
  return Math.max(0, Math.min(newTotal, +(t * (newTotal / oldTotal)).toFixed(3)));
}

async function loadTablerIcon(preferredName: string, fallbackQuery: string): Promise<SceneIcon> {
  const direct = await iconPaths(preferredName);
  if (direct) return { name: preferredName, paths: direct, query: fallbackQuery, score: 1 };
  const resolved = await resolveIcon(fallbackQuery);
  if (resolved) return resolved;
  return { name: preferredName, paths: '<circle cx="12" cy="12" r="8" />', query: fallbackQuery, score: 0.5 };
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, ".bookreel", "renders", "reference");
  await fs.mkdir(outDir, { recursive: true });

  try {
    const ep = await prisma.episode.findUnique({
      where: { id: EPISODE_ID },
      include: { book: true },
    });
    if (!ep || !ep.projectPath || !ep.scenePlan || !ep.visualPlan) {
      throw new Error(`Episode missing required render data: ${EPISODE_ID}`);
    }

    console.log(`\n======================================================`);
    console.log(`Building 7-IN-1 COMPLETE OMNI ULTRA VIDEO: ${SLUG}`);
    console.log(`Episode: ${ep.title}`);
    console.log(`======================================================`);

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

    const refProj = path.join(cwd, ".bookreel", "projects", SLUG);
    const workDir = path.join(cwd, ".bookreel", "work", SLUG);
    await fs.rm(refProj, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.cp(origProj, refProj, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    const verifiedPages = await Promise.all(
      pageMatches.map(async (pm) => {
        const hiExists = await fs
          .stat(path.join(refProj, pm.hiSrc))
          .then((st) => st.size > 512, () => false);
        return hiExists ? pm : { ...pm, hiSrc: undefined };
      }),
    );

    // 1. Unified single-speaker Studio Voiceover (`charles`) + faster-whisper alignment
    const beatTexts = pkg.beats.map((b) => b.voiceover);
    console.log(`  [1/4] Synthesizing unified studio voiceover (voice=charles, beats=${beatTexts.length})...`);
    const voice = await synthesizeVoiceover(beatTexts, workDir, "charles");
    const timing = await timeNarration(voice, workDir);
    await fs.copyFile(voice.audioPath, path.join(refProj, "assets", "voice.wav"));

    const oldDuration = Number(ep.durationSec ?? voice.totalDuration);
    const totalDuration = voice.totalDuration;
    const duration = AUDIO_OFFSET + totalDuration + OUTRO_TAIL;
    console.log(`  [Voice OK] duration=${totalDuration.toFixed(2)}s source=${timing.source} words=${timing.words.length}`);

    // 2. Remap sweeps & camera to exact spoken word timestamps
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

    const beatBounds = timing.beats.map((b, bi) => {
      const start = bi === 0 ? 0 : timing.beats[bi - 1].end;
      const end = bi === timing.beats.length - 1 ? totalDuration : b.end;
      return { start: +start.toFixed(3), end: +Math.max(start + 0.8, end).toFixed(3) };
    });
    const wordsInWindow = (start: number, end: number) =>
      timing.words
        .filter((w) => w.start >= start - 0.06 && w.start < end + 0.04)
        .map((w) => ({ word: w.word, start: w.start, end: w.end }));

    // Calm midnight-indigo & sapphire theme (zero harsh orange beam or 4px halftone grain)
    const theme = bookThemeById("blueprint");

    // Generate calm, desaturated cool-slate architectural library study plate (`localAnalysisOnly: true`)
    console.log(`  [2/4] Generating calm cool-slate 2.5D architectural study plate & choreographing all 7 models...`);
    const seedComfy: Scene[] = [
      {
        index: 0,
        kind: "cinematic",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "cool",
        environment: "still",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 13, startWord: 0, endWord: 14 },
        reason: "Quiet minimalist 1900s dark oak architectural library desk in soft cool moonlight",
        concept:
          "minimalist classical dark oak study desk by tall misty window in soft cool moonlight, brushed silver pocket chronometer on closed leather notebook, muted desaturated slate blue and charcoal tones, calm architectural cinema",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        cine: { hero: "clock", keyword: "decide to act", lead: "", hook: true },
      },
    ];

    const vOut = await generateEpisodeVisuals({
      episodeId: `${SLUG}-calm-v2`,
      bookTitle: ep.book.title,
      author: ep.book.authorVerified ? ep.book.author : null,
      archetype: ep.book.archetype,
      pkg,
      scenes: seedComfy,
      theme,
      engine: "hybrid-cinematic",
      localAnalysisOnly: true,
      offlineReferences: true,
    });
    for (const asset of vOut.projectAssets) {
      const destPath = path.join(refProj, "assets", asset.to);
      if (/plate-0\.(jpg|png)$/i.test(asset.to)) {
        // Apply calm Fincher/Nolan desaturated cool-slate cinema grade from Buffer (never mmap destPath on Windows)
        const srcBuf = await fs.readFile(asset.from);
        const toned = await sharp(srcBuf)
          .modulate({ saturation: 0.62, brightness: 0.82 })
          .tint({ r: 196, g: 214, b: 236 })
          .jpeg({ quality: 95, mozjpeg: true })
          .toBuffer();
        await fs.writeFile(destPath, toned);
      } else {
        await fs.copyFile(asset.from, destPath);
      }
    }
    await releaseComfyVramSafely().catch(() => false);

    const rawHookPlate = vOut.scenes.find((s) => s.index === 0)?.cine?.plate;
    const hookPlate = rawHookPlate
      ? {
          ...rawHookPlate,
          colorGrade: "cool-noir" as const,
          dominantHex: "#0f172a",
          accentHex: "#7dd3fc",
          shadowHex: "#04070f",
        }
      : undefined;

    const questionIcon = await loadTablerIcon("help-hexagon", "hidden internal choice mystery");
    const stopwatchIcon = await loadTablerIcon("stopwatch", "exact measured millisecond data");

    // =======================================================================
    // 9-SCENE MASTER PLAN SHOWCASING ALL 7 MODELS SEAMLESSLY IN ONE VIDEO
    // =======================================================================
    const omniScenes: Scene[] = [
      // Beat 0 -> Model 7 (`magnates-cinema`): Calm Cool-Slate Moonlight Library 2.5D Plate + Frosted Dark Hook Card
      {
        index: 0,
        kind: "cinematic",
        sceneModel: "magnates-cinema",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "cool",
        environment: "still",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 13, startWord: 0, endWord: 14 },
        reason: "Model 7 (Magnates 2.5D Dark Cinema) calm cool-slate opening hook",
        concept: "early twentieth century laboratory capturing exact moment of choice",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        transitionIn: "dissolve",
        cine: {
          hero: "clock",
          keyword: "decide to act",
          lead: "",
          hook: true,
          accentWords: ["laboratory", "exact moment", "decide"],
          plate: hookPlate,
        },
      },
      // Beat 1 -> Model 4 (`trifecta-viral` Archival Proof): Spotlighted @2x Scan (p.15) + Marker Sweep + Shutter-Snap
      {
        index: 1,
        kind: "book-crop",
        sceneModel: "trifecta-viral",
        start: beatBounds[1].start,
        end: beatBounds[1].end,
        tone: "cool",
        environment: "grid",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 15, startWord: 10, endWord: 24 },
        reason: "Spotlighted @2x archival book scan turning messy choosing into cold data",
        concept: "turning internal process of choosing into hard cold data",
        crop: { x0: 152.4, y0: 303.6, x1: 907.9, y1: 384.8 },
        shot: "wide",
        transitionIn: "depth-push",
      },
      // Beat 2 -> Model 3 (`neuro-lab`): Neon-Indigo Lab + Bespoke Two-Glass Spring & Electric Timer Apparatus
      {
        index: 2,
        kind: "cinematic",
        sceneModel: "neuro-lab",
        start: beatBounds[2].start,
        end: beatBounds[2].end,
        tone: "deep",
        environment: "deep",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 69, startWord: 0, endWord: 16 },
        reason: "Model 3 (Neon Neuro Lab) animating two glasses on springs wired to an electric timer",
        concept: "table with two glasses on springs wired to electric timer",
        words: wordsInWindow(beatBounds[2].start, beatBounds[2].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "mind",
          keyword: "electric timer",
          lead: "Two spring-loaded glasses wired to",
          proModel: "lab-apparatus",
          proMeta: {
            kicker: "1910 VOLITION CHRONO-SPRING RIG",
            badge: "TIMER ARMED",
            leftTitle: "GLASS A (SPRING)",
            rightTitle: "GLASS B (SPRING)",
          },
        },
      },
      // Beat 3 -> Model 1 (`vision-bento`): VisionOS Frosted Glass Bento + Circuit-Break Millisecond Telemetry Rig
      {
        index: 3,
        kind: "cinematic",
        sceneModel: "vision-bento",
        start: beatBounds[3].start,
        end: beatBounds[3].end,
        tone: "deep",
        environment: "grid",
        sentences: [3],
        beatIndex: 3,
        source: { pageIndex: 69, startWord: 17, endWord: 34 },
        reason: "Model 1 (VisionOS Bento) animating glass lift -> circuit break -> millisecond lock",
        concept: "lifting glass breaks circuit to record exact millisecond",
        words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
        transitionIn: "spring-pop",
        cine: {
          hero: "focus",
          keyword: "exact millisecond",
          lead: "Circuit broke instantly to record",
          proModel: "obstacle-radar",
          proMeta: {
            kicker: "MILLISECOND CIRCUIT TELEMETRY",
            badge: "0.001s LOCKED",
            leftTitle: "Glass Lifted",
            rightTitle: "Circuit Broken",
          },
        },
      },
      // Beat 4 -> Model 2 (`investigative-dossier`): Clean Dark-Slate Archival Grid + Tactile Manila Verbatim Quote Card (p.70)
      {
        index: 4,
        kind: "quote",
        sceneModel: "investigative-dossier",
        start: beatBounds[4].start,
        end: beatBounds[4].end,
        tone: "cool",
        environment: "grid",
        sentences: [4],
        beatIndex: 4,
        source: { pageIndex: 70, startWord: 0, endWord: 20 },
        reason: "Model 2 (Investigative Dossier) Manila stamped lab instruction quote on clean dark-slate archival grid",
        concept: "verbatim lab protocol instruction",
        quote: {
          text: "You are to choose between these substances and to drink at once the liquid which you have chosen.",
          page: 70,
        },
        transitionIn: "rise-wipe",
      },
      // Beat 5 -> Model 6 (`vox-explainer`): Warm Archival Cream Paper Grid + Hard-Shadow 4-Phase Paper-Cutout Checklist
      {
        index: 5,
        kind: "steps",
        sceneModel: "vox-explainer",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "bright",
        environment: "warm",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 71, startWord: 0, endWord: 18 },
        reason: "Model 6 (Vox Paper Explainer) 4-phase breakdown on warm cream paper grid",
        concept: "4 Phases Of Measured Choice",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        steps: [
          "Seeing the stimulus card",
          "Weighing two substances",
          "Breaking spring circuit",
          "Final choice realization",
        ],
        transitionIn: "spring-pop",
      },
      // Beat 6 -> Model 5 (`dankoe-vector`): Pitch-Black Ruled Vector Grid + Live-Drawing SVG Volition Diagram
      {
        index: 6,
        kind: "cinematic",
        sceneModel: "dankoe-vector",
        start: beatBounds[6].start,
        end: beatBounds[6].end,
        tone: "deep",
        environment: "grid",
        sentences: [6],
        beatIndex: 6,
        source: { pageIndex: 13, startWord: 15, endWord: 30 },
        reason: "Model 5 (Dan Koe Minimalist Vector) live-drawing geometric volition trajectory diagram",
        concept: "mapping the mechanics of human volition",
        words: wordsInWindow(beatBounds[6].start, beatBounds[6].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "path",
          keyword: "human volition",
          lead: "Mapping the hidden mechanics of",
          vectorMode: true,
        },
      },
      // Beat 7 -> Model 4 (`trifecta-viral`): Tactile Ivory Dual-Icon Comparison Card over Calm Midnight-Slate Studio Grid
      {
        index: 7,
        kind: "comparison",
        sceneModel: "trifecta-viral",
        start: beatBounds[7].start,
        end: beatBounds[7].end,
        tone: "cool",
        environment: "grid",
        sentences: [7],
        beatIndex: 7,
        source: { pageIndex: 70, startWord: 21, endWord: 36 },
        reason: "Model 4 (3-in-1 Trifecta) tactile ivory Dual-Icon Comparison over clean midnight-slate backdrop",
        concept: "stripping away mystery with isolated millisecond data",
        words: wordsInWindow(beatBounds[7].start, beatBounds[7].end),
        left: "Hidden mystery",
        right: "Measured volition",
        icons: [questionIcon, stopwatchIcon],
        transitionIn: "spring-pop",
      },
      // Beat 8 -> Model 7 (`magnates-cinema` Live 3D): Anti-Aliased 3D Platinum & Sapphire Chronometer (`HEROES.clock`) + CTA
      {
        index: 8,
        kind: "cinematic",
        sceneModel: "magnates-cinema",
        start: beatBounds[8].start,
        end: beatBounds[8].end,
        tone: "cool",
        environment: "still",
        sentences: [8],
        beatIndex: 8,
        source: { pageIndex: 13, startWord: 31, endWord: 40 },
        reason: "Model 7 crisp anti-aliased 3D platinum-sapphire chronometer sculpture into CTA",
        concept: "precision chronometer measuring human will",
        words: wordsInWindow(beatBounds[8].start, beatBounds[8].end),
        transitionIn: "dissolve",
        cine: {
          hero: "clock",
          keyword: "next excuse",
          lead: "Save this before your",
          vectorMode: false,
        },
      },
    ];

    // 3. Synthesize 20% ducked score + full Earshot Foley SFX suite
    console.log(`  [3/4] Synthesizing 20% BGM (editorial) + full Earshot Foley suite...`);
    const musicPath = path.join(refProj, "assets", "music.wav");
    const hasMusic = await generateCinematicScoreWav(duration, musicPath, {
      style: "editorial",
      voicePath: voice.audioPath,
      voiceOffsetSec: AUDIO_OFFSET,
      targetMeanDb: -25,
    }).then(() => true, () => false);

    const allStrokes = sweeps.flatMap((steps) => steps.map((st) => ({ start: st.start, end: st.end })));
    const speechSpans = timing.words.map((w) => ({ start: w.start, end: w.end }));
    const sfxOut = await generateSfxTrack({
      durationSec: duration,
      audioOffsetSec: AUDIO_OFFSET,
      scenes: omniScenes,
      strokes: allStrokes,
      speechSpans,
      reelModel: "omni-7-ultra",
      seedKey: `${EPISODE_ID}::${SLUG}`,
      outPath: path.join(refProj, "assets", "sfx.wav"),
    });
    if (sfxOut.usedFiles?.length) {
      console.log(`  [Selective SFX] cues=${sfxOut.cues.length} files=[${sfxOut.usedFiles.join(", ")}]`);
    }

    // 4. Build 7-in-1 Omni Ultra HTML composition & render 1080×1920 high-quality MP4
    const upgradedHtml = buildComposition({
      pkg,
      beats: timing.beats,
      captions: timing.captions,
      pages: verifiedPages,
      sweeps,
      camera,
      theme,
      totalDuration,
      music: hasMusic,
      sfx: sfxOut.cues.length > 0,
      viralCaptions: true,
      reelStyle: "omni-7-ultra",
      bookTitle: ep.book.title,
      author: ep.book.authorVerified ? ep.book.author : null,
      bookLink: ep.book.bookLink,
      scenes: omniScenes,
    });

    await fs.writeFile(path.join(refProj, "index.html"), upgradedHtml, "utf8");

    const outMp4 = path.join(outDir, `${SLUG}.mp4`);
    const tmpOutMp4 = path.join(os.tmpdir(), `${SLUG}-${Date.now()}.mp4`);
    const t0 = Date.now();
    console.log(
      `  [4/4 Render START] ${SLUG} (${totalDuration.toFixed(1)}s, style=omni-7-ultra, sfxCues=${sfxOut.cues.length}, earshotOk=${sfxOut.syncReport.ok})`,
    );
    await renderProject(refProj, tmpOutMp4, "high", "local", 1);
    await fs.copyFile(tmpOutMp4, outMp4);
    await fs.rm(tmpOutMp4, { force: true }).catch(() => {});
    const stat = await fs.stat(outMp4);
    console.log(
      `  [Render DONE] ${outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
