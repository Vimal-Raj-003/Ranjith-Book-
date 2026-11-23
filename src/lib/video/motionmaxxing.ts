/**
 * MotionMaxxing + ShotCraft Quality & Choreography Module for BookReel.
 *
 * Bridges ShotCraft's deterministic shot-recipe vocabulary with MotionMaxxing's
 * kinetic typography scaling and DOM safe-zone / seek-safety geometry verification
 * on our native HTML + GSAP + Three.js composition pipeline.
 */
import type { CaptionLine } from "../media/captions";
import { BANDS, CONTENT_WIDTH, FRAME } from "./composition/frame";
import { overlappingAnims, type SceneAnim } from "./scenes/render";
import type { Scene } from "./scenes/types";

const STAGE_CARD = { x: 60, y: 250, w: 960, h: 1120 } as const;

/** Vertical safe-zone boundaries for 9:16 Reels / Shorts (1080x1920). */
export const SAFE_ZONE = {
  left: 44,
  right: FRAME.width - 44, // 1036px
  top: 48,
  /** Instagram Reels & YouTube Shorts bottom UI chrome starts at y=1670. */
  bottom: 1670,
} as const;

export type ShotRecipeId =
  | "shotcraft-hero-hook"
  | "shotcraft-spring-bento"
  | "shotcraft-split-quote"
  | "shotcraft-whip-compare"
  | "shotcraft-step-cascade"
  | "shotcraft-trajectory-draw"
  | "shotcraft-stat-counter"
  | "shotcraft-page-dolly-left"
  | "shotcraft-page-overhead"
  | "shotcraft-page-dolly-right"
  | "shotcraft-page-push-up";

/** Deterministic ShotCraft camera recipe for the 4-way book-page camera cycle. */
export interface PageCameraRecipe {
  recipe: ShotRecipeId;
  from: { ry: number; rx: number; s: number; y: number };
  to: { ry: number; rx: number; s: number; y: number };
}

const PAGE_CAMERA_RECIPES: readonly PageCameraRecipe[] = [
  {
    recipe: "shotcraft-page-dolly-left",
    from: { ry: 9.5, rx: 4.5, s: 0.93, y: 30 },
    to: { ry: 2.2, rx: 1.1, s: 1.025, y: 0 },
  },
  {
    recipe: "shotcraft-page-overhead",
    from: { ry: -4.2, rx: 7.5, s: 0.94, y: 24 },
    to: { ry: -1.0, rx: 1.8, s: 1.02, y: -4 },
  },
  {
    recipe: "shotcraft-page-dolly-right",
    from: { ry: -9.5, rx: 4.2, s: 0.93, y: 28 },
    to: { ry: -2.2, rx: 1.1, s: 1.025, y: 0 },
  },
  {
    recipe: "shotcraft-page-push-up",
    from: { ry: 3.8, rx: -3.6, s: 0.95, y: 36 },
    to: { ry: 1.2, rx: 0.8, s: 1.03, y: -2 },
  },
];

export function pageCameraRecipeAt(pageSceneIndex: number): PageCameraRecipe {
  const idx = Math.abs(Math.floor(pageSceneIndex)) % PAGE_CAMERA_RECIPES.length;
  return PAGE_CAMERA_RECIPES[idx];
}

/** Map a scene to its ShotCraft shot-recipe card identifier. */
export function shotRecipeForScene(scene: Scene, pageSceneOrdinal = 0): ShotRecipeId {
  switch (scene.kind) {
    case "cinematic":
      return "shotcraft-hero-hook";
    case "icon-concept":
      return "shotcraft-spring-bento";
    case "quote":
      return "shotcraft-split-quote";
    case "comparison":
      return "shotcraft-whip-compare";
    case "steps":
    case "timeline":
      return "shotcraft-step-cascade";
    case "growth-curve":
      return "shotcraft-trajectory-draw";
    case "stat":
      return "shotcraft-stat-counter";
    case "book-page":
    case "book-crop":
    default:
      return pageCameraRecipeAt(pageSceneOrdinal).recipe;
  }
}

/**
 * MotionMaxxing adaptive viral caption font size:
 * - Short 1–14 char power hooks pop at 76px
 * - Standard 15–28 char 2–3 word phrases sit at 70px
 * - Longer 29+ char lines step down to 58px so they never wrap past 2 lines or cross y=1670.
 */
export function viralCaptionFontSize(text: string): number {
  const len = Array.from((text ?? "").trim()).length;
  if (len <= 14) return 76;
  if (len <= 28) return 70;
  return 58;
}

export interface MotionMaxxingAuditReport {
  ok: boolean;
  safeZonePass: boolean;
  seekSafePass: boolean;
  kineticWordsCount: number;
  shotRecipes: ShotRecipeId[];
  issues: string[];
}

/**
 * Deterministic MotionMaxxing geometry & seek-safety gate run on built scene plans
 * and caption tracks before rendering. Verifies:
 *  1. Stage card and caption baseline strictly stay inside [44..1036] x [48..1670].
 *  2. Zero overlapping GSAP tweens on any `(scene, element)` pair (`overlappingAnims`).
 *  3. Captions fit within safe vertical clearance without overflowing Instagram/Shorts UI chrome.
 */
export function auditMotionMaxxingLayout(opts: {
  scenes: Scene[];
  captions: CaptionLine[];
  anims: SceneAnim[];
  viralCaptions?: boolean;
}): MotionMaxxingAuditReport {
  const issues: string[] = [];

  // 1. Stage card & caption safe-zone geometry check
  if (STAGE_CARD.x < SAFE_ZONE.left || STAGE_CARD.x + STAGE_CARD.w > SAFE_ZONE.right) {
    issues.push(`Stage card horizontal bounds [${STAGE_CARD.x}, ${STAGE_CARD.x + STAGE_CARD.w}] exceed safe zone [${SAFE_ZONE.left}, ${SAFE_ZONE.right}]`);
  }
  if (STAGE_CARD.y < SAFE_ZONE.top || STAGE_CARD.y + STAGE_CARD.h > SAFE_ZONE.bottom) {
    issues.push(`Stage card vertical bounds [${STAGE_CARD.y}, ${STAGE_CARD.y + STAGE_CARD.h}] exceed safe zone [${SAFE_ZONE.top}, ${SAFE_ZONE.bottom}]`);
  }
  if (BANDS.caption.bottom > SAFE_ZONE.bottom) {
    issues.push(`Caption baseline ${BANDS.caption.bottom} exceeds Reels/Shorts chrome cutoff ${SAFE_ZONE.bottom}`);
  }
  if (CONTENT_WIDTH > SAFE_ZONE.right - SAFE_ZONE.left) {
    issues.push(`Caption content width ${CONTENT_WIDTH} exceeds horizontal safe zone`);
  }

  for (let i = 0; i < opts.captions.length; i++) {
    const c = opts.captions[i];
    const fontPx = opts.viralCaptions ? viralCaptionFontSize(c.text) : c.text.length > 34 ? 52 : 60;
    const approxCharsPerRow = Math.max(10, Math.floor(CONTENT_WIDTH / (fontPx * 0.58)));
    const estimatedRows = Math.ceil(Math.max(1, Array.from(c.text.trim()).length) / approxCharsPerRow);
    const estHeight = estimatedRows * Math.round(fontPx * 1.2) + 44;
    const topEdge = BANDS.caption.bottom - estHeight;
    if (topEdge < SAFE_ZONE.top) {
      issues.push(`Caption ${i} estimated top ${topEdge}px intrudes above top safe zone`);
    }
  }

  const safeZonePass = issues.length === 0;

  // 2. Seek-safety overlap audit
  const overlaps = overlappingAnims(opts.anims);
  if (overlaps.length > 0) {
    issues.push(...overlaps.map((o) => `Overlapping tween: ${o}`));
  }
  const seekSafePass = overlaps.length === 0;

  // 3. Collect ShotCraft recipes & kinetic word count
  let pageOrd = 0;
  const shotRecipes = opts.scenes.map((s) => {
    const isPage = s.kind === "book-page" || s.kind === "book-crop";
    const r = shotRecipeForScene(s, isPage ? pageOrd++ : 0);
    return r;
  });

  const kineticWordsCount =
    opts.scenes.reduce((sum, s) => sum + (s.words?.length ?? 0), 0) +
    opts.captions.reduce((sum, c) => sum + (c.words?.length ?? 0), 0);

  return {
    ok: safeZonePass && seekSafePass,
    safeZonePass,
    seekSafePass,
    kineticWordsCount,
    shotRecipes,
    issues,
  };
}
