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
import { esc } from "../composition/escape";
import type { BookTheme } from "../composition/theme-contract";
import type { Scene, SceneIcon } from "./types";

/** Where scene content may be drawn: the same rectangle the page card occupies. */
export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One tween: kind `k`, on element `e` of scene `s`, at time `t` for `d` seconds. */
export interface SceneAnim {
  s: number;
  /** Element index within the scene; -1 is the scene layer itself. */
  e: number;
  k: "in" | "out" | "rise" | "pop" | "wipe" | "grow" | "draw";
  t: number;
  d: number;
  /** The from-value: pixels for `rise`, scale for `pop`, dash length for `draw`. */
  v?: number;
}

export interface RenderedScene {
  markup: string;
  anims: SceneAnim[];
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

function kineticText(scene: Scene, i: number): RenderedScene {
  const words = scene.words ?? [];
  const chars = words.reduce((n, w) => n + w.word.length + 1, 0);
  const size = fitSize(chars, 96, 46, 0.26);
  const markup = words
    .map((w, k) => `<span class="sc-word" data-el="${k}">${esc(w.word)}</span>`)
    .join(" ");
  // Each word arrives on the exact measured start of that word in the audio.
  const anims: SceneAnim[] = words.map((w, k) => ({ s: i, e: k, k: "rise", t: w.start, d: 0.26, v: 18 }));
  return {
    markup: `<div class="sc-kinetic" style="font-size:${size}px">${markup}</div>`,
    anims,
  };
}

function quote(scene: Scene, i: number): RenderedScene {
  const text = scene.quote?.text ?? "";
  const size = fitSize(text.length, 74, 38, 0.13);
  const times = stagger(2, scene.start, scene.end - scene.start);
  return {
    markup: `<div class="sc-quote">
      <div class="sc-quote-mark" data-el="0">&ldquo;</div>
      <blockquote class="sc-quote-text" data-el="1" style="font-size:${size}px">${esc(text)}</blockquote>
      <div class="sc-quote-ref" data-el="2">page ${(scene.quote?.page ?? 0) + 1}</div>
    </div>`,
    anims: [
      { s: i, e: 0, k: "pop", t: times[0], d: ENTER, v: 0.7 },
      { s: i, e: 1, k: "rise", t: times[0] + 0.12, d: ENTER, v: 26 },
      { s: i, e: 2, k: "in", t: times[1] + 0.2, d: ENTER },
    ],
  };
}

function iconConcept(scene: Scene, i: number): RenderedScene {
  const icons = scene.icons ?? [];
  const labels = scene.items ?? [];
  const size = icons.length === 1 ? 300 : icons.length === 2 ? 220 : 170;
  const times = stagger(icons.length, scene.start, scene.end - scene.start);
  const cells = icons
    .map(
      (icon, k) => `<div class="sc-cell" data-el="${k}">
        <div class="sc-icon-well" style="--sz:${size}px">${iconSvg(icon, Math.round(size * 0.56))}</div>
        ${labels[k] ? `<div class="sc-cell-label">${esc(labels[k])}</div>` : ""}
      </div>`,
    )
    .join("");
  return {
    markup: `<div class="sc-icons sc-cols-${icons.length}">${cells}</div>`,
    anims: icons.map((_, k) => ({ s: i, e: k, k: "pop" as const, t: times[k], d: ENTER, v: 0.62 })),
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
  return {
    markup: `<div class="sc-steps">${scene.concept ? `<div class="sc-heading" data-el="${items.length}">${esc(scene.concept)}</div>` : ""}${rows}</div>`,
    anims: [
      ...items.map((_, k) => ({ s: i, e: k, k: "rise" as const, t: times[k], d: ENTER, v: 30 })),
      ...(scene.concept ? [{ s: i, e: items.length, k: "in" as const, t: scene.start, d: 0.36 }] : []),
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
  return {
    markup: `<div class="sc-curve">
      ${scene.curve?.label ? `<div class="sc-curve-label" data-el="2">${esc(scene.curve.label)}</div>` : ""}
      <svg viewBox="0 0 ${CURVE.w} ${CURVE.h}" width="${CURVE.w}" height="${CURVE.h}" fill="none" aria-hidden="true">
        <line class="sc-axis" x1="0" y1="${CURVE.h}" x2="${CURVE.w}" y2="${CURVE.h}" />
        <polyline class="sc-curve-line" data-el="0" points="${coords.join(" ")}"
                  stroke-linecap="round" stroke-linejoin="round"
                  style="stroke-dasharray:${dash};stroke-dashoffset:${dash}" />
        <circle class="sc-curve-head" data-el="1" cx="${CURVE.w}" cy="${(CURVE.h - (pts[pts.length - 1] / max) * CURVE.h).toFixed(1)}" r="12" />
      </svg>
    </div>`,
    anims: [
      { s: i, e: 0, k: "draw", t: scene.start + 0.15, d: Math.min(1.8, (scene.end - scene.start) * 0.6), v: dash },
      { s: i, e: 1, k: "pop", t: scene.start + Math.min(1.95, (scene.end - scene.start) * 0.6), d: 0.4, v: 0.2 },
      ...(scene.curve?.label ? [{ s: i, e: 2, k: "in" as const, t: scene.start, d: 0.4 }] : []),
    ],
  };
}

function stat(scene: Scene, i: number): RenderedScene {
  const value = scene.stat?.value ?? "";
  const label = scene.stat?.label ?? "";
  const size = fitSize(value.length, 300, 120, 14);
  return {
    markup: `<div class="sc-stat">
      <div class="sc-stat-value" data-el="0" style="font-size:${size}px">${esc(value)}</div>
      ${label ? `<div class="sc-stat-label" data-el="1">${esc(label)}</div>` : ""}
      <div class="sc-stat-rule" data-el="2"></div>
    </div>`,
    anims: [
      { s: i, e: 0, k: "pop", t: scene.start, d: 0.52, v: 0.66 },
      { s: i, e: 2, k: "wipe", t: scene.start + 0.3, d: 0.5 },
      ...(label ? [{ s: i, e: 1, k: "rise" as const, t: scene.start + 0.42, d: ENTER, v: 22 }] : []),
    ],
  };
}

/**
 * Render one scene.
 *
 * Book scenes (`book-page`, `book-crop`) have no layer of their own: they show
 * the real page card, which lives outside the scene stack because the page
 * column and its camera are continuous across the whole video. `build.ts`
 * drives the card's visibility and zoom from the scene list instead.
 */
export function renderScene(scene: Scene, rect: SceneRect): RenderedScene | null {
  const i = scene.index;
  let body: RenderedScene | null;
  switch (scene.kind) {
    case "kinetic-text": body = kineticText(scene, i); break;
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

  // The layer's own dissolve. It fades out at its end, except the last scene,
  // which the CTA card covers anyway — handled by the caller clamping times.
  const layerAnims: SceneAnim[] = [
    { s: i, e: -1, k: "in", t: scene.start, d: SCENE_FADE },
    { s: i, e: -1, k: "out", t: Math.max(scene.start + SCENE_FADE + 0.01, scene.end - SCENE_FADE), d: SCENE_FADE },
  ];

  return {
    markup: `<div class="sc" data-scene="${i}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px">${body.markup}</div>`,
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
  .sc-kinetic { text-align:center; font-weight:800; line-height:1.18; letter-spacing:-0.5px;
                padding:0 18px; }
  .sc-word { display:inline-block; margin:0 0.16em 0.1em 0; }

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
  .sc-icon-well { width:var(--sz); height:var(--sz); border-radius:40px;
                  display:flex; align-items:center; justify-content:center;
                  background:${p.cardFace}; box-shadow:0 30px 70px -28px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-cell-label { font-size:40px; font-weight:800; text-align:center; line-height:1.18; max-width:300px; }

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
  .sc-steps { display:flex; flex-direction:column; gap:26px; padding:0 20px; }
  .sc-heading { font-size:34px; font-weight:800; letter-spacing:2px; text-transform:uppercase;
                color:${p.accent}; text-align:center; margin-bottom:8px; }
  .sc-step { display:flex; align-items:center; gap:30px; padding:30px 34px; border-radius:28px;
             background:${p.cardFace}; box-shadow:0 22px 54px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-step-n { flex:0 0 auto; width:76px; height:76px; border-radius:24px; background:${p.accent};
               color:${p.ctaFace}; font-size:40px; font-weight:800;
               display:flex; align-items:center; justify-content:center; }
  .sc-step-t { font-size:42px; font-weight:700; line-height:1.2; color:${p.ink}; }

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

  /* stat — one number the page actually states */
  .sc-stat { text-align:center; }
  .sc-stat-value { font-weight:800; line-height:1; letter-spacing:-4px; color:${p.accent}; }
  .sc-stat-rule { width:${Math.round(rect.w * 0.42)}px; height:8px; border-radius:4px; margin:40px auto 0;
                  background:${p.accent}; transform:scaleX(0); transform-origin:left center; }
  .sc-stat-label { margin-top:36px; font-size:46px; font-weight:700; line-height:1.24; }
`;
}
