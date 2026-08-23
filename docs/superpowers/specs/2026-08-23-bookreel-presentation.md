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

---

# Addendum — 2026-08-23 (second pass)

Operator feedback after watching a finished video and using the app.

## Confirmed bugs (fixed before this addendum)

| Symptom | Real cause |
|---|---|
| "the thumbnail is not coming" | `parseThumbnails` takes the episode ROW; both API routes passed the COLUMN. Typed `unknown`, so it compiled and silently returned `[]` every time. |
| No error anywhere explaining it | Every best-effort step appended notes to a snapshot taken at the top of `runEpisode`, so each writer erased the previous one. |
| The store genuinely failed on a live run | The dev server held a Prisma client generated before the `thumbnails` column existed. **A schema change needs the dev server restarted, not just `prisma generate`.** |

## Decisions (operator)

- **Page treatment: enhanced photo + motion.** Keep the operator's real photograph. Grade it so it reads as a printed book rather than a phone snapshot, and add motion. NOT re-typeset — that would rebuild the highlight geometry and risk the marker accuracy, which currently measures 100%.
- **Book link: typed at upload.** Optional. Present → description carries it and the video ends with a purchase CTA. Absent → both silently skipped.
- **Free books: Project Gutenberg.** ~75,000 genuinely public-domain titles, free API (`gutendex.com`), no key. Everything on it is out of copyright, so it carries no rights risk.
- **Author: shown only when verified.** The existing four-link verification chain decides. Verified → shown under the title. Not verified → title alone, no placeholder, no guess. This preserves the operator's original standing instruction.

## 7. Page enhancement

A new step between the derivative and the composition. **The enhanced image MUST have byte-identical pixel dimensions to the derivative it replaces** — every OCR box, line run, sweep step and camera key is measured in that exact pixel space, and a resize of even one pixel silently moves every highlight. Enhancement changes colour, never geometry.

Applied with `sharp` (already a dependency):
- neutralise the yellow/warm cast typical of indoor phone photos
- lift contrast and black point so grey paper reads as white
- gentle denoise, then unsharp mask so the print stays crisp
- a warm paper grade back on top, so it reads as book paper, not a scan

Best-effort: if enhancement fails, the original derivative is used unchanged.

## 8. Motion (all seek-safe)

Every addition is ONE tween on ONE property of its OWN element, `immediateRender: false`, validated by `npm run e2e:seek`.
- **Depth drift** — a very slow scale on a dedicated `.card-drift` wrapper (never `.scaler`, never `.column`), so the page feels alive rather than static.
- **Light sweep** — a soft gradient band translated across the card once per beat.
- Neither may touch the camera, the strokes, or the scale that maps column space to the card.

## 9. Byline

A persistent line under the card: book title, and the author only when `Book.authorVerified` is true.

```
y=1370  card bottom
y=1388  BYLINE_Y   — title · author (author only if verified), 28px, single line
y=1450  cue band   (unchanged)
y=1720  caption baseline (unchanged)
```

## 10. Emoji

One optional emoji per beat, chosen by the writer to match that beat's meaning.

**Emoji may appear ONLY on the cue card and in social copy — never in `voiceover`.** `sanitizeForSpeech` already strips them, and it must keep doing so: a speech engine either skips an emoji silently (dead air) or names it aloud.

## 11. Book link and the purchase CTA

- `Book.bookLink String?` — optional, entered on the upload form.
- Present: the description ends with the link, and a final purchase card follows the CTA.
- Absent: no link line, no purchase card. Not a placeholder, not an empty section.
- The purchase line is composed deterministically in code, NOT asked of the model — a model that invents a URL is worse than no URL.
- The link is validated as `http(s)` before it is stored or rendered.

## 12. Free books (Project Gutenberg)

- Search and browse via `gutendex.com` (no key). Cover, title, author, download formats.
- Download EPUB / plain text / PDF where the format exists.
- Network calls go through the existing `fetch-guard`, with a timeout, and never block a render.
- This is a browsing and download surface. Generating episodes directly from a Gutenberg text is the natural next step and is explicitly OUT of scope here.
