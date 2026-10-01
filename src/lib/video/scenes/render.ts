/**
 * One scene, as markup plus declared animation.
 *
 * Nothing here writes JavaScript. Each template returns HTML and a list of
 * animation records, and the composition's single runtime loop applies them —
 * which is what keeps the whole scene system seek-safe by construction rather
 * than by review: every record is ONE tween of ONE primitive on ONE element,
 * and `assertSeekSafe` proves no element ever receives two that overlap.
 *
 * The rest state of every animated element is its CSS, and that CSS matches
 * the tween's from-state (invisible, unscaled, undrawn). A frame rendered
 * before an element's tween begins therefore shows exactly what a frame
 * rendered after seeking backwards past it shows.
 *
 * No import from `build.ts`: the frame rectangle is passed in. The two modules
 * would otherwise form a cycle, and a cycle among modules holding exported
 * `const`s is how `paths.ts` once ended up undefined at evaluation time.
 */
import fs from "node:fs";
import path from "node:path";
import { esc } from "../composition/escape";
import type { BookTheme } from "../composition/theme-contract";
import type { Scene, SceneIcon } from "./types";
import { emphasizeWords } from "./emphasis";
import { normalizeToken } from "../../ingest/align";
import { alpha } from "../composition/themes/color";
import type { HeroId } from "./heroes";
import { lottieFor, LOTTIE_DURATION_S, type LottieAnimationData } from "./lottie";
import { shapeForIcon, type ThreeShapeKind } from "./three-shapes";

/** Where scene content may be drawn: the same rectangle the page card occupies. */
export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The element index of a scene's `[data-drift]` wrapper (a slow push-in), and how far it pushes. */
export const DRIFT_EL = -2;
export const DRIFT_SCALE = 1.06;

/** One tween: kind `k`, on element `e` of scene `s`, at time `t` for `d` seconds. */
export interface SceneAnim {
  s: number;
  /** Element index within the scene; -1 is the scene layer itself, -2 the scene's `[data-drift]` wrapper. */
  e: number;
  k: "in" | "out" | "rise" | "pop" | "wipe" | "grow" | "draw" | "count" | "lottie" | "three" | "focus" | "cine" | "drift";
  t: number;
  d: number;
  /** The from-value: pixels for `rise`, scale for `pop`, dash length for `draw`, the target number for `count`. */
  v?: number;
  /** `count` only: text either side of the counted digits, e.g. "$" and "%". */
  prefix?: string;
  suffix?: string;
  /** `lottie` only: the animation to play, embedded whole so the runtime
   *  never has to fetch a second asset mid-render. */
  data?: LottieAnimationData;
  /** `three` only: which low-poly primitive to build (three-shapes.ts). The
   *  runtime constructs the geometry itself — unlike `lottie`'s `data`, there
   *  is no asset to embed, just a name from a small fixed vocabulary. */
  shape?: ThreeShapeKind;
  /** `cine` only: which procedural hero to draw (cine-runtime.js), and the element index of its bloom canvas. */
  hero?: HeroId;
  bloom?: number;
  /** `cine` only: the opening hook, whose headline runs several lines, so the hero is framed lower and smaller under it. */
  hook?: boolean;
}

export interface RenderedScene {
  markup: string;
  anims: SceneAnim[];
}

/**
 * Cinematic scenes are full-frame: unlike every other template they are not
 * confined to the page card's rectangle. (The frame size is repeated here
 * rather than imported from build.ts, which imports this module.)
 */
export const FULL_FRAME: SceneRect = { x: 0, y: 0, w: 1080, h: 1920 };

/** Internal render-buffer sizes of a hero canvas and its bloom (CSS stretches both to the frame). */
export const CINE_BUFFER = { w: 720, h: 1280 };
export const CINE_BLOOM = { w: 90, h: 160 };

let cineSource: string | null = null;
/**
 * The cinematic engine's source, inlined into any composition that has a
 * cinematic scene. A plain .js file read from disk (like align.py) so it can be
 * written, syntax-checked and tested as real JavaScript instead of as a string.
 */
export function cineRuntimeSource(): string {
  if (cineSource === null) cineSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "video", "scenes", "cine-runtime.js"), "utf8");
  return cineSource;
}

/** Heroes whose title is set BEHIND them, so the object overlaps its own headline. */
const TEXT_BEHIND: ReadonlySet<HeroId> = new Set<HeroId>(["hourglass", "clock", "orbit", "bookletters", "chain", "mountain", "spark", "path"]);

/** Whether a palette's backdrop is light (paper) rather than dark (film). */
export function isLightPalette(backdropDeep: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(backdropDeep.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55;
}

/** The scene layer's own cross-fade. Long enough to read as a dissolve. */
export const SCENE_FADE = 0.42;
/** How long one element takes to arrive. */
const ENTER = 0.5;
/** Entries are all on screen within this much of the scene starting. */
const ENTER_WINDOW = 1.7;

/**
 * When each of `n` entries arrives: staggered across the smaller of
 * ENTER_WINDOW and a third of the scene, so a short scene still finishes
 * arriving well before it leaves.
 */
function stagger(n: number, start: number, dur: number): number[] {
  if (n <= 0) return [];
  const window = Math.max(0.2, Math.min(ENTER_WINDOW, dur * 0.34));
  const step = n > 1 ? window / (n - 1) : 0;
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/** An icon as inline SVG. `currentColor` makes the theme's accent apply. */
function iconSvg(icon: SceneIcon, size: number): string {
  return `<svg class="sc-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon.paths}</svg>`;
}

/** Type size that keeps a block of text inside the card without measuring it. */
function fitSize(chars: number, max: number, min: number, per: number): number {
  return Math.max(min, Math.min(max, Math.round(max - chars * per)));
}

// --- the templates -----------------------------------------------------------

function kineticText(scene: Scene, i: number, accent: string): RenderedScene {
  const words = scene.words ?? [];
  const chars = words.reduce((n, w) => n + w.word.length + 1, 0);
  const size = fitSize(chars, 96, 46, 0.26);
  // "Important concepts" get visual weight, not every word — see emphasis.ts
  // for the categories and the spacing rule that keeps this occasional.
  const emphasis = emphasizeWords(words.map((w) => w.word));
  const markup = words
    .map((w, k) => {
      const hit = emphasis[k];
      const cls = hit ? ` sc-word-emph sc-cat-${hit.category}` : "";
      return `<span class="sc-word${cls}" data-el="${k}">${esc(w.word)}</span>`;
    })
    .join(" ");
  // Each word arrives on the exact measured start of that word in the audio.
  // An emphasised word pops in bigger than it rests (matching its CSS scale,
  // see sc-word-emph) rather than just rising, so the arrival itself reads as
  // the moment of emphasis, not only the word's own styling.
  const anims: SceneAnim[] = words.map((w, k) =>
    emphasis[k]
      ? { s: i, e: k, k: "pop", t: w.start, d: 0.3, v: 0.55 }
      : { s: i, e: k, k: "rise", t: w.start, d: 0.26, v: 18 },
  );
  // The optional accent icon (validate.ts) — quiet, above the words, never in
  // place of them: kinetic text is already a complete scene without it.
  const iconEl = words.length;
  let iconMarkup = "";
  if (scene.icon) {
    iconMarkup = `<div class="sc-kinetic-icon" data-el="${iconEl}">${iconSvg(scene.icon, 110)}</div>`;
    anims.push({ s: i, e: iconEl, k: "in", t: scene.start, d: 0.4 });
  } else {
    // No confident Tabler match for this scene's concept (icons.ts already
    // tried, in validate.ts) — Phase 4's first advanced-visual accent: a
    // small, hand-authored Lottie animation for the first emphasised word's
    // CATEGORY, when one has been authored (lottie.ts). Most categories have
    // none yet, so this is the ordinary path for most scenes, not a fallback
    // being exercised — the actual fallback is the `null` case right below
    // doing nothing at all, identical to today's behaviour.
    const firstHit = emphasis.find((h) => h);
    const clip = firstHit ? lottieFor(firstHit.category, accent) : null;
    if (clip) {
      // The lone element carries its own permanent-visibility exemption
      // (sceneCss) rather than a separate fade-in tween: two tweens on one
      // element in one window is exactly what `overlappingAnims` refuses,
      // and the clip's own first keyframe already starts fully invisible
      // (opacity 0, scale 0) — the seek-safety rest state lives inside the
      // Lottie data itself, not in this element's CSS.
      iconMarkup = `<div class="sc-kinetic-icon sc-lottie" data-el="${iconEl}"></div>`;
      anims.push({ s: i, e: iconEl, k: "lottie", t: scene.start, d: LOTTIE_DURATION_S, data: clip });
    }
  }
  // A slow push-in over the whole scene: type on a plain page is never a still.
  anims.push({ s: i, e: DRIFT_EL, k: "drift", t: scene.start, d: Math.max(1, scene.end - scene.start), v: DRIFT_SCALE });
  return {
    markup: `<div class="sc-kinetic-wrap" data-drift>${iconMarkup}<div class="sc-kinetic" style="font-size:${size}px">${markup}</div></div>`,
    anims,
  };
}

/**
 * A full-frame cinematic scene: one procedural 3D hero (cine-runtime.js) with
 * cinematic type. Everything animated is declared here as one tween of one
 * property on one element, so the whole scene is seek-safe by construction.
 *
 *   element 0  the hero canvas (the runtime redraws it from the timeline clock)
 *   element 1  its bloom canvas (no tween of its own; revealed with the hero)
 *   2 …        the lead, then one element per keyword letter — or, for the hook,
 *              one per spoken word
 *
 * A browser with no WebGL never reveals the canvases and shows `.cine-fallback`
 * (a plain glow) under the type instead: the scene degrades to type on a glow,
 * never to a blank.
 */
function cinematic(scene: Scene, i: number): RenderedScene {
  const cine = scene.cine!;
  const words = scene.words ?? [];
  const anims: SceneAnim[] = [];
  let text = "";

  if (cine.hook) {
    const accent = new Set((cine.accentWords ?? []).map((w) => normalizeToken(w)).filter(Boolean));
    const emphasis = emphasizeWords(words.map((w) => w.word));
    const chars = words.reduce((n, w) => n + w.word.length + 1, 0);
    const size = fitSize(chars, 92, 56, 0.24);
    const spans = words
      .map((w, k) => {
        const emph = accent.has(normalizeToken(w.word)) || Boolean(emphasis[k]);
        return `<span class="sc-word${emph ? " sc-word-emph" : ""}" data-el="${2 + k}">${esc(w.word)}</span>`;
      })
      .join(" ");
    words.forEach((w, k) => {
      const emph = accent.has(normalizeToken(w.word)) || Boolean(emphasis[k]);
      anims.push(emph ? { s: i, e: 2 + k, k: "pop", t: w.start, d: 0.34, v: 0.5 } : { s: i, e: 2 + k, k: "rise", t: w.start, d: 0.28, v: 22 });
    });
    text = `<div class="cine-hook" style="font-size:${size}px">${spans}</div>`;
  } else {
    const key = cine.keyword.trim();
    const letters = Array.from(key);
    const keyTokens = key.split(/\s+/).map(normalizeToken);
    const at = words.findIndex((w) => normalizeToken(w.word) === keyTokens[0]);
    const earliest = scene.start + 0.2;
    const latest = Math.max(earliest, scene.end - 1.3);
    const keyStart = Math.min(latest, Math.max(earliest, at >= 0 ? words[at].start : scene.start + 0.7));
    const lead = cine.lead.trim();
    let leadMarkup = "";
    let n = 2;
    if (lead) {
      const first = normalizeToken(lead.split(/\s+/)[0] ?? "");
      const li = words.findIndex((w) => normalizeToken(w.word) === first);
      const leadStart = Math.min(keyStart, Math.max(earliest, li >= 0 ? words[li].start : scene.start + 0.25));
      leadMarkup = `<div class="cine-lead" data-el="${n}">${esc(lead)}</div>`;
      anims.push({ s: i, e: n, k: "focus", t: leadStart, d: 0.5, v: 18 });
      n += 1;
    }
    const size = Math.max(92, Math.min(236, Math.round(900 / (Math.max(4, letters.length) * 0.66))));
    let step = 0;
    const spans = letters
      .map((ch) => {
        if (ch === " ") return `<span class="cine-space"> </span>`;
        const el = n++;
        anims.push({ s: i, e: el, k: "focus", t: keyStart + step * 0.05, d: 0.55, v: 34 });
        step += 1;
        return `<span class="cine-letter" data-el="${el}">${esc(ch)}</span>`;
      })
      .join("");
    text = `<div class="cine-text">${leadMarkup}<div class="cine-key" style="font-size:${size}px">${spans}</div></div>`;
  }

  anims.push({ s: i, e: 0, k: "cine", t: scene.start, d: Math.max(0.5, scene.end - scene.start), hero: cine.hero, bloom: 1, ...(cine.hook ? { hook: true } : {}) });
  const behind = TEXT_BEHIND.has(cine.hero) && !cine.hook;
  const canvases = `<canvas class="cine-canvas" data-el="0" width="${CINE_BUFFER.w}" height="${CINE_BUFFER.h}"></canvas><canvas class="cine-bloom" data-el="1" width="${CINE_BLOOM.w}" height="${CINE_BLOOM.h}"></canvas>`;
  return {
    markup: `<div class="cine-fallback"></div>${behind ? text : ""}${canvases}${behind ? "" : text}`,
    anims,
  };
}

function quote(scene: Scene, i: number): RenderedScene {
  const text = scene.quote?.text ?? "";
  const size = fitSize(text.length, 74, 38, 0.13);
  const times = stagger(2, scene.start, scene.end - scene.start);
  return {
    markup: `<div class="sc-quote" data-drift>
      <div class="sc-quote-mark" data-el="0">&ldquo;</div>
      <blockquote class="sc-quote-text" data-el="1" style="font-size:${size}px">${esc(text)}</blockquote>
      <div class="sc-quote-ref" data-el="2">page ${(scene.quote?.page ?? 0) + 1}</div>
    </div>`,
    anims: [
      { s: i, e: 0, k: "pop", t: times[0], d: ENTER, v: 0.7 },
      { s: i, e: 1, k: "rise", t: times[0] + 0.12, d: ENTER, v: 26 },
      { s: i, e: 2, k: "in", t: times[1] + 0.2, d: ENTER },
      // A quote card can be on screen for ten seconds while the line is read: it drifts closer the whole time.
      { s: i, e: DRIFT_EL, k: "drift", t: scene.start, d: Math.max(1, scene.end - scene.start), v: DRIFT_SCALE },
    ],
  };
}

/** The Three.js accent's own internal render-buffer size — see three-shapes.ts's
 *  runtime and the SIZE convention lottie.ts already set for the same reason:
 *  one fixed number every accent shares, rather than one guessed per call site. */
const THREE_SIZE = 200;

function iconConcept(scene: Scene, i: number): RenderedScene {
  const icons = scene.icons ?? [];
  const labels = scene.items ?? [];
  const size = icons.length === 1 ? 300 : icons.length === 2 ? 220 : 170;
  const times = stagger(icons.length, scene.start, scene.end - scene.start);
  // Element indices past the cells' own (0..icons.length-1) so the canvas's
  // "three" tween never shares a key with its cell's "pop" tween —
  // `overlappingAnims` keys purely on element index, and the two run for
  // different, overlapping windows (the cell pops in once; the shape keeps
  // turning for as long as the scene holds).
  const threeEl = (k: number) => icons.length + k;
  const cells = icons
    .map(
      (icon, k) => `<div class="sc-cell" data-el="${k}">
        <div class="sc-icon-well" style="--sz:${size}px">
          ${iconSvg(icon, Math.round(size * 0.56))}
          <canvas class="sc-three" data-el="${threeEl(k)}" width="${THREE_SIZE}" height="${THREE_SIZE}"></canvas>
        </div>
        ${labels[k] ? `<div class="sc-cell-label">${esc(labels[k])}</div>` : ""}
      </div>`,
    )
    .join("");
  const anims: SceneAnim[] = icons.map((_, k) => ({ s: i, e: k, k: "pop" as const, t: times[k], d: ENTER, v: 0.62 }));
  // The optional Three.js treatment (three-shapes.ts), Phase 4's second
  // advanced-visual module — a low-poly shape standing over the SAME flat
  // icon rather than a separate slot, so a browser that cannot show it
  // (no WebGL, the CDN failed, `window.THREE` never loaded) leaves exactly
  // what renders today: the plain Tabler icon, already in the markup above,
  // never conditional on this tween existing at all.
  //
  // This tween's OWN window is not the icon's brief pop-in: it runs from the
  // icon's own arrival to the scene's end, so the shape keeps a slow, subtle
  // turn for as long as it holds the frame, not just for its entrance.
  icons.forEach((icon, k) => {
    const start = times[k];
    const dur = Math.max(0.5, scene.end - start);
    anims.push({ s: i, e: threeEl(k), k: "three", t: start, d: dur, shape: shapeForIcon(icon) });
  });
  return {
    markup: `<div class="sc-icons sc-cols-${icons.length}">${cells}</div>`,
    anims,
  };
}

function comparison(scene: Scene, i: number): RenderedScene {
  const icons = scene.icons ?? [];
  const times = stagger(3, scene.start, scene.end - scene.start);
  const side = (label: string, icon: SceneIcon | undefined, el: number) =>
    `<div class="sc-side" data-el="${el}">
      ${icon ? `<div class="sc-side-icon">${iconSvg(icon, 130)}</div>` : ""}
      <div class="sc-side-label">${esc(label)}</div>
    </div>`;
  return {
    markup: `<div class="sc-compare">
      ${side(scene.left ?? "", icons[0], 0)}
      <div class="sc-vs" data-el="1">vs</div>
      ${side(scene.right ?? "", icons[1], 2)}
    </div>`,
    anims: [
      { s: i, e: 0, k: "rise", t: times[0], d: ENTER, v: 34 },
      { s: i, e: 1, k: "pop", t: times[1], d: 0.36, v: 0.5 },
      { s: i, e: 2, k: "rise", t: times[2], d: ENTER, v: 34 },
    ],
  };
}

function steps(scene: Scene, i: number): RenderedScene {
  const items = scene.steps ?? [];
  const times = stagger(items.length, scene.start, scene.end - scene.start);
  const rows = items
    .map(
      (s, k) => `<div class="sc-step" data-el="${k}">
        <div class="sc-step-n">${k + 1}</div>
        <div class="sc-step-t">${esc(s)}</div>
      </div>`,
    )
    .join("");
  const headingEl = items.length;
  const connectorEl = items.length + 1;
  // The same "a line joins the points" idea `timeline`'s axis already draws,
  // scaled to run behind the step numbers instead of down the whole card —
  // a diagram connector, so a process reads as one thing with stages, not a
  // stack of unrelated cards.
  const connector = items.length > 1 ? `<div class="sc-step-connector" data-el="${connectorEl}"></div>` : "";
  return {
    markup: `<div class="sc-steps">${connector}${scene.concept ? `<div class="sc-heading" data-el="${headingEl}">${esc(scene.concept)}</div>` : ""}${rows}</div>`,
    anims: [
      ...items.map((_, k) => ({ s: i, e: k, k: "rise" as const, t: times[k], d: ENTER, v: 30 })),
      ...(scene.concept ? [{ s: i, e: headingEl, k: "in" as const, t: scene.start, d: 0.36 }] : []),
      ...(items.length > 1
        ? [{ s: i, e: connectorEl, k: "grow" as const, t: scene.start + 0.1, d: Math.min(1.2, (scene.end - scene.start) * 0.5) }]
        : []),
    ],
  };
}

function timeline(scene: Scene, i: number): RenderedScene {
  const items = scene.steps ?? [];
  const times = stagger(items.length, scene.start + 0.25, scene.end - scene.start);
  const rows = items
    .map(
      (s, k) => `<div class="sc-tl-row" data-el="${k}">
        <div class="sc-tl-dot"></div>
        <div class="sc-tl-label">${esc(s)}</div>
      </div>`,
    )
    .join("");
  const axisEl = items.length;
  return {
    markup: `<div class="sc-timeline">
      <div class="sc-tl-axis" data-el="${axisEl}"></div>
      ${rows}
    </div>`,
    anims: [
      { s: i, e: axisEl, k: "grow", t: scene.start, d: Math.min(1.1, (scene.end - scene.start) * 0.4) },
      ...items.map((_, k) => ({ s: i, e: k, k: "rise" as const, t: times[k], d: 0.44, v: 22 })),
    ],
  };
}

/** The curve's box inside the scene, and the path length used for the draw. */
const CURVE = { w: 760, h: 380 };

function growthCurve(scene: Scene, i: number): RenderedScene {
  const pts = scene.curve?.points ?? [];
  const max = Math.max(1, ...pts);
  const coords = pts.map((v, k) => {
    const x = (CURVE.w * k) / Math.max(1, pts.length - 1);
    const y = CURVE.h - (v / max) * CURVE.h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  // A generous over-estimate of the polyline's length: the dash offset only
  // has to be at least the path length for the draw to start fully hidden.
  const dash = Math.round(CURVE.w + CURVE.h * 2);
  const drawEnd = scene.start + 0.15 + Math.min(1.8, (scene.end - scene.start) * 0.6);
  // The same line, closed down to the baseline — a chart reads as a chart
  // once the area under it has weight, not just a stroke. Revealed after the
  // line finishes drawing, so it never appears ahead of the line itself.
  const fillPoints = `0,${CURVE.h} ${coords.join(" ")} ${CURVE.w},${CURVE.h}`;
  // Three quiet gridlines. Static — a chart's grid does not animate in real
  // life either, and everything that draws attention here should be the data.
  const grid = [0.25, 0.5, 0.75]
    .map((f) => `<line class="sc-grid" x1="0" y1="${(CURVE.h * f).toFixed(1)}" x2="${CURVE.w}" y2="${(CURVE.h * f).toFixed(1)}" />`)
    .join("");
  return {
    markup: `<div class="sc-curve">
      ${scene.curve?.label ? `<div class="sc-curve-label" data-el="2">${esc(scene.curve.label)}</div>` : ""}
      <svg viewBox="0 0 ${CURVE.w} ${CURVE.h}" width="${CURVE.w}" height="${CURVE.h}" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="sc-curve-fill-${i}" x1="0" y1="0" x2="0" y2="1">
            <stop class="sc-curve-fill-top" offset="0%" />
            <stop class="sc-curve-fill-bottom" offset="100%" />
          </linearGradient>
        </defs>
        ${grid}
        <line class="sc-axis" x1="0" y1="${CURVE.h}" x2="${CURVE.w}" y2="${CURVE.h}" />
        <polygon class="sc-curve-fill" data-el="3" fill="url(#sc-curve-fill-${i})" points="${fillPoints}" />
        <polyline class="sc-curve-line" data-el="0" points="${coords.join(" ")}"
                  stroke-linecap="round" stroke-linejoin="round"
                  style="stroke-dasharray:${dash};stroke-dashoffset:${dash}" />
        <circle class="sc-curve-head" data-el="1" cx="${CURVE.w}" cy="${(CURVE.h - (pts[pts.length - 1] / max) * CURVE.h).toFixed(1)}" r="12" />
      </svg>
    </div>`,
    anims: [
      { s: i, e: 0, k: "draw", t: scene.start + 0.15, d: drawEnd - (scene.start + 0.15), v: dash },
      { s: i, e: 1, k: "pop", t: drawEnd, d: 0.4, v: 0.2 },
      { s: i, e: 3, k: "in", t: drawEnd, d: 0.6 },
      ...(scene.curve?.label ? [{ s: i, e: 2, k: "in" as const, t: scene.start, d: 0.4 }] : []),
    ],
  };
}

/**
 * A stat's value, split for counting — "$4,000" → prefix "$", digits "4000",
 * suffix "" — or null when it is not a clean whole number (a decimal, a
 * range like "50-100", a bare word like "double"). Those still render, just
 * without the count-up: a `stat` scene the number came from `numberIsSaid`,
 * which already accepts things a counter cannot honestly animate through.
 */
export function counted(value: string): { prefix: string; digits: string; suffix: string; n: number } | null {
  const m = /^([$]?)([\d,]{1,10})([%x+]?)$/.exec(value.trim());
  if (!m) return null;
  const digits = m[2].replace(/,/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3], n };
}

function stat(scene: Scene, i: number): RenderedScene {
  const value = scene.stat?.value ?? "";
  const label = scene.stat?.label ?? "";
  const size = fitSize(value.length, 300, 120, 14);
  const count = counted(value);
  // The counted digits are a SEPARATE element (data-el 3) from the value
  // wrapper (data-el 0) that pops in, not the same one: `overlappingAnims`
  // refuses two tweens on one element in the same window, and `pop`'s scale
  // and `count`'s digit-by-digit text both run across the value's own
  // arrival. `.sc-stat-count` is exempted from the generic hidden rest state
  // (see sceneCss) because its visibility is the PARENT's — `pop` — not its
  // own; count never touches opacity, only textContent.
  const valueMarkup = count
    ? `<span class="sc-stat-count" data-el="3">${esc(count.prefix)}0${esc(count.suffix)}</span>`
    : esc(value);
  return {
    markup: `<div class="sc-stat">
      <div class="sc-stat-value" data-el="0" style="font-size:${size}px">${valueMarkup}</div>
      ${label ? `<div class="sc-stat-label" data-el="1">${esc(label)}</div>` : ""}
      <div class="sc-stat-rule" data-el="2"></div>
    </div>`,
    anims: [
      { s: i, e: 0, k: "pop", t: scene.start, d: 0.52, v: 0.66 },
      { s: i, e: 2, k: "wipe", t: scene.start + 0.3, d: 0.5 },
      ...(label ? [{ s: i, e: 1, k: "rise" as const, t: scene.start + 0.42, d: ENTER, v: 22 }] : []),
      ...(count
        ? [
            {
              s: i,
              e: 3,
              k: "count" as const,
              t: scene.start + 0.1,
              d: Math.min(1.1, Math.max(0.5, count.digits.length * 0.2)),
              v: count.n,
              prefix: count.prefix,
              suffix: count.suffix,
            },
          ]
        : []),
    ],
  };
}

/**
 * Which of "in" (a plain fade), "rise" (slide up) or "pop" (a gentle scale)
 * a scene ARRIVES with — deterministic from its own index, so the same plan
 * renders the same way on every run, and (since three options cycle) never
 * the same as the scene right before it. The same "vary deliberately" rule
 * the director itself is held to for which TEMPLATE it picks (director.ts),
 * applied here to how the template's own layer shows up.
 *
 * The exit is always a plain fade, never varied: a layer only has to get out
 * of the way, and reversing a slide or a scale on exit would double the
 * moving parts for a direction a viewer's eye has already left.
 */
const ENTRANCES: { k: "in" | "rise" | "pop"; v?: number }[] = [{ k: "in" }, { k: "rise", v: 40 }, { k: "pop", v: 0.94 }];

export function entranceFor(index: number): { k: "in" | "rise" | "pop"; v?: number } {
  return ENTRANCES[index % ENTRANCES.length];
}

/**
 * Render one scene.
 *
 * Book scenes (`book-page`, `book-crop`) have no layer of their own: they show
 * the real page card, which lives outside the scene stack because the page
 * column and its camera are continuous across the whole video. `build.ts`
 * drives the card's visibility and zoom from the scene list instead.
 */
export function renderScene(scene: Scene, rect: SceneRect, accent: string): RenderedScene | null {
  const i = scene.index;
  let body: RenderedScene | null;
  switch (scene.kind) {
    case "cinematic": body = scene.cine ? cinematic(scene, i) : null; break;
    case "kinetic-text": body = kineticText(scene, i, accent); break;
    case "quote": body = quote(scene, i); break;
    case "icon-concept": body = iconConcept(scene, i); break;
    case "comparison": body = comparison(scene, i); break;
    case "steps": body = steps(scene, i); break;
    case "timeline": body = timeline(scene, i); break;
    case "growth-curve": body = growthCurve(scene, i); break;
    case "stat": body = stat(scene, i); break;
    default: body = null;
  }
  if (!body) return null;

  // The layer's own transition. It fades out at its end, except the last
  // scene, which the CTA card covers anyway — handled by the caller clamping
  // times. Entrance duration matches SCENE_FADE exactly, the same window
  // `cardVisibility` (build.ts) crossfades the page card over — the shape of
  // the arrival varies, the timing it hands over on does not.
  const cine = scene.kind === "cinematic";
  // The opening hook owns frame zero: its layer RESTS visible (CSS, `sc-first`)
  // and has only the exit — the same shape the old hook card had.
  const first = cine && scene.cine?.hook === true;
  const entrance = cine ? { k: "in" as const, v: undefined } : entranceFor(i);
  const layerAnims: SceneAnim[] = [
    ...(first ? [] : [{ s: i, e: -1, k: entrance.k, t: scene.start, d: SCENE_FADE, v: entrance.v } as SceneAnim]),
    { s: i, e: -1, k: "out", t: Math.max(scene.start + SCENE_FADE + 0.01, scene.end - SCENE_FADE), d: SCENE_FADE },
  ];
  const r = cine ? FULL_FRAME : rect;

  return {
    markup: `<div class="sc${cine ? " sc-cine" : ""}${first ? " sc-first" : ""}" data-scene="${i}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">${body.markup}</div>`,
    anims: [...layerAnims, ...body.anims],
  };
}

/**
 * Proof that no element is ever tweened twice at once — the property the whole
 * seek-safety argument rests on, checked here in Node rather than trusted.
 * Returns the offending pairs, empty when the plan is safe.
 */
export function overlappingAnims(anims: SceneAnim[]): string[] {
  const byEl = new Map<string, SceneAnim[]>();
  for (const a of anims) {
    const key = `${a.s}:${a.e}`;
    if (!byEl.has(key)) byEl.set(key, []);
    byEl.get(key)!.push(a);
  }
  const bad: string[] = [];
  for (const [key, list] of byEl) {
    const sorted = [...list].sort((x, y) => x.t - y.t);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if (sorted[i].t < prev.t + prev.d - 1e-6) {
        bad.push(`${key}: ${prev.k}@${prev.t.toFixed(2)}+${prev.d} overlaps ${sorted[i].k}@${sorted[i].t.toFixed(2)}`);
      }
    }
  }
  return bad;
}

/**
 * The scene stack's CSS. Every colour is a palette role — a literal here would
 * look right in one theme and wrong in the other four, which
 * `tests/composition.test.mts` refuses outright.
 */
export function sceneCss(theme: BookTheme, rect: SceneRect): string {
  const p = theme.palette;
  const light = isLightPalette(p.backdropDeep);
  const ink = light ? p.ink : p.hookInk;
  const key = light ? p.accent : p.hookKey;
  return `
  /* --- scene stack (Phase 3C) ---------------------------------------------
     One layer per non-book scene, in the card's own rectangle. Layers rest
     INVISIBLE and so does everything inside them: the rest state has to match
     each tween's from-state, or a frame rendered before a tween starts differs
     from the same frame reached by seeking backwards. */
  .sc { position:absolute; opacity:0; visibility:hidden; pointer-events:none;
        display:flex; align-items:center; justify-content:center;
        font-family: Inter, system-ui, sans-serif; color:${p.hookInk}; }
  .sc > * { width:100%; }
  .sc [data-el] { opacity:0; visibility:hidden; }

  /* The content-aware glow: one element, one colour tween per scene, sitting
     over the theme's own backdrop so a theme keeps its character while the
     background still moves with the content. */
  .scene-glow { position:absolute; inset:0; pointer-events:none; opacity:0.55;
                background: radial-gradient(70% 44% at 50% 34%, ${p.bloomA} 0%, transparent 70%); }

  .sc-icon { color:${p.accent}; display:block; }

  /* kinetic text — the narration itself, word by word on the real audio */
  .sc-kinetic-wrap { display:flex; flex-direction:column; align-items:center; gap:28px; }
  .sc-kinetic { text-align:center; font-weight:800; line-height:1.18; letter-spacing:-0.5px;
                padding:0 18px; }
  .sc-word { display:inline-block; margin:0 0.16em 0.1em 0; }
  /* The optional accent icon (validate.ts). Quiet — its job is to let the eye
     place the concept a beat before the words do, not to compete with them. */
  .sc-kinetic-icon { opacity:0.85; }
  .sc-kinetic-icon .sc-icon { color:${p.accent}; }
  /* The optional Lottie accent (lottie.ts), Phase 4's first advanced-visual
     module — the SAME slot the Tabler icon above uses, never both at once.
     Exempted from the generic hidden rest state below: nothing here ever
     tweens this element's own opacity — the "lottie" anim kind only drives
     playback (goToAndStop), never autoAlpha — so its rest state IS its
     final state, and the reveal comes from the clip's own first keyframe
     (opacity 0, scale 0) instead.
     width/height are load-bearing, not decoration: unlike the Tabler <svg>
     above (which carries its own width/height attributes), lottie-web sizes
     the <svg> it injects from its CONTAINER's box — an unsized container
     renders it at 0×0, present in the DOM (a real element count) and
     completely invisible on screen. 110px matches the Tabler icon variant's
     own iconSvg(icon, 110) so the two accents read as the same size. */
  .sc [data-el].sc-lottie { opacity:0.85; visibility:visible; width:110px; height:110px; }
  /* An emphasised word (emphasis.ts): bigger and in the accent colour, the
     same "this is the loud one" treatment a stat's own number gets, so the
     same eye that reads a stat as important reads this word the same way.
     font-size, not transform:scale — its entrance is a "pop" (render.ts),
     and GSAP writes the WHOLE transform property when it tweens one, which
     would silently erase a scale set here the moment the tween starts. */
  .sc-word-emph { color:${p.accent}; font-size:1.18em; }

  /* quote — the book's own words */
  .sc-quote { text-align:center; padding:0 26px; }
  .sc-quote-mark { font-size:190px; line-height:0.6; color:${p.accent}; font-family:Georgia, serif; }
  .sc-quote-text { margin:34px 0 0; font-weight:600; line-height:1.3; font-family:Georgia, "Times New Roman", serif;
                   font-style:italic; }
  .sc-quote-ref { margin-top:34px; font-size:28px; font-weight:700; letter-spacing:3px;
                  text-transform:uppercase; color:${p.bylineInk}; }

  /* icon concept — one to three pictures with their labels */
  .sc-icons { display:flex; align-items:center; justify-content:center; gap:58px; }
  .sc-cell { display:flex; flex-direction:column; align-items:center; gap:26px; flex:1 1 0; }
  /* position:relative so the optional Three.js canvas (below) can sit exactly
     over the flat icon it may replace, rather than in normal flow beside it. */
  .sc-icon-well { position:relative; width:var(--sz); height:var(--sz); border-radius:40px;
                  display:flex; align-items:center; justify-content:center;
                  background:${p.cardFace}; box-shadow:0 30px 70px -28px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-cell-label { font-size:40px; font-weight:800; text-align:center; line-height:1.18; max-width:300px; }
  /* The optional Three.js accent (three-shapes.ts), Phase 4's second
     advanced-visual module. It sits OVER the flat Tabler icon already in the
     well, not beside it — CSS alone decides nothing here: the canvas starts
     at the generic hidden rest state every [data-el] gets (opacity:0), and
     ONLY the runtime script's own successful WebGL init ever makes it
     visible, once, at composition load — never a GSAP tween, and never
     conditional on the scene's own timing. A browser that cannot run it
     (no WebGL, the CDN failed) simply never flips that switch, and the icon
     underneath — already fully rendered, already positioned — is the whole
     of what shows. object-fit is irrelevant here (a canvas has no
     intrinsic-vs-box mismatch the way an img does): the internal buffer
     (THREE_SIZE, render.ts) and the CSS box both read as one square. */
  .sc [data-el].sc-three { position:absolute; inset:22%; width:56%; height:56%; }

  /* comparison — two sides */
  .sc-compare { display:flex; align-items:center; justify-content:center; gap:30px; }
  /* On paper, so its text is paper ink. The scene layer's own colour is the
     light ink that reads on the dark backdrop, and inheriting it here paints
     cream on cream — measured on a real render, the comparison panels came
     out blank. Every surface below that sits on cardFace sets its own ink. */
  .sc-side { flex:1 1 0; display:flex; flex-direction:column; align-items:center; gap:26px;
             padding:46px 22px; border-radius:34px; background:${p.cardFace};
             box-shadow:0 30px 70px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-side-label { font-size:44px; font-weight:800; text-align:center; line-height:1.18; color:${p.ink}; }
  .sc-vs { font-size:34px; font-weight:800; letter-spacing:2px; text-transform:uppercase;
           color:${p.accent}; flex:0 0 auto; }

  /* steps — an ordered short list */
  .sc-steps { position:relative; display:flex; flex-direction:column; gap:26px; padding:0 20px; }
  .sc-heading { font-size:34px; font-weight:800; letter-spacing:2px; text-transform:uppercase;
                color:${p.accent}; text-align:center; margin-bottom:8px; }
  .sc-step { display:flex; align-items:center; gap:30px; padding:30px 34px; border-radius:28px;
             background:${p.cardFace}; box-shadow:0 22px 54px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-step-n { flex:0 0 auto; width:76px; height:76px; border-radius:24px; background:${p.accent};
               color:${p.ctaFace}; font-size:40px; font-weight:800;
               display:flex; align-items:center; justify-content:center; }
  .sc-step-t { font-size:42px; font-weight:700; line-height:1.2; color:${p.ink}; }
  /* A diagram connector joining the step numbers, the same idea as the
     timeline's own axis (below) but scoped to this list. It only shows in the
     gaps between the opaque step cards, which reads as a line running behind
     the process rather than through it. */
  .sc-step-connector { position:absolute; left:92px; top:76px; bottom:76px; width:5px; border-radius:3px;
                        background:${p.accent}; opacity:0.5; transform:scaleY(0); transform-origin:top center; }

  /* timeline — points in order down the frame */
  .sc-timeline { position:relative; padding-left:86px; display:flex; flex-direction:column; gap:54px; }
  .sc-tl-axis { position:absolute; left:32px; top:12px; bottom:12px; width:5px; border-radius:3px;
                background:${p.accent}; transform:scaleY(0); transform-origin:top center; }
  .sc-tl-row { display:flex; align-items:center; gap:30px; }
  .sc-tl-dot { position:absolute; left:20px; width:29px; height:29px; border-radius:50%;
               background:${p.accent}; box-shadow:0 0 0 10px ${p.hookScrim}; }
  .sc-tl-label { font-size:44px; font-weight:700; line-height:1.2; }

  /* growth curve — a picture of compounding, never a plot of invented data */
  .sc-curve { display:flex; flex-direction:column; align-items:center; gap:36px; }
  .sc-curve-label { font-size:36px; font-weight:800; letter-spacing:2px; text-transform:uppercase;
                    color:${p.accent}; text-align:center; }
  .sc-curve-line { stroke:${p.accent}; stroke-width:12; }
  .sc-curve-head { fill:${p.accent}; }
  .sc-axis { stroke:${p.bylineInk}; stroke-width:3; opacity:0.5; }
  /* Quiet gridlines and the filled area under the line — a chart reads as a
     chart once it has these, not just a stroke on a blank field. Both static
     or revealed with a plain fade (see growthCurve), never their own draw:
     the LINE is the thing being drawn, everything else is its context. */
  .sc-grid { stroke:${p.bylineInk}; stroke-width:2; opacity:0.18; }
  .sc-curve-fill-top { stop-color:${p.accent}; stop-opacity:0.32; }
  .sc-curve-fill-bottom { stop-color:${p.accent}; stop-opacity:0; }

  /* stat — one number the page actually states */
  .sc-stat { text-align:center; }
  .sc-stat-value { font-weight:800; line-height:1; letter-spacing:-4px; color:${p.accent}; }
  /* The counted digits (render.ts's counted()) are a CHILD of .sc-stat-value,
     not the element the "pop" entrance itself scales — see the comment in
     stat(). Its visibility is entirely its parent's: unlike every other
     [data-el], count never touches opacity, so it must not rest hidden. */
  .sc [data-el].sc-stat-count { opacity:1; visibility:visible; }
  .sc-stat-rule { width:${Math.round(rect.w * 0.42)}px; height:8px; border-radius:4px; margin:40px auto 0;
                  background:${p.accent}; transform:scaleX(0); transform-origin:left center; }
  .sc-stat-label { margin-top:36px; font-size:46px; font-weight:700; line-height:1.24; }

  /* cinematic — one 3D hero with cinematic type, full frame (cine-runtime.js) */
  .sc.sc-cine { display:block; }
  .sc-cine > * { width:auto; }
  /* The opening hook rests visible: it owns frame zero, like the hook card did. */
  .sc.sc-first { opacity:1; visibility:visible; }
  .cine-canvas, .cine-bloom { position:absolute; left:0; top:0; width:${1080}px; height:${1920}px; }
  .cine-bloom { mix-blend-mode:${light ? "multiply" : "screen"}; }
  /* What shows when WebGL does not: a plain glow under the type, never a blank.
     The runtime hides it once the hero is drawing. */
  .cine-fallback { position:absolute; left:140px; top:640px; width:800px; height:800px; border-radius:50%;
                   background: radial-gradient(circle, ${alpha(p.accent, 0.4)} 0%, ${alpha(p.accent, 0.14)} 46%, transparent 70%);
                   box-shadow: inset 0 0 0 3px ${alpha(p.accent, 0.35)}, 0 0 0 80px ${alpha(p.accent, 0.06)}; }
  .cine-text { position:absolute; left:0; right:0; top:300px; text-align:center; padding:0 40px; font-family: Inter, system-ui, sans-serif; }
  .cine-lead { display:block; font-size:46px; font-weight:600; line-height:1.2; letter-spacing:1px;
               color:${ink}; margin-bottom:10px; ${light ? "" : `text-shadow:0 4px 26px ${alpha(p.backdropDeep, 0.8)};`} }
  .cine-key { font-weight:900; text-transform:uppercase; line-height:0.98; letter-spacing:-2px; color:${key};
              white-space:nowrap; ${light ? `text-shadow:0 10px 30px ${alpha(p.accent, 0.18)};` : `text-shadow:0 0 44px ${alpha(p.accent, 0.55)}, 0 6px 30px ${alpha(p.backdropDeep, 0.7)};`} }
  .cine-letter { display:inline-block; }
  .cine-space { display:inline-block; width:0.3em; }
  .cine-hook { position:absolute; left:64px; right:64px; top:292px; text-align:center; font-weight:800; line-height:1.14;
               letter-spacing:-0.5px; font-family: Inter, system-ui, sans-serif; color:${ink};
               ${light ? "" : `text-shadow:0 4px 32px ${alpha(p.backdropDeep, 0.85)};`} }
  .cine-hook .sc-word-emph { color:${key}; ${light ? "" : `text-shadow:0 0 36px ${alpha(p.accent, 0.5)};`} }
`;
}
