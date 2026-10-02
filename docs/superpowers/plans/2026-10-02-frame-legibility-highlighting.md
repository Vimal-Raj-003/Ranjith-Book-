# Frame, Legibility and Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the composition one module that owns its layout, move the byline to the top, delete the cue chip, lift the captions clear of the publishing platforms' own overlays, and replace the flat highlight bar with a camera push-in onto sharp, high-resolution page pixels.

**Architecture:** A new pure module, `composition/frame.ts`, holds the frame's bands, its platform-reserved regions and a `gridViolations()` checker. Every absolutely positioned element in `build.ts` is repositioned from that module instead of its own constant, and both a unit test and a live-browser test call the same checker, so a collision becomes a failing test rather than something spotted in a render. On top of that, the episode's pages are re-rendered at 3200 px (vector PDFs only), page scenes get a wide/medium/close shot size, and the highlight becomes a scale-and-track of the existing `#card-zoom` / `#column` pair with the surrounding page dimmed.

**Tech Stack:** TypeScript, Next.js 16, GSAP 3.14 (CDN), HyperFrames CLI renderer (headless Chrome screenshot capture), PyMuPDF via a Python child process, `node:test` + `tsx` for tests, `playwright-core` for live-browser tests.

**Spec:** `docs/superpowers/specs/2026-10-02-frame-legibility-highlighting-design.md`

## Global Constraints

- Frame is 1080 × 1920. Never change `FRAME`.
- `CONTENT_WIDTH = 820`, centred, so `CONTENT_X = 130` and content ends at x = 950, exactly where the action rail begins.
- Caption band is bottom-anchored at y = 1560; captions are clamped to **two lines**, stepping font-size 60 px → 52 px rather than growing a third line.
- Every absolutely positioned element uses `top:`, never `bottom:` — a `bottom:`-positioned element driven by an `autoAlpha` tween never paints in the real renderer. This is load-bearing; see the `CAPTION_BASELINE` doc comment in `build.ts`.
- One tween per element per property, non-overlapping. `overlappingAnims()` in `scenes/render.ts` enforces it and `e2e-seek.mjs` proves it.
- Any effect driven by `onUpdate` must compute its state from `tl.time()`, never accumulate — the renderer seeks non-linearly with `suppressEvents=false`.
- All existing word geometry (OCR boxes, line runs, sweep steps, camera keys) stays in 1600 px page space. Hi-res assets are a display-time multiply only.
- A missing or failed optional asset must never fail a render.
- Photo episodes (no `scenes`) must render exactly as they do today.
- Run a single test file with: `DATABASE_URL="file:./dev.db" npx tsx --test tests/<name>.test.mts`
- Run the whole suite with: `npm test`. Baseline on this branch is 591 tests, 576 passing; the 10 failures + 1 cancelled are known Windows-only issues (fake-CLI `spawn EFTYPE`, `measurePage` timeout, 2 vision-parse prototype checks). Do not count those as regressions, and do not let the count of them grow.
- Never start a task while an episode is generating on the dev server — editing `src/` mid-render makes Turbopack panic and kills both.

## One deliberate deviation from the spec

Spec §2 says the cinematic heroes' per-hero `FIT` table should be "re-derived
from the grid rather than hand-tuned". This plan does **not** do that. That table
was tuned by eye against real renders of all fifteen heroes, and re-deriving it
mechanically would risk regressing a look that is already verified, to fix a
collision that can be prevented more cheaply. Instead, Task 5's live-browser test
asserts that `.cine-key`, `.cine-lead` and `.cine-hook` stay inside the stage
band at every sampled instant, and the fix — if any hero violates it — is to
clamp that hero's type, not to rebuild the table. The spec's intent (hero type
never collides with the byline or the captions) is met; its proposed mechanism is
not. If a reviewer disagrees, this is the line to argue with.

## Review Focus

Five failure modes the spec implies that no task's happy-path test would catch. Each has a test attached to the task that owns the code.

1. **A caption too long for two lines even at 52 px** — it must clip or ellipsise inside the caption band, never grow upward into the stage and over the page card. (Task 4)
2. **A cited line box wider than the frame allows at `close` scale** — the shot must downgrade to `medium` rather than crop the quoted words out of frame. (Task 7)
3. **A scanned PDF with no extractable text** — hi-res is skipped, and the composition must reference the 1600 px asset, never a `@2x` file that was never written. The library contains a real one (`cmukwbffp…`, 0 text chars, 1 embedded image). (Task 6)
4. **A hi-res render that fails midway** — missing Python, missing PDF, full disk. The episode must complete on the 1600 px assets and record a note. (Task 6)
5. **An episode with no scenes** — shot grammar, dimming and `hiSrc` must all collapse to nothing, and the photo-episode composition must be byte-for-byte what it is today. (Task 8)

---

### Task 1: The frame grid module

**Files:**
- Create: `src/lib/video/composition/frame.ts`
- Create: `tests/frame.test.mts`

**Interfaces:**
- Consumes: nothing. This is a leaf module with no imports from the codebase.
- Produces: `FRAME: {width:number; height:number}`, `Box {x,y,w,h}`, `BandName = "progress"|"title"|"stage"|"caption"`, `BANDS: Record<BandName, Band>` where `Band = {top:number; bottom:number; x:number; w:number}`, `TEXT_BANDS: BandName[]`, `RESERVED: {name:string; box:Box}[]`, `CONTENT_WIDTH: number`, `CONTENT_X: number`, `bandBox(name: BandName): Box`, `overlaps(a: Box, b: Box): boolean`, `gridViolations(items: {name:string; box:Box}[]): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/frame.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME,
  BANDS,
  TEXT_BANDS,
  RESERVED,
  CONTENT_WIDTH,
  CONTENT_X,
  bandBox,
  overlaps,
  gridViolations,
  type BandName,
} from "../src/lib/video/composition/frame";

test("the bands run down the frame in order, never touching", () => {
  const order: BandName[] = ["progress", "title", "stage", "caption"];
  let prevBottom = -1;
  for (const name of order) {
    const b = BANDS[name];
    assert.ok(b.top > prevBottom, `${name} starts below the band above it`);
    assert.ok(b.bottom > b.top, `${name} has height`);
    assert.ok(b.bottom <= FRAME.height, `${name} is inside the frame`);
    prevBottom = b.bottom;
  }
});

test("no band that carries TEXT reaches a region the platforms cover with their own UI", () => {
  for (const name of TEXT_BANDS) {
    for (const r of RESERVED) {
      assert.equal(overlaps(bandBox(name), r.box), false, `the ${name} band overlaps ${r.name}`);
    }
  }
});

test("content is narrow enough to clear the action rail, and stays centred", () => {
  const rail = RESERVED.find((r) => r.name === "action-rail")!;
  assert.equal(CONTENT_X + CONTENT_WIDTH, rail.box.x, "content ends exactly where the rail begins");
  assert.equal(CONTENT_X, FRAME.width - (CONTENT_X + CONTENT_WIDTH), "equal margins either side");
});

test("a two-line caption fits its band and still clears the page card", () => {
  // 60px type, 1.2 line-height, 16px padding top and bottom.
  const twoLines = 60 * 1.2 * 2 + 32;
  const caption = BANDS.caption;
  assert.ok(twoLines <= caption.bottom - caption.top, `two lines (${twoLines}px) fit the caption band`);
  assert.ok(caption.bottom - twoLines > BANDS.stage.bottom, "a two-line caption starts below the stage");
});

test("gridViolations names what is wrong, and says nothing when all is well", () => {
  assert.deepEqual(gridViolations([{ name: "caption", box: bandBox("caption") }]), []);

  const sunk = gridViolations([{ name: "caption", box: { x: 130, y: 1700, w: 820, h: 100 } }]);
  assert.equal(sunk.length, 1);
  assert.match(sunk[0], /caption.*reels-bottom/);

  const wide = gridViolations([{ name: "caption", box: { x: 130, y: 1400, w: 900, h: 100 } }]);
  assert.match(wide[0], /caption.*action-rail/);

  const clash = gridViolations([
    { name: "byline", box: { x: 0, y: 300, w: 100, h: 100 } },
    { name: "caption", box: { x: 50, y: 350, w: 100, h: 100 } },
  ]);
  assert.match(clash[0], /byline.*overlaps.*caption/);

  const outside = gridViolations([{ name: "stray", box: { x: -10, y: 300, w: 50, h: 50 } }]);
  assert.match(outside[0], /stray.*outside the frame/);
});

test("touching edges are not an overlap", () => {
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/frame.test.mts`
Expected: FAIL — `Cannot find module '../src/lib/video/composition/frame'`

- [ ] **Step 3: Write the module**

Create `src/lib/video/composition/frame.ts`:

```ts
/**
 * The frame's layout, in one place.
 *
 * Before this module every absolutely positioned element in `build.ts` carried
 * its own hardcoded `y` — `BYLINE_Y = 1388`, `CUE_TOP = 1450`,
 * `CAPTION_BASELINE = 1720` — and nothing compared them against each other, or
 * against the full-frame cinematic heroes, or against the chrome the publishing
 * platforms draw over the video. A collision was therefore invisible until
 * somebody watched a render, and one shipped: the bottom of every caption sat
 * under Instagram's own caption row.
 *
 * Elements now ask this module where they go, and `gridViolations` is called by
 * both a unit test and a live-browser test, so a collision fails a test instead.
 */

export const FRAME = { width: 1080, height: 1920 } as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Band {
  top: number;
  bottom: number;
  x: number;
  w: number;
}

export type BandName = "progress" | "title" | "stage" | "caption";

/**
 * How wide anything carrying text may be.
 *
 * 820 rather than the full frame so that a centred element ends at x=950,
 * exactly where both platforms' button rail begins. The captions were 920 wide,
 * which put their last 35px under it.
 */
export const CONTENT_WIDTH = 820;
export const CONTENT_X = (FRAME.width - CONTENT_WIDTH) / 2;

export const BANDS: Record<BandName, Band> = {
  /** The progress bar, hard against the top edge. */
  progress: { top: 0, bottom: 8, x: 0, w: FRAME.width },
  /** The persistent byline. Above the card, out of every scene's way. */
  title: { top: 60, bottom: 150, x: CONTENT_X, w: CONTENT_WIDTH },
  /** The page card, the cinematic heroes, and all scene type. */
  stage: { top: 200, bottom: 1370, x: 0, w: FRAME.width },
  /** Captions, bottom-anchored at `bottom`, growing upward to at most two lines. */
  caption: { top: 1380, bottom: 1560, x: CONTENT_X, w: CONTENT_WIDTH },
};

/** The bands that carry words, and so must clear the platforms' own chrome. */
export const TEXT_BANDS: BandName[] = ["title", "caption"];

/**
 * What the publishing platforms draw over the video.
 *
 * The stage deliberately runs under the action rail: the page card is imagery,
 * and nobody needs its right margin. Only `TEXT_BANDS` are held clear.
 */
export const RESERVED: { name: string; box: Box }[] = [
  /** Instagram Reels: username, caption and the audio ticker. */
  { name: "reels-bottom", box: { x: 0, y: 1670, w: FRAME.width, h: FRAME.height - 1670 } },
  /** YouTube Shorts: the title and channel row. */
  { name: "shorts-bottom", box: { x: 0, y: 1760, w: FRAME.width, h: FRAME.height - 1760 } },
  /** Both platforms' like / comment / share column. */
  { name: "action-rail", box: { x: 950, y: 1000, w: FRAME.width - 950, h: 800 } },
];

export function bandBox(name: BandName): Box {
  const b = BANDS[name];
  return { x: b.x, y: b.top, w: b.w, h: b.bottom - b.top };
}

/** Strict overlap: boxes that merely share an edge do not overlap. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Every way a set of placed boxes can be wrong, named. Empty means the layout is
 * sound. Pure, so the unit test and the live-browser test share one judgement.
 */
export function gridViolations(items: { name: string; box: Box }[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const { name, box } = item;
    if (box.x < 0 || box.y < 0 || box.x + box.w > FRAME.width || box.y + box.h > FRAME.height) {
      out.push(`${name} is outside the frame: ${JSON.stringify(box)}`);
    }
    for (const r of RESERVED) {
      if (overlaps(box, r.box)) out.push(`${name} reaches into ${r.name}, which the platform covers`);
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let k = i + 1; k < items.length; k++) {
      if (overlaps(items[i].box, items[k].box)) {
        out.push(`${items[i].name} overlaps ${items[k].name}`);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/frame.test.mts`
Expected: PASS — 6 tests

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/lib/video/composition/frame.ts tests/frame.test.mts
git commit -m "feat(composition): a frame grid that owns the layout and the platforms' safe areas"
```

---

### Task 2: Move the byline to the title band

**Files:**
- Modify: `src/lib/video/composition/build.ts` — the layout doc comment (lines 28–34), `BYLINE_Y` (line 92), `.byline` CSS (lines 813–816)
- Modify: `tests/composition.test.mts` — the byline position test (lines ~730–745)

**Interfaces:**
- Consumes: `BANDS`, `CONTENT_WIDTH` from Task 1.
- Produces: `BYLINE_Y` keeps its name and export so nothing else breaks, but its value now comes from `BANDS.title.top`.

- [ ] **Step 1: Update the failing test**

In `tests/composition.test.mts`, replace the two assertions at lines 733–734:

```ts
  assert.match(html, new RegExp(`\\.byline \\{[^}]*top:${BYLINE_Y}px`));
  assert.equal(BYLINE_Y, 1388);
```

with:

```ts
  assert.match(html, new RegExp(`\\.byline \\{[^}]*top:${BYLINE_Y}px`));
  assert.equal(BYLINE_Y, BANDS.title.top, "the byline sits in the title band");
  assert.ok(BYLINE_Y < BANDS.stage.top, "the byline is above the page card, not under it");
  assert.match(html, new RegExp(`\\.byline \\{[^}]*max-width:${CONTENT_WIDTH}px`));
```

and fix the stale comment on lines 738–739 to read:

```ts
  // One line, always: nowrap plus an ellipsis, never a second row of type
  // pushing down into the stage.
```

Add to that file's imports:

```ts
import { BANDS, CONTENT_WIDTH } from "../src/lib/video/composition/frame";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: FAIL — `BYLINE_Y` is 1388, `BANDS.title.top` is 60

- [ ] **Step 3: Move the byline**

In `build.ts`, add to the imports at the top of the file:

```ts
import { BANDS, CONTENT_WIDTH, FRAME as GRID_FRAME } from "./frame";
```

Replace the `BYLINE_Y` declaration (line 92) and its doc comment with:

```ts
/**
 * The persistent byline (spec 2026-08-23 §9): book title, and the author ONLY
 * when the four-link verification chain passed upstream.
 *
 * It lives in the title band at the TOP of the frame. It used to sit at 1388,
 * between the card and the captions, where the full-frame cinematic heroes draw
 * straight through it.
 *
 * It carries NO tween at all. That is the cheapest thing there is to seek
 * correctly, and it is also what "persistent" means: the title is on screen for
 * every frame of the video, including the ones a viewer screenshots.
 */
export const BYLINE_Y = BANDS.title.top;
```

Replace the `.byline` CSS block (lines 813–816) with:

```ts
  .byline { position:absolute; left:50%; top:${BYLINE_Y}px; transform:translateX(-50%);
            max-width:${CONTENT_WIDTH}px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            font-size:28px; font-weight:600; letter-spacing:0.3px; line-height:1.2;
            font-family: Inter, system-ui, sans-serif; color:${p.bylineInk}; }
```

Update the layout map comment at lines 28–34 to:

```ts
 *   y=0     progress bar, full width, PROGRESS_H tall
 *   y=60    byline                                   ┐ frame.ts BANDS.title
 *   y=250   card top          ┐                      │
 *   ...     the photographed  │ CARD_H = 1120        │ frame.ts BANDS.stage
 *   y=1370  card bottom       ┘                      ┘
 *   y=1560  caption baseline                           frame.ts BANDS.caption
 *   y=1670  Instagram's own chrome begins — nothing with words goes below here
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/video/composition/build.ts tests/composition.test.mts
git commit -m "feat(composition): move the byline to the top of the frame"
```

---

### Task 3: Delete the cue chip

**Files:**
- Modify: `src/lib/video/composition/build.ts` — remove `CUE_TOP` (line 100), `CUE_FADE` (line 104), `beatEmoji()` (lines 510–516), `cueMarkup()` (lines 529–537), `.cues`/`.cue`/`.cue-emoji`/`.cue-label` CSS (lines 818–828), the cue timeline loop (lines 997–1005), `cueData` (lines 1780–1785), `cues: cueData` (line 1888), the `<div class="cues">` block (lines 2029–2031)
- Modify: `src/lib/video/composition/themes/blueprint.ts`, `editorial.ts`, `marginalia.ts`, `terminal.ts`, `spotlight.ts` — remove the `.annot` rules
- Modify: `tests/composition.test.mts` — lines ~113–121, ~175–195, ~200–234, ~760–780
- Modify: `tests/beat-emoji.test.mts` — line 59
- Modify: `scripts/e2e-seek.mjs` — drop `.cue` from the tracked selector

**Interfaces:**
- Consumes: nothing new.
- Produces: `composition-data` no longer has a `cues` key. `beatEmoji` is no longer exported from `build.ts`. `Beat.emoji` and `Beat.onScreen` stay in the content schema untouched — the content pipeline still produces them, `sanitizeForSpeech` still strips emoji from narration, and the scene director still reads `onScreen`.

- [ ] **Step 1: Rewrite the tests that assert the cue exists**

In `tests/composition.test.mts`:

Replace the assertion at line 121 (`data-cue="0"` must exist) with its caption-only equivalent, keeping the surrounding test about text being in the DOM at load:

```ts
  assert.ok(!html.includes("data-cue="), "the cue chip is gone");
  assert.ok(html.includes("A hook."), "the caption text is written into the DOM at load, not assigned at runtime");
```

Replace the test at line 175 (`the last beat's cue is marked to hold…`) entirely with:

```ts
test("the composition carries no cue layer at all", () => {
  const html = buildComposition(input());
  for (const gone of ["data-cue=", 'class="cues"', "cue-emoji", "cue-label", ".annot"]) {
    assert.ok(!html.includes(gone), `${gone} must be gone from the composition`);
  }
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]);
  assert.equal("cues" in data, false, "composition-data must not carry a cues array");
  const js = html.split("<script>")[1] ?? "";
  assert.ok(!js.includes("cue"), "the runtime script must not reference cues");
});
```

Retarget the live-browser test at line 200 — what it really proves is that the final element holds through the outro tail, which is now the caption's job. Replace its body's cue selector `'[data-cue="1"]'` with the last caption line, and rename it:

```ts
test("tl.duration() and data-duration agree, and the final caption is genuinely visible through the tail (live browser)", async () => {
```

and inside the page evaluation replace:

```ts
        const el = document.querySelector('[data-cue="1"]');
```

with:

```ts
        const lines = document.querySelectorAll(".caption-line");
        const el = lines[lines.length - 1];
```

and update the three assertion messages on lines ~230–234 from "cue" to "caption".

Replace the emoji test at line 768 with one that proves the emoji never reaches the composition at all:

```ts
test("a beat's emoji never reaches the rendered composition, and never reaches anything spoken", () => {
  const html = buildComposition(withEmoji("🔥"));
  assert.ok(!html.includes("🔥"), "the emoji has no on-screen home now that the cue chip is gone");

  // §10: emoji may appear in social copy, NEVER in anything spoken.
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    captions: { text: string }[];
  };
  for (const c of data.captions) assert.ok(!/\p{Extended_Pictographic}/u.test(c.text));
});
```

Delete any now-unused `beatEmoji` import from that file.

In `tests/beat-emoji.test.mts`, line 59, change the message only:

```ts
  assert.equal(p.beats[0].emoji, "🕯️", "the beat still carries its emoji for social copy");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: FAIL — the cue markup, CSS and data are all still present

- [ ] **Step 3: Delete the cue**

In `build.ts` delete, in this order:

1. The `CUE_TOP` constant and its doc comment (lines 94–100).
2. `const CUE_FADE = 0.2;` (line 104).
3. The `beatEmoji` function and its doc comment (lines ~495–516), and `EMOJI_MAX_CHARS` if nothing else uses it — check with `grep -n EMOJI_MAX_CHARS src/lib/video/composition/build.ts`.
4. The `cueMarkup` function and its doc comment (lines ~518–537).
5. The CSS block `.cues` … `.cue-label` (lines 818–828).
6. The cue timeline loop (lines 997–1005).
7. The `cueData` constant (lines 1780–1785).
8. `cues: cueData,` from the composition-data object (line 1888).
9. The markup block:

```ts
    <div class="cues">
      ${cueMarkup(pkg)}
    </div>
```

In each theme file under `src/lib/video/composition/themes/`, delete the `.annot` rule and any `.annot::before`. In `blueprint.ts` that is lines ~137 and ~142; in `editorial.ts` ~133; `marginalia.ts`, `terminal.ts` and `spotlight.ts` each have one. Leave the surrounding doc comments that explain the theme's type choices, but remove sentences that describe the cue card.

In `scripts/e2e-seek.mjs`, remove `.cue, ` from the tracked selector string and delete the `el.dataset.cue !== undefined ? \`cue:${el.dataset.cue}\` :` branch from the key expression.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts tests/beat-emoji.test.mts`
Expected: PASS

- [ ] **Step 5: Typecheck and prove nothing else referenced the cue**

Run: `npx tsc --noEmit && grep -rn "cueMarkup\|cueData\|beatEmoji\|CUE_TOP\|CUE_FADE\|data-cue" src tests scripts`
Expected: tsc silent; grep prints nothing

- [ ] **Step 6: Commit**

```bash
git add -A src/lib/video/composition tests/composition.test.mts tests/beat-emoji.test.mts scripts/e2e-seek.mjs
git commit -m "feat(composition): delete the cue chip, which duplicated the scene's own type"
```

---

### Task 4: Raise and narrow the captions

**Files:**
- Modify: `src/lib/video/composition/build.ts` — `CAPTION_BASELINE` (line 78), `.caption-line` CSS (lines 830–835), and the caption markup function
- Modify: `tests/composition.test.mts`

**Interfaces:**
- Consumes: `BANDS`, `CONTENT_WIDTH` from Task 1.
- Produces: `CAPTION_BASELINE` keeps its name and export; its value is now `BANDS.caption.bottom`. New export `CAPTION_MAX_LINES = 2` and `captionFontSize(text: string): number` returning 60 or 52.

- [ ] **Step 1: Write the failing test**

Add to `tests/composition.test.mts`:

```ts
test("captions sit in the caption band, clear of both platforms' chrome, at most two lines", () => {
  const html = buildComposition(input());
  assert.equal(CAPTION_BASELINE, BANDS.caption.bottom);
  assert.match(html, new RegExp(`\\.caption-line \\{[^}]*top:${CAPTION_BASELINE}px`));
  assert.match(html, new RegExp(`\\.caption-line \\{[^}]*max-width:${CONTENT_WIDTH}px`));
  // Anchored by its BOTTOM edge, so a second line grows upward into the band.
  assert.match(html, /\.caption-line \{[^}]*transform:translate\(-50%, ?-100%\)/);
  assert.doesNotMatch(html, /\.caption-line \{[^}]*bottom:/);

  // The whole point: a two-line caption clears the card above and Instagram below.
  const twoLines = 60 * 1.2 * 2 + 32;
  assert.ok(CAPTION_BASELINE - twoLines > BANDS.stage.bottom, "two lines clear the page card");
  const reels = RESERVED.find((r) => r.name === "reels-bottom")!;
  assert.ok(CAPTION_BASELINE <= reels.box.y, "no caption pixel is under Instagram's caption row");
});

test("a caption too long for two lines steps its type down rather than growing a third", () => {
  const short = "Follow for more.";
  const long = "An extraordinarily long caption line that no reasonable splitter would ever produce but which must still not grow upward over the page card";
  assert.equal(captionFontSize(short), 60);
  assert.equal(captionFontSize(long), 52);
  // Even at the smaller size it is clamped, not allowed to run on.
  const html = buildComposition(input());
  assert.match(html, /\.caption-line \{[^}]*-webkit-line-clamp:2/);
  assert.match(html, /\.caption-line \{[^}]*overflow:hidden/);
});
```

Add `CAPTION_BASELINE` and `captionFontSize` to that file's `build` import, and `RESERVED` to its `frame` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: FAIL — `CAPTION_BASELINE` is 1720, `captionFontSize` is not exported

- [ ] **Step 3: Raise, narrow and clamp the captions**

In `build.ts`, replace the `CAPTION_BASELINE` declaration (keeping the whole `top:`-not-`bottom:` doc comment above it, which is still load-bearing, but replacing its last paragraph):

```ts
/**
 * 1560, from `BANDS.caption.bottom`: the bottom 250px of a Reel is covered by
 * Instagram's username, caption and audio ticker, and the bottom 160px of a
 * Short by its title row. The baseline was 1720, which put the lower ~50px of
 * every caption under Instagram's own text.
 */
export const CAPTION_BASELINE = BANDS.caption.bottom;

/** A caption is two lines at most; a longer one shrinks rather than growing. */
export const CAPTION_MAX_LINES = 2;

/**
 * 60px normally, 52px for a line long enough to wrap past two rows at 60.
 *
 * ~17 characters fit a 820px row at 60px in this weight; two rows is ~34. The
 * threshold is deliberately generous — stepping down a caption that would have
 * fitted costs nothing, while a third row would push type over the page card.
 */
export function captionFontSize(text: string): number {
  return text.length > 34 ? 52 : 60;
}
```

Replace the `.caption-line` CSS block with:

```ts
  .caption-line { position:absolute; left:50%; top:${CAPTION_BASELINE}px;
                  transform:translate(-50%, -100%);
                  max-width:${CONTENT_WIDTH}px; width:max-content; text-align:center; font-size:60px;
                  font-weight:800; line-height:1.2; padding:16px 30px; border-radius:20px;
                  display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:${CAPTION_MAX_LINES};
                  overflow:hidden;
                  opacity:0; visibility:hidden; font-family: Inter, system-ui, sans-serif;
                  background:${p.captionBg}; color:${p.captionInk}; }
```

In the caption markup function (find it with `grep -n "caption-line" src/lib/video/composition/build.ts`), add the per-line font size as an inline style, so only the long lines shrink:

```ts
`<div class="caption-line" data-caption="${i}" style="font-size:${captionFontSize(line.text)}px">${esc(line.text)}</div>`
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/video/composition/build.ts tests/composition.test.mts
git commit -m "feat(composition): raise and narrow the captions clear of Reels and Shorts chrome"
```

---

### Task 5: Prove nothing collides, in a real browser

**Files:**
- Modify: `src/lib/video/composition/build.ts` — audit and reposition `#hook-text`, `#cta-card`, `#buy-card`, `.scene-glow`
- Create: `tests/frame-live.test.mts`

**Interfaces:**
- Consumes: `gridViolations`, `BANDS`, `RESERVED` from Task 1; `buildComposition` and `AUDIO_OFFSET` from `build.ts`; `fixtureInput` from `scripts/fixtures/composition-fixture.mjs`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `tests/frame-live.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { buildComposition, type CompositionInput } from "../src/lib/video/composition/build";
import { bookThemeById } from "../src/lib/video/composition/themes";
import { gridViolations, BANDS, type Box } from "../src/lib/video/composition/frame";
import { fixtureInput } from "../scripts/fixtures/composition-fixture.mjs";

const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

/** Every element on the frame that carries words, and where it actually is. */
const TEXT_SELECTORS = ".byline, .caption-line, .cta-card, #buy-card, .hook-text, .sc-cine .cine-key, .sc-cine .cine-lead, .sc-cine .cine-hook";

async function textBoxesAt(page: import("playwright-core").Page, t: number) {
  return within(
    page.evaluate(
      ({ time, sel }) => {
        (window as unknown as { __tl: { seek(t: number, s: boolean): void } }).__tl.seek(time, false);
        const out: { name: string; box: { x: number; y: number; w: number; h: number } }[] = [];
        document.querySelectorAll(sel).forEach((el, i) => {
          const cs = getComputedStyle(el as HTMLElement);
          if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return;
          out.push({
            name: `${(el as HTMLElement).className || el.tagName}#${i}`,
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        });
        return out;
      },
      { time: t, sel: TEXT_SELECTORS },
    ),
    30_000,
    `boxes at ${t}`,
  );
}

async function withComposition(html: string, run: (p: import("playwright-core").Page) => Promise<void>) {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await within(page.setContent(html, { waitUntil: "load" }), 30_000, "load");
    await within(page.waitForFunction(() => Boolean((window as unknown as { __tl?: unknown }).__tl), null, { timeout: 30_000 }), 35_000, "timeline");
    await new Promise((r) => setTimeout(r, 1500));
    await run(page);
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser.close();
  }
}

for (const themeId of ["editorial", "marginalia"]) {
  test(`no word on screen ever collides or falls under platform chrome — ${themeId} (live browser)`, async () => {
    const theme = bookThemeById(themeId);
    const html = buildComposition({
      ...(fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput),
      bookTitle: "A Fixture Book With A Deliberately Long Title",
      author: "A Verified Author",
    });
    await withComposition(html, async (page) => {
      const duration = await page.evaluate(() => (window as unknown as { __tl: { duration(): number } }).__tl.duration());
      for (let i = 0; i < 24; i++) {
        const t = (duration * (i + 0.5)) / 24;
        const boxes = await textBoxesAt(page, t);
        const bad = gridViolations(boxes as { name: string; box: Box }[]);
        assert.deepEqual(bad, [], `at t=${t.toFixed(2)}s: ${bad.join(" | ")}`);
      }
    });
  });
}

test("the byline is above the stage and the captions below it, at every sampled instant (live browser)", async () => {
  const theme = bookThemeById("editorial");
  const html = buildComposition({
    ...(fixtureInput({ theme, withScenes: true, cinematic: true }) as unknown as CompositionInput),
    bookTitle: "Fixture",
  });
  await withComposition(html, async (page) => {
    for (const t of [0.5, 4, 8, 12]) {
      const boxes = await textBoxesAt(page, t);
      for (const b of boxes) {
        if (b.name.includes("byline")) assert.ok(b.box.y + b.box.h <= BANDS.stage.top, `byline at ${b.box.y}`);
        if (b.name.includes("caption-line")) assert.ok(b.box.y >= BANDS.stage.bottom, `caption at ${b.box.y}`);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/frame-live.test.mts`
Expected: FAIL — violations naming whichever of `.hook-text`, `.cta-card` or `#buy-card` sits in a reserved region or overlaps a neighbour

- [ ] **Step 3: Reposition whatever the test named**

For each element the failure names, in `build.ts`:

- `.hook-text` is at `top: CARD_Y + CARD_H / 2` (≈810) — inside the stage, so it should pass. If it fails, it is because its box is wider than `CONTENT_WIDTH`; set `max-width:${CONTENT_WIDTH}px`.
- `.cta-card` and `#buy-card` sit over the lower frame. Give both `max-width:${CONTENT_WIDTH}px` and move their `top` so their boxes end at or above `BANDS.caption.bottom`.
- If a cinematic scene's `.cine-key` or `.cine-hook` overflows the stage, clamp it in `scenes/render.ts`'s `sceneCss` by setting the `.cine-text` / `.cine-hook` `top` and `max-height` from `BANDS.stage`.

Make the smallest change that clears the violation; do not restyle anything the test did not name.

- [ ] **Step 4: Run the test to verify it passes**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/frame-live.test.mts`
Expected: PASS — 3 tests

- [ ] **Step 5: Run the full suite for regressions**

Run: `npm test`
Expected: the known 10 failures + 1 cancelled, and no others

- [ ] **Step 6: Commit**

```bash
git add src/lib/video/composition tests/frame-live.test.mts
git commit -m "test(composition): prove in a real browser that no word collides or falls under platform chrome"
```

---

### Task 6: High-resolution page assets

**Files:**
- Create: `src/lib/pdf/render-pages.py`
- Create: `src/lib/pdf/render-pages.ts`
- Create: `tests/render-pages.test.mts`
- Modify: `src/lib/pipeline.ts` — the `compPages` block (~line 770) and the `writeProject` call (~line 1079)
- Modify: `src/lib/video/composition/build.ts` — `CompositionInput.pages`, `pageMarkup()` (line ~404)

**Interfaces:**
- Consumes: `resolvePython()` from `src/lib/pdf/extract.ts`.
- Produces: `HI_SCALE = 2`, `HI_LONG_EDGE = 3200`, and `renderPagesAt(opts: { pdfPath: string; outDir: string; pageIndices: number[]; longEdge: number }): Promise<Map<number, string>>` returning page index → absolute file path, omitting any page that has no extractable text or failed to render. `CompositionInput.pages[]` gains optional `hiSrc?: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/render-pages.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderPagesAt, HI_LONG_EDGE, HI_SCALE } from "../src/lib/pdf/render-pages";

const VECTOR_PDF = path.join(process.cwd(), ".bookreel", "uploads", "cmuo1h91x0002n60sv9qah7rr", "source.pdf");
const SCANNED_PDF = path.join(process.cwd(), ".bookreel", "uploads", "cmukwbffp0002n6ikm6fvkcff", "source.pdf");

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), "brhi-"));

test("the scale and the long edge agree with the 1600px space every box is measured in", () => {
  assert.equal(HI_LONG_EDGE, 1600 * HI_SCALE);
});

test("a vector page renders at the high resolution and lands where it says it did", async (t) => {
  if (!(await fs.stat(VECTOR_PDF).catch(() => null))) return t.skip("fixture PDF not on this machine");
  const out = await tmp();
  try {
    const got = await renderPagesAt({ pdfPath: VECTOR_PDF, outDir: out, pageIndices: [8, 10], longEdge: HI_LONG_EDGE });
    assert.deepEqual([...got.keys()].sort((a, b) => a - b), [8, 10]);
    for (const p of got.values()) {
      const st = await fs.stat(p);
      assert.ok(st.size > 50_000, `${p} is a real image, not an empty file`);
    }
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("a scanned page is skipped — upscaling a photograph buys nothing", async (t) => {
  if (!(await fs.stat(SCANNED_PDF).catch(() => null))) return t.skip("fixture PDF not on this machine");
  const out = await tmp();
  try {
    const got = await renderPagesAt({ pdfPath: SCANNED_PDF, outDir: out, pageIndices: [0, 1], longEdge: HI_LONG_EDGE });
    assert.equal(got.size, 0, "no page with zero extractable text is rendered");
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("a missing PDF resolves to an empty map rather than throwing — the render must survive it", async () => {
  const out = await tmp();
  try {
    const got = await renderPagesAt({ pdfPath: path.join(out, "nope.pdf"), outDir: out, pageIndices: [0], longEdge: HI_LONG_EDGE });
    assert.equal(got.size, 0);
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/render-pages.test.mts`
Expected: FAIL — `Cannot find module '../src/lib/pdf/render-pages'`

- [ ] **Step 3: Write the Python renderer**

Create `src/lib/pdf/render-pages.py`:

```python
"""Render chosen PDF pages to JPEG at a chosen resolution.

Separate from extract.py on purpose: extract.py walks the whole book and writes
word boxes, per-page JSON and a manifest. This renders a handful of named pages
and nothing else, for the composition's high-resolution page assets.

A page with no extractable text is SKIPPED: it is a scan, and upscaling a
photograph adds no detail, only bytes.

Usage: python render-pages.py <pdf> <out_dir> <long_edge> <index,index,...>

Writes <out_dir>/page-NNNN@2x.jpg per rendered page, then one JSON line:
  {"type": "done", "rendered": [8, 10], "skipped": [11]}
A failure is one line {"type": "error", "code": ..., "message": ...} and exit 2.
"""

import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(code, message):
    emit({"type": "error", "code": code, "message": message})
    sys.exit(2)


def main():
    args = sys.argv[1:]
    if len(args) < 4:
        fail("usage", "usage: render-pages.py <pdf> <out_dir> <long_edge> <indices>")
    pdf_path, out_dir, long_edge, indices = args[0], args[1], int(args[2]), args[3]
    want = [int(i) for i in indices.split(",") if i.strip() != ""]

    try:
        import pymupdf as fitz
    except ImportError:
        fail("no_pymupdf", "PyMuPDF is not installed for this interpreter")

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        fail("open_failed", str(exc))

    rendered, skipped = [], []
    for index in want:
        if index < 0 or index >= doc.page_count:
            skipped.append(index)
            continue
        page = doc[index]
        # A scan has no text layer. Upscaling its photograph buys nothing.
        if len(page.get_text("text").strip()) == 0:
            skipped.append(index)
            continue
        rect = page.rect
        scale = long_edge / max(rect.width, rect.height)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        pix.save("%s/page-%04d@2x.jpg" % (out_dir, index), jpg_quality=88)
        rendered.append(index)

    doc.close()
    emit({"type": "done", "rendered": rendered, "skipped": skipped})


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Write the TypeScript wrapper**

Create `src/lib/pdf/render-pages.ts`:

```ts
/**
 * High-resolution page images for the composition.
 *
 * Every box the pipeline measures — OCR words, line runs, sweep steps, camera
 * keys — lives in the 1600px page space `extract.py` produced. These assets do
 * not change that: they are the same page at `HI_SCALE` times the size, and the
 * composition multiplies coordinates by `HI_SCALE` only when it draws one. That
 * is what lets a 2.2x close-up render sharper than today's full-page view
 * instead of softer.
 *
 * Everything here is best-effort. A missing interpreter, a missing PDF, a full
 * disk: all resolve to "no hi-res page", and the composition falls back to the
 * 1600px asset it has always used.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolvePython } from "./extract";

const exec = promisify(execFile);

/** How much bigger a hi-res page is than the space its boxes are measured in. */
export const HI_SCALE = 2;
export const HI_LONG_EDGE = 1600 * HI_SCALE;

const SCRIPT = fileURLToPath(new URL("./render-pages.py", import.meta.url));

export interface RenderPagesOptions {
  pdfPath: string;
  outDir: string;
  pageIndices: number[];
  longEdge: number;
}

/** Page index → absolute path of its hi-res JPEG. Pages that could not be rendered are absent. */
export async function renderPagesAt(opts: RenderPagesOptions): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (opts.pageIndices.length === 0) return out;
  try {
    const { bin, args } = await resolvePython();
    const { stdout } = await exec(
      bin,
      [...args, SCRIPT, opts.pdfPath, opts.outDir, String(opts.longEdge), opts.pageIndices.join(",")],
      { timeout: 120_000, windowsHide: true, maxBuffer: 1 << 20 },
    );
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return out;
    const parsed = JSON.parse(line) as { type: string; rendered?: number[] };
    if (parsed.type !== "done" || !Array.isArray(parsed.rendered)) return out;
    for (const index of parsed.rendered) {
      out.set(index, path.join(opts.outDir, `page-${String(index).padStart(4, "0")}@2x.jpg`));
    }
  } catch {
    // Best effort by contract: the composition falls back to the 1600px assets.
    return new Map();
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/render-pages.test.mts`
Expected: PASS — 4 tests

- [ ] **Step 6: Wire it into the pipeline and the composition**

In `build.ts`, widen the page type on `CompositionInput`:

```ts
  pages: { src: string; width: number; height: number; pageIndex?: number; hiSrc?: string }[];
```

and change `pageMarkup` to prefer the hi-res file while keeping the declared box in 1600px space:

```ts
function pageMarkup(page: { src: string; width: number; height: number; hiSrc?: string }, offset: number): string {
  // `width`/`height` stay in the 1600px space every measured box lives in; only
  // the file behind them changes, so the browser downsamples a sharper image.
  const src = page.hiSrc ?? page.src;
  return `<div class="page" style="top:${offset}px;width:${page.width}px;height:${page.height}px;"><img src="${esc(src)}" width="${page.width}" height="${page.height}" alt="" /></div>`;
}
```

In `pipeline.ts`, after `compPages` is built (~line 782) and before `buildComposition`, add:

```ts
    // Sharp pixels for the close shots. Best-effort: a failure here leaves the
    // 1600px assets in place and costs the video nothing but softness.
    const hiDir = path.join(workDir, "hires");
    let hiByPageIndex = new Map<number, string>();
    try {
      await fs.mkdir(hiDir, { recursive: true });
      hiByPageIndex = await renderPagesAt({
        pdfPath: episode.upload.sourcePath,
        outDir: hiDir,
        pageIndices: compPages.map((p) => p.pageIndex),
        longEdge: HI_LONG_EDGE,
      });
      if (hiByPageIndex.size === 0) {
        await appendNotes(episodeId, ["No high-resolution page images were produced; close shots use the standard assets."]);
      }
    } catch (err) {
      await appendNotes(episodeId, [`High-resolution page rendering failed (${message(err)}) — the video is unaffected.`]);
    }
```

Add `hiSrc` to the `pages` passed to `buildComposition`:

```ts
      pages: compPages.map((p) => ({
        src: p.src,
        width: p.width,
        height: p.height,
        pageIndex: p.pageIndex,
        ...(hiByPageIndex.has(p.pageIndex) ? { hiSrc: `assets/${path.basename(hiByPageIndex.get(p.pageIndex)!)}` } : {}),
      })),
```

and add them to the `writeProject` assets list:

```ts
      assets: [
        ...compPages.map((p) => ({ from: p.from, to: p.to })),
        ...[...hiByPageIndex.values()].map((f) => ({ from: f, to: path.basename(f) })),
      ],
```

Import at the top of `pipeline.ts`:

```ts
import { renderPagesAt, HI_LONG_EDGE } from "./pdf/render-pages";
```

- [ ] **Step 7: Verify the composition still builds both ways**

Add to `tests/composition.test.mts`:

```ts
test("a page with a hi-res asset draws it at the SAME declared box; one without is untouched", () => {
  const base = input();
  const plain = buildComposition(base);
  assert.match(plain, /<img src="assets\/page-00\.jpg" width="1000" height="1400"/);

  const hi = buildComposition({
    ...base,
    pages: base.pages.map((p) => ({ ...p, hiSrc: "assets/page-0000@2x.jpg" })),
  });
  assert.match(hi, /<img src="assets\/page-0000@2x\.jpg" width="1000" height="1400"/);
  assert.ok(!hi.includes('src="assets/page-00.jpg"'), "the hi-res file replaces the standard one");
});
```

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts && npx tsc --noEmit`
Expected: PASS, tsc silent

- [ ] **Step 8: Commit**

```bash
git add src/lib/pdf/render-pages.py src/lib/pdf/render-pages.ts src/lib/pipeline.ts src/lib/video/composition/build.ts tests/render-pages.test.mts tests/composition.test.mts
git commit -m "feat(video): high-resolution page assets, so a close shot renders sharp"
```

---

### Task 7: Shot grammar — wide, medium, close

**Files:**
- Modify: `src/lib/video/scenes/types.ts` — add `ShotSize` and `Scene.shot`
- Modify: `src/lib/video/scenes/validate.ts` — assign shots
- Modify: `tests/scenes.test.mts`

**Interfaces:**
- Consumes: `PAGE_KINDS`, `Scene` from `scenes/types.ts`.
- Produces: `export type ShotSize = "wide" | "medium" | "close"` and `export const SHOT_SCALE: Record<ShotSize, number> = { wide: 1, medium: 1.5, close: 2.2 }` from `scenes/types.ts`; `Scene.shot?: ShotSize`; and from `validate.ts` both `shotFor(want: ShotSize, cited: {y0:number; y1:number} | null, cardHeightInColumnPx: number): ShotSize` and `assignShots(scenes: Scene[], citedFor: (s: Scene) => {y0:number; y1:number} | null, cardHeightInColumnPx: number): void`.

- [ ] **Step 1: Write the failing test**

Add to `tests/scenes.test.mts`:

```ts
test("page scenes get varied shot sizes: an establishing wide, then never the same twice running", async () => {
  const beats = [beat(0, "Open here. One line. Two line. Three line. Four line. Five line.")];
  const sentences = sentencesOf(beats, timed(beats));
  const specs = sentences.map((s) => spec(s.index, s.index, s.index === 0 ? "kinetic-text" : "book-page"));
  const r = await validateScenes(specs, ctx({ sentences }));

  const shots = r.scenes.filter((s) => PAGE_KINDS.includes(s.kind)).map((s) => s.shot);
  assert.ok(shots.length >= 3, "the fixture must actually produce page scenes");
  assert.equal(shots[0], "wide", "the first page scene establishes");
  for (let i = 1; i < shots.length; i++) {
    assert.notEqual(shots[i], shots[i - 1], `scenes ${i - 1} and ${i} both used ${shots[i]}`);
  }
  for (const s of shots) assert.ok(s && s in SHOT_SCALE, `${s} is a real shot size`);
});

test("a cited block too tall to frame closely falls back rather than cropping the words out", () => {
  // The card shows ~1283 column px. A close shot at 2.2x frames ~583 of them.
  const tall = { y0: 100, y1: 900 };
  const short = { y0: 100, y1: 260 };
  assert.equal(shotFor("close", tall, 1283), "medium", "an 800px block cannot be framed at 2.2x");
  assert.equal(shotFor("close", short, 1283), "close");
  assert.equal(shotFor("medium", tall, 1283), "wide", "nor at 1.5x");
  assert.equal(shotFor("close", null, 1283), "medium", "no geometry, no close shot");
});
```

Import `SHOT_SCALE`, `shotFor` and `PAGE_KINDS` at the top of that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/scenes.test.mts`
Expected: FAIL — `SHOT_SCALE` and `shotFor` are not exported

- [ ] **Step 3: Add the shot type**

In `src/lib/video/scenes/types.ts`:

```ts
/**
 * How tightly a page scene is framed. The composition used to hold one fixed
 * 960x1120 card for every page scene in every video, which is what made the
 * frame feel locked off rather than shot.
 */
export type ShotSize = "wide" | "medium" | "close";

/** What each shot scales the card to. */
export const SHOT_SCALE: Record<ShotSize, number> = { wide: 1, medium: 1.5, close: 2.2 };
```

and on the `Scene` interface:

```ts
  /** Page kinds only: how tightly this scene is framed. */
  shot?: ShotSize;
```

- [ ] **Step 4: Assign shots in the validator**

In `src/lib/video/scenes/validate.ts`:

```ts
/**
 * The shot a cited block can actually be framed at. A block taller than the
 * card can show at that scale would have its own words cropped out of frame,
 * which is the opposite of what a close shot is for, so it steps back.
 */
export function shotFor(want: ShotSize, cited: { y0: number; y1: number } | null, cardHeightInColumnPx: number): ShotSize {
  if (!cited) return want === "close" ? "medium" : want;
  const height = Math.max(1, cited.y1 - cited.y0);
  const order: ShotSize[] = ["close", "medium", "wide"];
  for (const shot of order.slice(order.indexOf(want))) {
    if (height <= cardHeightInColumnPx / SHOT_SCALE[shot]) return shot;
  }
  return "wide";
}

/**
 * One shot size per page scene: an establishing wide first, then alternating,
 * and never the same size twice running. Deterministic, so it is testable
 * without a model call — the same discipline as the cinematic variety rules.
 */
export function assignShots(scenes: Scene[], citedFor: (s: Scene) => { y0: number; y1: number } | null, cardHeightInColumnPx: number): void {
  let previous: ShotSize | null = null;
  let isFirst = true;
  for (const scene of scenes) {
    if (!PAGE_KINDS.includes(scene.kind)) continue;
    let want: ShotSize;
    if (isFirst) {
      want = "wide";
      isFirst = false;
    } else {
      want = previous === "close" ? "medium" : "close";
    }
    let shot = shotFor(want, citedFor(scene), cardHeightInColumnPx);
    if (shot === previous) shot = shot === "close" ? "medium" : shot === "medium" ? "wide" : "medium";
    scene.shot = shot;
    previous = shot;
  }
}
```

Call `assignShots` at the end of `validateScenes`, just before it returns, passing the context's crop lookup and `cardViewportHeight`'s value for the plan.

- [ ] **Step 5: Run the test to verify it passes**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/scenes.test.mts && npx tsc --noEmit`
Expected: PASS, tsc silent

- [ ] **Step 6: Commit**

```bash
git add src/lib/video/scenes/types.ts src/lib/video/scenes/validate.ts tests/scenes.test.mts
git commit -m "feat(scenes): wide/medium/close shot sizes, so the frame stops being locked off"
```

---

### Task 8: The push-in highlight and the dimmed surround

**Files:**
- Create: `src/lib/video/composition/highlight.ts` — the page-highlight geometry, moved out of `build.ts`
- Modify: `src/lib/video/composition/build.ts` — delete `cardZooms()` (~line 1634) and `CROP_MIN`/`CROP_MAX` (lines 339–340), re-export from the new module, add the `.page-dim` element, its CSS and its timeline driver, restyle `.stroke`
- Modify: `tests/composition.test.mts`, `tests/scenes.test.mts` (the `cardZooms` test at line 380)
- Modify: `scripts/e2e-seek.mjs` — track `#page-dim`

**Interfaces:**
- Consumes: `SHOT_SCALE`, `Scene.shot` from Task 7; `PAGE_KINDS` from `scenes/types.ts`.
- Produces, from `src/lib/video/composition/highlight.ts`: `export interface Keyed { t: number; d: number }`, `cardZooms(scenes: Scene[], shift: number, cardHeightInColumnPx: number): (Keyed & { v: number })[]`, and `dimKeys(scenes: Scene[], shift: number): (Keyed & { o: number; y: number; h: number })[]` where `o` is the dim opacity and `y`/`h` are the transparent window in column pixels. `build.ts` re-exports `cardZooms` so `tests/scenes.test.mts`'s existing import keeps working.

**Note on `Keyed`:** it is currently a non-exported interface at `build.ts:1614` and is also used by `cardVisibility` and `glowKeys`. Move the declaration into `highlight.ts`, export it there, and have `build.ts` import it — do not duplicate it.

- [ ] **Step 1: Write the failing test**

Add to `tests/composition.test.mts`:

```ts
test("every page scene drives the card to its own shot scale, and the scales do not overlap in time", () => {
  const theme = bookThemeById("marginalia");
  const base = fixtureInput({ theme, withScenes: true }) as unknown as CompositionInput;
  const scenes = (base.scenes as Scene[]).map((s, i) => (PAGE_KINDS.includes(s.kind) ? { ...s, shot: (["wide", "close", "medium"] as const)[i % 3] } : s));
  const html = buildComposition({ ...base, scenes, bookTitle: "T" });
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as {
    zooms: { t: number; d: number; v: number }[];
    dim: { t: number; d: number; o: number; y: number; h: number }[];
  };

  assert.ok(data.zooms.length >= 2, "more than one shot size is actually used");
  for (const z of data.zooms) assert.ok(Object.values(SHOT_SCALE).includes(z.v), `${z.v} is a shot scale`);
  for (let i = 1; i < data.zooms.length; i++) {
    assert.ok(data.zooms[i - 1].t + data.zooms[i - 1].d <= data.zooms[i].t + 1e-6, "two scale tweens never run at once");
  }

  // The dim window never fully hides the page, and never covers the cited lines.
  for (const d of data.dim) {
    assert.ok(d.o > 0 && d.o <= 0.75, `dim opacity ${d.o} leaves the page readable`);
    assert.ok(d.h > 0, "the transparent window has height");
  }
});

test("with no scenes there is no zoom, no dim layer and no change to the old composition", () => {
  const theme = bookThemeById("marginalia");
  const html = buildComposition({ ...(fixtureInput({ theme }) as unknown as CompositionInput), bookTitle: "T" });
  assert.ok(!html.includes('id="page-dim"'), "a photo episode gets no dim layer at all");
  const data = JSON.parse(html.match(/<script id="composition-data"[^>]*>([\s\S]*?)<\/script>/)![1]) as { zooms: unknown[]; dim: unknown[] };
  assert.deepEqual(data.zooms, []);
  assert.deepEqual(data.dim, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: FAIL — `data.dim` is undefined, and `zooms` carry the old `CROP_MIN`/`CROP_MAX` values

Also update the existing zoom test in `tests/scenes.test.mts` (line 380), which predates shot sizes and asserts a crop-derived scale:

```ts
test("a scene's shot size drives the card's scale, and a wide shot returns it to life size", () => {
  const s = (i: number, kind: VisualKind, shot?: Scene["shot"]): Scene => ({ ...sceneOf(kind), index: i, start: i * 4, end: i * 4 + 4, shot });
  const zooms = cardZooms([s(0, "book-crop", "close"), s(1, "book-page", "wide")], 0, 1280);
  assert.equal(zooms[0].v, SHOT_SCALE.close);
  assert.equal(zooms[1].v, 1, "back to life size for the whole page");
  assert.deepEqual(glowKeys([s(0, "stat")], 0).length, 1);
});
```

- [ ] **Step 3: Move the zoom into its own module and drive it from the shot size**

Create `src/lib/video/composition/highlight.ts`. Move `Keyed` (exported), `cardZooms` and the new `dimKeys` into it, delete `CROP_MIN`/`CROP_MAX` from `build.ts`, have `build.ts` import `Keyed` and re-export `cardZooms`, and give `cardZooms` this body:

```ts
export function cardZooms(scenes: Scene[], shift: number, cardHeightInColumnPx: number): (Keyed & { v: number })[] {
  const out: (Keyed & { v: number })[] = [];
  let current = 1;
  for (const s of scenes) {
    if (!PAGE_KINDS.includes(s.kind)) continue;
    const target = SHOT_SCALE[s.shot ?? "wide"];
    if (Math.abs(target - current) < 0.02) continue;
    const t = Math.max(0, shift + s.start);
    const d = Math.min(1.4, Math.max(0.5, (s.end - s.start) * 0.35));
    const previous = out[out.length - 1];
    if (previous && previous.t + previous.d > t) previous.d = Math.max(0.05, t - previous.t);
    out.push({ t, d, v: Math.round(target * 1000) / 1000 });
    current = target;
  }
  return out;
}
```

`cardHeightInColumnPx` stays in the signature — Task 7's `shotFor` already used it to pick a shot that fits, so this function no longer needs to compute a scale, but callers are unchanged.

- [ ] **Step 4: Add the dim layer**

In `highlight.ts`, beside `cardZooms`:

```ts
/**
 * The page outside the cited lines, dimmed so the eye has one place to go.
 *
 * One element inside `#column`, in the same coordinate space as the strokes, so
 * it scrolls and scales with the page for free. The hole is a transparent band
 * over the cited lines and the dimming is a large `box-shadow` spread in the
 * backdrop colour — one element, one tween, no clip-path and no second copy of
 * the page.
 */
export function dimKeys(scenes: Scene[], shift: number): (Keyed & { o: number; y: number; h: number })[] {
  const out: (Keyed & { o: number; y: number; h: number })[] = [];
  for (const s of scenes) {
    if (!PAGE_KINDS.includes(s.kind)) continue;
    // A wide establishing shot shows the whole page; dimming it would be noise.
    const o = s.shot === "close" ? 0.62 : s.shot === "medium" ? 0.34 : 0;
    if (o === 0) continue;
    const crop = s.crop;
    if (!crop) continue;
    const t = Math.max(0, shift + s.start);
    const previous = out[out.length - 1];
    const d = Math.min(1.2, Math.max(0.4, (s.end - s.start) * 0.3));
    if (previous && previous.t + previous.d > t) previous.d = Math.max(0.05, t - previous.t);
    out.push({ t, d, o, y: Math.round(crop.y0), h: Math.round(Math.max(1, crop.y1 - crop.y0)) });
  }
  return out;
}
```

Add the element inside `#column`, after the pages and before the strokes, only when there are scenes:

```ts
      ${scenes.length ? `<div class="page-dim" id="page-dim"></div>` : ""}
```

Add its CSS beside `.stroke`:

```ts
  .page-dim { position:absolute; left:-2000px; right:-2000px; height:0; opacity:0;
              box-shadow:0 0 0 4000px ${theme.palette.backdropDeep}; pointer-events:none; }
```

Add `dim` to the composition-data object:

```ts
    dim: scenes.length ? dimKeys(scenes, AUDIO_OFFSET) : [],
```

and drive it in the timeline script, beside the `zooms` block:

```js
  var dimEl = document.getElementById("page-dim");
  if (dimEl) {
    (data.dim || []).forEach(function (k) {
      tl.to(dimEl, { top: k.y, height: k.h, opacity: k.o, duration: k.d, ease: "power2.out" }, k.t);
    });
  }
```

- [ ] **Step 5: Restyle the marker bar**

The flat bar is the last of the "not aesthetic" look. In `build.ts`, replace the `.stroke` rule (line ~791) so the bar reads as ink soaking into paper rather than a solid rectangle, while keeping `transform-origin:left center` — the `scaleX(0)→scaleX(1)` wipe and its timing are unchanged:

```ts
  .stroke { position:absolute; transform-origin:left center; border-radius:3px;
            filter:blur(0.6px); mix-blend-mode:multiply; }
```

Each theme supplies the bar's own colour in `strokeMarkup`; leave those alone. Verify the wipe still runs in time with the words by re-reading one real episode's strokes after Step 8.

- [ ] **Step 6: Track the new element in the seek harness**

In `scripts/e2e-seek.mjs`, add `#page-dim` to the tracked selector string.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts tests/scenes.test.mts && npx tsc --noEmit`
Expected: PASS, tsc silent

- [ ] **Step 8: Prove it is still seek-safe**

Run: `node --import tsx scripts/e2e-seek.mjs`
Expected: `Seek-safe: 5 theme(s) × 24 timestamps.` with no violations

- [ ] **Step 9: Run the full suite and render one real video**

Run: `npm test`
Expected: the known 10 failures + 1 cancelled, no others

Then generate one real episode through the API and sample a frame from each shot size, checking them against the grid overlay. Confirm: byline at top, no cue chip, caption clear of the bottom 250 px, visible push-in with the surround dimmed, and the marker still wiping in time with the spoken words.

- [ ] **Step 10: Commit**

```bash
git add src/lib/video/composition tests/composition.test.mts tests/scenes.test.mts scripts/e2e-seek.mjs
git commit -m "feat(video): push-in highlight with the surrounding page dimmed"
```

---

### Task 9: The magnifier loupe (phase two — only after Task 8 is reviewed)

**Gate:** Do not start this task until a real video from Task 8 has been watched and the push-in approved. If the push-in already reads well, the loupe is optional; if it looks cheap in review, drop this task entirely. Say so rather than building it anyway.

**Files:**
- Modify: `src/lib/video/composition/build.ts` — `.loupe` markup, CSS and its `onUpdate` driver
- Modify: `src/lib/video/scenes/validate.ts` — mark at most one scene `loupe: true`
- Modify: `tests/composition.test.mts`

**Interfaces:**
- Consumes: `Scene.shot`, `Scene.crop`, `hiSrc` from Task 6.
- Produces: `Scene.loupe?: boolean`, and `loupeKeys(scenes: Scene[], shift: number): (Keyed & { y: number; h: number })[]`.

- [ ] **Step 1: Write the failing test**

```ts
test("at most one scene in a video carries the loupe, and only a close shot on a cited block", async () => {
  const beats = [beat(0, "Open here. One line. Two line. Three line. Four line.")];
  const sentences = sentencesOf(beats, timed(beats));
  const specs = sentences.map((s) => spec(s.index, s.index, s.index === 0 ? "kinetic-text" : "book-crop"));
  const r = await validateScenes(specs, ctx({ sentences }));
  const loupes = r.scenes.filter((s) => s.loupe);
  assert.ok(loupes.length <= 1, `${loupes.length} scenes carry the loupe`);
  for (const s of loupes) {
    assert.equal(s.shot, "close", "the loupe only ever lands on a close shot");
    assert.ok(s.crop, "the loupe needs real geometry to magnify");
  }
});

test("the loupe is driven from tl.time(), never accumulated", () => {
  const html = buildComposition({ ...(fixtureInput({ theme: bookThemeById("marginalia"), withScenes: true }) as unknown as CompositionInput), bookTitle: "T" });
  const js = html.split("<script>")[1] ?? "";
  if (!js.includes("loupe")) return; // no loupe in this fixture
  const block = js.slice(js.indexOf('a.k === "loupe"'));
  assert.match(block.slice(0, 600), /tl\.time\(\)/, "the loupe computes its position from the timeline clock");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts`
Expected: FAIL — `Scene.loupe` does not exist

- [ ] **Step 3: Implement the loupe**

Add `loupe?: boolean` to `Scene` in `scenes/types.ts`. In `validate.ts`, after `assignShots`, mark the single close-shot page scene with the largest cited block:

```ts
  const candidates = scenes.filter((s) => s.shot === "close" && s.crop);
  if (candidates.length) {
    const best = candidates.reduce((a, b) => ((a.crop!.y1 - a.crop!.y0) >= (b.crop!.y1 - b.crop!.y0) ? a : b));
    best.loupe = true;
  }
```

In `highlight.ts`:

```ts
/** The loupe's travel: one entry, the cited band it glides along, in column pixels. */
export function loupeKeys(scenes: Scene[], shift: number): (Keyed & { y: number; h: number; x0: number; x1: number })[] {
  const scene = scenes.find((s) => s.loupe && s.crop);
  if (!scene) return [];
  const c = scene.crop!;
  return [{
    t: Math.max(0, shift + scene.start),
    d: Math.max(1.2, scene.end - scene.start - 0.4),
    y: Math.round((c.y0 + c.y1) / 2),
    h: Math.round(Math.max(40, c.y1 - c.y0)),
    x0: Math.round(c.x0),
    x1: Math.round(c.x1),
  }];
}
```

In `build.ts`, add the element inside `#column`, after `.page-dim` and before the strokes, only when `loupeKeys` is non-empty — the page it magnifies is the same asset the page below uses, so it is sharp only because of Task 6:

```ts
      ${loupe.length ? `<div class="loupe" id="loupe"><div class="loupe-glass" id="loupe-glass"></div></div>` : ""}
```

Its CSS, beside `.page-dim`:

```ts
  .loupe { position:absolute; left:0; top:0; width:${LOUPE_D}px; height:${LOUPE_D}px; opacity:0;
           border-radius:50%; overflow:hidden; pointer-events:none;
           box-shadow:0 18px 44px ${alpha(p.backdropDeep, 0.45)}, inset 0 0 0 3px ${alpha(p.accent, 0.5)},
                      inset 0 6px 18px ${alpha("#ffffff", 0.35)}; }
  .loupe-glass { position:absolute; left:0; top:0; width:100%; height:100%;
                 background-image:url("${esc(firstPageSrc)}"); background-repeat:no-repeat; }
```

where `const LOUPE_D = 320;` sits beside `CARD_RADIUS`, and `firstPageSrc` is the `hiSrc ?? src` of the page the loupe's scene cites.

Drive it in the timeline script, computing everything from `tl.time()` so a cold seek lands in the right place — the identical discipline `cine`, `lottie` and `three` already use:

```js
  var loupeEl = document.getElementById("loupe");
  var glassEl = document.getElementById("loupe-glass");
  (data.loupe || []).forEach(function (k) {
    if (!loupeEl || !glassEl) return;
    var half = k.h / 2;
    tl.fromTo(
      loupeEl,
      { autoAlpha: 0 },
      {
        autoAlpha: 1,
        duration: k.d,
        ease: "none",
        immediateRender: false,
        onUpdate: function () {
          var progress = Math.max(0, Math.min(1, (tl.time() - k.t) / k.d));
          // Ease the travel, not the opacity: the glass glides, it does not jump.
          var eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
          var cx = k.x0 + (k.x1 - k.x0) * eased;
          var cy = k.y;
          loupeEl.style.left = cx - LOUPE_D / 2 + "px";
          loupeEl.style.top = cy - LOUPE_D / 2 + "px";
          // The magnified copy is offset so the point under the glass registers
          // with the page beneath it: at MAG times size, the pixel at (cx,cy)
          // must land at the glass's centre.
          glassEl.style.backgroundSize = PAGE_W * MAG + "px " + PAGE_H * MAG + "px";
          glassEl.style.backgroundPosition = LOUPE_D / 2 - cx * MAG + "px " + (LOUPE_D / 2 - cy * MAG) + "px";
          void half;
        },
      },
      k.t,
    );
  });
```

with `var MAG = 2;` and `PAGE_W`/`PAGE_H` read from `data` beside `cineBuf` — add `loupe: loupeKeys(scenes, AUDIO_OFFSET)` and `page: { w, h }` to the composition-data object. The loupe fades out with one `tl.to(loupeEl, { autoAlpha: 0, ... })` at `k.t + k.d`, which is a second tween on the same element but in a disjoint window, so `overlappingAnims`' rule holds.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `DATABASE_URL="file:./dev.db" npx tsx --test tests/composition.test.mts && node --import tsx scripts/e2e-seek.mjs`
Expected: PASS, and seek-safe across all five themes

- [ ] **Step 5: Render and judge**

Generate one real episode and watch the loupe moment. If it does not look as good as the push-in around it, revert this task rather than shipping it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/video/composition/build.ts src/lib/video/scenes tests/composition.test.mts
git commit -m "feat(video): a magnifier loupe on the single key quoted line"
```
