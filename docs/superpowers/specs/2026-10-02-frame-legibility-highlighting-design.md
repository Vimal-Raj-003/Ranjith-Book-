# Frame, legibility and highlighting

Design, 2026-10-02. Sub-project 1 of the BookReel "next level" upgrade.

## Why

Every video BookReel makes stacks three separate text layers into the 350 px
between the bottom of the page card and the frame edge, and draws full-frame 3D
heroes straight through all of them. The result reads as cluttered and amateur,
which is the operator's primary complaint.

Measured on a real frame (episode `cmuphddy6…`, t = 33 s):

| Element | y range | Problem |
| --- | --- | --- |
| `.byline` — book title | 1374–1404 | Sits under the cinematic heroes |
| `.cue` — `beat.onScreen` chip | 1436–1492 | Duplicate text, fights the animation |
| `.caption-line` | 1616–1720 | Bottom ~50 px is under Instagram's own overlay |

The captions are the serious one: every video made so far has its last ~50 px of
caption buried under Instagram Reels' username and caption row, and a 920 px-wide
caption runs under the right-hand action rail. Nobody noticed because nothing
checks.

The second complaint is that the frame never changes: every page scene is the
same 960 × 1120 card in the same place, and the highlight is a flat coloured bar
that wipes left to right. There is no shot variety and no sense that a camera is
looking at anything.

### Root cause

Each element carries its own hardcoded constant — `BYLINE_Y = 1388`,
`CUE_TOP = 1450`, `CAPTION_BASELINE = 1720` — and nothing compares them against
each other, against the heroes, or against the platforms the video is published
to. Collisions are therefore invisible until someone watches a render.

## Goals

1. No text element may overlap another, overlap a scene's own type, or land in a
   region the publishing platform covers — enforced by a test, not by review.
2. The byline moves to the top of the frame.
3. The cue chip is removed entirely.
4. Page scenes vary their shot size instead of holding one fixed frame.
5. The highlight becomes a camera move onto the cited lines, not a flat bar.

## Non-goals

Deferred to later sub-projects, and explicitly not addressed here: hero lighting
and material realism, thumbnails, trending/ranking of ideas, auto-publishing, and
the episode failure rate. Nothing in this design may regress them.

## Design

### 1. A frame grid (`src/lib/video/composition/frame.ts`, new)

One module owns the 1080 × 1920 frame. Every absolutely positioned element asks
it for a position instead of declaring its own constant.

```
BANDS
  progress   y    0 ..    8   progress bar
  title      y   60 ..  150   byline
  stage      y  200 .. 1370   page card, heroes, all scene type
  caption    y 1380 .. 1560   captions, bottom-anchored at 1560

RESERVED (never receives content)
  reels_bottom    y >= 1670            Instagram caption + audio row
  shorts_bottom   y >= 1760            YouTube Shorts title row
  action_rail     x >= 950, y 1000..1800   both platforms' button column

CONTENT_WIDTH = 820, centred -> x 130 .. 950
```

`CONTENT_WIDTH` drops from 920 to 820 so that no caption reaches the action rail.

The module exports the bands, the reserved regions, a `place()` helper returning
CSS for a band, and `gridViolations()` — a pure function returning the list of
overlaps for a set of boxes, which both the unit test and the live browser test
call.

**Changes that fall out of it**

- `.byline` moves from y 1388 to the title band, max-width `CONTENT_WIDTH`.
- `.cue` is deleted: markup (`build.ts` ~line 534), CSS (`.cues`, `.cue`,
  `.cue-emoji`, `.cue-label`, every theme's `.annot` rule), the `cues` array in
  `composition-data`, the timeline loop that animates it, and `CUE_TOP` /
  `CUE_FADE`. `beat.onScreen` stays in the data model — the content pipeline and
  its tests still produce it, and the scene director reads it.
- `.caption-line` becomes bottom-anchored at 1560, max-width `CONTENT_WIDTH`,
  clamped to **two lines**: if the text would wrap to a third, the font steps
  from 60 px to 52 px rather than growing the box. A two-line caption occupies
  y 1384–1560, which clears the stage by 14 px.
- Every other absolutely positioned element — hook text, CTA card, buy card,
  progress bar, scene glow, bokeh — is audited against the grid and moved if it
  violates one.

### 2. Cinematic heroes stay in the stage

A cinematic scene keeps its full-frame canvas, so the glow and bokeh still bleed
to the frame edge. What changes is that its **type** — hook words, keyword
letters, lead line — is laid out inside the stage band only (y 260–1340). The
per-hero `FIT` table in `cine-runtime.js` already shifts each hero down to leave
room for type; that shift is re-derived from the grid rather than hand-tuned, so
the hero and its type cannot drift into the title or caption bands.

### 3. High-resolution page assets

Verified across the three distinct source PDFs in the library:

| PDF | Pages | Text chars/page | Embedded images | Hi-res helps? |
| --- | --- | --- | --- | --- |
| Bennett | 27 | 4,329 | 0 | yes — vector text |
| Meditations | 177 | 2,252 | 0 | yes — vector text |
| scanned e2e | 38 | 0 | 1 | no — a real scan |

Re-rendering a vector page at 3200 px costs **21 ms**. An episode uses about
three pages, so this costs roughly 60 ms. The scanned upload is why the
conditional below is not hypothetical.

- At composition time, render each of the episode's pages a second time at
  3200 px long edge into the project as `assets/page-NNNN@2x.jpg`.
- All existing geometry — OCR boxes, line runs, sweep steps, camera keys — stays
  in 1600 px space, unchanged. The composition multiplies by `HI_SCALE = 2` only
  when drawing the hi-res image.
- Emitted only when the page has extractable text. A scanned page gains nothing
  from upscaling and keeps today's asset.
- If the second render fails for any reason, the composition falls back to the
  1600 px asset and records a note. A missing hi-res asset must never fail a
  render.

Without this, every zoom below renders softer than the current full-page view.
With it, a 2.2× close-up is sharper than what ships today.

### 4. Shot grammar

Each page scene is assigned a shot size, and two consecutive page scenes never
share one:

| Shot | Scale | Frames |
| --- | --- | --- |
| wide | 1.0 | the whole page, at rest — establishing, once, early |
| medium | ~1.5 | the cited paragraph |
| close | ~2.2 | the cited lines |

The assignment is deterministic, made in the scene validator alongside the
existing variety rules (cinematic share, quote cap, hero repetition), so it is
unit-testable without a model call. `CROP_MIN`/`CROP_MAX` (today 1.12 and 1.22)
are replaced by this table; `cardZooms` becomes the mechanism that executes it.

### 5. The highlight

**Phase A — push-in focus.** The default for every page scene. `#card-zoom`
scales to the shot size and `#column` translates so the cited lines sit in the
frame, easing in over ~0.8 s and holding for the beat. The marker bar stays but
restyles: thinner, soft-edged, an ink-bleed rather than a flat fill, still wiping
in time with the spoken words.

Everything outside the cited span is dimmed and softened so the eye has one place
to go. The dimming is a single element inside `#column`, in the same coordinate
space as the strokes, carrying a large `box-shadow` spread in the backdrop colour
and a transparent centre sized to the cited box — one element, one tween, no
clip-path and no second copy of the page. It therefore scrolls and scales with
the column for free and stays seek-safe under the existing one-tween-per-element
rule.

**Phase B — the loupe.** A glass magnifier over the single highest-value quoted
line in a video, used at most once. Implemented as a second copy of the page
image inside a clipped, rounded element, scaled 2× and offset so the magnified
point registers with the page underneath, with a glass edge and a drop shadow.
Like `cine`/`lottie`, its motion is computed from `tl.time()` inside one
`onUpdate` rather than accumulated, so it is seek-safe.

Phase B ships only once Phase A is verified. If the loupe does not look good at
review, it is dropped; Phase A stands on its own.

### 6. Typography

**No change.** An earlier draft of this design claimed the themes' serifs were
falling back to a generic face. That was wrong: `pala.ttf` (Palatino Linotype)
and `BOD_R.TTF` (Bodoni MT) are both installed, so `SERIF_TEXT` and
`SERIF_DISPLAY` resolve to the faces they were designed around. The HyperFrames
`font_family_without_font_face` lint is noise here.

One real residue, recorded but not scheduled: those faces ship with Microsoft
Office rather than Windows, so a render on a machine without them would fall
through to Times New Roman and Georgia with no warning. Embedding them as web
fonts would make the render deterministic across machines. That is robustness,
not a quality fix, and it is out of scope for this sub-project.

## Data and interface changes

- `composition-data` loses `cues`; `anims` loses the cue entries. Nothing
  outside the composition reads either.
- `CompositionInput.pages` gains an optional `hiSrc` alongside `src`.
- `Scene` gains `shot: "wide" | "medium" | "close"` for page kinds.
- `src/lib/video/composition/build.ts` is already ~2,000 lines. The frame grid
  and the new mask/loupe layers go in their own modules rather than growing it
  further; the geometry constants it exports today move into `frame.ts` and are
  re-exported from `build.ts` so existing imports keep working.

## Testing

| Level | What it proves |
| --- | --- |
| Unit — `frame.test.mts` | Bands do not overlap; no band intersects a reserved region; `CONTENT_WIDTH` clears the action rail; `gridViolations()` catches a deliberately misplaced box. |
| Unit — composition | Cue markup, CSS and data are gone; byline is in the title band; caption is bottom-anchored, ≤ 2 lines, ≤ `CONTENT_WIDTH`. |
| Unit — scenes | Shot sizes are assigned, never repeat consecutively, and a `close` shot targets the cited line box. |
| Live browser | At sampled timestamps, every visible text element's bounding box is inside its band and outside every reserved region, and does not intersect the hero's type. |
| Seek safety | The new zoom, mask and loupe tweens pass `e2e-seek` on the cinematic fixture across all five themes. |
| Regression | `composition`, `scenes`, `cinematic`, `visual-enhancement`, `lottie`, `three` suites stay green. |
| Visual | One real episode rendered end to end; frames sampled at each shot size and checked against the grid overlay. |

## Risks

- **Hi-res assets inflate the project directory.** Three pages at 3200 px is a
  few MB per episode. Acceptable; renders are already ~30 MB.
- **Close shots can crop a cited line that spans the page width.** The shot
  assignment must fall back to `medium` when the cited box is wider than the
  frame allows at that scale.
- **The loupe is the one piece that can look cheap.** Mitigated by shipping it
  second, behind a verified Phase A.
- **Deleting the cue removes a visual element without replacing it.** The lower
  frame gets quieter. This is intended, but it is a taste call worth confirming
  on the first real render.

## Open questions

Neither blocks this spec.

**Generation time.** The operator reported it as the first problem, while the
last ten successful runs took 4.8–7.3 minutes, inside the 10-minute target. Four
of the last fourteen runs failed outright, burning 2.6–5.0 minutes each.
Reliability, not speed, is the likely cause of the perception, and that decides
what the next sub-project should be.

**A duplicate upload.** The upload titled "The Psychology of Money / Morgan
Housel" (`cmup1tydo…`) and the Bennett upload (`cmuo1h91x…`) contain a
byte-identical PDF (md5 `01824547`). Every idea generated under the Housel title
is therefore drawn from Bennett's text — which matches their subject matter on
inspection. Either the wrong file was uploaded or ingest attached the wrong
title. Out of scope here, but any video published from that book would be
mislabelled.
