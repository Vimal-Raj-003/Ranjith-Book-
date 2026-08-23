import { PALETTE, type AspectSpec, type ThumbFocus, type Variant } from "./types";
import { clean, escapeHtml, paintKeywords, trimWords } from "./text";

export interface Photo {
  /** `data:image/jpeg;base64,...` — inlined, because the page is loaded via
   *  `setContent` with no base URL and must never make a network request. */
  dataUri: string;
  width: number;
  height: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Turn a caller-supplied focus box into one that is safe to draw, or null.
 *
 * Inverted boxes are swapped rather than rejected — a beat whose end word
 * precedes its start word is a content bug, not a reason to lose the crop —
 * and out-of-bounds coordinates are clamped to the image. Only a box that is
 * degenerate after all that (zero-area, or entirely off the page) gives up.
 * Nothing here throws: a bad focus box costs the marker, never the thumbnail.
 */
export function normaliseFocus(
  focus: ThumbFocus | null | undefined,
  page: { width: number; height: number },
): Box | null {
  if (!focus) return null;
  const raw = [focus.x0, focus.y0, focus.x1, focus.y1];
  if (raw.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  if (!(page.width > 0) || !(page.height > 0)) return null;

  const x0 = clamp(Math.min(focus.x0, focus.x1), 0, page.width);
  const x1 = clamp(Math.max(focus.x0, focus.x1), 0, page.width);
  const y0 = clamp(Math.min(focus.y0, focus.y1), 0, page.height);
  const y1 = clamp(Math.max(focus.y0, focus.y1), 0, page.height);

  // Anything thinner than a few pixels is noise, and a marker drawn on it
  // would read as a scratch rather than a highlight.
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return { x0, y0, x1, y1 };
}

export interface Crop {
  /** Rendered size of the whole photo, and where its top-left corner sits
   *  relative to the (overflow:hidden) window. */
  imgW: number;
  imgH: number;
  left: number;
  top: number;
  mark: { left: number; top: number; width: number; height: number } | null;
}

/**
 * Cover-crop a page photo into a `boxW x boxH` window, centred on the focus box
 * when there is one. The visible region is roughly twice the width of the
 * highlighted line, which is close enough to read the words around it without
 * making the highlight itself a stripe in a field of grey.
 */
export function computeCrop(
  photoW: number,
  photoH: number,
  boxW: number,
  boxH: number,
  focus: Box | null,
): Crop {
  const aspect = boxW / boxH;

  const cx = focus ? (focus.x0 + focus.x1) / 2 : photoW / 2;
  // No focus: bias upward. A book page carries its text above the midline more
  // often than below it, and the bottom of a photograph is usually the desk.
  const cy = focus ? (focus.y0 + focus.y1) / 2 : photoH * 0.42;

  let rw = focus ? Math.max((focus.x1 - focus.x0) * 1.9, photoW * 0.34) : photoW * 0.78;
  rw = Math.min(rw, photoW);
  let rh = rw / aspect;
  if (rh > photoH) {
    rh = photoH;
    rw = Math.min(photoW, rh * aspect);
    rh = rw / aspect;
  }

  const rx = clamp(cx - rw / 2, 0, photoW - rw);
  const ry = clamp(cy - rh / 2, 0, photoH - rh);
  const scale = boxW / rw;

  return {
    imgW: round2(photoW * scale),
    imgH: round2(photoH * scale),
    left: round2(-rx * scale),
    top: round2(-ry * scale),
    mark: focus
      ? {
          left: round2((focus.x0 - rx) * scale),
          top: round2((focus.y0 - ry) * scale),
          width: round2((focus.x1 - focus.x0) * scale),
          height: round2((focus.y1 - focus.y0) * scale),
        }
      : null,
  };
}

function photoLayer(
  photo: Photo | null,
  focus: Box | null,
  style: string,
  boxW: number,
  boxH: number,
  extraClass = "",
): string {
  if (!photo) {
    // No usable photograph. Rather than dropping the thumbnail, the window
    // becomes a deep panel — the type carries the frame on its own.
    return `<div class="photo empty ${extraClass}" style="${style}"></div>`;
  }
  const crop = computeCrop(photo.width, photo.height, boxW, boxH, focus);
  const mark = crop.mark
    ? `<div class="mark" style="left:${crop.mark.left}px;top:${crop.mark.top}px;width:${crop.mark.width}px;height:${crop.mark.height}px"></div>`
    : "";
  return (
    `<div class="photo ${extraClass}" style="${style}">` +
    `<img src="${escapeHtml(photo.dataUri)}" style="width:${crop.imgW}px;height:${crop.imgH}px;left:${crop.left}px;top:${crop.top}px" alt="">` +
    mark +
    `</div>`
  );
}

export interface ThumbCopy {
  title: string;
  hook: string;
  keywords: string[];
  cta: string;
}

/** Word budgets. A thumbnail that has to be read at full size is a failed one. */
const WORD_BUDGET: Record<Variant, number> = { quote: 7, bold: 7, split: 6 };

function headline(copy: ThumbCopy, variant: Variant): string {
  const source = clean(copy.hook) || clean(copy.title);
  const trimmed = trimWords(source, WORD_BUDGET[variant]);
  return paintKeywords(trimmed, copy.keywords);
}

function baseCss(a: AspectSpec): string {
  const P = PALETTE;
  return `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${a.width}px;height:${a.height}px;overflow:hidden}
body{background:${P.paper};color:${P.ink};
  font-family:"Helvetica Neue",Helvetica,Arial,"Liberation Sans","DejaVu Sans",sans-serif;
  -webkit-font-smoothing:antialiased}
.frame{position:relative;width:${a.width}px;height:${a.height}px;overflow:hidden}
.photo{position:absolute;overflow:hidden;background:${P.backdropDeep}}
.photo.empty{background:radial-gradient(120% 90% at 50% 25%, ${P.backdropWarm} 0%, ${P.backdropMid} 48%, ${P.backdropDeep} 100%)}
.photo img{position:absolute;display:block;max-width:none}
/* Same recipe as the composition's \`.stroke\`: one multiply-blended slab of
   marker yellow, so the thumbnail advertises the video's own highlight. */
.mark{position:absolute;border-radius:4px;
  background:linear-gradient(180deg,#ffe97a 0%,${P.marker} 55%,${P.markerEdge} 100%);
  mix-blend-mode:multiply;box-shadow:0 0 26px 8px rgba(255,225,77,.5)}
.panel{position:absolute;display:flex;flex-direction:column;overflow:hidden}
.fitbox{flex:1 1 auto;min-height:0;display:flex;align-items:center;overflow:hidden}
.fit{width:100%;font-weight:900;line-height:0.94;letter-spacing:-0.025em;
  /* Padding in \`em\` so it scales with whatever size the fit lands on: at
     line-height .94 a descender ("busy", "people") hangs below the last line
     box, and without this the fit happily chooses a size whose tails are
     shaved off by the panel edge. */
  padding:0.07em 0;
  /* Deliberately NOT break-word: a mid-word break is worse than a smaller
     headline, so an over-wide word must overflow and be caught by the fit's
     width check. The script turns breaking on only as a last resort. */
  overflow-wrap:normal;word-break:normal;hyphens:none}
.kw{font-style:normal;color:${P.accent}}
.kicker{display:flex;align-items:center;gap:${Math.round(a.width * 0.018)}px;flex:0 0 auto}
.rule{display:block;flex:0 0 auto;width:${Math.round(a.width * 0.075)}px;
  height:${Math.round(a.width * 0.012)}px;background:${P.accent};border-radius:99px}
.kicker-t{font-size:${Math.round(a.width * 0.026)}px;font-weight:800;letter-spacing:.14em;
  text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  opacity:.62}
.chip{flex:0 0 auto;align-self:flex-start;max-width:100%;
  font-size:${Math.round(a.width * 0.027)}px;font-weight:800;letter-spacing:.02em;
  padding:${Math.round(a.width * 0.014)}px ${Math.round(a.width * 0.026)}px;
  border-radius:99px;background:${P.ink};color:${P.paper};
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
}

/**
 * The whole document for one thumbnail. Every piece of book text on the way in
 * goes through `escapeHtml`/`paintKeywords`; nothing here interpolates raw
 * user text into markup.
 */
export function buildThumbHtml(opts: {
  aspect: AspectSpec;
  variant: Variant;
  copy: ThumbCopy;
  photo: Photo | null;
  focus: Box | null;
}): string {
  const { aspect: a, variant, copy, photo, focus } = opts;
  const P = PALETTE;
  const portrait = a.height > a.width;
  const pad = Math.round(a.width * (portrait ? 0.055 : 0.045));
  const gap = Math.round(a.height * 0.02);
  const fitMin = Math.max(16, Math.round(a.height * 0.024));
  const fitMax = Math.round(a.height * 0.22);
  const fitAttr = `data-fit="${fitMin},${fitMax}"`;

  const title = escapeHtml(trimWords(copy.title, 6).toUpperCase());
  const cta = escapeHtml(trimWords(copy.cta, 6));
  const head = headline(copy, variant);
  const kicker = title
    ? `<div class="kicker"><span class="rule"></span><span class="kicker-t">${title}</span></div>`
    : "";

  let css = "";
  let body = "";

  if (variant === "quote") {
    const photoH = Math.round(a.height * (portrait ? 0.58 : 0.52));
    css = `
.panel{left:0;right:0;top:${photoH}px;bottom:0;background:${P.paper};padding:${pad}px;gap:${gap}px;
  box-shadow:0 -22px 48px -20px rgba(0,0,0,.55)}
.fit{font-size:${fitMax}px}
`;
    body =
      photoLayer(photo, focus, `left:0;top:0;width:${a.width}px;height:${photoH}px`, a.width, photoH) +
      `<div class="panel">${kicker}<div class="fitbox"><div class="fit" ${fitAttr}>${head}</div></div></div>`;
  } else if (variant === "bold") {
    // Full-bleed type on the theme's own deep desk. The photograph, if there is
    // one, is only texture: heavily darkened, well behind the words.
    css = `
.bg{position:absolute;inset:0;
  background:radial-gradient(120% 70% at 50% 22%, ${P.backdropWarm} 0%, ${P.backdropMid} 46%, ${P.backdropDeep} 100%),
             linear-gradient(180deg,#241708 0%,#120c07 100%)}
.bloom{position:absolute;border-radius:50%;filter:blur(150px)}
.bloom-a{width:${Math.round(a.width * 0.85)}px;height:${Math.round(a.width * 0.85)}px;
  left:${-Math.round(a.width * 0.2)}px;top:${-Math.round(a.height * 0.12)}px;
  background:radial-gradient(circle, ${P.bloomA} 0%, rgba(217,83,30,0) 70%)}
.bloom-b{width:${Math.round(a.width * 0.95)}px;height:${Math.round(a.width * 0.95)}px;
  left:${Math.round(a.width * 0.35)}px;top:${Math.round(a.height * 0.62)}px;
  background:radial-gradient(circle, ${P.bloomB} 0%, rgba(255,201,77,0) 70%)}
.grain{position:absolute;inset:0;opacity:.10;mix-blend-mode:overlay;
  background-image:radial-gradient(#d9c9a3 1px, transparent 1px);background-size:3px 3px}
.photo{opacity:.16;filter:grayscale(.5) brightness(.45)}
.photo .mark{opacity:.45}
.scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,7,4,.58) 0%,rgba(10,7,4,.84) 100%)}
/* Top and bottom padding leave the kicker and the CTA chip their own air —
   both are absolutely positioned, so the headline box has to stop short of
   them rather than discover them by overlapping. */
.panel{left:0;right:0;top:0;bottom:0;gap:${gap}px;justify-content:center;
  padding:${pad + Math.round(a.height * 0.05)}px ${pad}px ${pad + Math.round(a.height * 0.07)}px}
.kicker{position:absolute;left:${pad}px;top:${pad}px;right:${pad}px}
.kicker-t{color:${P.hookInk};opacity:.72}
.rule{background:${P.marker}}
.fit{color:${P.hookInk};text-transform:uppercase;letter-spacing:-0.015em;
  text-shadow:0 8px 30px rgba(0,0,0,.55);font-size:${fitMax}px}
/* On the dark backdrop the accent is painted as the video's own hook-key tint
   — raw #d9531e only reaches about 4:1 here and vanishes at feed size. */
.kw{color:${P.hookKey}}
.chip{position:absolute;left:${pad}px;bottom:${pad}px;background:${P.marker};color:${P.ink}}
`;
    body =
      `<div class="bg"></div><div class="bloom bloom-a"></div><div class="bloom bloom-b"></div>` +
      (photo
        ? photoLayer(photo, focus, `left:0;top:0;width:${a.width}px;height:${a.height}px`, a.width, a.height)
        : "") +
      `<div class="scrim"></div><div class="grain"></div>` +
      `<div class="panel"><div class="fitbox"><div class="fit" ${fitAttr}>${head}</div></div></div>` +
      kicker +
      (cta ? `<div class="chip">${cta}</div>` : "");
  } else {
    const photoW = Math.round(a.width * (portrait ? 0.46 : 0.5));
    css = `
.panel{left:${photoW}px;right:0;top:0;bottom:0;background:${P.paper};gap:${gap}px;
  justify-content:center;box-shadow:-22px 0 48px -20px rgba(0,0,0,.5);
  padding:${pad + Math.round(a.height * 0.06)}px ${pad}px ${pad + Math.round(a.height * 0.08)}px}
.seam{position:absolute;left:${photoW - Math.round(a.width * 0.008)}px;top:0;bottom:0;
  width:${Math.round(a.width * 0.008)}px;background:${P.marker}}
.kicker{position:absolute;left:${photoW + pad}px;top:${pad}px;right:${pad}px}
.fit{font-size:${fitMax}px}
.chip{position:absolute;left:${photoW + pad}px;bottom:${pad}px;max-width:${a.width - photoW - 2 * pad}px}
`;
    body =
      photoLayer(photo, focus, `left:0;top:0;width:${photoW}px;height:${a.height}px`, photoW, a.height) +
      `<div class="seam"></div>` +
      `<div class="panel"><div class="fitbox"><div class="fit" ${fitAttr}>${head}</div></div></div>` +
      kicker +
      (cta ? `<div class="chip">${cta}</div>` : "");
  }

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<style>${baseCss(a)}${css}</style></head>` +
    `<body><div class="frame ${variant}">${body}</div></body></html>`
  );
}

/**
 * Shrink every `[data-fit]` block to the largest whole pixel size that still
 * fits its box. Runs in the page, after layout: measuring is the only reliable
 * way to keep a seven-word hook and a two-word hook both filling the frame,
 * and a binary search over integers is deterministic — same text, same size.
 *
 * Written as a self-invoking expression, not a bare arrow function: Playwright
 * evaluates a string as an EXPRESSION, so `() => {...}` would merely construct
 * a function and hand it back, leaving every headline at its start size.
 */
export const FIT_SCRIPT = `(() => {
  const els = Array.from(document.querySelectorAll("[data-fit]"));
  for (const el of els) {
    const box = el.parentElement;
    if (!box) continue;
    const parts = String(el.getAttribute("data-fit")).split(",");
    const min = Number(parts[0]) || 12;
    const max = Number(parts[1]) || 96;
    // Measure the box ONCE, at the smallest size. Every fit box in this module
    // is a \`flex:1\` cell whose height does not depend on its content, but
    // reading it inside the loop would make a box that ever did track its
    // content circular — the search would then compare the text against itself
    // and collapse to the floor.
    el.style.fontSize = min + "px";
    const boxH = box.clientHeight;
    const boxW = box.clientWidth;
    const fits = (n) => {
      el.style.fontSize = n + "px";
      return el.scrollHeight <= boxH && el.scrollWidth <= boxW;
    };
    const search = () => {
      let lo = min, hi = max, best = min, found = false;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) { best = mid; found = true; lo = mid + 1; } else { hi = mid - 1; }
      }
      return { best: best, found: found };
    };
    let r = search();
    if (!r.found) {
      // Nothing fits even at the floor — a single word longer than the box.
      // Only now is breaking it the lesser evil.
      el.style.overflowWrap = "break-word";
      el.style.wordBreak = "break-word";
      r = search();
    }
    el.style.fontSize = r.best + "px";
  }
})()`;
