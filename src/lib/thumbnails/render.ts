import type { AspectSpec, ThumbFocus, Variant } from "./types";
import { clean, escapeHtml, headlineText, paintKeywords, trimWords } from "./text";
import { alpha, fade, mix, thumbPalette, type ThumbPalette } from "./palette";

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
  /** Centre of the mark in window coordinates, as a percentage — what the
   *  spotlight shade is aimed at. Falls back to a sensible point with no mark. */
  focusPct: { x: number; y: number };
}

/**
 * Cover-crop a page photo into a `boxW x boxH` window, centred on the focus box.
 *
 * The old rule showed roughly twice the WIDTH of the highlighted line, and at
 * 200px in a feed that was the single worst decision in this module: on a
 * portrait window, showing an 850px-wide line inside a 1.1:1 box means showing
 * 750px of page height with it — twenty lines of nine-point body text, which
 * downscale to grey noise with one thin yellow stripe in them. The most
 * authentic asset the operator has, a real page with a real marker on it,
 * contributed nothing but texture.
 *
 * So the crop is sized in TEXT LINES, taking the height of the highlight box
 * as the height of one line, and `lines` says how many the layout wants to
 * see. That deliberately lets the window cut through the marked line
 * horizontally: half a legible sentence with a marker under it says "somebody
 * read this book", where a whole illegible page says "stock paper". Cropping
 * INTO the photograph is the point.
 */
export function computeCrop(
  photoW: number,
  photoH: number,
  boxW: number,
  boxH: number,
  focus: Box | null,
  lines = 10,
): Crop {
  const aspect = boxW / boxH;

  const cx = focus ? (focus.x0 + focus.x1) / 2 : photoW / 2;
  // No focus: bias upward. A book page carries its text above the midline more
  // often than below it, and the bottom of a photograph is usually the desk.
  const cy = focus ? (focus.y0 + focus.y1) / 2 : photoH * 0.42;

  // One text line, as measured by the highlight itself. Floored against the
  // page height so a focus box that arrived a few pixels tall — a sliver of a
  // superscript, a mis-fit OCR row — cannot zoom the crop to a single letter.
  const unit = focus ? Math.max(focus.y1 - focus.y0, photoH * 0.016) : photoH * 0.03;
  let rh = clamp(unit * Math.max(2, lines), photoH * 0.1, photoH);
  let rw = rh * aspect;
  if (rw > photoW) {
    rw = photoW;
    rh = Math.min(photoH, rw / aspect);
  }
  if (rh > photoH) {
    rh = photoH;
    rw = Math.min(photoW, rh * aspect);
  }

  // The marked line sits a little above centre. An eye entering the frame
  // travels down, so the thing it should land on belongs in the upper half —
  // and it leaves the lines *under* the highlight visible, which is what makes
  // a crop read as a page rather than as a strip.
  const rx = clamp(cx - rw / 2, 0, Math.max(0, photoW - rw));
  const ry = clamp(cy - rh * 0.44, 0, Math.max(0, photoH - rh));
  const scale = boxW / rw;

  const mark = focus
    ? {
        left: round2((focus.x0 - rx) * scale),
        top: round2((focus.y0 - ry) * scale),
        width: round2((focus.x1 - focus.x0) * scale),
        height: round2((focus.y1 - focus.y0) * scale),
      }
    : null;

  return {
    imgW: round2(photoW * scale),
    imgH: round2(photoH * scale),
    left: round2(-rx * scale),
    top: round2(-ry * scale),
    mark,
    focusPct: mark
      ? {
          x: round2(clamp(((mark.left + mark.width / 2) / boxW) * 100, 8, 92)),
          y: round2(clamp(((mark.top + mark.height / 2) / boxH) * 100, 8, 92)),
        }
      : { x: 50, y: 44 },
  };
}

/**
 * One cropped page photograph, with the highlight redrawn on it and a
 * spotlight shade pulling the eye onto that highlight.
 *
 * The shade is the hierarchy: a page is a rectangle of near-uniform grey, so
 * without it the marker is one bright stripe competing with a hundred lines of
 * equally-lit type. Darkening everything more than about a third of the frame
 * away from the mark makes the marked line the only lit thing in the window,
 * which at 200px is the difference between a focal point and a texture.
 */
function photoLayer(
  P: ThumbPalette,
  photo: Photo | null,
  focus: Box | null,
  style: string,
  boxW: number,
  boxH: number,
  opts: { extraClass?: string; lines?: number; shade?: number } = {},
): string {
  const cls = opts.extraClass ?? "";
  if (!photo) {
    // No usable photograph. Rather than dropping the thumbnail, the window
    // becomes a deep panel — the type carries the frame on its own.
    return `<div class="photo empty ${cls}" style="${style}"></div>`;
  }
  const crop = computeCrop(photo.width, photo.height, boxW, boxH, focus, opts.lines ?? 10);
  const mark = crop.mark
    ? `<div class="mark" style="left:${crop.mark.left}px;top:${crop.mark.top}px;width:${crop.mark.width}px;height:${crop.mark.height}px"></div>`
    : "";
  const s = opts.shade ?? 1;
  const shade =
    s > 0
      ? `<div class="pshade" style="background:radial-gradient(78% 62% at ${crop.focusPct.x}% ${crop.focusPct.y}%,` +
        ` ${fade(P.ground)} 0%, ${alpha(P.ground, 0.1 * s)} 34%, ${alpha(P.ground, 0.62 * s)} 74%, ${alpha(P.ground, 0.92 * s)} 100%)"></div>`
      : "";
  return (
    `<div class="photo ${cls}" style="${style}">` +
    `<img src="${escapeHtml(photo.dataUri)}" style="width:${crop.imgW}px;height:${crop.imgH}px;left:${crop.left}px;top:${crop.top}px" alt="">` +
    mark +
    shade +
    `</div>`
  );
}

export interface ThumbCopy {
  title: string;
  hook: string;
  keywords: string[];
  cta: string;
  /** Every beat's on-screen label, hook beat first. Headline material — see
   *  `headlineText`. Optional so an older caller still compiles. */
  onScreen?: string[];
  /** The takeaway bullets. The supporting line under a headline comes from
   *  here before it comes from the CTA: it is about THIS idea. */
  takeaway?: string[];
}

/**
 * Word budgets — a ceiling on what counts as a whole thought, not a truncation
 * point. `headlineText` prefers a shorter complete line over a longer cut one,
 * so these say "anything past here is too much to read at 200px", and the
 * package's own short lines are what get promoted when the hook overruns.
 */
const WORD_BUDGET: Record<Variant, number> = { quote: 8, bold: 7, split: 6 };

/**
 * The shared skeleton. Everything that is the same whatever the layout: the
 * ground, its texture, the eyebrow, the marker slab, the headline box.
 */
function baseCss(a: AspectSpec, P: ThumbPalette): string {
  const w = a.width;
  // Texture pitch is set against the *rendered* width so the ruling is the
  // same physical density in both aspects — a grid that is fine in 1080 and
  // coarse in 1280 would make the two posters look like different themes.
  const pitch = Math.round(w * 0.052);
  const tex =
    P.texture === "grid"
      ? `background-image:linear-gradient(${alpha(P.grain, 0.14)} 1px,transparent 1px),
                          linear-gradient(90deg,${alpha(P.grain, 0.14)} 1px,transparent 1px);
         background-size:${pitch}px ${pitch}px,${pitch}px ${pitch}px;opacity:.9`
      : P.texture === "weave"
        ? /* Coarse on purpose. A 1px-on-7px weave is high-frequency noise across
           every pixel of the frame, and JPEG spends enormous numbers of bytes
           on exactly that — Editorial's posters came out at over 500KB, well
           past what the delivery route should be shipping, for a texture no
           one can see at 200px anyway. */
        `background-image:repeating-linear-gradient(135deg,${alpha(P.grain, 0.1)} 0px,${alpha(P.grain, 0.1)} 2px,
                             ${fade(P.grain)} 2px,${fade(P.grain)} 14px);opacity:.75`
        : P.texture === "halftone"
          ? `background-image:radial-gradient(${alpha(P.grain, 0.5)} 1px,${fade(P.grain)} 1px);
             background-size:5px 5px;opacity:.22;mix-blend-mode:overlay`
          : `background-image:radial-gradient(${alpha(P.grain, 0.45)} 1px,${fade(P.grain)} 1px);
             background-size:3px 3px;opacity:.16;mix-blend-mode:overlay`;

  return `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${a.height}px;overflow:hidden}
body{background:${P.ground};color:${P.ink};
  font-family:"Helvetica Neue",Helvetica,Arial,"Liberation Sans","DejaVu Sans",sans-serif;
  -webkit-font-smoothing:antialiased}
.frame{position:relative;width:${w}px;height:${a.height}px;overflow:hidden}

/* --- the theme's ground ------------------------------------------------- */
.ground{position:absolute;inset:0;
  background:radial-gradient(125% 78% at 50% 18%, ${P.groundMid} 0%, ${mix(P.groundMid, P.ground, 0.55)} 46%, ${P.ground} 100%)}
.tex{position:absolute;inset:0;pointer-events:none;${tex}}
.bloom{position:absolute;border-radius:50%;filter:blur(${Math.round(w * 0.13)}px);pointer-events:none}
.bloom-a{width:${Math.round(w * 0.9)}px;height:${Math.round(w * 0.9)}px;
  left:${-Math.round(w * 0.24)}px;top:${-Math.round(a.height * 0.14)}px;
  background:radial-gradient(circle, ${P.bloomA} 0%, ${fade(P.bloomA)} 70%)}
.bloom-b{width:${Math.round(w * 1.0)}px;height:${Math.round(w * 1.0)}px;
  left:${Math.round(w * 0.38)}px;top:${Math.round(a.height * 0.66)}px;
  background:radial-gradient(circle, ${P.bloomB} 0%, ${fade(P.bloomB)} 70%)}

/* --- the photograph ----------------------------------------------------- */
.photo{position:absolute;overflow:hidden;background:${P.ground}}
.photo.empty{background:radial-gradient(120% 90% at 50% 25%, ${P.groundMid} 0%, ${mix(P.groundMid, P.ground, 0.5)} 48%, ${P.ground} 100%)}
/* A printed page photographed on a desk is flat by nature; a little contrast
   and a little extra light is what makes nine-point type survive a downscale
   to a 200px-wide tile. */
.photo img{position:absolute;display:block;max-width:none;filter:contrast(1.16) saturate(.86) brightness(1.04)}
.pshade{position:absolute;inset:0;pointer-events:none}
/* The video's own stroke: a multiply-blended slab of the theme's marker, with
   its edge colour along the bottom, and a glow so it still registers as the
   brightest thing in the window once the tile is 200px wide. */
.mark{position:absolute;border-radius:${P.markRadius}px;
  background:linear-gradient(180deg,${mix(P.marker, "#ffffff", 0.28)} 0%,${P.marker} 58%,${P.markerEdge} 100%);
  mix-blend-mode:multiply;
  box-shadow:inset 0 -${Math.max(4, Math.round(w * 0.005))}px 0 0 ${P.markerEdge},
             0 0 ${Math.round(w * 0.05)}px ${Math.round(w * 0.012)}px ${alpha(P.slab, 0.6)}}

/* --- type --------------------------------------------------------------- */
.panel{position:absolute;display:flex;flex-direction:column;overflow:hidden}
.fitbox{flex:1 1 auto;min-height:0;display:flex;align-items:center;overflow:hidden}
.fit{width:100%;font-weight:900;line-height:0.92;letter-spacing:-0.03em;
  /* Padding in \`em\` so it scales with whatever size the fit lands on: at this
     line-height a descender ("busy", "performance") hangs below the last line
     box, and without this the fit happily chooses a size whose tails are
     shaved off by the panel edge. The marker slab needs the same room. */
  padding:0.1em 0;
  /* Deliberately NOT break-word: a mid-word break is worse than a smaller
     headline, so an over-wide word must overflow and be caught by the fit's
     width check. The script turns breaking on only as a last resort. */
  overflow-wrap:normal;word-break:normal;hyphens:none}
/* The keyword is not merely tinted, it is HIGHLIGHTED — the same slab of the
   same marker the video paints over the page. It is the one mark the channel
   owns, it survives a downscale to 200px as a bar of saturated colour, and it
   rhymes with the real marker in the photograph beside it.
   The slab is a sized, positioned BACKGROUND rather than a plain fill: an
   inline box is as tall as the font's content area (~1.16em), which at this
   line-height is taller than the line box, so a plain background painted the
   whole box and struck through the line above it. Naming the band's height and
   offset in em keeps it inside the line at every size the fit can choose,
   and changes no geometry, so the fit still measures what it did before. */
.kw{font-style:normal;color:${P.onSlab};
  background-image:linear-gradient(180deg,${mix(P.slab, "#ffffff", 0.2)} 0%,${P.slab} 62%,${P.slabEdge} 100%);
  background-repeat:no-repeat;background-size:100% 0.88em;background-position:0 0.13em;
  border-radius:${P.markRadius}px;padding:0 0.06em;margin:0 -0.02em;
  -webkit-box-decoration-break:clone;box-decoration-break:clone}
.eyebrow{display:flex;align-items:center;gap:${Math.round(w * 0.02)}px;flex:0 0 auto}
/* A short, fat accent bar rather than a hairline. At 200px the title next to
   it is unreadable by any measure — what has to survive is the MARK, so the
   bar is the thing sized for the feed and the words are for the full view. */
.ebar{display:block;flex:0 0 auto;width:${Math.round(w * 0.085)}px;
  height:${Math.round(w * 0.017)}px;background:${P.accent};border-radius:99px}
.etext{font-size:${Math.round(w * 0.031)}px;font-weight:800;letter-spacing:.16em;
  text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:${P.inkSoft}}
.sub{flex:0 0 auto;font-size:${Math.round(w * 0.036)}px;font-weight:600;line-height:1.28;
  letter-spacing:-0.005em;color:${P.inkSoft};
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chip{position:absolute;max-width:70%;
  font-size:${Math.round(w * 0.03)}px;font-weight:800;letter-spacing:.01em;
  padding:${Math.round(w * 0.015)}px ${Math.round(w * 0.028)}px;
  border-radius:99px;background:${P.accent};color:${P.onAccent};
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
}

/**
 * The whole document for one thumbnail. Every piece of book text on the way in
 * goes through `escapeHtml`/`paintKeywords`; nothing here interpolates raw
 * user text into markup.
 *
 * `theme` is the episode's stored theme id. It is optional and resolved
 * through `bookThemeById`, so an unrecognised or absent id renders the default
 * theme's poster rather than throwing — a caller that has not been wired up
 * yet gets the old look, not a crash.
 */
export function buildThumbHtml(opts: {
  aspect: AspectSpec;
  variant: Variant;
  copy: ThumbCopy;
  photo: Photo | null;
  focus: Box | null;
  theme?: string | null;
  palette?: ThumbPalette;
}): string {
  const { aspect: a, variant, copy, photo, focus } = opts;
  const P = opts.palette ?? thumbPalette(opts.theme);
  const w = a.width;
  const h = a.height;
  const portrait = h > w;
  const pad = Math.round(w * (portrait ? 0.058 : 0.042));
  const gap = Math.round(h * (portrait ? 0.022 : 0.032));

  /**
   * YouTube stamps a duration badge over the bottom-right corner and crowds
   * the bottom edge with its own chrome, so nothing load-bearing may go there.
   * Every layout below either stops its type column short of `safeR` or keeps
   * clear of `safeB` — never both edges of the same corner.
   */
  const safeB = Math.round(h * (portrait ? 0.055 : 0.075));
  // Wider in portrait: a 9:16 card in a feed is narrow, so the badge covers a
  // larger fraction of its width than it does of a 16:9 card's.
  const safeR = Math.round(w * (portrait ? 0.26 : 0.2));

  const fitMin = Math.max(18, Math.round(h * 0.028));
  const fitMax = Math.round(h * (portrait ? 0.2 : 0.3));
  const fitAttr = `data-fit="${fitMin},${fitMax}"`;

  const title = escapeHtml(trimWords(copy.title, 5).toUpperCase());
  const cta = escapeHtml(trimWords(copy.cta, 6));
  const head = paintKeywords(headlineText(copy, WORD_BUDGET[variant]), copy.keywords);
  const subSource = clean(copy.takeaway?.[0]) || clean(copy.cta);
  const sub = escapeHtml(trimWords(subSource, 9));
  const eyebrow = title
    ? `<div class="eyebrow"><span class="ebar"></span><span class="etext">${title}</span></div>`
    : `<div class="eyebrow"><span class="ebar"></span></div>`;
  const fit = `<div class="fitbox"><div class="fit" ${fitAttr}>${head}</div></div>`;
  const ground = `<div class="ground"></div><div class="bloom bloom-a"></div><div class="bloom bloom-b"></div>`;

  let css = "";
  let body = "";

  if (variant === "quote") {
    // Photo-led: the photograph is the hero and the type is its caption, in
    // both shapes. A full-bleed photo with the type floated over it was tried
    // and abandoned — the scrim that stops the crop's sliced-off top edge from
    // competing with the headline is the same scrim that dims the marked line,
    // because both sit in the upper half. Two hard-edged bands need no scrim
    // at all: the photograph keeps all of its contrast, the type keeps all of
    // the ground, and the accent rule between them does the separating.
    const photoH = Math.round(h * (portrait ? 0.5 : 0.4));
    css = `
.photo{border-bottom:${Math.round(w * (portrait ? 0.014 : 0.011))}px solid ${P.accent}}
.panel{left:0;right:0;top:${photoH}px;bottom:0;
  padding:${pad}px ${pad + (portrait ? 0 : safeR)}px ${pad + safeB}px ${pad}px;
  gap:${Math.round(gap * (portrait ? 1 : 0.6))}px}
.fit{font-size:${fitMax}px}
.sub{padding-right:${safeR}px}
`;
    body =
      // Texture UNDER the photograph, not over it. The panel has no background
      // of its own, so the ruled or grained ground still reads through it —
      // but a grid drawn across the page crop would be ruling somebody's
      // photograph, which is the one surface here that is not ours to mark.
      ground +
      `<div class="tex"></div>` +
      photoLayer(P, photo, focus, `left:0;top:0;width:${w}px;height:${photoH}px`, w, photoH, {
        lines: portrait ? 13 : 5,
      }) +
      `<div class="panel">${eyebrow}${fit}${sub && portrait ? `<div class="sub">${sub}</div>` : ""}</div>`;
  } else if (variant === "bold") {
    // Type-led, full bleed. The photograph is present but demoted to evidence:
    // dark, desaturated, with the marker still glowing through it, so the
    // poster reads as "a page from a book" rather than as a gradient — which
    // is the whole difference from a generic quote card.
    css = `
/* The page is defocused rather than merely dimmed. At 200px a legible second
   block of words beside the headline is not texture, it is a competitor — but
   a page blurred just past reading still says "this came out of a book", and
   the marker, which is a sibling of the image and so stays sharp, still burns
   through it. */
/* Two treatments, because the five themes are not all dark. Sinking the page
   into a deep ground means darkening it; sinking the same page into
   Editorial's ecru means the opposite — darkening there would make the photo
   the LOUDEST thing in the frame, which is precisely what this variant must
   not do. The branch is on measured luminance, not on a theme id, so a theme
   added later lands on the correct side of it by itself. */
${
  P.dark
    ? `.photo{opacity:.5}
.photo img{filter:grayscale(.68) contrast(1.25) brightness(.46) blur(${Math.round(w * 0.006)}px)}
.photo .mark{mix-blend-mode:screen;opacity:.92}
.scrim{position:absolute;inset:0;
  background:linear-gradient(180deg,${alpha(P.ground, 0.62)} 0%,${alpha(P.ground, 0.8)} 46%,${alpha(P.ground, 0.94)} 100%)}`
    : `.photo{opacity:.5;mix-blend-mode:multiply}
.photo img{filter:grayscale(.6) contrast(.82) brightness(1.06) blur(${Math.round(w * 0.006)}px)}
.photo .mark{mix-blend-mode:multiply;opacity:.9}
.scrim{position:absolute;inset:0;
  background:linear-gradient(180deg,${alpha(P.ground, 0.5)} 0%,${alpha(P.ground, 0.7)} 46%,${alpha(P.ground, 0.88)} 100%)}`
}
.panel{left:${pad}px;right:${pad}px;top:${pad + Math.round(h * (portrait ? 0.1 : 0.14))}px;
  bottom:${pad + safeB + Math.round(h * (portrait ? 0.07 : 0.1))}px;gap:${gap}px;justify-content:center}
.fit{font-size:${fitMax}px;text-transform:uppercase;letter-spacing:-0.022em;
  text-shadow:0 ${Math.round(h * 0.006)}px ${Math.round(h * 0.02)}px ${alpha(P.ground, 0.6)}}
.eyebrow{position:absolute;left:${pad}px;top:${pad}px;right:${pad}px}
.chip{left:${pad}px;bottom:${pad + Math.round(safeB * 0.4)}px}
`;
    body =
      ground +
      (photo
        ? photoLayer(P, photo, focus, `left:0;top:0;width:${w}px;height:${h}px`, w, h, { lines: portrait ? 32 : 20, shade: 0.5 })
        : "") +
      `<div class="scrim"></div><div class="tex"></div>` +
      `<div class="panel">${fit}</div>` +
      eyebrow +
      (cta ? `<div class="chip">${cta}</div>` : "");
  } else {
    // Type-led, banded. A solid field of the theme's own accent above a band of
    // the photographed page.
    //
    // This used to be a vertical split, type in a column beside the photo, and
    // the column was the problem: a headline's longest word sets its size, and
    // "performance" in a 560px column caps the type at about 90px — a third of
    // what the same words reach across the full frame. The type is the reason
    // this variant exists, so the photograph gave up the width instead.
    //
    // Putting the photograph at the BOTTOM is also the best answer to
    // YouTube's duration badge: something has to sit in that corner, and a
    // corner of a page crop is the one element here that loses nothing by
    // being covered.
    const fieldH = Math.round(h * (portrait ? 0.66 : 0.66));
    const seam = Math.round(h * (portrait ? 0.008 : 0.014));
    css = `
.field{position:absolute;left:0;top:0;width:${w}px;height:${fieldH}px;background:${P.accent}}
.fieldtex{position:absolute;left:0;top:0;width:${w}px;height:${fieldH}px;pointer-events:none;
  background:radial-gradient(90% 80% at 16% 10%, ${alpha("#ffffff", 0.17)} 0%, ${fade("#ffffff")} 66%),
             linear-gradient(180deg, ${fade("#000000")} 46%, ${alpha("#000000", 0.2)} 100%)}
.seam{position:absolute;left:0;right:0;top:${fieldH}px;height:${seam}px;background:${P.ground}}
.panel{left:${pad}px;right:${pad}px;top:${pad}px;height:${fieldH - pad * 2}px;gap:${Math.round(gap * 0.7)}px;
  justify-content:flex-start;color:${P.onAccent}}
/* Headline and supporting line sit together at the FOOT of the field, so the
   air above them reads as a poster's negative space rather than as a gap the
   layout failed to fill. */
.fitbox{align-items:flex-end}
.etext{color:${alpha(P.onAccent, 0.82)}}
.ebar{background:${P.onAccent}}
.sub{color:${alpha(P.onAccent, 0.8)}}
.fit{font-size:${fitMax}px;color:${P.onAccent};letter-spacing:-0.034em}
/* The band is the quietest element here, not the loudest: it is evidence
   under a headline, and an unmodified page photograph is brighter than any
   accent field it sits below. */
.photo img{filter:contrast(1.2) saturate(.82) brightness(.92)}
/* A photographed page is brighter than any accent field above it, so without
   this the eye lands on the evidence instead of the claim. The band fades into
   the ground at its own bottom edge, which is also where YouTube's chrome
   arrives. */
.bandshade{position:absolute;left:0;right:0;top:${fieldH + seam}px;bottom:0;pointer-events:none;
  background:linear-gradient(180deg, ${alpha(P.ground, 0.16)} 0%, ${alpha(P.ground, 0.06)} 34%, ${alpha(P.ground, 0.5)} 100%)}
/* On a field that is already the accent, the keyword inverts instead: a slab
   of marker on a slab of accent is two saturated colours fighting, and at
   200px the pair reads as mud. */
/* Still a background IMAGE, not a background-color: the sized, positioned band
   is what keeps the slab inside its own line, and a flat colour would paint
   the full inline box and strike through the line above — which it did. */
.kw{color:${P.accent};
  background-image:linear-gradient(180deg,${P.onAccent} 0%,${P.onAccent} 100%)}
`;
    body =
      ground +
      photoLayer(
        P,
        photo,
        focus,
        `left:0;top:${fieldH + seam}px;width:${w}px;height:${h - fieldH - seam}px`,
        w,
        h - fieldH - seam,
        { lines: portrait ? 7 : 4, shade: 0.92 },
      ) +
      `<div class="bandshade"></div>` +
      `<div class="field"></div><div class="fieldtex"></div><div class="seam"></div>` +
      `<div class="panel">${eyebrow}${fit}${sub && portrait ? `<div class="sub">${sub}</div>` : ""}</div>`;
  }

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<style>${baseCss(a, P)}${css}</style></head>` +
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
