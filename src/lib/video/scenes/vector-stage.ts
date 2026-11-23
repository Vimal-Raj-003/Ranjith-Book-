/**
 * Seek-Safe HyperFrames Geometric Vector Stage (`Dan Koe` / `Minimalist Mindset` style).
 *
 * Renders razor-sharp 1080×1920 inline SVG geometric motion diagrams driven
 * exclusively by BookReel's deterministic GSAP `draw` (`strokeDashoffset`) and
 * `pop` primitives — zero CSS `@keyframes`, zero raster blur, zero hardcoded
 * colour literals (uses `currentColor` + theme palette roles only).
 */
import type { HeroId } from "./heroes";

export type VectorDiagramKind =
  | "split-forces"
  | "focus-reticle"
  | "balance-deadlock"
  | "habit-loop"
  | "trajectory-grid";

export interface VectorDiagramOutput {
  markup: string;
  /** Element indices and dash lengths to animate via `k: "draw"` / `k: "pop"`. */
  draws: Array<{ el: number; dash: number; delaySec: number; durSec: number }>;
  pops: Array<{ el: number; delaySec: number; scaleFrom: number }>;
}

export function vectorKindForHero(hero: HeroId | undefined, narration = ""): VectorDiagramKind {
  const lower = narration.toLowerCase();
  if (/different|two|versus|between|class|compare|both/.test(lower) || hero === "dialogue") {
    return "split-forces";
  }
  if (/equal|weigh|balance|swing|alternat|paralyz|hesitat/.test(lower) || hero === "scales") {
    return "balance-deadlock";
  }
  if (/loop|habit|repeat|automat|cycle|orbit/.test(lower) || hero === "loop" || hero === "orbit") {
    return "habit-loop";
  }
  if (/attention|focus|volition|mind|willpower|eye|stare/.test(lower) || hero === "focus" || hero === "mind") {
    return "focus-reticle";
  }
  return "trajectory-grid";
}

/**
 * Build a crisp geometric SVG diagram occupying the lower-center visual stage
 * (`y = 660..1360`, clear of top headlines and bottom captions).
 * `baseEl` is the starting `data-el` index so no element collides with text spans.
 */
export function buildVectorDiagram(kind: VectorDiagramKind, baseEl: number): VectorDiagramOutput {
  const draws: VectorDiagramOutput["draws"] = [];
  const pops: VectorDiagramOutput["pops"] = [];
  let nextEl = baseEl;

  const addPath = (d: string, cls: string, dash: number, delaySec: number, durSec = 0.72) => {
    const el = nextEl++;
    draws.push({ el, dash, delaySec, durSec });
    return `<path class="${cls}" data-el="${el}" d="${d}" stroke-dasharray="${dash}" stroke-dashoffset="${dash}" />`;
  };

  const addNode = (cx: number, cy: number, r: number, cls: string, delaySec: number) => {
    const el = nextEl++;
    pops.push({ el, delaySec, scaleFrom: 0.25 });
    return `<circle class="${cls}" data-el="${el}" cx="${cx}" cy="${cy}" r="${r}" />`;
  };

  let inner = "";

  if (kind === "split-forces") {
    // Two distinct geometric force rings converging into one unified core axis
    inner = [
      addPath("M 90 260 L 630 260", "vec-guide", 560, 0.04, 0.55),
      addPath("M 360 70 L 360 450", "vec-guide", 400, 0.08, 0.55),
      addPath("M 230 260 m -128 0 a 128 128 0 1 0 256 0 a 128 128 0 1 0 -256 0", "vec-stroke-dim", 820, 0.12, 0.82),
      addPath("M 490 260 m -128 0 a 128 128 0 1 0 256 0 a 128 128 0 1 0 -256 0", "vec-stroke-accent", 820, 0.24, 0.82),
      addPath("M 360 156 C 412 195, 412 325, 360 364 C 308 325, 308 195, 360 156 Z", "vec-stroke-bright", 540, 0.48, 0.75),
      addNode(230, 260, 10, "vec-node-dim", 0.36),
      addNode(490, 260, 10, "vec-node-accent", 0.46),
      addNode(360, 260, 16, "vec-node-core", 0.68),
    ].join("");
  } else if (kind === "focus-reticle") {
    // Precision concentric attention target locking onto a single volition core
    inner = [
      addPath("M 360 64 L 360 456", "vec-guide", 400, 0.04, 0.5),
      addPath("M 100 260 L 620 260", "vec-guide", 530, 0.08, 0.5),
      addPath("M 360 260 m -176 0 a 176 176 0 1 0 352 0 a 176 176 0 1 0 -352 0", "vec-stroke-dim", 1120, 0.1, 0.85),
      addPath("M 360 260 m -116 0 a 116 116 0 1 0 232 0 a 116 116 0 1 0 -232 0", "vec-stroke-accent", 740, 0.24, 0.78),
      addPath("M 206 260 Q 360 132 514 260 Q 360 388 206 260 Z", "vec-stroke-bright", 760, 0.38, 0.76),
      addNode(360, 260, 22, "vec-node-core", 0.56),
      addNode(360, 84, 7, "vec-node-accent", 0.64),
      addNode(360, 436, 7, "vec-node-accent", 0.68),
    ].join("");
  } else if (kind === "balance-deadlock") {
    // Symmetrical fulcrum & twin equal loads locking a precision beam horizontally
    inner = [
      addPath("M 120 416 L 600 416", "vec-guide", 500, 0.04, 0.5),
      addPath("M 360 416 L 318 334 L 402 334 Z", "vec-stroke-bright", 300, 0.12, 0.6),
      addPath("M 136 226 L 584 226", "vec-stroke-accent", 460, 0.24, 0.68),
      addPath("M 176 226 L 136 320 L 216 320 Z", "vec-stroke-dim", 300, 0.38, 0.62),
      addPath("M 544 226 L 504 320 L 584 320 Z", "vec-stroke-accent", 300, 0.44, 0.62),
      addNode(360, 226, 13, "vec-node-core", 0.32),
      addNode(176, 296, 18, "vec-node-dim", 0.56),
      addNode(544, 296, 18, "vec-node-core", 0.62),
    ].join("");
  } else if (kind === "habit-loop") {
    // Closed feedback loop with 3 directional lock nodes
    inner = [
      addPath("M 360 260 m -154 0 a 154 154 0 1 0 308 0 a 154 154 0 1 0 -308 0", "vec-stroke-accent", 980, 0.08, 0.88),
      addPath("M 360 260 m -92 0 a 92 92 0 1 0 184 0 a 92 92 0 1 0 -184 0", "vec-stroke-dim", 590, 0.22, 0.74),
      addPath("M 360 106 L 382 124 L 356 132", "vec-stroke-bright", 90, 0.52, 0.4),
      addPath("M 514 260 L 496 282 L 488 256", "vec-stroke-bright", 90, 0.6, 0.4),
      addNode(360, 106, 14, "vec-node-core", 0.34),
      addNode(493, 337, 14, "vec-node-accent", 0.48),
      addNode(227, 337, 14, "vec-node-dim", 0.62),
    ].join("");
  } else {
    // Architectural grid + ascending exponential clarity vector
    inner = [
      addPath("M 110 400 L 610 400", "vec-guide", 510, 0.04, 0.45),
      addPath("M 110 120 L 110 400", "vec-guide", 290, 0.08, 0.45),
      addPath("M 110 310 L 610 310", "vec-guide", 510, 0.12, 0.45),
      addPath("M 110 215 L 610 215", "vec-guide", 510, 0.16, 0.45),
      addPath("M 124 382 C 250 374, 368 320, 468 224 C 518 176, 558 144, 594 122", "vec-stroke-accent", 680, 0.22, 0.92),
      addNode(124, 382, 9, "vec-node-dim", 0.28),
      addNode(346, 316, 11, "vec-node-accent", 0.54),
      addNode(594, 122, 16, "vec-node-core", 0.84),
    ].join("");
  }

  const markup = `<div class="cine-vec-wrap"><svg class="cine-vec-svg" viewBox="0 0 720 520" width="720" height="520" fill="none" aria-hidden="true">${inner}</svg></div>`;
  return { markup, draws, pops };
}
