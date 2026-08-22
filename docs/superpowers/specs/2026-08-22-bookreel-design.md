# BookReel — design

**Status:** approved for planning
**Date:** 2026-08-22
**Ancestor:** RepoReel (`/Users/vims/Desktop/Test/git-automation`, 16,981 lines verified present)

---

## 1. What this is

Paste nothing; upload photographs of book pages. Get a narrated, captioned
9:16 video in which the real page scrolls behind the voice and a yellow
marker sweeps the exact words being spoken — plus thumbnails, a takeaway
document, and everything needed to publish to YouTube Shorts and Instagram
Reels on a daily schedule.

The skeleton is RepoReel's: a long-running, multi-stage, model-driven
generation pipeline with every stage timed and recorded, a web UI that
watches it run, and a publishing layer. The input adapter, the content
voice, and the visual language are replaced.

### Decisions taken before this document

| Question | Decision |
|---|---|
| Photo → text | Vision model via the Claude Code CLI provider |
| Narration fidelity | Transformative commentary, not verbatim reading |
| Video shape | 9:16 only, up to 90 s |
| Upload → videos | Model proposes a 1–N episode split; operator approves |
| Highlight | Real photo + OCR word boxes for geometry |
| Themes | Marginalia, Spotlight, Study Desk, Torn Page |
| Voice | Pocket TTS, local |
| Posting | Queue with an approval window |
| Book identity | Model inference + Open Library lookup |
| Author | Omitted unless verified to certainty; never guessed |
| Lead magnet | One-page takeaway sheet |
| Scheduling | Series-aware queue |
| Deployment | Local Mac now, VPS-ready |
| Thumbnails | 9:16 and 16:9, three variants each |
| First milestone | Vertical slice to one watchable video |

---

## 2. Reuse ledger

BookReel is a fork of the RepoReel tree, not a rewrite.

| Fate | Files | Approx. lines |
|---|---|---|
| **Verbatim** | `lib/auth/*`, `lib/publish/**`, `lib/media/fetch-guard.ts`, `lib/media/ffmpeg.ts`, `lib/media/tts.ts`, `lib/media/captions.ts`, `lib/video/render.ts`, `lib/paths.ts`, `lib/db.ts`, `lib/step-timer.ts`, `lib/reap.ts`, `lib/xlsx.ts`, `lib/format-duration.ts`, `components/Toast`, `RunClock`, `CopyBlock` | ~7,800 |
| **Adapted** | `lib/pipeline.ts`, `lib/content/*` providers, `lib/docs/*` (retargeted), `lib/video/theme.ts`, `components/Studio.tsx`, `SettingsPanel.tsx`, `PipelineRail.tsx`, `components/publish/*` | ~4,000 |
| **Deleted** | `lib/github.ts`, `lib/trending.ts`, `lib/video/github-chrome.ts`, `lib/auto-pick.ts`, `app/api/trending` | ~700 |
| **New** | ingest, OCR geometry, alignment, book identity, episode planner, highlight engine, four themes, upload UI, schedule queue | ~5,500 |

### One structural change to inherited code

`lib/video/composition.ts` is 1,467 lines. Four themes cannot live inside
it as branches. It splits:

```
lib/video/composition/build.ts     shared skeleton, timeline, captions, cues
lib/video/composition/themes/marginalia.ts
lib/video/composition/themes/spotlight.ts
lib/video/composition/themes/study-desk.ts
lib/video/composition/themes/torn-page.ts
lib/video/composition/theme-contract.ts
```

Each theme exports the same interface: palette tokens, page-frame renderer,
highlight renderer, caption style, cue-card style, page transition, music
mood. Adding a fifth theme costs one file.

---

## 3. Data model

RepoReel's `Creation` splits into four models, because a book is a source
returned to over weeks rather than a one-shot input.

**`Book`** — `title`, `openLibraryId`, `coverPath`, `year`, `subjects`,
`archetype` (`story` | `motivation` | `philosophy` | `howto` | `memoir`),
`rightsStatus` (`public-domain` | `in-copyright` | `own-work`),
`author` (nullable), `authorVerified` (boolean, default false),
`authorOmissionReason` (nullable).

**`Upload`** — one batch of photographs. Belongs to a `Book`.

**`Page`** — one photograph. `filePath` (original, EXIF-stripped),
`derivedPath` (deskewed), `pageIndex`, `visionText` JSON, `ocrBoxes` JSON,
`alignment` JSON, `alignmentConfidence`, `width`, `height`.

**`Episode`** — replaces `Creation`; one video. Belongs to `Book` and
`Upload`. Holds `script`, `verification`, `visualPlan`, `captions`,
`takeawayJson`, `theme`, `partNumber`, `seriesTotal`, `videoPath`,
`thumbnails` JSON, `srt`, `durationSec`, `step`, `status`, `notes` JSON.

**Carried over unchanged:** `StepRun`, `PublishJob`, `PlatformAccount`,
`Setting`, `User`, `Session`, `LoginCode`.

**`UsedHook`** carries over, scoped per book.
**`UsedIdea`** replaces `UsedKeyword`; unique index on `(bookId, ideaKey)`.
This is what prevents episode 11 from restating episode 4's point.

**`ScheduleSlot`** is new — per platform account, a daily time and a
`holdIfUnapproved` flag.

**Dropped:** `RepoSnapshot` and all trending state.

### Retained principle

Every intermediate is stored, not just the result. This matters more here
than it did in RepoReel: when a highlight lands on the wrong word, the OCR
boxes and the alignment map are the only way to see why.

---

## 4. The pipeline

`lib/pipeline.ts` → `runIngest(uploadId)` then `runEpisode(episodeId)`.
Each stage is wrapped in the inherited `StepTimer` and writes a `StepRun`.

```
INGEST (per upload)
 1  Reading the pages          vision model per photo → text, paragraphs, headings
 2  Measuring the pages        OCR geometry pass → word bounding boxes
 3  Aligning text to geometry  LCS token alignment; vision words → pixel boxes
 4  Identifying the book       model inference → Open Library confirmation
 5  Planning the episodes      model proposes a 1–N split; operator approves

EPISODE (per episode)
 6  Reserving the idea         unique claim on this episode's angle, before writing
 7  Writing the script         beats carry sourceRefs → page + word range
 8  Grounding check            adversarial pass, quotation budget, author gate
 9  Writing the takeaway sheet may fail; CTA withdrawn if it does
10  Preparing page assets      deskew, crop, cover art
11  Directing the visuals      page, word range, marker timing, cue cards
12  Recording the voiceover    one file per beat, mastered to −16 LUFS
13  Music bed                  ducked against the finished narration
14  Timing the captions        measured from real audio
15  Composition + seek check   theme HTML/GSAP at 1080×1920
16  Thumbnails, render, queue
```

### Ordering rules inherited and still load-bearing

1. The takeaway sheet is written (9) before the voiceover is recorded (12).
   The CTA offers the sheet; the sheet can fail; nothing has been spoken
   yet, so the promise can still be withdrawn.
2. The grounding check gates the voiceover. Nothing is spoken until the
   script passes. Two rewrites, then the run stops.
3. The music bed is generated after the voiceover, which is its sidechain key.
4. Captions are timed from measured audio, never from a words-per-minute
   estimate. One audio file per beat.
5. Thumbnails are made before the render, because they are cheap and a
   render failure should not cost them.

### New ordering rules

6. **The idea is reserved (6) before the script is written (7)**, and the
   writer is told which angle it owns. Same lesson as RepoReel's keyword.
7. **The author's verification status is resolved (4) before the script is
   written (7)**, and the writer is told there is no author when there is
   none. Patching an author out after writing produces prose with a hole
   in it; withholding it beforehand produces prose that never needed one.
8. **Alignment (3) precedes the visual director (11)**, because the
   director can only place a marker sweep where geometry exists.

### Failure policy

| Stage | On failure |
|---|---|
| Reading the pages | **fatal** — nothing to make a video from |
| Measuring the pages (OCR) | continue; degrade to paragraph-block highlight |
| Aligning | continue per page; unaligned pages get block highlight |
| Identifying the book | continue; title from the model, author omitted |
| Author verification | continue; author omitted, reason recorded |
| Planning the episodes | continue; fall back to one episode for the upload |
| Writing the script | **fatal** |
| Grounding verdict `revise` ×3 | **fatal**, report kept and shown |
| Quotation budget exceeded | **fatal** — a rights blocker, not a quality note |
| Takeaway sheet | continue; withdraw the CTA offer |
| Page assets | continue with the original photo |
| Visual director | continue with no cue cards |
| Music bed | continue dry |
| Composition check | continue; findings advisory |
| Thumbnails | continue; warn |
| Render | **fatal** — the video is the deliverable |

The rule is unchanged: fail only when the primary deliverable is impossible,
with one addition — a rights violation is treated as making the deliverable
impossible, because an unpublishable video is not a deliverable.

### Progress reporting

`PipelineRail.STEPS` is a hard-coded array and `activeIndex` is a
`findIndex`. An unknown stage name returns `-1` and the rail renders as
though nothing has started. **Every commit that adds a stage updates that
array in the same commit.** This is a checklist item in the plan, not a
hope.

---

## 5. The highlight engine

The novel core of the product, and the part that most deserves care.

### The problem

The vision model reads text accurately but is unreliable at coordinates.
OCR reads text poorly on phone photographs of books — curved spines,
shadows, tinted paper, decorative fonts — but its **geometry** is sound.

### The resolution

Each engine is used only for what it is good at.

1. Vision supplies the words, in reading order, with paragraph and heading
   structure.
2. OCR supplies word bounding boxes, in pixel coordinates.
3. An **LCS token alignment** maps vision word indices onto OCR boxes.
   Both sides are normalised (lowercase, alphanumeric only) before matching.
4. Words that fail to align inherit the bounding box of their line.
5. A page whose alignment confidence falls below threshold degrades to
   paragraph-block highlighting for that page only.

### Rendering the sweep

Aligned boxes cluster by baseline `y` into **line runs**. Each line run
becomes a rectangle behind the text. The marker animates as a `scaleX`
from 0 to 1 on each line's rectangle, left to right, wrapping to the next
line — which is the motion of a real highlighter.

Because each script beat carries `sourceRefs` naming a word range, and
caption timing supplies real millisecond boundaries, the sweep completes
exactly as the narration completes the thought.

### The camera

**This is a deliberate deviation from RepoReel's documented rule.**

RepoReel learned that steering the scroll to whichever passage each beat
mentioned was worse than a straight top-to-bottom pass: it jumped between
sections and skipped whole parts of the page.

Here the camera must follow the highlight or the highlight leaves the
frame. So the scroll is driven by the **highlight rectangle**, not by the
beat text: keep the active rectangle in the middle third of the frame,
ease toward it, hold still otherwise. The failure mode RepoReel hit cannot
occur, because every page is visited in order by construction — the
highlight advances monotonically through the document.

### Seek-safety

The inherited constraint is absolute: rendering happens by seeking to a
timestamp and screenshotting, so any animation whose state depends on how
it was reached produces artefacts.

- No CSS animations; everything on the one paused timeline.
- `immediateRender: false` on every `fromTo` not at time zero.
- Never two tweens on one property at the same time.
- No `Math.random()` at render time; positions fixed or hashed.
- Escape `<` in embedded JSON — a `</script>` in page text closes the tag
  early and the render comes out blank.

### Testability

`alignTokens`, `clusterLineRuns`, `sweepTimingForBeat` and
`degradeToBlocks` are pure functions with unit tests.

A **highlight-accuracy harness** renders a frame at a known timestamp and
asserts the yellow rectangle overlaps the target word box by ≥90% of that
box's area. It compares geometry, not pixels.

---

## 6. Themes

Four signature themes, sharing the highlight engine, differing in dressing.

**Marginalia** — paper grain, yellow marker, handwritten annotations easing
into the margins in a handwriting face, sticky-note cue cards. Warm and
studious.

**Spotlight** — page desaturated and dimmed; a soft light pool travels with
the narration, leaving read lines glowing amber behind it. Cinematic, high
contrast, strong on a phone at night.

**Study Desk** — page on a textured desk with depth-of-field, a coffee ring,
and a highlighter tip that physically draws the stroke. Tactile.

**Torn Page** — the key sentence tears out of the page and floats forward as
kinetic typography over blurred paper collage. Punchy; suits motivational
archetypes, not long story passages.

**Build order:** Marginalia first (milestone one), then Spotlight, then
Study Desk, then Torn Page. Torn Page leaves the page plane and therefore
stresses the theme interface hardest; it is built last, after three themes
have proven the contract.

Remaining theme slots reuse RepoReel's inherited style set and its
music-mood mapping.

---

## 7. The author rule

The operator's requirement: the author is not revealed unless it can be
established with certainty. Everything else proceeds regardless.

### Verification chain

`authorVerified` is set true only when **all** of the following hold:

1. Open Library returns exactly one work matching the identified title.
2. That work has exactly one author.
3. The model's independent inference from the page images names the same
   person, after normalisation (case, punctuation, initials, diacritics).
4. The adversarial grounding pass confirms the name against the pages.

Any ambiguity — multiple editions naming different authors, a translation,
an anthology, no match, two candidate names, a disagreement between steps —
leaves `authorVerified` false. There is no intermediate confidence state.

### When unverified

`Book.author` stays null and the author is **absent**, not placeholdered.
No "unknown author", no empty byline, no blank slot. Absent from:

- the narration and the voiceover
- on-screen text and cue cards
- both thumbnail aspect ratios
- the YouTube title, description and tags
- the Instagram caption and hashtags
- the takeaway sheet
- the storyboard and workbook exports

`Book.authorOmissionReason` records which link in the chain broke, visible
on the episode.

### Enforcement

Two mechanisms, deliberately both:

1. **Before writing** — the script prompt is told there is no author, so no
   sentence is ever composed that needs one. Withholding beforehand
   produces clean prose; patching afterwards produces prose with a hole.
2. **After writing** — the grounding check carries a hard blocker: any
   author name appearing in any field while `authorVerified` is false fails
   the run, the same class as a failed fact-check.

### Non-blocking

Author verification failing is **non-fatal and stalls nothing**. The video,
both thumbnail sets, the takeaway sheet and the publish payload are all
produced and delivered exactly as normal, minus that one field. A note is
recorded so the omission is visible and explainable.

### Manual entry

The UI offers no author override in milestone one. If it is added later it
sets `author` with `authorVerified` remaining false and a distinct
`authorSource: 'operator'`, so machine-verified and human-asserted names are
never confused in the data.

---

## 8. Rights, privacy and safety

Photographs of books introduce two exposures RepoReel never had.

### Quotation budget

`Book.rightsStatus` drives a budget enforced in the grounding check:

| Status | Longest contiguous quote | Verbatim share of narration |
|---|---|---|
| `in-copyright` | 25 words | 8% |
| `public-domain` | unlimited | unlimited |
| `own-work` | unlimited | unlimited |

Exceeding the budget is a **blocker**, of the same class as a failed fact
check, and blocks auto-publish. This is why the narration is transformative
commentary rather than a reading: an audiobook of someone else's
copyrighted work draws takedowns on both platforms.

### Uploaded images are attacker-controlled files

- Magic-byte validation; the declared extension is not trusted.
- 12 MB per photograph, 60 MB per upload, abandoned mid-stream.
- Re-encoded through a decoder before any other stage touches them.
- **EXIF stripped**, including GPS. Phone photographs of books carry home
  coordinates; a published video must not.
- Originals live under `WORK_ROOT`, never `public/`, and are served only
  through the authenticated route. Anything under `public/` is served by
  filename with no handler in front of it.

### Inherited, unchanged

- The SSRF guard on every third-party URL, including Open Library and cover
  fetches: http(s) only, every resolved address must be public, redirects
  followed manually so each hop is re-checked.
- Login codes and session tokens stored as SHA-256 hashes.
- Platform tokens encrypted with AES-256-GCM; model API keys not, because a
  refresh token uploads to a real channel.
- The working directory is deleted once the render succeeds.

---

## 9. Publishing and the daily queue

The publish layer transfers unchanged: OAuth per platform, AES-256-GCM
token storage, the compare-and-set `updateMany` job claim that lets two
processes share a database without double-posting, the signed 30-minute
media route that exists because Instagram fetches video from a URL, and the
browser engine that stops on the Publish button and never presses it.

### New: `ScheduleSlot`

Each platform account carries daily posting times. Approved episodes fill
the next open slot **in series order**, part numbers intact. A per-account
`holdIfUnapproved` flag decides whether an unapproved episode holds or posts
when its slot arrives.

### Auto-publish gates

Inherited: the grounding check passed with no blocking issues; groundedness
≥ 70; a rendered file exists and exceeds 200 KB; the platform's own field
limits are clean on the exact payload being sent.

Added: the quotation budget is within limits, and no author name appears
while `authorVerified` is false.

Only the API engine is ever used automatically. The browser engine waits
for a person, which has no place in a path whose premise is that nobody is
watching.

### Frozen payloads

`PublishJob.payload` remains a frozen copy of what was approved.
Regenerating an episode must not change what publishes later, or "the
operator approved it" stops being true.

---

## 10. Testing

The inherited split holds: pure functions are unit-tested — which is why
they are pure — and anything touching a browser, ffmpeg or the network gets
a harness that runs the real thing and **measures** it.

Assert the property, not the implementation.

### New unit tests

`alignTokens`, `clusterLineRuns`, `sweepTimingForBeat`, `degradeToBlocks`,
`quotationBudget`, `authorVerificationChain`, `episodeSplitValidation`,
`nextScheduleSlot`, `normalizePersonName`.

### New harnesses

- **Highlight accuracy** — render a frame at a known timestamp; assert the
  yellow rectangle overlaps the target word box by ≥90% of its area.
- **Alignment fixture** — a checked-in photograph with hand-labelled word
  boxes; assert alignment accuracy against it.
- **Author gate** — assert no author string reaches any output field when
  `authorVerified` is false, across all eight consumers listed in §7.
- **Seek-safety** — inherited; seek forward, away and back, assert every
  element resolves to an identical computed style. Compares computed styles,
  not pixels, because two identical states can rasterise a sub-pixel apart.

### A known gap fixed rather than inherited

RepoReel drops roughly two seconds of audio at the end of every video: the
stream is full length but silent in the tail, so the CTA card — the most
valuable frame — plays in silence.

BookReel adds an **audio-tail harness** that asserts audio energy exists in
the final second of the rendered file. If the cause proves to be inside
HyperFrames rather than the composition, the fix is to pad the audio and
extend the timeline rather than chase it upstream.

### Habits that repeatedly caught real bugs

1. Look at the output. Screenshots of thumbnails and frames catch what no
   assertion does.
2. Run the real pipeline before believing it.

---

## 11. Build order

Each step is independently verifiable. Do not skip ahead.

1. Fork the tree, strip the GitHub domain layer, schema migrated, auth and
   an empty episode list working. *(Sign in, see an empty library.)*
2. Upload form, image validation, EXIF strip, `Page` rows written.
   *(Photographs land on disk, safely.)*
3. Vision read → `visionText`. *(Real page text in the database.)*
4. OCR geometry + alignment + the alignment fixture harness.
   *(Word boxes that provably match the words.)*
5. Book identity + the author verification chain + its gate harness.
   *(A title, and an author only when certain.)*
6. Episode planner + idea reservation. *(An approved 1–N split.)*
7. Script generation, schema-constrained. *(Real narration in the database.)*
8. Grounding check + quotation budget. *(A verdict and a score.)*
9. TTS + caption timing. *(A wav and word timings.)*
10. Marginalia composition, rendered as a single frame. *(A picture.)*
11. **Seek-safety and highlight-accuracy harnesses — before the full render.**
12. Full render. *(← milestone one ends here: a watchable video.)*
13. Thumbnails, takeaway sheet, exports.
14. Spotlight, Study Desk, Torn Page.
15. Publishing — API engine first; browser engine only if the API cannot.
16. Schedule slots and the approval queue.

The one ordering that matters most: **build the seek-safety and
highlight-accuracy harnesses before the full render.** A frame-by-frame
render of a composition that is not seek-safe produces artefacts that look
like renderer bugs and are not.

---

## 12. Milestone one

Upload photographs → read → align → identify → plan → script → grounding
check → voice → **Marginalia only** → one 9:16 video that can be watched.

Explicitly excluded from milestone one: publishing, the schedule queue, the
other three themes, the takeaway sheet, exports, and thumbnails of either
aspect ratio.

The reason for this scope: the plumbing is the known quantity — it already
works in RepoReel. The unknown is whether a photograph of a book page
becomes a video worth watching. That question gets answered first.

---

## 13. Known risks

1. **OCR geometry on real phone photographs is unproven.** Curved spines and
   shadows are the normal case, not the edge case. Mitigated by the block
   fallback and measured by the alignment fixture harness — but if accuracy
   is poor across a real sample, the clean-text-overlay approach is the
   fallback design, not a rewrite.
2. **Episode splitting is a judgement call with no ground truth.** Nothing
   verifies the split was the right one, only that it is well-formed. Same
   class of gap as RepoReel's unmeasured visual director.
3. **Vision reading cost scales with page count.** A ten-page upload is ten
   vision calls before anything else happens. Acceptable on a subscription;
   worth watching if the provider changes.
4. **No test covers the pipeline end to end.** Inherited. Stages are covered
   individually and by harnesses; orchestration is verified by running it.
5. **DNS rebinding is not defeated.** Inherited. The SSRF guard checks
   resolved addresses but does not pin the connection to the address it
   verified.
