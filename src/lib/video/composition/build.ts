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

/** Fade durations for captions/cues — short enough to read as a cut, not a dissolve. */
const CAPTION_FADE = 0.15;
const CUE_FADE = 0.2;

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
 * (the on-screen cue label), rather than into JSON read back by JavaScript.
 * A `.textContent` assignment never needs this — the DOM API does not parse
 * its argument as markup — but anything the server writes as literal HTML
 * does, and a `</script>` here would close the tag just as early as one
 * inside the JSON payload. Escaping only the JSON site and not this one is
 * exactly the "not just one site" failure this function exists to prevent.
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
    const pageIndex = Math.min(Math.max(beat.sourcePage, 0), Math.max(pageCount - 1, 0));
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

function captionMarkup(captions: CaptionLine[]): string {
  return captions.map((_, i) => `<div class="caption-line" data-caption="${i}"></div>`).join("\n");
}

const SHARED_CSS = `
  * , *::before, *::after { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#000; }
  .stage { position:relative; width:${FRAME.width}px; height:${FRAME.height}px; overflow:hidden;
           display:flex; justify-content:center; }
  .column { position:relative; }
  .page { position:absolute; left:0; }
  .page img { display:block; width:100%; height:100%; object-fit:cover; }
  .stroke { position:absolute; transform-origin:left center; }
  .cues { position:absolute; inset:0; pointer-events:none; }
  .cue { position:absolute; top:64px; left:50%; transform:translateX(-50%) rotate(-4deg);
         padding:10px 22px; border-radius:6px; opacity:0; visibility:hidden;
         white-space:nowrap; }
  .captions { position:absolute; left:0; right:0; bottom:130px; display:flex;
              justify-content:center; padding:0 60px; pointer-events:none; }
  .caption-line { position:absolute; max-width:900px; text-align:center; font-size:52px;
                  font-weight:700; line-height:1.25; padding:14px 28px; border-radius:18px;
                  opacity:0; visibility:hidden; font-family: Inter, system-ui, sans-serif; }
`;

/**
 * The runtime script. It only ever reads timing/geometry from the JSON payload
 * — no book text is ever interpolated into this string, so it carries no
 * escaping risk of its own.
 */
const TIMELINE_JS = `
(function () {
  var CAPTION_FADE = ${CAPTION_FADE};
  var CUE_FADE = ${CUE_FADE};
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

  var prevY = null;
  data.camera.forEach(function (key, i) {
    if (prevY !== null && key.y === prevY) return;
    var next = data.camera[i + 1];
    var dur = next ? Math.max(0.001, next.t - key.t) : Math.max(0.001, data.duration - key.t);
    tl.to(column, { y: -key.y, duration: dur, ease: "power2.inOut" }, key.t);
    prevY = key.y;
  });

  var capEls = document.querySelectorAll(".caption-line");
  data.captions.forEach(function (line, i) {
    var el = capEls[i];
    if (!el) return;
    el.textContent = line.text;
    tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: CAPTION_FADE, ease: "none", immediateRender: false }, line.start);
    tl.to(el, { autoAlpha: 0, duration: CAPTION_FADE, ease: "none" }, Math.max(line.start + CAPTION_FADE + 0.01, line.end - CAPTION_FADE));
  });

  var cueEls = document.querySelectorAll(".cue");
  data.cues.forEach(function (cue, i) {
    var el = cueEls[i];
    if (!el) return;
    tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: CUE_FADE, ease: "none", immediateRender: false }, cue.start);
    tl.to(el, { autoAlpha: 0, duration: CUE_FADE, ease: "none" }, Math.max(cue.start + CUE_FADE + 0.01, cue.end - CUE_FADE));
  });

  window.__tl = tl;
})();
`;

export function buildComposition(input: CompositionInput): string {
  const { theme, pages, sweeps, camera, captions, pkg, beats, totalDuration } = input;

  // Includes AUDIO_OFFSET: the audio element itself starts at AUDIO_OFFSET, not
  // zero, so the declared duration must cover that lead-in too — a duration of
  // just totalDuration + OUTRO_TAIL would truncate the last AUDIO_OFFSET seconds
  // of the CTA hold, the exact failure this attribute exists to prevent.
  const duration = AUDIO_OFFSET + totalDuration + OUTRO_TAIL;

  const offsets = offsetsFor(pages);
  const columnWidth = pages.length ? Math.max(...pages.map((p) => p.width)) : FRAME.width;
  const columnHeight = pages.length ? offsets[offsets.length - 1] + pages[pages.length - 1].height : 0;

  const strokes = flattenStrokes(pkg, sweeps, offsets, pages.length, AUDIO_OFFSET);
  const cameraData = camera.map((k) => ({ t: AUDIO_OFFSET + k.t, y: k.y }));
  const captionData = captions.map((c) => ({
    text: c.text,
    start: AUDIO_OFFSET + c.start,
    end: AUDIO_OFFSET + c.end,
  }));
  const cueData = pkg.beats.map((_, i) => {
    const audio: BeatAudio | undefined = beats[i];
    const start = AUDIO_OFFSET + (audio?.start ?? 0);
    const end = AUDIO_OFFSET + (audio?.end ?? audio?.start ?? 0);
    return { start, end };
  });

  const data = embed({ strokes, camera: cameraData, captions: captionData, cues: cueData, duration });

  const pagesHtml = pages.map((p, i) => pageMarkup(p, offsets[i])).join("\n");
  const strokesHtml = strokes.map((_, i) => theme.strokeMarkup(i)).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${FRAME.width}, height=${FRAME.height}" />
<title>${esc(pkg.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${SHARED_CSS}${theme.css()}</style>
</head>
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="${FRAME.width}" data-height="${FRAME.height}" data-duration="${duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0">
    ${theme.backdrop()}
    <div class="column" id="column" style="width:${columnWidth}px;height:${columnHeight}px;">
      ${pagesHtml}
      ${strokesHtml}
    </div>
    ${theme.overlay()}
    <div class="cues">
      ${cueMarkup(pkg)}
    </div>
    <div class="captions" id="captions">
      ${captionMarkup(captions)}
    </div>
    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${totalDuration.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
  </div>
</div>
<script id="composition-data" type="application/json">${data}</script>
<script>${TIMELINE_JS}</script>
</body>
</html>`;
}
