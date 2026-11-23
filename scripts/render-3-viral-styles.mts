/**
 * 100% Local BookReel ("YT Book") End-to-End Viral HyperFrames Showcase Runner.
 *
 * Strictly enforces ZERO Gemini / external cloud LLM or external image API calls
 * (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, `localAnalysisOnly: true`, `offlineReferences: true`).
 * Produces 3 genuinely distinct, current-trend Million-View HyperFrames Shorts/Reels:
 *   1. `viral-1-dankoe-vector`   — Dan Koe Pitch-Black Minimalist Vector Motion (`terminal`, `charles`)
 *   2. `viral-2-vox-explainer`   — Vox Tactile Cream Paper-Collage & Data Checklist (`editorial`, `george`)
 *   3. `viral-3-magnates-cinema` — MagnatesMedia 2.5D Dark Macro & 3D Brass Scales (`spotlight`, `stuart_bell`)
 */
process.env.BOOKREEL_VISUAL_LOCAL_ONLY = "1";

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
import { iconPaths, resolveIcon } from "../src/lib/video/scenes/icons";
import { renderProject } from "../src/lib/video/render";
import type { Beat, ContentPackage } from "../src/lib/content/schema";
import type { Scene, SceneIcon } from "../src/lib/video/scenes/types";
import type { SweepStep, CameraKey } from "../src/lib/video/sweep";

type ViralReelStyle = "dankoe-vector" | "vox-explainer" | "magnates-cinema";

interface ShowcaseTarget {
  id: string;
  slug: string;
  reelStyle: ViralReelStyle;
  themeId: BookThemeId;
  voiceId: string;
  musicStyle: string;
}

const TARGETS: ReadonlyArray<ShowcaseTarget> = [
  {
    id: "cmwqeq66c0011n6w0kc2iej7b",
    slug: "viral-1-dankoe-vector",
    reelStyle: "dankoe-vector",
    themeId: "terminal",
    voiceId: "charles",
    musicStyle: "terminal",
  },
  {
    id: "cmwqg9xla009rn6w0p8xcv1qo",
    slug: "viral-2-vox-explainer",
    reelStyle: "vox-explainer",
    themeId: "editorial",
    voiceId: "george",
    musicStyle: "editorial",
  },
  {
    id: "cmwrlb3u0004dn6n4zc245yrs",
    slug: "viral-3-magnates-cinema",
    reelStyle: "magnates-cinema",
    themeId: "spotlight",
    voiceId: "stuart_bell",
    musicStyle: "spotlight",
  },
];

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
  const fallbackCircle = '<circle cx="12" cy="12" r="8" />';
  return { name: preferredName, paths: fallbackCircle, query: fallbackQuery, score: 0.5 };
}

async function directScenesForStyle(
  target: ShowcaseTarget,
  epId: string,
  bookTitle: string,
  author: string | null,
  archetype: string | null,
  pkg: ContentPackage,
  mappedScenes: Scene[],
  refProj: string,
): Promise<Scene[]> {
  const theme = bookThemeById(target.themeId);

  if (target.reelStyle === "dankoe-vector") {
    const boltIcon = await loadTablerIcon("bolt", "forced discipline effort lightning");
    const eyeIcon = await loadTablerIcon("eye", "calm focused attention vision");

    return mappedScenes.map((s, idx) => {
      if (s.kind === "book-crop" || s.kind === "book-page") {
        return { ...s, environment: "grid", tone: "neutral" };
      }
      if (idx === 6 || s.kind === "comparison") {
        return {
          ...s,
          kind: "comparison",
          environment: "grid",
          tone: "bright",
          left: "Forced discipline",
          right: "Managing attention",
          icons: [boltIcon, eyeIcon],
          bgImageSrc: undefined,
          cine: undefined,
        };
      }
      const heroMap: Record<number, NonNullable<Scene["cine"]>["hero"]> = {
        0: "dialogue", // -> split-forces converging geometric rings
        2: "path",     // -> trajectory-grid ascending vector curve
        4: "focus",    // -> focus-reticle concentric target
        5: "loop",     // -> habit-loop directional feedback ring
      };
      return {
        ...s,
        kind: "cinematic",
        environment: "grid",
        tone: "deep",
        cine: {
          hero: heroMap[idx] ?? s.cine?.hero ?? "focus",
          keyword: s.cine?.keyword || "attention",
          lead: s.cine?.lead ?? "",
          hook: s.cine?.hook,
          accentWords: s.cine?.accentWords ?? ["focus", "resolve", "different"],
          vectorMode: true,
          plate: undefined,
        },
      };
    });
  }

  if (target.reelStyle === "vox-explainer") {
    const slipIcon = await loadTablerIcon("alert-triangle", "warning slip up mistake");
    const shieldIcon = await loadTablerIcon("shield-check", "reliable daily coping plan");
    const runIcon = await loadTablerIcon("run", "new physical activity exercise");
    const buddiesIcon = await loadTablerIcon("users", "exercise partners buddies group");

    return mappedScenes.map((s, idx) => {
      if (s.kind === "book-crop" || s.kind === "book-page") {
        return { ...s, environment: "warm", tone: "warm" };
      }
      if (idx === 0) {
        return {
          ...s,
          kind: "cinematic",
          environment: "warm",
          tone: "warm",
          cine: {
            hero: "loop",
            keyword: "boring",
            lead: "",
            hook: true,
            accentWords: ["healthy routine", "boring", "quit"],
            vectorMode: true,
            plate: undefined,
          },
        };
      }
      if (idx === 1) {
        return {
          ...s,
          kind: "cinematic",
          environment: "warm",
          tone: "warm",
          cine: {
            hero: "path",
            keyword: "daily progress",
            lead: "Monotony quietly destroys",
            vectorMode: true,
            plate: undefined,
          },
        };
      }
      if (idx === 3) {
        return {
          ...s,
          kind: "comparison",
          environment: "warm",
          tone: "bright",
          left: "Daily slip ups",
          right: "Reliable coping",
          icons: [slipIcon, shieldIcon],
          bgImageSrc: undefined,
          cine: undefined,
        };
      }
      if (idx === 4) {
        return {
          ...s,
          kind: "icon-concept",
          environment: "warm",
          tone: "bright",
          items: ["New activities", "Activity buddies"],
          icons: [runIcon, buddiesIcon],
          bgImageSrc: undefined,
          cine: undefined,
        };
      }
      return {
        ...s,
        kind: "steps",
        environment: "warm",
        tone: "bright",
        steps: ["Swap out your foods", "Try different recipes", "Change your rewards"],
        bgImageSrc: undefined,
        cine: undefined,
      };
    });
  }

  // Style 3: `magnates-cinema` — Local ComfyUI Hi-Res 2.5D Dark Macro Plates + Live Three.js 3D Brass Scales + Comparison + Spotlighted Book Proof
  const preppedForComfy: Scene[] = mappedScenes.map((s, idx) => {
    if (idx === 0) {
      return {
        ...s,
        kind: "cinematic",
        concept: "vintage brass balance scale with two equal heavy weights in dark study",
        cine: {
          hero: "scales",
          keyword: "locks up",
          lead: "",
          hook: true,
          accentWords: ["identical weight", "locks up"],
          plate: undefined,
        },
      };
    }
    if (idx === 5) {
      return {
        ...s,
        kind: "cinematic",
        concept: "ornate brass hourglass draining golden sand on dark walnut desk",
        cine: {
          hero: "hourglass",
          keyword: "balanced values",
          lead: "mental energy burning out on",
          plate: undefined,
        },
      };
    }
    return {
      ...s,
      cine: s.cine ? { ...s.cine, plate: undefined } : undefined,
      bgImageSrc: undefined,
    };
  });

  console.log(`  [ComfyUI Local 2.5D] Generating dark chiaroscuro plates (localAnalysisOnly=true)...`);
  const visualOut = await generateEpisodeVisuals({
    episodeId: `${target.slug}-${epId.slice(-6)}`,
    bookTitle,
    author,
    archetype,
    pkg,
    scenes: preppedForComfy,
    theme,
    engine: "hybrid-cinematic",
    localAnalysisOnly: true,
    offlineReferences: true,
  });

  for (const asset of visualOut.projectAssets) {
    await fs.copyFile(asset.from, path.join(refProj, "assets", asset.to));
  }
  await releaseComfyVramSafely().catch(() => false);
  console.log(`  [ComfyUI OK] copied ${visualOut.projectAssets.length} local 2.5D plate/depth assets`);

  const scaleIcon = await loadTablerIcon("scale", "equal balanced heavy options");
  const pauseIcon = await loadTablerIcon("player-pause", "severe hesitation refusing to act");
  const fallbackBgPlate =
    visualOut.scenes.find((sc) => sc.cine?.plate?.imageSrc)?.cine?.plate?.imageSrc;

  return visualOut.scenes.map((s, idx) => {
    // Scene 2: Live Three.js 3D Oscillating Brass Balance Scales Sculpture (`HEROES.scales`)
    if (idx === 2) {
      return {
        ...s,
        kind: "cinematic",
        environment: "deep",
        tone: "deep",
        cine: {
          hero: "scales",
          keyword: "two alternatives",
          lead: "mind swings back and forth between",
          plate: undefined,
          vectorMode: false,
        },
      };
    }
    // Scene 3: Grounded Dual-Icon Comparison Card over dark cinema backdrop
    if (idx === 3) {
      return {
        ...s,
        kind: "comparison",
        environment: "dusk",
        tone: "bright",
        left: "Severe hesitation",
        right: "Refusing to act",
        icons: [scaleIcon, pauseIcon],
        bgImageSrc: s.cine?.plate?.imageSrc ?? fallbackBgPlate,
        cine: undefined,
      };
    }
    return s;
  });
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, ".bookreel", "renders", "reference");
  await fs.mkdir(outDir, { recursive: true });
  const filterArg = process.argv[2]?.trim();
  const activeTargets = filterArg
    ? TARGETS.filter((t) => t.slug.includes(filterArg) || t.reelStyle.includes(filterArg))
    : TARGETS;

  try {
    for (const target of activeTargets) {
      const ep = await prisma.episode.findUnique({
        where: { id: target.id },
        include: { book: true },
      });
      if (!ep || !ep.projectPath || !ep.scenePlan || !ep.visualPlan) {
        throw new Error(`Episode missing required render data: ${target.id}`);
      }

      console.log(`\n======================================================`);
      console.log(`Preparing ${target.slug} [${target.reelStyle}] — ${ep.title}`);
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

      const refProj = path.join(cwd, ".bookreel", "projects", target.slug);
      const workDir = path.join(cwd, ".bookreel", "work", target.slug);
      await fs.rm(refProj, { recursive: true, force: true });
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.cp(origProj, refProj, { recursive: true });
      await fs.mkdir(workDir, { recursive: true });

      // Ensure hiSrc only points to an existing @2x file on disk
      const verifiedPages = await Promise.all(
        pageMatches.map(async (pm) => {
          const hiExists = await fs
            .stat(path.join(refProj, pm.hiSrc))
            .then((st) => st.size > 512, () => false);
          return hiExists ? pm : { ...pm, hiSrc: undefined };
        }),
      );

      // 1. Unified single-speaker Studio Voiceover + faster-whisper word alignment
      const beatTexts = pkg.beats.map((b) => b.voiceover);
      console.log(`  [1/4] Synthesizing unified studio voiceover (voice=${target.voiceId}, beats=${beatTexts.length})...`);
      const voice = await synthesizeVoiceover(beatTexts, workDir, target.voiceId);
      const timing = await timeNarration(voice, workDir);
      await fs.copyFile(voice.audioPath, path.join(refProj, "assets", "voice.wav"));

      const oldDuration = Number(ep.durationSec ?? voice.totalDuration);
      const totalDuration = voice.totalDuration;
      const duration = AUDIO_OFFSET + totalDuration + OUTRO_TAIL;
      console.log(`  [Voice OK] duration=${totalDuration.toFixed(2)}s source=${timing.source} words=${timing.words.length}`);

      // 2. Remap sweeps, camera & scenes to exact spoken word timestamps
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
        mappedScenes.push({
          ...s,
          start,
          end: safeEnd,
          words: sceneWords.length > 0 ? sceneWords : s.words,
        });
      }

      // 3. Direct style-specific HyperFrames visual stage (100% local BookReel engine, ZERO Gemini)
      const theme = bookThemeById(target.themeId);
      console.log(`  [2/4] Directing ${target.reelStyle} stage (theme=${theme.id})...`);
      const directedScenes = await directScenesForStyle(
        target,
        ep.id,
        ep.book.title,
        ep.book.authorVerified ? ep.book.author : null,
        ep.book.archetype,
        pkg,
        mappedScenes,
        refProj,
      );

      // 4. Generate 20% ducked score + viral Reels Earshot Foley SFX
      console.log(`  [3/4] Synthesizing 20% BGM (${target.musicStyle}) + Earshot Reels Foley...`);
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
        scenes: directedScenes,
        strokes: allStrokes,
        speechSpans,
        outPath: path.join(refProj, "assets", "sfx.wav"),
      });

      // 5. Build HyperFrames HTML composition & render 1080x1920 high-quality MP4
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
        reelStyle: target.reelStyle,
        bookTitle: ep.book.title,
        author: ep.book.authorVerified ? ep.book.author : null,
        bookLink: ep.book.bookLink,
        scenes: directedScenes,
      });

      await fs.writeFile(path.join(refProj, "index.html"), upgradedHtml, "utf8");

      const outMp4 = path.join(outDir, `${target.slug}.mp4`);
      const t0 = Date.now();
      console.log(
        `  [4/4 Render START] ${target.slug} (${totalDuration.toFixed(1)}s, style=${target.reelStyle}, sfxCues=${sfxOut.cues.length}, earshotOk=${sfxOut.syncReport.ok})`,
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
