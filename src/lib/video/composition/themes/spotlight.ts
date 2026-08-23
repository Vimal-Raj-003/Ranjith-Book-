import type { BookTheme, ThemePalette } from "../theme-contract";
import { CARD_X, CARD_Y, CARD_W, CARD_H, FRAME } from "../build";
import { alpha, mix, lift, fade } from "./color";

/**
 * The page under a stage light: near-black, one hot accent, and a beam.
 *
 * This is the loudest theme in the set and it is meant to be — it is the one
 * built for a feed, where the frame has about half a second to stop a thumb.
 * Everything is turned up: the card sits in a hot ring rather than a hairline,
 * the cue is a solid accent chip with black type rather than a quiet tag, the
 * caption is uppercase with a heavy rule under it, and there is a literal
 * light beam raking down the backdrop behind the card.
 *
 * Restraint is spent in exactly one place, and deliberately: the palette holds
 * ONE hot hue. The amber (`markerEdge`) is the same light a stop further up,
 * used only where the accent needs an edge to read against itself. A second
 * competing hue is what turns "punchy" into "circus", and the brief for this
 * theme is punchy.
 *
 * `mood: "driving"` maps to the `spotlight` music bed in `pipeline.ts` —
 * minor, faster harmonic rhythm — which is this theme's brief exactly.
 *
 * Type: the frame's own grotesque at its heaviest weight, uppercase where a
 * label rather than a sentence is being set. No font is fetched; the
 * composition renders offline, so this is a system stack with real fallbacks.
 */
const GROTESQUE = `Inter, "Helvetica Neue", "Segoe UI", Roboto, system-ui, Arial, sans-serif`;

/** A poster corner: nearly square, because a poster is not stationery. */
const POSTER_RADIUS = 6;

const p: ThemePalette = {
  paper: "#fdf6f3",
  ink: "#0a0608",
  // Light enough that the printed words stay black through the multiply, hot
  // enough that the band itself reads as a slab of colour at phone size.
  marker: "#ff7a3d",
  markerEdge: "#ffb020",
  captionBg: "rgba(8,4,6,0.94)",
  captionInk: "#fff6f2",
  accent: "#ff4d1c",
  vignette: "rgba(0,0,0,0.72)",

  backdropDeep: "#07050a",
  backdropBase: "#1a0d10",
  bloomA: "rgba(255,77,28,0.34)",
  bloomB: "rgba(255,176,32,0.20)",
  cardFace: "#0d0709",
  cardEdge: "rgba(255,77,28,0.92)",
  cardShadow: "rgba(0,0,0,0.85)",
  hookInk: "#fff6f2",
  // The accent lifted for the near-black scrim: raw #ff4d1c reads about 5:1
  // there, and the hook has two seconds to be read at phone size.
  hookKey: "#ff7a45",
  hookScrim: "rgba(6,3,5,0.74)",
  ctaInk: "#fff6f2",
  ctaFace: "#0d0709",
  progressTrack: "rgba(255,77,28,0.20)",
  progressFill: "#ff4d1c",

  // Warm off-white at 76% on near-black: legible under the card without
  // competing with the caption, which is the loudest line in the frame.
  bylineInk: "rgba(255,236,229,0.76)",
  // Screen-blended: a hot pass of stage light across the page, warmer and a
  // touch stronger than the other themes because this one is lit, not lamplit.
  sweepLight: "rgba(255,214,190,0.15)",
};

export const spotlight: BookTheme = {
  id: "spotlight",
  mood: "driving",
  palette: p,

  css: () => `
    /* --- backdrop: near-black, a hot pool, a raking beam ------------------ */
    .backdrop { position:absolute; inset:0;
                background:
                  radial-gradient(62% 34% at 50% 24%, ${alpha(p.accent, 0.30)} 0%, ${fade(p.accent)} 68%),
                  radial-gradient(120% 76% at 50% 26%, ${p.backdropBase} 0%, ${p.backdropDeep} 72%),
                  linear-gradient(180deg, ${p.backdropDeep} 0%, ${mix(p.backdropDeep, p.ink, 0.6)} 100%); }
    /* The beam: a blurred trapezoid narrowing toward the top of the frame,
       screened over the ground. Static — the renderer screenshots instants, so
       an animated beam would cost frames and buy nothing. */
    .spot-beam { position:absolute; left:120px; top:-260px; width:840px; height:1560px;
                 pointer-events:none; mix-blend-mode:screen;
                 clip-path: polygon(44% 0%, 56% 0%, 100% 100%, 0% 100%);
                 background: linear-gradient(180deg, ${alpha(p.bloomA, 0.85)} 0%, ${fade(p.bloomA)} 78%);
                 filter: blur(90px); }
    .spot-bloom { position:absolute; border-radius:50%; filter: blur(150px); pointer-events:none; }
    .spot-bloom-b { width:900px; height:900px; left:380px; top:${FRAME.height - 520}px;
                    background: radial-gradient(circle, ${p.bloomB} 0%, ${fade(p.bloomB)} 70%); }
    /* Coarse grain — a print halftone rather than Marginalia's fine paper
       tooth, so it survives a feed's compression. */
    .spot-grain { position:absolute; inset:0; opacity:.16; mix-blend-mode:overlay; pointer-events:none;
                  background-image: radial-gradient(${p.paper} 1px, ${fade(p.paper)} 1px);
                  background-size: 4px 4px; }

    /* --- the card: a poster in a hot frame -------------------------------- */
    .card { border-radius:${POSTER_RADIUS}px; background:${p.cardFace};
            box-shadow: 0 0 0 6px ${p.backdropDeep},
                        0 0 0 10px ${p.cardEdge},
                        0 0 100px -8px ${alpha(p.accent, 0.5)},
                        0 60px 120px -34px ${p.cardShadow}; }
    .card-face { position:absolute; inset:0;
                 background: linear-gradient(180deg, ${mix(p.cardFace, p.accent, 0.16)} 0%, ${p.cardFace} 60%); }

    /* --- highlight engine (look only) -------------------------------------
       A solid slab with an amber bar along its bottom edge and a hot glow
       around it. No corner radius at all: this marker is a stamp, where
       Marginalia's is a felt-tip and Editorial's is a pencil. The bar is an
       inset shadow on the one stroke element — a stroke is exactly one element
       driven by one scaleX tween, and nothing may add a second. */
    .stroke { border-radius:0;
              background: linear-gradient(180deg, ${lift(p.marker, 0.12)} 0%, ${p.marker} 100%);
              mix-blend-mode: multiply;
              box-shadow: inset 0 -7px 0 0 ${p.markerEdge},
                          0 0 30px 2px ${alpha(p.marker, 0.5)}; }

    /* --- cue: a solid accent chip -----------------------------------------
       The whole transform is restated on \`.cue\` (untweened — only autoAlpha
       touches it), never on \`.annot\`: same specificity, theme CSS appended
       last, so an \`.annot\` transform silently drops the translateX that
       centres the card. */
    .cue { transform: translateX(-50%) rotate(-2deg); border-radius:3px; }
    .annot { font-family:${GROTESQUE}; font-size:32px; font-weight:900; letter-spacing:2px;
             text-transform:uppercase; color:${p.ink}; background:${p.accent};
             box-shadow: 0 0 40px -6px ${alpha(p.accent, 0.75)}, 0 20px 44px -20px ${p.cardShadow}; }
    .cue-emoji { position:relative; top:-2px; }

    /* --- captions, hook, CTA, progress ------------------------------------ */
    .caption-line { font-family:${GROTESQUE}; font-size:56px; font-weight:900; letter-spacing:-1px;
                    text-transform:uppercase; border-radius:4px;
                    border-bottom:9px solid ${p.accent};
                    background:${p.captionBg}; color:${p.captionInk};
                    box-shadow: 0 26px 62px -18px ${p.cardShadow}; }
    .hook-scrim { background:${p.hookScrim}; }
    .hook-text { font-family:${GROTESQUE}; font-size:88px; font-weight:900; line-height:1.02;
                 letter-spacing:-3px; color:${p.hookInk};
                 text-shadow: 0 10px 40px ${alpha(p.backdropDeep, 0.85)}; }
    /* Only the keyword is uppercased. Shouting the whole hook would push a
       long one past the card and cost the retention the hook exists to buy. */
    .hook-key { color:${p.hookKey}; text-transform:uppercase;
                text-shadow: 0 0 40px ${alpha(p.accent, 0.6)}; }
    .cta-card { border-radius:${POSTER_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 4px ${p.cardEdge},
                            0 0 90px -14px ${alpha(p.accent, 0.45)},
                            0 44px 96px -30px ${p.cardShadow}; }
    .cta-kicker { font-family:${GROTESQUE}; font-size:30px; font-weight:900; letter-spacing:8px;
                  color:${p.accent}; }
    .cta-text { font-family:${GROTESQUE}; font-size:60px; font-weight:900; letter-spacing:-2px; }
    .buy-card { border-radius:${POSTER_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 3px ${alpha(p.cardEdge, 0.75)},
                            0 28px 66px -26px ${p.cardShadow}; }
    .buy-kicker { font-family:${GROTESQUE}; font-weight:900; letter-spacing:6px; color:${p.accent}; }
    .buy-text { font-family:${GROTESQUE}; font-size:38px; font-weight:900; letter-spacing:-1px; }
    .byline { font-family:${GROTESQUE}; font-size:26px; font-weight:800; letter-spacing:3px;
              text-transform:uppercase; color:${p.bylineInk}; }
    .progress-track { background:${p.progressTrack}; }
    .progress-fill { background: linear-gradient(90deg, ${p.progressFill} 0%, ${p.markerEdge} 100%);
                     box-shadow: 0 0 26px ${alpha(p.accent, 0.7)}; }

    /* --- overlay: rim light on the card, a hard vignette ------------------- */
    /* Positioned from the exported layout constants, never repeated numbers. */
    .spot-rim { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
                border-radius:${POSTER_RADIUS}px; pointer-events:none; mix-blend-mode:screen;
                background: linear-gradient(180deg,
                  ${alpha(p.accent, 0.22)} 0%, ${fade(p.accent)} 22%,
                  ${fade(p.accent)} 78%, ${alpha(p.markerEdge, 0.12)} 100%); }
    .spot-vignette { position:absolute; inset:0; pointer-events:none;
                     box-shadow: inset 0 0 320px 130px ${p.vignette}; }
  `,

  backdrop: () =>
    `<div class="backdrop"></div><div class="spot-beam"></div><div class="spot-bloom spot-bloom-b"></div><div class="spot-grain"></div>`,

  cardFace: () => `<div class="card-face"></div>`,

  overlay: () => `<div class="spot-rim"></div><div class="spot-vignette"></div>`,

  // One element, one transform, one scaleX tween — the amber bar and the glow
  // are shadows on that same element, never a second one.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
