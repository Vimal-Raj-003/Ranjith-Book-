# Inspector controls: thumbnails, voice, music

Date: 2026-10-04
Status: approved for implementation
Scope: workstream 1 of 6. Frontend restructuring, cinematic themes and
auto-publish are explicitly **out of scope** and get their own specs.

## Why

Three operator-facing controls are either broken or absent:

- **Thumbnails are generated correctly but never arrive.** The posters
  exist on disk and the API serves them; the library grid simply cannot
  finish downloading them.
- **Voice cannot be changed.** The twelve-voice backend is already built
  and already read by the pipeline; the UI control is hardcoded
  `disabled` and the settings route refuses to store a voice.
- **Music has no controls at all** and four fixed moods chosen by theme.

## Ground truth

Measured on this machine, 2026-10-04, against the live dev server and
`prisma/dev.db` (139 episodes):

| Claim | Evidence |
|---|---|
| Generation works | 40/40 most recent DONE episodes have 6 specs in the DB and 6 files on disk; 105 episode folders under `.bookreel/thumbs` |
| Serving works | `GET /api/episodes/<id>/thumbnail/9x16-quote` → `200 image/jpeg 268846 bytes` |
| Display is the defect | Library grid renders posters at **164 CSS px** but downloads the **1080 px, ~270 KB** original. After 20 s: **38 of 63** images loaded, 45 requests, 4.1 MB |
| Caching is wrong | Route sets `private, max-age=0, must-revalidate`, so every visit re-downloads everything (~27 MB for 100 episodes) |
| Voice backend is done | `POCKET_VOICES` has 12 entries; `synthesizeVoiceover` already reads `getSetting("voiceId")` |
| Voice UI is blocked | `<select disabled>` in `Inspector.tsx`; `PUT /api/settings` accepts `theme` only and 400s on anything else |
| Ducking already exists | `sidechaincompress=threshold=0.05:ratio=6:attack=20:release=500` in `ffmpeg.ts` |
| Moods are fixed | `MOODS` has 4 entries, selected by theme via `MOOD_TO_STYLE` |

Two corrections to the original request follow from this: thumbnail
generation is **not** broken, and narration-aware ducking is **already
implemented**. The work is display performance, operator control, and
recording what was used.

## Design

### 1. Thumbnails

#### 1a. The loading defect (fix first)

A `size` query parameter, not a new key. `selectThumb` pins the resolved
filename to exactly `<key>.jpg` and `isThumbKey` rejects `@`, so encoding
the variant in the key would break a deliberate security invariant. The
key matching stays byte-for-byte identical.

```
GET /api/episodes/<id>/thumbnail/<key>           → full-resolution JPEG (unchanged)
GET /api/episodes/<id>/thumbnail/<key>?size=grid → 324x576 WebP, ~25 KB
```

`size` is validated against a closed set (`grid` only; absent means
full). Anything else is treated as absent, never echoed, never joined to
a path.

Derivation is lazy and cached, which is what makes the 139 existing
episodes work without re-rendering:

1. Request arrives for `?size=grid`.
2. If `.bookreel/thumbs/<id>/grid/<key>.webp` exists, stream it.
3. Otherwise derive it from the already-validated full-resolution path
   with `sharp` (already a dependency, already used in four modules),
   write it, then stream it.
4. If derivation fails for any reason, **fall back to streaming the full
   JPEG**. A slow poster beats a broken one.

New episodes also write grid variants during `generateThumbnails`, so the
first request is already warm.

Caching: a given episode+key's bytes never change once written, so

```
Cache-Control: private, max-age=31536000, immutable
ETag: <sha256 of file, first 16 hex chars>
```

`private` is retained — the existing comment is right that a shared proxy
must never hand one operator's page photograph to another. Only the
browser caches.

#### 1b. Selection and headline editing

Two nullable columns on `Episode` (see Migration):

- `thumbChoice` — the key the operator picked as *the* poster.
- `thumbHeadline` — their edited headline text, when they overrode it.

`LibraryGrid` and any future publish step read `thumbChoice`, falling
back to today's behaviour (first `9:16`) when it is null. Every episode
that predates this change therefore keeps working unchanged.

Editing a headline re-renders that variant rather than overlaying text in
the browser, so the downloadable file and the on-screen preview can never
disagree:

```
POST /api/episodes/<id>/thumbnail        { variant, headline? }
```

The handler re-runs the existing HTML→screenshot path for that variant in
both aspect ratios with `ThumbCopy.title` replaced, writes the files,
updates the stored specs, and invalidates the cached grid derivative.
`headline` is trimmed, length-capped, and HTML-escaped by the existing
`escapeHtml` before it reaches the template.

#### 1c. Poster redesign

Applied to the existing three variants, with legibility at 164 px as the
acceptance bar: a larger minimum type size in the `FIT_SCRIPT` binary
search, a stronger scrim behind text on photographic grounds,
subject-aware cropping using the `focus` box already computed in
`pipeline.ts`, and a contrast floor so light themes stop washing out.

### 2. Voice

#### 2a. Settings route

`PUT /api/settings` is widened from theme-only to a validated key set.
Each key keeps its own guard, in the shape of the existing
`isThemeSetting`:

| Key | Validated against |
|---|---|
| `theme` | `isThemeSetting` (unchanged) |
| `voiceId` | `POCKET_VOICES` ids |
| `voiceProvider` | `pocket` \| `elevenlabs` \| `openai` \| `system` |
| `musicMood` | `MUSIC_MOODS` ids + `auto` |
| `musicIntensity` | `0` \| `1` \| `2` (sparse / default / full) |
| `musicLevel` | integer dB, −40..−13 |
| `musicDuck` | `off` \| `light` \| `normal` \| `strong` |

An unknown value is a 400 with a `code`, never a silent write. `GET`
returns every key with its resolved effective value. Partial updates are
supported: a body naming only `voiceId` leaves the rest untouched.

#### 2b. The picker

The `<select>` loses `disabled` and gains real state, using the same
optimistic-write-with-rollback that `choose()` already uses for themes.
Twelve voices grouped by gender, each showing its existing note
("deep, deliberate").

#### 2c. Preview

```
POST /api/voice/preview   { voiceId }  →  audio/wav
```

Synthesizes one short fixed sentence through `synthPocket` and returns
the bytes. It never enqueues an episode, never touches the pipeline,
never writes to `Episode`. It validates `voiceId` against `POCKET_VOICES`
before synthesis. Results are cached on disk by voice id, so previewing
the same voice twice costs one synthesis.

First call pays the ~25 s Pocket TTS model load if the server is cold;
the UI shows a pending state and a hint saying so rather than appearing
hung.

#### 2d. Recording what was used

`synthesizeVoiceover` already resolves the voice. It returns the resolved
id and provider, and `pipeline.ts` stamps them onto the episode row, so
the library can state what a finished video was actually narrated with
rather than what the setting says today.

### 3. Music

#### 3a. Richer synthesis

`renderPad` currently produces three sustained chord voices. It gains,
behind an `intensity` parameter (0–2, default 1):

- a root-following **bass** line an octave below,
- a gentle **arpeggio** on the chord tones, phrased against
  `chordSeconds`,
- soft **percussive accents** on chord changes at higher intensities.

All of it is synthesized arithmetically in `music-synth.ts`, exactly as
now. **No sample files, no downloads, no external licensing** — this is a
hard constraint, and any change to it requires asking first.

Determinism is preserved: no randomness, no clock. The same episode at
the same settings renders the same bed, byte for byte.

**What "preserve current behaviour" means here.** The richer layers are
on by default — that is the point of the work, and a default that hid
them would make §3a dead code. What is preserved is the *mood selection
logic*: with mood `auto`, the theme still picks the mood through
`MOOD_TO_STYLE`, and that mood's progression, root and chord length are
untouched. So a re-rendered episode keeps its harmonic identity and
simply sounds fuller.

The existing synthesis path is pinned by construction rather than by
promise: `intensity: 0` must emit a bed byte-identical to the current
build. The new layers are strictly additive on top of an unmodified
`renderPad` core, and criterion 19 tests exactly that. This gives a hard
regression gate without forcing the default to be the old thin pad.

#### 3b. Ten moods

The four existing moods keep their ids, progressions, roots and chord
lengths **exactly as they are**, so every current episode re-renders
identically. Six are added, each a named chord progression and timbre in
the same `MusicMood` shape.

#### 3c. Controls

Mood, intensity, level and duck strength in the inspector, replacing the
read-only `StatRow`s. The default for mood is `auto`, which means today's
selection — derived from the theme via `MOOD_TO_STYLE` — so an operator
who touches nothing keeps the harmony they have now.

`generateMusicBed` takes `intensity`, `level` and `duck` options. `duck`
maps to the existing `sidechaincompress` parameters; `off` skips the
second pass, which is the already-implemented no-voice path.

## Migration

One migration, four nullable columns, no backfill, no data loss:

```prisma
model Episode {
  // ...
  voiceId       String?  // resolved voice the narration actually used
  voiceProvider String?  // which engine resolved it
  thumbChoice   String?  // operator-selected poster key
  thumbHeadline String?  // operator-edited headline
}
```

Every column is nullable and every reader has a defined null behaviour,
so rows written by the current build keep rendering and keep listing. Run
with `npm run db:push` (SQLite, `prisma/dev.db`).

**The dev server must be restarted after `prisma generate`** — a running
Next.js dev server keeps the Prisma client it booted with, which is the
failure `assertModels` in `db.ts` exists to name. The affected routes call
`assertModels` so the error says this instead of a blank 500.

## Acceptance criteria

### Thumbnails

1. Opening the library with 100 episodes renders **every** visible poster
   within **3 seconds** on this machine, verified by an `e2e-*` script
   asserting `img.complete && img.naturalWidth > 0` for all in-viewport
   images. (Baseline today: 38 of 63 after 20 s.)
2. A second visit to the library issues **zero** thumbnail image requests
   that transfer a body — all served from browser cache (304 or memory).
3. Grid payload for a 100-episode library is **under 3 MB** total.
   (Baseline today: ~27 MB.)
4. All three variants are previewable per episode, in both aspects.
5. Selecting a poster persists; after a hard refresh the same poster is
   shown as selected.
6. Editing a headline re-renders that variant; the new text appears in
   the preview **and** in the downloaded full-resolution file.
7. The full-resolution original remains downloadable at the unchanged URL.
8. Deleting the grid cache directory causes posters to be re-derived on
   next request, not to break.
9. A `sharp` failure falls back to the full JPEG rather than a broken image.
10. **Thumbnail generation never fails or blocks a video render** — the
    existing contract, covered by a test that renders with a poisoned
    thumbnail path and asserts the episode still reaches DONE with a video.

### Voice

11. All 12 Pocket TTS voices appear, with name, gender and note.
12. Selecting a voice persists across refresh and is returned by `GET /api/settings`.
13. `PUT /api/settings` with an unsupported `voiceId` returns **400** and does not write.
14. Preview plays audio for the selected voice and **creates no Episode row** —
    asserted by comparing `episode.count()` before and after.
15. A finished episode records the voice actually used, visible in the API response.
16. A failed preview surfaces a toast and leaves the inspector usable.
17. Existing episodes with no `voiceId` continue to list and render.

### Music

18. Ten moods selectable; `auto` is the default and reproduces today's
    theme-derived choice exactly.
19. `intensity: 0` produces a **byte-identical** music bed to the current
    build, for every one of the four existing moods. This is the
    regression gate proving the new layers are strictly additive and the
    existing `renderPad` core is untouched. (The shipped default is
    intensity 1 — fuller, same harmony. See §3a.)
20. Level and duck controls change the mix audibly and are bounded to
    their validated ranges. The level range was narrowed from −6 to **−13**
    during implementation: above about −12 a peak ceiling silently held the
    delivered level back, so the readout lied by up to 4 dB and re-introduced
    mood-to-mood level spread. Measured over 6,540 renders, −13 is the highest
    whole decibel at which every slider position delivers exactly what it says.
21. Ducking remains narration-aware; `duck: off` produces an unducked bed.
22. No network request and no file download occurs during music generation.

### Reliability

23. All existing tests pass (`npm test`).
24. `npm run typecheck` and `npm run lint` are clean.
25. No existing API route changes its response shape in a
    backwards-incompatible way; `size` and the new settings keys are
    additive.
26. A thumbnail failure, a voice preview failure, and a music failure each
    leave the inspector usable and the render unaffected.

## Out of scope

Frontend restructuring (collapsible rails, layout, spacing), the ten
cinematic themes, and YouTube/Instagram auto-publish. Each gets its own
spec after this lands.

## Testing

`node --test` over `tests/*.test.mts`, plus browser-driven `scripts/e2e-*.mjs`
in the existing style.

- `tests/settings-route.test.mts` — per-key accept/reject.
- `tests/thumbnails-grid.test.mts` — derivation, cache hit, fallback, key safety.
- `tests/music-moods.test.mts` — registry integrity, byte-identical `auto` bed.
- `tests/voice-preview.test.mts` — validation, no episode created.
- `scripts/e2e-thumbnails.mjs` — the load-time regression test for the
  reported bug, asserting criteria 1–3 against a real session.
