/**
 * 100% Local BookReel ("YT Book") Unified Trifecta Master Video Runner.
 *
 * Combines ALL 3 viral HyperFrames styles seamlessly into ONE cohesive 1080×1920 video:
 *   - Style 3 (Magnates 2.5D Dark Cinema): Opening Hook Plate + Finale Macro Hourglass Plate
 *   - Archival Proof: Spotlighted @2x Book-Crop Evidence + Felt-Tip Sweep + Shutter-Snap
 *   - Style 3 (Live Three.js 3D): Oscillating Brass Balance Scales Sculpture + Clock-Tick
 *   - Style 1 (Dan Koe Vector Motion): Live GSAP Geometric SVG Diagram on Dark Ruled Grid + UI-Click
 *   - Style 2 (Vox Tactile Paper-Collage): Ivory Offset-Shadow Dual-Icon Comparison + 3-Step Checklist
 *
 * Strictly 100% local (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, zero Gemini/external API calls),
 * 100% single-speaker Studio Voice, and 20% ducked BGM.
 */
process.env.BOOKREEL_VISUAL_LOCAL_ONLY = "1";

import fs from "node:fs/promises";
import path from "node:path";
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

const EPISODE_ID = "cmwrlb3u0004dn6n4zc245yrs";
const SLUG = "viral-master-trifecta";

function mapTime(t: number, oldTotal: number, newTotal: number): number {
  if (oldTotal <= 0) return t;
  return Math.max(0, Math.min(newTotal, +(t * (newTotal / oldTotal)).toFixed(3)));
}

async function loadTablerIcon(preferredName: string, fallbackQuery: string): Promise<SceneIcon> {
  const direct = await iconPaths(preferredName);
  if (direct) {
    return { name: preferredName, paths: direct, query: fallbackQuery, score: 1 };
  }
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
    console.log(`Building Unified 3-in-1 Master Video: ${SLUG}`);
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

    // 1. Unified single-speaker Studio Voiceover (`charles` -> en-US-ChristopherNeural) + faster-whisper alignment
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

    // Build 7 beat-aligned scenes so every single beat gets its ideal archetype from the 3 styles!
    const origScenes = JSON.parse(ep.scenePlan) as Scene[];
    const cropBeat1 = origScenes.find((s) => s.kind === "book-crop")?.crop ?? { x0: 50, y0: 437.7, x1: 810.4, y1: 513.5 };
    const wordsInWindow = (start: number, end: number) =>
      timing.words
        .filter((w) => w.start >= start - 0.06 && w.start < end + 0.04)
        .map((w) => ({ word: w.word, start: w.start, end: w.end }));

    const beatBounds = timing.beats.map((b, bi) => {
      const start = bi === 0 ? 0 : timing.beats[bi - 1].end;
      const end = bi === timing.beats.length - 1 ? totalDuration : b.end;
      return { start: +start.toFixed(3), end: +Math.max(start + 0.8, end).toFixed(3) };
    });

    const theme = bookThemeById("spotlight");

    // Seed ComfyUI plates for Beat 0 (Opening Hook) & Beat 6 (Finale Payoff) via 100% local BookReel engine
    const comfySeedScenes: Scene[] = [
      {
        index: 0,
        kind: "cinematic",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "deep",
        environment: "still",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 186, startWord: 149, endWord: 162 },
        reason: "Magnates 2.5D dark chiaroscuro opening hook plate",
        concept: "tranquil lantern study dock over mirror dark lake at dusk",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        cine: {
          hero: "focus",
          keyword: "locks up",
          lead: "",
          hook: true,
          accentWords: ["identical weight", "locks up"],
        },
      },
      {
        index: 6,
        kind: "cinematic",
        start: beatBounds[6].start,
        end: beatBounds[6].end,
        tone: "deep",
        environment: "warm",
        sentences: [6],
        beatIndex: 6,
        source: { pageIndex: 196, startWord: 126, endWord: 136 },
        reason: "Magnates 2.5D dark macro brass hourglass finale plate",
        concept: "ornate brass hourglass with glowing golden sand on dark walnut study desk",
        words: wordsInWindow(beatBounds[6].start, beatBounds[6].end),
        cine: {
          hero: "hourglass",
          keyword: "BookReel",
          lead: "Follow for more ideas from books",
        },
      },
    ];

    console.log(`  [2/4] Generating local ComfyUI 2.5D dark macro plates + directing 3-in-1 Trifecta scenes...`);
    const visualOut = await generateEpisodeVisuals({
      episodeId: `${SLUG}-plates`,
      bookTitle: ep.book.title,
      author: ep.book.authorVerified ? ep.book.author : null,
      archetype: ep.book.archetype,
      pkg,
      scenes: comfySeedScenes,
      theme,
      engine: "hybrid-cinematic",
      localAnalysisOnly: true,
      offlineReferences: true,
    });

    for (const asset of visualOut.projectAssets) {
      await fs.copyFile(asset.from, path.join(refProj, "assets", asset.to));
    }
    await releaseComfyVramSafely().catch(() => false);

    const hookPlate = visualOut.scenes.find((s) => s.index === 0)?.cine?.plate;
    const finalePlate = visualOut.scenes.find((s) => s.index === 6)?.cine?.plate;

    const scaleIcon = await loadTablerIcon("scale", "endless mental debate balanced weights");
    const handGrabIcon = await loadTablerIcon("hand-grab", "grabbing whatever is closest impulse");

    // Assemble the 7-scene Unified Trifecta Master Plan combining ALL 3 HyperFrames styles:
    const trifectaScenes: Scene[] = [
      // Scene 0 (Beat 0): Style 3 — Magnates 2.5D Dark Cinema Hook + Frosted Dark Glass Hook Card
      {
        index: 0,
        kind: "cinematic",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "deep",
        environment: "still",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 186, startWord: 149, endWord: 162 },
        reason: "Magnates 2.5D dark cinema opening hook",
        concept: "two options carrying identical weight",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        transitionIn: "dissolve",
        cine: {
          hero: "scales",
          keyword: "locks up",
          lead: "",
          hook: true,
          accentWords: ["identical weight", "locks up"],
          plate: hookPlate,
        },
      },
      // Scene 1 (Beat 1): Archival Book Proof — Spotlighted @2x Scan + Felt-Tip Sweep + Shutter-Snap
      {
        index: 1,
        kind: "book-crop",
        start: beatBounds[1].start,
        end: beatBounds[1].end,
        tone: "warm",
        environment: "grid",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 194, startWord: 76, endWord: 80 },
        reason: "Spotlighted @2x book-crop proof of disagreeable substances",
        concept: "choosing between two disagreeable substances",
        crop: cropBeat1,
        shot: "wide",
        transitionIn: "depth-push",
      },
      // Scene 2 (Beat 2): Style 3 — Live Three.js 3D Oscillating Brass Balance Scales Sculpture
      {
        index: 2,
        kind: "cinematic",
        start: beatBounds[2].start,
        end: beatBounds[2].end,
        tone: "deep",
        environment: "deep",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 186, startWord: 81, endWord: 94 },
        reason: "Live Three.js 3D brass balance scales swinging between alternatives",
        concept: "mind swinging back and forth between two alternatives",
        words: wordsInWindow(beatBounds[2].start, beatBounds[2].end),
        transitionIn: "depth-push",
        cine: {
          hero: "scales",
          keyword: "two alternatives",
          lead: "mind swings back and forth between",
          vectorMode: false,
        },
      },
      // Scene 3 (Beat 3): Style 1 — Dan Koe Minimalist Geometric SVG Vector Diagram on Ruled Grid
      {
        index: 3,
        kind: "cinematic",
        start: beatBounds[3].start,
        end: beatBounds[3].end,
        tone: "deep",
        environment: "grid",
        sentences: [3],
        beatIndex: 3,
        source: { pageIndex: 186, startWord: 112, endWord: 125 },
        reason: "Dan Koe precision concentric focus-reticle vector diagram",
        concept: "severe hesitation draining focus",
        words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "focus",
          keyword: "drains your focus",
          lead: "This severe hesitation",
          vectorMode: true,
        },
      },
      // Scene 4 (Beat 4): Style 2 — Vox Tactile Ivory Paper-Cutout Dual-Icon Comparison Card
      {
        index: 4,
        kind: "comparison",
        start: beatBounds[4].start,
        end: beatBounds[4].end,
        tone: "bright",
        environment: "dusk",
        sentences: [4],
        beatIndex: 4,
        source: { pageIndex: 196, startWord: 112, endWord: 125 },
        reason: "Vox tactile paper-cutout comparison contrasting endless debate vs grabbing closest option",
        concept: "escaping endless debate by grabbing closest option",
        words: wordsInWindow(beatBounds[4].start, beatBounds[4].end),
        left: "Endless debate",
        right: "Grabbing closest",
        icons: [scaleIcon, handGrabIcon],
        bgImageSrc: finalePlate?.imageSrc ?? hookPlate?.imageSrc,
        transitionIn: "spring-pop",
      },
      // Scene 5 (Beat 5): Style 2 — Vox Tactile Ivory Paper-Cutout 3-Step Takeaway Checklist
      {
        index: 5,
        kind: "steps",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "bright",
        environment: "warm",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 196, startWord: 126, endWord: 136 },
        reason: "Vox tactile 3-step breakdown of choice burnout",
        concept: "Why Equal Choices Burn Out",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        steps: [
          "Balanced values lock focus",
          "Hesitation drains mental energy",
          "Decide fast on equal ties",
        ],
        bgImageSrc: hookPlate?.imageSrc,
        transitionIn: "rise-wipe",
      },
      // Scene 6 (Beat 6): Style 3 — Magnates 2.5D Dark Macro Brass Hourglass Finale + CTA
      {
        index: 6,
        kind: "cinematic",
        start: beatBounds[6].start,
        end: beatBounds[6].end,
        tone: "deep",
        environment: "still",
        sentences: [6],
        beatIndex: 6,
        source: { pageIndex: 196, startWord: 126, endWord: 136 },
        reason: "Magnates dark macro hourglass finale into CTA",
        concept: "timeless ideas from books",
        words: wordsInWindow(beatBounds[6].start, beatBounds[6].end),
        transitionIn: "dissolve",
        cine: {
          hero: "hourglass",
          keyword: "BookReel",
          lead: "More ideas from books",
          plate: finalePlate,
        },
      },
    ];

    // 3. Synthesize 20% ducked score + full Viral Reels Earshot Foley suite
    console.log(`  [3/4] Synthesizing 20% BGM (spotlight) + full Earshot Reels Foley suite...`);
    const musicPath = path.join(refProj, "assets", "music.wav");
    const hasMusic = await generateCinematicScoreWav(duration, musicPath, {
      style: "spotlight",
      voicePath: voice.audioPath,
      voiceOffsetSec: AUDIO_OFFSET,
      targetMeanDb: -25,
    }).then(() => true, () => false);

    const allStrokes = sweeps.flatMap((steps) => steps.map((st) => ({ start: st.start, end: st.end })));
    const speechSpans = timing.words.map((w) => ({ start: w.start, end: w.end }));
    const sfxOut = await generateSfxTrack({
      durationSec: duration,
      audioOffsetSec: AUDIO_OFFSET,
      scenes: trifectaScenes,
      strokes: allStrokes,
      speechSpans,
      outPath: path.join(refProj, "assets", "sfx.wav"),
    });

    // 4. Build unified Trifecta HyperFrames HTML & render 1080×1920 high-quality MP4
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
      reelStyle: "trifecta-viral",
      bookTitle: ep.book.title,
      author: ep.book.authorVerified ? ep.book.author : null,
      bookLink: ep.book.bookLink,
      scenes: trifectaScenes,
    });

    await fs.writeFile(path.join(refProj, "index.html"), upgradedHtml, "utf8");

    const outMp4 = path.join(outDir, `${SLUG}.mp4`);
    const t0 = Date.now();
    console.log(
      `  [4/4 Render START] ${SLUG} (${totalDuration.toFixed(1)}s, style=trifecta-viral, sfxCues=${sfxOut.cues.length}, earshotOk=${sfxOut.syncReport.ok})`,
    );
    await renderProject(refProj, outMp4, "high", "local", 1);
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
