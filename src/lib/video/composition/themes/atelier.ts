import type { ThemePalette } from "../theme-contract";
import { defineTheme } from "./compile";

/**
 * Luxury Editorial — ivory, charcoal and gold, with nothing in the frame that
 * does not have to be there.
 *
 * The opposite decision to Dark Academia at almost every point, which is what
 * keeps the two apart in a feed: a FLAT charcoal ground with no grain at all,
 * a cold near-white sheet rather than a warm one, a didone display face whose
 * thin strokes need the flat ground to survive, and an uppercase caption set
 * in wide tracking on a near-opaque plate.
 *
 * Gold is a hairline here, never a fill: `cardEdge` and `accent` carry it, the
 * marker is a thin gold rule under the words, and the card's shadow is the
 * shallowest in the set (0.7x) because a luxury object sits ON the surface
 * rather than floating over it.
 *
 * Optics: a tight, hard light pass (26% wide, 12px blur) — the specular flash
 * off coated stock — and no drifting bokeh at all (`bokeh: 0`). Bed: `resolve`
 * (root-position major triads, slow).
 */
const p: ThemePalette = {
  paper: "#fdfcf8",
  ink: "#141312",
  marker: "#e7dcc0",
  markerEdge: "#a8863f",
  captionBg: "rgba(17,16,15,0.94)",
  captionInk: "#fbf8f1",
  accent: "#c8ab6d",
  vignette: "rgba(20,19,18,0.42)",

  backdropDeep: "#111010",
  backdropBase: "#232120",
  bloomA: "rgba(200,171,109,0.2)",
  bloomB: "rgba(90,86,80,0.3)",
  cardFace: "#fdfcf8",
  cardEdge: "rgba(200,171,109,0.38)",
  cardShadow: "rgba(0,0,0,0.5)",
  hookInk: "#fbf8f1",
  hookKey: "#d9bd81",
  hookScrim: "rgba(14,13,12,0.8)",
  ctaInk: "#141312",
  ctaFace: "#fdfcf8",
  progressTrack: "rgba(251,248,241,0.12)",
  progressFill: "#d9bd81",

  bylineInk: "rgba(246,241,230,0.68)",
  sweepLight: "rgba(255,250,236,0.16)",
};

export const atelier = defineTheme({
  id: "atelier",
  mood: "warm",
  musicMood: "resolve",
  palette: p,
  typography: {
    display: `Didot, "Bodoni MT", "Didot LT STD", "Big Caslon", "Hoefler Text", Georgia, serif`,
    body: `"Futura", "Century Gothic", "Avenir Next", "Trebuchet MS", Inter, system-ui, sans-serif`,
    displayWeight: 400,
    bodyWeight: 500,
    captionWeight: 600,
    captionSize: 46,
    hookSize: 88,
    displayTracking: "-2px",
    captionTracking: "5px",
    captionCase: "uppercase",
    bylineTracking: "4px",
    bylineSize: 24,
    caption: "plate",
  },
  texture: { grain: "none", vignette: 0.3, vignetteSpread: 60, bloomBlur: 220 },
  surface: { radius: 0, shadow: 0.7, edge: 1, faceAngle: 180, faceDepth: 0.05 },
  marker: { shape: "underline", radius: 0 },
  optics: { perspective: 2100, sweepAngle: -14, sweepWidth: 26, sweepBlur: 12, sweepScale: 1.4, bokeh: 0, cineVignette: 0.38 },
  meta: {
    name: "Luxury Editorial",
    description: "Ivory on flat charcoal, a didone headline, gold as a hairline, uppercase captions.",
    bestFor: "Design, style, money — a book you want to look expensive.",
  },
});
