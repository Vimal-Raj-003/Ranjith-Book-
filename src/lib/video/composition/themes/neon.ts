import type { ThemePalette } from "../theme-contract";
import { defineTheme } from "./compile";

/**
 * Futuristic Neon — the page on a lit panel, violet and magenta, with the
 * print glowing through.
 *
 * This one deserves its name honestly, which is worth stating because two of
 * the looks originally asked for do not (see the report): everything here is a
 * gradient, a blur, a blend mode and a scanline, and every one of those is
 * something this compositor already paints. Nothing is generated and nothing
 * is fetched.
 *
 * How it stays apart from Terminal, the other dark screen theme: Terminal is
 * mint phosphor on near-black graphite with a monospace face and almost no
 * bloom — a text editor. This is violet-black with a magenta accent, a cyan
 * marker that GLOWS (the one theme in the set with `shape: "glow"`), 240px
 * blooms, and a scanline across the ground. One is a terminal window, the
 * other is a sign.
 *
 * The scanline is on the BACKDROP and only the backdrop: `.tx-grain` is
 * emitted by `backdrop()`, which sits behind the card, so the photographed
 * page and the caption stay crisp. That is deliberate rather than a
 * limitation — a scanline over the print is a scanline over the one thing
 * the viewer is reading — but it is why this theme does not claim to scan
 * "everything".
 *
 * Optics: the strongest cinematic settings in the set — a 1000px perspective
 * (the most pronounced camera tilt available), a near-vertical 30deg light
 * pass that reads as a bar of light crossing the panel, full bokeh at 22px
 * blur, and the deepest `cineVignette` (0.78) so the corners fall away to
 * black. Bed: `tension` (minor seconds held against the root).
 */
const p: ThemePalette = {
  paper: "#120a22",
  ink: "#e8e2ff",
  marker: "#49e0ff",
  markerEdge: "#1d7fd4",
  captionBg: "rgba(10,4,24,0.9)",
  captionInk: "#f2ecff",
  accent: "#ff2fb8",
  vignette: "rgba(10,2,26,0.72)",

  backdropDeep: "#06030f",
  backdropBase: "#1d0b3a",
  bloomA: "rgba(255,47,184,0.46)",
  bloomB: "rgba(73,224,255,0.36)",
  cardFace: "#120a22",
  cardEdge: "rgba(255,47,184,0.42)",
  cardShadow: "rgba(0,0,0,0.78)",
  hookInk: "#f4eeff",
  hookKey: "#6ef0ff",
  hookScrim: "rgba(6,3,15,0.76)",
  ctaInk: "#f2ecff",
  ctaFace: "#160c29",
  progressTrack: "rgba(232,226,255,0.14)",
  progressFill: "#6ef0ff",

  bylineInk: "rgba(226,214,255,0.78)",
  sweepLight: "rgba(188,230,255,0.2)",
};

export const neon = defineTheme({
  id: "neon",
  mood: "driving",
  musicMood: "tension",
  palette: p,
  typography: {
    display: `"Bahnschrift", "DIN Alternate", "Eurostile", "Arial Narrow", Inter, system-ui, sans-serif`,
    body: `"Bahnschrift", "DIN Alternate", "Arial Narrow", Inter, system-ui, sans-serif`,
    displayWeight: 700,
    bodyWeight: 600,
    captionWeight: 700,
    // 46, not 50. Measured, not chosen: Bahnschrift set in caps at 2.6px
    // tracking is the widest caption in the set, and a 43-character line —
    // "Successful entrepreneurs embrace uncertainty" — wrapped to THREE rows at
    // 50px, which the two-row clamp then cut, losing the last word. 46 is the
    // largest size that holds it. `tests/themes.test.mts` measures this rather
    // than trusting it.
    captionSize: 46,
    hookSize: 82,
    displayTracking: "1.4px",
    captionTracking: "2.6px",
    captionCase: "uppercase",
    bylineTracking: "3px",
    bylineSize: 25,
    caption: "rule",
  },
  texture: { grain: "scanline", grainOpacity: 0.17, grainScale: 3, grainBlend: "screen", vignette: 0.8, vignetteSpread: 140, bloomBlur: 240 },
  surface: { radius: 10, shadow: 1.2, edge: 2, faceAngle: 200, faceDepth: 0.3 },
  marker: { shape: "glow", radius: 2, glow: 1.6 },
  optics: { perspective: 1000, perspectiveOrigin: "50% 42%", sweepAngle: -30, sweepWidth: 22, sweepBlur: 16, sweepScale: 1.6, bokeh: 1, bokehBlur: 22, cineVignette: 0.78 },
  meta: {
    name: "Futuristic Neon",
    description: "Violet ground under scanlines, magenta and cyan bloom, a marker that glows.",
    bestFor: "Technology, the future, and anything meant to stop a thumb.",
  },
});
