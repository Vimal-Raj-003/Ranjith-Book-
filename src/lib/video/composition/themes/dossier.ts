import type { ThemePalette } from "../theme-contract";
import { defineTheme } from "./compile";

/**
 * Documentary — the page as evidence, shot on location.
 *
 * A cold slate ground, a neutral off-white sheet with almost no warmth in it,
 * and the one thing that makes this theme what it is: a BROADCAST SUBTITLE.
 * `caption: "plate"` drops the rounded chip and the drop shadow for a square
 * box at 86% black with the text in a grotesque — the subtitle convention every
 * documentary uses, which is a far stronger signal of the genre than any
 * palette choice would be.
 *
 * The accent is a signal amber: the colour of a location card and a lower
 * third, and the only warm thing in the frame, which is why it reads as
 * information rather than decoration.
 *
 * Optics: the SHORTEST perspective in the set (1200px against 1700px), so a
 * page scene's camera tilt is pronounced — a handheld lean rather than the
 * skeleton's gentle one — with a measured, medium sweep. Bed: `vista` (wide,
 * cinematic, unhurried).
 */
const p: ThemePalette = {
  paper: "#f2f3f1",
  ink: "#15191c",
  marker: "#ffd98f",
  markerEdge: "#b06d16",
  captionBg: "rgba(0,0,0,0.86)",
  captionInk: "#ffffff",
  accent: "#e2762b",
  vignette: "rgba(10,16,20,0.5)",

  backdropDeep: "#0f1316",
  backdropBase: "#28323a",
  bloomA: "rgba(226,118,43,0.26)",
  bloomB: "rgba(70,104,128,0.4)",
  cardFace: "#f2f3f1",
  cardEdge: "rgba(226,232,236,0.2)",
  cardShadow: "rgba(0,0,0,0.6)",
  hookInk: "#f4f7f9",
  hookKey: "#f49a52",
  hookScrim: "rgba(8,12,15,0.72)",
  ctaInk: "#15191c",
  ctaFace: "#f2f3f1",
  progressTrack: "rgba(226,232,236,0.16)",
  progressFill: "#f49a52",

  bylineInk: "rgba(228,236,241,0.76)",
  sweepLight: "rgba(236,246,255,0.1)",
};

export const dossier = defineTheme({
  id: "dossier",
  mood: "calm",
  musicMood: "vista",
  palette: p,
  typography: {
    display: `"Helvetica Neue", Helvetica, Arial, Inter, system-ui, sans-serif`,
    body: `"Helvetica Neue", Helvetica, Arial, Inter, system-ui, sans-serif`,
    displayWeight: 700,
    bodyWeight: 600,
    captionWeight: 500,
    captionSize: 52,
    hookSize: 72,
    displayTracking: "-1px",
    captionTracking: "0.2px",
    bylineTracking: "1.6px",
    bylineSize: 26,
    caption: "plate",
  },
  texture: { grain: "speckle", grainOpacity: 0.16, grainBlend: "soft-light", vignette: 0.5, vignetteSpread: 90, bloomBlur: 160 },
  surface: { radius: 2, shadow: 0.9, faceAngle: 176, faceDepth: 0.08 },
  marker: { shape: "block", radius: 0 },
  optics: { perspective: 1200, perspectiveOrigin: "50% 44%", sweepAngle: -3, sweepWidth: 48, sweepBlur: 30, bokeh: 0.45, bokehBlur: 18, cineVignette: 0.5 },
  meta: {
    name: "Documentary",
    description: "Cold slate, a neutral sheet, signal amber, and real broadcast subtitles.",
    bestFor: "Reported books, biography, science — where the page is evidence.",
  },
});
