/**
 * Small, hand-authored, deterministic Lottie animations for kinetic text's
 * emphasis accent — Phase 4's first advanced-visual module.
 *
 * These are procedurally generated shape-layer JSON (the Bodymovin/Lottie
 * schema), not sourced third-party illustrations: every value here is
 * written and owned by this file, coloured from the theme's own accent, so
 * there is no licensing question and no colour that fights the
 * palette-roles-only rule the rest of the scene system already enforces
 * (tests/composition.test.mts). "Generated programmatically and remain
 * deterministic" — the same rule every other motion-graphic primitive in
 * this codebase already follows.
 *
 * Only a few EmphasisCategory values have one, deliberately: a category with
 * none simply gets no Lottie accent — the same "no forced visual" rule
 * icons.ts already follows for a phrase with no confident icon — and kinetic
 * text renders exactly as it does today. Proving that one, narrow path end
 * to end (a real render, a real fallback) is the point of this first
 * increment; more categories are a mechanical follow-up once it holds up.
 */
import type { EmphasisCategory } from "./emphasis";

/** The subset of the Lottie/Bodymovin JSON schema this file emits. Untyped
 *  beyond this shape on purpose — the full spec is far larger than what a
 *  hand-authored shape layer ever touches, and a wider type would claim
 *  support this module does not provide. */
export interface LottieAnimationData {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0;
  assets: [];
  layers: unknown[];
}

const FPS = 30;
/** How long the clip runs. Exported so the caller's own GSAP tween — which
 *  drives playback, see render.ts — uses the exact same duration rather than
 *  a second, easily-drifting copy of this number. */
export const LOTTIE_DURATION_S = 1.1;
/** Frame count for the clip. Exported so the runtime doesn't have to
 *  recompute op-ip from a JSON blob it treats as opaque. */
export const LOTTIE_FRAMES = Math.round(FPS * LOTTIE_DURATION_S);
const SIZE = 200;

function hexToRgb1(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  // Never actually reached — every theme's accent is a real #rrggbb — but a
  // shape with an odd fallback colour is still safer than a thrown error
  // over an entirely optional accent.
  if (!m) return [0.85, 0.32, 0.11];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/**
 * Standard After-Effects-style ease, on the OUTGOING side of the first
 * keyframe and the INCOMING side of the last. This is not optional styling:
 * measured directly against a real lottie-web build, an animated ("a": 1)
 * keyframe pair with no `i`/`o` at all does not fall back to linear — the
 * shape it drives renders as a `<path>` with NO `d` attribute at every
 * frame, present in the DOM and completely invisible, no thrown error
 * anywhere. `i`/`o` are required for the interpolation to run at all, not
 * an easing refinement on top of one that already does.
 */
const EASE_OUT = { x: [0.333], y: [0] };
const EASE_IN = { x: [0.667], y: [1] };

/** Opacity 0→100 and scale 0→100 across the whole clip: a plain "pop in". */
function transform(cx: number, cy: number) {
  return {
    o: { a: 1, k: [{ t: 0, s: [0], o: EASE_OUT, i: EASE_IN }, { t: LOTTIE_FRAMES, s: [100] }] },
    r: { a: 0, k: 0 },
    p: { a: 0, k: [cx, cy, 0] },
    a: { a: 0, k: [0, 0, 0] },
    s: { a: 1, k: [{ t: 0, s: [0, 0, 100], o: EASE_OUT, i: EASE_IN }, { t: LOTTIE_FRAMES, s: [100, 100, 100] }] },
  };
}

/** A filled shape group: the geometry, its fill, then a no-op transform —
 *  `tr` last is the one ordering rule a Lottie shape group actually enforces. */
function fillGroup(shape: Record<string, unknown>, rgb: [number, number, number]) {
  return {
    ty: "gr",
    it: [
      shape,
      { ty: "fl", c: { a: 0, k: [...rgb, 1] }, o: { a: 0, k: 100 }, nm: "fill" },
      { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ],
  };
}

function shapeLayer(shapes: unknown[], cx: number, cy: number): unknown {
  return { ddd: 0, ind: 1, ty: 4, nm: "accent", sr: 1, ks: transform(cx, cy), ao: 0, shapes, ip: 0, op: LOTTIE_FRAMES, st: 0, bm: 0 };
}

function coin(rgb: [number, number, number]) {
  const c = SIZE / 2;
  return shapeLayer([fillGroup({ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [SIZE * 0.62, SIZE * 0.62] }, nm: "circle" }, rgb)], c, c);
}

/** A closed, straight-edged polygon path — the simplest non-ellipse Lottie shape. */
function polygon(points: [number, number][]): Record<string, unknown> {
  const zero = points.map(() => [0, 0]);
  return { ty: "sh", ks: { a: 0, k: { c: true, i: zero, o: zero, v: points } }, nm: "polygon" };
}

function chevronUp(rgb: [number, number, number]) {
  const c = SIZE / 2;
  const r = SIZE * 0.34;
  return shapeLayer([fillGroup(polygon([[0, -r], [r, r * 0.7], [-r, r * 0.7]]), rgb)], c, c);
}

function diamond(rgb: [number, number, number]) {
  const c = SIZE / 2;
  const r = SIZE * 0.32;
  return shapeLayer([fillGroup(polygon([[0, -r], [r, 0], [0, r], [-r, 0]]), rgb)], c, c);
}

/** Category → shape builder. Deliberately partial — see the module doc. */
const BUILDERS: Partial<Record<EmphasisCategory, (rgb: [number, number, number]) => unknown>> = {
  money: coin,
  growth: chevronUp,
  solution: diamond,
};

/** The categories `lottieFor` can actually answer for, for tests and callers
 *  that want to know before asking. */
export const LOTTIE_CATEGORIES: EmphasisCategory[] = Object.keys(BUILDERS) as EmphasisCategory[];

/**
 * A ready-to-embed Lottie animation for this category in this theme's accent
 * colour, or null when none has been authored — the caller must treat null
 * exactly like "no icon found": show nothing extra, never force a
 * mismatched visual.
 */
export function lottieFor(category: EmphasisCategory, accentHex: string): LottieAnimationData | null {
  const build = BUILDERS[category];
  if (!build) return null;
  return {
    v: "5.12.2",
    fr: FPS,
    ip: 0,
    op: LOTTIE_FRAMES,
    w: SIZE,
    h: SIZE,
    nm: `accent-${category}`,
    ddd: 0,
    assets: [],
    layers: [build(hexToRgb1(accentHex))],
  };
}
