/**
 * Deterministic colour maths for themes.
 *
 * It exists for one rule from the presentation spec's third pass: *every*
 * colour a theme paints must trace back to a role in that theme's own
 * `ThemePalette`. A hex literal buried in `css()` is what let Marginalia's
 * hook keyword drift out of sync with the thumbnail renderer, and a theme
 * needs far more tones than a palette has roles — a hairline, a scrim, a
 * bloom, a glow are all *derived* from a role, not new colours.
 *
 * So: no colour literal appears in a theme's `css()` at all. Every tone is
 * either `${p.role}` or a call into this module with a role as its argument,
 * which `tests/themes.test.mts` enforces by reading the theme sources.
 *
 * Nothing here is random and nothing here throws: an unparseable input is
 * returned unchanged rather than raising, because a malformed colour must
 * degrade to "that colour, unmodified" and never to a failed render.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const byte = (n: number) => clamp(Math.round(n), 0, 255);

/**
 * Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. Palette roles
 * are written in all of those shapes (a scrim is naturally an `rgba()`, a
 * paper tone naturally a hex), so a helper that only understood hex would
 * quietly fail on exactly the roles most likely to be re-alpha'd.
 */
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
    const parts = fn[1].split(/[\s,/]+/).filter((x) => x.length > 0).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a };
  }

  return null;
}

const render = (c: Rgba): string =>
  c.a >= 1
    ? `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})`
    : `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Math.round(clamp(c.a, 0, 1) * 1000) / 1000})`;

/** The same colour at a new opacity. Used for scrims, hairlines and glows. */
export function alpha(color: string, a: number): string {
  const c = parse(color);
  if (!c) return color;
  return render({ ...c, a: clamp(a, 0, 1) });
}

/**
 * `t` of the way from `color` to `other`, in sRGB. Alpha follows the same
 * ramp, so mixing a solid role toward a transparent one fades as well as
 * shifts — which is what a bloom's outer stop actually wants.
 */
export function mix(color: string, other: string, t: number): string {
  const a = parse(color);
  const b = parse(other);
  if (!a || !b) return color;
  const k = clamp(t, 0, 1);
  return render({
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  });
}

/** Toward white. A tint of a role is still that role, which is the point. */
export function lift(color: string, amount: number): string {
  const c = parse(color);
  if (!c) return color;
  const k = clamp(amount, 0, 1);
  return render({ r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k, a: c.a });
}

/** Toward black. */
export function drop(color: string, amount: number): string {
  const c = parse(color);
  if (!c) return color;
  const k = 1 - clamp(amount, 0, 1);
  return render({ r: c.r * k, g: c.g * k, b: c.b * k, a: c.a });
}

/** Fully transparent, at the same hue — the outer stop of every radial bloom. */
export function fade(color: string): string {
  return alpha(color, 0);
}
