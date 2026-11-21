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
import type { CinePlateSpec, Scene, SceneIcon } from "./types";
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
  k:
    | "in"
    | "out"
    | "rise"
    | "reveal"
    | "slide-x"
    | "scale-soft"
    | "pop"
    | "wipe"
    | "grow"
    | "draw"
    | "count"
    | "lottie"
    | "three"
    | "focus"
    | "cine"
    | "drift";
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
  /** `cine` only: optional generated 9:16 visual plate + depth map for 2.5D parallax or local video. */
  plate?: CinePlateSpec;
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

const SYNC_STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "he", "her", "his", "i", "in", "into", "is", "it", "its", "of", "on", "or", "she", "so",
  "that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "what", "when",
  "which", "who", "will", "with", "you", "your", "not", "can", "do", "does", "our", "than",
]);

const SPOKEN_DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13",
  fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
  seventy: "70", eighty: "80", ninety: "90", hundred: "100", thousand: "1000", million: "1000000",
  half: "50", double: "2", twice: "2",
};

function stemToken(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, "");
}

/**
 * Exact spoken timestamp of a statistic's digits in `scene.words`, or `null` when
 * the words slice does not utter those digits (leaving deterministic scene-start
 * timing intact for synthetic fixtures).
 */
function spokenNumberTime(
  digits: string,
  words: { word: string; start: number }[] | undefined,
  sceneStart: number,
  sceneEnd: number,
): number | null {
  if (!digits || !words || words.length === 0) return null;
  for (const w of words) {
    const rawDigits = w.word.replace(/[^\d]/g, "");
    const norm = normalizeToken(w.word);
    if ((rawDigits && rawDigits === digits) || (norm && SPOKEN_DIGIT_WORDS[norm] === digits)) {
      const latest = Math.max(sceneStart + 0.1, sceneEnd - 0.85);
      return Math.max(sceneStart + 0.05, Math.min(latest, w.start));
    }
  }
  return null;
}

/**
 * Synchronize each item/phrase of a motion-graphics template to the exact instant
 * its first content word is spoken in `scene.words`, advancing monotonically and
 * falling back cleanly to `stagger(...)` whenever a phrase is not lexically matched.
 */
function syncPhrasesToWords(
  phrases: string[],
  words: { word: string; start: number }[] | undefined,
  start: number,
  dur: number,
): number[] {
  const n = phrases.length;
  if (n <= 0) return [];
  const base = stagger(n, start, dur);
  if (!words || words.length === 0) return base;

  const spoken = words.map((w) => ({
    norm: normalizeToken(w.word),
    stem: stemToken(normalizeToken(w.word)),
    start: w.start,
  }));
  const minT = start;
  const maxT = Math.max(start + 0.25, start + dur - 0.6);

  let cursor = 0;
  let matchedAny = false;
  const rawTimes: (number | null)[] = phrases.map((phrase) => {
    const content = phrase
      .split(/\s+/)
      .map(normalizeToken)
      .filter((t) => t.length > 2 && !SYNC_STOP.has(t));
    if (content.length === 0) return null;
    for (let wi = cursor; wi < spoken.length; wi++) {
      const sw = spoken[wi];
      if (!sw.norm) continue;
      if (content.some((ct) => sw.norm === ct || (ct.length >= 4 && sw.stem === stemToken(ct)))) {
        cursor = wi + 1;
        matchedAny = true;
        return Math.max(minT, Math.min(maxT, sw.start));
      }
    }
    return null;
  });

  if (!matchedAny) return base;

  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const candidate = rawTimes[k] ?? (k === 0 ? base[0] : out[k - 1] + 0.28);
    const prev = k > 0 ? out[k - 1] + 0.14 : minT;
    out.push(Math.min(maxT, Math.max(prev, candidate)));
  }
  return out;
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
  const size = fitSize(chars, 88, 44, 0.26);
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
    iconMarkup = `<div class="sc-kinetic-icon" data-el="${iconEl}">${iconSvg(scene.icon, 104)}</div>`;
    anims.push({ s: i, e: iconEl, k: "in", t: scene.start, d: 0.4 });
  } else {
    const firstHit = emphasis.find((h) => h);
    const clip = firstHit ? lottieFor(firstHit.category, accent) : null;
    if (clip) {
      iconMarkup = `<div class="sc-kinetic-icon sc-lottie" data-el="${iconEl}"></div>`;
      anims.push({ s: i, e: iconEl, k: "lottie", t: scene.start, d: LOTTIE_DURATION_S, data: clip });
    }
  }
  const ruleEl = words.length + 1;
  const hasRule = words.length >= 4;
  const ruleMarkup = hasRule ? `<div class="sc-kinetic-rule" data-el="${ruleEl}"></div>` : "";
  if (hasRule) {
    anims.push({ s: i, e: ruleEl, k: "wipe", t: scene.start + 0.04, d: 0.44 });
  }
  // A slow push-in over the whole scene: type on a plain page is never a still.
  anims.push({ s: i, e: DRIFT_EL, k: "drift", t: scene.start, d: Math.max(1, scene.end - scene.start), v: DRIFT_SCALE });
  return {
    markup: `<div class="sc-kinetic-wrap" data-drift>${iconMarkup}${ruleMarkup}<div class="sc-kinetic" style="font-size:${size}px">${markup}</div></div>`,
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
    const size = fitSize(chars, 76, 46, 0.26);
    const spans = words
      .map((w, k) => {
        const emph = accent.has(normalizeToken(w.word)) || Boolean(emphasis[k]);
        return `<span class="sc-word${emph ? " sc-word-emph" : ""}" data-el="${2 + k}">${esc(w.word)}</span>`;
      })
      .join(" ");
    words.forEach((w, k) => {
      const emph = accent.has(normalizeToken(w.word)) || Boolean(emphasis[k]);
      anims.push(emph ? { s: i, e: 2 + k, k: "pop", t: w.start, d: 0.32, v: 0.52 } : { s: i, e: 2 + k, k: "rise", t: w.start, d: 0.24, v: 20 });
    });
    text = `<div class="cine-hook" style="font-size:${size}px">${spans}</div>`;
  } else {
    const key = cine.keyword.trim();
    const letters = Array.from(key);
    const keyTokens = key.split(/\s+/).map(normalizeToken);
    const at = words.findIndex((w) => normalizeToken(w.word) === keyTokens[0]);
    const earliest = scene.start + 0.16;
    const latest = Math.max(earliest, scene.end - 1.15);
    const keyStart = Math.min(latest, Math.max(earliest, at >= 0 ? words[at].start : scene.start + 0.6));
    const lead = cine.lead.trim();
    const callout = (cine.plate?.callout ?? "").trim();
    let calloutMarkup = "";
    let leadMarkup = "";
    let n = 2;
    if (callout) {
      const calloutEl = n++;
      calloutMarkup = `<div class="cine-callout" data-el="${calloutEl}">${esc(callout)}</div>`;
      anims.push({ s: i, e: calloutEl, k: "reveal", t: earliest, d: 0.4, v: 14 });
    }
    if (lead && !cine.plate) {
      const first = normalizeToken(lead.split(/\s+/)[0] ?? "");
      const li = words.findIndex((w) => normalizeToken(w.word) === first);
      const leadStart = Math.min(keyStart, Math.max(earliest, li >= 0 ? words[li].start : scene.start + 0.22));
      leadMarkup = `<div class="cine-lead" data-el="${n}">${esc(lead)}</div>`;
      anims.push({ s: i, e: n, k: "focus", t: leadStart, d: 0.44, v: 16 });
      n += 1;
    }
    const size = Math.max(54, Math.min(136, Math.round(650 / (Math.max(5, letters.length) * 0.76))));
    let step = 0;
    const spans = letters
      .map((ch) => {
        if (ch === " ") return `<span class="cine-space"> </span>`;
        const el = n++;
        anims.push({ s: i, e: el, k: "focus", t: keyStart + step * 0.032, d: 0.42, v: 22 });
        step += 1;
        return `<span class="cine-letter" data-el="${el}">${esc(ch)}</span>`;
      })
      .join("");
    text = `<div class="cine-text">${calloutMarkup}${leadMarkup}<div class="cine-key" style="font-size:${size}px">${spans}</div></div>`;
  }

  anims.push({
    s: i,
    e: 0,
    k: "cine",
    t: scene.start,
    d: Math.max(0.5, scene.end - scene.start),
    hero: cine.hero,
    bloom: 1,
    ...(cine.hook ? { hook: true } : {}),
    ...(cine.plate ? { plate: cine.plate } : {}),
  });
  const behind = TEXT_BEHIND.has(cine.hero) && !cine.hook && !cine.plate;
  const plateMarkup = cine.plate
    ? `<img class="cine-plate-src" data-plate-img="1" decoding="sync" loading="eager" src="${esc(cine.plate.imageSrc)}" alt="" />` +
      `<img class="cine-plate-src" data-plate-depth="1" decoding="sync" loading="eager" src="${esc(cine.plate.depthSrc)}" alt="" />` +
      (cine.plate.videoSrc
        ? `<video class="cine-video" data-plate-video="1" src="${esc(cine.plate.videoSrc)}" muted playsinline preload="auto" data-start="${scene.start.toFixed(3)}" data-duration="${Math.max(0.5, scene.end - scene.start + SCENE_FADE).toFixed(3)}" data-track-index="${3 + (i % 4)}"></video>`
        : "")
    : "";
  const scrimMarkup = cine.plate ? `<div class="cine-plate-scrim"></div>` : "";
  const canvases = `<canvas class="cine-canvas" data-el="0" width="${CINE_BUFFER.w}" height="${CINE_BUFFER.h}"></canvas><canvas class="cine-bloom" data-el="1" width="${CINE_BLOOM.w}" height="${CINE_BLOOM.h}"></canvas>`;
  return {
    markup: `<div class="cine-fallback"></div>${plateMarkup}${behind ? text : ""}${canvases}${scrimMarkup}${behind ? "" : text}`,
    anims,
  };
}

function quote(scene: Scene, i: number): RenderedScene {
  const text = scene.quote?.text ?? "";
  const size = fitSize(text.length, 74, 38, 0.13);
  const times = stagger(2, scene.start, scene.end - scene.start);
  return {
    // No page-number label. It read on screen as "PAGE 17" beside the quotation — a piece of
    // apparatus the viewer did not ask for, competing with the book's own words for the one
    // thing this scene exists to show. The page a quote came from is still recorded on the
    // scene (`scene.quote.page`) and still checked by the grounding tests; it is simply not
    // painted. `times` keeps its two stops so the quote mark and the line still stagger.
    markup: `<div class="sc-quote" data-drift>
      <div class="sc-quote-mark" data-el="0">&ldquo;</div>
      <blockquote class="sc-quote-text" data-el="1" style="font-size:${size}px">${esc(text)}</blockquote>
    </div>`,
    anims: [
      { s: i, e: 0, k: "pop", t: times[0], d: ENTER, v: 0.7 },
      { s: i, e: 1, k: "rise", t: times[0] + 0.12, d: ENTER, v: 26 },
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
  const size = icons.length === 1 ? 268 : icons.length === 2 ? 204 : 162;
  const maxLabelLen = Math.max(8, ...labels.map((l) => l.length));
  const labelSize = fitSize(maxLabelLen, 36, 24, 0.34);
  const syncPhrases = labels.length === icons.length ? labels : icons.map((ic) => ic.query);
  const times = syncPhrasesToWords(syncPhrases, scene.words, scene.start, scene.end - scene.start);
  const threeEl = (k: number) => icons.length + k;
  const shapes = icons.map((icon) => shapeForIcon(icon));
  const cells = icons
    .map(
      (icon, k) => `<div class="sc-cell" data-el="${k}">
        <div class="sc-icon-well" style="--sz:${size}px">
          ${iconSvg(icon, Math.round(size * 0.54))}
          ${shapes[k] ? `<canvas class="sc-three" data-el="${threeEl(k)}" width="${THREE_SIZE}" height="${THREE_SIZE}"></canvas>` : ""}
        </div>
        ${labels[k] ? `<div class="sc-cell-label" style="font-size:${labelSize}px">${esc(labels[k])}</div>` : ""}
      </div>`,
    )
    .join("");
  const anims: SceneAnim[] = icons.map((_, k) => ({ s: i, e: k, k: "pop" as const, t: times[k], d: ENTER, v: 0.68 }));
  icons.forEach((_icon, k) => {
    const shape = shapes[k];
    if (!shape) return;
    const start = times[k];
    const dur = Math.max(0.5, scene.end - start);
    anims.push({ s: i, e: threeEl(k), k: "three", t: start, d: dur, shape });
  });
  const railEl = icons.length * 2;
  const railMarkup =
    icons.length > 1
      ? `<div class="sc-icons-rail" data-el="${railEl}" style="top:${Math.round(size * 0.5)}px"></div>`
      : "";
  if (icons.length > 1) {
    anims.push({ s: i, e: railEl, k: "wipe", t: Math.max(scene.start, times[0] + 0.08), d: Math.min(0.65, Math.max(0.3, times[times.length - 1] - times[0] + 0.25)) });
  }
  return {
    markup: `<div class="sc-icons-wrap">${railMarkup}<div class="sc-icons sc-cols-${icons.length}">${cells}</div></div>`,
    anims,
  };
}

function comparison(scene: Scene, i: number): RenderedScene {
  const icons = scene.icons ?? [];
  const left = scene.left ?? "";
  const right = scene.right ?? "";
  const dur = Math.max(0.6, scene.end - scene.start);
  const sideTimes = syncPhrasesToWords([left, right], scene.words, scene.start + 0.06, dur);
  const leftT = Math.min(scene.start + 0.35, sideTimes[0] ?? scene.start + 0.06);
  const rightT = Math.min(leftT + 0.44, Math.max(leftT + 0.22, sideTimes[1] ?? leftT + 0.32));
  const vsT = leftT + (rightT - leftT) * 0.5;
  const labelSize = fitSize(Math.max(left.length, right.length), 38, 25, 0.36);

  const side = (label: string, icon: SceneIcon | undefined, el: number, variant: "a" | "b") =>
    `<div class="sc-side sc-side-${variant}" data-el="${el}">
      <div class="sc-side-bar sc-side-bar-${variant}"></div>
      ${icon ? `<div class="sc-side-icon">${iconSvg(icon, 108)}</div>` : ""}
      <div class="sc-side-label" style="font-size:${labelSize}px">${esc(label)}</div>
    </div>`;
  return {
    markup: `<div class="sc-compare">
      ${side(left, icons[0], 0, "a")}
      <div class="sc-vs-badge" data-el="1"><span class="sc-vs">vs</span></div>
      ${side(right, icons[1], 2, "b")}
    </div>`,
    anims: [
      { s: i, e: 0, k: "slide-x", t: leftT, d: ENTER, v: -28 },
      { s: i, e: 1, k: "pop", t: vsT, d: 0.36, v: 0.58 },
      { s: i, e: 2, k: "slide-x", t: rightT, d: ENTER, v: 28 },
    ],
  };
}

function steps(scene: Scene, i: number): RenderedScene {
  const items = scene.steps ?? [];
  const dur = Math.max(0.6, scene.end - scene.start);
  const times = syncPhrasesToWords(items, scene.words, scene.start + 0.08, dur);
  const maxLen = Math.max(10, ...items.map((s) => s.length));
  const textSize = fitSize(maxLen, 38, 26, 0.26);
  const headingText = (scene.concept ?? "")
    .replace(/\s+\b(?:icons?|pictures?|visuals?|illustrations?|graphics?|cards?|diagrams?|scenes?)\s*$/i, "")
    .trim();
  const headingSize = fitSize(headingText.length, 30, 22, 0.2);
  const chevronSvg = `<svg class="sc-step-chevron" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
  const rows = items
    .map(
      (s, k) => `<div class="sc-step" data-el="${k}">
        <div class="sc-step-n">${k + 1}</div>
        <div class="sc-step-t" style="font-size:${textSize}px">${esc(s)}</div>
        ${k + 1 < items.length ? chevronSvg : ""}
      </div>`,
    )
    .join("");
  const headingEl = items.length;
  const connectorEl = items.length + 1;
  const connector = items.length > 1 ? `<div class="sc-step-connector" data-el="${connectorEl}"></div>` : "";
  const connectorDur =
    items.length > 1
      ? Math.max(0.45, Math.min(1.4, (times[times.length - 1] ?? scene.start + 0.6) - scene.start + 0.25))
      : 0.5;
  return {
    markup: `<div class="sc-steps">${headingText ? `<div class="sc-heading" data-el="${headingEl}" style="font-size:${headingSize}px">${esc(headingText)}</div>` : ""}<div class="sc-steps-track">${connector}${rows}</div></div>`,
    anims: [
      ...items.map((_, k) => ({ s: i, e: k, k: "reveal" as const, t: times[k], d: 0.46, v: 24 })),
      ...(headingText ? [{ s: i, e: headingEl, k: "reveal" as const, t: scene.start, d: 0.36, v: 14 }] : []),
      ...(items.length > 1
        ? [{ s: i, e: connectorEl, k: "grow" as const, t: Math.max(scene.start, times[0] - 0.04), d: connectorDur }]
        : []),
    ],
  };
}

function timeline(scene: Scene, i: number): RenderedScene {
  const items = scene.steps ?? [];
  const dur = Math.max(0.6, scene.end - scene.start);
  const times = syncPhrasesToWords(items, scene.words, scene.start + 0.16, dur);
  const maxLen = Math.max(10, ...items.map((s) => s.length));
  const labelSize = fitSize(maxLen, 38, 26, 0.28);
  const rows = items
    .map(
      (s, k) => `<div class="sc-tl-row" data-el="${k}">
        <div class="sc-tl-dot"></div>
        <div class="sc-tl-card">
          <div class="sc-tl-step-chip" aria-hidden="true">0${k + 1}</div>
          <div class="sc-tl-label" style="font-size:${labelSize}px">${esc(s)}</div>
        </div>
      </div>`,
    )
    .join("");
  const axisEl = items.length;
  const axisDur = Math.max(0.5, Math.min(1.4, (times[times.length - 1] ?? scene.start + 0.7) - scene.start + 0.25));
  return {
    markup: `<div class="sc-timeline">
      <div class="sc-tl-axis" data-el="${axisEl}"></div>
      ${rows}
    </div>`,
    anims: [
      { s: i, e: axisEl, k: "grow", t: scene.start, d: axisDur },
      ...items.map((_, k) => ({ s: i, e: k, k: "slide-x" as const, t: times[k], d: 0.44, v: 24 })),
    ],
  };
}

/** The curve's box inside the scene, and the path length used for the draw. */
const CURVE = { w: 660, h: 320 };

function smoothCurvePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let k = 0; k < points.length - 1; k++) {
    const p0 = points[Math.max(0, k - 1)];
    const p1 = points[k];
    const p2 = points[k + 1];
    const p3 = points[Math.min(points.length - 1, k + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.max(0, Math.min(CURVE.h, p1.y + (p2.y - p0.y) / 6));
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.max(0, Math.min(CURVE.h, p2.y - (p3.y - p1.y) / 6));
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function growthCurve(scene: Scene, i: number): RenderedScene {
  const pts = scene.curve?.points ?? [];
  const max = Math.max(1, ...pts);
  const xy = pts.map((v, k) => ({
    x: (CURVE.w * k) / Math.max(1, pts.length - 1),
    y: CURVE.h - (v / max) * (CURVE.h - 18) - 6,
  }));
  const linePath = smoothCurvePath(xy);
  const areaPath = xy.length
    ? `${linePath} L ${CURVE.w.toFixed(1)} ${CURVE.h.toFixed(1)} L 0 ${CURVE.h.toFixed(1)} Z`
    : "";
  const dash = Math.round(CURVE.w + CURVE.h * 2.2);
  const dur = Math.max(0.8, scene.end - scene.start);
  const label = (scene.curve?.label ?? "").trim();
  const syncedLabel = label ? syncPhrasesToWords([label], scene.words, scene.start, dur)[0] : scene.start;
  const drawStart = Math.max(scene.start + 0.12, Math.min(scene.start + 0.45, syncedLabel));
  const drawDur = Math.min(1.85, Math.max(0.65, dur * 0.56));
  const drawEnd = Math.min(Math.max(drawStart + 0.4, scene.end - 0.35), drawStart + drawDur);
  const labelSize = fitSize(label.length, 32, 22, 0.24);

  const hGrid = [0.25, 0.5, 0.75]
    .map((f) => `<line class="sc-grid" x1="0" y1="${(CURVE.h * f).toFixed(1)}" x2="${CURVE.w}" y2="${(CURVE.h * f).toFixed(1)}" stroke-dasharray="6 8" />`)
    .join("");
  const vGrid = [0.25, 0.5, 0.75]
    .map((f) => `<line class="sc-grid" x1="${(CURVE.w * f).toFixed(1)}" y1="0" x2="${(CURVE.w * f).toFixed(1)}" y2="${CURVE.h}" stroke-dasharray="6 8" />`)
    .join("");

  const midNodes: { markup: string; anim: SceneAnim }[] = [];
  for (let k = 1; k < xy.length - 1; k++) {
    if (xy.length > 5 && k % 2 !== 0) continue;
    const elIdx = 4 + midNodes.length;
    const frac = k / Math.max(1, xy.length - 1);
    const nodeT = drawStart + (drawEnd - drawStart) * frac;
    midNodes.push({
      markup: `<circle class="sc-curve-node" data-el="${elIdx}" cx="${xy[k].x.toFixed(1)}" cy="${xy[k].y.toFixed(1)}" r="7.5" />`,
      anim: { s: i, e: elIdx, k: "pop", t: nodeT, d: 0.3, v: 0.3 },
    });
  }
  const head = xy[xy.length - 1] ?? { x: CURVE.w, y: 0 };

  return {
    markup: `<div class="sc-curve">
      ${label ? `<div class="sc-curve-label" data-el="2" style="font-size:${labelSize}px">${esc(label)}</div>` : ""}
      <svg class="sc-curve-svg" viewBox="-16 -18 ${CURVE.w + 32} ${CURVE.h + 34}" width="${CURVE.w + 32}" height="${CURVE.h + 34}" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="sc-curve-fill-${i}" x1="0" y1="0" x2="0" y2="1">
            <stop class="sc-curve-fill-top" offset="0%" />
            <stop class="sc-curve-fill-bottom" offset="100%" />
          </linearGradient>
        </defs>
        ${hGrid}
        ${vGrid}
        <line class="sc-axis" x1="0" y1="0" x2="0" y2="${CURVE.h}" />
        <line class="sc-axis" x1="0" y1="${CURVE.h}" x2="${CURVE.w}" y2="${CURVE.h}" />
        <path class="sc-curve-fill" data-el="3" fill="url(#sc-curve-fill-${i})" d="${areaPath}" />
        <path class="sc-curve-line" data-el="0" d="${linePath}"
              stroke-linecap="round" stroke-linejoin="round"
              style="stroke-dasharray:${dash};stroke-dashoffset:${dash}" />
        ${midNodes.map((n) => n.markup).join("")}
        <circle class="sc-curve-head" data-el="1" cx="${head.x.toFixed(1)}" cy="${head.y.toFixed(1)}" r="12" />
      </svg>
    </div>`,
    anims: [
      { s: i, e: 0, k: "draw", t: drawStart, d: Math.max(0.2, drawEnd - drawStart), v: dash },
      { s: i, e: 1, k: "pop", t: drawEnd, d: 0.38, v: 0.25 },
      { s: i, e: 3, k: "in", t: Math.max(drawStart + 0.2, drawEnd), d: 0.55 },
      ...midNodes.map((n) => n.anim),
      ...(label ? [{ s: i, e: 2, k: "reveal" as const, t: scene.start, d: 0.4, v: 14 }] : []),
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
  const size = fitSize(value.length, 240, 112, 12);
  const labelSize = fitSize(label.length, 42, 28, 0.34);
  const count = counted(value);
  const rawDigits = count ? count.digits.replace(/,/g, "") : value.replace(/[^\d]/g, "");
  const spokenT = spokenNumberTime(rawDigits, scene.words, scene.start, scene.end);
  const countStart = spokenT !== null ? spokenT : scene.start + 0.1;
  const valueStart = spokenT !== null ? Math.max(scene.start, spokenT - 0.16) : scene.start;
  const ruleStart = Math.min(Math.max(scene.start + 0.2, scene.end - 0.6), valueStart + 0.24);
  const labelStart =
    label && spokenT !== null
      ? Math.min(Math.max(scene.start + 0.3, scene.end - 0.55), countStart + 0.28)
      : scene.start + 0.42;

  const fillShare =
    count && count.suffix === "%" && count.n > 0 && count.n <= 100
      ? Math.max(12, Math.min(100, count.n))
      : 100;

  const valueMarkup = count
    ? `<span class="sc-stat-count" data-el="3">${esc(count.prefix)}0${esc(count.suffix)}</span>`
    : esc(value);
  return {
    markup: `<div class="sc-stat">
      <div class="sc-stat-card">
        <div class="sc-stat-value" data-el="0" style="font-size:${size}px">${valueMarkup}</div>
        <div class="sc-stat-track"><div class="sc-stat-rule" data-el="2" style="width:${fillShare}%"></div></div>
        ${label ? `<div class="sc-stat-label" data-el="1" style="font-size:${labelSize}px">${esc(label)}</div>` : ""}
      </div>
    </div>`,
    anims: [
      { s: i, e: 0, k: "pop", t: valueStart, d: 0.48, v: 0.72 },
      { s: i, e: 2, k: "wipe", t: ruleStart, d: 0.52 },
      ...(label ? [{ s: i, e: 1, k: "reveal" as const, t: labelStart, d: 0.46, v: 20 }] : []),
      ...(count
        ? [
            {
              s: i,
              e: 3,
              k: "count" as const,
              t: countStart,
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

function transitionEntrance(
  scene: Scene,
  index: number,
): { k: "in" | "rise" | "pop" | "reveal" | "slide-x" | "scale-soft"; v?: number } {
  switch (scene.transitionIn) {
    case "dissolve":
      return { k: "in" };
    case "depth-push":
      return { k: "scale-soft", v: 0.94 };
    case "pan-slide":
      return { k: "slide-x", v: index % 2 === 0 ? 28 : -28 };
    case "rise-wipe":
      return { k: "reveal", v: 34 };
    default:
      return entranceFor(index);
  }
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
  const entrance = cine ? { k: "in" as const, v: undefined } : transitionEntrance(scene, i);
  const layerAnims: SceneAnim[] = [
    ...(first ? [] : [{ s: i, e: -1, k: entrance.k, t: scene.start, d: SCENE_FADE, v: entrance.v } as SceneAnim]),
    // The exit begins where the scene ENDS, not SCENE_FADE before it, so that it
    // overlaps the next layer's entrance instead of finishing just as that
    // entrance starts. Measured on the fixture before this change: the outgoing
    // layer reached zero at exactly the instant the incoming one began, so 2 of
    // 11 boundaries showed a frame with no scene and no page card on it at all —
    // a blink of bare backdrop between two scenes. Book boundaries never showed
    // it because the page card carries those (it is already at 0.50 mid-
    // transition); this makes the scene layers behave the way the card already
    // does. The `max` keeps the exit from overlapping this layer's OWN entrance
    // on a very short scene, which would put two tweens on one element's opacity
    // at once and break the seek-safety rule the whole composition is built on.
    { s: i, e: -1, k: "out", t: Math.max(scene.start + SCENE_FADE + 0.01, scene.end), d: SCENE_FADE },
  ];
  const r = cine ? FULL_FRAME : rect;
  const bgPlateMarkup =
    !cine && scene.bgImageSrc
      ? `<div class="sc-bg-plate" style="left:${-r.x}px;top:${-r.y}px;width:1080px;height:1920px"><img src="${esc(scene.bgImageSrc)}" alt="" /><div class="sc-bg-scrim"></div></div>`
      : "";

  return {
    markup: `<div class="sc${cine ? " sc-cine" : ""}${first ? " sc-first" : ""}" data-scene="${i}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">${bgPlateMarkup}${body.markup}</div>`,
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
  // Ink for text printed ON a card face, chosen from that face's own lightness
  // rather than the backdrop's — the two disagree in three of the five themes,
  // which is exactly how .sc-step-t and .sc-side-label ended up invisible. See
  // the note above .sc-side below.
  const cardInk = isLightPalette(p.cardFace) ? p.ink : p.hookInk;
  return `
  /* --- scene stack (Phase 3C) ---------------------------------------------
     One layer per non-book scene, in the card's own rectangle. Layers rest
     INVISIBLE and so does everything inside them: the rest state has to match
     each tween's from-state, or a frame rendered before a tween starts differs
     from the same frame reached by seeking backwards. */
  .sc { position:absolute; opacity:0; visibility:hidden; pointer-events:none;
        display:flex; align-items:center; justify-content:center;
        font-family: Inter, system-ui, sans-serif; color:${p.hookInk}; }
  .sc > * { width:100%; position:relative; }
  .sc > .sc-bg-plate { position:absolute; pointer-events:none; overflow:hidden; }
  .sc-bg-plate img { display:block; width:100%; height:100%; object-fit:cover; filter:blur(15px) saturate(1.26) contrast(1.08); transform:scale(1.08); opacity:0.78; }
  .sc-bg-scrim { position:absolute; inset:0; background:radial-gradient(95% 78% at 50% 45%, ${alpha(p.backdropDeep, light ? 0.44 : 0.48)} 0%, ${alpha(p.backdropDeep, light ? 0.78 : 0.82)} 100%); }
  .sc [data-el] { opacity:0; visibility:hidden; }

  /* The content-aware glow: one element, one colour tween per scene, sitting
     over the theme's own backdrop so a theme keeps its character while the
     background still moves with the content. */
  .scene-glow { position:absolute; inset:0; pointer-events:none; opacity:0.55;
                background: radial-gradient(70% 44% at 50% 34%, ${p.bloomA} 0%, transparent 70%); }

  .sc-icon { color:${p.accent}; display:block; }

  /* kinetic text — the narration itself, word by word on the real audio */
  .sc-kinetic-wrap { display:flex; flex-direction:column; align-items:center; gap:24px; max-width:810px; margin:0 auto; }
  .sc-kinetic-rule { width:96px; height:5px; border-radius:3px; background:${p.accent};
                     transform:scaleX(0); transform-origin:center center; }
  .sc-kinetic { text-align:center; font-weight:800; line-height:1.2; letter-spacing:-0.6px;
                padding:0 16px; }
  .sc-word { display:inline-block; margin:0 0.16em 0.12em 0; }
  .sc-kinetic-icon { opacity:0.88; }
  .sc-kinetic-icon .sc-icon { color:${p.accent}; }
  .sc [data-el].sc-lottie { opacity:0.88; visibility:visible; width:104px; height:104px; }
  .sc-word-emph { color:${p.accent}; font-size:1.15em; padding:0 0.08em; border-radius:8px;
                  background:linear-gradient(180deg, transparent 68%, ${alpha(p.accent, light ? 0.16 : 0.22)} 68%); }

  /* quote — the book's own words */
  .sc-quote { text-align:center; padding:0 28px; max-width:810px; margin:0 auto; }
  .sc-quote-mark { font-size:176px; line-height:0.6; color:${p.accent}; font-family:Georgia, serif; }
  .sc-quote-text { margin:32px 0 0; font-weight:600; line-height:1.32; font-family:Georgia, "Times New Roman", serif;
                   font-style:italic; }

  /* icon concept — modular infographic diagram with optional Three.js accents */
  .sc-icons-wrap { position:relative; max-width:810px; margin:0 auto; }
  .sc-icons-rail { position:absolute; left:14%; right:14%; height:4px; border-radius:2px;
                   background:${alpha(p.accent, 0.38)}; transform:scaleX(0); transform-origin:left center; }
  .sc-icons { position:relative; display:flex; align-items:flex-start; justify-content:center; gap:32px; }
  .sc-cell { display:flex; flex-direction:column; align-items:center; gap:22px; flex:1 1 0; min-width:0; }
  .sc-icon-well { position:relative; width:var(--sz); height:var(--sz); border-radius:36px;
                  display:flex; align-items:center; justify-content:center;
                  background:${p.cardFace};
                  box-shadow:0 28px 68px -28px ${p.cardShadow}, 0 0 0 1.5px ${p.cardEdge}, inset 0 1px 0 ${alpha(p.accent, 0.16)}; }
  .sc-cell-label { font-size:34px; font-weight:800; text-align:center; line-height:1.2; max-width:236px;
                   color:${ink}; overflow-wrap:break-word; }
  .sc [data-el].sc-three { position:absolute; inset:22%; width:56%; height:56%; }

  /* comparison — balanced documentary contrast with visual hierarchy */
  .sc-compare { display:flex; align-items:stretch; justify-content:center; gap:20px; max-width:810px; margin:0 auto; }
  .sc-side { position:relative; flex:1 1 0; min-width:0; display:flex; flex-direction:column;
             align-items:center; justify-content:center; gap:22px;
             padding:44px 24px 38px; border-radius:32px; background:${p.cardFace}; overflow:hidden;
             box-shadow:0 28px 66px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-side-b { box-shadow:0 32px 74px -28px ${p.cardShadow}, 0 0 0 2px ${alpha(p.accent, 0.68)}; }
  .sc-side-bar { position:absolute; left:24px; right:24px; top:0; height:6px; border-radius:0 0 6px 6px; }
  .sc-side-bar-a { background:${alpha(p.bylineInk, 0.35)}; }
  .sc-side-bar-b { background:${p.accent}; }
  .sc-side-a .sc-icon { color:${p.bylineInk}; }
  .sc-side-b .sc-icon { color:${p.accent}; }
  .sc-side-label { font-size:36px; font-weight:800; text-align:center; line-height:1.22; color:${cardInk};
                   max-width:100%; overflow-wrap:break-word; }
  .sc-vs-badge { flex:0 0 auto; align-self:center; width:66px; height:66px; border-radius:50%;
                 display:flex; align-items:center; justify-content:center;
                 background:${alpha(p.accent, light ? 0.14 : 0.2)};
                 box-shadow:inset 0 0 0 1.5px ${alpha(p.accent, 0.55)}; }
  .sc-vs { font-size:24px; font-weight:900; letter-spacing:2px; text-transform:uppercase;
           color:${p.accent}; }

  /* steps — connected process diagram */
  .sc-steps { display:flex; flex-direction:column; gap:20px; max-width:790px; margin:0 auto; }
  .sc-steps-track { position:relative; display:flex; flex-direction:column; gap:22px; }
  .sc-heading { font-size:28px; font-weight:800; letter-spacing:2.4px; text-transform:uppercase;
                color:${p.accent}; text-align:center; margin-bottom:6px; }
  .sc-step { position:relative; display:flex; align-items:center; gap:26px; padding:24px 28px; border-radius:26px;
             background:${p.cardFace};
             box-shadow:0 22px 54px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-step-n { flex:0 0 auto; width:68px; height:68px; border-radius:20px; background:${p.accent};
               color:${p.ctaFace}; font-size:34px; font-weight:800; font-variant-numeric:tabular-nums;
               display:flex; align-items:center; justify-content:center; }
  .sc-step-t { flex:1 1 auto; min-width:0; font-size:36px; font-weight:700; line-height:1.22;
               color:${cardInk}; overflow-wrap:break-word; }
  .sc-step-chevron { flex:0 0 auto; color:${alpha(p.accent, 0.72)}; }
  .sc-step-connector { position:absolute; left:60px; top:56px; bottom:56px; width:5px; border-radius:3px;
                       background:${p.accent}; opacity:0.55; transform:scaleY(0); transform-origin:top center; }

  /* timeline — chronological / sequential milestone cards */
  .sc-timeline { position:relative; max-width:790px; margin:0 auto; padding-left:78px;
                 display:flex; flex-direction:column; gap:26px; }
  .sc-tl-axis { position:absolute; left:28px; top:20px; bottom:20px; width:4px; border-radius:2px;
                background:${p.accent}; transform:scaleY(0); transform-origin:top center; }
  .sc-tl-row { position:relative; display:flex; align-items:center; }
  .sc-tl-dot { position:absolute; left:-61px; top:50%; margin-top:-11px;
               width:22px; height:22px; border-radius:50%;
               background:${p.accent};
               box-shadow:0 0 0 6px ${alpha(p.backdropDeep, light ? 0.2 : 0.75)}, 0 0 0 9px ${alpha(p.accent, 0.36)}; }
  .sc-tl-card { flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:20px;
                padding:22px 28px; border-radius:24px; background:${p.cardFace};
                box-shadow:0 20px 50px -28px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-tl-step-chip { flex:0 0 auto; padding:6px 12px; border-radius:10px;
                     background:${alpha(p.accent, light ? 0.14 : 0.2)}; color:${p.accent};
                     font-size:22px; font-weight:800; letter-spacing:1.2px; font-variant-numeric:tabular-nums; }
  .sc-tl-label { flex:1 1 auto; min-width:0; font-size:36px; font-weight:700; line-height:1.22;
                 color:${cardInk}; overflow-wrap:break-word; }

  /* growth curve — framed documentary trajectory chart */
  .sc-curve { display:flex; flex-direction:column; align-items:center; gap:28px;
              max-width:790px; margin:0 auto; padding:40px 40px 36px; border-radius:34px;
              background:${p.cardFace};
              box-shadow:0 30px 72px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-curve-label { font-size:30px; font-weight:800; letter-spacing:2.2px; text-transform:uppercase;
                    color:${p.accent}; text-align:center; max-width:100%; overflow-wrap:break-word; }
  .sc-curve-svg { display:block; max-width:100%; height:auto; overflow:visible; }
  .sc-curve-line { stroke:${p.accent}; stroke-width:9; }
  .sc-curve-node { fill:${p.cardFace}; stroke:${p.accent}; stroke-width:5; }
  .sc-curve-head { fill:${p.accent}; stroke:${p.cardFace}; stroke-width:4; }
  .sc-axis { stroke:${alpha(cardInk, 0.28)}; stroke-width:2.5; }
  .sc-grid { stroke:${alpha(cardInk, 0.14)}; stroke-width:1.5; }
  .sc-curve-fill-top { stop-color:${p.accent}; stop-opacity:0.34; }
  .sc-curve-fill-bottom { stop-color:${p.accent}; stop-opacity:0.02; }

  /* stat — documentary figure card with tabular counter & precision bar */
  .sc-stat { text-align:center; max-width:780px; margin:0 auto; }
  .sc-stat-card { padding:54px 48px 48px; border-radius:36px; background:${p.cardFace};
                  box-shadow:0 32px 78px -30px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .sc-stat-value { font-weight:900; line-height:0.98; letter-spacing:-4px; color:${p.accent};
                   font-variant-numeric:tabular-nums; }
  .sc [data-el].sc-stat-count { opacity:1; visibility:visible; font-variant-numeric:tabular-nums; }
  .sc-stat-track { width:${Math.round(rect.w * 0.5)}px; max-width:100%; height:10px; border-radius:999px;
                   margin:34px auto 0; background:${alpha(cardInk, 0.14)}; overflow:hidden; }
  .sc-stat-rule { height:100%; border-radius:999px;
                  background:${p.accent}; transform:scaleX(0); transform-origin:left center; }
  .sc-stat-label { margin-top:30px; font-size:40px; font-weight:700; line-height:1.24;
                   color:${cardInk}; overflow-wrap:break-word; }
  .sc-icon-label::first-letter, .sc-side-label::first-letter, .sc-step-t::first-letter,
  .sc-tl-label::first-letter, .sc-stat-label::first-letter { text-transform:uppercase; }

  /* cinematic — one 3D hero with cinematic type, full frame (cine-runtime.js) */
  .sc.sc-cine { display:block; }
  .sc-cine > * { width:auto; }
  /* The opening hook rests visible: it owns frame zero, like the hook card did. */
  .sc.sc-first { opacity:1; visibility:visible; }
  .cine-canvas, .cine-bloom { position:absolute; left:0; top:0; width:${1080}px; height:${1920}px; }
  .cine-canvas { filter:contrast(1.1) saturate(1.24) brightness(1.06); }
  .cine-bloom { mix-blend-mode:${light ? "multiply" : "screen"}; }
  .cine-plate-src { position:absolute; left:0; top:0; width:1px; height:1px; opacity:0; pointer-events:none; }
  .cine-video { position:absolute; left:0; top:0; width:${1080}px; height:${1920}px; object-fit:cover; filter:contrast(1.08) saturate(1.18) brightness(1.04); }
  .cine-plate-scrim { position:absolute; inset:0; pointer-events:none;
                      background: linear-gradient(180deg, ${alpha(light ? p.cardFace : p.backdropDeep, light ? 0.6 : 0.62)} 0%, ${alpha(light ? p.cardFace : p.backdropDeep, light ? 0.02 : 0.03)} 34%, ${alpha(light ? p.cardFace : p.backdropDeep, light ? 0.03 : 0.05)} 66%, ${alpha(light ? p.cardFace : p.backdropDeep, light ? 0.74 : 0.76)} 100%); }
  .cine-fallback { position:absolute; left:140px; top:640px; width:800px; height:800px; border-radius:50%;
                   background: radial-gradient(circle, ${alpha(p.accent, 0.4)} 0%, ${alpha(p.accent, 0.14)} 46%, transparent 70%);
                   box-shadow: inset 0 0 0 3px ${alpha(p.accent, 0.35)}, 0 0 0 80px ${alpha(p.accent, 0.06)}; }
  .cine-text { position:absolute; left:130px; right:130px; top:264px; text-align:center; font-family: Inter, system-ui, sans-serif; }
  .cine-callout { display:inline-block; margin-bottom:18px; padding:10px 24px; border-radius:999px;
                  font-size:26px; font-weight:800; letter-spacing:2.2px; text-transform:uppercase;
                  color:${key}; background:${alpha(light ? p.cardFace : p.backdropDeep, light ? 0.82 : 0.68)};
                  box-shadow:inset 0 0 0 1.5px ${alpha(p.accent, 0.48)}; }
  .cine-lead { display:block; font-size:40px; font-weight:600; line-height:1.22; letter-spacing:0.8px;
               color:${ink}; margin-bottom:12px; ${light ? `text-shadow:0 2px 20px ${alpha(p.cardFace, 0.94)};` : `text-shadow:0 4px 26px ${alpha(p.backdropDeep, 0.85)};`} }
  .cine-key { font-weight:900; text-transform:uppercase; line-height:0.98; letter-spacing:-2px; color:${key};
              max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${light ? `text-shadow:0 2px 24px ${alpha(p.cardFace, 0.92)}, 0 8px 26px ${alpha(p.accent, 0.18)};` : `text-shadow:0 0 42px ${alpha(p.accent, 0.52)}, 0 6px 28px ${alpha(p.backdropDeep, 0.75)};`} }
  .cine-letter { display:inline-block; }
  .cine-space { display:inline-block; width:0.3em; }
  .cine-hook { position:absolute; left:130px; right:130px; top:252px; text-align:center; font-weight:800; line-height:1.15;
               letter-spacing:-0.5px; font-family: Inter, system-ui, sans-serif; color:${ink};
               ${light ? `text-shadow:0 2px 24px ${alpha(p.cardFace, 0.95)}, 0 0 10px ${alpha(p.cardFace, 0.9)};` : `text-shadow:0 4px 32px ${alpha(p.backdropDeep, 0.88)};`} }
  .cine-hook .sc-word-emph { color:${key}; background:none; padding:0; ${light ? "" : `text-shadow:0 0 36px ${alpha(p.accent, 0.5)};`} }
`;
}

/**
 * The world behind a scene (scenes/environment.ts), as one CSS class per environment.
 *
 * Why this exists: before it, `theme.backdrop()` was emitted once for the whole video, from a
 * global app setting rather than from content — so across forty finished episodes the library
 * held exactly two distinct backgrounds, and the background could not follow meaning because
 * there was no code path for it. These layers are that path.
 *
 * Every colour is a palette role put through `alpha`, never a literal. That is what keeps a
 * theme looking like itself while its world changes with the story: the environments differ in
 * where the light comes from and how heavy the dark is, not in hue. `tests/scenes.test.mts`
 * enforces it by setting every role to one hue and refusing any output colour that is neutral
 * or of another hue — a literal anywhere would survive that substitution and be caught.
 *
 * Each rule matches its entry in `ENVIRONMENT_GUIDE`, whose prose is what the director is given
 * to choose from, so what the model is promised is what the frame actually paints.
 */
export function environmentCss(theme: BookTheme): string {
  const p = theme.palette;
  const light = isLightPalette(p.backdropDeep);
  /** Dark themes carry the atmosphere; light ones tint rather than shade, or the page goes muddy. */
  const w = (dark: number, pale: number) => (light ? pale : dark);

  return `
  /* --- the world behind the scene (environment.ts) ----------------------- */
  /* One static layer per environment in use, stacked behind everything and crossfaded on
     opacity alone. Static because a layer whose look never changes makes "which world is
     showing" a pure function of the playhead, which is what the renderer's non-linear
     seeking requires. Positioned with inset, never with a bottom edge. */
  .env { position:absolute; inset:0; opacity:0; pointer-events:none; }
  .env-first { opacity:1; }

  /* still — an even ground, one soft light high up, nothing pulling at the eye. */
  .env-still { background:
      radial-gradient(130% 86% at 50% 16%, ${alpha(p.bloomA, w(0.3, 0.42))} 0%, transparent 62%),
      radial-gradient(120% 100% at 50% 100%, ${alpha(p.backdropDeep, w(0.52, 0.2))} 0%, transparent 70%),
      linear-gradient(180deg, ${alpha(p.backdropBase, w(0.5, 0.72))} 0%, ${alpha(p.backdropDeep, w(0.72, 0.26))} 100%); }

  /* dawn — warm light rising from the lower edge and widening as it climbs. */
  .env-dawn { background:
      radial-gradient(150% 92% at 50% 112%, ${alpha(p.accent, w(0.46, 0.34))} 0%, ${alpha(p.bloomA, w(0.26, 0.2))} 34%, transparent 72%),
      radial-gradient(90% 60% at 50% 104%, ${alpha(p.bloomB, w(0.4, 0.26))} 0%, transparent 60%),
      linear-gradient(180deg, ${alpha(p.backdropDeep, w(0.8, 0.24))} 0%, ${alpha(p.backdropBase, w(0.3, 0.6))} 100%); }

  /* dusk — a heavy sky above, a low band of light fading along the horizon. */
  .env-dusk { background:
      linear-gradient(180deg, ${alpha(p.backdropDeep, w(0.92, 0.4))} 0%, ${alpha(p.backdropDeep, w(0.52, 0.16))} 56%, transparent 78%),
      radial-gradient(160% 26% at 50% 76%, ${alpha(p.accent, w(0.38, 0.3))} 0%, ${alpha(p.bloomB, w(0.18, 0.14))} 40%, transparent 74%),
      linear-gradient(180deg, transparent 60%, ${alpha(p.vignette, w(0.6, 0.22))} 100%); }

  /* storm — a tense ground, slanting rain, one hard flash off to the side. */
  .env-storm { background:
      radial-gradient(60% 46% at 22% 28%, ${alpha(p.accent, w(0.5, 0.36))} 0%, transparent 58%),
      repeating-linear-gradient(74deg, ${alpha(p.ink, w(0.16, 0.1))} 0px, ${alpha(p.ink, w(0.16, 0.1))} 1px, transparent 1px, transparent 13px),
      radial-gradient(140% 110% at 70% 8%, ${alpha(p.backdropDeep, w(0.9, 0.34))} 0%, ${alpha(p.backdropDeep, w(0.5, 0.14))} 54%, transparent 84%); }

  /* deep — a tunnel closing in on a faint pool of light, rings spreading from the centre. */
  .env-deep { background:
      radial-gradient(42% 30% at 50% 46%, ${alpha(p.bloomA, w(0.34, 0.3))} 0%, transparent 70%),
      repeating-radial-gradient(circle at 50% 46%, transparent 0px, transparent 54px, ${alpha(p.accent, w(0.1, 0.08))} 54px, transparent 56px),
      radial-gradient(118% 92% at 50% 46%, transparent 24%, ${alpha(p.backdropDeep, w(0.86, 0.3))} 72%, ${alpha(p.vignette, w(0.94, 0.4))} 100%); }

  /* warm — a wide, soft, enveloping glow lit from the middle of the frame. */
  .env-warm { background:
      radial-gradient(108% 78% at 50% 48%, ${alpha(p.accent, w(0.3, 0.24))} 0%, ${alpha(p.bloomA, w(0.24, 0.26))} 42%, transparent 80%),
      radial-gradient(70% 54% at 34% 62%, ${alpha(p.bloomB, w(0.26, 0.2))} 0%, transparent 66%),
      linear-gradient(180deg, ${alpha(p.backdropBase, w(0.38, 0.58))} 0%, ${alpha(p.backdropDeep, w(0.6, 0.2))} 100%); }

  /* grid — a faint ruled plan under a spotlight, like drafting paper. */
  .env-grid { background:
      radial-gradient(72% 52% at 50% 34%, ${alpha(p.bloomA, w(0.3, 0.34))} 0%, transparent 70%),
      repeating-linear-gradient(0deg, ${alpha(p.marker, w(0.14, 0.12))} 0px, ${alpha(p.marker, w(0.14, 0.12))} 1px, transparent 1px, transparent 64px),
      repeating-linear-gradient(90deg, ${alpha(p.marker, w(0.14, 0.12))} 0px, ${alpha(p.marker, w(0.14, 0.12))} 1px, transparent 1px, transparent 64px),
      linear-gradient(180deg, ${alpha(p.backdropBase, w(0.4, 0.6))} 0%, ${alpha(p.backdropDeep, w(0.68, 0.22))} 100%); }
`;
}
