import type { ThemePalette } from "../theme-contract";
import { defineTheme } from "./compile";

/**
 * Dark Academia — the page under a reading lamp in a library after hours.
 *
 * Walnut-black ground, a brass lamp bloom falling from the upper left, aged
 * ivory stock, and an old-style serif throughout. The grain is paper FIBRE
 * (two passes at right angles) rather than Marginalia's dot screen, because
 * what this theme is imitating is the sheet itself, not a photographic grain
 * over it.
 *
 * The marker is a sepia underline, not a highlighter: in a book this old
 * nobody takes a felt-tip to the page, and an underline leaves the print
 * entirely unobscured — which is also the most legible mark this engine can
 * make on a close shot.
 *
 * Optics: the longest perspective in the set (2400px against the skeleton's
 * 1700px), so a page scene's camera tilt is a slow lean rather than a swing,
 * and the widest, softest light sweep (62% wide, 40px blur) — a lamp moving,
 * not a flash. Bed: `nocturne` (minor 7ths, very low movement), which the
 * four-value `mood` enum could never have asked for.
 */
const p: ThemePalette = {
  paper: "#efe6d2",
  ink: "#1b150d",
  marker: "#e9d6a6",
  markerEdge: "#8a6a2f",
  captionBg: "rgba(18,13,7,0.88)",
  captionInk: "#f6ecd6",
  accent: "#c9a227",
  vignette: "rgba(26,16,4,0.6)",

  backdropDeep: "#0d0a07",
  backdropBase: "#2e2214",
  bloomA: "rgba(201,162,39,0.42)",
  bloomB: "rgba(120,72,30,0.38)",
  cardFace: "#efe6d2",
  cardEdge: "rgba(201,162,39,0.22)",
  cardShadow: "rgba(0,0,0,0.7)",
  hookInk: "#f3e9d2",
  hookKey: "#e3bb4a",
  hookScrim: "rgba(10,7,4,0.74)",
  ctaInk: "#1b150d",
  ctaFace: "#efe6d2",
  progressTrack: "rgba(233,214,166,0.14)",
  progressFill: "#e3bb4a",

  bylineInk: "rgba(238,224,192,0.74)",
  sweepLight: "rgba(255,238,198,0.11)",
};

export const academia = defineTheme({
  id: "academia",
  mood: "calm",
  musicMood: "nocturne",
  palette: p,
  typography: {
    display: `"Hoefler Text", "Baskerville Old Face", Baskerville, Garamond, "Palatino Linotype", Georgia, serif`,
    body: `"Palatino Linotype", Palatino, "Book Antiqua", "Iowan Old Style", Georgia, serif`,
    displayWeight: 700,
    captionWeight: 600,
    captionSize: 54,
    hookSize: 78,
    displayTracking: "-0.8px",
    captionTracking: "0.2px",
    bylineStyle: "italic",
    bylineTracking: "0.6px",
    caption: "chip",
  },
  texture: { grain: "fibre", grainOpacity: 0.14, grainScale: 4, grainBlend: "overlay", vignette: 0.72, vignetteSpread: 110, bloomBlur: 190 },
  surface: { radius: 6, shadow: 1.15, faceAngle: 160, faceDepth: 0.2 },
  marker: { shape: "underline", radius: 1 },
  optics: { perspective: 2400, sweepAngle: -5, sweepWidth: 62, sweepBlur: 40, bokeh: 0.7, bokehBlur: 14, cineVignette: 0.66 },
  meta: {
    name: "Dark Academia",
    description: "Walnut dark, brass lamplight, old-style serif on aged ivory, a sepia underline.",
    bestFor: "Philosophy, history, the classics — anything read slowly.",
  },
});
