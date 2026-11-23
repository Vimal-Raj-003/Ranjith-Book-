/**
 * 100% Local BookReel ("YT Book") ULTRA-PRO CREATOR 3-Video Showcase Runner.
 *
 * Strictly 100% local (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, zero Gemini / external cloud calls).
 * Produces 3 completely different, example-driven Ultra-Pro Creator Shorts/Reels:
 *   1. `ultra-pro-1-vision-bento`          — Apple Keynote / Iman Gadzhi VisionOS Glass Bento & Live Streak Telemetry
 *   2. `ultra-pro-2-investigative-dossier` — Johnny Harris Dark-Room Investigative Dossier, 50-vs-500k Rig & Red-String Timeline
 *   3. `ultra-pro-3-neuro-lab`             — Kurzgesagt / Cleo Abram Neon Neuroscience Lab & Mid-Flight Hand Swerve Simulator
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

type UltraStyle = "vision-bento" | "investigative-dossier" | "neuro-lab";

interface UltraTarget {
  id: string;
  slug: string;
  reelStyle: UltraStyle;
  themeId: BookThemeId;
  voiceId: string;
  musicStyle: string;
}

const TARGETS: ReadonlyArray<UltraTarget> = [
  {
    id: "cmwqg9xs6009tn6w0pl20v7hv",
    slug: "ultra-pro-1-vision-bento",
    reelStyle: "vision-bento",
    themeId: "terminal",
    voiceId: "charles",
    musicStyle: "terminal",
  },
  {
    id: "cmwqeq60a000xn6w024bcg1su",
    slug: "ultra-pro-2-investigative-dossier",
    reelStyle: "investigative-dossier",
    themeId: "spotlight",
    voiceId: "stuart_bell",
    musicStyle: "spotlight",
  },
  {
    id: "cmwqeq5mc000pn6w0kwb57biu",
    slug: "ultra-pro-3-neuro-lab",
    reelStyle: "neuro-lab",
    themeId: "blueprint",
    voiceId: "george",
    musicStyle: "editorial",
  },
];

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

async function buildUltraScenes(
  target: UltraTarget,
  epId: string,
  bookTitle: string,
  author: string | null,
  archetype: string | null,
  pkg: ContentPackage,
  beatBounds: Array<{ start: number; end: number }>,
  wordsInWindow: (start: number, end: number) => Array<{ word: string; start: number; end: number }>,
  refProj: string,
): Promise<Scene[]> {
  const theme = bookThemeById(target.themeId);

  // =========================================================================
  // VIDEO 1: `ultra-pro-1-vision-bento` (Why One Bad Day Doesn't Ruin Health)
  // =========================================================================
  if (target.reelStyle === "vision-bento") {
    const alertIcon = await loadTablerIcon("alert-circle", "minor misstep single slip");
    const awardIcon = await loadTablerIcon("trophy", "good progress achievement");

    const seedComfy: Scene[] = [
      {
        index: 6,
        kind: "cinematic",
        start: beatBounds[6].start,
        end: beatBounds[6].end,
        tone: "deep",
        environment: "dawn",
        sentences: [6],
        beatIndex: 6,
        source: { pageIndex: 5, startWord: 0, endWord: 12 },
        reason: "Monumental morning stone staircase ascending into golden dawn",
        concept: "monumental stone staircase ascending out of shadow into warm morning light",
        words: wordsInWindow(beatBounds[6].start, beatBounds[6].end),
        cine: { hero: "staircase", keyword: "BookReel", lead: "Practical ideas from books" },
      },
    ];
    const vOut = await generateEpisodeVisuals({
      episodeId: `${target.slug}-p`,
      bookTitle,
      author,
      archetype,
      pkg,
      scenes: seedComfy,
      theme,
      engine: "hybrid-cinematic",
      localAnalysisOnly: true,
      offlineReferences: true,
    });
    for (const asset of vOut.projectAssets) {
      await fs.copyFile(asset.from, path.join(refProj, "assets", asset.to));
    }
    await releaseComfyVramSafely().catch(() => false);
    const finalePlate = vOut.scenes[0]?.cine?.plate;

    return [
      // Beat 0: VisionOS 7-Day Workout/Snack Streak Telemetry Bento Model
      {
        index: 0,
        kind: "cinematic",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "deep",
        environment: "grid",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 4, startWord: 0, endWord: 14 },
        reason: "Animated 7-day workout & snack streak shield telemetry widget",
        concept: "missing one workout or heavy snack inside a 7-day streak",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        transitionIn: "dissolve",
        cine: {
          hero: "focus",
          keyword: "failed",
          lead: "",
          hook: true,
          accentWords: ["planned workout", "heavy snack", "failed"],
          proModel: "streak-shield",
        },
      },
      // Beat 1: VisionOS Dual-Icon Glass Bento Comparison (`Total defeat` vs `Good you're doing`)
      {
        index: 1,
        kind: "comparison",
        start: beatBounds[1].start,
        end: beatBounds[1].end,
        tone: "bright",
        environment: "grid",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 4, startWord: 14, endWord: 28 },
        reason: "Contrasts viewing a minor misstep as total defeat vs reminding yourself of good progress",
        concept: "minor misstep vs good progress",
        words: wordsInWindow(beatBounds[1].start, beatBounds[1].end),
        left: "Total defeat",
        right: "Good you're doing",
        icons: [alertIcon, awardIcon],
        transitionIn: "spring-pop",
      },
      // Beat 2: Bespoke Bad-Weather & Detour Obstacle Radar Simulator (`obstacle-radar`)
      {
        index: 2,
        kind: "cinematic",
        start: beatBounds[2].start,
        end: beatBounds[2].end,
        tone: "deep",
        environment: "grid",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 5, startWord: 0, endWord: 14 },
        reason: "Animates bad weather & unusual obstacles rerouting cleanly back to goal",
        concept: "bad weather and unusual obstacles adaptive route",
        words: wordsInWindow(beatBounds[2].start, beatBounds[2].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "path",
          keyword: "bad weather",
          lead: "Unexpected obstacles happen through",
          proModel: "obstacle-radar",
        },
      },
      // Beat 3: Framed @2x Full-Color NIH Guide Book Proof (`page 5`)
      {
        index: 3,
        kind: "book-crop",
        start: beatBounds[3].start,
        end: beatBounds[3].end,
        tone: "warm",
        environment: "grid",
        sentences: [3],
        beatIndex: 3,
        source: { pageIndex: 5, startWord: 15, endWord: 30 },
        reason: "Direct @2x NIH page proof advising to regroup and meet your goal again",
        concept: "Regroup and focus on meeting your goal",
        crop: { x0: 116.2, y0: 494.4, x1: 558.6, y1: 633.8 },
        shot: "wide",
        transitionIn: "depth-push",
      },
      // Beat 4: Bespoke 365-Day Compounding Health Curve vs 1-Day Blip (`compound-blip`)
      {
        index: 4,
        kind: "cinematic",
        start: beatBounds[4].start,
        end: beatBounds[4].end,
        tone: "deep",
        environment: "grid",
        sentences: [4],
        beatIndex: 4,
        source: { pageIndex: 5, startWord: 31, endWord: 44 },
        reason: "365-day compounding curve contrasting lifelong behaviors against a 1-day blip",
        concept: "lifelong behaviors vs one-time events",
        words: wordsInWindow(beatBounds[4].start, beatBounds[4].end),
        transitionIn: "rise-wipe",
        cine: {
          hero: "growth",
          keyword: "lifelong behaviors",
          lead: "Health is built on",
          proModel: "compound-blip",
        },
      },
      // Beat 5: VisionOS 3-Step Adaptive Control Checklist
      {
        index: 5,
        kind: "steps",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "bright",
        environment: "grid",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 5, startWord: 45, endWord: 60 },
        reason: "Actionable 3-step system for handling planned and unplanned life changes",
        concept: "Adaptive Habit System",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        steps: [
          "Watch your daily efforts",
          "Adjust to planned changes",
          "Regroup on surprise snags",
        ],
        transitionIn: "spring-pop",
      },
      // Beat 6: Dawn Architectural Staircase 2.5D Plate Finale + CTA
      {
        index: 6,
        kind: "cinematic",
        start: beatBounds[6].start,
        end: beatBounds[6].end,
        tone: "deep",
        environment: "dawn",
        sentences: [6],
        beatIndex: 6,
        source: { pageIndex: 5, startWord: 45, endWord: 60 },
        reason: "Ascending stone staircase finale into BookReel CTA",
        concept: "practical ideas from books",
        words: wordsInWindow(beatBounds[6].start, beatBounds[6].end),
        transitionIn: "dissolve",
        cine: {
          hero: "staircase",
          keyword: "BookReel",
          lead: "Practical ideas from books",
          plate: finalePlate,
        },
      },
    ];
  }

  // =========================================================================
  // VIDEO 2: `ultra-pro-2-investigative-dossier` (50 Anarchists vs 500,000)
  // =========================================================================
  if (target.reelStyle === "investigative-dossier") {
    const flameIcon = await loadTablerIcon("flame", "organized minority terror shock");
    const shieldOffIcon = await loadTablerIcon("users", "paralyzed half million crowd");

    const seedComfy: Scene[] = [
      {
        index: 0,
        kind: "cinematic",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "deep",
        environment: "dusk",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 33, startWord: 0, endWord: 14 },
        reason: "Historic European cobblestone city canyon at twilight",
        concept: "wet cobblestone European city street reflecting warm lamps at dusk",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        cine: { hero: "storm", keyword: "Barcelona", lead: "", hook: true },
      },
      {
        index: 5,
        kind: "cinematic",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "deep",
        environment: "still",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 33, startWord: 40, endWord: 55 },
        reason: "Heavy iron links in chiaroscuro stone archway",
        concept: "heavy weathered iron chain links inside dark vaulted stone archway",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        cine: { hero: "chain", keyword: "BookReel", lead: "More ideas from books" },
      },
    ];
    const vOut = await generateEpisodeVisuals({
      episodeId: `${target.slug}-p`,
      bookTitle,
      author,
      archetype,
      pkg,
      scenes: seedComfy,
      theme,
      engine: "hybrid-cinematic",
      localAnalysisOnly: true,
      offlineReferences: true,
    });
    for (const asset of vOut.projectAssets) {
      await fs.copyFile(asset.from, path.join(refProj, "assets", asset.to));
    }
    await releaseComfyVramSafely().catch(() => false);
    const cityPlate = vOut.scenes.find((s) => s.index === 0)?.cine?.plate;
    const ironPlate = vOut.scenes.find((s) => s.index === 5)?.cine?.plate;

    return [
      // Beat 0: Historic Dark Barcelona Cobblestone 2.5D Plate + Hook Card
      {
        index: 0,
        kind: "cinematic",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "deep",
        environment: "dusk",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 33, startWord: 0, endWord: 14 },
        reason: "Atmospheric historic Barcelona dusk 2.5D hook",
        concept: "fifty anarchists seizing Barcelona in hours",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        transitionIn: "dissolve",
        cine: {
          hero: "storm",
          keyword: "Barcelona",
          lead: "",
          hook: true,
          accentWords: ["Fifty anarchists", "Barcelona", "short hours"],
          plate: cityPlate,
        },
      },
      // Beat 1: Bespoke `50 vs 500,000` Crowd Asymmetry War-Room Rig (`crowd-asymmetry`)
      {
        index: 1,
        kind: "cinematic",
        start: beatBounds[1].start,
        end: beatBounds[1].end,
        tone: "deep",
        environment: "grid",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 33, startWord: 15, endWord: 28 },
        reason: "Visualizes 50 operatives vs 500,000 citizens (1 : 10,000 leverage)",
        concept: "50 vs 500000 crowd psychology leverage",
        words: wordsInWindow(beatBounds[1].start, beatBounds[1].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "network",
          keyword: "crowd psychology",
          lead: "How a tiny group masters",
          proModel: "crowd-asymmetry",
          plate: cityPlate,
        },
      },
      // Beat 2: Spotlighted @2x Archival Book Evidence (`page 33`) + Shutter-Snap
      {
        index: 2,
        kind: "book-crop",
        start: beatBounds[2].start,
        end: beatBounds[2].end,
        tone: "warm",
        environment: "still",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 33, startWord: 29, endWord: 42 },
        reason: "Direct archival book proof of laws of terrorisation",
        concept: "laws of terrorisation archival proof",
        crop: { x0: 159.7, y0: 1194.9, x1: 920.6, y1: 1311.1 },
        shot: "wide",
        transitionIn: "depth-push",
      },
      // Beat 3: Bespoke `72-Hour City Collapse` Red-String Dossier Timeline (`barcelona-timeline`)
      {
        index: 3,
        kind: "cinematic",
        start: beatBounds[3].start,
        end: beatBounds[3].end,
        tone: "deep",
        environment: "storm",
        sentences: [3],
        beatIndex: 3,
        source: { pageIndex: 33, startWord: 43, endWord: 56 },
        reason: "3-day investigative red-string evidence timeline of Barcelona's paralysis",
        concept: "three full days churches and schools burned",
        words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
        transitionIn: "rise-wipe",
        cine: {
          hero: "clock",
          keyword: "three full days",
          lead: "Half a million watched for",
          proModel: "barcelona-timeline",
          plate: ironPlate,
        },
      },
      // Beat 4: Manila Dossier Dual-Icon Comparison Card (`Tiny organized group` vs `Paralyzed crowd`)
      {
        index: 4,
        kind: "comparison",
        start: beatBounds[4].start,
        end: beatBounds[4].end,
        tone: "bright",
        environment: "dusk",
        sentences: [4],
        beatIndex: 4,
        source: { pageIndex: 33, startWord: 57, endWord: 70 },
        reason: "Contrasts organized terror force vs paralyzed half-million crowd",
        concept: "raw terror vs crowd surrender",
        words: wordsInWindow(beatBounds[4].start, beatBounds[4].end),
        left: "50 using fear",
        right: "500k paralyzed",
        icons: [flameIcon, shieldOffIcon],
        bgImageSrc: cityPlate?.imageSrc,
        transitionIn: "spring-pop",
      },
      // Beat 5: Dark Vaulted Iron Archway 2.5D Finale + CTA
      {
        index: 5,
        kind: "cinematic",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "deep",
        environment: "still",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 33, startWord: 57, endWord: 70 },
        reason: "Dark investigative finale into BookReel CTA",
        concept: "more ideas from books",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        transitionIn: "dissolve",
        cine: {
          hero: "chain",
          keyword: "BookReel",
          lead: "Hidden psychology from books",
          plate: ironPlate,
        },
      },
    ];
  }

  // =========================================================================
  // VIDEO 3: `ultra-pro-3-neuro-lab` (Why Your Hand Can Swerve Mid-Choice)
  // =========================================================================
  const arrowLeftIcon = await loadTablerIcon("arrow-up-left", "first impulse reaching left");
  const targetIcon = await loadTablerIcon("target-arrow", "stronger value override target K");

  const seedNeuro: Scene[] = [
    {
      index: 7,
      kind: "cinematic",
      start: beatBounds[7].start,
      end: beatBounds[7].end,
      tone: "deep",
      environment: "deep",
      sentences: [7],
      beatIndex: 7,
      source: { pageIndex: 208, startWord: 60, endWord: 75 },
      reason: "Classical laboratory glass instruments & warm study lamp",
      concept: "historic laboratory study desk with brass chronometer and glass instruments in low key light",
      words: wordsInWindow(beatBounds[7].start, beatBounds[7].end),
      cine: { hero: "clock", keyword: "BookReel", lead: "More ideas from books" },
    },
  ];
  const vNeuro = await generateEpisodeVisuals({
    episodeId: `${target.slug}-p`,
    bookTitle,
    author,
    archetype,
    pkg,
    scenes: seedNeuro,
    theme,
    engine: "hybrid-cinematic",
    localAnalysisOnly: true,
    offlineReferences: true,
  });
  for (const asset of vNeuro.projectAssets) {
    await fs.copyFile(asset.from, path.join(refProj, "assets", asset.to));
  }
  await releaseComfyVramSafely().catch(() => false);
  const labPlate = vNeuro.scenes[0]?.cine?.plate;

  return [
    // Beat 0: Neon Neuro-Lab Hook + Concentric Focus Reticle Vector (`vectorMode`)
    {
      index: 0,
      kind: "cinematic",
      start: beatBounds[0].start,
      end: beatBounds[0].end,
      tone: "deep",
      environment: "deep",
      sentences: [0],
      beatIndex: 0,
      source: { pageIndex: 208, startWord: 0, endWord: 12 },
      reason: "Neon neuroscience hook questioning locked decisions",
      concept: "final decision locked when movement starts",
      words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
      transitionIn: "dissolve",
      cine: {
        hero: "focus",
        keyword: "locked",
        lead: "",
        hook: true,
        accentWords: ["final decision", "locked", "start moving"],
        vectorMode: true,
      },
    },
    // Beat 1 & Beat 2 combined/sequenced: Bespoke 1910 Lab Choice-Reaction Overhead Table (`lab-apparatus`)
    {
      index: 1,
      kind: "cinematic",
      start: beatBounds[1].start,
      end: beatBounds[2].end,
      tone: "deep",
      environment: "grid",
      sentences: [1, 2],
      beatIndex: 1,
      source: { pageIndex: 208, startWord: 13, endWord: 32 },
      reason: "Overhead laboratory schematic showing Subject Hand, Object L (Left), and Object K (Right)",
      concept: "laboratory table with left object and right object",
      words: wordsInWindow(beatBounds[1].start, beatBounds[2].end),
      transitionIn: "whip-pan",
      cine: {
        hero: "mind",
        keyword: "left side",
        lead: "Subject reached toward object on",
        proModel: "lab-apparatus",
      },
    },
    // Beat 3: Bespoke Mid-Flight Hand Swerve Bezier Trajectory Simulator (`hand-swerve-arc`)
    {
      index: 2,
      kind: "cinematic",
      start: beatBounds[3].start,
      end: beatBounds[3].end,
      tone: "deep",
      environment: "deep",
      sentences: [3],
      beatIndex: 3,
      source: { pageIndex: 208, startWord: 33, endWord: 45 },
      reason: "Live physics simulation of hand trajectory swerving mid-flight from L to K",
      concept: "well directed hand movement swerving on sudden realization",
      words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
      transitionIn: "spring-pop",
      cine: {
        hero: "path",
        keyword: "sudden realization",
        lead: "Movement swerved mid-air as",
        proModel: "hand-swerve-arc",
      },
    },
    // Beat 4: @2x Lab-Framed Archival Book Proof (`page 208` — "The direction of my hand formed a curve")
    {
      index: 3,
      kind: "book-crop",
      start: beatBounds[4].start,
      end: beatBounds[4].end,
      tone: "warm",
      environment: "grid",
      sentences: [4],
      beatIndex: 4,
      source: { pageIndex: 208, startWord: 46, endWord: 68 },
      reason: "Exact @2x book page scan of 'The direction of my hand formed a curve'",
      concept: "The direction of my hand formed a curve",
      crop: { x0: 73.3, y0: 1270.4, x1: 834.1, y1: 1368.3 },
      shot: "wide",
      transitionIn: "depth-push",
    },
    // Beat 5: Live Three.js 3D Gravitational Orbit Hijack Sculpture (`HEROES.orbit`)
    {
      index: 4,
      kind: "cinematic",
      start: beatBounds[5].start,
      end: beatBounds[5].end,
      tone: "deep",
      environment: "deep",
      sentences: [5],
      beatIndex: 5,
      source: { pageIndex: 208, startWord: 69, endWord: 80 },
      reason: "Live Three.js 3D orbital capture showing fresh attraction hijacking momentum",
      concept: "fresh attraction hijacking physical momentum",
      words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
      transitionIn: "depth-push",
      cine: {
        hero: "orbit",
        keyword: "last instant",
        lead: "Fresh attraction hijacks momentum at",
      },
    },
    // Beat 6: Neon Lab Dual-Icon Comparison Card (`First impulse` vs `Stronger value`)
    {
      index: 5,
      kind: "comparison",
      start: beatBounds[6].start,
      end: beatBounds[6].end,
      tone: "bright",
      environment: "grid",
      sentences: [6],
      beatIndex: 6,
      source: { pageIndex: 208, startWord: 81, endWord: 92 },
      reason: "Contrasts initial motor impulse against stronger value override",
      concept: "first impulse vs stronger value override",
      words: wordsInWindow(beatBounds[6].start, beatBounds[6].end),
      left: "First impulse",
      right: "Stronger value",
      icons: [arrowLeftIcon, targetIcon],
      bgImageSrc: labPlate?.imageSrc,
      transitionIn: "spring-pop",
    },
    // Beat 7: Historic Lab Chronometer 2.5D Plate Finale + CTA
    {
      index: 6,
      kind: "cinematic",
      start: beatBounds[7].start,
      end: beatBounds[7].end,
      tone: "deep",
      environment: "still",
      sentences: [7],
      beatIndex: 7,
      source: { pageIndex: 208, startWord: 81, endWord: 92 },
      reason: "Lab chronometer dark finale into BookReel CTA",
      concept: "more ideas from books",
      words: wordsInWindow(beatBounds[7].start, beatBounds[7].end),
      transitionIn: "dissolve",
      cine: {
        hero: "clock",
        keyword: "BookReel",
        lead: "More neuroscience from books",
        plate: labPlate,
      },
    },
  ];
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
      console.log(`Building ULTRA-PRO Video: ${target.slug} [${target.reelStyle}]`);
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

      const refProj = path.join(cwd, ".bookreel", "projects", target.slug);
      const workDir = path.join(cwd, ".bookreel", "work", target.slug);
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

      // 1. Unified single-speaker Studio Voiceover + faster-whisper alignment
      const beatTexts = pkg.beats.map((b) => b.voiceover);
      console.log(`  [1/4] Synthesizing unified studio voiceover (voice=${target.voiceId}, beats=${beatTexts.length})...`);
      const voice = await synthesizeVoiceover(beatTexts, workDir, target.voiceId);
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

      // 3. Build Ultra-Pro Creator example models & local 2.5D plates
      console.log(`  [2/4] Directing Ultra-Pro ${target.reelStyle} models & plates...`);
      const ultraScenes = await buildUltraScenes(
        target,
        ep.id,
        ep.book.title,
        ep.book.authorVerified ? ep.book.author : null,
        ep.book.archetype,
        pkg,
        beatBounds,
        wordsInWindow,
        refProj,
      );

      // 4. Generate 20% ducked score + Earshot Foley SFX
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
        scenes: ultraScenes,
        strokes: allStrokes,
        speechSpans,
        outPath: path.join(refProj, "assets", "sfx.wav"),
      });

      const theme = bookThemeById(target.themeId);
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
        scenes: ultraScenes,
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
