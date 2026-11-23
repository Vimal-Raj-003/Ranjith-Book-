/**
 * Types for BookReel's 100% Free Intelligent Hybrid Cinematic Visual System.
 * Kept free of Node-only imports so UI and API view layers can share types safely.
 */

export const VISUAL_ENGINES = ["hybrid-cinematic", "cinematic-auto", "procedural"] as const;
export type VisualEngineMode = (typeof VISUAL_ENGINES)[number];

/** Default engine for all newly generated videos — no manual selection required. */
export const DEFAULT_VISUAL_ENGINE: VisualEngineMode = "hybrid-cinematic";

export function isVisualEngineMode(v: unknown): v is VisualEngineMode {
  return typeof v === "string" && (VISUAL_ENGINES as readonly string[]).includes(v);
}

/** True when the episode uses the automatic Hybrid Cinematic engine (including legacy `cinematic-auto` alias). */
export function isHybridVisualEngine(v: unknown): boolean {
  return v === "hybrid-cinematic" || v === "cinematic-auto";
}

/**
 * Scene-level visual treatments selected automatically per scene based on narration,
 * story context, subject matter, emotional tone, and explanatory purpose.
 */
export const VISUAL_TREATMENTS = [
  "hybrid-cinematic",
  "documentary",
  "3d-animation",
  "motion-graphics",
] as const;

export type VisualTreatment = (typeof VISUAL_TREATMENTS)[number];

export type ShotAngleKind =
  | "eye-level"
  | "low-angle-heroic"
  | "high-angle-overview"
  | "close-intimate"
  | "wide-establishing";

export type CameraMoveKind =
  | "push-in"
  | "pull-back"
  | "pan-right"
  | "pan-left"
  | "rise-reveal"
  | "orbit-drift";

export type AtmosphereKind = "dust" | "mist" | "embers" | "rain" | "rays" | "still";

export type SceneTransitionKind =
  | "dissolve"
  | "depth-push"
  | "pan-slide"
  | "rise-wipe"
  | "whip-pan"
  | "spring-pop";

export type ColorGradePreset =
  | "warm-cinema"
  | "archival-sepia"
  | "cool-noir"
  | "crisp-editorial"
  | "golden-amber";

export interface RecurringCharacterSpec {
  name: string;
  /** Concise visual description kept identical across scenes for visual continuity. */
  appearance: string;
}

/** Episode-wide visual continuity bible derived from the book and full narration. */
export interface BookVisualBible {
  visualStyle: string;
  eraAndSetting: string;
  lightingLanguage: string;
  colorPalette: string[];
  recurringCharacters: RecurringCharacterSpec[];
  moodKeywords: string[];
  negativePrompt: string;
}

/**
 * Structured pre-generation visual plan for a single scene (Section 4).
 * Grounded in actual spoken narration and book context before any asset is generated.
 */
export interface SceneVisualPlan {
  sceneIndex: number;
  /** Narrative role in the episode arc (e.g. `opening-hook`, `real-world-story`, `data-proof`, `conceptual-metaphor`, `book-evidence`, `closing-takeaway`). */
  scenePurpose: string;
  narration: string;
  mainSubject: string;
  environmentAndBackground: string;
  visualTreatment: VisualTreatment;
  /** Why this treatment was chosen for this specific narration. */
  treatmentReason: string;
  /** Underlying BookReel template (`cinematic`, `stat`, `comparison`, `steps`, `timeline`, `growth-curve`, `icon-concept`, `book-page`, etc.). */
  sceneKind: string;
  /** Concrete assets required (`comfyui-plate`, `depth-map`, `threejs-hero:mind`, `svg-growth-curve`, `book-page-scan`, etc.). */
  requiredAssets: string[];
  compositionAndAngle: {
    shotAngle: ShotAngleKind;
    foreground: string;
    midground: string;
    background: string;
  };
  cameraMovement: CameraMoveKind;
  depthAndParallax: {
    enabled: boolean;
    /** 0..1 displacement and foreground/background parallax strength. */
    intensity: number;
    foregroundSeparation: boolean;
    accent3d: boolean;
  };
  motionGraphics: {
    active: boolean;
    template: string | null;
    calloutText: string | null;
  };
  lightingAndAtmosphere: {
    lighting: string;
    atmosphere: AtmosphereKind;
    colorGrade: ColorGradePreset;
  };
  transitionToNext: SceneTransitionKind;
}

/** Per-scene visual storytelling intent derived from the scene's spoken words. */
export interface SceneVisualIntent {
  sceneIndex: number;
  narration: string;
  summary: string;
  subject: string;
  characters: string[];
  environment: string;
  emotion: string;
  action: string;
  lighting: string;
  cameraMove: CameraMoveKind;
  shotAngle?: ShotAngleKind;
  visualTreatment?: VisualTreatment;
  calloutText?: string | null;
  atmosphere: AtmosphereKind;
  /** Ranked queries for permitted visual reference discovery. */
  searchQueries: string[];
  /** Concrete visual prompt core for local ComfyUI image/video synthesis. */
  promptCore: string;
}

export type ReferenceSourceKind =
  | "pinterest"
  | "openverse"
  | "wikimedia"
  | "pexels"
  | "local-director";

/** Metadata of a permitted visual reference (never directly published). */
export interface VisualReference {
  source: ReferenceSourceKind;
  id: string;
  title: string;
  license: string;
  creator?: string;
  thumbnailUrl?: string;
  similarityScore: number;
}

/**
 * Clean-room cinematographic style brief extracted from visual references or
 * synthesized locally. Only non-copyrightable lighting/palette/mood properties
 * cross this boundary into local generation and Three.js shading.
 */
export interface VisualStyleBrief {
  dominantHex: string;
  accentHex: string;
  shadowHex: string;
  warmth: "warm" | "cool" | "neutral";
  contrast: "high" | "medium" | "low";
  lightingNote: string;
  compositionNote: string;
  atmosphere: AtmosphereKind;
  referenceSource: ReferenceSourceKind;
  referenceTitle?: string;
  referenceLicense?: string;
}

export type SceneGenerationMode =
  | "comfyui-video"
  | "comfyui-image-25d"
  | "threejs-3d"
  | "motion-graphics"
  | "procedural-fallback";

/** Record of what was planned and generated for one visual scene. */
export interface SceneGeneratedVisual {
  sceneIndex: number;
  /** URL-safe key for preview delivery (`scene-0`, `scene-3`, ...). */
  key: string;
  mode: SceneGenerationMode;
  visualTreatment?: VisualTreatment;
  scenePurpose?: string;
  sceneKind?: string;
  shotAngle?: ShotAngleKind;
  transitionToNext?: SceneTransitionKind;
  cacheHit: boolean;
  cacheKey: string;
  checkpoint?: string | null;
  videoModel?: string | null;
  /** Server-side absolute path to generated 1080x1920 JPEG/PNG (stripped before public API responses). */
  imagePath?: string | null;
  /** Server-side absolute path to 3D depth map PNG (stripped before public API responses). */
  depthPath?: string | null;
  /** Server-side absolute path to normalized 1080x1920@30fps MP4 clip when video generation ran. */
  videoPath?: string | null;
  width: number;
  height: number;
  intent: SceneVisualIntent;
  styleBrief: VisualStyleBrief;
  fallbackReason?: string | null;
  durationMs: number;
}

export interface ComfyRuntimeDiagnostic {
  reachable: boolean;
  autoStarted: boolean;
  reusedExisting: boolean;
  busyWithExternalWork: boolean;
  checkpoint: string | null;
  availableCheckpoints: string[];
  videoModel: string | null;
  videoCapable: boolean;
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  vramReleasedAfterRun: boolean;
  fallbackReason?: string | null;
}

/** Stored on `Episode.visualManifest` (JSON) for resumption, previews, and diagnostics. */
export interface EpisodeVisualManifest {
  version: 1;
  engine: VisualEngineMode;
  generatedAt: string;
  analysisSource: "cli" | "local-heuristic";
  colorGrade?: ColorGradePreset;
  comfy: ComfyRuntimeDiagnostic;
  bible: BookVisualBible;
  /** Full structured pre-generation visual plan across every scene in the episode. */
  scenePlans?: SceneVisualPlan[];
  scenes: SceneGeneratedVisual[];
}

/** Client-safe view of a generated/planned scene visual (no filesystem paths exposed). */
export interface PublicSceneVisual {
  sceneIndex: number;
  key: string;
  mode: SceneGenerationMode;
  visualTreatment: VisualTreatment;
  scenePurpose: string;
  sceneKind: string;
  shotAngle: ShotAngleKind;
  transitionToNext: SceneTransitionKind;
  cacheHit: boolean;
  hasImage: boolean;
  hasVideo: boolean;
  checkpoint: string | null;
  videoModel: string | null;
  summary: string;
  environment: string;
  emotion: string;
  cameraMove: CameraMoveKind;
  referenceSource: ReferenceSourceKind;
  dominantHex: string;
  accentHex: string;
  fallbackReason: string | null;
}
