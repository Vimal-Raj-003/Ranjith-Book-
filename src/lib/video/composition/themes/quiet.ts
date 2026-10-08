import type { ThemePalette } from "../theme-contract";
import { defineTheme } from "./compile";

/**
 * Premium Minimal — whitespace, one strong face, and almost no effects.
 *
 * The second LIGHT ground in the set after Editorial, and deliberately a cold
 * one where Editorial's is warm ecru: this is gallery wall, not press sheet.
 * The card is a hair brighter than the wall rather than a different material,
 * the shadow is the shallowest here of any theme (0.55x), and the hairline is
 * the only edge in the frame.
 *
 * Restraint is implemented, not just described. `bokeh: 0` removes the
 * drifting light entirely, `vignette: 0` removes the corner shade, the grain is
 * `none`, and the sweep is 18% wide at 8px blur — a thin specular line that
 * crosses and is gone. What is left to carry the video is the type: a tight
 * grotesque, a 94px hook at -3px tracking, and a small uppercase caption.
 *
 * Not NO effects, though, and the card says "the quietest motion here"
 * rather than "none" because three things still move: the shared
 * page-change pop and depth drift, which no theme can switch off; that thin
 * sweep; and the camera tilt on a page scene, damped rather than removed by
 * the longest perspective in the set (2800px against the skeleton's 1700px).
 * `cineVignette: 0.12` is a trace rather than zero, because a scene layer
 * with no edge at all floats off its ground.
 *
 * The accent is near-black, which is the whole point of a minimal theme: the
 * loudest colour in the frame is ink.
 *
 * Bed: `stark` — open fifths, no third, so it states no mood of its own.
 */
const p: ThemePalette = {
  paper: "#fbfbf9",
  ink: "#121212",
  marker: "#e4e5e0",
  markerEdge: "#15151a",
  captionBg: "#ffffff",
  captionInk: "#121212",
  accent: "#1d1d20",
  vignette: "rgba(120,124,120,0.16)",

  backdropDeep: "#d7d9d6",
  backdropBase: "#eceeea",
  bloomA: "rgba(29,29,32,0.05)",
  bloomB: "rgba(176,182,176,0.34)",
  cardFace: "#fbfbf9",
  cardEdge: "rgba(18,18,18,0.14)",
  cardShadow: "rgba(90,94,90,0.36)",
  hookInk: "#121212",
  // The hook's keyword, and — through `thumbnails/palette.ts` — the accent
  // painted into the POSTER headline, which is the harder of the two surfaces:
  // the poster ground (#d7d9d6) is lighter than the hook scrim. At #5b5f5b this
  // read 4.57:1 there, below the 5.29:1 the five shipped themes all manage, so
  // the one minimal theme would have had the weakest keyword in the library.
  // #4e524c is 5.61:1 on the poster and 6.82:1 on the scrim, and is still a
  // grey — the whole point of this theme is that the loudest colour is ink.
  hookKey: "#4e524c",
  hookScrim: "rgba(236,238,234,0.9)",
  ctaInk: "#121212",
  ctaFace: "#ffffff",
  progressTrack: "rgba(18,18,18,0.1)",
  progressFill: "#1d1d20",

  bylineInk: "#5c605c",
  sweepLight: "rgba(255,255,255,0.1)",
};

export const quiet = defineTheme({
  id: "quiet",
  mood: "sparse",
  musicMood: "stark",
  palette: p,
  typography: {
    display: `"Inter Tight", Inter, "Helvetica Neue", "Segoe UI", system-ui, sans-serif`,
    body: `Inter, "Segoe UI", system-ui, sans-serif`,
    displayWeight: 800,
    bodyWeight: 500,
    captionWeight: 700,
    captionSize: 42,
    hookSize: 94,
    displayTracking: "-3px",
    captionTracking: "3.4px",
    captionCase: "uppercase",
    bylineTracking: "2.4px",
    bylineSize: 23,
    caption: "chip",
  },
  texture: { grain: "none", vignette: 0, vignetteSpread: 0, bloomBlur: 240 },
  surface: { radius: 4, shadow: 0.55, faceAngle: 180, faceDepth: 0.04 },
  marker: { shape: "block", radius: 0 },
  optics: { perspective: 2800, sweepAngle: -16, sweepWidth: 18, sweepBlur: 8, bokeh: 0, cineVignette: 0.12 },
  meta: {
    name: "Premium Minimal",
    description: "Gallery white, a tight grotesque at scale, one hairline, the quietest motion here.",
    bestFor: "Design, productivity, essays — a book that wants room to breathe.",
  },
});
