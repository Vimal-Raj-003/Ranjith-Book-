import type { ThemePalette } from "../theme-contract";
import { defineTheme } from "./compile";

/**
 * Vintage Storybook — a cloth-bound children's edition that has been on a
 * shelf for forty years.
 *
 * Moss-green board rather than any of the browns already in the set (Marginalia
 * owns the warm desk, Dark Academia owns walnut), an aged cream block that has
 * yellowed unevenly, and brick red for the accent — the three colours a
 * mid-century picture book was actually printed in.
 *
 * The grain is `speckle`: six fixed, hand-placed blooms, which is foxing — the
 * rust spotting old paper develops — rather than a uniform screen. Fixed
 * positions, never random: a grain that moved frame to frame is the one thing
 * on screen that would prove the renderer screenshots rather than plays.
 *
 * The marker is a pencil: a soft apricot wash with a solid rule under it, which
 * is the mark a child's edition actually carries.
 *
 * Optics: a rounded 14px block with the deepest shadow in the set (1.3x), so
 * the page reads as a thick signature rather than a sheet, and a slow wide
 * sweep. `mood: "warm"` alone, with NO `musicMood` override — the warm bed
 * `MOOD_TO_STYLE` already picks is the right one, and naming it again would be
 * a field that says nothing.
 */
const p: ThemePalette = {
  paper: "#f3e8cf",
  ink: "#2a2416",
  marker: "#f6c9a1",
  markerEdge: "#b9552f",
  captionBg: "rgba(31,35,24,0.9)",
  captionInk: "#f7efdb",
  accent: "#b9552f",
  vignette: "rgba(48,40,16,0.52)",

  backdropDeep: "#1f2318",
  backdropBase: "#43492f",
  bloomA: "rgba(185,85,47,0.34)",
  bloomB: "rgba(212,176,96,0.3)",
  cardFace: "#f3e8cf",
  cardEdge: "rgba(243,232,207,0.26)",
  cardShadow: "rgba(16,18,8,0.66)",
  hookInk: "#f7efdb",
  hookKey: "#edb45c",
  hookScrim: "rgba(20,23,14,0.7)",
  ctaInk: "#2a2416",
  ctaFace: "#f3e8cf",
  progressTrack: "rgba(247,239,219,0.16)",
  progressFill: "#edb45c",

  bylineInk: "rgba(243,233,206,0.75)",
  sweepLight: "rgba(255,243,214,0.12)",
};

export const storybook = defineTheme({
  id: "storybook",
  mood: "warm",
  palette: p,
  typography: {
    display: `"Goudy Old Style", "Bookman Old Style", "Palatino Linotype", "Book Antiqua", Garamond, Georgia, serif`,
    body: `"Century Schoolbook", "Bookman Old Style", "Palatino Linotype", Georgia, serif`,
    displayWeight: 700,
    bodyWeight: 600,
    captionWeight: 600,
    captionSize: 52,
    hookSize: 74,
    displayTracking: "0px",
    captionTracking: "0.4px",
    bylineTracking: "1px",
    bylineStyle: "italic",
    caption: "chip",
  },
  texture: { grain: "speckle", grainOpacity: 0.2, grainBlend: "multiply", vignette: 0.62, vignetteSpread: 120, bloomBlur: 170 },
  surface: { radius: 14, shadow: 1.3, edge: 2, faceAngle: 150, faceDepth: 0.26 },
  marker: { shape: "pencil", radius: 4 },
  optics: { perspective: 2000, sweepAngle: -6, sweepWidth: 56, sweepBlur: 34, bokeh: 0.8, bokehBlur: 12, cineVignette: 0.6 },
  meta: {
    name: "Vintage Storybook",
    description: "Moss board, foxed cream paper, brick red, a pencil wash under the words.",
    bestFor: "Fables, memoir, anything with a narrator and a long time ago.",
  },
});
