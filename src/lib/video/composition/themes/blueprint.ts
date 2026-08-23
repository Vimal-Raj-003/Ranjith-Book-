import type { BookTheme, ThemePalette } from "../theme-contract";
import { CARD_X, CARD_Y, CARD_W, CARD_H, FRAME } from "../build";
import { alpha, mix, fade } from "./color";

/**
 * The page as a drawing on a drafting table: deep indigo, a two-scale grid, a
 * sheet border, registration marks at the card's corners, and a marker that
 * measures rather than shouts.
 *
 * This is the quietest theme in the set, which is the brief — calm, technical,
 * documentary. It earns its difference from Terminal (the other dark theme)
 * structurally rather than by hue: Terminal is a screen and behaves like one
 * (scanlines, a caret, a status chip, a glow), while this is paper on a table
 * (a ruled sheet, registration crosses, spec tags, no glow anywhere). Nothing
 * in this theme emits light.
 *
 * The marker is a dimension band: a pale wash bounded top and bottom by solid
 * rules, the way a measurement is called out on a drawing — not a highlighter
 * and not an underline.
 *
 * `mood: "calm"` maps to the `blueprint` music bed in `pipeline.ts` —
 * suspended voicings, very little movement — which is this theme's brief
 * exactly.
 *
 * Type: monospace for every label (cue, byline, kickers), where a drawing sets
 * its annotations, and the frame's own grotesque for the sentences a viewer
 * actually reads. Both are system stacks with real fallbacks; nothing is
 * fetched, because the composition renders offline.
 */
const MONO = `"IBM Plex Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
const SANS = `Inter, "Helvetica Neue", "Segoe UI", Roboto, system-ui, Arial, sans-serif`;

/** A drawing is trimmed square. */
const SHEET_RADIUS = 3;
/** The drawing-sheet border, inset from the frame edge. */
const SHEET_INSET = 26;
/** Fine and coarse grid pitches, in frame pixels. */
const GRID_FINE = 40;
const GRID_COARSE = 200;

const p: ThemePalette = {
  paper: "#eef3fb",
  ink: "#0a1024",
  // A pale wash bounded by solid rules: the words keep their contrast and the
  // band reads as a measurement, not a stain.
  marker: "#9ed3ff",
  markerEdge: "#1f6fd0",
  captionBg: "rgba(9,17,44,0.93)",
  captionInk: "#eaf1ff",
  accent: "#7fb2ff",
  vignette: "rgba(3,7,22,0.55)",

  backdropDeep: "#050a1c",
  backdropBase: "#111d44",
  bloomA: "rgba(127,178,255,0.20)",
  bloomB: "rgba(157,139,255,0.18)",
  cardFace: "#0b1330",
  cardEdge: "rgba(127,178,255,0.34)",
  cardShadow: "rgba(1,4,14,0.8)",
  hookInk: "#eaf1ff",
  // The accent as painted on the indigo scrim. #7fb2ff clears 7:1 there, and
  // unlike the raw accent on paper it does not go grey at phone size.
  hookKey: "#8fc6ff",
  hookScrim: "rgba(5,10,28,0.78)",
  ctaInk: "#eaf1ff",
  ctaFace: "#0b1330",
  progressTrack: "rgba(127,178,255,0.16)",
  progressFill: "#7fb2ff",

  // Cool grey-blue at 76% on indigo: readable at 26px and deliberately
  // quieter than the caption, which is the loudest text in the frame.
  bylineInk: "rgba(178,197,232,0.76)",
  // Screen-blended, cool and very low: on a drafting table the light does not
  // flare, it passes.
  sweepLight: "rgba(206,228,255,0.09)",
};

export const blueprint: BookTheme = {
  id: "blueprint",
  mood: "calm",
  palette: p,

  css: () => `
    /* --- backdrop: indigo, a two-scale drafting grid, a sheet border ------ */
    .backdrop { position:absolute; inset:0;
                background:
                  radial-gradient(115% 70% at 50% 20%, ${p.backdropBase} 0%, ${mix(p.backdropBase, p.backdropDeep, 0.6)} 52%, ${p.backdropDeep} 100%); }
    /* Two grids at once — a fine pitch and a coarse one over it — which is
       what makes it read as drafting paper rather than as graph paper. */
    .bp-grid { position:absolute; inset:0; pointer-events:none;
               background-image:
                 linear-gradient(${alpha(p.accent, 0.07)} 1px, transparent 1px),
                 linear-gradient(90deg, ${alpha(p.accent, 0.07)} 1px, transparent 1px),
                 linear-gradient(${alpha(p.accent, 0.13)} 1px, transparent 1px),
                 linear-gradient(90deg, ${alpha(p.accent, 0.13)} 1px, transparent 1px);
               background-size: ${GRID_FINE}px ${GRID_FINE}px, ${GRID_FINE}px ${GRID_FINE}px,
                                ${GRID_COARSE}px ${GRID_COARSE}px, ${GRID_COARSE}px ${GRID_COARSE}px; }
    .bp-sheet { position:absolute; left:${SHEET_INSET}px; top:${SHEET_INSET}px;
                width:${FRAME.width - SHEET_INSET * 2}px; height:${FRAME.height - SHEET_INSET * 2}px;
                border:1px solid ${alpha(p.accent, 0.22)}; pointer-events:none; }
    .bp-bloom { position:absolute; border-radius:50%; filter: blur(170px); pointer-events:none; }
    .bp-bloom-a { width:1000px; height:1000px; left:-260px; top:-240px;
                  background: radial-gradient(circle, ${p.bloomA} 0%, ${fade(p.bloomA)} 70%); }
    .bp-bloom-b { width:980px; height:980px; left:360px; top:1240px;
                  background: radial-gradient(circle, ${p.bloomB} 0%, ${fade(p.bloomB)} 70%); }

    /* --- the card: a trimmed drawing -------------------------------------- */
    .card { border-radius:${SHEET_RADIUS}px; background:${p.cardFace};
            box-shadow: 0 0 0 1px ${p.cardEdge},
                        0 0 0 9px ${alpha(p.backdropDeep, 0.55)},
                        0 44px 96px -32px ${p.cardShadow}; }
    .card-face { position:absolute; inset:0;
                 background: linear-gradient(180deg, ${mix(p.cardFace, p.accent, 0.10)} 0%, ${p.cardFace} 100%); }
    .card-face-grid { position:absolute; inset:0;
                      background-image:
                        linear-gradient(${alpha(p.accent, 0.09)} 1px, transparent 1px),
                        linear-gradient(90deg, ${alpha(p.accent, 0.09)} 1px, transparent 1px);
                      background-size: ${GRID_FINE}px ${GRID_FINE}px, ${GRID_FINE}px ${GRID_FINE}px; }

    /* --- highlight engine (look only) -------------------------------------
       A dimension band: a pale wash bounded by a rule top and bottom. Both
       rules are inset shadows on the ONE stroke element — a stroke is exactly
       one element driven by one scaleX tween, and nothing here may add a
       second. Square corners, because a callout on a drawing has none. */
    .stroke { border-radius:0;
              background: ${alpha(p.marker, 0.5)};
              mix-blend-mode: multiply;
              box-shadow: inset 0 3px 0 0 ${p.markerEdge},
                          inset 0 -3px 0 0 ${p.markerEdge}; }

    /* --- cue: a spec tag ---------------------------------------------------
       Untilted: a drawing's annotations are square to the sheet. The whole
       transform is restated on \`.cue\` (untweened — only autoAlpha touches
       it), never on \`.annot\`: same specificity, theme CSS appended last, so
       an \`.annot\` transform silently drops the translateX that centres it. */
    .cue { transform: translateX(-50%); border-radius:2px; }
    .annot { font-family:${MONO}; font-size:26px; font-weight:500; letter-spacing:3.5px;
             text-transform:uppercase; color:${p.accent};
             background:${alpha(p.backdropDeep, 0.9)};
             border:1px solid ${alpha(p.accent, 0.42)};
             box-shadow: 0 18px 44px -22px ${p.cardShadow}; }
    .annot::before { content:"+ "; color:${alpha(p.accent, 0.55)}; }
    .cue-emoji { position:relative; top:-1px; }

    /* --- captions, hook, CTA, progress ------------------------------------ */
    .caption-line { font-family:${SANS}; font-size:58px; font-weight:800; letter-spacing:-0.5px;
                    border-radius:2px; border-top:3px solid ${p.accent};
                    background:${p.captionBg}; color:${p.captionInk};
                    box-shadow: 0 0 0 1px ${alpha(p.accent, 0.2)},
                                0 22px 52px -20px ${p.cardShadow}; }
    .hook-scrim { background:${p.hookScrim}; }
    /* The hook is set between two rules — a title block, not a headline. */
    .hook-text { font-family:${SANS}; font-size:72px; font-weight:800; line-height:1.12;
                 letter-spacing:-1px; color:${p.hookInk}; padding:38px 0;
                 border-top:1px solid ${alpha(p.accent, 0.45)};
                 border-bottom:1px solid ${alpha(p.accent, 0.45)}; }
    .hook-key { color:${p.hookKey}; }
    .cta-card { border-radius:${SHEET_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 1px ${p.cardEdge},
                            0 0 0 8px ${alpha(p.backdropDeep, 0.5)},
                            0 42px 92px -32px ${p.cardShadow}; }
    .cta-kicker { font-family:${MONO}; font-size:26px; font-weight:500; letter-spacing:10px;
                  color:${p.accent}; }
    .cta-text { font-family:${SANS}; font-size:56px; font-weight:800; letter-spacing:-1px; }
    .buy-card { border-radius:${SHEET_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 1px ${p.cardEdge}, 0 26px 62px -26px ${p.cardShadow}; }
    .buy-kicker { font-family:${MONO}; font-weight:500; letter-spacing:8px; color:${p.accent}; }
    .buy-text { font-family:${SANS}; font-size:36px; font-weight:800; }
    .byline { font-family:${MONO}; font-size:26px; font-weight:500; letter-spacing:2px;
              text-transform:uppercase; color:${p.bylineInk}; }
    .progress-track { background:${p.progressTrack}; }
    .progress-fill { background: linear-gradient(90deg, ${mix(p.progressFill, p.bloomB, 0.5)} 0%, ${p.progressFill} 100%); }

    /* --- overlay: the sheet's own grid over the drawing, corner marks ------ */
    /* Positioned from the exported layout constants, never repeated numbers. */
    .bp-over-grid { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
                    border-radius:${SHEET_RADIUS}px; overflow:hidden; pointer-events:none;
                    background-image:
                      linear-gradient(${alpha(p.markerEdge, 0.07)} 1px, transparent 1px),
                      linear-gradient(90deg, ${alpha(p.markerEdge, 0.07)} 1px, transparent 1px);
                    background-size: ${GRID_FINE}px ${GRID_FINE}px, ${GRID_FINE}px ${GRID_FINE}px; }
    /* Registration crosses, drawn as two hairlines inside one element rather
       than as four extra divs. */
    .bp-reg { position:absolute; width:28px; height:28px; pointer-events:none; opacity:.75;
              background:
                linear-gradient(${p.accent}, ${p.accent}) center / 28px 1px no-repeat,
                linear-gradient(${p.accent}, ${p.accent}) center / 1px 28px no-repeat; }
    .bp-reg-tl { left:${CARD_X - 30}px; top:${CARD_Y - 30}px; }
    .bp-reg-tr { left:${CARD_X + CARD_W + 2}px; top:${CARD_Y - 30}px; }
    .bp-reg-bl { left:${CARD_X - 30}px; top:${CARD_Y + CARD_H + 2}px; }
    .bp-reg-br { left:${CARD_X + CARD_W + 2}px; top:${CARD_Y + CARD_H + 2}px; }
    .bp-vignette { position:absolute; inset:0; pointer-events:none;
                   box-shadow: inset 0 0 280px 110px ${p.vignette}; }
  `,

  backdrop: () =>
    `<div class="backdrop"></div><div class="bp-bloom bp-bloom-a"></div><div class="bp-bloom bp-bloom-b"></div>` +
    `<div class="bp-grid"></div><div class="bp-sheet"></div>`,

  cardFace: () => `<div class="card-face"><div class="card-face-grid"></div></div>`,

  overlay: () =>
    `<div class="bp-over-grid"></div>` +
    `<div class="bp-reg bp-reg-tl"></div><div class="bp-reg bp-reg-tr"></div>` +
    `<div class="bp-reg bp-reg-bl"></div><div class="bp-reg bp-reg-br"></div>` +
    `<div class="bp-vignette"></div>`,

  // One element, one transform, one scaleX tween — the two rules bounding the
  // band are inset shadows on that same element, never extra ones.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
