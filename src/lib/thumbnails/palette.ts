/**
 * The thumbnail's colour roles, derived from the theme the video is actually
 * rendered in.
 *
 * This module exists because a thumbnail used to carry a hardcoded copy of
 * Marginalia's palette. That was survivable when Marginalia was the only
 * theme; with five of them it meant a video rendered in Spotlight — near-black
 * with a hot orange — was advertised by a poster in cream and yellow. A viewer
 * who clicks a cream poster and lands on a black video has been mis-sold, and
 * the two stop reading as one channel.
 *
 * A `ThemePalette` is written for a 1080x1920 composition, so it cannot be used
 * verbatim: it names a card, a caption, a progress bar, none of which a poster
 * has. What it does name is the theme's *ground* and the type that sits on it,
 * and those are exactly what a thumbnail is made of. `thumbPalette` maps one to
 * the other, and does it defensively — see `pickInk`.
 *
 * Nothing here throws and nothing here is random: an unparseable colour is
 * returned unchanged rather than raising (a poster in a slightly wrong tone is
 * a far better failure than no poster), and every derivation is pure
 * arithmetic on the palette, so the same theme always yields the same bytes.
 */

import type { ThemePalette } from "../video/composition/theme-contract";
import { bookThemeById } from "../video/composition/themes";

/**
 * A local colour parser rather than an import from the composition's
 * `themes/color.ts`, for the reason `text.ts` owns its own escaper: this module
 * must keep behaving the same way even if the composition's helpers are
 * rewritten, and it needs one thing (relative luminance) that they do not
 * export at all.
 */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byte = (n: number) => clamp(Math.round(n), 0, 255);

function parse(color: string): Rgba | null {
  if (typeof color !== "string") return null;
  const s = color.trim();

  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const v = h.split("").map((c) => parseInt(c + c, 16));
      return { r: v[0], g: v[1], b: v[2], a: h.length === 4 ? v[3] / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16));
      return { r: v[0], g: v[1], b: v[2], a: v.length === 4 ? v[3] / 255 : 1 };
    }
    return null;
  }

  const fn = s.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter((x) => x.length > 0)
      .map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a };
  }

  return null;
}

const show = (c: Rgba): string =>
  c.a >= 1
    ? `rgb(${byte(c.r)},${byte(c.g)},${byte(c.b)})`
    : `rgba(${byte(c.r)},${byte(c.g)},${byte(c.b)},${Math.round(clamp(c.a, 0, 1) * 1000) / 1000})`;

/** The same colour at a new opacity — scrims, hairlines, glows. */
export function alpha(color: string, a: number): string {
  const c = parse(color);
  return c ? show({ ...c, a: clamp(a, 0, 1) }) : color;
}

/** `t` of the way from one colour to another, in sRGB. Alpha rides along. */
export function mix(color: string, other: string, t: number): string {
  const a = parse(color);
  const b = parse(other);
  if (!a || !b) return color;
  const k = clamp(t, 0, 1);
  return show({
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  });
}

/** Fully transparent at the same hue — the outer stop of every radial bloom. */
export function fade(color: string): string {
  return alpha(color, 0);
}

/**
 * Flatten a possibly-translucent colour onto an opaque one. Palette roles are
 * written in whichever shape suited the composition — a scrim is naturally an
 * `rgba()`, a paper tone naturally a hex — and comparing the contrast of an
 * `rgba(...,0.72)` without first compositing it would measure a colour nobody
 * ever sees.
 */
function over(color: string, base: string): Rgba | null {
  const c = parse(color);
  const b = parse(base);
  if (!c) return null;
  if (c.a >= 1 || !b) return { ...c, a: 1 };
  const k = clamp(c.a, 0, 1);
  return { r: b.r + (c.r - b.r) * k, g: b.g + (c.g - b.g) * k, b: b.b + (c.b - b.b) * k, a: 1 };
}

/** WCAG relative luminance. */
function lum(c: Rgba): number {
  const ch = (v: number) => {
    const s = clamp(v, 0, 255) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** WCAG contrast ratio of `fg` over `bg`, 1..21. Unparseable reads as 1. */
export function contrast(fg: string, bg: string): number {
  const f = over(fg, bg);
  const b = over(bg, "#000000");
  if (!f || !b) return 1;
  const a = lum(f);
  const c = lum(b);
  return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
}

/** True when a surface is dark enough to want light type on it. */
export function isDark(color: string): boolean {
  const c = over(color, "#000000");
  return c ? lum(c) < 0.34 : true;
}

/**
 * The first candidate that clears `want:1` against `bg`, else whichever of the
 * candidates and plain black/white has the most contrast.
 *
 * The last-resort black-or-white is compared rather than simply preferred, and
 * that is not a nicety: Marginalia's accent is a burnt orange that its own ink
 * clears at 4.1:1 while white manages only 4.0:1, so a fallback that fired
 * whenever no candidate reached the target would have swapped the theme's own
 * ink for a WORSE colour that also happened to belong to no theme.
 *
 * The fallback chain is the whole point. A theme's `hookInk` is declared for
 * text over that theme's `hookScrim`, which is not the same surface as a
 * poster's ground: Editorial's scrim is a pale ecru wash and its `hookInk` is
 * near-black, which is right there and right here, but nothing in the contract
 * *guarantees* that for a theme added later. Rather than trusting the role and
 * shipping an invisible headline, the role is measured and only used if it
 * actually reads.
 */
function pickInk(bg: string, candidates: string[], want = 7): string {
  let best = "";
  let bestRatio = 0;
  for (const c of candidates) {
    if (!c) continue;
    const r = contrast(c, bg);
    if (r >= want) return c;
    if (r > bestRatio) {
      bestRatio = r;
      best = c;
    }
  }
  const plain = isDark(bg) ? "#ffffff" : "#0a0a0a";
  return contrast(plain, bg) > bestRatio ? plain : best || plain;
}

/**
 * How a theme's ground is patterned. Derived from the theme id rather than
 * from the palette because it is the one part of a theme's identity that
 * colour alone cannot carry: Terminal and Blueprint are both dark and both
 * ruled, and it is the ruling that says which. An id this map does not know
 * — a theme added after this file — falls through to `grain`, which suits any
 * ground rather than fighting it.
 */
const TEXTURES: Record<string, ThumbTexture> = {
  marginalia: "grain",
  terminal: "grid",
  editorial: "weave",
  spotlight: "halftone",
  blueprint: "grid",
};

/** Corner radius of the marker slab, matching each theme's stroke. */
const MARK_RADIUS: Record<string, number> = {
  marginalia: 5,
  terminal: 0,
  editorial: 2,
  spotlight: 0,
  blueprint: 0,
};

export type ThumbTexture = "grain" | "grid" | "weave" | "halftone";

/**
 * Everything a poster paints. Deliberately a small, flat set of *poster* roles
 * rather than a pass-through of `ThemePalette`: `render.ts` should never have
 * to know that `hookInk` exists or that Editorial's ground is lighter than its
 * type, and every role here is already guaranteed to read against the surface
 * it is named for.
 */
export interface ThumbPalette {
  id: string;
  /** Outer/darkest ground stop, and the inner one behind the type. */
  ground: string;
  groundMid: string;
  bloomA: string;
  bloomB: string;
  /** Headline type on the ground, and the accent painted into it. */
  ink: string;
  /** Quieter ink, for the eyebrow and the supporting line. */
  inkSoft: string;
  key: string;
  /** A solid accent block, and type that reads on top of it. */
  accent: string;
  onAccent: string;
  /** The light plate: the photograph's backing, the chip. */
  paper: string;
  paperInk: string;
  paperSoft: string;
  /** The highlighter, exactly as the video draws it. */
  marker: string;
  markerEdge: string;
  markRadius: number;
  /**
   * The slab painted behind a keyword in the headline, its lower edge, and
   * type that reads on top of it. Usually the marker — but see `thumbPalette`:
   * a marker chosen to sit on white paper is not guaranteed to separate from
   * the poster's ground, and a highlight you cannot see is not a highlight.
   */
  slab: string;
  slabEdge: string;
  onSlab: string;
  /** Grain/rule colour for the ground texture, and which texture. */
  grain: string;
  texture: ThumbTexture;
  /** True when `ground` wants light type — layouts branch on it for shadows. */
  dark: boolean;
}

/**
 * Build the poster roles for one theme.
 *
 * Takes the stored theme id — the same `string | null | undefined` the video
 * renderer takes — so an episode row written before the picker existed, or one
 * naming a theme that has since been renamed, produces the default theme's
 * poster instead of a crash. That is the same guarantee `bookThemeById` makes,
 * borrowed rather than reimplemented.
 */
export function thumbPalette(themeId?: string | null): ThumbPalette {
  const theme = bookThemeById(themeId);
  const p: ThemePalette = theme.palette;

  const ground = p.backdropDeep;
  const dark = isDark(ground);
  // The ground is a gradient from `backdropBase` down to `backdropDeep`, which
  // on some themes is only a few percent of separation. Pushed apart a little
  // so the frame has a visible top-to-bottom fall at 200px, where a subtle
  // gradient is simply a flat colour.
  const groundMid = mix(p.backdropBase, dark ? "#ffffff" : "#000000", 0.06);

  // Type on the ground. `hookInk` first — it is the theme's own answer to
  // "what colour is body text over my backdrop" — then the other declared
  // light/dark roles, then a measured fallback.
  const ink = pickInk(groundMid, [p.hookInk, p.captionInk, dark ? p.paper : p.ink]);
  // The accent as painted on the ground. `hookKey` exists for exactly this and
  // is already tuned per theme; `accent` is the fallback when it does not read.
  // 4:1 rather than 7:1 — an accent word sits inside a headline that already
  // reads, so it only has to be *distinguishable*, and holding out for 7:1
  // would reject every warm accent on a warm ground and leave the headline
  // monochrome, which is the duller failure.
  const key = pickInk(groundMid, [p.hookKey, p.accent, p.marker, p.progressFill], 4);

  const accent = p.accent;
  const onAccent = pickInk(accent, [p.ink, p.paper, p.captionInk], 4.5);

  const paper = p.paper;
  const paperInk = pickInk(paper, [p.ink, p.captionInk], 7);

  /**
   * A highlighter is designed to sit on white paper and let the print read
   * through it, so nothing says it separates from the poster's own ground.
   * Editorial is the live case: its marker is a pale peach wash and its ground
   * is ecru, so a keyword slab in it is invisible at 200px — a highlight that
   * highlights nothing. When the marker does not clear the ground, the slab
   * falls back to the theme's `accent`, which is by definition the colour that
   * theme uses when it wants to be seen. 1.7 rather than a WCAG threshold on
   * purpose: this is a block of colour against a block of colour, not text.
   */
  const markerSeparates = contrast(p.marker, groundMid) >= 1.7;
  const slab = markerSeparates ? p.marker : accent;
  const slabEdge = markerSeparates ? p.markerEdge : mix(accent, "#000000", 0.28);

  return {
    id: theme.id,
    ground,
    groundMid,
    bloomA: p.bloomA,
    bloomB: p.bloomB,
    ink,
    inkSoft: alpha(ink, 0.66),
    key,
    accent,
    onAccent,
    paper,
    paperInk,
    paperSoft: alpha(paperInk, 0.55),
    marker: p.marker,
    markerEdge: p.markerEdge,
    slab,
    slabEdge,
    // The slab is painted IN the headline, so it is read as type, not as a
    // swatch: 7:1, and measured rather than assumed, because a theme is free
    // to choose a slab colour of any lightness.
    onSlab: pickInk(slab, [p.ink, p.captionInk, p.paper], 7),
    markRadius: MARK_RADIUS[theme.id] ?? 4,
    grain: dark ? alpha(p.paper, 0.5) : alpha(p.ink, 0.5),
    texture: TEXTURES[theme.id] ?? "grain",
    dark,
  };
}
