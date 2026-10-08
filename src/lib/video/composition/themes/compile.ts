/**
 * One compiler, many themes.
 *
 * The five themes that shipped before this file are five hand-written modules
 * of 103–198 lines each, and about 70% of each one is the same thing said in a
 * different palette: dress `.backdrop`, dress `.card`, dress `.card-face`,
 * dress `.stroke`, dress the caption, the hook, the two end cards, the byline
 * and the progress bar. Writing five more of those is how a theme system
 * becomes a thing nobody will add to — and the operator asked for
 * configuration-driven definitions, not ten copies of one file.
 *
 * So a theme is DATA now: a `ThemeSpec` naming a palette, a type treatment, a
 * grain, a surface, a marker shape and a set of optics. `defineTheme` turns
 * that into the `BookTheme` the renderer already understands. Nothing about the
 * renderer changed, which is the point: the five existing themes are not routed
 * through here and are not touched at all, so their output is byte-identical
 * (pinned in `tests/theme-compat.test.mts`).
 *
 * Three rules this file must keep, each of which this repo has been burned by:
 *
 *  1. **No colour literal.** Every tone traces back to a `ThemePalette` role,
 *     through `./color`. A hex buried here is how Marginalia's hook keyword once
 *     drifted out of sync with the thumbnail renderer.
 *  2. **No `@keyframes`, no `transition`, no `bottom:`, no fetched asset, no
 *     randomness.** The renderer seeks to a timestamp and screenshots; it never
 *     plays forward, and it is offline.
 *  3. **No `transform` on anything GSAP drives.** `.card-pop`, `.card-drift`,
 *     `.card-sweep-band`, `.scaler`, `.column`, `.progress-fill`, `.bokeh-dot`
 *     and `#card` all receive a tween, and GSAP writes the WHOLE transform
 *     property when it tweens one component of it. The two transforms emitted
 *     below (`.card-sweep` and `.card-stage`'s perspective) are on the static
 *     parents GSAP never touches — see the `ThemeOptics` doc comment.
 *
 * `tests/themes.test.mts` enforces all three against every registered theme.
 */
import type {
  BookTheme,
  ThemeMarker,
  ThemeMeta,
  ThemeOptics,
  ThemePalette,
  ThemeSurface,
  ThemeTexture,
  ThemeTypography,
} from "../theme-contract";
import { CARD_X, CARD_Y, CARD_W, CARD_H, CARD_RADIUS } from "../build";
import { alpha, mix, lift, drop, fade } from "./color";

/** A whole theme, as data. The only thing a new theme file has to write. */
export interface ThemeSpec {
  id: string;
  /** The four-value bed enum `pipeline.ts` has always read. */
  mood: BookTheme["mood"];
  /** A bed from the 10-mood registry, when one of the four is not the right one. */
  musicMood?: string;
  palette: ThemePalette;
  typography?: ThemeTypography;
  texture?: ThemeTexture;
  surface?: ThemeSurface;
  marker?: ThemeMarker;
  optics?: ThemeOptics;
  /** Required on a spec, optional on `BookTheme`: a NEW theme must introduce itself. */
  meta: ThemeMeta;
}

/**
 * The shared system stack, repeated here rather than imported from `build.ts`
 * because it is what `sharedCss` writes and this file's whole contract is "an
 * omitted field paints exactly what the skeleton already painted".
 */
const SYSTEM_STACK = `Inter, system-ui, sans-serif`;

/**
 * Every optics default is the literal value in `sharedCss`. Read them together
 * with the rules there: `.card-stage { perspective:1700px; perspective-origin:50% 38% }`,
 * `.card-sweep { mix-blend-mode:screen; transform:rotate(-8deg) scale(1.25) }`,
 * `.card-sweep-band { width:42%; filter:blur(24px) }`, `.bokeh-dot { filter:blur(8px) }`.
 */
export const OPTICS_DEFAULTS: Required<Omit<ThemeOptics, "cineVignette">> = {
  perspective: 1700,
  perspectiveOrigin: "50% 38%",
  sweepAngle: -8,
  sweepScale: 1.25,
  sweepWidth: 42,
  sweepBlur: 24,
  sweepBlend: "screen",
  bokeh: 1,
  bokehBlur: 8,
};

/** The type defaults, likewise lifted from `sharedCss` line for line. */
export const TYPE_DEFAULTS: Required<Omit<ThemeTypography, "display" | "body">> & {
  display: string;
  body: string;
} = {
  display: SYSTEM_STACK,
  body: SYSTEM_STACK,
  displayWeight: 800,
  bodyWeight: 600,
  captionWeight: 800,
  displayTracking: "-0.5px",
  captionTracking: "normal",
  bylineTracking: "0.3px",
  captionCase: "none",
  captionSize: 60,
  hookSize: 76,
  bylineSize: 28,
  bylineStyle: "normal",
  caption: "chip",
};

export const SURFACE_DEFAULTS: Required<ThemeSurface> = {
  radius: CARD_RADIUS,
  shadow: 1,
  edge: 1,
  faceAngle: 168,
  faceDepth: 0.14,
};

export const TEXTURE_DEFAULTS: Required<ThemeTexture> = {
  grain: "none",
  grainOpacity: 0.1,
  grainScale: 3,
  grainBlend: "overlay",
  vignette: 0.55,
  vignetteSpread: 80,
  bloomBlur: 150,
};

export const MARKER_DEFAULTS: Required<ThemeMarker> = {
  shape: "highlighter",
  radius: 3,
  glow: 0,
};

/* --- grain ----------------------------------------------------------------
 * Each pattern is pure CSS over one palette role, so it costs nothing to
 * render, never fetches, and is identical on every frame — a grain that
 * differed frame to frame would be the one thing on screen that proved the
 * renderer screenshots rather than plays.
 */
function grainImage(kind: Required<ThemeTexture>["grain"], tone: string, s: number): string {
  switch (kind) {
    case "dots":
      return `radial-gradient(${tone} 1px, ${fade(tone)} 1px)`;
    case "weave":
      return `repeating-linear-gradient(135deg, ${tone} 0px, ${tone} 1px, ${fade(tone)} 1px, ${fade(tone)} ${s}px)`;
    case "fibre":
      // Two passes at right angles: paper has a grain direction and a weft.
      return (
        `repeating-linear-gradient(0deg, ${tone} 0px, ${tone} 1px, ${fade(tone)} 1px, ${fade(tone)} ${s}px),` +
        `repeating-linear-gradient(90deg, ${tone} 0px, ${tone} 1px, ${fade(tone)} 1px, ${fade(tone)} ${s * 2}px)`
      );
    case "scanline":
      return `repeating-linear-gradient(0deg, ${tone} 0px, ${tone} 1px, ${fade(tone)} 1px, ${fade(tone)} ${s}px)`;
    case "speckle":
      // Foxing: fixed, hand-placed blooms, never a random field.
      return [
        [18, 24],
        [71, 12],
        [39, 55],
        [88, 68],
        [12, 81],
        [62, 93],
      ]
        .map(([x, y]) => `radial-gradient(circle at ${x}% ${y}%, ${tone} 0%, ${fade(tone)} 7%)`)
        .join(",");
    default:
      return "";
  }
}

function grainSize(kind: Required<ThemeTexture>["grain"], s: number): string {
  if (kind === "dots") return `${s}px ${s}px`;
  if (kind === "speckle") return `auto`;
  return `auto`;
}

/* --- the marker ------------------------------------------------------------
 * One element, one `scaleX` tween, always. Every shape below is therefore a
 * background plus (at most) an inset shadow on that SAME element — a second
 * element would be a second thing to animate, and two tweens on one property
 * are order-dependent, which does not survive a seek.
 */
function markerCss(p: ThemePalette, m: Required<ThemeMarker>): string {
  const glow = m.glow > 0 ? ` box-shadow: 0 0 ${Math.round(6 * m.glow)}px ${Math.round(2 * m.glow)}px ${alpha(p.marker, Math.min(0.75, 0.45 * m.glow))};` : "";
  switch (m.shape) {
    case "pencil":
      return (
        `background: linear-gradient(180deg, ${alpha(p.marker, 0.55)} 0%, ${p.marker} 100%);` +
        ` box-shadow: inset 0 -5px 0 0 ${p.markerEdge};`
      );
    case "underline":
      // A rule with a breath of colour above it, not a block: the fill has to
      // stay a real background or the stroke paints nothing at all.
      return (
        `background: linear-gradient(180deg, ${alpha(p.marker, 0.16)} 0%, ${alpha(p.marker, 0.3)} 70%, ${p.markerEdge} 70%);`
      );
    case "block":
      return `background: ${p.marker}; box-shadow: inset 0 0 0 1px ${p.markerEdge};${glow}`;
    case "glow":
      return (
        `background: linear-gradient(180deg, ${lift(p.marker, 0.2)} 0%, ${p.marker} 60%, ${p.markerEdge} 100%);` +
        ` box-shadow: 0 0 ${Math.round(10 * Math.max(1, m.glow))}px ${Math.round(3 * Math.max(1, m.glow))}px ${alpha(p.marker, 0.55)}, inset 0 0 0 1px ${alpha(p.markerEdge, 0.8)};`
      );
    default:
      return (
        `background: linear-gradient(180deg, ${lift(p.marker, 0.22)} 0%, ${p.marker} 55%, ${p.markerEdge} 100%);${glow}`
      );
  }
}

/* --- captions -------------------------------------------------------------- */
function captionShape(p: ThemePalette, t: typeof TYPE_DEFAULTS): string {
  switch (t.caption) {
    case "plate":
      // The broadcast subtitle: a square box, no radius, no ring. It reads as
      // a caption burned into a documentary rather than a chip floating on one.
      return `border-radius:0; padding:14px 26px; box-shadow:none;`;
    case "rule":
      return `border-radius:3px; padding:14px 28px; border-bottom:5px solid ${p.accent};` +
        ` box-shadow: 0 0 0 1px ${alpha(p.ink, 0.12)}, 0 22px 48px -22px ${p.cardShadow};`;
    default:
      return `border-radius:20px; padding:16px 30px; box-shadow: 0 10px 30px -12px ${alpha(p.cardShadow, 0.7)};`;
  }
}

/**
 * Turn a spec into the theme the renderer consumes.
 *
 * The returned object spreads the spec's own optional axes back onto the
 * `BookTheme`, so a consumer that wants to know a theme's typography (the
 * preview generator does) reads it from the theme rather than re-deriving it.
 */
export function defineTheme(spec: ThemeSpec): BookTheme {
  const p = spec.palette;
  const t = { ...TYPE_DEFAULTS, ...spec.typography };
  const x = { ...TEXTURE_DEFAULTS, ...spec.texture };
  const s = { ...SURFACE_DEFAULTS, ...spec.surface };
  const m = { ...MARKER_DEFAULTS, ...spec.marker };
  const o = { ...OPTICS_DEFAULTS, ...spec.optics };

  const grainTone = alpha(mix(p.paper, p.ink, 0.35), 1);
  const hasGrain = x.grain !== "none";
  const shadowY = Math.round(42 * s.shadow);
  const shadowBlur = Math.round(90 * s.shadow);
  const caseRule = t.captionCase === "uppercase" ? ` text-transform:uppercase;` : "";

  const css = () => `
    /* --- the ground ------------------------------------------------------- */
    .backdrop { position:absolute; inset:0;
                background:
                  radial-gradient(120% 72% at 50% 20%, ${lift(p.backdropBase, 0.14)} 0%, ${p.backdropBase} 44%, ${p.backdropDeep} 100%),
                  linear-gradient(180deg, ${mix(p.backdropBase, p.backdropDeep, 0.55)} 0%, ${p.backdropDeep} 100%); }
    .tx-bloom { position:absolute; border-radius:50%; filter: blur(${x.bloomBlur}px); pointer-events:none; }
    .tx-bloom-a { width:900px; height:900px; left:-220px; top:-160px;
                  background: radial-gradient(circle, ${p.bloomA} 0%, ${fade(p.bloomA)} 70%); }
    .tx-bloom-b { width:1000px; height:1000px; left:380px; top:1180px;
                  background: radial-gradient(circle, ${p.bloomB} 0%, ${fade(p.bloomB)} 70%); }
${hasGrain
      ? `    .tx-grain { position:absolute; inset:0; pointer-events:none; opacity:${x.grainOpacity};
                 mix-blend-mode:${x.grainBlend};
                 background-image: ${grainImage(x.grain, grainTone, x.grainScale)};
                 background-size: ${grainSize(x.grain, x.grainScale)}; }`
      : `    .tx-grain { display:none; }`}

    /* --- the card --------------------------------------------------------- */
    .card { border-radius:${s.radius}px; background:${p.cardFace};
            box-shadow: 0 ${shadowY}px ${shadowBlur}px -24px ${p.cardShadow},
                        0 8px 26px -10px ${alpha(p.cardShadow, 0.5)},
                        0 0 0 ${s.edge}px ${p.cardEdge}; }
    .card-face { position:absolute; inset:0;
                 background: linear-gradient(${s.faceAngle}deg,
                   ${lift(p.paper, s.faceDepth * 1.6)} 0%,
                   ${p.paper} 54%,
                   ${mix(p.paper, p.backdropDeep, s.faceDepth)} 100%); }

    /* --- the marker (look only; geometry and timing are shared) ----------- */
    .stroke { border-radius:${m.radius}px; mix-blend-mode: multiply; ${markerCss(p, m)} }

    /* --- captions, hook, end cards, byline, progress ---------------------- */
    /* \`font-size\` is the ONE declaration in this file that needs
       \`!important\`, and it is not a shortcut. \`captionMarkup\` writes
       \`style="font-size:60px"\` (or 52px for a long line) INLINE on every
       \`.caption-line\`, and an inline style beats any stylesheet rule no matter
       how late it is appended — so without this, \`typography.captionSize\` is a
       field that silently does nothing. It was measured doing nothing: every
       one of the eleven themes computed to 52px on a long caption.
       That is not cosmetic. Atelier and Quiet set small uppercase captions in
       wide tracking precisely so a long line still fits the two-row clamp; at
       the inline 52px they overflow it and the last word is clipped.
       Only this one property is forced. Everything else here is a genuine tie
       the theme wins by being appended last. */
    .caption-line { font-family:${t.body}; font-size:${t.captionSize}px !important;
                    font-weight:${t.captionWeight};
                    letter-spacing:${t.captionTracking};${caseRule}
                    background:${p.captionBg}; color:${p.captionInk};
                    ${captionShape(p, t)} }
    .hook-scrim { background:${p.hookScrim}; }
    .hook-text { font-family:${t.display}; font-size:${t.hookSize}px; font-weight:${t.displayWeight};
                 letter-spacing:${t.displayTracking}; color:${p.hookInk};
                 text-shadow: 0 6px 26px ${alpha(p.cardShadow, 0.55)}; }
    .hook-key { color:${p.hookKey}; }
    .cta-card { border-radius:${s.radius}px; background:${p.ctaFace}; color:${p.ctaInk};
                font-family:${t.display};
                box-shadow: 0 36px 80px -24px ${p.cardShadow}, 0 0 0 ${s.edge}px ${p.cardEdge}; }
    .cta-kicker { font-family:${t.body}; color:${p.accent}; }
    .cta-text { font-family:${t.display}; font-weight:${t.displayWeight}; letter-spacing:${t.displayTracking}; }
    .buy-card { border-radius:${s.radius}px; background:${p.ctaFace}; color:${p.ctaInk};
                font-family:${t.display};
                box-shadow: 0 24px 60px -22px ${p.cardShadow}, 0 0 0 ${s.edge}px ${p.cardEdge}; }
    .buy-kicker { font-family:${t.body}; color:${p.accent}; }
    .buy-text { font-family:${t.display}; font-weight:${t.displayWeight}; }
    .byline { font-family:${t.body}; font-size:${t.bylineSize}px; font-weight:${t.bodyWeight};
              font-style:${t.bylineStyle}; letter-spacing:${t.bylineTracking};
              color:${p.bylineInk}; text-shadow: 0 2px 10px ${alpha(p.cardShadow, 0.45)}; }
    .progress-track { background:${p.progressTrack}; }
    .progress-fill { background: linear-gradient(90deg, ${p.accent} 0%, ${p.progressFill} 100%); }

    /* --- optics: the four cinematic properties no tween writes ------------ */
    /* See the ThemeOptics doc comment for why these four and no others. */
    .card-stage { perspective:${o.perspective}px; perspective-origin:${o.perspectiveOrigin}; }
    .card-sweep { mix-blend-mode:${o.sweepBlend};
                  transform: rotate(${o.sweepAngle}deg) scale(${o.sweepScale}); }
    .card-sweep-band { width:${o.sweepWidth}%; filter: blur(${o.sweepBlur}px);
                       background: linear-gradient(90deg,
                         ${fade(p.sweepLight)} 0%, ${p.sweepLight} 50%, ${fade(p.sweepLight)} 100%); }
    .cine-bokeh { opacity:${o.bokeh}; }
    .bokeh-dot { filter: blur(${o.bokehBlur}px); }
${o.cineVignette === undefined
      ? ""
      : `    .cine-vignette { background: radial-gradient(ellipse 96% 70% at 50% 44%,
                       ${fade(p.vignette)} 50%, ${alpha(drop(p.backdropDeep, 0.25), o.cineVignette)} 100%); }`}

    /* --- overlay ---------------------------------------------------------- */
    .tx-pool { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
               border-radius:${s.radius}px; pointer-events:none; mix-blend-mode:multiply;
               background: radial-gradient(96% 72% at 50% 26%,
                 ${fade(p.vignette)} 0%, ${fade(p.vignette)} 72%, ${alpha(p.vignette, 0.3)} 100%); }
    .tx-vignette { position:absolute; inset:0; pointer-events:none;
                   box-shadow: inset 0 0 260px ${x.vignetteSpread}px ${alpha(p.vignette, x.vignette)}; }
  `;

  return {
    id: spec.id,
    mood: spec.mood,
    musicMood: spec.musicMood,
    palette: p,
    typography: spec.typography,
    texture: spec.texture,
    surface: spec.surface,
    marker: spec.marker,
    optics: spec.optics,
    meta: spec.meta,
    css,
    backdrop: () =>
      `<div class="backdrop"></div><div class="tx-bloom tx-bloom-a"></div>` +
      `<div class="tx-bloom tx-bloom-b"></div>` +
      (hasGrain ? `<div class="tx-grain"></div>` : ""),
    cardFace: () => `<div class="card-face"></div>`,
    overlay: () =>
      (x.vignette > 0 ? `<div class="tx-pool"></div><div class="tx-vignette"></div>` : `<div class="tx-pool"></div>`),
    // One element, one transform, one scaleX tween — see the file header.
    strokeMarkup: (index: number) =>
      `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
  };
}
