export interface ThemePalette {
  paper: string;
  ink: string;
  marker: string;
  markerEdge: string;
  captionBg: string;
  captionInk: string;
  accent: string;
  vignette: string;
}

/**
 * Everything a theme is allowed to change. The highlight ENGINE — geometry,
 * timing, the camera — is shared, because it is the product. A theme changes how
 * it looks, never where or when the marker goes.
 */
export interface BookTheme {
  id: string;
  palette: ThemePalette;
  /** Music mood passed through to the ffmpeg bed generator. */
  mood: "calm" | "warm" | "driving" | "sparse";
  /** Extra CSS, appended after the shared rules. */
  css(): string;
  /** Markup layered behind the page — desk, texture, vignette. */
  backdrop(): string;
  /** Markup layered over the page — annotations, sticky notes, light pool. */
  overlay(): string;
  /** How one stroke is drawn. Must be a single scaleX tween, for seek-safety. */
  strokeMarkup(index: number): string;
}
