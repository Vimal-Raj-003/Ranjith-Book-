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
 *    `.progress-fill`, `.caption-line`, `.cue` / `.cue-emoji` / `.cue-label`,
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
