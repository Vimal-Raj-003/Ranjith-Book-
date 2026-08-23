import type { BookTheme } from "./theme-contract";
import type { SweepStep, CameraKey } from "../sweep";
import type { CaptionLine } from "../../media/captions";
import type { ContentPackage } from "../../content/schema";
import type { BeatAudio } from "../../media/tts";

/**
 * The page before the marker: a moment for the photograph to settle on screen
 * before the first word is spoken, so the highlight never starts mid-motion.
 */
export const AUDIO_OFFSET = 0.7;
/** How long the CTA card holds after the last word, so it can be read. */
export const OUTRO_TAIL = 1.8;
export const FRAME = { width: 1080, height: 1920 };
export const FPS = 30;

/* ===========================================================================
 * Frame layout — spec 2026-08-23 §1 (binding constants)
 *
 * Every workstream shares these numbers, which is why they are exported rather
 * than left as locals: the controller (`pipeline.ts`) needs them to size the
 * camera, and the thumbnail renderer needs them to crop the same way the video
 * frames.
 *
 *   y=0     progress bar, full width, PROGRESS_H tall
 *   y=250   card top          ┐
 *   ...     the photographed  │ CARD_H = 1120, CARD_X = 60, CARD_W = 960
 *   y=1370  card bottom       ┘
 *   y=1450  cue / annotation band
 *   y=1720  caption baseline
 *   y=1920  bottom 200px deliberately left clear of Instagram's own chrome
 * ======================================================================== */

/** Height of the top progress bar. */
export const PROGRESS_H = 8;
/** Left edge of the paper card. */
export const CARD_X = 60;
/** Width of the paper card. Also the numerator of `columnScale`. */
export const CARD_W = 960;
/** Top edge of the paper card. */
export const CARD_Y = 250;
/** Height of the paper card — the visible window onto the scrolling column. */
export const CARD_H = 1120;
/** Corner radius of the paper card. */
export const CARD_RADIUS = 28;

/**
 * `.caption-line` is deliberately positioned with `top` + `transform`, not
 * the more obvious `left:50%; bottom:200px; transform:translateX(-50%)`.
 *
 * (This constant was `CAPTION_TOP = FRAME.height - 130` before spec
 * 2026-08-23 §2.4 moved the baseline up to 1720; the investigation below is
 * what it recorded, and it applies unchanged to every element on this frame
 * whose visibility is driven by `autoAlpha` — the hook card and the CTA card
 * included, which is why both of those are positioned with `top` too.)
 *
 * Verified against real `hyperframes render`/`snapshot` output (not just the
 * in-repo Playwright harnesses, which drive the GSAP timeline directly and
 * never exercised the real renderer's own paint path): an absolutely
 * positioned element whose visibility is driven by a GSAP `autoAlpha` tween
 * AND whose position is expressed with `bottom` never painted at all —
 * opacity 0 forever, no error anywhere, identical markup and timing
 * otherwise. The same element at the exact same pixel position expressed
 * with `top` instead (and a matching `translateY(-100%)` to keep its BOTTOM
 * edge anchored, so a two-line caption still grows upward the way a
 * one-line one does) rendered correctly. Isolated by swapping only that one
 * property with everything else held constant; not a container-sizing or
 * z-index issue — `.cue` sits in an identically full-inset ancestor and
 * uses `top` already, which is why it never showed this failure.
 *
 * 1720 rather than the old 1790: the bottom ~200px of a Reel is covered by
 * Instagram's own like/comment/caption chrome, so a caption sitting there is
 * a caption nobody can read.
 */
export const CAPTION_BASELINE = 1720;

/**
 * Where the cue / annotation band sits — between the card's bottom edge
 * (1370) and the caption's own top edge (roughly 1640 once `translateY(-100%)`
 * is applied to a one-line caption). The cue used to sit at `top:64px`, which
 * is now inside the progress-bar/brand strip above the card.
 */
const CUE_TOP = 1450;

/** Fade durations for captions/cues — short enough to read as a cut, not a dissolve. */
const CAPTION_FADE = 0.15;
const CUE_FADE = 0.2;
/** The hook card's dissolve into the page, and the CTA end card's fade in. */
const HOOK_FADE = 0.35;
const CTA_FADE = 0.35;
/** The card's page-change pop: how far it starts scaled up, and for how long. */
const POP_FROM = 1.04;
const POP_DUR = 0.5;

/**
 * The scale that maps COLUMN space (the 1600px-long-edge derivative's pixel
 * space, which every OCR box, line run, sweep step and camera key is measured
 * in) onto the card.
 *
 * Nothing is ever re-measured or rescaled: the column keeps its own pixel
 * coordinates and GSAP keeps tweening `y` on `.column` in unscaled column
 * pixels. This number lives on a separate `.scaler` ancestor as a STATIC CSS
 * transform, because GSAP writes the whole `transform` property when it tweens
 * `y` — a scale on `.column` itself would be overwritten by the first camera
 * tween and the page would jump to full size mid-video.
 *
 * A zero, negative, NaN or infinite `columnWidth` returns 1 rather than
 * Infinity/NaN: an unmeasurable page must degrade to "unscaled", not poison
 * the CSS transform (a `scale(NaN)` is dropped by the browser, silently
 * leaving the column at full size and overflowing the card) and not poison
 * `cardViewportHeight` downstream, which would hand `cameraTrack` a
 * non-finite frame height.
 */
export function columnScale(columnWidth: number): number {
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) return 1;
  return CARD_W / columnWidth;
}

/**
 * The card's height expressed in COLUMN space — what `cameraTrack` must be
 * given as its `frameHeight`, in place of `FRAME.height`.
 *
 * `cameraTrack` computes `maxY = pageHeight - frameHeight` and centres the
 * active stroke in the middle third of `frameHeight`, both in column pixels.
 * The window the viewer actually sees is the card: `CARD_H` device pixels,
 * which is `CARD_H / s` column pixels — about 1283 for a typical 1600-long-edge
 * portrait page, NOT 1920.
 *
 * Passing `FRAME.height` (1920) instead is the single highest-risk line in
 * this change, and it fails in both directions at once:
 *
 *  - `maxY` is computed against a window ~640 column pixels TALLER than the
 *    real one, so the camera stops scrolling ~640 column pixels early and the
 *    last stretch of the last page is never brought into the card at all —
 *    the marker keeps advancing down the column, runs off the bottom of the
 *    card, and highlights words nobody can see.
 *  - The "middle third" the stroke is centred in is a third of 1920, not a
 *    third of 1283, so even mid-document the marker is parked below the card's
 *    real centre and drifts out of the bottom of the frame.
 *
 * Both failures look like a highlight-timing bug and are not one, which is why
 * this is a named function rather than an inline division at the call site.
 */
export function cardViewportHeight(columnWidth: number): number {
  return CARD_H / columnScale(columnWidth);
}

export interface CompositionInput {
  pkg: ContentPackage;
  beats: BeatAudio[];
  captions: CaptionLine[];
  /** The DERIVED page images (1600px long edge) — the same coordinate space every
   * OCR box, line run, sweep step and camera key was measured in. Never rescaled. */
  pages: { src: string; width: number; height: number }[];
  /** One entry per beat in `pkg.beats`/`beats`, not per page — `sweepForBeat` is
   * called once per beat, so `sweeps[i]` is beat `i`'s strokes. */
  sweeps: SweepStep[][];
  camera: CameraKey[];
  theme: BookTheme;
  /** Measured length of the mastered voice track (`VoiceoverResult.totalDuration`). */
  totalDuration: number;
  /**
   * Whether a music bed (`assets/music.wav`, from `generateMusicBed`) was
   * produced for this render. Generating the bed can fail — a synthesis
   * error, a missing ffmpeg binary — and a missing bed must never sink the
   * render (same contract as `writeProject`'s own best-effort copy), so this
   * flag exists to skip the `<audio>` element entirely rather than reference
   * a file that was never written. When present, the element spans the FULL
   * composition duration (0 to `duration`), not just `totalDuration` like the
   * voice track: the bed is what is meant to carry the CTA's outro hold,
   * which is exactly the stretch the voice track never covers.
   */
  music?: boolean;
}

/**
 * `<` is escaped inside the embedded JSON because a single `</script>` anywhere
 * in book text closes the tag early, GSAP never runs, and the render comes out
 * blank — a failure that looks like a renderer bug and is not.
 */
function embed(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * The other embedding site: text written directly into the page as markup
 * (the on-screen cue label, the hook, the call to action), rather than into
 * JSON read back by JavaScript. A `.textContent` assignment never needs this
 * — the DOM API does not parse its argument as markup — but anything the
 * server writes as literal HTML does, and a `</script>` here would close the
 * tag just as early as one inside the JSON payload. Escaping only the JSON
 * site and not this one is exactly the "not just one site" failure this
 * function exists to prevent.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Cumulative top offset of each page inside the one scrolling column. */
function offsetsFor(pages: { width: number; height: number }[]): number[] {
  const offsets: number[] = [];
  let y = 0;
  for (const p of pages) {
    offsets.push(y);
    y += p.height;
  }
  return offsets;
}

interface StrokeDatum {
  x: number;
  y: number;
  w: number;
  h: number;
  start: number;
  end: number;
}

/**
 * Flatten every beat's sweep steps into one ordered list of strokes, each
 * positioned in COLUMN space: the box's own (page-local) x, plus that beat's
 * page offset added to the box's y. `sweeps[i]` belongs to `pkg.beats[i]` —
 * `sweepForBeat` is called once per beat, never once per page — so a beat's
 * `sourcePage` is what resolves which page offset its strokes take.
 *
 * Timestamps are shifted by `shift` (`AUDIO_OFFSET`) so they land on the same
 * clock the composition's audio element actually starts on.
 */
function flattenStrokes(
  pkg: ContentPackage,
  sweeps: SweepStep[][],
  offsets: number[],
  pageCount: number,
  shift: number,
): StrokeDatum[] {
  const out: StrokeDatum[] = [];
  pkg.beats.forEach((beat, i) => {
    const steps = sweeps[i] ?? [];
    if (steps.length === 0) return;
    const pageIndex = pageIndexOf(beat.sourcePage, pageCount);
    const offset = offsets[pageIndex] ?? 0;
    for (const step of steps) {
      out.push({
        x: step.box.x0,
        y: offset + step.box.y0,
        w: Math.max(0, step.box.x1 - step.box.x0),
        h: Math.max(0, step.box.y1 - step.box.y0),
        start: shift + step.start,
        end: shift + step.end,
      });
    }
  });
  return out;
}

/** The one place a beat's declared `sourcePage` is clamped into the pages array. */
function pageIndexOf(sourcePage: number, pageCount: number): number {
  return Math.min(Math.max(sourcePage, 0), Math.max(pageCount - 1, 0));
}

function pageMarkup(page: { src: string; width: number; height: number }, offset: number): string {
  return `<div class="page" style="top:${offset}px;width:${page.width}px;height:${page.height}px;"><img src="${esc(page.src)}" width="${page.width}" height="${page.height}" alt="" /></div>`;
}

/**
 * The on-screen label lives in the shared skeleton, not the theme, even though
 * it is styled by the theme's CSS (`.annot` in Marginalia): WHERE it sits and
 * WHEN it shows/hides is timing and layout, which the theme contract does not
 * own. Only its look is themed.
 */
function cueMarkup(pkg: ContentPackage): string {
  return pkg.beats
    .map((b, i) => `<div class="cue annot" data-cue="${i}">${esc(b.onScreen)}</div>`)
    .join("\n");
}

/**
 * Text is baked into the markup at build time, the same way `cueMarkup`
 * above does it — NOT left blank and filled in later by
 * `el.textContent = ...` in the runtime script. Verified against a real
 * `hyperframes snapshot`/render (not just the in-repo Playwright harnesses,
 * which drive the timeline directly and never exercised this path): a
 * caption line built the JS-assigned way sits at its `autoAlpha:0` rest
 * state for the entire video with no error reported anywhere, while a cue —
 * built exactly like this, text already present in the DOM at load — fades
 * in and out correctly. The renderer's own static analysis pass runs over
 * the page before the runtime script populates anything, so an element
 * that is empty at that point never becomes visible content it will render.
 *
 * The same rule is why `hookMarkup` and `ctaMarkup` below bake their text in
 * too, rather than the runtime script writing `pkg.hook` into an empty div.
 */
function captionMarkup(captions: CaptionLine[]): string {
  return captions
    .map((c, i) => `<div class="caption-line" data-caption="${i}">${esc(c.text)}</div>`)
    .join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The hook, with every occurrence of a `hookKeywords` entry wrapped in the
 * accent span — the one thing the model already generates, dedupes against
 * past videos and stores, and which until now had zero consumers anywhere.
 *
 * Matching is case-insensitive and on word boundaries expressed as
 * lookarounds over letters/digits rather than `\b`, so a keyword that begins
 * or ends with punctuation (or a non-ASCII letter, which `\b` gets wrong)
 * still matches only whole words. Longer keywords are tried first, so an
 * entry that contains another entry is not chopped up by it.
 *
 * Every branch escapes with `esc()`. That is not incidental: the hook is
 * model-written text about a scanned book, this function splices raw HTML
 * (`<span>`) around slices of it, and a `</script>` reaching the document
 * unescaped has blanked an entire render before.
 *
 * `hookKeywords` is optional in `ContentPackage` and is routinely absent,
 * empty, or full of words that never appear in the hook. All three return
 * the plain escaped hook rather than throwing.
 */
export function hookMarkup(hook: string, keywords?: string[]): string {
  const keys = (keywords ?? [])
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .sort((a, b) => b.length - a.length);

  if (keys.length === 0) return esc(hook);

  let re: RegExp;
  try {
    re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${keys.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  } catch {
    // A keyword that cannot be compiled into a pattern is a reason to render
    // the hook plain, never a reason to fail the whole render.
    return esc(hook);
  }

  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(hook)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out += esc(hook.slice(last, match.index));
    out += `<span class="hook-key">${esc(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + esc(hook.slice(last));
}

/**
 * Page-change pops (spec §2.3). One `fromTo` per page change, on the
 * dedicated `.card-pop` wrapper that receives no other tween.
 *
 * The times come from the beats, not from the camera keys: a camera key moves
 * whenever the marker moves, several times within one page, whereas the card
 * should only kick when the photograph under it actually changes. A beat's
 * `sourcePage` is clamped through the same `pageIndexOf` the strokes use, so
 * two beats naming out-of-range pages do not fake a page change between them.
 *
 * Each pop's duration is clipped to stop before the next pop starts. Two
 * overlapping `fromTo`s on one property of one element are order-dependent,
 * and order is exactly what a seek does not preserve.
 */
function popTimes(
  pkg: ContentPackage,
  beats: BeatAudio[],
  pageCount: number,
  shift: number,
  duration: number,
): { t: number; d: number }[] {
  // Deliberately NOT seeded with t=0. A pop at zero is a special case in two
  // ways and worth neither: the hook card's scrim covers the whole frame at
  // t=0 so nobody can see it, and GSAP renders a `fromTo` sitting exactly at
  // the playhead's own origin at its END value on the very first render and
  // its FROM value once initted — a one-frame discontinuity at frame 0 for an
  // effect that is invisible there anyway. The first page arrives by the hook
  // dissolving off it, which is a better reveal than a kick.
  const times: number[] = [];
  let prevPage: number | null = null;
  pkg.beats.forEach((beat, i) => {
    const page = pageIndexOf(beat.sourcePage, pageCount);
    if (prevPage !== null && page !== prevPage) {
      const t = shift + (beats[i]?.start ?? 0);
      if (Number.isFinite(t) && t > 0 && t < duration) times.push(t);
    }
    prevPage = page;
  });

  const sorted = Array.from(new Set(times)).sort((a, b) => a - b);
  return sorted.map((t, i) => {
    const next = sorted[i + 1] ?? duration;
    // 0.01 of clearance, so two pops never share an instant even after the
    // renderer rounds a timestamp to a frame.
    const d = Math.max(0.05, Math.min(POP_DUR, next - t - 0.01));
    return { t, d };
  });
}

function sharedCss(theme: BookTheme): string {
  const p = theme.palette;
  return `
  * , *::before, *::after { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:${p.backdropDeep}; }
  .stage { position:relative; width:${FRAME.width}px; height:${FRAME.height}px; overflow:hidden;
           background:${p.backdropDeep}; }
  .backdrop { position:absolute; inset:0;
              background: radial-gradient(120% 70% at 50% 22%, ${p.backdropBase} 0%, ${p.backdropDeep} 100%); }

  /* --- progress bar (§2.6): one scaleX 0->1 over the whole duration ------- */
  .progress-track { position:absolute; left:0; top:0; width:${FRAME.width}px; height:${PROGRESS_H}px;
                    background:${p.progressTrack}; overflow:hidden; }
  .progress-fill { position:absolute; left:0; top:0; width:${FRAME.width}px; height:${PROGRESS_H}px;
                   background:${p.progressFill}; transform-origin:left center; transform:scaleX(0); }

  /* --- the card: the window the page scrolls INSIDE ----------------------- */
  /* .card never moves and is never tweened. .card-pop is the ONLY element the
     pop scale touches. .scaler carries the static column->card scale, which
     GSAP must never write, because GSAP writes the whole transform property
     when it tweens .column's y. */
  .card { position:absolute; left:${CARD_X}px; top:${CARD_Y}px; width:${CARD_W}px; height:${CARD_H}px;
          border-radius:${CARD_RADIUS}px; overflow:hidden; background:${p.cardFace};
          box-shadow: 0 42px 90px -24px ${p.cardShadow}, 0 0 0 1px ${p.cardEdge}; }
  .card-pop { position:absolute; inset:0; transform-origin:50% 50%; }
  .scaler { position:absolute; left:0; top:0; transform-origin: top left; }
  .column { position:relative; }
  .page { position:absolute; left:0; }
  .page img { display:block; width:100%; height:100%; object-fit:cover; }
  .stroke { position:absolute; transform-origin:left center; }

  .cues { position:absolute; inset:0; pointer-events:none; }
  .cue { position:absolute; top:${CUE_TOP}px; left:50%; transform:translateX(-50%) rotate(-4deg);
         padding:10px 22px; border-radius:6px; opacity:0; visibility:hidden;
         white-space:nowrap; }
  .captions { position:absolute; inset:0; pointer-events:none; }
  .caption-line { position:absolute; left:50%; top:${CAPTION_BASELINE}px;
                  transform:translate(-50%, -100%);
                  max-width:920px; width:max-content; text-align:center; font-size:60px;
                  font-weight:800; line-height:1.2; padding:16px 30px; border-radius:20px;
                  opacity:0; visibility:hidden; font-family: Inter, system-ui, sans-serif;
                  background:${p.captionBg}; color:${p.captionInk}; }

  /* --- hook card (§2.2) --------------------------------------------------- */
  /* Rest state is VISIBLE: the hook owns t=0, so a render that never ran the
     timeline at all still shows it rather than a blank first frame.
     It is the LAST full-frame layer, so its scrim also covers beat 0's cue
     and caption for as long as it holds. That is deliberate: the hook at 76px
     is what the first second is FOR, and stacking a 60px caption of the same
     beat's narration under it is two competing headlines, not two pieces of
     information. */
  .hook { position:absolute; inset:0; pointer-events:none; opacity:1; visibility:visible; }
  .hook-scrim { position:absolute; inset:0; background:${p.hookScrim};
                backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
  .hook-text { position:absolute; left:50%; top:${Math.round(CARD_Y + CARD_H / 2)}px;
               transform:translate(-50%, -50%);
               width:900px; text-align:center; font-size:76px; font-weight:800; line-height:1.14;
               font-family: Inter, system-ui, sans-serif; color:${p.hookInk};
               letter-spacing:-0.5px; }
  .hook-key { color:${p.accent}; }

  /* --- CTA end card (§2.5) ------------------------------------------------ */
  .cta-card { position:absolute; left:${CARD_X + 40}px; top:${Math.round(CARD_Y + CARD_H / 2 - 200)}px;
              width:${CARD_W - 80}px; padding:56px 48px; border-radius:${CARD_RADIUS}px;
              text-align:center; font-family: Inter, system-ui, sans-serif;
              background:${p.ctaFace}; color:${p.ctaInk};
              opacity:0; visibility:hidden; }
  .cta-kicker { font-size:30px; font-weight:800; letter-spacing:6px; text-transform:uppercase;
                color:${p.accent}; margin-bottom:22px; }
  .cta-text { font-size:58px; font-weight:800; line-height:1.2; }
`;
}

/**
 * The runtime script. It only ever reads timing/geometry from the JSON payload
 * — no book text is ever interpolated into this string, so it carries no
 * escaping risk of its own.
 */
const TIMELINE_JS = `
(function () {
  var CAPTION_FADE = ${CAPTION_FADE};
  var CUE_FADE = ${CUE_FADE};
  var HOOK_FADE = ${HOOK_FADE};
  var CTA_FADE = ${CTA_FADE};
  var raw = document.getElementById("composition-data").textContent;
  var data = JSON.parse(raw);
  var column = document.getElementById("column");
  var tl = gsap.timeline({ paused: true });

  data.strokes.forEach(function (s, i) {
    var el = document.querySelector('[data-stroke="' + i + '"]');
    if (!el) return;
    el.style.left = s.x + "px";
    el.style.top = s.y + "px";
    el.style.width = s.w + "px";
    el.style.height = s.h + "px";
    gsap.set(el, { scaleX: 0 });
    tl.to(el, { scaleX: 1, duration: Math.max(0.001, s.end - s.start), ease: "none" }, s.start);
  });

  // The camera tweens \`y\` on .column in UNSCALED COLUMN PIXELS, exactly as it
  // did before the card existed. The column->card scale lives on .scaler, a
  // separate ancestor, precisely so this tween — which rewrites the whole
  // transform property — cannot clobber it.
  var prevY = null;
  data.camera.forEach(function (key, i) {
    if (prevY !== null && key.y === prevY) return;
    var next = data.camera[i + 1];
    var dur = next ? Math.max(0.001, next.t - key.t) : Math.max(0.001, data.duration - key.t);
    tl.to(column, { y: -key.y, duration: dur, ease: "power2.inOut" }, key.t);
    prevY = key.y;
  });

  // The progress bar: one scaleX over the full duration, on an element nothing
  // else ever touches.
  var progress = document.getElementById("progress");
  if (progress) {
    gsap.set(progress, { scaleX: 0 });
    tl.to(progress, { scaleX: 1, duration: Math.max(0.001, data.duration), ease: "none" }, 0);
  }

  // The page-change pop. Several non-overlapping fromTo scale tweens on ONE
  // dedicated wrapper that receives no other tween — see popTimes() and the
  // .card-pop CSS comment. Proven by scripts/e2e-seek.mjs, which tracks
  // .card-pop explicitly.
  var pop = document.getElementById("card-pop");
  if (pop) {
    gsap.set(pop, { scale: 1 });
    data.pops.forEach(function (p) {
      tl.fromTo(pop, { scale: p.from }, { scale: 1, duration: p.d, ease: "power2.out", immediateRender: false }, p.t);
    });
  }

  var capEls = document.querySelectorAll(".caption-line");
  data.captions.forEach(function (line, i) {
    var el = capEls[i];
    if (!el) return;
    // Text is already in the DOM (see captionMarkup's doc comment) — not
    // assigned here.
    tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: CAPTION_FADE, ease: "none", immediateRender: false }, line.start);
    // A "held" line (the last beat's, i.e. the CTA's) never fades out — there is
    // nothing after it to cut to, so it stays on screen through the outro tail
    // instead of going dark at its own beat's end.
    if (!line.hold) {
      tl.to(el, { autoAlpha: 0, duration: CAPTION_FADE, ease: "none" }, Math.max(line.start + CAPTION_FADE + 0.01, line.end - CAPTION_FADE));
    }
  });

  var cueEls = document.querySelectorAll(".cue");
  data.cues.forEach(function (cue, i) {
    var el = cueEls[i];
    if (!el) return;
    tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: CUE_FADE, ease: "none", immediateRender: false }, cue.start);
    if (!cue.hold) {
      tl.to(el, { autoAlpha: 0, duration: CUE_FADE, ease: "none" }, Math.max(cue.start + CUE_FADE + 0.01, cue.end - CUE_FADE));
    }
  });

  // The hook owns the frame from t=0, so it is NOT a fromTo: it rests visible
  // (CSS) and has exactly one tween, the fade-out at the end of beat 0. One
  // tween on one property of one element is the cheapest thing there is to
  // seek correctly.
  var hookEl = document.getElementById("hook");
  if (hookEl && data.hook) {
    gsap.set(hookEl, { autoAlpha: 1 });
    tl.to(hookEl, { autoAlpha: 0, duration: HOOK_FADE, ease: "none" }, data.hook.fadeAt);
  }

  // The CTA end card fades in where the outro tail begins and holds to the end
  // — again a single tween, never faded back out.
  var ctaEl = document.getElementById("cta-card");
  if (ctaEl && data.cta) {
    gsap.set(ctaEl, { autoAlpha: 0 });
    tl.fromTo(ctaEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: CTA_FADE, ease: "none", immediateRender: false }, data.cta.start);
  }

  // An explicit tail marker: a zero-duration, no-op set at the declared end of
  // the composition. Without it, when the last camera key is skipped (the
  // ordinary "camera settles, then holds for the CTA" shape — see the
  // zero-distance skip above) and the last cue/caption is held rather than
  // faded, nothing in the timeline actually reaches \`data.duration\`, and
  // GSAP's own tl.duration() falls short of what the document declares. A
  // renderer seeking by data-duration would still see the held state, but the
  // mismatch is real and misleading on its own, so it is closed here directly
  // rather than left to depend on some other tween happening to land there.
  tl.set({}, {}, data.duration);

  // The renderer drives the timeline it finds at window.__timelines, keyed
  // by the root's data-composition-id — see hyperframes-core's own
  // contract: each composition registers exactly one paused GSAP timeline
  // there. Without this, hyperframes' own check command flags
  // gsap_timeline_not_registered, and -- verified against a real render --
  // the renderer falls back to the composition's static initial DOM: every
  // stroke, caption and cue stayed at its rest state (opacity 0, scaleX 0)
  // for the whole video, with no error surfaced anywhere. That failure is
  // invisible to the composition test suite and to the seek-safety script,
  // both of which reach the timeline directly via window.__tl (kept below
  // for exactly that reason) rather than through the door the real
  // renderer uses.
  window.__tl = tl;
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
`;

export function buildComposition(input: CompositionInput): string {
  const { theme, pages, sweeps, camera, captions, pkg, beats, totalDuration, music } = input;

  // Includes AUDIO_OFFSET: the audio element itself starts at AUDIO_OFFSET, not
  // zero, so the declared duration must cover that lead-in too — a duration of
  // just totalDuration + OUTRO_TAIL would truncate the last AUDIO_OFFSET seconds
  // of the CTA hold, the exact failure this attribute exists to prevent.
  const duration = AUDIO_OFFSET + totalDuration + OUTRO_TAIL;

  const offsets = offsetsFor(pages);
  const columnWidth = pages.length ? Math.max(...pages.map((p) => p.width)) : FRAME.width;
  const columnHeight = pages.length ? offsets[offsets.length - 1] + pages[pages.length - 1].height : 0;
  const scale = columnScale(columnWidth);

  const strokes = flattenStrokes(pkg, sweeps, offsets, pages.length, AUDIO_OFFSET);
  const cameraData = camera.map((k) => ({ t: AUDIO_OFFSET + k.t, y: k.y }));

  // The last beat is the CTA. Its cue (and its FINAL caption line, if it has
  // one) must hold through the outro tail rather than fade out at the beat's
  // own clip end — `beat.end` lands exactly where OUTRO_TAIL begins, so
  // fading out there produces a video whose entire tail is a blank page.
  // `hold: true` tells the runtime script to skip that fade-out and leave the
  // element visible all the way to `duration`.
  //
  // Captions are one-to-many with beats (`buildCaptions` splits a beat's
  // speech into a new line every `wordsPerLine` words), so `hold` must never
  // be assigned by `beatIndex` alone — a multi-word CTA produces more than
  // one caption line whose `beatIndex` names the last beat, and marking every
  // one of them held skips ALL of their fade-outs, stacking an earlier line
  // on screen under the final one for as long as the beat's own narration
  // runs, well before the tail even begins. Only the LAST caption line in
  // the whole array — not every line naming the last beat — is held.
  const lastBeatIndex = pkg.beats.length - 1;
  const lastCaptionIndex = captions.length - 1;

  const captionData = captions.map((c, i) => ({
    text: c.text,
    start: AUDIO_OFFSET + c.start,
    end: AUDIO_OFFSET + c.end,
    hold: i === lastCaptionIndex && c.beatIndex === lastBeatIndex,
  }));
  const cueData = pkg.beats.map((_, i) => {
    const audio: BeatAudio | undefined = beats[i];
    const start = AUDIO_OFFSET + (audio?.start ?? 0);
    const end = AUDIO_OFFSET + (audio?.end ?? audio?.start ?? 0);
    return { start, end, hold: i === lastBeatIndex };
  });

  // --- Hook window (spec §2.2) ---------------------------------------------
  // t=0 to the end of beat 0 — the hook BEAT, `pkg.beats[0]`, whose measured
  // clip end is `beats[0].end`. A package with no beats at all (guarded
  // upstream, but this function is exported and must stand on its own) gets no
  // hook card rather than a card that never leaves the screen: with no beat 0
  // there is no honest moment to hand the page over at.
  const hookEnd = pkg.beats.length > 0 ? AUDIO_OFFSET + (beats[0]?.end ?? beats[0]?.start ?? 0) : 0;
  const showHook =
    pkg.beats.length > 0 && pkg.hook.trim().length > 0 && Number.isFinite(hookEnd) && hookEnd > 0;
  // The fade must START early enough to be FINISHED by the beat's end, not
  // begin there — a hook still dissolving over the second beat's narration is
  // the page arriving late, which is the retention problem this card exists to
  // solve, reintroduced at the other end.
  const hookData = showHook
    ? { end: hookEnd, fadeAt: Math.max(0, Math.min(hookEnd - HOOK_FADE, duration - HOOK_FADE)) }
    : null;

  // --- CTA end card (spec §2.5) --------------------------------------------
  // Starts where the outro tail begins (the last beat's own clip end), not at
  // the start of the CTA's narration: the last beat still has a marker sweep
  // running on the page, and covering it with an end card would hide the
  // highlight mid-word.
  const ctaStartRaw = lastBeatIndex >= 0 ? AUDIO_OFFSET + (beats[lastBeatIndex]?.end ?? totalDuration) : 0;
  const showCta = pkg.cta.trim().length > 0 && Number.isFinite(ctaStartRaw);
  const ctaData = showCta
    ? { start: Math.max(0, Math.min(ctaStartRaw, duration - CTA_FADE)) }
    : null;

  const pops = popTimes(pkg, beats, pages.length, AUDIO_OFFSET, duration).map((p) => ({
    t: p.t,
    d: p.d,
    from: POP_FROM,
  }));

  const data = embed({
    strokes,
    camera: cameraData,
    captions: captionData,
    cues: cueData,
    pops,
    hook: hookData,
    cta: ctaData,
    duration,
  });

  const pagesHtml = pages.map((p, i) => pageMarkup(p, offsets[i])).join("\n");
  const strokesHtml = strokes.map((_, i) => theme.strokeMarkup(i)).join("\n");

  const hookHtml = showHook
    ? `<div class="hook" id="hook">
      <div class="hook-scrim"></div>
      <div class="hook-text">${hookMarkup(pkg.hook, pkg.hookKeywords)}</div>
    </div>`
    : "";

  const ctaHtml = showCta
    ? `<div class="cta-card" id="cta-card">
      <div class="cta-kicker">BookReel</div>
      <div class="cta-text">${esc(pkg.cta)}</div>
    </div>`
    : "";

  // Track index 10, below the voice's 20: a bed sits under the narration, not
  // over it. Spans 0 → duration (not totalDuration) so it is the one thing
  // that is actually present through the outro tail — see the field doc on
  // `music` above.
  const musicHtml = music
    ? `<audio id="music" src="assets/music.wav" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="10" data-volume="1"></audio>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${FRAME.width}, height=${FRAME.height}" />
<title>${esc(pkg.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${sharedCss(theme)}${theme.css()}</style>
</head>
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="${FRAME.width}" data-height="${FRAME.height}" data-duration="${duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0">
    ${theme.backdrop()}
    <div class="progress-track"><div class="progress-fill" id="progress"></div></div>
    <div class="card" id="card">
      <div class="card-pop" id="card-pop">
        ${theme.cardFace()}
        <div class="scaler" style="transform:scale(${scale.toFixed(6)});">
          <div class="column" id="column" style="width:${columnWidth}px;height:${columnHeight}px;">
            ${pagesHtml}
            ${strokesHtml}
          </div>
        </div>
      </div>
    </div>
    ${theme.overlay()}
    <div class="cues">
      ${cueMarkup(pkg)}
    </div>
    <div class="captions" id="captions">
      ${captionMarkup(captions)}
    </div>
    ${hookHtml}
    ${ctaHtml}
    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${totalDuration.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    ${musicHtml}
  </div>
</div>
<script id="composition-data" type="application/json">${data}</script>
<script>${TIMELINE_JS}</script>
</body>
</html>`;
}
