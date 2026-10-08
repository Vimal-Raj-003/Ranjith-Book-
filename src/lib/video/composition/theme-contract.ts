/**
 * Colour roles a theme must supply. Every role is REQUIRED rather than
 * optional, deliberately: the shared skeleton in `build.ts` derives the
 * default look of every framed surface (backdrop, card, hook card, CTA card,
 * progress bar) from this palette, so a role left unfilled would not be a
 * slightly-off colour — it would be `undefined` interpolated into a CSS
 * declaration, which the browser drops silently and which no test that only
 * checks markup would ever notice. Making them required means `tsc` catches a
 * theme that forgot one, at the only moment it is cheap to catch.
 */
export interface ThemePalette {
  paper: string;
  ink: string;
  marker: string;
  markerEdge: string;
  captionBg: string;
  captionInk: string;
  accent: string;
  vignette: string;

  // --- Framed-layout roles (spec 2026-08-23 §1/§2) -------------------------
  // Before the framed layout the page image covered all 1080x1920, so
  // `backdrop()` was painted and then completely hidden. It is visible now,
  // which is why these roles exist at all.
  /** The backdrop's outer/darkest gradient stop. */
  backdropDeep: string;
  /** The backdrop's inner/lighter gradient stop, behind the card. */
  backdropBase: string;
  /** First soft blurred colour bloom on the backdrop. */
  bloomA: string;
  /** Second soft blurred colour bloom, in a different hue from `bloomA`. */
  bloomB: string;
  /** The paper card's own surface, seen at its edges and before the page loads. */
  cardFace: string;
  /** A 1px hairline around the card, separating paper from backdrop. */
  cardEdge: string;
  /** The card's drop shadow — the thing that makes it read as floating. */
  cardShadow: string;
  /** Hook card body text. */
  hookInk: string;
  /**
   * The accent as painted ON the hook card's dark scrim, which is not the same
   * colour as `accent` on paper. Marginalia's `accent` (#d9531e) reaches only
   * about 4:1 against the backdrop, and the hook has roughly two seconds to be
   * read at phone size — the thumbnail renderer already made this distinction
   * for the identical reason, and the two must agree or a thumbnail advertises
   * a video in a different colour than the video uses.
   */
  hookKey: string;
  /** The scrim behind the hook text, so the page reads through it. */
  hookScrim: string;
  /** CTA end-card body text. */
  ctaInk: string;
  /** The CTA end card's own surface. */
  ctaFace: string;
  /** Unfilled part of the progress bar. */
  progressTrack: string;
  /** Filled part of the progress bar. */
  progressFill: string;

  // --- Motion and byline roles (spec 2026-08-23 §8/§9) ---------------------
  /**
   * The persistent byline under the card. It sits on the BACKDROP, not on
   * paper and not on a scrim, so it is neither `ink` nor `captionInk`: it has
   * to be legible against the darkest surface in the frame while staying
   * quieter than the caption, which is the loudest.
   */
  bylineInk: string;
  /**
   * The bright centre of the light-sweep band. Painted with
   * `mix-blend-mode: screen`, so this is a LIGHT value: a dark colour here
   * does nothing at all rather than darkening the page, and a fully opaque one
   * blows the print out to white as the band passes over it. A low-alpha warm
   * white is what reads as light moving over paper.
   */
  sweepLight: string;
}

/**
 * Everything a theme is allowed to change. The highlight ENGINE — geometry,
 * timing, the camera — is shared, because it is the product. A theme changes how
 * it looks, never where or when the marker goes.
 *
 * That rule is what decides which side of this interface a thing lands on.
 * The framed layout added five new on-screen surfaces, and none of them moved
 * a marker, so none of them became a theme-owned *position*:
 *
 *  - `.card` / `.card-pop` / `.card-drift` / `.card-sweep` / `.scaler` —
 *    geometry and motion, owned by `build.ts`'s exported layout constants. A
 *    theme may only restyle `.card`. In particular a theme must NEVER declare
 *    `transform` on `.card-drift`, `.card-sweep-band` or `.scaler`: the first
 *    two are tweened (theme CSS is appended last, so it would win the tie at
 *    load and then be overwritten the first time the tween runs — a jump), and
 *    the third carries the static column->card scale.
 *  - `.hook-card`, `.cta-card`, `.buy-card`, `.progress-track` /
 *    `.progress-fill`, `.caption-line`,
 *    `.byline` — placed and timed by `build.ts`, styled by the palette above
 *    and refinable by `css()`.
 *  - `cardFace()` is the one genuinely new markup surface a theme owns: what
 *    is painted INSIDE the card, behind the photographed page.
 */
export interface BookTheme {
  id: string;
  palette: ThemePalette;
  /**
   * Music mood passed through to the ffmpeg bed generator.
   * `src/lib/pipeline.ts` maps this to a music style — the set of values is
   * part of that contract, not a free-form label.
   */
  mood: "calm" | "warm" | "driving" | "sparse";

  /* === The widened surface (2026-10-05) ===================================
   *
   * Everything below is OPTIONAL, and every one of them has a documented
   * default that is *the value `build.ts` already paints*. That is the whole
   * compatibility argument and it is checked rather than asserted:
   * `tests/theme-compat.test.mts` pins a SHA-256 of each pre-existing theme's
   * five render surfaces, so a change here that moved a pixel on marginalia,
   * terminal, editorial, spotlight or blueprint fails before it ships.
   *
   * Why these axes and not the ones a plan might list. A field earns a place
   * here only if something in this repo can HONOUR it today:
   *
   *  - Typography, texture, surface and marker are honoured because a theme's
   *    `css()` is appended after the shared rules and wins every tie.
   *  - `optics` is honoured because `.card-stage`'s perspective, `.card-sweep`'s
   *    static rotation, `.cine-bokeh`'s opacity and `.cine-vignette`'s paint are
   *    the four cinematic properties GSAP never writes. (It does write
   *    `transform` on `.bokeh-dot`, `.card-sweep-band`, `.card-pop`,
   *    `.card-drift`, `.scaler`, `.column` and `#card` — none of which are
   *    reachable from here, by design.)
   *  - `musicMood` is honoured by `themeMusicStyle()`, which `pipeline.ts` uses
   *    in place of the old four-value `MOOD_TO_STYLE` lookup.
   *
   * What is deliberately NOT here: beat-to-beat motion (pop strength, drift,
   * settle timing), shot-grammar bias and transition style. Those live in
   * `build.ts`'s `TIMELINE_JS` and `scenes/director.ts` as module constants, and
   * a theme cannot reach them without a change to those files. Declaring them
   * here with nothing reading them would be a field that lies.
   */

  /**
   * The bed this theme would rather have, named from the 10-mood registry in
   * `src/lib/media/moods.ts`.
   *
   * `mood` above is a FOUR-value enum that predates that registry, so it can
   * only ever ask for four of the ten beds. This names one directly. Absent —
   * which is every theme that shipped before this field existed — the bed is
   * exactly what `MOOD_TO_STYLE[mood]` chose, so an old theme's sound is
   * unchanged. Resolved by `themes/music.ts`, never read raw.
   */
  musicMood?: string;

  /** Type treatment. Absent: the Inter stack and sizes `sharedCss` already sets. */
  typography?: ThemeTypography;
  /** Grain, weave and vignette. Absent: no grain layer and no extra vignette. */
  texture?: ThemeTexture;
  /** The card as an object. Absent: `CARD_RADIUS`, one hairline, the shared shadow. */
  surface?: ThemeSurface;
  /** How the highlight is drawn. Absent: a plain `marker` fill. */
  marker?: ThemeMarker;
  /** Camera and light. Absent: exactly `sharedCss`'s values — see `OPTICS_DEFAULTS`. */
  optics?: ThemeOptics;
  /**
   * What the picker shows for this theme without rendering a video. Absent for
   * the five that predate the preview cards; `src/lib/strings.ts` carries their
   * copy, because the inspector is `"use client"` and cannot import a theme.
   */
  meta?: ThemeMeta;
  /**
   * Extra CSS, appended after the shared rules — so it wins ties against the
   * palette-derived defaults `build.ts` emits, and a theme can refine any of
   * the surfaces listed above without the skeleton knowing about it.
   */
  css(): string;
  /**
   * Markup layered behind the card: gradient, colour blooms, grain, texture.
   * This is now genuinely visible — the page no longer covers the frame.
   */
  backdrop(): string;
  /**
   * Markup painted inside the card, behind the photographed page: the paper
   * surface itself. Sits inside `.card-pop` and `.card-drift`, so it pops and
   * breathes WITH the page rather than sliding out from under it.
   */
  cardFace(): string;
  /** Markup layered over the page — annotations, sticky notes, light pool. */
  overlay(): string;
  /** How one stroke is drawn. Must be a single scaleX tween, for seek-safety. */
  strokeMarkup(index: number): string;
}

/* ===========================================================================
 * The optional axes
 *
 * Each field below states its default as the value already in `sharedCss` or
 * `build.ts`. "Absent" and "set to the default" must paint the same pixels —
 * that is what makes the whole set additive.
 * ======================================================================== */

/**
 * Faces must be system faces. The composition renders OFFLINE: a webfont URL
 * does not error, it silently falls back, so a theme that names one is a theme
 * whose type is a lie. `tests/themes.test.mts` refuses `url(http...)` and
 * `@import` in theme CSS for exactly this reason.
 */
export interface ThemeTypography {
  /** Hook, CTA and purchase-card headline. Default: `Inter, system-ui, sans-serif`. */
  display?: string;
  /** Captions, byline, kickers. Default: `Inter, system-ui, sans-serif`. */
  body?: string;
  /** Default: 800 (hook/CTA), 600 (byline), 800 (caption). */
  displayWeight?: number;
  bodyWeight?: number;
  captionWeight?: number;
  /** Default: hook `-0.5px`, caption `normal`, byline `0.3px`. */
  displayTracking?: string;
  captionTracking?: string;
  bylineTracking?: string;
  /** Default: `none`. `uppercase` also tightens nothing else — set tracking too. */
  captionCase?: "none" | "uppercase";
  /** Default: 60 (caption), 76 (hook), 28 (byline). Device px on a 1080x1920 frame. */
  captionSize?: number;
  hookSize?: number;
  bylineSize?: number;
  /** Default: `normal`. */
  bylineStyle?: "normal" | "italic";
  /** Caption plate shape. Default: `chip` — 20px radius, 16px/30px padding. */
  caption?: "chip" | "plate" | "rule";
}

/** The ground's own material. Absent: a flat radial gradient and nothing over it. */
export interface ThemeTexture {
  /** Default: `none`. */
  grain?: "none" | "dots" | "weave" | "fibre" | "scanline" | "speckle";
  /** Default: 0.1. */
  grainOpacity?: number;
  /** Tile size in px. Default: 3. */
  grainScale?: number;
  /** Default: `overlay`. */
  grainBlend?: "overlay" | "multiply" | "soft-light" | "screen";
  /** Strength of the `overlay()` vignette, 0 removes it. Default: 0.55. */
  vignette?: number;
  /** Spread of that vignette in px. Default: 80. */
  vignetteSpread?: number;
  /** Radius of the two backdrop blooms in px. Default: 150. */
  bloomBlur?: number;
}

/** The paper card as a physical object. */
export interface ThemeSurface {
  /** Default: `CARD_RADIUS` (28). Paper wants 4–8; a screen pane wants 0–4. */
  radius?: number;
  /** Shadow depth multiplier, 1 = `sharedCss`'s `0 42px 90px -24px`. Default: 1. */
  shadow?: number;
  /** Hairline width in px. Default: 1. */
  edge?: number;
  /** Angle of the card-face gradient in deg. Default: 168. */
  faceAngle?: number;
  /** How far the face gradient travels from `paper`, 0 = flat. Default: 0.14. */
  faceDepth?: number;
}

/** How the highlight reads. Every shape keeps `mix-blend-mode: multiply`. */
export interface ThemeMarker {
  /** Default: `highlighter`. */
  shape?: "highlighter" | "pencil" | "underline" | "block" | "glow";
  /** Corner radius in px. Default: 3. */
  radius?: number;
  /** Outer glow strength, 0 removes it. Default: 0. */
  glow?: number;
}

/**
 * Camera and light — the four cinematic properties a theme can set without
 * colliding with a GSAP tween. Every default here is literally the value
 * `sharedCss` writes today; see `OPTICS_DEFAULTS` in `themes/compile.ts`.
 */
export interface ThemeOptics {
  /** `.card-stage` perspective, px. LOWER is a stronger tilt. Default: 1700. */
  perspective?: number;
  /** Default: `50% 38%`. */
  perspectiveOrigin?: string;
  /** `.card-sweep` rotation, deg. Default: -8. */
  sweepAngle?: number;
  /** `.card-sweep` scale. Default: 1.25. */
  sweepScale?: number;
  /** `.card-sweep-band` width, %. A narrow band reads as a faster, harder pass. Default: 42. */
  sweepWidth?: number;
  /** `.card-sweep-band` blur, px. Default: 24. */
  sweepBlur?: number;
  /** Default: `screen`. */
  sweepBlend?: "screen" | "overlay" | "soft-light";
  /** `.cine-bokeh` opacity, 0 removes the drifting light entirely. Default: 1. */
  bokeh?: number;
  /** `.bokeh-dot` blur, px. Default: 8. */
  bokehBlur?: number;
  /** `.cine-vignette` strength, 0 removes it. Default: 0.52 (dark grounds) / 0.2 (light). */
  cineVignette?: number;
}

/** The preview card's copy. Shown by the inspector; never painted into a video. */
export interface ThemeMeta {
  /** Display name — "Dark Academia", not "academia". */
  name: string;
  /** One line on what it looks like. */
  description: string;
  /** One line on the kind of book it suits. */
  bestFor: string;
}
