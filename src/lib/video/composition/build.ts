import type { BookTheme } from "./theme-contract";
import { embed, esc } from "./escape";
import { renderScene, sceneCss, SCENE_FADE, type SceneAnim } from "../scenes/render";
import { PAGE_KINDS, type Scene, type SceneTone } from "../scenes/types";
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
 * The persistent byline under the card (spec 2026-08-23 §9): book title, and
 * the author ONLY when the four-link verification chain passed upstream.
 *
 * 1388 is 18px below the card's bottom edge (1370) and well clear of the cue
 * band at 1450 — the byline is a caption for the object above it, not a third
 * competing text layer.
 *
 * It carries NO tween at all. That is the cheapest thing there is to seek
 * correctly, and it is also what "persistent" means: the title is on screen
 * for every frame of the video, including the ones a viewer screenshots.
 */
export const BYLINE_Y = 1388;

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
/**
 * The hard ceiling on how long the hook card sits over the page, in seconds.
 *
 * Chosen so the card is COMPLETELY GONE inside four seconds — the operator's
 * limit — not merely starting to fade there: the fade begins at
 * `HOOK_MAX_VISIBLE - HOOK_FADE`, so the last frame carrying any of it lands
 * at 3.5s. A Short has about two seconds to earn the next twenty; a card that
 * outstays that is costing the thing it was built to buy.
 */
export const HOOK_MAX_VISIBLE = 3.5;
const CTA_FADE = 0.35;
/** The card's page-change pop: how far it starts scaled up, and for how long. */
const POP_FROM = 1.04;
const POP_DUR = 0.5;
/** The purchase card's fade-in, and how long after the CTA card it follows. */
const BUY_FADE = 0.35;
const BUY_DELAY = 0.45;

/* ===========================================================================
 * Motion — spec 2026-08-23 §8. "Humanised", and every bit of it seek-safe.
 *
 * Both effects below live on their OWN elements, and the choice of element is
 * the entire safety argument, not a detail:
 *
 *  - NEVER `.scaler`. It carries the static CSS scale that maps column space
 *    onto the card.
 *  - NEVER `.column`. It carries the camera's `y` tween.
 *
 * GSAP writes the WHOLE `transform` property whenever it tweens any transform
 * component, so a second tween on either of those elements does not compose
 * with what is already there — it replaces it. Drift on `.scaler` would erase
 * the column->card scale (the page snaps to full size and overflows the card);
 * drift on `.column` would erase the camera's `y` (every marker in the video
 * lands on the wrong words, with the highlight geometry itself still perfectly
 * correct, which is why it would read as a highlight bug and would not be one).
 * ======================================================================== */

/**
 * Depth drift: where the very slow scale on `.card-drift` ends up.
 *
 * 1.03 over the whole video is about 0.1% per second — below the threshold at
 * which a viewer reads it as a zoom, above the one at which the frame reads as
 * a still photograph. It is expressed as a single `tl.to` from a `gsap.set`
 * rest state rather than a `fromTo`, because one tween spanning the entire
 * timeline cannot overlap anything, including itself.
 *
 * The amplitude is also bounded by the highlight: `.card-drift` sits INSIDE
 * `.card` (which clips), and the camera parks the active stroke in the middle
 * third of the card, so 3% pushes a centred stroke a handful of pixels further
 * from centre and can never carry it out of the card. A large drift could, and
 * would show up as `npm run e2e:highlight`'s sibling check in
 * `tests/composition.test.mts` ("the marker never leaves the card").
 */
const DRIFT_TO = 1.03;

/**
 * Light sweep: the band's travel, in percentages of its OWN width (GSAP
 * `xPercent`), so the numbers do not have to be recomputed if the band is
 * resized. The band is 42% of the card wide, so -140 parks it entirely off the
 * card's left edge and 240 entirely off its right — at rest, before the first
 * pass and after the last, it paints nothing at all.
 */
const SWEEP_FROM = -140;
const SWEEP_TO = 240;
/** A pass is clipped to stop before the next one starts; these bound it. */
const SWEEP_MAX_DUR = 2.6;
const SWEEP_MIN_DUR = 0.4;

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

  /* --- Byline and purchase card (spec 2026-08-23 §9 / §11) ----------------
   *
   * All three are declared OPTIONAL rather than required, and that is a
   * deliberate, narrow concession: `buildComposition` is called from
   * `src/lib/pipeline.ts`, which is the controller's file, and a required
   * field would break `tsc` for everyone until that one call site catches up.
   * Optional here means "the controller has not wired it yet", and every
   * consumer below treats a missing value EXACTLY as it treats an absent one:
   * it renders nothing. There is no placeholder anywhere on this path.
   */

  /**
   * The book's title, rendered in the persistent byline under the card.
   * Absent or blank renders no byline at all rather than an empty strip.
   */
  bookTitle: string;
  /**
   * The author — and ONLY when the four-link verification chain upstream
   * passed. `pipeline.ts` already resolves this to
   * `book.authorVerified ? book.author : null`, so by the time it reaches
   * here the decision has been made and this function's whole job is to
   * render nothing where there is no name.
   *
   * Never a placeholder, never "Unknown", never a dangling "by" — the
   * separator is composed WITH the name in `bylineText` rather than emitted
   * around it, so an absent author cannot leave punctuation behind.
   */
  author?: string | null;
  /**
   * The purchase link, validated as `http(s)` upstream. Present: a final
   * purchase card follows the CTA. Absent: nothing — no empty card, no
   * placeholder, no "coming soon".
   *
   * The URL itself is NEVER painted as on-screen text: it is unreadable at
   * phone size, unclickable in a video, and the description already carries
   * the real link. The card says where to find it and the URL travels only as
   * an escaped `data-book-link` attribute, so the markup records what this
   * render was built for without asking a viewer to transcribe it.
   */
  bookLink?: string | null;

  /**
   * The scene plan (Phase 3C). Absent — for a photographed episode, or any
   * caller that has not planned scenes — renders EXACTLY what this function
   * rendered before scenes existed: the page card alone, visible throughout,
   * with no scene stack, no zoom and no glow. Present, it decides what is on
   * screen when: book scenes show the card, every other kind gets its own
   * cross-faded layer, and the card is hidden while they hold the frame.
   */
  scenes?: Scene[];
}

/** How the backdrop glow sits for each scene tone: quiet, lifted, or wide. */
const GLOW_BY_TONE: Record<SceneTone, { o: number; y: number; s: number }> = {
  neutral: { o: 0.45, y: 0, s: 1.05 },
  warm: { o: 0.58, y: 2, s: 1.0 },
  cool: { o: 0.46, y: -6, s: 1.1 },
  bright: { o: 0.72, y: -3, s: 1.22 },
  deep: { o: 0.3, y: 7, s: 1.16 },
};

/**
 * How far a `book-crop` scene magnifies the card.
 *
 * Bounded tightly, and the cap is the load-bearing number: a printed line runs
 * the FULL width of the page, so magnifying about the centre eats the margins
 * first and then the words themselves. Measured on real renders — at 1.8x
 * every line was cut mid-word at both edges, at 1.35x the text still touched
 * them. 1.22x spends roughly the page's own margin and no more. The zoom's job
 * is to make the cited lines comfortably readable, not to crop to them.
 */
const CROP_MIN = 1.12;
const CROP_MAX = 1.22;

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

/* ===========================================================================
 * Byline — spec 2026-08-23 §9
 * ======================================================================== */

/** Roughly what fits on one 28px line inside the card's own width. */
const BYLINE_MAX_CHARS = 58;
/** A title is never truncated below this, even to make room for a long name. */
const BYLINE_MIN_TITLE_CHARS = 18;
/** A name longer than this is itself a data problem; it is clipped, not obeyed. */
const BYLINE_AUTHOR_MAX = 28;
/**
 * The separator is emitted only as part of the "title AND author" branch. It
 * is never concatenated onto the title and then optionally followed by a name,
 * which is the shape that produces a trailing "·" (or a dangling "by") on
 * every unverified book — the exact failure §9 forbids.
 */
const BYLINE_SEP = " · ";

/**
 * Single-line truncation with a real ellipsis character, over CODE POINTS
 * rather than UTF-16 units: `String.prototype.slice` on a title containing an
 * astral character (an emoji, or any of the CJK extension planes a translated
 * title can carry) can cut a surrogate pair in half and produce a replacement
 * glyph as the last thing on screen.
 */
function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/**
 * The byline's text, or `null` when there is nothing honest to say.
 *
 * Exported because it is the whole of the §9 rule expressed in one place, and
 * a rule this easy to get subtly wrong ("by" with nothing after it, "Unknown",
 * a trailing separator) deserves to be testable without parsing HTML out of a
 * whole composition.
 *
 * A long title is truncated rather than wrapped: `.byline` is `white-space:
 * nowrap` and overflows into an ellipsis anyway, but doing it here as well
 * keeps the ellipsis on the TITLE and leaves the author's name intact, which
 * is the opposite of what CSS overflow would do (it would eat the name — the
 * one part of the line that had to earn its place by being verified).
 */
export function bylineText(
  bookTitle: string | null | undefined,
  author: string | null | undefined,
): string | null {
  const title = typeof bookTitle === "string" ? bookTitle.trim() : "";
  if (title.length === 0) return null;

  const name = typeof author === "string" ? author.trim() : "";
  if (name.length === 0) return truncate(title, BYLINE_MAX_CHARS);

  const shown = truncate(name, BYLINE_AUTHOR_MAX);
  const budget = Math.max(
    BYLINE_MIN_TITLE_CHARS,
    BYLINE_MAX_CHARS - Array.from(shown).length - BYLINE_SEP.length,
  );
  return `${truncate(title, budget)}${BYLINE_SEP}${shown}`;
}

/* ===========================================================================
 * Emoji — spec 2026-08-23 §10
 * ======================================================================== */

/** How many code points of a beat's `emoji` are actually painted. */
const EMOJI_MAX_CHARS = 4;

/**
 * A beat's optional emoji, or `null`.
 *
 * `Beat.emoji` is written by the model and added to the schema by another
 * workstream, so at this call site it may be present, absent, empty, or not a
 * string at all (a number, an array, `null`). Every one of those must produce
 * a cue card without an emoji rather than an exception — a decorative glyph is
 * never worth failing a render for. Hence the `unknown` read and the `typeof`
 * gate, rather than trusting the declared type.
 *
 * Clipped over CODE POINTS (`Array.from`, not `slice`): every interesting
 * emoji is astral, and a UTF-16 slice would cut one in half and paint a
 * replacement glyph. The clip exists at all because "one emoji" is a
 * convention, not a guarantee — a model that returns a sentence here should
 * cost four characters of cue card, not the layout.
 *
 * This function feeds the CUE CARD ONLY. Nothing spoken passes through here:
 * `voiceover` is read straight from the beat by the TTS path and
 * `sanitizeForSpeech` strips emoji there independently, which is what keeps a
 * speech engine from either going silent or reading a glyph's name aloud.
 */
export function beatEmoji(beat: unknown): string | null {
  const raw = (beat as { emoji?: unknown } | null | undefined)?.emoji;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return Array.from(trimmed).slice(0, EMOJI_MAX_CHARS).join("");
}

/**
 * The on-screen label lives in the shared skeleton, not the theme, even though
 * it is styled by the theme's CSS (`.annot` in Marginalia): WHERE it sits and
 * WHEN it shows/hides is timing and layout, which the theme contract does not
 * own. Only its look is themed.
 *
 * The emoji (§10) is a SIBLING span rather than text prepended to the label,
 * so the theme can size and space it independently of the handwritten cue face
 * — a colour-emoji font and a script font at the same px are not the same
 * optical size — and so that a beat without one leaves no stray leading space.
 */
function cueMarkup(pkg: ContentPackage): string {
  return pkg.beats
    .map((b, i) => {
      const emoji = beatEmoji(b);
      const badge = emoji ? `<span class="cue-emoji">${esc(emoji)}</span>` : "";
      return `<div class="cue annot" data-cue="${i}">${badge}<span class="cue-label">${esc(b.onScreen)}</span></div>`;
    })
    .join("\n");
}

/* ===========================================================================
 * Purchase card — spec 2026-08-23 §11
 * ======================================================================== */

/**
 * Whether a purchase card is warranted, and the link it was built for.
 *
 * The link is re-validated as `http(s)` here even though §11 says it is
 * validated before it is stored: "before it is stored OR RENDERED" is two
 * checks, and this is the render one. A `javascript:` or `data:` string would
 * never be painted (the URL is not rendered as text at all) but it would still
 * be written into the document as an attribute value, and the cheapest place
 * to refuse that is the place that decides whether the card exists.
 *
 * Anything that is not a usable http(s) URL — absent, null, blank, a bare
 * "amazon.com", a mailto: — produces NO card. Not an empty one.
 */
function purchaseLink(bookLink: string | null | undefined): string | null {
  if (typeof bookLink !== "string") return null;
  const trimmed = bookLink.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
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

/**
 * Light-sweep passes (spec §8) — one per beat, on the dedicated
 * `.card-sweep-band` element that receives no other tween.
 *
 * Built from the BEAT clip starts, so the band crosses the paper once per
 * spoken beat, which is what makes the light read as tied to the narration
 * rather than to a metronome running underneath it.
 *
 * Two rules, both learned from `popTimes` above:
 *  - Each pass is clipped to end before the next one begins. Two overlapping
 *    `fromTo`s on one property of one element resolve in tween-creation order,
 *    and creation order is exactly what a seek does not replay.
 *  - Starts are deduped and sorted before clipping, so two beats sharing an
 *    instant (a zero-length clip, a fixture with repeated timings) produce one
 *    pass rather than two stacked on the same millisecond.
 *
 * A window too short to be seen as a sweep (`SWEEP_MIN_DUR`) is dropped
 * entirely rather than played fast: a band that crosses the whole card in a
 * tenth of a second is a flash, and a flash on one frame out of three is
 * strobing, not light on paper.
 */
function sweepPasses(beats: BeatAudio[], shift: number, duration: number): { t: number; d: number }[] {
  const starts = beats
    .map((b) => shift + (b?.start ?? 0))
    .filter((t) => Number.isFinite(t) && t >= 0 && t < duration);

  const sorted = Array.from(new Set(starts)).sort((a, b) => a - b);
  const out: { t: number; d: number }[] = [];
  sorted.forEach((t, i) => {
    const next = sorted[i + 1] ?? duration;
    // 0.01 of clearance, so two passes never share an instant even after the
    // renderer rounds a timestamp to a frame.
    const d = Math.min(SWEEP_MAX_DUR, next - t - 0.01);
    if (d >= SWEEP_MIN_DUR) out.push({ t, d });
  });
  return out;
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
  /* Depth drift (§8). Its OWN wrapper, between .card-pop and .scaler, carrying
     exactly one tween (a scale) and nothing else. It is a separate element from
     .card-pop for the same reason .card-pop is separate from .scaler: two
     tweens writing 'transform' on one element do not compose, they overwrite,
     and the page-change pop and the drift are on different clocks. */
  .card-drift { position:absolute; inset:0; transform-origin:50% 50%; }
  /* The crop zoom's own wrapper (§3C), for the same reason .card-drift is
     separate from .card-pop: a third tween writing 'transform' on either of
     those would overwrite the other, and this one is on a third clock again —
     it changes only when a scene changes. About 50% 50%, which is where the
     camera has already parked the words being spoken. */
  .card-zoom { position:absolute; inset:0; transform-origin:50% 50%; }
  .scaler { position:absolute; left:0; top:0; transform-origin: top left; }
  .column { position:relative; }
  .page { position:absolute; left:0; }
  .page img { display:block; width:100%; height:100%; object-fit:cover; }
  .stroke { position:absolute; transform-origin:left center; }

  /* --- light sweep (§8) --------------------------------------------------- */
  /* The rotation and the clipping live on the STATIC wrapper; only the inner
     band is ever tweened. Putting the tilt on the band itself would be the
     .scaler mistake in miniature — GSAP writes the whole transform property
     when it tweens xPercent, so the rotation would vanish on the first pass. */
  .card-sweep { position:absolute; inset:0; overflow:hidden; pointer-events:none;
                mix-blend-mode:screen; transform:rotate(-8deg) scale(1.25); }
  .card-sweep-band { position:absolute; left:0; top:0; width:42%; height:100%;
                     transform:translateX(${SWEEP_FROM}%);
                     background: linear-gradient(90deg,
                       rgba(255,255,255,0) 0%, ${p.sweepLight} 50%, rgba(255,255,255,0) 100%);
                     filter: blur(24px); }

  /* --- byline (§9) -------------------------------------------------------- */
  /* No tween, ever. 'top' (not 'bottom') for the same reason every other
     absolutely positioned element on this frame uses it — see CAPTION_BASELINE.
     nowrap + ellipsis is the second of two truncations: 'bylineText' already
     clipped the title so the ellipsis lands there rather than eating the
     author's name, and this is the guard for a title whose characters happen
     to be wider than the estimate. */
  .byline { position:absolute; left:50%; top:${BYLINE_Y}px; transform:translateX(-50%);
            max-width:${CARD_W}px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            font-size:28px; font-weight:600; letter-spacing:0.3px; line-height:1.2;
            font-family: Inter, system-ui, sans-serif; color:${p.bylineInk}; }

  .cues { position:absolute; inset:0; pointer-events:none; }
  .cue { position:absolute; top:${CUE_TOP}px; left:50%; transform:translateX(-50%) rotate(-4deg);
         padding:10px 22px; border-radius:6px; opacity:0; visibility:hidden;
         white-space:nowrap; }
  /* The emoji (§10) sits beside the label, sized on its own: a colour-emoji
     font and Marginalia's script face do not share an optical size at the same
     px, and a beat without an emoji must leave no gap where one would be. */
  .cue-emoji { display:inline-block; vertical-align:middle; margin-right:12px;
               font-size:0.92em; line-height:1;
               font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
  .cue-label { display:inline-block; vertical-align:middle; }
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
  .hook-key { color:${p.hookKey}; }

  /* --- CTA end card (§2.5) ------------------------------------------------ */
  .cta-card { position:absolute; left:${CARD_X + 40}px; top:${Math.round(CARD_Y + CARD_H / 2 - 200)}px;
              width:${CARD_W - 80}px; padding:56px 48px; border-radius:${CARD_RADIUS}px;
              text-align:center; font-family: Inter, system-ui, sans-serif;
              background:${p.ctaFace}; color:${p.ctaInk};
              opacity:0; visibility:hidden; }
  .cta-kicker { font-size:30px; font-weight:800; letter-spacing:6px; text-transform:uppercase;
                color:${p.accent}; margin-bottom:22px; }
  .cta-text { font-size:58px; font-weight:800; line-height:1.2; }

  /* --- purchase card (§11) ------------------------------------------------ */
  /* Sits BELOW the CTA card and fades in after it, so the two read as one
     ending rather than one covering the other — the CTA card is never faded
     back out (exactly one tween touches it), so "after" here has to mean
     "underneath and later", not "instead of".
     'top', never 'bottom': autoAlpha-driven, see CAPTION_BASELINE.
     The URL is not on this card. Nothing here is a link, because nothing in a
     video is clickable; the description carries the real one. */
  .buy-card { position:absolute; left:${CARD_X + 120}px; top:${Math.round(CARD_Y + CARD_H / 2 + 260)}px;
              width:${CARD_W - 240}px; padding:28px 34px; border-radius:${CARD_RADIUS}px;
              text-align:center; font-family: Inter, system-ui, sans-serif;
              background:${p.ctaFace}; color:${p.ctaInk};
              opacity:0; visibility:hidden; }
  .buy-kicker { font-size:24px; font-weight:800; letter-spacing:5px; text-transform:uppercase;
                color:${p.accent}; margin-bottom:12px; }
  .buy-text { font-size:38px; font-weight:800; line-height:1.15; }
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
  var BUY_FADE = ${BUY_FADE};
  var DRIFT_TO = ${DRIFT_TO};
  var SWEEP_FROM = ${SWEEP_FROM};
  var SWEEP_TO = ${SWEEP_TO};
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

  // Depth drift (§8). ONE tween, ONE property, ONE element, spanning the whole
  // timeline — so it cannot overlap anything, including a later copy of itself.
  // A tl.to() off a gsap.set() rest state rather than a fromTo: at time 0 a
  // fromTo is the shape GSAP renders at its END value on the first pass and its
  // FROM value once initted, which is a one-frame discontinuity at frame 0 for
  // no benefit.
  //
  // #card-drift, NOT .scaler and NOT .column. See the DRIFT_TO doc comment:
  // GSAP writes the whole transform property, so this tween on .scaler would
  // erase the column->card scale and on .column would erase the camera, putting
  // every marker in the video on the wrong words.
  var drift = document.getElementById("card-drift");
  if (drift) {
    gsap.set(drift, { scale: 1 });
    tl.to(drift, { scale: DRIFT_TO, duration: Math.max(0.001, data.duration), ease: "sine.inOut" }, 0);
  }

  // Light sweep (§8). Non-overlapping fromTo xPercent tweens on one dedicated
  // band — the same proven shape as the card pop above, and clipped by
  // sweepPasses() so no two ever share an instant. The rotation and the clip
  // live on the band's static .card-sweep parent, which nothing tweens.
  var band = document.getElementById("card-sweep");
  if (band) {
    gsap.set(band, { xPercent: SWEEP_FROM });
    data.lightSweeps.forEach(function (s) {
      tl.fromTo(band, { xPercent: SWEEP_FROM }, { xPercent: SWEEP_TO, duration: s.d, ease: "none", immediateRender: false }, s.t);
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

  // The purchase card (§11) fades in shortly after the CTA card and, like it,
  // is never faded back out — one tween, one property, one element. It exists
  // only when a validated http(s) link was supplied; with none, data.buy is
  // null and there is no element in the document to tween at all.
  var buyEl = document.getElementById("buy-card");
  if (buyEl && data.buy) {
    gsap.set(buyEl, { autoAlpha: 0 });
    tl.fromTo(buyEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: BUY_FADE, ease: "none", immediateRender: false }, data.buy.start);
  }

  // --- the scene stack (§3C) ----------------------------------------------
  // One generic loop over declared records, rather than per-scene generated
  // JavaScript. Every record is one tween of one primitive on one element, and
  // the builder has already proved no element receives two that overlap
  // (\`overlappingAnims\`), which is what makes the whole stack seek-safe.
  (data.anims || []).forEach(function (a) {
    var el = a.e < 0
      ? document.querySelector('[data-scene="' + a.s + '"]')
      : document.querySelector('[data-scene="' + a.s + '"] [data-el="' + a.e + '"]');
    if (!el) return;
    var d = Math.max(0.001, a.d);
    if (a.k === "in") {
      tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: d, ease: "power1.out", immediateRender: false }, a.t);
    } else if (a.k === "out") {
      tl.to(el, { autoAlpha: 0, duration: d, ease: "power1.in" }, a.t);
    } else if (a.k === "rise") {
      tl.fromTo(el, { autoAlpha: 0, y: a.v || 20 }, { autoAlpha: 1, y: 0, duration: d, ease: "power2.out", immediateRender: false }, a.t);
    } else if (a.k === "pop") {
      tl.fromTo(el, { autoAlpha: 0, scale: a.v || 0.7 }, { autoAlpha: 1, scale: 1, duration: d, ease: "back.out(1.6)", immediateRender: false }, a.t);
    } else if (a.k === "wipe") {
      tl.fromTo(el, { autoAlpha: 1, scaleX: 0 }, { autoAlpha: 1, scaleX: 1, duration: d, ease: "power2.out", immediateRender: false }, a.t);
    } else if (a.k === "grow") {
      tl.fromTo(el, { autoAlpha: 1, scaleY: 0 }, { autoAlpha: 1, scaleY: 1, duration: d, ease: "power2.out", immediateRender: false }, a.t);
    } else if (a.k === "draw") {
      tl.fromTo(el, { autoAlpha: 1, strokeDashoffset: a.v || 0 }, { autoAlpha: 1, strokeDashoffset: 0, duration: d, ease: "power1.inOut", immediateRender: false }, a.t);
    }
  });

  // The page card is shown only while a book scene holds the frame. Its rest
  // state is SET rather than tweened, so a composition whose first scene is
  // not a book scene does not flash the page on frame zero.
  var cardEl = document.getElementById("card");
  if (cardEl && data.cardVis) {
    gsap.set(cardEl, { autoAlpha: data.cardVis.start });
    data.cardVis.at.forEach(function (c) {
      tl.to(cardEl, { autoAlpha: c.v, duration: Math.max(0.001, c.d), ease: "power1.inOut" }, c.t);
    });
  }

  // The crop zoom, on its own wrapper. One tween per change, never overlapping
  // because scenes are sequential.
  var zoomEl = document.getElementById("card-zoom");
  if (zoomEl && (data.zooms || []).length) {
    gsap.set(zoomEl, { scale: 1 });
    data.zooms.forEach(function (z) {
      tl.to(zoomEl, { scale: z.v, duration: Math.max(0.001, z.d), ease: "power2.inOut" }, z.t);
    });
  }

  // The backdrop glow moves with the content: one tween per scene on one
  // element, so the background is never the same for two minutes.
  var glowEl = document.getElementById("scene-glow");
  if (glowEl && (data.glow || []).length) {
    data.glow.forEach(function (g) {
      tl.to(glowEl, { opacity: g.o, yPercent: g.y, scale: g.s, duration: Math.max(0.001, g.d), ease: "sine.inOut" }, g.t);
    });
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

/* ===========================================================================
 * Scene stack (Phase 3C)
 *
 * The page card is NOT one of the scene layers, and that is the whole design.
 * The page column and its camera are continuous across the video — one column,
 * one scroll, one marker advancing through it — so the card cannot be rebuilt
 * per scene. It stays where it has always been and its VISIBILITY is driven by
 * the scene list instead: shown for book scenes, faded out while another
 * template holds the frame, and already scrolled to the right place when it
 * comes back.
 * ======================================================================== */

interface Keyed {
  t: number;
  d: number;
}

/**
 * When the card is on screen. Returns its state at t=0 and one fade per
 * change, so a run of consecutive book scenes costs one tween, not one each.
 */
export function cardVisibility(scenes: Scene[], shift: number): { start: number; at: (Keyed & { v: number })[] } {
  if (scenes.length === 0) return { start: 1, at: [] };
  // PAGE kinds, not book kinds: a `quote` scene is a book scene — it shows the
  // book's own words and cites the page — but it renders them on their own
  // layer. Leaving the page card up behind it puts light quote text over a
  // light page, which on a real render came out invisible.
  const wants = scenes.map((s) => (PAGE_KINDS.includes(s.kind) ? 1 : 0));
  const at: (Keyed & { v: number })[] = [];
  for (let i = 1; i < scenes.length; i++) {
    if (wants[i] === wants[i - 1]) continue;
    // Hand over mid-dissolve: the incoming layer is fading in across the same
    // window, so neither a blank frame nor a double image appears between them.
    at.push({ t: Math.max(0, shift + scenes[i].start - SCENE_FADE * 0.5), d: SCENE_FADE, v: wants[i] });
  }
  return { start: wants[0], at };
}

/**
 * How far the card is magnified, per book scene.
 *
 * A crop zooms the card's CONTENT rather than repositioning it, because the
 * camera has already parked the words being spoken at the card's vertical
 * centre (`cameraTrack`'s MIDDLE). Scaling about that centre therefore closes
 * in on exactly those words, and cannot fight the camera the way an absolute
 * pan would. Bounded at CROP_MAX so a stroke the camera had to clamp (at the
 * very top or bottom of the column, where it cannot centre) is still inside
 * the card when magnified.
 */
export function cardZooms(scenes: Scene[], shift: number, cardHeightInColumnPx: number): (Keyed & { v: number })[] {
  const out: (Keyed & { v: number })[] = [];
  let current = 1;
  for (const s of scenes) {
    if (!PAGE_KINDS.includes(s.kind)) continue;
    let target = 1;
    if (s.kind === "book-crop" && s.crop) {
      const h = Math.max(1, s.crop.y1 - s.crop.y0);
      target = Math.min(CROP_MAX, Math.max(CROP_MIN, cardHeightInColumnPx / (h * 3)));
    }
    if (Math.abs(target - current) < 0.02) continue;
    out.push({ t: Math.max(0, shift + s.start), d: Math.min(1.4, Math.max(0.5, (s.end - s.start) * 0.35)), v: Math.round(target * 1000) / 1000 });
    current = target;
  }
  return out;
}

/** The backdrop glow's state per scene, so the background moves with the content. */
export function glowKeys(scenes: Scene[], shift: number): (Keyed & { o: number; y: number; s: number })[] {
  return scenes.map((scene) => {
    const g = GLOW_BY_TONE[scene.tone] ?? GLOW_BY_TONE.neutral;
    return { t: Math.max(0, shift + scene.start - SCENE_FADE), d: SCENE_FADE * 1.6, ...g };
  });
}

export function buildComposition(input: CompositionInput): string {
  const { theme, pages, sweeps, camera, captions, pkg, beats, totalDuration, music } = input;
  const { bookTitle, author, bookLink } = input;

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
  // The hook card owns the opening, then hands over to the page.
  //
  // It used to run to the end of beat 0 — the hook BEAT — on the reasoning
  // that the card should stand while its own line is spoken. On a real render
  // that came to 17.4 SECONDS, because beat 0's narration is a paragraph, not
  // a sentence. Seventeen seconds of scrim over the page is the exact
  // retention failure this card exists to prevent, inflicted by the card
  // itself: the viewer never sees the book.
  //
  // So the card is capped independently of how long beat 0 talks. It leaves by
  // HOOK_MAX_VISIBLE at the latest, and earlier if beat 0 is genuinely short —
  // whichever comes first. The narration is not cut; only the card goes. The
  // hook line keeps being spoken over the page it is describing, which is
  // where the viewer should be looking by then anyway.
  //
  // A package with no beats at all (guarded upstream, but this function is
  // exported and must stand on its own) gets no hook card rather than a card
  // that never leaves the screen.
  const beatZeroEnd = pkg.beats.length > 0 ? AUDIO_OFFSET + (beats[0]?.end ?? beats[0]?.start ?? 0) : 0;
  const hookEnd = pkg.beats.length > 0 ? Math.min(beatZeroEnd, HOOK_MAX_VISIBLE) : 0;
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

  // --- Purchase card (spec §11) --------------------------------------------
  // Starts BUY_DELAY after the CTA card so the two arrive as a sequence rather
  // than together, and is clamped so its fade always completes inside the
  // declared duration — a card that begins fading in at `duration` is a card
  // nobody ever sees, on the one part of the video that exists to be read.
  const link = purchaseLink(bookLink);
  const buyData = link
    ? { start: Math.max(0, Math.min(ctaStartRaw + BUY_DELAY, duration - BUY_FADE)) }
    : null;

  const pops = popTimes(pkg, beats, pages.length, AUDIO_OFFSET, duration).map((p) => ({
    t: p.t,
    d: p.d,
    from: POP_FROM,
  }));

  const lightSweeps = sweepPasses(beats, AUDIO_OFFSET, duration);

  // --- the scene stack (§3C) ------------------------------------------------
  // Absent scenes must render the pre-3C composition exactly, so every piece
  // below collapses to nothing rather than to a default.
  const scenes = input.scenes ?? [];
  const rect = { x: CARD_X, y: CARD_Y, w: CARD_W, h: CARD_H };
  const rendered = scenes.map((s) => renderScene({ ...s, start: AUDIO_OFFSET + s.start, end: AUDIO_OFFSET + s.end }, rect));
  const sceneHtml = rendered.filter((r) => r !== null).map((r) => r!.markup).join("\n");
  const anims: SceneAnim[] = rendered.flatMap((r) => r?.anims ?? []);
  const cardVis = scenes.length ? cardVisibility(scenes, AUDIO_OFFSET) : null;
  const zooms = scenes.length ? cardZooms(scenes, AUDIO_OFFSET, cardViewportHeight(columnWidth)) : [];
  const glow = scenes.length ? glowKeys(scenes, AUDIO_OFFSET) : [];

  const data = embed({
    strokes,
    camera: cameraData,
    captions: captionData,
    cues: cueData,
    pops,
    lightSweeps,
    hook: hookData,
    cta: ctaData,
    buy: buyData,
    duration,
    anims,
    cardVis,
    zooms,
    glow,
    // For tests and for the record: what was on screen, and when.
    scenes: scenes.map((s) => ({
      i: s.index,
      kind: s.kind,
      start: Math.round((AUDIO_OFFSET + s.start) * 1000) / 1000,
      end: Math.round((AUDIO_OFFSET + s.end) * 1000) / 1000,
      page: s.source.pageIndex,
    })),
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

  // The byline (§9). Baked into the markup at build time like every other text
  // surface here — it is never assigned by the runtime script. `null` means
  // there is nothing honest to render, and the element is then simply absent:
  // no empty strip, no "Unknown", no dangling separator.
  const byline = bylineText(bookTitle, author);
  const bylineHtml = byline ? `<div class="byline" id="byline">${esc(byline)}</div>` : "";

  // The purchase card (§11). It says WHERE the link is; it never paints the
  // link. `esc()` is applied to the URL regardless, because it is still
  // written into the document as an attribute value and a raw `"` there would
  // break out of the attribute exactly as a raw `</script>` breaks out of the
  // JSON payload.
  const buyHtml = link
    ? `<div class="buy-card" id="buy-card" data-book-link="${esc(link)}">
      <div class="buy-kicker">Get the book</div>
      <div class="buy-text">Link in the description</div>
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
<style>${sharedCss(theme)}${sceneCss(theme, rect)}${theme.css()}</style>
</head>
<body>
<div id="root" class="stage" data-composition-id="main" data-start="0" data-width="${FRAME.width}" data-height="${FRAME.height}" data-duration="${duration.toFixed(3)}" data-fps="${FPS}">
  <div class="clip" id="scene" data-start="0" data-duration="${duration.toFixed(3)}" data-track-index="0">
    ${theme.backdrop()}
    ${scenes.length ? `<div class="scene-glow" id="scene-glow"></div>` : ""}
    <div class="progress-track"><div class="progress-fill" id="progress"></div></div>
    <div class="card" id="card">
      <div class="card-pop" id="card-pop">
        <div class="card-drift" id="card-drift">
          ${theme.cardFace()}
          <div class="card-zoom" id="card-zoom">
            <div class="scaler" style="transform:scale(${scale.toFixed(6)});">
              <div class="column" id="column" style="width:${columnWidth}px;height:${columnHeight}px;">
                ${pagesHtml}
                ${strokesHtml}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="card-sweep"><div class="card-sweep-band" id="card-sweep"></div></div>
    </div>
    ${sceneHtml}
    ${theme.overlay()}
    ${bylineHtml}
    <div class="cues">
      ${cueMarkup(pkg)}
    </div>
    <div class="captions" id="captions">
      ${captionMarkup(captions)}
    </div>
    ${hookHtml}
    ${ctaHtml}
    ${buyHtml}
    <audio id="voice" src="assets/voice.wav" data-start="${AUDIO_OFFSET.toFixed(3)}" data-duration="${totalDuration.toFixed(3)}" data-track-index="20" data-volume="1"></audio>
    ${musicHtml}
  </div>
</div>
<script id="composition-data" type="application/json">${data}</script>
<script>${TIMELINE_JS}</script>
</body>
</html>`;
}
