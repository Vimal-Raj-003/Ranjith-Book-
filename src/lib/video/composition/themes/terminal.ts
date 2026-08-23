import type { BookTheme, ThemePalette } from "../theme-contract";
import { CARD_X, CARD_Y, CARD_W, CARD_H } from "../build";
import { alpha, mix, fade } from "./color";

/**
 * The page as something on a screen at 2am: deep graphite, a phosphor teal
 * that selects rather than smears, and every label set in the terminal's own
 * monospace.
 *
 * Where Marginalia is a warm desk with a felt-tip, this is a dark editor.
 * The differences are structural rather than tonal — the marker is a hard
 * rectangular SELECTION with a bright leading edge (a caret dragging across
 * the words) instead of a rounded highlighter blot; the card is a screen
 * pane with corner brackets and scanlines instead of floating paper; the type
 * is monospace everywhere a theme is allowed to set type.
 *
 * `mood: "sparse"` maps to the `terminal` music bed in `pipeline.ts` —
 * minor, unhurried, no brightness — which is the same brief this palette was
 * drawn from, so the picture and the bed agree by construction.
 *
 * Type: `ui-monospace` first (SF Mono / Cascadia / the platform's own), then
 * the named faces every desktop OS ships, then the generic `monospace`. No
 * font is fetched: the composition renders offline and a `@font-face` URL
 * would render as a fallback silently.
 */
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace`;

/** The card is a screen pane, not a sheet of paper: a much tighter corner. */
const PANE_RADIUS = 10;

const p: ThemePalette = {
  // The page tone the card face carries under the photograph — cool, not warm.
  paper: "#e6edf3",
  ink: "#0b1017",
  // A pale phosphor body with a saturated caret at the leading edge. Both are
  // multiplied over the printed page, so the words stay black and only the
  // paper takes the tint.
  marker: "#7cf7d0",
  markerEdge: "#12b98a",
  captionBg: "rgba(6,10,16,0.93)",
  captionInk: "#e7f2ff",
  accent: "#5eead4",
  vignette: "rgba(2,5,9,0.62)",

  backdropDeep: "#04070c",
  backdropBase: "#101a26",
  bloomA: "rgba(94,234,212,0.22)",
  bloomB: "rgba(139,125,255,0.24)",
  cardFace: "#0b121b",
  cardEdge: "rgba(94,234,212,0.30)",
  cardShadow: "rgba(0,0,0,0.78)",
  hookInk: "#e9f4ff",
  // Teal on the near-black scrim, not the raw accent on paper: this is the
  // value the hook is actually painted at, and it clears 10:1 on #04070c.
  hookKey: "#5eead4",
  hookScrim: "rgba(4,7,12,0.76)",
  ctaInk: "#e8f2ff",
  ctaFace: "#0d1620",
  progressTrack: "rgba(94,234,212,0.14)",
  progressFill: "#5eead4",

  // Cool grey at ~78% on the graphite backdrop: legible at 26px, and quieter
  // than the caption's near-white, which is the loudest thing in the frame.
  bylineInk: "rgba(198,214,232,0.78)",
  // Screen-blended, so this is light ADDED to the page. Cool rather than
  // warm — a phosphor pass over a screen, not sunlight over paper.
  sweepLight: "rgba(186,255,240,0.10)",
};

export const terminal: BookTheme = {
  id: "terminal",
  mood: "sparse",
  palette: p,

  css: () => `
    /* --- backdrop: graphite, a 48px machine grid, two cold blooms --------- */
    .backdrop { position:absolute; inset:0;
                background:
                  radial-gradient(95% 55% at 50% 16%, ${mix(p.backdropBase, p.accent, 0.10)} 0%, ${p.backdropBase} 44%, ${p.backdropDeep} 100%),
                  linear-gradient(180deg, ${mix(p.backdropBase, p.backdropDeep, 0.4)} 0%, ${p.backdropDeep} 100%); }
    /* A grid rather than Marginalia's paper grain: the ground is a screen. */
    .term-grid { position:absolute; inset:0; pointer-events:none;
                 background-image:
                   linear-gradient(${alpha(p.accent, 0.055)} 1px, transparent 1px),
                   linear-gradient(90deg, ${alpha(p.accent, 0.055)} 1px, transparent 1px);
                 background-size: 48px 48px, 48px 48px; }
    /* Blurred blooms. Static filters, never tweened — the renderer only ever
       screenshots single instants, so an animated blur costs frames for
       nothing. */
    .term-bloom { position:absolute; border-radius:50%; filter: blur(160px); pointer-events:none; }
    .term-bloom-a { width:940px; height:940px; left:-260px; top:-200px;
                    background: radial-gradient(circle, ${p.bloomA} 0%, ${fade(p.bloomA)} 70%); }
    .term-bloom-b { width:1040px; height:1040px; left:400px; top:1220px;
                    background: radial-gradient(circle, ${p.bloomB} 0%, ${fade(p.bloomB)} 70%); }

    /* --- the card: a screen pane ------------------------------------------ */
    .card { border-radius:${PANE_RADIUS}px; background:${p.cardFace};
            box-shadow: 0 0 0 1px ${p.cardEdge},
                        0 0 70px -14px ${alpha(p.accent, 0.30)},
                        0 46px 100px -30px ${p.cardShadow}; }
    .card-face { position:absolute; inset:0;
                 background: linear-gradient(180deg, ${mix(p.cardFace, p.accent, 0.07)} 0%, ${p.cardFace} 100%); }
    .card-face-rule { position:absolute; inset:0;
                      background-image: linear-gradient(${alpha(p.accent, 0.07)} 1px, transparent 1px);
                      background-size: 100% 34px; }

    /* --- highlight engine (look only) -------------------------------------
       A hard-edged selection block, not a felt-tip blot: no corner radius, and
       the last tenth of the element is the saturated caret that leads the
       wipe. Because the whole element is scaled from its left edge by the one
       shared scaleX tween, that caret rides the growing right edge for free —
       geometry and timing are untouched, only the paint. */
    .stroke { border-radius:0;
              background: linear-gradient(90deg,
                            ${alpha(p.marker, 0.88)} 0%,
                            ${alpha(p.marker, 0.88)} 88%,
                            ${p.markerEdge} 88%,
                            ${p.markerEdge} 100%);
              mix-blend-mode: multiply;
              box-shadow: 0 0 0 1px ${alpha(p.markerEdge, 0.45)}; }

    /* --- cue: a status chip -----------------------------------------------
       The tilt is dropped by restating the WHOLE transform on \`.cue\` (which
       carries no tween — only autoAlpha touches it), never by declaring one on
       \`.annot\`: same specificity, theme CSS appended last, so an \`.annot\`
       transform silently drops the translateX that centres the card. */
    .cue { transform: translateX(-50%); border-radius:4px; }
    .annot { font-family:${MONO}; font-size:29px; font-weight:500; letter-spacing:0.4px;
             color:${p.accent}; background:${alpha(p.backdropDeep, 0.9)};
             border:1px solid ${alpha(p.accent, 0.34)}; border-left:5px solid ${p.accent};
             box-shadow: 0 18px 42px -18px ${p.cardShadow}; }
    .annot::before { content:"$ "; color:${alpha(p.accent, 0.5)}; }
    .cue-emoji { position:relative; top:-1px; }

    /* --- captions, hook, CTA, progress ------------------------------------ */
    .caption-line { font-family:${MONO}; font-size:52px; font-weight:700; letter-spacing:-0.5px;
                    border-radius:6px; border-left:6px solid ${p.accent};
                    background:${p.captionBg}; color:${p.captionInk};
                    box-shadow: 0 20px 46px -16px ${p.cardShadow}; }
    .hook-scrim { background:${p.hookScrim}; }
    .hook-text { font-family:${MONO}; font-size:62px; font-weight:700; letter-spacing:-1px;
                 line-height:1.2; color:${p.hookInk};
                 text-shadow: 0 8px 30px ${alpha(p.backdropDeep, 0.9)}; }
    .hook-key { color:${p.hookKey}; text-shadow: 0 0 28px ${alpha(p.hookKey, 0.45)}; }
    .cta-card { border-radius:${PANE_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 1px ${alpha(p.accent, 0.32)},
                            0 40px 90px -30px ${p.cardShadow}; }
    .cta-kicker { font-family:${MONO}; font-size:26px; letter-spacing:9px; color:${p.accent}; }
    .cta-text { font-family:${MONO}; font-size:48px; font-weight:700; letter-spacing:-1px; }
    .buy-card { border-radius:${PANE_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 1px ${alpha(p.accent, 0.32)},
                            0 26px 64px -24px ${p.cardShadow}; }
    .buy-kicker { font-family:${MONO}; letter-spacing:7px; color:${p.accent}; }
    .buy-text { font-family:${MONO}; font-size:33px; font-weight:700; }
    .byline { font-family:${MONO}; font-size:26px; font-weight:500; letter-spacing:0.6px;
              color:${p.bylineInk}; text-shadow: 0 2px 12px ${alpha(p.backdropDeep, 0.85)}; }
    .progress-fill { background: linear-gradient(90deg, ${alpha(p.accent, 0.5)} 0%, ${p.progressFill} 72%, ${p.markerEdge} 100%);
                     box-shadow: 0 0 20px ${alpha(p.progressFill, 0.55)}; }

    /* --- overlay: scanlines on the pane, brackets at its corners ----------- */
    /* Everything below is positioned from the exported layout constants, never
       from repeated numbers — the card can move without this drifting off it. */
    .term-scan { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
                 border-radius:${PANE_RADIUS}px; overflow:hidden; pointer-events:none;
                 background: repeating-linear-gradient(180deg,
                   ${alpha(p.backdropDeep, 0.15)} 0px, ${alpha(p.backdropDeep, 0.15)} 2px,
                   ${fade(p.backdropDeep)} 2px, ${fade(p.backdropDeep)} 5px); }
    /* A phosphor glow at the pane's top and bottom only — the middle third,
       where the camera parks the marker, is left completely clear so nothing
       tints the highlight. */
    .term-glass { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
                  border-radius:${PANE_RADIUS}px; pointer-events:none; mix-blend-mode:screen;
                  background: linear-gradient(180deg,
                    ${alpha(p.accent, 0.12)} 0%, ${fade(p.accent)} 26%,
                    ${fade(p.accent)} 74%, ${alpha(p.accent, 0.10)} 100%); }
    .term-tick { position:absolute; width:38px; height:38px; pointer-events:none;
                 border:2px solid ${alpha(p.accent, 0.72)}; }
    .term-tick-tl { left:${CARD_X - 14}px; top:${CARD_Y - 14}px; border-right:0; border-bottom:0; }
    .term-tick-tr { left:${CARD_X + CARD_W - 24}px; top:${CARD_Y - 14}px; border-left:0; border-bottom:0; }
    .term-tick-bl { left:${CARD_X - 14}px; top:${CARD_Y + CARD_H - 24}px; border-right:0; border-top:0; }
    .term-tick-br { left:${CARD_X + CARD_W - 24}px; top:${CARD_Y + CARD_H - 24}px; border-left:0; border-top:0; }
    .term-vignette { position:absolute; inset:0; pointer-events:none;
                     box-shadow: inset 0 0 300px 100px ${p.vignette}; }
  `,

  backdrop: () =>
    `<div class="backdrop"></div><div class="term-grid"></div><div class="term-bloom term-bloom-a"></div><div class="term-bloom term-bloom-b"></div>`,

  cardFace: () => `<div class="card-face"><div class="card-face-rule"></div></div>`,

  overlay: () =>
    `<div class="term-scan"></div><div class="term-glass"></div>` +
    `<div class="term-tick term-tick-tl"></div><div class="term-tick term-tick-tr"></div>` +
    `<div class="term-tick term-tick-bl"></div><div class="term-tick term-tick-br"></div>` +
    `<div class="term-vignette"></div>`,

  // One element, one transform, driven by the one shared scaleX tween. Two
  // tweens on one property are order-dependent and order does not survive a
  // seek — the caret above is a gradient stop, not a second element.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
