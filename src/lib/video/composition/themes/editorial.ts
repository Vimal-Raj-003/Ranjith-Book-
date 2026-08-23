import type { BookTheme, ThemePalette } from "../theme-contract";
import { CARD_X, CARD_Y, CARD_W, CARD_H } from "../build";
import { alpha, mix, lift, fade } from "./color";

/**
 * The page as a magazine feature: an ecru press sheet, a masthead rule, a
 * sheet of near-white paper floating on it, and an editor's pencil under the
 * words.
 *
 * This is the only theme in the set with a LIGHT ground, which is what makes
 * it unmistakable in a feed at thumbnail size — every other theme, Marginalia
 * included, is a bright card on a dark field, and this is a bright card on a
 * brighter one. That inversion drives every other role: the caption is a
 * cream chip with ink type rather than a dark bar, the hook scrim is a warm
 * paper wash the page ghosts through rather than a blackout, and the byline
 * has to be dark enough to hold on ecru instead of light enough to hold on
 * graphite.
 *
 * The marker is a pencil, not a highlighter: a soft blush wash with a solid
 * vermillion rule sitting under it, the mark an editor actually makes.
 *
 * `mood: "warm"` maps to the `editorial` music bed in `pipeline.ts` — major,
 * gentle, the friendliest of the beds — which is this theme's brief exactly.
 *
 * Type: a text serif for body and captions, a display serif for the hook and
 * the end cards. Both stacks name faces that ship with macOS and Windows and
 * fall through to Georgia and then the generic `serif`, so nothing is ever
 * fetched — the composition renders offline and a webfont URL would silently
 * render as a fallback.
 */
const SERIF_TEXT = `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "Times New Roman", Georgia, serif`;
const SERIF_DISPLAY = `Didot, "Bodoni MT", "Hoefler Text", "Big Caslon", Garamond, Georgia, serif`;

/** Paper has a softer corner than a screen pane and a harder one than a card. */
const SHEET_RADIUS = 6;
/** Where the masthead rules sit: clear of the progress bar, above the card. */
const MASTHEAD_Y = 150;

const p: ThemePalette = {
  paper: "#fffdf8",
  ink: "#1a1712",
  // A blush wash rather than a fluorescent: multiplied over the page it warms
  // the paper under the words without ever competing with the rule below it.
  marker: "#f5cca4",
  markerEdge: "#b3341c",
  // The one light caption in the set: cream stock, ink type, a vermillion rule.
  captionBg: "#fffaf0",
  captionInk: "#1a1712",
  accent: "#b3341c",
  vignette: "rgba(120,96,60,0.18)",

  // Light "deep" and "base": on this theme the backdrop is the press sheet.
  backdropDeep: "#e4dbc8",
  backdropBase: "#f8f2e5",
  bloomA: "rgba(179,52,28,0.10)",
  bloomB: "rgba(226,186,118,0.28)",
  cardFace: "#fffdf8",
  cardEdge: "rgba(26,23,18,0.16)",
  cardShadow: "rgba(96,76,48,0.42)",
  hookInk: "#1a1712",
  // The accent as painted on the LIGHT hook scrim. Vermillion on warm cream
  // reaches about 6:1, where the same value on a dark scrim would be 3:1 —
  // the role exists precisely because those two are not the same colour.
  hookKey: "#a12c15",
  hookScrim: "rgba(248,242,229,0.88)",
  ctaInk: "#1a1712",
  ctaFace: "#fffaf0",
  progressTrack: "rgba(26,23,18,0.13)",
  progressFill: "#b3341c",

  // Warm grey on ecru: about 5:1 at 28px, deliberately quieter than the
  // caption's full ink, which is the loudest text in the frame.
  bylineInk: "#6b5c48",
  // Screen-blended over an already-light page, so this is a whisper: any more
  // and the pass blows the print out to white as it crosses.
  sweepLight: "rgba(255,252,240,0.09)",
};

export const editorial: BookTheme = {
  id: "editorial",
  mood: "warm",
  palette: p,

  css: () => `
    /* --- backdrop: an ecru press sheet with a letterpress weave ----------- */
    .backdrop { position:absolute; inset:0;
                background:
                  radial-gradient(120% 78% at 50% 6%, ${lift(p.backdropBase, 0.35)} 0%, ${p.backdropBase} 40%, ${p.backdropDeep} 100%); }
    /* A fine diagonal weave instead of Marginalia's dot grain: this ground is
       stock, not a desk. */
    .ed-weave { position:absolute; inset:0; pointer-events:none;
                background-image: repeating-linear-gradient(135deg,
                  ${alpha(p.ink, 0.03)} 0px, ${alpha(p.ink, 0.03)} 1px,
                  ${fade(p.ink)} 1px, ${fade(p.ink)} 7px); }
    .ed-bloom { position:absolute; border-radius:50%; filter: blur(170px); pointer-events:none; }
    .ed-bloom-a { width:900px; height:900px; left:-240px; top:1140px;
                  background: radial-gradient(circle, ${p.bloomA} 0%, ${fade(p.bloomA)} 70%); }
    .ed-bloom-b { width:1100px; height:1100px; left:300px; top:-320px;
                  background: radial-gradient(circle, ${p.bloomB} 0%, ${fade(p.bloomB)} 70%); }
    /* The masthead: a thick rule and a hairline, the width of the card, above
       it. Positioned from the exported layout constants, never from repeated
       numbers. */
    .ed-rule { position:absolute; left:${CARD_X}px; width:${CARD_W}px; pointer-events:none;
               background:${alpha(p.ink, 0.62)}; }
    .ed-rule-a { top:${MASTHEAD_Y}px; height:4px; }
    .ed-rule-b { top:${MASTHEAD_Y + 11}px; height:1px; }

    /* --- the card: a sheet of paper, not a pane --------------------------- */
    .card { border-radius:${SHEET_RADIUS}px; background:${p.cardFace};
            box-shadow: 0 0 0 1px ${p.cardEdge},
                        0 2px 0 0 ${alpha(p.ink, 0.05)},
                        0 40px 80px -28px ${p.cardShadow},
                        0 10px 26px -12px ${alpha(p.cardShadow, 0.5)}; }
    .card-face { position:absolute; inset:0;
                 background: linear-gradient(170deg, ${lift(p.paper, 0.4)} 0%, ${p.paper} 52%, ${mix(p.paper, p.backdropDeep, 0.22)} 100%); }

    /* --- highlight engine (look only) -------------------------------------
       A pencil, not a highlighter: a soft wash, a 2px corner, and a solid
       vermillion rule inset along the bottom edge. The rule is an inset
       box-shadow rather than a second element, because a stroke is exactly one
       element driven by one scaleX tween and nothing here may add a second. */
    .stroke { border-radius:2px;
              background: linear-gradient(180deg, ${alpha(p.marker, 0.6)} 0%, ${p.marker} 100%);
              mix-blend-mode: multiply;
              box-shadow: inset 0 -5px 0 0 ${p.markerEdge}; }

    /* --- cue: a pull-quote tag -------------------------------------------
       The whole transform is restated on \`.cue\` (untweened; only autoAlpha
       touches it) so the tilt can change. Never on \`.annot\`: same
       specificity, theme CSS appended last, and it would drop the translateX
       that centres the card. */
    .cue { transform: translateX(-50%) rotate(-1.2deg); border-radius:2px; }
    .annot { font-family:${SERIF_TEXT}; font-style:italic; font-size:34px; font-weight:600;
             color:${p.ink}; background:${p.paper}; border-top:3px solid ${p.accent};
             box-shadow: 0 0 0 1px ${alpha(p.ink, 0.14)}, 0 16px 36px -18px ${p.cardShadow}; }
    .cue-emoji { position:relative; top:-2px; }

    /* --- captions, hook, CTA, progress ------------------------------------ */
    .caption-line { font-family:${SERIF_TEXT}; font-size:56px; font-weight:700; letter-spacing:-0.5px;
                    border-radius:3px; border-bottom:5px solid ${p.accent};
                    background:${p.captionBg}; color:${p.captionInk};
                    box-shadow: 0 0 0 1px ${alpha(p.ink, 0.12)},
                                0 0 0 7px ${alpha(p.paper, 0.45)},
                                0 24px 52px -22px ${p.cardShadow}; }
    .hook-scrim { background:${p.hookScrim}; }
    .hook-text { font-family:${SERIF_DISPLAY}; font-size:84px; font-weight:700; line-height:1.06;
                 letter-spacing:-1.5px; color:${p.hookInk};
                 text-shadow: 0 2px 22px ${alpha(p.paper, 0.9)}; }
    .hook-key { color:${p.hookKey}; font-style:italic; }
    .cta-card { border-radius:${SHEET_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 1px ${alpha(p.ink, 0.14)},
                            0 0 0 10px ${alpha(p.paper, 0.4)},
                            0 40px 88px -30px ${p.cardShadow}; }
    .cta-kicker { font-family:${SERIF_TEXT}; font-size:25px; font-weight:700; letter-spacing:11px;
                  color:${p.accent}; }
    .cta-text { font-family:${SERIF_DISPLAY}; font-size:60px; font-weight:700; letter-spacing:-1px; }
    .buy-card { border-radius:${SHEET_RADIUS}px; background:${p.ctaFace}; color:${p.ctaInk};
                box-shadow: 0 0 0 1px ${alpha(p.ink, 0.14)},
                            0 26px 60px -26px ${p.cardShadow}; }
    .buy-kicker { font-family:${SERIF_TEXT}; letter-spacing:8px; color:${p.accent}; }
    .buy-text { font-family:${SERIF_DISPLAY}; font-size:36px; font-weight:700; }
    .byline { font-family:${SERIF_TEXT}; font-size:28px; font-style:italic; font-weight:600;
              letter-spacing:0.2px; color:${p.bylineInk}; text-shadow:none; }
    .progress-track { background:${p.progressTrack}; }
    .progress-fill { background: linear-gradient(90deg, ${mix(p.progressFill, p.bloomB, 0.45)} 0%, ${p.progressFill} 100%); }

    /* --- overlay: a soft light pool on the sheet, a warm vignette ---------- */
    /* Only the sheet's outer corners take any shade at all: the middle two
       thirds — where the camera parks the marker — stay clean paper, because a
       pool dark enough to be felt anywhere near the words turns the page from
       stock into cardboard. */
    .ed-pool { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
               border-radius:${SHEET_RADIUS}px; pointer-events:none; mix-blend-mode:multiply;
               background: radial-gradient(96% 70% at 50% 26%,
                 ${fade(p.vignette)} 0%, ${fade(p.vignette)} 74%, ${alpha(p.vignette, 0.22)} 100%); }
    .ed-vignette { position:absolute; inset:0; pointer-events:none;
                   box-shadow: inset 0 0 240px 90px ${p.vignette}; }
  `,

  backdrop: () =>
    `<div class="backdrop"></div><div class="ed-bloom ed-bloom-b"></div><div class="ed-bloom ed-bloom-a"></div>` +
    `<div class="ed-weave"></div><div class="ed-rule ed-rule-a"></div><div class="ed-rule ed-rule-b"></div>`,

  cardFace: () => `<div class="card-face"></div>`,

  overlay: () => `<div class="ed-pool"></div><div class="ed-vignette"></div>`,

  // One element, one transform, one scaleX tween — the rule under the words is
  // an inset shadow on that same element, never a second one.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
