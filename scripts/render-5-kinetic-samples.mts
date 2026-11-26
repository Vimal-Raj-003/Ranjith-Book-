/**
 * Renders the 5 V3 Reference Showcase Videos (`v3_sample_01..05.mp4`) combining
 * Option 1 (Dark Pro Glass + Soft Spotlight), Option 2 (Scene-by-Scene 7-in-1 Mix),
 * and Option 3 (Clean V1 Studio + Subtle Soft Aura & Frosted Glass) on the exact
 * same 5 topics!
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { renderCinematicScore } from "../src/lib/media/cinematic-score";
import { MOODS } from "../src/lib/media/moods";
import { toWav } from "../src/lib/media/music-synth";
import { loadProjectSfxLibrary } from "../src/lib/media/sfx-library";
import { renderProject, writeProject } from "../src/lib/video/render";
import {
  buildKinetic100Composition,
  renderKinetic100SfxBuffer,
  type KineticPaletteId,
} from "../src/lib/video/kinetic-100-engine";
import type { ContentPackage } from "../src/lib/content/schema";
import type { TimedWord } from "../src/lib/media/word-timing";

const SAMPLES: ReadonlyArray<{
  slug: string;
  episodeId: string;
  palette: KineticPaletteId;
  mood: "spotlight" | "blueprint" | "editorial" | "vista" | "terminal";
}> = [
  {
    slug: "v3_sample_01_mental_math_dark_pro_glass",
    episodeId: "cmww1lp0o00xwn6lg0f1pzr53",
    palette: "dark-pro-glass", // Option 1
    mood: "spotlight",
  },
  {
    slug: "v3_sample_02_inner_voice_scene_mix",
    episodeId: "cmww1lp5m00xyn6lgqtzr7rhc",
    palette: "scene-mix-master", // Option 2
    mood: "blueprint",
  },
  {
    slug: "v3_sample_03_bright_colors_clean_studio",
    episodeId: "cmww1lr4l00yon6lgczsyxzjd",
    palette: "clean-v1-studio", // Option 3
    mood: "editorial",
  },
  {
    slug: "v3_sample_04_multitasking_emerald_amber_glass",
    episodeId: "cmww1lqtp00ykn6lg3x9bupd7",
    palette: "emerald-amber-pro", // Option 1 + Option 2
    mood: "vista",
  },
  {
    slug: "v3_sample_05_brain_glitch_editorial_studio_mix",
    episodeId: "cmww1lr9b00yqn6lgk3h22h7f",
    palette: "editorial-studio-mix", // Option 3 + Option 2 + Option 1
    mood: "terminal",
  },
];

async function main() {
  const sfxLib = await loadProjectSfxLibrary();
  const globalUsedFrames = new Set<number>();
  const artifactDir = process.env.ARTIFACT_DIR ?? null;
  const outRenderDir = path.join(process.cwd(), ".bookreel", "renders", "kinetic-100-samples");
  await fs.mkdir(outRenderDir, { recursive: true });

  for (let i = 0; i < SAMPLES.length; i++) {
    const spec = SAMPLES[i];
    const ep = await prisma.episode.findUniqueOrThrow({
      where: { id: spec.episodeId },
      include: { book: true },
    });

    const parsedScript = JSON.parse(ep.script!);
    const pkg: ContentPackage = Array.isArray(parsedScript)
      ? {
          ideaKey: ep.ideaKey ?? "idea",
          title: ep.title ?? "BookReel",
          hook: ep.hook ?? "",
          cta: ep.cta ?? "Follow BookReel for the next sharp idea.",
          description: ep.description ?? "",
          hashtags: [],
          takeaway: [],
          beats: parsedScript,
        }
      : parsedScript;
    const rawWt = JSON.parse(ep.wordTimings!);
    const rawList: Array<Record<string, unknown>> = Array.isArray(rawWt) ? rawWt : rawWt.words ?? [];
    const words: TimedWord[] = rawList
      .map((x) => ({
        word: String(x.word ?? x.w ?? ""),
        start: Number(x.start ?? x.s ?? 0),
        end: Number(x.end ?? x.e ?? 0),
        beatIndex: Number(x.beatIndex ?? x.b ?? 0),
        index: Number(x.index ?? x.i ?? 0),
        source: (x.source ?? x.src ?? "audio") as TimedWord["source"],
      }))
      .filter((w) => w.word.length > 0);
    const totalDuration = ep.durationSec!;
    const audioOffsetSec = 0.45;

    const comp = buildKinetic100Composition({
      paletteId: spec.palette,
      pkg,
      words,
      totalDuration,
      audioOffsetSec,
      outroTailSec: 1.8,
      bookTitle: ep.book.title,
      author: ep.book.authorVerified ? ep.book.author : null,
      bookLink: ep.book.bookLink,
      music: true,
      sfx: true,
      globalUsedFrames,
      episodeSeed: `${spec.slug}::${i}`,
    });

    const workDir = path.join(process.cwd(), ".bookreel", "projects", spec.slug);
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(workDir, { recursive: true });

    const musicPath = path.join(workDir, "music-src.wav");
    const musicBuf = renderCinematicScore(comp.durationSec, MOODS[spec.mood]);
    await fs.writeFile(musicPath, toWav(musicBuf));

    const sfxBuf = renderKinetic100SfxBuffer({
      durationSec: comp.durationSec,
      events: comp.sfxEvents,
      library: sfxLib,
      speechSpans: words.map((w) => ({ start: w.start, end: w.end })),
      audioOffsetSec,
    });
    const sfxPath = path.join(workDir, "sfx-src.wav");
    await fs.writeFile(sfxPath, toWav(sfxBuf));

    await writeProject({
      dir: workDir,
      indexHtml: comp.html,
      audioSource: ep.audioPath!,
      musicSource: musicPath,
      sfxSource: sfxPath,
      assets: [],
    });

    const outMp4 = path.join(outRenderDir, `${spec.slug}.mp4`);
    console.log(
      `[${i + 1}/5] Rendering ${spec.slug} (${comp.shots.length} micro-shots, frames=[${comp.usedFrameIds.join(",")}], ${comp.sfxEvents.length} SFX cues)...`,
    );
    await renderProject(workDir, outMp4, "high", "local", 8);

    if (artifactDir) {
      const artifactMp4 = path.join(artifactDir, `${spec.slug}.mp4`);
      await fs.copyFile(outMp4, artifactMp4);
      console.log(`  -> DONE: ${outMp4} (copied to ${artifactMp4})`);
    } else {
      console.log(`  -> DONE: ${outMp4}`);
    }
  }

  console.log(`\nALL 5 V3 SAMPLES RENDERED! Total unique frames used across 5 videos: ${globalUsedFrames.size}/112`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
