/**
 * SERVER-ONLY. Intelligent Hybrid Cinematic Visual System Orchestrator.
 *
 * Runs strictly AFTER script grounding (`Grounding check`) and `planScenes` so
 * speculative drafts never consume GPU time.
 *
 * Workflow:
 *  1. Run `classifyAndPlanEpisodeScenes` (`hybrid-planner.ts`) to promote grounded
 *     motion-graphics opportunities (`stat`, `comparison`, `steps`, `timeline`,
 *     `growth-curve`), classify every scene into its optimal visual treatment
 *     (`hybrid-cinematic`, `documentary`, `3d-animation`, `motion-graphics`), and
 *     produce a complete 11-field `SceneVisualPlan` per scene with unified colour
 *     grade, non-repeating camera angles/movements, and smooth transitions.
 *  2. Analyse book + spoken scene narration via existing free CLI / local director.
 *  3. Discover permitted visual references (Pinterest v5 optional -> Openverse ->
 *     Wikimedia -> Pexels -> local director) for plate-bearing scenes, extracting
 *     clean-room `VisualStyleBrief` colour/lighting/contrast profiles.
 *  4. Inspect/auto-start local ComfyUI (`E:\ComfyUI` @ `127.0.0.1:8188`), verify
 *     checkpoints, video capability, and free GPU VRAM.
 *  5. Generate original 1080×1920 vertical scene plates + smooth 3D depth maps
 *     for `hybrid-cinematic` and `documentary` scenes (resuming from SHA-256 disk
 *     cache on retries), while routing `3d-animation` scenes directly to Three.js
 *     3D sculptural heroes and `motion-graphics` scenes to vector/SVG templates.
 *  6. Safely release ComfyUI GPU memory (`POST /free`) before Chrome/HyperFrames
 *     capture workers launch.
 */
import fsp from "node:fs/promises";
import { mapLimit } from "../../concurrency";
import { transformersEmbedder } from "../../analysis/embed";
import { abortOpts, wasCancelled, CancelledError } from "../../cancel";
import type { ContentPackage } from "../../content/schema";
import type { BookTheme } from "../composition/theme-contract";
import { BOOK_KINDS, PAGE_KINDS, type Scene } from "../scenes/types";
import { analyzeEpisodeVisuals } from "./analyze";
import { classifyAndPlanEpisodeScenes } from "./hybrid-planner";
import { discoverSceneStyleBrief } from "./references";
import {
  generateSceneWithComfy,
  inspectComfyCapabilities,
  releaseComfyVramSafely,
} from "./comfyui";
import { visualCacheKey } from "./paths";
import {
  DEFAULT_VISUAL_ENGINE,
  isVisualEngineMode,
  type EpisodeVisualManifest,
  type PublicSceneVisual,
  type SceneGeneratedVisual,
  type SceneVisualPlan,
  type VisualEngineMode,
  type VisualStyleBrief,
} from "./types";

export interface RunCinematicVisualEngineInput {
  episodeId: string;
  bookTitle: string;
  author?: string | null;
  archetype?: string | null;
  pkg: ContentPackage;
  scenes: Scene[];
  theme: BookTheme;
  /** Optional pageIndex -> page words map for strict book-text grounding checks. */
  pageWords?: Map<number, string[]>;
  engine?: string | null;
  /** Previous manifest on the episode row, enabling instant resume of finished scenes on retry. */
  previousManifestJson?: string | null;
  /** Optional offline override for deterministic tests. */
  offlineReferences?: boolean;
  /** Optional local-only analysis override for deterministic tests. */
  localAnalysisOnly?: boolean;
  /** Optional progress callback (`Generating cinematic visuals · Scene 2 of 6`). */
  onProgress?: (progress: { label: string; done: number; total: number }) => Promise<void> | void;
  /** Optional incremental manifest callback so live UI polls can display each scene preview as soon as it finishes. */
  onPartialManifest?: (manifest: EpisodeVisualManifest) => Promise<void> | void;
}

export interface RunCinematicVisualEngineOutput {
  engine: VisualEngineMode;
  scenes: Scene[];
  /** Extra files for `writeProject` to copy into `projects/<episodeId>/assets/`. */
  projectAssets: Array<{ from: string; to: string }>;
  manifest: EpisodeVisualManifest;
  notes: string[];
}

export function parseVisualManifest(raw: string | null | undefined): EpisodeVisualManifest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EpisodeVisualManifest;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.scenes)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function publicSceneVisuals(manifest: EpisodeVisualManifest | null): PublicSceneVisual[] {
  if (!manifest) return [];
  const planByIndex = new Map<number, SceneVisualPlan>(
    (manifest.scenePlans ?? []).map((p) => [p.sceneIndex, p]),
  );
  return manifest.scenes.map((s) => {
    const plan = planByIndex.get(s.sceneIndex);
    const fallbackTreatment =
      s.mode === "threejs-3d"
        ? "3d-animation"
        : s.mode === "motion-graphics"
          ? "motion-graphics"
          : "hybrid-cinematic";
    return {
      sceneIndex: s.sceneIndex,
      key: s.key,
      mode: s.mode,
      visualTreatment: s.visualTreatment ?? plan?.visualTreatment ?? s.intent.visualTreatment ?? fallbackTreatment,
      scenePurpose: s.scenePurpose ?? plan?.scenePurpose ?? "dramatic-story-beat",
      sceneKind: s.sceneKind ?? plan?.sceneKind ?? "cinematic",
      shotAngle: s.shotAngle ?? plan?.compositionAndAngle.shotAngle ?? s.intent.shotAngle ?? "eye-level",
      transitionToNext: s.transitionToNext ?? plan?.transitionToNext ?? "dissolve",
      cacheHit: s.cacheHit,
      hasImage: Boolean(s.imagePath),
      hasVideo: Boolean(s.videoPath),
      checkpoint: s.checkpoint ?? null,
      videoModel: s.videoModel ?? null,
      summary: s.intent.summary,
      environment: s.intent.environment,
      emotion: s.intent.emotion,
      cameraMove: s.intent.cameraMove,
      referenceSource: s.styleBrief.referenceSource,
      dominantHex: s.styleBrief.dominantHex,
      accentHex: s.styleBrief.accentHex,
      fallbackReason: s.fallbackReason ?? null,
    };
  });
}

async function filesExist(paths: Array<string | null | undefined>): Promise<boolean> {
  for (const p of paths) {
    if (!p) return false;
    const ok = await fsp.stat(p).then((s) => s.size > 512, () => false);
    if (!ok) return false;
  }
  return true;
}

function localThemeStyleBrief(theme: BookTheme, plan: SceneVisualPlan): VisualStyleBrief {
  return {
    dominantHex: theme.palette.backdropBase,
    accentHex: theme.palette.accent,
    shadowHex: theme.palette.backdropDeep,
    warmth: plan.lightingAndAtmosphere.colorGrade === "cool-noir" ? "cool" : "warm",
    contrast: "high",
    lightingNote: plan.lightingAndAtmosphere.lighting,
    compositionNote: `${plan.compositionAndAngle.shotAngle} framing`,
    atmosphere: plan.lightingAndAtmosphere.atmosphere,
    referenceSource: "local-director",
  };
}

export async function generateEpisodeVisuals(
  input: RunCinematicVisualEngineInput,
): Promise<RunCinematicVisualEngineOutput> {
  if (wasCancelled() || abortOpts().signal?.aborted) throw new CancelledError();

  // Hybrid Cinematic is the automatic default; legacy `cinematic-auto` upgrades transparently to `hybrid-cinematic`.
  const rawEngine = isVisualEngineMode(input.engine) ? input.engine : DEFAULT_VISUAL_ENGINE;
  const engine: VisualEngineMode = rawEngine === "procedural" ? "procedural" : "hybrid-cinematic";
  const notes: string[] = [];

  // Explicit operator opt-out to pure procedural mode, or empty scene list.
  if (engine === "procedural" || input.scenes.length === 0) {
    const emptyManifest: EpisodeVisualManifest = {
      version: 1,
      engine,
      generatedAt: new Date().toISOString(),
      analysisSource: "local-heuristic",
      comfy: {
        reachable: false,
        autoStarted: false,
        reusedExisting: false,
        busyWithExternalWork: false,
        checkpoint: null,
        availableCheckpoints: [],
        videoModel: null,
        videoCapable: false,
        vramTotalMb: null,
        vramFreeMb: null,
        vramReleasedAfterRun: false,
        fallbackReason: engine === "procedural" ? "Procedural engine selected." : "No scenes in plan.",
      },
      bible: {
        visualStyle: "procedural 3D",
        eraAndSetting: "",
        lightingLanguage: "",
        colorPalette: [input.theme.palette.backdropDeep, input.theme.palette.accent],
        recurringCharacters: [],
        moodKeywords: [],
        negativePrompt: "",
      },
      scenePlans: [],
      scenes: [],
    };
    return { engine, scenes: input.scenes, projectAssets: [], manifest: emptyManifest, notes };
  }

  // 1. Intelligent Hybrid Scene Classification & Pre-Generation Visual Planning.
  const hybridPlan = await classifyAndPlanEpisodeScenes({
    bookTitle: input.bookTitle,
    author: input.author,
    archetype: input.archetype,
    pkg: input.pkg,
    scenes: input.scenes,
    theme: input.theme,
    pageWords: input.pageWords,
    embedder: transformersEmbedder,
  });
  notes.push(...hybridPlan.notes);

  const plannedScenes = hybridPlan.scenes;
  const planByIndex = new Map<number, SceneVisualPlan>(
    hybridPlan.plans.map((p) => [p.sceneIndex, p]),
  );

  // Scenes eligible for ComfyUI 9:16 plate + 2.5D depth synthesis (`hybrid-cinematic`, `documentary`,
  // and `3d-animation` whenever local ComfyUI is reachable so no scene drops to bare cartoon shapes mid-video).
  const plateScenes = plannedScenes.filter((s) => s.kind === "cinematic" && Boolean(s.cine));

  // Non-page visual scenes reported in `manifest.scenes` (`plateScenes` + `motion-graphics` + `quote`).
  const visualScenes = plannedScenes.filter((s) => !BOOK_KINDS.includes(s.kind));

  await input.onProgress?.({
    label: "Planning hybrid cinematic visuals",
    done: 0,
    total: Math.max(1, plateScenes.length),
  });

  // 2. Scene visual storytelling analysis (CLI or local heuristic, $0).
  const analysis = await analyzeEpisodeVisuals({
    bookTitle: input.bookTitle,
    author: input.author,
    archetype: input.archetype,
    pkg: input.pkg,
    scenes: plannedScenes,
    scenePlans: planByIndex,
    theme: input.theme,
    localOnly: input.localAnalysisOnly,
  });
  notes.push(...analysis.notes);

  // 3. Permitted visual reference discovery for plate-bearing scenes (bounded concurrency = 3).
  const styleBriefsByScene = new Map<number, VisualStyleBrief>();

  await mapLimit(plateScenes, 3, async (scene) => {
    const intent = analysis.intents.get(scene.index)!;
    const { brief } = await discoverSceneStyleBrief(intent, analysis.bible, input.theme, {
      embedder: transformersEmbedder,
      offlineOnly: input.offlineReferences,
    });
    styleBriefsByScene.set(scene.index, brief);
  });

  for (const scene of visualScenes) {
    if (!styleBriefsByScene.has(scene.index)) {
      const plan = planByIndex.get(scene.index)!;
      styleBriefsByScene.set(scene.index, localThemeStyleBrief(input.theme, plan));
    }
  }

  // 4. Inspect / auto-start local ComfyUI & verify VRAM + checkpoints when at least one plate scene exists.
  const comfyDiag =
    plateScenes.length > 0
      ? await inspectComfyCapabilities()
      : {
          reachable: false,
          autoStarted: false,
          reusedExisting: false,
          busyWithExternalWork: false,
          checkpoint: null,
          availableCheckpoints: [],
          videoModel: null,
          videoCapable: false,
          vramTotalMb: null,
          vramFreeMb: null,
          vramReleasedAfterRun: false,
          fallbackReason: "No ComfyUI plate scenes required in this plan.",
        };

  if (comfyDiag.autoStarted) {
    notes.push(`Started local ComfyUI server automatically (${comfyDiag.checkpoint ?? "low-VRAM mode"}).`);
  } else if (comfyDiag.reusedExisting && comfyDiag.checkpoint) {
    notes.push(`Connected to running local ComfyUI (${comfyDiag.checkpoint}).`);
  }
  if (plateScenes.length > 0 && !comfyDiag.checkpoint && comfyDiag.fallbackReason) {
    notes.push(`Local AI visual generation unavailable (${comfyDiag.fallbackReason}) — using procedural 3D & 2.5D fallback.`);
  }

  const prevManifest = parseVisualManifest(input.previousManifestJson);
  const prevBySceneIndex = new Map<number, SceneGeneratedVisual>(
    (prevManifest?.scenes ?? []).map((s) => [s.sceneIndex, s]),
  );

  // 5. Generate plate assets with GPU-safe bounded concurrency = 1 on 6GB VRAM,
  //    and record dedicated `threejs-3d` and `motion-graphics` visual scenes alongside them.
  let completedPlates = 0;
  const settledSoFar: SceneGeneratedVisual[] = [];

  const generatedRecords = await mapLimit(visualScenes, 1, async (scene) => {
    if (wasCancelled() || abortOpts().signal?.aborted) throw new CancelledError();

    const t0 = Date.now();
    const plan = planByIndex.get(scene.index)!;
    const intent = analysis.intents.get(scene.index)!;
    const styleBrief = styleBriefsByScene.get(scene.index)!;
    const key = `scene-${scene.index}`;
    const isPlateScene =
      scene.kind === "cinematic" &&
      Boolean(scene.cine) &&
      (plan.visualTreatment === "hybrid-cinematic" ||
        plan.visualTreatment === "documentary" ||
        (plan.visualTreatment === "3d-animation" && comfyDiag.reachable && Boolean(comfyDiag.checkpoint)));

    // Dedicated Three.js 3D Animation or Motion Graphics scenes do not waste ComfyUI VRAM:
    if (!isPlateScene) {
      const mode = plan.visualTreatment === "3d-animation" ? ("threejs-3d" as const) : ("motion-graphics" as const);
      const nonPlateCacheKey = visualCacheKey({
        v: 2,
        mode,
        kind: scene.kind,
        subject: plan.mainSubject,
      });
      const rec: SceneGeneratedVisual = {
        sceneIndex: scene.index,
        key,
        mode,
        visualTreatment: plan.visualTreatment,
        scenePurpose: plan.scenePurpose,
        sceneKind: scene.kind,
        shotAngle: plan.compositionAndAngle.shotAngle,
        transitionToNext: plan.transitionToNext,
        cacheHit: false,
        cacheKey: nonPlateCacheKey,
        checkpoint: null,
        videoModel: null,
        imagePath: null,
        depthPath: null,
        videoPath: null,
        width: 1080,
        height: 1920,
        intent,
        styleBrief,
        fallbackReason: null,
        durationMs: Date.now() - t0,
      };
      settledSoFar.push(rec);
      return rec;
    }

    const positivePrompt = [
      "low-key dark chiaroscuro cinema macro photography, deep moody dark background, warm tungsten key light on subject in lower center, no people, 50mm f/1.8",
      intent.promptCore,
      styleBrief.lightingNote,
      `color palette inspired by ${styleBrief.dominantHex} and ${styleBrief.accentHex}`,
    ]
      .filter(Boolean)
      .join(", ");

    const effectiveNegativePrompt = [
      analysis.bible.negativePrompt,
      "person, people, human, man, woman, face, portrait, body, silhouette, hands, white wall, bright window, overexposed, white background, sparks, particles, rain",
    ]
      .filter(Boolean)
      .join(", ");

    const cacheKey = visualCacheKey({
      v: 4,
      treatment: plan.visualTreatment,
      ckpt: comfyDiag.checkpoint ?? "procedural",
      videoModel: comfyDiag.videoModel ?? null,
      positivePrompt,
      negativePrompt: effectiveNegativePrompt,
    });

    // Resume from previous manifest on retry if files are already intact on disk.
    const prior = prevBySceneIndex.get(scene.index);
    if (
      prior &&
      prior.cacheKey === cacheKey &&
      (prior.mode === "comfyui-image-25d" || prior.mode === "comfyui-video") &&
      (await filesExist([prior.imagePath, prior.depthPath]))
    ) {
      completedPlates += 1;
      await input.onProgress?.({
        label: `Resumed cached ${plan.visualTreatment} visual ${completedPlates} of ${plateScenes.length}`,
        done: completedPlates,
        total: plateScenes.length,
      });
      const resumed: SceneGeneratedVisual = {
        ...prior,
        visualTreatment: plan.visualTreatment,
        scenePurpose: plan.scenePurpose,
        sceneKind: scene.kind,
        shotAngle: plan.compositionAndAngle.shotAngle,
        transitionToNext: plan.transitionToNext,
        cacheHit: true,
        durationMs: Date.now() - t0,
      };
      settledSoFar.push(resumed);
      return resumed;
    }

    if (!comfyDiag.reachable || !comfyDiag.checkpoint) {
      completedPlates += 1;
      await input.onProgress?.({
        label: `Prepared procedural 3D fallback ${completedPlates} of ${plateScenes.length}`,
        done: completedPlates,
        total: plateScenes.length,
      });
      const fallbackRec: SceneGeneratedVisual = {
        sceneIndex: scene.index,
        key,
        mode: "procedural-fallback",
        visualTreatment: plan.visualTreatment,
        scenePurpose: plan.scenePurpose,
        sceneKind: scene.kind,
        shotAngle: plan.compositionAndAngle.shotAngle,
        transitionToNext: plan.transitionToNext,
        cacheHit: false,
        cacheKey,
        checkpoint: null,
        videoModel: null,
        imagePath: null,
        depthPath: null,
        videoPath: null,
        width: 1080,
        height: 1920,
        intent,
        styleBrief,
        fallbackReason: comfyDiag.fallbackReason ?? "ComfyUI unavailable.",
        durationMs: Date.now() - t0,
      };
      settledSoFar.push(fallbackRec);
      return fallbackRec;
    }

    try {
      await input.onProgress?.({
        label: `Generating ${plan.visualTreatment} scene ${completedPlates + 1} of ${plateScenes.length}`,
        done: completedPlates,
        total: plateScenes.length,
      });

      const out = await generateSceneWithComfy({
        episodeId: input.episodeId,
        cacheKey,
        checkpoint: comfyDiag.checkpoint,
        videoModel: comfyDiag.videoCapable ? comfyDiag.videoModel : null,
        positivePrompt,
        negativePrompt: effectiveNegativePrompt,
        sceneDurationSec: Math.max(2.5, scene.end - scene.start),
        dominantHex: styleBrief.dominantHex,
        accentHex: styleBrief.accentHex,
      });

      completedPlates += 1;
      await input.onProgress?.({
        label: `Generated ${plan.visualTreatment} scene ${completedPlates} of ${plateScenes.length}`,
        done: completedPlates,
        total: plateScenes.length,
      });

      const rec: SceneGeneratedVisual = {
        sceneIndex: scene.index,
        key,
        mode: out.videoPath ? "comfyui-video" : "comfyui-image-25d",
        visualTreatment: plan.visualTreatment,
        scenePurpose: plan.scenePurpose,
        sceneKind: scene.kind,
        shotAngle: plan.compositionAndAngle.shotAngle,
        transitionToNext: plan.transitionToNext,
        cacheHit: out.cacheHit,
        cacheKey,
        checkpoint: comfyDiag.checkpoint,
        videoModel: out.videoPath ? comfyDiag.videoModel : null,
        imagePath: out.imagePath,
        depthPath: out.depthPath,
        videoPath: out.videoPath,
        width: 1080,
        height: 1920,
        intent,
        styleBrief,
        fallbackReason: null,
        durationMs: Date.now() - t0,
      };
      settledSoFar.push(rec);
      await input.onPartialManifest?.({
        version: 1,
        engine,
        generatedAt: new Date().toISOString(),
        analysisSource: analysis.source,
        colorGrade: hybridPlan.colorGrade,
        comfy: comfyDiag,
        bible: analysis.bible,
        scenePlans: hybridPlan.plans,
        scenes: [...settledSoFar].sort((a, b) => a.sceneIndex - b.sceneIndex),
      });
      return rec;
    } catch (err) {
      if (err instanceof CancelledError || wasCancelled()) throw new CancelledError();
      const reason = err instanceof Error ? err.message.slice(0, 180) : "ComfyUI generation error";
      notes.push(`Scene ${scene.index + 1}: ComfyUI failed (${reason}) — fell back to procedural 3D hero.`);
      completedPlates += 1;
      const errRec: SceneGeneratedVisual = {
        sceneIndex: scene.index,
        key,
        mode: "procedural-fallback",
        visualTreatment: plan.visualTreatment,
        scenePurpose: plan.scenePurpose,
        sceneKind: scene.kind,
        shotAngle: plan.compositionAndAngle.shotAngle,
        transitionToNext: plan.transitionToNext,
        cacheHit: false,
        cacheKey,
        checkpoint: comfyDiag.checkpoint,
        videoModel: null,
        imagePath: null,
        depthPath: null,
        videoPath: null,
        width: 1080,
        height: 1920,
        intent,
        styleBrief,
        fallbackReason: reason,
        durationMs: Date.now() - t0,
      };
      settledSoFar.push(errRec);
      return errRec;
    }
  });

  // 6. Release ComfyUI GPU memory before headless Chrome / HyperFrames launches.
  if (
    comfyDiag.reachable &&
    generatedRecords.some((r) => !r.cacheHit && (r.mode === "comfyui-image-25d" || r.mode === "comfyui-video"))
  ) {
    comfyDiag.vramReleasedAfterRun = await releaseComfyVramSafely();
  }

  // 7. Wire generated plates + hybrid parameters onto scenes & collect composition assets.
  const bySceneIndex = new Map(generatedRecords.map((r) => [r.sceneIndex, r]));
  const projectAssets: Array<{ from: string; to: string }> = [];

  const updatedScenes: Scene[] = plannedScenes.map((scene) => {
    const rec = bySceneIndex.get(scene.index);
    const plan = planByIndex.get(scene.index);
    if (
      !rec ||
      !scene.cine ||
      (rec.mode !== "comfyui-image-25d" && rec.mode !== "comfyui-video") ||
      !rec.imagePath ||
      !rec.depthPath
    ) {
      return scene;
    }
    const imgName = `cine-plate-${scene.index}.jpg`;
    const depthName = `cine-depth-${scene.index}.png`;
    projectAssets.push({ from: rec.imagePath, to: imgName });
    projectAssets.push({ from: rec.depthPath, to: depthName });

    let videoSrc: string | undefined;
    if (rec.videoPath) {
      const vidName = `cine-video-${scene.index}.mp4`;
      projectAssets.push({ from: rec.videoPath, to: vidName });
      videoSrc = `assets/${vidName}`;
    }

    const plateTreatment = plan?.visualTreatment === "documentary" ? "documentary" : "hybrid-cinematic";

    return {
      ...scene,
      cine: {
        ...scene.cine,
        plate: {
          imageSrc: `assets/${imgName}`,
          depthSrc: `assets/${depthName}`,
          ...(videoSrc ? { videoSrc } : {}),
          cameraMove: rec.intent.cameraMove,
          shotAngle: plan?.compositionAndAngle.shotAngle ?? rec.intent.shotAngle,
          treatment: plateTreatment,
          parallaxIntensity: plan?.depthAndParallax.intensity ?? (plateTreatment === "documentary" ? 0.55 : 0.92),
          colorGrade: hybridPlan.colorGrade,
          accent3d: plan?.depthAndParallax.accent3d ?? false,
          ...(plan?.motionGraphics.calloutText ? { callout: plan.motionGraphics.calloutText } : {}),
          atmosphere: rec.styleBrief.atmosphere,
          dominantHex: rec.styleBrief.dominantHex,
          accentHex: rec.styleBrief.accentHex,
          shadowHex: rec.styleBrief.shadowHex,
        },
      },
    };
  });

  const availablePlateSrcs = updatedScenes
    .map((s) => s.cine?.plate?.imageSrc)
    .filter((src): src is string => Boolean(src));
  const enrichedScenes: Scene[] =
    availablePlateSrcs.length > 0
      ? updatedScenes.map((s, idx) => {
          if (s.kind === "cinematic" || PAGE_KINDS.includes(s.kind)) return s;
          return { ...s, bgImageSrc: availablePlateSrcs[idx % availablePlateSrcs.length] };
        })
      : updatedScenes;

  const aiCount = generatedRecords.filter((r) => r.mode === "comfyui-image-25d" || r.mode === "comfyui-video").length;
  const cachedCount = generatedRecords.filter((r) => r.cacheHit).length;
  const threeDCount = generatedRecords.filter((r) => r.mode === "threejs-3d").length;
  const motionCount = generatedRecords.filter((r) => r.mode === "motion-graphics").length;

  if (aiCount > 0 || threeDCount > 0 || motionCount > 0) {
    notes.push(
      `Hybrid cinematic engine prepared ${aiCount} ComfyUI 2.5D plate(s) (${cachedCount} cached${comfyDiag.checkpoint ? `, ${comfyDiag.checkpoint}` : ""}), ${threeDCount} Three.js 3D scene(s), and ${motionCount} motion-graphics scene(s).`,
    );
  }

  const manifest: EpisodeVisualManifest = {
    version: 1,
    engine,
    generatedAt: new Date().toISOString(),
    analysisSource: analysis.source,
    colorGrade: hybridPlan.colorGrade,
    comfy: comfyDiag,
    bible: analysis.bible,
    scenePlans: hybridPlan.plans,
    scenes: generatedRecords,
  };

  return {
    engine,
    scenes: enrichedScenes,
    projectAssets,
    manifest,
    notes,
  };
}
