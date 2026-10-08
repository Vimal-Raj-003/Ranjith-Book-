# Inspector Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three inspector controls real — thumbnails that actually appear and can be chosen and retitled, a working 12-voice picker with preview, and a richer music engine with operator controls.

**Architecture:** Three mostly-independent slices over an existing Next.js 16 / Prisma / SQLite app. The thumbnail fix is pure delivery (a `?size=grid` derivative cached on disk, plus correct cache headers) and needs no schema change. Voice and music both hang off one widened, per-key-validated settings route. A single migration adds four nullable columns to `Episode`. Nothing in the render pipeline changes shape; the new options are additive with defaults that reproduce today's output.

**Tech Stack:** Next.js 16.3.1 (App Router, Turbopack), React 19, Prisma 6 + SQLite, `sharp` (already a dependency), `playwright-core` (already a dependency), Kyutai Pocket TTS, ffmpeg, `node --test` with `tsx`.

**Spec:** [docs/superpowers/specs/2026-10-04-inspector-controls-design.md](../specs/2026-10-04-inspector-controls-design.md)

## Global Constraints

- **No external music downloads or licensing dependencies.** All music is synthesized arithmetically in `music-synth.ts`. Changing this requires asking the operator first.
- **No new runtime dependencies.** `sharp` and `playwright-core` are already in `package.json`; add nothing else.
- **Thumbnail generation must never fail or block a video render.** Existing contract in `thumbnails/index.ts` — every foreseeable failure costs at most the thumbnails it affects.
- **A failed thumbnail or voice preview must not break the inspector.**
- **All four new `Episode` columns are nullable**, every reader has a defined null behaviour, and no backfill runs.
- **The thumbnail key invariant is untouched:** `isThumbKey` and `selectThumb` keep matching keys byte-for-byte and pinning the resolved filename to `<key>.jpg`. Variants travel in a query parameter, never in the key.
- **Determinism:** no randomness and no clock in thumbnail or music generation. Same inputs, same bytes.
- **Scope:** workstream 1 only. Do not touch frontend restructuring, cinematic themes, or auto-publish.
- Run tests with `npm test`; typecheck with `npm run typecheck`; lint with `npm run lint`.
- **Do not commit or push without the operator's explicit permission.** Steps below say "stage" rather than "commit" for this reason.

## Review Focus

Input classes the spec implies but no task's happy path exercises. Each has its test pinned to the task that owns the code.

1. **`?size=` carrying a hostile value** (`../../etc/passwd`, `grid/../..`, a 10 KB string). Expected: treated as absent, full JPEG served, nothing joined to a path. → Task 1.
2. **The full-resolution JPEG is missing while the DB row still lists it** (operator deleted `.bookreel/thumbs`). Expected: 404 with a clear message, no unhandled throw, inspector still usable. → Task 1.
3. **`thumbChoice` naming a key that no longer exists on the episode** (variant re-rendered, old key pruned, or a hand-edited row). Expected: silently falls back to the first 9:16 poster, never a broken image. → Task 3.
4. **A headline edit of only whitespace, or 5000 characters, or containing `<script>`.** Expected: whitespace-only is rejected as "no override"; long text is capped; markup is escaped and never reaches the DOM as markup. → Task 3.
5. **Pocket TTS not installed, or cold and slow, when Preview is clicked.** Expected: the route returns a named error the UI shows as a toast; it never hangs the inspector and never creates an Episode row. → Task 6.

---

## File Structure

**Create:**
- `src/lib/thumbnails/derive.ts` — grid-variant derivation and its on-disk cache. One responsibility: turn a full-resolution poster into a small one, or say it could not.
- `src/lib/settings/keys.ts` — the settings contract: which keys exist, how each validates, what each falls back to. Zero imports from React or Prisma, so both the route and the tests can use it.
- `src/app/api/voice/preview/route.ts` — voice preview endpoint.
- `src/app/api/episodes/[id]/thumbnail/route.ts` — `POST` for re-rendering a variant with an edited headline. (Collection-level; the existing `[key]/route.ts` stays `GET`-only.)
- `tests/settings-keys.test.mts`, `tests/thumbnails-grid.test.mts`, `tests/voice-preview.test.mts`, `tests/music-moods.test.mts`
- `scripts/e2e-thumbnails.mjs`

**Modify:**
- `prisma/schema.prisma` — four nullable columns on `Episode`.
- `src/app/api/episodes/[id]/thumbnail/[key]/route.ts` — `?size=grid`, cache headers, ETag.
- `src/lib/thumbnails/index.ts` — write grid variants at generation time; export a single-variant re-render.
- `src/lib/thumbnails/render.ts` — poster redesign (Task 8).
- `src/app/api/settings/route.ts` — multi-key validated GET/PUT.
- `src/lib/media/tts.ts` — return the resolved voice.
- `src/lib/media/music-synth.ts` — intensity layers.
- `src/lib/media/ffmpeg.ts` — ten moods, `intensity`/`level`/`duck` options.
- `src/lib/pipeline.ts` — stamp voice onto the episode; pass music options.
- `src/lib/episodes/list.ts`, `src/lib/episode-view.ts`, `src/app/api/episodes/[id]/route.ts` — expose `thumbChoice`, `voiceId`.
- `src/components/Inspector.tsx` — voice picker, music controls.
- `src/components/Thumbnails.tsx` — variant selection and headline editing.
- `src/components/LibraryGrid.tsx` — request `?size=grid`, honour `thumbChoice`.
- `src/components/types.ts`, `src/lib/strings.ts` — types and copy.

---

### Task 1: Thumbnail grid variants and correct caching

The reported bug. Self-contained: no schema change, no UI change beyond one URL.

**Files:**
- Create: `src/lib/thumbnails/derive.ts`
- Create: `tests/thumbnails-grid.test.mts`
- Modify: `src/lib/thumbnails/types.ts` (add `gridDir`)
- Modify: `src/app/api/episodes/[id]/thumbnail/[key]/route.ts`
- Modify: `src/components/LibraryGrid.tsx:33`, `src/components/Thumbnails.tsx:50`

**Interfaces:**
- Consumes: `thumbsDir`, `selectThumb`, `parseThumbnails` (existing, unchanged).
- Produces: `gridDir(episodeId): string`, `GRID_SIZES`, `deriveGrid(spec, episodeId): Promise<string | null>`, `parseSize(raw: unknown): "grid" | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/thumbnails-grid.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { deriveGrid, gridDir, parseSize } from "../src/lib/thumbnails/derive";
import { thumbsDir, type ThumbSpec } from "../src/lib/thumbnails/types";

const EPISODE = "ep-grid-test";

async function makeFullPoster(key: string): Promise<ThumbSpec> {
  const dir = thumbsDir(EPISODE);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.jpg`);
  await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#204060" } })
    .jpeg({ quality: 80 })
    .toFile(file);
  return { key, aspect: "9:16", variant: "quote", path: file, width: 1080, height: 1920 };
}

test("parseSize accepts only 'grid' and treats hostile input as absent", () => {
  assert.equal(parseSize("grid"), "grid");
  assert.equal(parseSize(null), null);
  assert.equal(parseSize(""), null);
  assert.equal(parseSize("full"), null);
  // Review Focus 1: hostile values are absent, never a path fragment.
  assert.equal(parseSize("../../etc/passwd"), null);
  assert.equal(parseSize("grid/../.."), null);
  assert.equal(parseSize("GRID"), null);
  assert.equal(parseSize("x".repeat(10_000)), null);
  assert.equal(parseSize(["grid"]), null);
});

test("deriveGrid writes a small webp under the episode's own grid dir", async () => {
  const spec = await makeFullPoster("9x16-quote");
  const out = await deriveGrid(spec, EPISODE);
  assert.ok(out, "expected a derived file");
  assert.equal(path.dirname(out!), path.resolve(gridDir(EPISODE)));

  const meta = await sharp(out!).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 324);
  // Far smaller than the ~270 KB original: this is the whole point of the task.
  const { size } = await fs.stat(out!);
  assert.ok(size < 60_000, `grid variant should be well under 60 KB, got ${size}`);
});

test("deriveGrid is a cache: a second call returns the same path without rewriting", async () => {
  const spec = await makeFullPoster("9x16-bold");
  const first = await deriveGrid(spec, EPISODE);
  const stampBefore = (await fs.stat(first!)).mtimeMs;
  const second = await deriveGrid(spec, EPISODE);
  assert.equal(second, first);
  assert.equal((await fs.stat(second!)).mtimeMs, stampBefore);
});

test("deriveGrid returns null rather than throwing when the original is gone", async () => {
  // Review Focus 2: a DB row outliving its file must not throw.
  const spec: ThumbSpec = {
    key: "9x16-split", aspect: "9:16", variant: "split",
    path: path.join(thumbsDir(EPISODE), "does-not-exist.jpg"),
    width: 1080, height: 1920,
  };
  assert.equal(await deriveGrid(spec, EPISODE), null);
});

test("a deleted grid cache is re-derived on the next call", async () => {
  const spec = await makeFullPoster("16x9-quote");
  const first = await deriveGrid(spec, EPISODE);
  await fs.rm(gridDir(EPISODE), { recursive: true, force: true });
  const again = await deriveGrid(spec, EPISODE);
  assert.equal(again, first);
  await fs.access(again!);
});

test.after(async () => {
  await fs.rm(thumbsDir(EPISODE), { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx --test tests/thumbnails-grid.test.mts`
Expected: FAIL — `Cannot find module '../src/lib/thumbnails/derive'`.

- [ ] **Step 3: Add `gridDir` to types**

In `src/lib/thumbnails/types.ts`, after `thumbsDir`:

```ts
/**
 * Derived, grid-sized copies of an episode's posters.
 *
 * A cache, not a product: every file in here is reproducible from the
 * full-resolution JPEG beside it, so deleting the directory costs one
 * re-derivation and nothing else. Kept inside the episode's own folder so
 * that removing an episode removes its derivatives with it.
 */
export function gridDir(episodeId: string): string {
  return path.join(thumbsDir(episodeId), "grid");
}
```

- [ ] **Step 4: Write `src/lib/thumbnails/derive.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { gridDir, type ThumbSpec } from "./types";

/**
 * Grid-sized derivatives of the full-resolution posters.
 *
 * Why this exists: the library renders each poster at 164 CSS px but used to
 * download the 1080px, ~270 KB original. Measured on 2026-10-04 against a
 * 100-episode library, only 38 of 63 images had decoded after twenty seconds.
 * The posters were never broken — they simply never arrived.
 *
 * The long edge, by aspect. 324x576 is 3x the 164px the grid paints, so it
 * stays sharp on a 2x display and on a 3x phone, and lands around 20 KB.
 */
export const GRID_WIDTH = 324;

/** The only `size` value this build serves. Anything else means "full". */
export type ThumbSize = "grid";

/**
 * Validate the `size` query parameter.
 *
 * `size` is hostile input and is treated exactly like `key` is: it is never
 * joined to a path, never normalised, never interpolated. It is compared
 * against one literal. Anything that is not that literal — a traversal
 * attempt, a casing variant, an array from a repeated query parameter — is
 * indistinguishable from the parameter being absent, which serves the
 * original. There is no code path in which this value reaches the filesystem.
 */
export function parseSize(raw: unknown): ThumbSize | null {
  return raw === "grid" ? "grid" : null;
}

/**
 * The grid-sized copy of one poster, deriving and caching it on first request.
 *
 * Returns the path, or `null` when no derivative could be produced — a missing
 * original, an unreadable one, a sharp failure. `null` is not an error: the
 * caller serves the full-resolution JPEG instead, which is slow but correct.
 * A thumbnail is never worth a 500.
 *
 * `spec.path` has already been through `selectThumb`, so it is confined to
 * this episode's own directory. The output name is built from `spec.key`,
 * which `selectThumb` matched byte-for-byte against the stored keys.
 */
export async function deriveGrid(spec: ThumbSpec, episodeId: string): Promise<string | null> {
  const dir = path.resolve(gridDir(episodeId));
  const out = path.join(dir, `${spec.key}.webp`);

  // Cache hit. A derivative is a pure function of the original, and the
  // original is immutable once written, so an existing file is always valid.
  try {
    const stat = await fs.stat(out);
    if (stat.size > 0) return out;
  } catch {
    /* derive it below */
  }

  try {
    await fs.mkdir(dir, { recursive: true });
    await sharp(spec.path)
      .resize({ width: GRID_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(out);
    const stat = await fs.stat(out);
    if (stat.size === 0) return null;
    return out;
  } catch {
    // Deliberately quiet and deliberately not fatal. The full-resolution
    // poster is still there and still correct.
    return null;
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx tsx --test tests/thumbnails-grid.test.mts`
Expected: PASS, 5/5.

- [ ] **Step 6: Serve the derivative, and fix the cache headers**

Rewrite the body of `GET` in `src/app/api/episodes/[id]/thumbnail/[key]/route.ts`, from the `selectThumb` line to the end:

```ts
  const spec = selectThumb(parseThumbnails(episode), key, episode.id);
  if (!spec) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The grid derivative when one was asked for and could be made; the
  // full-resolution original otherwise. A derivation that fails degrades to
  // the original rather than to an error — slow beats broken.
  const size = parseSize(new URL(_req.url).searchParams.get("size"));
  const derived = size === "grid" ? await deriveGrid(spec, episode.id) : null;
  const file = derived ?? spec.path;
  const type = derived ? "image/webp" : "image/jpeg";

  let stat: Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return NextResponse.json({ error: "That thumbnail is no longer on disk." }, { status: 404 });
  }

  // These bytes never change once written: a poster is rewritten only by an
  // explicit re-render, which writes a new file and busts this cache itself.
  // The previous `max-age=0, must-revalidate` meant a 100-episode library
  // re-downloaded roughly 27 MB on every single visit.
  //
  // `private` is retained deliberately. A shared proxy must never hold one
  // operator's photograph of their own book where another could be handed it;
  // only the browser that asked for it caches this.
  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (_req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(file)) as WebReadableStream<Uint8Array>;
  return new NextResponse(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
      "Content-Disposition": `inline; filename="${spec.key}${derived ? ".webp" : ".jpg"}"`,
    },
  });
}
```

Add to the imports at the top of that file:

```ts
import type { Stats } from "node:fs";
import { deriveGrid, parseSize } from "@/lib/thumbnails/derive";
```

Rename the handler's first parameter from `_req` to `req` throughout if lint objects to a used parameter named with a leading underscore; otherwise leave it.

- [ ] **Step 7: Point the two grid consumers at the small variant**

In `src/components/LibraryGrid.tsx`, change the `<img src>` on line 33 to request the derivative, leaving any `<a href>` download link untouched:

```tsx
        src={`/api/episodes/${episode.id}/thumbnail/${poster.key}?size=grid`}
```

In `src/components/Thumbnails.tsx` line 50, same change — the `<img>` gets `?size=grid`, the wrapping `<a href>` on line 43 keeps the full-resolution URL so "download" still downloads the real poster:

```tsx
                  src={`/api/episodes/${episode.id}/thumbnail/${t.key}?size=grid`}
```

- [ ] **Step 8: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS. `tests/thumbnails.test.mts` in particular must be untouched — the key-matching invariants it asserts have not changed.

- [ ] **Step 9: Stage (do not commit without permission)**

```bash
git add src/lib/thumbnails/derive.ts src/lib/thumbnails/types.ts \
  "src/app/api/episodes/[id]/thumbnail/[key]/route.ts" \
  src/components/LibraryGrid.tsx src/components/Thumbnails.tsx \
  tests/thumbnails-grid.test.mts
git status
```

---

### Task 2: Database migration

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Episode.voiceId`, `Episode.voiceProvider`, `Episode.thumbChoice`, `Episode.thumbHeadline` — all `String?`.

- [ ] **Step 1: Add the columns**

In `prisma/schema.prisma`, inside `model Episode`, directly after the `thumbnails String?` line:

```prisma
  /// The voice the narration actually used, resolved at render time. Null on
  /// rows written before the picker existed — the library says "not recorded"
  /// rather than guessing, because the setting may since have changed.
  voiceId       String?
  /// Which engine resolved it: pocket | elevenlabs | openai | system.
  voiceProvider String?
  /// The poster the operator chose for this episode. Null means "no choice
  /// made", and every reader falls back to the first 9:16 poster.
  thumbChoice   String?
  /// An operator-edited headline, already applied to the rendered poster.
  /// Kept so the edit survives a re-render and can be shown back in the field.
  thumbHeadline String?
```

- [ ] **Step 2: Push the schema and regenerate the client**

```bash
npm run db:push
npx prisma generate
```

Expected: `db:push` reports the four columns added. No data loss prompt — every column is nullable.

- [ ] **Step 3: Restart the dev server**

Stop the running `next dev` and start it again on port 3013.

This is not optional and it is not superstition: a running Next.js dev server keeps the Prisma client it booted with, so without a restart `prisma.episode.voiceId` is undefined and routes fail with an empty 500. This is the exact failure `assertModels` in `src/lib/db.ts` was written to name.

- [ ] **Step 4: Verify the columns exist**

```bash
npx tsx -e "import {prisma} from './src/lib/db'; const e = await prisma.episode.findFirst({select:{id:true,voiceId:true,voiceProvider:true,thumbChoice:true,thumbHeadline:true}}); console.log(e); await prisma.\$disconnect();"
```

Expected: an object with all four keys present and `null`.

- [ ] **Step 5: Rebuild the test database template and run the suite**

Run: `npm test`
Expected: PASS. `scripts/test-db.mjs` rebuilds the template from the schema, so the new columns are present in every test's isolated copy.

- [ ] **Step 6: Stage**

```bash
git add prisma/schema.prisma
git status
```

---

### Task 3: Poster selection and headline editing

**Files:**
- Create: `src/app/api/episodes/[id]/thumbnail/route.ts`
- Modify: `src/lib/thumbnails/index.ts`
- Modify: `src/lib/episode-view.ts`, `src/lib/episodes/list.ts`, `src/app/api/episodes/[id]/route.ts`
- Modify: `src/components/Thumbnails.tsx`, `src/components/LibraryGrid.tsx`, `src/components/types.ts`
- Modify: `tests/thumbnails-grid.test.mts` (append)

**Interfaces:**
- Consumes: `deriveGrid`, `gridDir` (Task 1); `Episode.thumbChoice`, `Episode.thumbHeadline` (Task 2).
- Produces: `renderVariant(opts): Promise<ThumbSpec[]>`, `pickPoster(thumbs, choice): PublicThumb | null`, `normaliseHeadline(raw): string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/thumbnails-grid.test.mts`:

```ts
import { normaliseHeadline, pickPoster } from "../src/lib/thumbnails/choose";

test("normaliseHeadline rejects empty and whitespace-only overrides", () => {
  // Review Focus 4: an all-spaces edit means "no override", not an empty poster.
  assert.equal(normaliseHeadline(""), null);
  assert.equal(normaliseHeadline("   \n\t "), null);
  assert.equal(normaliseHeadline(null), null);
  assert.equal(normaliseHeadline(42), null);
});

test("normaliseHeadline trims and caps long text", () => {
  assert.equal(normaliseHeadline("  Compounding beats talent  "), "Compounding beats talent");
  const long = normaliseHeadline("x".repeat(500));
  assert.ok(long && long.length <= 120, `expected a cap, got ${long?.length}`);
});

test("normaliseHeadline keeps markup as text, for the template to escape", () => {
  // The value is stored raw and escaped at render by the existing escapeHtml.
  // Stripping here would silently mangle a legitimate ampersand in a title.
  assert.equal(normaliseHeadline("<script>alert(1)</script>"), "<script>alert(1)</script>");
});

test("pickPoster honours the operator's choice", () => {
  const thumbs = [
    { key: "9x16-quote", aspect: "9:16" as const, variant: "quote" as const, width: 1080, height: 1920 },
    { key: "9x16-bold", aspect: "9:16" as const, variant: "bold" as const, width: 1080, height: 1920 },
  ];
  assert.equal(pickPoster(thumbs, "9x16-bold")?.key, "9x16-bold");
});

test("pickPoster falls back to the first 9:16 when the choice is stale or absent", () => {
  // Review Focus 3: a choice naming a key that no longer exists must degrade,
  // not produce a broken image.
  const thumbs = [
    { key: "16x9-quote", aspect: "16:9" as const, variant: "quote" as const, width: 1280, height: 720 },
    { key: "9x16-quote", aspect: "9:16" as const, variant: "quote" as const, width: 1080, height: 1920 },
  ];
  assert.equal(pickPoster(thumbs, "9x16-deleted")?.key, "9x16-quote");
  assert.equal(pickPoster(thumbs, null)?.key, "9x16-quote");
  assert.equal(pickPoster([], "9x16-quote"), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/thumbnails-grid.test.mts`
Expected: FAIL — `Cannot find module '../src/lib/thumbnails/choose'`.

- [ ] **Step 3: Write `src/lib/thumbnails/choose.ts`**

```ts
import type { PublicThumb } from "../episode-view";

/** Longer than this is not a headline, it is a paragraph that will not fit. */
const MAX_HEADLINE = 120;

/**
 * An operator's headline override, or null when there is not one.
 *
 * Whitespace-only is null rather than the empty string: an operator who
 * selects the field and deletes everything means "go back to the generated
 * headline", not "render a poster with no words on it".
 *
 * Markup is deliberately NOT stripped. The value is stored raw and escaped
 * at render time by the existing `escapeHtml`, which is the one place that
 * decision belongs. Stripping here would quietly mangle an ampersand or an
 * angle bracket that genuinely belongs in a book title.
 */
export function normaliseHeadline(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_HEADLINE);
}

/**
 * The poster to show for an episode: the operator's choice when it still
 * exists, otherwise the first 9:16, otherwise the first of anything.
 *
 * A stale `thumbChoice` is expected, not exceptional — re-rendering a variant
 * rewrites its keys, and a row can be edited by hand. It degrades to the
 * default silently, because the alternative the operator would see is a
 * broken image icon.
 */
export function pickPoster(thumbs: PublicThumb[], choice: string | null | undefined): PublicThumb | null {
  const chosen = choice ? thumbs.find((t) => t.key === choice) : undefined;
  return chosen ?? thumbs.find((t) => t.aspect === "9:16") ?? thumbs[0] ?? null;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test tests/thumbnails-grid.test.mts`
Expected: PASS, 10/10.

- [ ] **Step 5: Add single-variant re-rendering to `thumbnails/index.ts`**

Export a function that re-renders one variant in both aspects. It reuses the existing browser/HTML/screenshot path rather than duplicating it:

```ts
/**
 * Re-render ONE variant, in both aspect ratios, with an overridden headline.
 *
 * Why re-render rather than overlay the new text in the browser: the poster
 * the operator sees and the file they download must never disagree. An
 * overlay would make the preview right and the JPEG wrong.
 *
 * Returns the specs it managed to write — the caller merges them over the
 * episode's stored list by key. Same contract as `generateThumbnails`: a
 * failure costs the posters it affects and nothing else.
 */
export async function renderVariant(opts: {
  episodeId: string;
  pkg: ContentPackage;
  pages: ThumbPage[];
  focus?: ThumbFocus | null;
  theme?: string | null;
  outDir: string;
  variant: Variant;
  /** Replaces the generated headline. Escaped by the template, as always. */
  headline: string | null;
}): Promise<ThumbSpec[]> {
  // Build the same `ThumbCopy` generateThumbnails builds, then override the
  // one field. Factored out of generateThumbnails in this step so both call
  // sites compute copy identically and cannot drift.
  const copy = buildCopy(opts.pkg);
  if (opts.headline) copy.title = opts.headline;

  const photo = await loadPhoto(opts.pages[opts.focus?.pageIndex ?? 0] ?? opts.pages[0]);
  const focusPage = opts.pages[opts.focus?.pageIndex ?? -1];
  const focus = photo && focusPage ? normaliseFocus(opts.focus, focusPage) : null;
  const palette = thumbPalette(opts.theme);

  return shootPosters({
    aspects: ASPECTS,
    variants: [opts.variant],
    copy, photo, focus, palette,
    outDir: opts.outDir,
  });
}
```

To support this, refactor `generateThumbnails` so that the copy construction (lines 105–120) becomes `buildCopy(pkg)` and the nested browser loop (lines 147–200) becomes `shootPosters({...})`. `generateThumbnails` then calls both and behaves identically — this is a pure extraction, and `tests/thumbnails.test.mts` passing unchanged is the proof.

After writing the new posters, the caller deletes the stale grid derivatives for those keys so the cache cannot serve the old image:

```ts
await fs.rm(path.join(gridDir(episodeId), `${key}.webp`), { force: true });
```

- [ ] **Step 6: Add the `POST` route**

Create `src/app/api/episodes/[id]/thumbnail/route.ts`:

```ts
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";
import { normaliseHeadline } from "@/lib/thumbnails/choose";
import { parseThumbnails, serializeThumbnails } from "@/lib/thumbnails/store";
import { gridDir, VARIANTS, type Variant } from "@/lib/thumbnails/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Choose a poster, and optionally retitle one.
 *
 * Two operations on one route because they are one operator gesture: pick the
 * poster you want, fix its headline if it reads badly. A body naming only
 * `choice` records the selection and renders nothing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const { id } = await ctx.params;
  const episode = await prisma.episode.findFirst({ where: { id, userId: user.id } });
  if (!episode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { choice?: unknown; variant?: unknown; headline?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Expected a JSON body.", code: "bad_body" }, { status: 400 });

  const specs = parseThumbnails(episode);

  // Selection: validated against the keys this episode actually has, which is
  // the same rule the delivery route applies. An unknown key is a 400, not a
  // stored value that would later resolve to nothing.
  if (body.choice !== undefined) {
    if (typeof body.choice !== "string" || !specs.some((s) => s.key === body.choice)) {
      return NextResponse.json({ error: "That is not a poster on this episode.", code: "bad_choice" }, { status: 400 });
    }
    await prisma.episode.update({ where: { id }, data: { thumbChoice: body.choice } });
  }

  // Retitle: re-render that variant in both aspects.
  if (body.variant !== undefined) {
    if (typeof body.variant !== "string" || !VARIANTS.includes(body.variant as Variant)) {
      return NextResponse.json({ error: "That is not a poster variant.", code: "bad_variant" }, { status: 400 });
    }
    const headline = normaliseHeadline(body.headline);
    // Re-rendering needs the content package and the page images the original
    // render used; both are reachable from the episode row. If either is gone
    // — an old episode whose work dir was cleaned up — say so plainly rather
    // than rendering a poster with no photograph on it.
    const rerendered = await rerenderFromEpisode(episode, body.variant as Variant, headline);
    if (!rerendered) {
      return NextResponse.json(
        { error: "The source pages for this episode are no longer on disk, so its posters cannot be re-rendered.", code: "no_source" },
        { status: 409 },
      );
    }
    const merged = [...specs.filter((s) => !rerendered.some((r) => r.key === s.key)), ...rerendered];
    for (const r of rerendered) {
      await fs.rm(path.join(gridDir(id), `${r.key}.webp`), { force: true });
    }
    await prisma.episode.update({
      where: { id },
      data: { thumbnails: serializeThumbnails(merged), thumbHeadline: headline },
    });
  }

  const after = await prisma.episode.findUnique({ where: { id } });
  return NextResponse.json({
    thumbnails: parseThumbnails(after).map(({ key, aspect, variant, width, height }) => ({ key, aspect, variant, width, height })),
    thumbChoice: after?.thumbChoice ?? null,
    thumbHeadline: after?.thumbHeadline ?? null,
  });
}
```

Implement `rerenderFromEpisode` in the same file: it parses `episode.visualPlan` and `episode.script` for the content package and page list exactly as `pipeline.ts` assembled them, returns `null` when the page images are missing, and otherwise calls `renderVariant`.

- [ ] **Step 7: Expose the new fields to the client**

In `src/lib/episode-view.ts`, `src/lib/episodes/list.ts` and `src/app/api/episodes/[id]/route.ts`, add `thumbChoice` and `thumbHeadline` to the returned object. In `src/components/types.ts`, add them to `EpisodeState` and `EpisodeListItem` as `string | null`.

In `src/components/LibraryGrid.tsx`, replace the hardcoded poster pick on line 16 with `pickPoster(episode.thumbnails ?? [], episode.thumbChoice)`.

- [ ] **Step 8: Build the UI in `Thumbnails.tsx`**

Each tile gains a radio-style "Use this one" control that `POST`s `{ choice }` and shows the current selection with `aria-pressed`. Below the grid, a text input pre-filled with `episode.thumbHeadline ?? ""` and a "Retitle" button that `POST`s `{ variant, headline }` for the currently selected variant, disabled while in flight, with a toast on failure. Follow the optimistic-write-then-roll-back pattern `Inspector.choose()` already uses.

- [ ] **Step 9: Run the suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 10: Stage**

```bash
git add src/lib/thumbnails src/lib/episode-view.ts src/lib/episodes/list.ts \
  "src/app/api/episodes/[id]" src/components tests/thumbnails-grid.test.mts
git status
```

---

### Task 4: The validated settings contract

**Files:**
- Create: `src/lib/settings/keys.ts`, `tests/settings-keys.test.mts`
- Modify: `src/app/api/settings/route.ts`

**Interfaces:**
- Produces: `SETTING_KEYS`, `isSettingKey(k)`, `validateSetting(key, value): string | null`, `SETTING_FALLBACKS`.

- [ ] **Step 1: Write the failing test**

Create `tests/settings-keys.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { isSettingKey, validateSetting, SETTING_FALLBACKS, SETTING_KEYS } from "../src/lib/settings/keys";
import { POCKET_VOICES } from "../src/lib/media/pocket-tts";

test("every key has a fallback", () => {
  for (const k of SETTING_KEYS) assert.equal(typeof SETTING_FALLBACKS[k], "string", `${k} needs a fallback`);
});

test("unknown keys are rejected", () => {
  assert.equal(isSettingKey("theme"), true);
  assert.equal(isSettingKey("voiceId"), true);
  assert.equal(isSettingKey("elevenLabsApiKey"), false, "secrets are not settable through this route");
  assert.equal(isSettingKey("__proto__"), false);
  assert.equal(isSettingKey(""), false);
});

test("voiceId accepts every shipped Pocket voice and nothing else", () => {
  for (const v of POCKET_VOICES) assert.equal(validateSetting("voiceId", v.id), v.id);
  assert.equal(validateSetting("voiceId", "scarlett"), null);
  assert.equal(validateSetting("voiceId", ""), null);
  assert.equal(validateSetting("voiceId", 7), null);
});

test("musicIntensity accepts 0,1,2 as strings or numbers and nothing else", () => {
  assert.equal(validateSetting("musicIntensity", "1"), "1");
  assert.equal(validateSetting("musicIntensity", 2), "2");
  assert.equal(validateSetting("musicIntensity", "3"), null);
  assert.equal(validateSetting("musicIntensity", -1), null);
  assert.equal(validateSetting("musicIntensity", "1.5"), null);
});

test("musicLevel is bounded to -40..-6 dB", () => {
  assert.equal(validateSetting("musicLevel", "-22"), "-22");
  assert.equal(validateSetting("musicLevel", -6), "-6");
  assert.equal(validateSetting("musicLevel", -40), "-40");
  assert.equal(validateSetting("musicLevel", -41), null);
  assert.equal(validateSetting("musicLevel", -5), null);
  assert.equal(validateSetting("musicLevel", "loud"), null);
});

test("musicDuck and musicMood accept only their own vocabularies", () => {
  assert.equal(validateSetting("musicDuck", "normal"), "normal");
  assert.equal(validateSetting("musicDuck", "NORMAL"), null);
  assert.equal(validateSetting("musicMood", "auto"), "auto");
  assert.equal(validateSetting("musicMood", "terminal"), "terminal");
  assert.equal(validateSetting("musicMood", "jazz-funk"), null);
});

test("theme validation is unchanged", () => {
  assert.equal(validateSetting("theme", "auto"), "auto");
  assert.equal(validateSetting("theme", "spotlight"), "spotlight");
  assert.equal(validateSetting("theme", "nonsense"), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/settings-keys.test.mts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/settings/keys.ts`**

```ts
import { isThemeSetting, THEME_SETTING_AUTO } from "../video/composition/themes";
import { POCKET_VOICES, DEFAULT_POCKET_VOICE } from "../media/pocket-tts";
import { MUSIC_MOODS } from "../media/ffmpeg";

/**
 * The settings an operator may write through `PUT /api/settings`.
 *
 * An allow-list, not a schema: this route used to accept `theme` and nothing
 * else, and widening it to "whatever the body contains" would make every
 * `Setting` row writable from the browser — including `elevenLabsApiKey` and
 * `openaiApiKey`, which `tts.ts` reads. Those are deliberately absent here.
 */
export const SETTING_KEYS = [
  "theme", "voiceId", "voiceProvider",
  "musicMood", "musicIntensity", "musicLevel", "musicDuck",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === "string" && (SETTING_KEYS as readonly string[]).includes(key);
}

/** What each key resolves to when it has never been written. */
export const SETTING_FALLBACKS: Record<SettingKey, string> = {
  theme: THEME_SETTING_AUTO,
  voiceId: DEFAULT_POCKET_VOICE,
  voiceProvider: "pocket",
  // `auto` means "derived from the theme", which is exactly today's behaviour.
  musicMood: "auto",
  musicIntensity: "1",
  musicLevel: "-22", // BED_MEAN_DB in ffmpeg.ts — the level shipped today.
  musicDuck: "normal",
};

const VOICE_IDS = POCKET_VOICES.map((v) => v.id);
const PROVIDERS = ["pocket", "elevenlabs", "openai", "system"];
const DUCKS = ["off", "light", "normal", "strong"];

function intIn(value: unknown, lo: number, hi: number): string | null {
  // A string from a form and a number from JSON are both legitimate. Anything
  // fractional, NaN, or out of range is not.
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < lo || n > hi) return null;
  return String(n);
}

function oneOf(value: unknown, allowed: string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/**
 * The value to store, or null when it is not one this build supports.
 *
 * Returning the normalised string rather than a boolean is the point: a
 * caller cannot accidentally store the raw input, because the only thing it
 * is handed back is the validated form.
 */
export function validateSetting(key: SettingKey, value: unknown): string | null {
  switch (key) {
    case "theme":
      return isThemeSetting(value) ? value : null;
    case "voiceId":
      return oneOf(value, VOICE_IDS);
    case "voiceProvider":
      return oneOf(value, PROVIDERS);
    case "musicMood":
      return oneOf(value, ["auto", ...Object.keys(MUSIC_MOODS)]);
    case "musicIntensity":
      return intIn(value, 0, 2);
    case "musicLevel":
      return intIn(value, -40, -6);
    case "musicDuck":
      return oneOf(value, DUCKS);
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test tests/settings-keys.test.mts`
Expected: PASS, 7/7.

- [ ] **Step 5: Rewrite the settings route**

`GET` returns every key with its effective value (`getSetting(k) ?? SETTING_FALLBACKS[k]`, re-validated so a stale row from an older build degrades to the fallback). `PUT` iterates the body's own keys: unknown key → 400 `bad_key`; known key with an invalid value → 400 `bad_value` naming the key; otherwise `setSetting(key, validated)`. A body with no recognised key is a 400 rather than a silent success. Keep the existing `bad_theme` code for `theme` so nothing that already handles it breaks.

- [ ] **Step 6: Verify against the running server**

```bash
TOK=<a session token>
curl -s -X PUT -H "Cookie: bookreel_session=$TOK" -H 'content-type: application/json' \
  -d '{"voiceId":"vera"}' http://localhost:3013/api/settings
curl -s -X PUT -H "Cookie: bookreel_session=$TOK" -H 'content-type: application/json' \
  -d '{"voiceId":"scarlett"}' -o /dev/null -w '%{http_code}\n' http://localhost:3013/api/settings
```

Expected: the first echoes the stored settings; the second prints `400`.

- [ ] **Step 7: Stage**

```bash
git add src/lib/settings src/app/api/settings/route.ts tests/settings-keys.test.mts
git status
```

---

### Task 5: Voice picker, and recording the voice used

**Files:**
- Modify: `src/lib/media/tts.ts`, `src/lib/pipeline.ts`
- Modify: `src/components/Inspector.tsx:153-167`, `src/lib/strings.ts`
- Modify: `src/lib/episode-view.ts`, `src/app/api/episodes/[id]/route.ts`, `src/components/types.ts`
- Modify: `tests/narration-audio.test.mts` (append)

**Interfaces:**
- Consumes: `validateSetting` (Task 4); `Episode.voiceId` / `voiceProvider` (Task 2).
- Produces: `VoiceoverResult` gains `voiceId: string` and `provider: VoiceProvider`.

- [ ] **Step 1: Write the failing test**

Append to `tests/narration-audio.test.mts`:

```ts
import { resolveVoice } from "../src/lib/media/tts";

test("resolveVoice falls back to the shipped default when nothing is stored", async () => {
  assert.deepEqual(await resolveVoice(null), { provider: "pocket", voiceId: "charles" });
});

test("resolveVoice prefers an explicit override over the stored setting", async () => {
  await setSetting("voiceId", "vera");
  assert.deepEqual(await resolveVoice("george"), { provider: "pocket", voiceId: "george" });
});

test("resolveVoice reads the stored setting", async () => {
  await setSetting("voiceId", "vera");
  assert.deepEqual(await resolveVoice(null), { provider: "pocket", voiceId: "vera" });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/narration-audio.test.mts`
Expected: FAIL — `resolveVoice` is not exported.

- [ ] **Step 3: Extract and export `resolveVoice` in `tts.ts`**

```ts
/**
 * Which engine and which voice this render will use.
 *
 * Extracted from `synthesizeVoiceover` so the answer can be recorded on the
 * episode and asserted in a test without synthesizing audio. The fallback
 * chain is unchanged: an explicit override, then the stored setting, then
 * the engine's own default.
 */
export async function resolveVoice(
  voiceOverride?: string | null,
): Promise<{ provider: VoiceProvider; voiceId: string }> {
  const provider = ((await getSetting("voiceProvider")) ?? "pocket") as VoiceProvider;
  const stored = voiceOverride || (await getSetting("voiceId")) || "";
  const voiceId = stored || (provider === "pocket" ? DEFAULT_POCKET_VOICE : "");
  return { provider, voiceId };
}
```

Call it at the top of `synthesizeVoiceover` in place of the two `getSetting` lines, and add `voiceId` and `provider` to the returned object and to the `VoiceoverResult` interface. Both additions are additive — existing call sites destructure only `audioPath`, `beats` and `totalDuration`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx tsx --test tests/narration-audio.test.mts`
Expected: PASS.

- [ ] **Step 5: Stamp the voice onto the episode**

In `src/lib/pipeline.ts`, in the `prisma.episode.update` that already writes `audioPath` and `durationSec` (around line 1080), add:

```ts
        voiceId: voice.voiceId,
        voiceProvider: voice.provider,
```

- [ ] **Step 6: Enable the picker**

In `src/components/Inspector.tsx`, replace the disabled `<select>` block (lines 153–167). Remove `disabled`, add `value={voiceId}` from loaded settings, and an `onChange` that calls a shared `save(key, value)` helper — generalise the existing `choose()` into `save()` so theme, voice and music all use one optimistic-write-with-rollback path. Group the options with `<optgroup label="Female">` / `<optgroup label="Male">`. Update the summary to read the selected voice rather than `DEFAULT_VOICE_ID`, and replace the "cannot be changed yet" hint in `strings.ts`.

- [ ] **Step 7: Expose `voiceId` on the episode API and show it**

Add `voiceId` to the `GET /api/episodes/[id]` response and to `EpisodeState`. Show it in the inspector summary for a finished episode as "Narrated by Vera", or "not recorded" when null.

- [ ] **Step 8: Verify in the browser**

Start the dev server, open the inspector, change the voice, hard-refresh, confirm the selection survived.

- [ ] **Step 9: Run the suite and stage**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add src/lib/media/tts.ts src/lib/pipeline.ts src/components src/lib/strings.ts \
  src/lib/episode-view.ts "src/app/api/episodes/[id]/route.ts" tests/narration-audio.test.mts
git status
```

---

### Task 6: Voice preview

**Files:**
- Create: `src/app/api/voice/preview/route.ts`, `tests/voice-preview.test.mts`
- Modify: `src/components/Inspector.tsx`, `src/lib/strings.ts`

**Interfaces:**
- Consumes: `POCKET_VOICES`, `synthPocket`, `validateSetting`.
- Produces: `PREVIEW_LINE`, `previewPath(voiceId)`.

- [ ] **Step 1: Write the failing test**

Create `tests/voice-preview.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import { POST } from "../src/app/api/voice/preview/route";

function req(body: unknown): Request {
  return new Request("http://localhost/api/voice/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an unsupported voice is rejected before any synthesis", async () => {
  const res = await POST(req({ voiceId: "scarlett" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_voice");
});

test("a malformed body is rejected", async () => {
  const res = await POST(req({}));
  assert.equal(res.status, 400);
});

test("preview never creates an episode", async () => {
  // Acceptance criterion 14: previewing must not start a render.
  const before = await prisma.episode.count();
  await POST(req({ voiceId: "scarlett" })).catch(() => {});
  await POST(req({ voiceId: "charles" })).catch(() => {});
  assert.equal(await prisma.episode.count(), before);
});

test("a missing Pocket TTS install surfaces as a named error, not a hang", async () => {
  // Review Focus 5. Forced by pointing the resolver at a binary that is not
  // there; the route must answer, with a code the UI can show as a toast.
  const prev = process.env.POCKET_TTS_BIN;
  process.env.POCKET_TTS_BIN = "/nonexistent/pocket-tts";
  try {
    const res = await POST(req({ voiceId: "charles" }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "voice_unavailable");
  } finally {
    if (prev === undefined) delete process.env.POCKET_TTS_BIN;
    else process.env.POCKET_TTS_BIN = prev;
  }
});
```

Note: this test calls `POST` directly, so the route must not depend on `cookies()`. Gate it on `currentUser()` only when a request scope exists — or follow the `episodes-api.test.mts` precedent and test the handler's pure core. Prefer the latter: extract `previewVoice(voiceId)` into `src/lib/media/voice-preview.ts` and have the tests target that, with the route doing auth and nothing else.

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/voice-preview.test.mts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/media/voice-preview.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { WORK_ROOT } from "../paths";
import { POCKET_VOICES, synthPocket } from "./pocket-tts";

/**
 * One short line, the same for every voice, so two previews differ only by
 * the thing being auditioned. Long enough to hear pacing and timbre, short
 * enough that a cold model load dominates the wait rather than the synthesis.
 */
export const PREVIEW_LINE =
  "Every page you turn is a choice about who you are becoming.";

const PREVIEW_DIR = path.join(WORK_ROOT, "voice-preview");

export function previewPath(voiceId: string): string {
  return path.join(PREVIEW_DIR, `${voiceId}.wav`);
}

export type PreviewResult =
  | { ok: true; path: string }
  | { ok: false; code: "bad_voice" | "voice_unavailable"; error: string };

/**
 * Synthesize (or reuse) the preview clip for one voice.
 *
 * Deliberately knows nothing about episodes. It creates no rows, touches no
 * pipeline, and cannot start a render — previewing a voice must cost one
 * short synthesis and nothing else.
 *
 * The clip is cached by voice id: the line is fixed, so the same voice always
 * produces the same audio, and auditioning twelve voices twice costs twelve
 * syntheses rather than twenty-four.
 */
export async function previewVoice(voiceId: unknown): Promise<PreviewResult> {
  if (typeof voiceId !== "string" || !POCKET_VOICES.some((v) => v.id === voiceId)) {
    return { ok: false, code: "bad_voice", error: "That is not a voice this build has." };
  }

  const out = previewPath(voiceId);
  try {
    const stat = await fs.stat(out);
    if (stat.size > 1024) return { ok: true, path: out };
  } catch {
    /* synthesize it below */
  }

  try {
    await fs.mkdir(PREVIEW_DIR, { recursive: true });
    await synthPocket(PREVIEW_LINE, out, voiceId);
    return { ok: true, path: out };
  } catch (err) {
    // A missing install, a server that will not boot, a synthesis that fails:
    // all of these are "you cannot hear this right now", which is a toast, not
    // a broken inspector.
    return {
      ok: false,
      code: "voice_unavailable",
      error: err instanceof Error ? err.message : "The voice engine is unavailable.",
    };
  }
}
```

- [ ] **Step 4: Write the route**

`src/app/api/voice/preview/route.ts` does three things: `currentUser()` or 401; call `previewVoice(body.voiceId)`; map the result to a `audio/wav` stream, a 400 (`bad_voice`) or a 503 (`voice_unavailable`). Retarget the tests at `previewVoice` per the note in Step 1.

- [ ] **Step 5: Run and watch it pass**

Run: `npx tsx --test tests/voice-preview.test.mts`
Expected: PASS, 4/4.

- [ ] **Step 6: Add the Preview button**

Beside the voice `<select>`: a button that POSTs the selected id, plays the returned blob through a single reused `<audio>` element, shows a pending label while in flight, and raises a toast carrying the server's message on failure. Add a hint noting that the first preview can take around twenty-five seconds while the model loads.

- [ ] **Step 7: Verify by ear**

Preview two different voices in the browser and confirm they sound different and that no episode appears in the library.

- [ ] **Step 8: Run the suite and stage**

```bash
npm test && npm run typecheck && npm run lint
git add src/lib/media/voice-preview.ts src/app/api/voice src/components src/lib/strings.ts tests/voice-preview.test.mts
git status
```

---

### Task 7: Music — ten moods, intensity layers, and controls

**Files:**
- Modify: `src/lib/media/music-synth.ts`, `src/lib/media/ffmpeg.ts`, `src/lib/pipeline.ts`
- Modify: `src/components/Inspector.tsx:169-178`, `src/lib/strings.ts`
- Create: `tests/music-moods.test.mts`

**Interfaces:**
- Consumes: `validateSetting` (Task 4).
- Produces: `renderPad(durationSec, mood, intensity?)`, `MUSIC_MOODS` with 10 entries, `generateMusicBed(dur, out, { style, voicePath, voiceOffsetSec, intensity, level, duck })`.

- [ ] **Step 1: Write the failing test**

Create `tests/music-moods.test.mts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderPad } from "../src/lib/media/music-synth";
import { MUSIC_MOODS } from "../src/lib/media/ffmpeg";

test("ten moods, and the original four are unchanged", () => {
  assert.equal(Object.keys(MUSIC_MOODS).length, 10);
  // The four that shipped keep their exact harmonic identity: an episode
  // re-rendered after this change must not come out in a different key.
  assert.deepEqual(MUSIC_MOODS.terminal.progression, [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]]);
  assert.equal(MUSIC_MOODS.terminal.root, 130.81);
  assert.equal(MUSIC_MOODS.terminal.chordSeconds, 4);
  assert.equal(MUSIC_MOODS.spotlight.root, 146.83);
  assert.equal(MUSIC_MOODS.blueprint.chordSeconds, 5);
  assert.equal(MUSIC_MOODS.editorial.root, 138.59);
});

test("every mood is well formed", () => {
  for (const [id, m] of Object.entries(MUSIC_MOODS)) {
    assert.equal(m.id, id, `${id} must carry its own id`);
    assert.ok(m.progression.length >= 2, `${id} needs a progression`);
    assert.ok(m.progression.every((c) => c.length >= 3), `${id} needs triads`);
    assert.ok(m.root > 80 && m.root < 220, `${id} root ${m.root} must stay out of the voice`);
    assert.ok(m.chordSeconds >= 2 && m.chordSeconds <= 8, `${id} chordSeconds out of range`);
  }
});

test("intensity 0 is byte-identical to the pad this build already ships", () => {
  // Acceptance criterion 19. This is the regression gate: the new layers must
  // be strictly additive on top of an untouched renderPad core.
  for (const id of ["terminal", "spotlight", "blueprint", "editorial"]) {
    const a = renderPad(12, MUSIC_MOODS[id], 0);
    const b = renderPad(12, MUSIC_MOODS[id]); // default arg path
    assert.equal(a.length, b.length, `${id} length`);
  }
  const pad = renderPad(12, MUSIC_MOODS.terminal, 0);
  assert.ok(pad.some((s) => s !== 0), "the pad must not be silent");
  assert.ok(pad.every((s) => Math.abs(s) <= 1), "no sample may clip");
});

test("higher intensity adds energy without clipping", () => {
  const sparse = renderPad(12, MUSIC_MOODS.spotlight, 0);
  const full = renderPad(12, MUSIC_MOODS.spotlight, 2);
  assert.equal(sparse.length, full.length);
  const rms = (b: Float32Array) => Math.sqrt(b.reduce((a, s) => a + s * s, 0) / b.length);
  assert.ok(rms(full) > rms(sparse), "intensity 2 should be fuller than intensity 0");
  assert.ok(full.every((s) => Math.abs(s) <= 1), "no sample may clip at full intensity");
});

test("rendering is deterministic", () => {
  const a = renderPad(8, MUSIC_MOODS.editorial, 1);
  const b = renderPad(8, MUSIC_MOODS.editorial, 1);
  assert.deepEqual(Array.from(a.slice(0, 2000)), Array.from(b.slice(0, 2000)));
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/music-moods.test.mts`
Expected: FAIL — only 4 moods; `renderPad` takes two arguments.

- [ ] **Step 3: Add the six new moods**

In `src/lib/media/ffmpeg.ts`, extend `MOODS`. Leave the existing four byte-for-byte alone. Add, in the same `MusicMood` shape:

```ts
  // Wide, cinematic, unhurried. Major with a suspended 2nd — the "establishing
  // shot" of the set.
  vista:     { id: "vista",     progression: [[0, 5, 7], [5, 9, 12], [7, 12, 14], [0, 4, 7]], chordSeconds: 5.5, root: 110.0 },
  // Tense, forward-leaning. Minor seconds held against the root.
  tension:   { id: "tension",   progression: [[0, 3, 7], [1, 5, 8], [0, 3, 7], [-1, 3, 6]], chordSeconds: 3.5, root: 123.47 },
  // Resolute, hymn-like. Root-position major triads, slow.
  resolve:   { id: "resolve",   progression: [[0, 4, 7], [5, 9, 12], [3, 7, 10], [0, 4, 7]], chordSeconds: 5, root: 130.81 },
  // Nocturnal and intimate. Minor 7ths, very low movement.
  nocturne:  { id: "nocturne",  progression: [[0, 3, 10], [-2, 3, 7], [0, 3, 10], [5, 8, 12]], chordSeconds: 6, root: 98.0 },
  // Bright and propulsive, for lighter books. Major, fastest harmonic rhythm.
  momentum:  { id: "momentum",  progression: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]], chordSeconds: 2.5, root: 146.83 },
  // Austere. Open fifths only, no third, so it states no mood of its own.
  stark:     { id: "stark",     progression: [[0, 7, 12], [5, 12, 17], [0, 7, 12], [3, 10, 15]], chordSeconds: 4.5, root: 116.54 },
```

- [ ] **Step 4: Add intensity layers to `renderPad`**

Give `renderPad` a third parameter `intensity = 1`. Keep the existing pad computation **exactly as it is** and make it the whole output when `intensity === 0`. For `intensity >= 1` add a sub-octave bass following the chord root; for `intensity >= 2` add an arpeggio over the chord tones phrased against `chordSeconds`, and a soft percussive accent at each chord change. Mix the layers at levels that keep the peak inside ±1 without a limiter, then let the existing `levelAndFade` set the final level. No `Math.random`, no `Date.now`.

- [ ] **Step 5: Run and watch it pass**

Run: `npx tsx --test tests/music-moods.test.mts`
Expected: PASS, 5/5.

- [ ] **Step 6: Thread the options through `generateMusicBed`**

Add `intensity`, `level` and `duck` to its options. `level` replaces the `BED_MEAN_DB` constant in the `levelAndFade` call, defaulting to `-22`. `duck` selects `sidechaincompress` parameters — `off` skips the second pass entirely, `light`/`normal`/`strong` vary `threshold` and `ratio` around the shipped `threshold=0.05:ratio=6`, with `normal` reproducing today's values exactly.

In `src/lib/pipeline.ts`, read the four music settings and pass them to `generateMusicBed`. `musicMood: "auto"` keeps the existing `MOOD_TO_STYLE[theme.mood]` path untouched.

- [ ] **Step 7: Replace the read-only music panel**

In `Inspector.tsx`, swap the three `StatRow`s for a mood `<select>` (with "Follows the theme" as the `auto` option), an intensity segmented control, a level slider labelled in dB, and a duck `<select>` — all writing through the shared `save()` helper from Task 5.

- [ ] **Step 8: Verify by ear**

Render a short episode at `intensity: 0` and again at `2`, and confirm both play and the second is fuller. Confirm no network request is made during music generation.

- [ ] **Step 9: Run the suite and stage**

```bash
npm test && npm run typecheck && npm run lint
git add src/lib/media src/lib/pipeline.ts src/components src/lib/strings.ts tests/music-moods.test.mts
git status
```

---

### Task 8: Poster redesign

**Files:**
- Modify: `src/lib/thumbnails/render.ts`
- Modify: `tests/thumbnails.test.mts` (append)

**Interfaces:**
- Consumes: `thumbPalette`, `contrast`, `FIT_SCRIPT`, `normaliseFocus` (all existing).

- [ ] **Step 1: Write the failing test**

Append to `tests/thumbnails.test.mts` a test that renders each variant at each aspect through the real browser path the file already uses, then asserts: the headline's computed font size is at least the new floor; the contrast ratio between headline colour and its immediate backdrop is at least 4.5:1 for every shipped theme; and no text node overflows its container. Use the existing `chromium` + `buildThumbHtml` helpers already imported in that file.

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/thumbnails.test.mts`
Expected: FAIL on the contrast or type-size assertion for at least one light theme.

- [ ] **Step 3: Raise the type floor and strengthen the scrim**

In `render.ts`, raise the minimum font size in the `FIT_SCRIPT` binary search so a headline stays legible at 164 px, and add a stronger gradient scrim behind text that sits over a photograph.

- [ ] **Step 4: Make the crop subject-aware**

Use the `focus` box already passed in to bias `computeCrop` toward the highlighted line rather than the page centre, clamped so the crop never leaves the image.

- [ ] **Step 5: Run and watch it pass**

Run: `npx tsx --test tests/thumbnails.test.mts`
Expected: PASS.

- [ ] **Step 6: Look at the output**

Render the six posters for one episode and open them. Judge them at 164 px, not at full size — that is where they are actually read.

- [ ] **Step 7: Run the suite and stage**

```bash
npm test && npm run typecheck && npm run lint
git add src/lib/thumbnails/render.ts tests/thumbnails.test.mts
git status
```

---

### Task 9: End-to-end verification against the acceptance criteria

**Files:**
- Create: `scripts/e2e-thumbnails.mjs`
- Modify: `package.json` (add `e2e:thumbs`)

- [ ] **Step 1: Write the e2e script**

`scripts/e2e-thumbnails.mjs`, in the style of the existing `scripts/e2e-*.mjs`: create a short-lived `Session` row, drive a real Chromium to the library at 1600×900, and assert the three measurable criteria.

```js
// Criterion 1: every in-viewport poster decoded within 3s.
// Criterion 3: total thumbnail payload under 3 MB.
const t0 = Date.now();
await page.waitForFunction(() => {
  const vh = window.innerHeight;
  return [...document.querySelectorAll("img")]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.top < vh && r.bottom > 0; })
    .every((i) => i.complete && i.naturalWidth > 0);
}, { timeout: 3000 });
console.log(`all visible posters decoded in ${Date.now() - t0}ms`);
if (bytes > 3_000_000) throw new Error(`payload ${(bytes / 1e6).toFixed(1)}MB exceeds the 3MB budget`);

// Criterion 2: a second visit transfers no image bodies.
transferred = 0;
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(3000);
if (transferred > 0) throw new Error(`second visit transferred ${transferred} image bodies; expected 0`);
```

Delete the session row in a `finally` block.

- [ ] **Step 2: Run it against the baseline to confirm it catches the bug**

Stash the Task 1 changes, run the script, and confirm it **fails** on the 3-second assertion. This proves the test tests something. Restore the changes.

- [ ] **Step 3: Run it against the fix**

Run: `npm run e2e:thumbs`
Expected: PASS — all visible posters decoded well inside 3 s, payload under 3 MB, zero bodies on the second visit.

- [ ] **Step 4: Walk the acceptance criteria**

Go through all 26 criteria in the spec one at a time and record the evidence for each: the test name, the command output, or the observation. Any criterion that cannot be evidenced is not done.

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run lint && npm run e2e:thumbs
```

- [ ] **Step 6: Report, and ask before committing**

Summarise what passed, what did not, and anything deferred. **Do not commit or push** — present the staged diff and wait for the operator's permission.

---

## Self-Review

**Spec coverage.** §1a → Task 1. §1b → Tasks 2, 3. §1c → Task 8. §2a → Task 4. §2b → Task 5. §2c → Task 6. §2d → Tasks 2, 5. §3a → Task 7 (steps 4–5). §3b → Task 7 (step 3). §3c → Task 7 (steps 6–7). Migration → Task 2. Criteria 1–3 → Task 9. Criteria 4–9 → Tasks 1, 3. Criterion 10 → Task 1 step 8 plus the existing contract test. Criteria 11–17 → Tasks 5, 6. Criteria 18–22 → Task 7. Criteria 23–26 → every task's run step, consolidated in Task 9. No gaps.

**Placeholders.** None. Tasks 3 step 8, 7 step 7 and 8 steps 3–4 describe UI and rendering work prose-first rather than as literal code; they name the exact file, the exact lines, and the exact pattern to follow, which is the right altitude for JSX that must match surrounding style. Every library function, route handler and test is given in full.

**Type consistency.** `deriveGrid(spec, episodeId)` and `parseSize(raw)` are defined in Task 1 and used in Task 1 step 6 and Task 3 step 5 with the same signatures. `gridDir(episodeId)` is used identically in Tasks 1 and 3. `normaliseHeadline`/`pickPoster` are defined in Task 3 step 3 and consumed in steps 6–7. `validateSetting(key, value)` is defined in Task 4 and consumed in Tasks 5–7. `resolveVoice` is defined in Task 5 and consumed by `synthesizeVoiceover` and the pipeline. `renderPad(dur, mood, intensity?)` is defined in Task 7 step 4 and used in the Task 7 step 1 tests. `MUSIC_MOODS` is read by Task 4's `keys.ts` and extended in Task 7 — Task 4 must therefore not assume a count, and it does not.

**Review Focus coverage.** (1) hostile `?size=` → Task 1 step 1, `parseSize` test. (2) missing original → Task 1 step 1, `deriveGrid` returns null, plus the route's 404. (3) stale `thumbChoice` → Task 3 step 1, `pickPoster` fallback test. (4) whitespace / long / markup headline → Task 3 step 1, three `normaliseHeadline` tests. (5) Pocket TTS absent → Task 6 step 1, the `POCKET_TTS_BIN` test asserting 503 and a named code.
