# BookReel Presentation Overhaul — Design Spec

**Date:** 2026-08-23
**Supersedes nothing.** Additive to `2026-08-22-bookreel-design.md`. Every existing
feature, test and function keeps working; this changes presentation, not pipeline logic.

## Why

The vertical slice produced a watchable video, but the operator's verdict on the
real output was: the video is not attractive, the UI is not a desktop app, the
music cannot be heard, and there are no thumbnails. Each of those is now measured,
not assumed:

| # | Finding | Evidence |
|---|---------|----------|
| 1 | Page fills the entire 1080x1920 frame; `theme.backdrop()` is painted behind it and never visible | `build.ts` `.stage`/`.column`, no framing element |
| 2 | `pkg.hook` + `pkg.hookKeywords` generated, deduped, stored — never rendered | only consumers are `pipeline.ts:531`, `verify.ts:188`, `index.ts:343` |
| 3 | Captions sit 130px from the bottom, under Instagram's own UI chrome | `CAPTION_TOP = FRAME.height - 130` |
| 4 | Music bed is ~16 dB under narration — effectively inaudible | `BED_MEAN_DB = -32` vs `loudnorm=I=-16` |
| 5 | No thumbnails anywhere | no code in `src/lib`, no column in `schema.prisma` |
| 6 | UI is a 560px phone-width column on desktop | `Studio.tsx` `max-w-[560px]` |

## Decisions (operator, 2026-08-23)

- **Render engine: HyperFrames.** Not Remotion. Every complaint is a composition
  DESIGN problem, not a render-engine problem; HyperFrames already renders
  correctly with GSAP, seek-safety and multi-track audio.
- **Frame: floating paper card.** The page stops filling the screen. It sits on a
  rounded card with a real shadow, on a designed background, and the scroll
  happens INSIDE the card.
- **Voice: Charles** (deep, deliberate) as the new default, plus a more
  projecting master chain.
- **Sequence: everything in one pass.**

## 1. Frame layout (binding constants)

All four workstreams use these exact numbers. `FRAME = 1080 x 1920`, `FPS = 30`.

```
y=0     ┌──────────────────────────────┐
        │ ▮ progress bar, h=8, full-w  │  PROGRESS_H       = 8
y=56    │   brand / part label         │  BRAND_Y          = 56
y=250   │  ╔════════════════════════╗  │  CARD_X           = 60
        │  ║                        ║  │  CARD_W           = 960
        │  ║   book page scrolls    ║  │  CARD_Y           = 250
        │  ║   INSIDE this card     ║  │  CARD_H           = 1120
        │  ║                        ║  │  CARD_RADIUS      = 28
y=1370  │  ╚════════════════════════╝  │
        │        ▀ shadow ▀            │
y=1450  │   ┏━━━━━━━━━━━━━━━━━━━━┓     │  cue / annotation band
y=1720  │   ┃   CAPTION TEXT     ┃     │  CAPTION_BASELINE = 1720
        │   ┗━━━━━━━━━━━━━━━━━━━━┛     │
y=1920  └──────────────────────────────┘  bottom 200px left clear for IG chrome
```

### Coordinate unity — the load-bearing rule

OCR boxes, line runs, sweep steps and camera keys are ALL measured in the
1600px-long-edge derivative's pixel space ("column space"). That must not change.
The card is smaller than the frame, so the column is scaled by CSS — never
re-measured.

```
.card      position:absolute; overflow:hidden;   <- the window, never moves
  .scaler  transform: scale(s); transform-origin: top left;   <- STATIC CSS only
    .column                                       <- GSAP tweens `y` here, column space
      .page img  +  .stroke
```

- `s = CARD_W / columnWidth`
- GSAP keeps tweening `y` on `.column` in **unscaled column pixels**. Unchanged.
- `.scaler` carries a static CSS transform that GSAP never touches, so it cannot
  fight the camera tween and cannot break a seek.
- **`cameraTrack` must be called with the card's viewport height expressed in
  column space: `CARD_H / s`, NOT `FRAME.height`.** Calling it with 1920 while the
  window is really `1120/s` tall makes the camera overscroll and the marker leaves
  the card. This is the single highest-risk line in the change
  (`pipeline.ts:619`).

## 2. Composition additions

Each is one element driven by ONE tween on ONE property, matching the existing
seek-safe contract (`immediateRender: false` on every non-zero `fromTo`, no CSS
transitions, no `Math.random()` at render).

1. **Backdrop** — theme-owned: deep gradient + two soft blurred colour blooms +
   grain. Now actually visible, because the card no longer covers it.
2. **Hook card** — `pkg.hook` at ~76px bold, `pkg.hookKeywords` painted in the
   theme accent. Spans `0` to the end of beat 0 (the hook beat), over a blurred
   scrim so the page reads behind it. Fades out; the page card takes over.
3. **Card pop** — on each page change the card plays a single `fromTo` scale
   `1.04 -> 1.0`. Non-overlapping, one property, own wrapper element
   (`.card-pop`). Must be validated by `npm run e2e:seek`.
4. **Captions** — 60px, weight 800, baseline at `CAPTION_BASELINE = 1720`,
   expressed with `top` + `translateY(-100%)` (the `bottom` property is never
   painted by the renderer — see `build.ts` `CAPTION_TOP` doc comment).
5. **CTA end card** — a designed overlay, not just a held caption line.
6. **Progress bar** — one `scaleX` 0->1 over the full duration.

## 3. Audio

- `BED_MEAN_DB: -32 -> -22`. Narration is mastered to `-16 LUFS`; -22 puts the
  bed about 6 dB under, which is the operator's "half the volume" requirement.
- Because the bed is now 10 dB louder, the duck must work harder or it will
  fight the words: `sidechaincompress` moves to `threshold=0.05:ratio=6`,
  keeping `attack=20:release=500`. Under speech the bed steps well back; in the
  gaps between sentences it returns to its new, clearly audible level.
- `DEFAULT_POCKET_VOICE: "alba" -> "charles"`.
- `masterVoice` gains projection: presence lift `3200Hz +2.5 -> +3.5`, a second
  lift at `1800Hz +1.5` for body, and `acompressor` ratio `3 -> 3.5` with
  `threshold -20dB`. Target stays `-16 LUFS` — that is what YouTube and
  Instagram normalise to, and changing it only invites their normaliser to
  change it back.

## 4. Thumbnails

- **Both aspect ratios, 3 variants each**: 9:16 `1080x1920`, 16:9 `1280x720`.
- **Rendered with `playwright-core`** (already a dependency, chromium already
  cached) screenshotting a generated HTML page. Full CSS control, sub-second,
  no new dependency, no licence.
- Source imagery is the operator's own page photo, cropped around the
  highest-value highlighted line, plus the hook text.
- Variants: `quote` (page crop + pulled quote), `bold` (full-bleed type on the
  theme backdrop), `split` (page photo one half, type the other).
- Storage: `WORK_ROOT/thumbs/<episodeId>/<key>.jpg`, never `public/`.
- DB: new nullable `thumbnails String?` column on `Episode` (JSON array of
  `{key, aspect, variant, path, width, height}`). Nullable so no existing row
  is invalidated and no backfill is needed.
- API: `GET /api/episodes/[id]/thumbnail/[key]`, session-guarded exactly like
  the existing video route.
- A thumbnail failure must NEVER sink a render — same contract as the music bed.

## 5. Desktop UI

Three-pane, full-width, responsive down to one column on mobile.

```
┌──────────┬────────────────────────────────┬──────────────┐
│ SIDEBAR  │  WORKBENCH                     │  INSPECTOR   │
│ 240px    │  flexible                      │  340px       │
│          │                                │              │
│ BookReel │  ┌ upload dropzone ──────────┐ │ Theme        │
│          │  └───────────────────────────┘ │ Voice        │
│ Studio   │  ┌ run rail + clock ─────────┐ │ Music        │
│ Library  │  └───────────────────────────┘ │ ──────────── │
│ Queue    │  ┌ 9:16 video preview ───────┐ │ Thumbnails   │
│          │  │                           │ │ [][][] 9:16  │
│ ──────── │  └───────────────────────────┘ │ [][][] 16:9  │
│ account  │  ┌ YouTube / Instagram copy ─┐ │ ──────────── │
│          │  └───────────────────────────┘ │ Download     │
└──────────┴────────────────────────────────┴──────────────┘
```

- Existing token set in `globals.css` is kept and extended — not replaced.
- Library becomes a card grid with poster thumbnails, not a text list.
- Copy blocks for YouTube title/description/hashtags and Instagram caption, each
  with the existing `CopyBlock` one-click copy.
- Keyboard reachable, `prefers-reduced-motion` respected, both themes intact.

## 6. Non-negotiables

1. `npm run typecheck` clean; all existing tests stay green.
2. `npm run e2e:seek` must pass — it is the only thing standing between a new
   tween and a video that renders blank.
3. `npm run e2e:highlight` must pass — the marker must still land on the right
   words after the card scale is introduced.
4. No new runtime dependency without a licence that permits commercial use.
5. Author rule (§7 of the original spec) is untouched.
6. Nothing written to `public/`; photographs stay under `WORK_ROOT`.
