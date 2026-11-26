/**
 * 100% Local BookReel ("YT Book") 3-VIDEO ZERO-REPEAT GLASSMORPHISM & REAL-SFX RUNNER.
 *
 * Strictly 100% local (`BOOKREEL_VISUAL_LOCAL_ONLY = "1"`, zero Gemini / external calls).
 * Renders 3 fresh, distinct 1080×1920 (`--quality high`) reference videos showcasing:
 *   - ZERO REPEATED ANIMATIONS across all 18 scenes (12 brand-new Glassmorphism interactive
 *     UI rigs + 3 @2x spotlighted archival book proofs + 3 anti-aliased live 3D heroes = 18 unique scenes).
 *   - True Spatial Glassmorphism (`glassmorphism-ui`: `glass-sapphire`, `glass-emerald`,
 *     `glass-amethyst` frosted glass panels with `backdrop-filter: blur(26px) saturate(165%)`,
 *     specular rim catchlights, and glowing ambient aurora orbs).
 *   - Real studio sound effects from `<workspace>/sfx/` (`sfx-library.ts`), matched to each
 *     specific Glassmorphism animation (chronometer gears, neural circuits, vault clicks,
 *     archival shutters, VisionOS glass chimes) and placed sparsely (`>= 5.2s` gap).
 *   - 20% ducked background music + 3 distinct single-speaker Studio Voices (`george`, `charles`, `stuart_bell`).
 */
process.env.BOOKREEL_VISUAL_LOCAL_ONLY = "1";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
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

interface RefSpec {
  episodeId: string;
  slug: string;
  voiceId: string;
  themeId: BookThemeId;
  musicStyle: string;
  sfxModelHint: string;
}

const TARGETS: ReadonlyArray<RefSpec> = [
  {
    episodeId: "cmwqeq5fb000nn6w00khoy2f5",
    slug: "ref-1-glass-fast-decisions",
    voiceId: "george",
    themeId: "blueprint",
    musicStyle: "editorial",
    sfxModelHint: "glassmorphism-ui",
  },
  {
    episodeId: "cmwqg9xla009rn6w0p8xcv1qo",
    slug: "ref-2-glass-boring-habits",
    voiceId: "charles",
    themeId: "terminal",
    musicStyle: "terminal",
    sfxModelHint: "glassmorphism-ui",
  },
  {
    episodeId: "cmwqeq56h000hn6w083wcs3rv",
    slug: "ref-3-glass-past-regret",
    voiceId: "stuart_bell",
    themeId: "blueprint",
    musicStyle: "blueprint",
    sfxModelHint: "glassmorphism-ui",
  },
];

function mapTime(t: number, oldTotal: number, newTotal: number): number {
  if (oldTotal <= 0) return t;
  return Math.max(0, Math.min(newTotal, +(t * (newTotal / oldTotal)).toFixed(3)));
}

async function buildScenesForTarget(
  spec: RefSpec,
  bookTitle: string,
  author: string | null,
  archetype: string | null,
  pkg: ContentPackage,
  beatBounds: Array<{ start: number; end: number }>,
  wordsInWindow: (start: number, end: number) => Array<{ word: string; start: number; end: number }>,
  refProj: string,
): Promise<Scene[]> {
  const theme = bookThemeById(spec.themeId);

  // =========================================================================
  // VIDEO 1: `ref-1-glass-fast-decisions` — Sapphire-Cyan Glassmorphism
  // Unique rigs: glass-radial-gauge, book-crop p.114, glass-prism-spectrum,
  //              glass-balance-scale, glass-iceberg-depth, 3D HEROES.clock
  // =========================================================================
  if (spec.slug === "ref-1-glass-fast-decisions") {
    return [
      // Beat 0: Sapphire Glassmorphism Radial Velocity Gauge (`glass-radial-gauge`)
      {
        index: 0,
        kind: "cinematic",
        sceneModel: "glass-sapphire",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "cool",
        environment: "still",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 114, startWord: 0, endWord: 12 },
        reason: "Sapphire Glassmorphism radial velocity dial showing instant decision pull",
        concept: "how fast you choose reveals what you really want",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        transitionIn: "dissolve",
        cine: {
          hero: "mind",
          keyword: "fast you choose",
          lead: "",
          hook: true,
          accentWords: ["really want", "fast", "choose"],
          proModel: "glass-radial-gauge",
          proMeta: {
            kicker: "DECISION VELOCITY DIAL",
            badge: "INSTANT PULL",
            statBig: "0.18s",
            calloutTag: "SIGNAL",
            calloutText: "Reaction speed exposes true hidden motive",
          },
        },
      },
      // Beat 1: Frosted Glass Spotlighted @2x Archival Book Proof (p.114)
      {
        index: 1,
        kind: "book-crop",
        sceneModel: "glass-sapphire",
        start: beatBounds[1].start,
        end: beatBounds[1].end,
        tone: "cool",
        environment: "grid",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 114, startWord: 12, endWord: 26 },
        reason: "Spotlighted @2x page 114 proof framed in frosted sapphire glass",
        concept: "speed of selection matches weight of pull",
        crop: { x0: 67, y0: 774, x1: 823, y1: 833.5 },
        shot: "wide",
        transitionIn: "depth-push",
      },
      // Beat 2: Sapphire Glassmorphism Optical Prism Spectrum (`glass-prism-spectrum`)
      {
        index: 2,
        kind: "cinematic",
        sceneModel: "glass-sapphire",
        start: beatBounds[2].start,
        end: beatBounds[2].end,
        tone: "deep",
        environment: "grid",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 114, startWord: 27, endWord: 42 },
        reason: "Glass optical prism refracting choice beam straight toward preferred path",
        concept: "mind snatches preferred path with swiftness",
        words: wordsInWindow(beatBounds[2].start, beatBounds[2].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "path",
          keyword: "great swiftness",
          lead: "Mind snatches preferred path with",
          proModel: "glass-prism-spectrum",
          proMeta: {
            kicker: "DECISION SPECTRUM PRISM",
            badge: "CLARITY",
            leftTitle: "Negative Path",
            rightTitle: "Preferred ✓",
            calloutTag: "FOCUS",
            calloutText: "Mind snaps immediately toward stronger desire",
          },
        },
      },
      // Beat 3: Sapphire Glassmorphism Precision Balance Scale (`glass-balance-scale`)
      {
        index: 3,
        kind: "cinematic",
        sceneModel: "glass-sapphire",
        start: beatBounds[3].start,
        end: beatBounds[3].end,
        tone: "cool",
        environment: "grid",
        sentences: [3],
        beatIndex: 3,
        source: { pageIndex: 114, startWord: 43, endWord: 58 },
        reason: "Glass fulcrum balance weighing internal doubt against true motive pull",
        concept: "internal doubt vs true motive weight",
        words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
        transitionIn: "spring-pop",
        cine: {
          hero: "scales",
          keyword: "motive force",
          lead: "Hesitation melts under stronger",
          proModel: "glass-balance-scale",
          proMeta: {
            kicker: "CHOICE WEIGHT EQUILIBRIUM",
            badge: "DECISIVE",
            leftTitle: "Internal Doubt",
            rightTitle: "True Motive ✓",
            calloutTag: "TILT",
            calloutText: "Stronger motive tips the scale in milliseconds",
          },
        },
      },
      // Beat 4: Sapphire Glassmorphism Subconscious Iceberg (`glass-iceberg-depth`)
      {
        index: 4,
        kind: "cinematic",
        sceneModel: "glass-sapphire",
        start: beatBounds[4].start,
        end: beatBounds[4].end,
        tone: "deep",
        environment: "grid",
        sentences: [4],
        beatIndex: 4,
        source: { pageIndex: 114, startWord: 59, endWord: 72 },
        reason: "Glass iceberg diagram contrasting 10% conscious story vs 90% actual preference",
        concept: "reaction time lays bare actual preference",
        words: wordsInWindow(beatBounds[4].start, beatBounds[4].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "focus",
          keyword: "actual preference",
          lead: "Reaction time lays bare your",
          proModel: "glass-iceberg-depth",
          proMeta: {
            kicker: "SUBCONSCIOUS MOTIVE DEPTH",
            badge: "90% HIDDEN",
            leftTitle: "10% Rational Story",
            rightTitle: "90% Actual Preference ✓",
            calloutTag: "TRUTH",
            calloutText: "Bypasses every excuse you tell yourself",
          },
        },
      },
      // Beat 5: Anti-Aliased 3D Platinum-Sapphire Chronometer Finale (`HEROES.clock`)
      {
        index: 5,
        kind: "cinematic",
        sceneModel: "glass-sapphire",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "cool",
        environment: "still",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 114, startWord: 73, endWord: 82 },
        reason: "Anti-aliased 3D platinum-sapphire chronometer finale",
        concept: "notice how fast you reach today",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        transitionIn: "dissolve",
        cine: {
          hero: "clock",
          keyword: "reach today",
          lead: "Notice how fast you",
          vectorMode: false,
        },
      },
    ];
  }

  // =========================================================================
  // VIDEO 2: `ref-2-glass-boring-habits` — Emerald-Mint Glassmorphism
  // Unique rigs: glass-battery-drain, glass-split-bars, book-crop p.5,
  //              glass-orbit-gravity, glass-step-staircase, 3D HEROES.staircase
  // =========================================================================
  if (spec.slug === "ref-2-glass-boring-habits") {
    const seedComfy: Scene[] = [
      {
        index: 5,
        kind: "cinematic",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "cool",
        environment: "still",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 5, startWord: 0, endWord: 12 },
        reason: "Calm minimalist stone garden steps in soft cool morning mist",
        concept:
          "minimalist architectural stone steps rising through serene morning mist in muted sage green and cool slate tones, calm natural daylight",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        cine: { hero: "staircase", keyword: "next excuse", lead: "Save this before your" },
      },
    ];
    const vOut = await generateEpisodeVisuals({
      episodeId: `${spec.slug}-calm`,
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
      const destPath = path.join(refProj, "assets", asset.to);
      if (/plate-5\.(jpg|png)$/i.test(asset.to)) {
        const srcBuf = await fs.readFile(asset.from);
        const toned = await sharp(srcBuf)
          .modulate({ saturation: 0.65, brightness: 0.84 })
          .tint({ r: 196, g: 224, b: 228 })
          .jpeg({ quality: 95, mozjpeg: true })
          .toBuffer();
        await fs.writeFile(destPath, toned);
      } else {
        await fs.copyFile(asset.from, destPath);
      }
    }
    await releaseComfyVramSafely().catch(() => false);
    const rawStairPlate = vOut.scenes[0]?.cine?.plate;
    const stairPlate = rawStairPlate
      ? {
          ...rawStairPlate,
          colorGrade: "cool-noir" as const,
          dominantHex: "#0b1922",
          accentHex: "#34d399",
          shadowHex: "#040a10",
        }
      : undefined;

    return [
      // Beat 0: Emerald Glassmorphism Habit Energy Battery (`glass-battery-drain`)
      {
        index: 0,
        kind: "cinematic",
        sceneModel: "glass-emerald",
        start: beatBounds[0].start,
        end: beatBounds[0].end,
        tone: "cool",
        environment: "grid",
        sentences: [0],
        beatIndex: 0,
        source: { pageIndex: 5, startWord: 0, endWord: 16 },
        reason: "Emerald frosted-glass battery reserve warning before boredom causes quitting",
        concept: "healthy routine boredom warning before quitting",
        words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
        transitionIn: "dissolve",
        cine: {
          hero: "focus",
          keyword: "monotony",
          lead: "",
          hook: true,
          accentWords: ["boring", "quit", "Monotony"],
          proModel: "glass-battery-drain",
          proMeta: {
            kicker: "HABIT ENERGY RESERVE",
            badge: "RECHARGE NOW",
            calloutTag: "ALERT",
            calloutText: "Monotony drains drive before willpower",
          },
        },
      },
      // Beat 1: Emerald Glassmorphism Split Telemetry Bars (`glass-split-bars`)
      {
        index: 1,
        kind: "cinematic",
        sceneModel: "glass-emerald",
        start: beatBounds[1].start,
        end: beatBounds[1].end,
        tone: "cool",
        environment: "grid",
        sentences: [1],
        beatIndex: 1,
        source: { pageIndex: 5, startWord: 17, endWord: 32 },
        reason: "Frosted glass horizontal telemetry bars comparing passive boredom vs active variety",
        concept: "passive routine vs active effort",
        words: wordsInWindow(beatBounds[1].start, beatBounds[1].end),
        transitionIn: "spring-pop",
        cine: {
          hero: "scales",
          keyword: "stay interested",
          lead: "Consistency requires active variety to",
          proModel: "glass-split-bars",
          proMeta: {
            kicker: "ROUTINE ENGAGEMENT INDEX",
            badge: "+68% RETENTION",
            leftTitle: "Passive Monotony",
            rightTitle: "Active Variety ✓",
            calloutTag: "DELTA",
            calloutText: "Deliberate novelty keeps healthy habits alive",
          },
        },
      },
      // Beat 2: Full-Color @2x NIH Guide Book Crop Proof in Emerald Glass Frame (p.5)
      {
        index: 2,
        kind: "book-crop",
        sceneModel: "glass-emerald",
        start: beatBounds[2].start,
        end: beatBounds[2].end,
        tone: "cool",
        environment: "grid",
        sentences: [2],
        beatIndex: 2,
        source: { pageIndex: 5, startWord: 33, endWord: 48 },
        reason: "Direct @2x NIH guide proof on avoiding slip-ups",
        concept: "avoid slip ups with reliable ways to cope",
        crop: { x0: 116.9, y0: 252.7, x1: 568, y1: 311.8 },
        shot: "wide",
        transitionIn: "depth-push",
      },
      // Beat 3: Emerald Glassmorphism Orbital Variety Ecosystem (`glass-orbit-gravity`)
      {
        index: 3,
        kind: "cinematic",
        sceneModel: "glass-emerald",
        start: beatBounds[3].start,
        end: beatBounds[3].end,
        tone: "deep",
        environment: "grid",
        sentences: [3],
        beatIndex: 3,
        source: { pageIndex: 5, startWord: 49, endWord: 64 },
        reason: "3-ring glass orbital system showing new activities and workout buddies",
        concept: "mix up routine with new activities and workout buddies",
        words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
        transitionIn: "whip-pan",
        cine: {
          hero: "network",
          keyword: "new activities",
          lead: "Mix up your routine with",
          proModel: "glass-orbit-gravity",
          proMeta: {
            kicker: "VARIETY ECOSYSTEM ORBIT",
            badge: "IN MOTION",
            leftTitle: "New Activities",
            rightTitle: "Activity Buddy",
            calloutTag: "CORE",
            calloutText: "Social & movement variety locks in long-term pull",
          },
        },
      },
      // Beat 4: Emerald Glassmorphism 4-Step Ascending Momentum Pillars (`glass-step-staircase`)
      {
        index: 4,
        kind: "cinematic",
        sceneModel: "glass-emerald",
        start: beatBounds[4].start,
        end: beatBounds[4].end,
        tone: "cool",
        environment: "grid",
        sentences: [4],
        beatIndex: 4,
        source: { pageIndex: 5, startWord: 65, endWord: 80 },
        reason: "4 ascending frosted-glass pillars showing daily variety upgrades",
        concept: "swap foods recipes rewards to keep habits fresh",
        words: wordsInWindow(beatBounds[4].start, beatBounds[4].end),
        transitionIn: "spring-pop",
        cine: {
          hero: "staircase",
          keyword: "change rewards",
          lead: "Swap foods, try recipes, and",
          proModel: "glass-step-staircase",
          proMeta: {
            kicker: "HABIT REFRESH STAIRCASE",
            badge: "4 UPGRADES",
            items: ["Foods", "Recipes", "Rewards", "Fresh ✓"],
            calloutTag: "RESULT",
            calloutText: "Small weekly swaps keep boredom at zero",
          },
        },
      },
      // Beat 5: Calm Cool-Emerald Morning Stone Steps 2.5D Plate + 3D Staircase Finale
      {
        index: 5,
        kind: "cinematic",
        sceneModel: "glass-emerald",
        start: beatBounds[5].start,
        end: beatBounds[5].end,
        tone: "cool",
        environment: "still",
        sentences: [5],
        beatIndex: 5,
        source: { pageIndex: 5, startWord: 81, endWord: 90 },
        reason: "Calm misty morning stone steps finale into CTA",
        concept: "save this before your next excuse",
        words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
        transitionIn: "dissolve",
        cine: {
          hero: "staircase",
          keyword: "next excuse",
          lead: "Save this before your",
          plate: stairPlate,
        },
      },
    ];
  }

  // =========================================================================
  // VIDEO 3: `ref-3-glass-past-regret` — Amethyst-Sapphire Glassmorphism
  // Unique rigs: glass-radar-sonar, glass-domino-chain, book-crop p.192,
  //              glass-neural-synapse, glass-vault-unlock, 3D HEROES.chain
  // =========================================================================
  return [
    // Beat 0: Amethyst Glassmorphism 360° Rumination Sonar (`glass-radar-sonar`)
    {
      index: 0,
      kind: "cinematic",
      sceneModel: "glass-amethyst",
      start: beatBounds[0].start,
      end: beatBounds[0].end,
      tone: "cool",
      environment: "still",
      sentences: [0],
      beatIndex: 0,
      source: { pageIndex: 192, startWord: 0, endWord: 16 },
      reason: "Amethyst frosted-glass polar sonar scanning hidden rumination traps",
      concept: "replaying a past choice builds a mental trap",
      words: wordsInWindow(beatBounds[0].start, beatBounds[0].end),
      transitionIn: "dissolve",
      cine: {
        hero: "chain",
        keyword: "mental trap",
        lead: "",
        hook: true,
        accentWords: ["past choice", "mental trap"],
        proModel: "glass-radar-sonar",
        proMeta: {
          kicker: "RUMINATION TRAP SCANNER",
          badge: "TRAP DETECTED",
          calloutTag: "SCAN",
          calloutText: "Replaying choices wires chronic doubt",
        },
      },
    },
    // Beat 1: Amethyst Glassmorphism 4-Tile Domino Cascade (`glass-domino-chain`)
    {
      index: 1,
      kind: "cinematic",
      sceneModel: "glass-amethyst",
      start: beatBounds[1].start,
      end: beatBounds[1].end,
      tone: "cool",
      environment: "grid",
      sentences: [1],
      beatIndex: 1,
      source: { pageIndex: 192, startWord: 17, endWord: 32 },
      reason: "Frosted glass domino chain reaction illustrating how repining triggers hesitation",
      concept: "repining over what you picked creates path to hesitation",
      words: wordsInWindow(beatBounds[1].start, beatBounds[1].end),
      transitionIn: "whip-pan",
      cine: {
        hero: "path",
        keyword: "hesitation",
        lead: "Repining builds a direct path to",
        proModel: "glass-domino-chain",
        proMeta: {
          kicker: "REGRET CASCADE REACTION",
          badge: "CHAIN EFFECT",
          items: ["Replay", "Repine", "Friction", "Freeze"],
          calloutTag: "TRAP",
          calloutText: "One backward loop topples future decisiveness",
        },
      },
    },
    // Beat 2: Spotlighted @2x Archival Book Proof in Amethyst Glass Frame (p.192)
    {
      index: 2,
      kind: "book-crop",
      sceneModel: "glass-amethyst",
      start: beatBounds[2].start,
      end: beatBounds[2].end,
      tone: "cool",
      environment: "grid",
      sentences: [2],
      beatIndex: 2,
      source: { pageIndex: 192, startWord: 33, endWord: 48 },
      reason: "Spotlighted @2x archival scan on careless valuations and futile repining",
      concept: "careless valuations and futile repining predispose hesitation",
      crop: { x0: 60.2, y0: 1075.3, x1: 817.2, y1: 1191.1 },
      shot: "wide",
      transitionIn: "depth-push",
    },
    // Beat 3: Amethyst Glassmorphism Neural Synapse Rewire (`glass-neural-synapse`)
    {
      index: 3,
      kind: "cinematic",
      sceneModel: "glass-amethyst",
      start: beatBounds[3].start,
      end: beatBounds[3].end,
      tone: "cool",
      environment: "grid",
      sentences: [3],
      beatIndex: 3,
      source: { pageIndex: 194, startWord: 0, endWord: 16 },
      reason: "6-node bioluminescent glass neural circuit rerouting past agony into forward action",
      concept: "prior agony stall rerouted to decisive action",
      words: wordsInWindow(beatBounds[3].start, beatBounds[3].end),
      transitionIn: "spring-pop",
      cine: {
        hero: "mind",
        keyword: "prior agony",
        lead: "Release emotional friction from",
        proModel: "glass-neural-synapse",
        proMeta: {
          kicker: "COGNITIVE PATHWAY REWIRE",
          badge: "REROUTED",
          leftTitle: "OLD AGONY",
          rightTitle: "CLEAR CHOICE ✓",
          calloutTag: "SYNAPSE",
          calloutText: "Letting friction go frees executive response",
        },
      },
    },
    // Beat 4: Amethyst Glassmorphism Precision Vault Unlock (`glass-vault-unlock`)
    {
      index: 4,
      kind: "cinematic",
      sceneModel: "glass-amethyst",
      start: beatBounds[4].start,
      end: beatBounds[4].end,
      tone: "deep",
      environment: "grid",
      sentences: [4],
      beatIndex: 4,
      source: { pageIndex: 194, startWord: 17, endWord: 32 },
      reason: "Precision glass lock mechanism releasing mental freeze",
      concept: "stop training your brain to freeze up",
      words: wordsInWindow(beatBounds[4].start, beatBounds[4].end),
      transitionIn: "whip-pan",
      cine: {
        hero: "loop",
        keyword: "freeze up",
        lead: "Stop training your brain to",
        proModel: "glass-vault-unlock",
        proMeta: {
          kicker: "HESITATION LOCK RELEASE",
          badge: "UNLOCKED ✓",
          statBig: "FREE",
          leftTitle: "DROP REGRET",
          rightTitle: "ACT CLEARLY",
          calloutTag: "OPEN",
          calloutText: "Accept the past choice — move cleanly forward",
        },
      },
    },
    // Beat 5: Anti-Aliased 3D Brushed Steel Chain Breaking Free (`HEROES.chain`)
    {
      index: 5,
      kind: "cinematic",
      sceneModel: "glass-amethyst",
      start: beatBounds[5].start,
      end: beatBounds[5].end,
      tone: "cool",
      environment: "still",
      sentences: [5],
      beatIndex: 5,
      source: { pageIndex: 194, startWord: 33, endWord: 42 },
      reason: "Live Three.js 3D chain breaking free into BookReel CTA",
      concept: "breaking free from past regret chains",
      words: wordsInWindow(beatBounds[5].start, beatBounds[5].end),
      transitionIn: "dissolve",
      cine: {
        hero: "chain",
        keyword: "BookReel",
        lead: "More insights from books on",
        vectorMode: false,
      },
    },
  ];
}

async function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, ".bookreel", "renders", "reference");
  await fs.mkdir(outDir, { recursive: true });

  const onlySlug = process.env.BOOKREEL_ONLY_SLUG?.trim();
  const activeTargets = onlySlug ? TARGETS.filter((t) => t.slug === onlySlug) : TARGETS;

  try {
    for (const spec of activeTargets) {
      const ep = await prisma.episode.findUnique({
        where: { id: spec.episodeId },
        include: { book: true },
      });
      if (!ep || !ep.projectPath || !ep.visualPlan) {
        throw new Error(`Episode missing render data: ${spec.episodeId}`);
      }

      console.log(`\n======================================================`);
      console.log(`Rendering Zero-Repeat Glassmorphism Video: ${spec.slug}`);
      console.log(`Episode: ${ep.title} (voice=${spec.voiceId})`);
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

      const refProj = path.join(cwd, ".bookreel", "projects", spec.slug);
      const workDir = path.join(os.tmpdir(), "bookreel-work", spec.slug);
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

      // 1. Unified single-speaker Studio Voiceover + faster-whisper word alignment
      const beatTexts = pkg.beats.map((b) => b.voiceover);
      const voice = await synthesizeVoiceover(beatTexts, workDir, spec.voiceId);
      const timing = await timeNarration(voice, workDir);
      await fs.copyFile(voice.audioPath, path.join(refProj, "assets", "voice.wav"));

      const oldDuration = Number(ep.durationSec ?? voice.totalDuration);
      const totalDuration = voice.totalDuration;
      const duration = AUDIO_OFFSET + totalDuration + OUTRO_TAIL;

      // 2. Remap sweeps & camera to exact spoken word timestamps
      const origVPlan = JSON.parse(ep.visualPlan) as { sweeps: SweepStep[][]; camera: CameraKey[] };
      const sweeps: SweepStep[][] = origVPlan.sweeps.map((beatSteps, bi) => {
        const bAudio = timing.beats[bi];
        if (!beatSteps.length || !bAudio) return [];
        const oldMin = beatSteps[0].start;
        const oldMax = Math.max(oldMin + 0.05, beatSteps[beatSteps.length - 1].end);
        const newSpan = Math.max(0.15, bAudio.speechStart < bAudio.speechEnd ? bAudio.speechEnd - bAudio.speechStart : 0.5);
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

      const scenes = await buildScenesForTarget(
        spec,
        ep.book.title,
        ep.book.authorVerified ? ep.book.author : null,
        ep.book.archetype,
        pkg,
        beatBounds,
        wordsInWindow,
        refProj,
      );

      // 3. 20% ducked score + selective animation-matched real `sfx/` cues
      const musicPath = path.join(refProj, "assets", "music.wav");
      const hasMusic = await generateCinematicScoreWav(duration, musicPath, {
        style: spec.musicStyle,
        voicePath: voice.audioPath,
        voiceOffsetSec: AUDIO_OFFSET,
        targetMeanDb: -25,
      }).then(() => true, () => false);

      const speechSpans = timing.words.map((w) => ({ start: w.start, end: w.end }));
      const sfxOut = await generateSfxTrack({
        durationSec: duration,
        audioOffsetSec: AUDIO_OFFSET,
        scenes,
        speechSpans,
        reelModel: spec.sfxModelHint,
        seedKey: `${spec.episodeId}::${spec.slug}`,
        outPath: path.join(refProj, "assets", "sfx.wav"),
      });

      console.log(
        `  [Selective SFX] cues=${sfxOut.cues.length} files=[${(sfxOut.usedFiles ?? []).join(", ")}] syncOk=${sfxOut.syncReport.ok}`,
      );

      // 4. Build composition & render 1080×1920 MP4 via os.tmpdir() (preserving G: disk headroom)
      const theme = bookThemeById(spec.themeId);
      const html = buildComposition({
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
        reelStyle: "glassmorphism-ui",
        bookTitle: ep.book.title,
        author: ep.book.authorVerified ? ep.book.author : null,
        bookLink: ep.book.bookLink,
        scenes,
      });

      await fs.writeFile(path.join(refProj, "index.html"), html, "utf8");

      const outMp4 = path.join(outDir, `${spec.slug}.mp4`);
      const tmpOutMp4 = path.join(os.tmpdir(), `${spec.slug}-${Date.now()}.mp4`);
      const t0 = Date.now();
      await renderProject(refProj, tmpOutMp4, "high", "local", 1);
      await fs.copyFile(tmpOutMp4, outMp4);
      await fs.rm(tmpOutMp4, { force: true }).catch(() => {});
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      // Clean temporary project copy after render so G: keeps maximum free space
      await fs.rm(refProj, { recursive: true, force: true }).catch(() => {});

      const stat = await fs.stat(outMp4);
      console.log(
        `  [DONE] ${spec.slug}.mp4 -> ${(stat.size / (1024 * 1024)).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
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
