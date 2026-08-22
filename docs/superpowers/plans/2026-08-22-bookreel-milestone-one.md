# BookReel Milestone One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload photographs of book pages and get back one watchable 9:16 video in which the real page scrolls and a yellow marker sweeps the exact words being narrated.

**Architecture:** A fork of the RepoReel tree at `/Users/vims/Desktop/Test/git-automation` (16,981 lines, verified present). The generic layer — auth, database, paths, step timing, TTS, captions, ffmpeg, render invocation — is copied verbatim or near-verbatim. The GitHub input adapter is replaced by a photo-ingest chain: a vision model reads the words, a WASM OCR pass measures where they sit, and an LCS alignment maps one onto the other so a highlight can be drawn on the real photograph in time with measured audio.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma + SQLite, Tailwind v4, `playwright-core`, HyperFrames CLI + GSAP, Pocket TTS, ffmpeg static binaries, `sharp` (image handling), `tesseract.js` (OCR geometry only). Tests are `node:test` via `tsx`.

**Spec:** [docs/superpowers/specs/2026-08-22-bookreel-design.md](../specs/2026-08-22-bookreel-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript strict.** `npm run typecheck` must pass at the end of every task.
- **Test command:** `npm test` runs `node --import tsx --test tests/*.test.mts`. A single file: `node --import tsx --test tests/<name>.test.mts`.
- **Video format:** 9:16, 1080×1920, 30 fps, maximum 90 seconds. No 16:9 output in this milestone.
- **File size:** split a file when it passes roughly 400 lines. One responsibility per file.
- **Logic in pure functions, I/O at the edges.** This is what makes the unit tests possible.
- **Named errors, never an empty 500.** Every API handler wraps in try/catch and returns a named JSON error.
- **Renders and uploads live under `WORK_ROOT`, never `public/`.** Anything under `public/` is served by filename with no handler in front of it.
- **Seek-safety is absolute** in composition code: no CSS animations, `immediateRender: false` on every `fromTo` not at time zero, never two tweens on one property at once, no `Math.random()` at render time, escape `<` in embedded JSON.
- **Author is absent unless `authorVerified` is true.** No placeholder, no "unknown author", no empty byline.
- **Quotation budget for `in-copyright` books:** longest contiguous quote 25 words, verbatim share of narration 8%.
- **Highlight accuracy gate:** the marker rectangle must overlap its target word box by at least 90% of that box's area.
- **Accessibility:** WCAG 2.2 AA contrast, visible focus rings, full keyboard navigation, `prefers-reduced-motion` respected in the UI, responsive to 390 px.
- **`PipelineRail.STEPS` is updated in the same commit as any stage addition.** An unknown stage name makes `findIndex` return `-1` and the rail renders as though nothing has started.
- **Commit at the end of every task.** No task ends with uncommitted work.

## Scope: what is deliberately NOT in this milestone

The publish layer (`lib/publish/**`), the docs layer (`lib/docs/**`), the takeaway sheet, exports, thumbnails of either aspect ratio, the other three themes, and the schedule queue. They arrive in later plans.

**Consequence for Task 1:** `lib/publish/**` and `lib/docs/**` are *not copied* in this milestone. They reference `prisma.creation`, which this schema renames to `Episode`, and copying them would break `typecheck` for no benefit. They are copied and adapted in the milestone-three plan.

## File Structure

```
src/
  app/
    api/
      auth/{request,verify,me}/route.ts   copied verbatim
      uploads/route.ts                    POST: create upload, validate photos
      uploads/[id]/route.ts               GET: upload + pages + episodes
      uploads/[id]/ingest/route.ts        POST: start the ingest pipeline
      episodes/route.ts                   GET library
      episodes/[id]/route.ts              GET one episode + StepRuns (polled)
      episodes/[id]/video/route.ts        range-request MP4 streaming
      pages/[id]/image/route.ts           authenticated photo delivery
      health/route.ts                     adapted
    layout.tsx  page.tsx  login/page.tsx  adapted
  components/
    Studio.tsx           library + upload entry
    UploadDropzone.tsx   drag-drop, previews, reorder
    PipelineRail.tsx     adapted; STEPS rewritten
    Toast.tsx RunClock.tsx CopyBlock.tsx   copied verbatim
  lib/
    paths.ts db.ts reap.ts format-duration.ts   copied verbatim
    step-timer.ts                                adapted: episodeId
    errors.ts                                    NEW: named error types
    ingest/
      validate.ts     magic bytes, size caps          PURE + I/O
      normalize.ts    EXIF strip, downscale, deskew   sharp
      vision.ts       page photo -> PageText
      ocr.ts          page photo -> OcrWord[]         tesseract.js
      align.ts        vision words <-> ocr boxes      PURE
      lines.ts        boxes -> LineRun[]              PURE
      identity.ts     book identity + author chain
      names.ts        normalizePersonName             PURE
      plan-episodes.ts  1..N split                    PURE validation
    content/
      cli.ts cli-provider.ts anthropic.ts openai.ts   copied verbatim
      cli-vision.ts   NEW: image-capable CLI call
      schema.ts       REWRITTEN for books
      prompt.ts       REWRITTEN for books
      verify.ts       ADAPTED: quotation budget + author gate
      quotation.ts    NEW: budget check                PURE
      idea.ts         NEW: reserve/release/apply       replaces keyword.ts
      index.ts        ADAPTED orchestration
    media/
      tts.ts pocket-tts.ts captions.ts ffmpeg.ts fetch-guard.ts  copied verbatim
    video/
      render.ts theme.ts                copied verbatim
      sweep.ts        beat -> sweep timings            PURE
      composition/
        theme-contract.ts               the interface every theme implements
        build.ts                        shared skeleton, timeline, captions
        themes/marginalia.ts            the only theme in this milestone
    pipeline.ts       REWRITTEN: runIngest + runEpisode
tests/            *.test.mts
scripts/          fetch-ffmpeg.mjs setup-voice.mjs (copied) + new harnesses
```

---

### Task 1: Fork the skeleton

Produce a booting Next.js app with the generic layer copied in, the GitHub domain layer absent, and the test runner working.

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.gitignore`
- Create (copy verbatim from source): `src/lib/paths.ts`, `src/lib/db.ts`, `src/lib/reap.ts`, `src/lib/format-duration.ts`, `src/lib/media/fetch-guard.ts`, `src/lib/media/ffmpeg.ts`, `src/lib/media/tts.ts`, `src/lib/media/pocket-tts.ts`, `src/lib/media/captions.ts`, `src/lib/video/render.ts`, `src/lib/video/theme.ts`, `src/lib/auth/*`, `src/lib/content/cli.ts`, `src/lib/content/cli-provider.ts`, `src/lib/content/anthropic.ts`, `src/lib/content/openai.ts`, `scripts/fetch-ffmpeg.mjs`, `scripts/setup-voice.mjs`
- Create: `src/lib/errors.ts`
- Test: `tests/fetch-guard.test.mts` (copied verbatim — proves the copy landed intact)

**Interfaces:**
- Consumes: nothing.
- Produces: `WORK_ROOT`, `RENDER_DIR` (from `paths.ts`); `prisma`, `getSetting(key: string): Promise<string | null>`, `setSetting(key, value)`, `assertModels(...names: string[]): void` (from `db.ts`); `runCli(provider: CliProvider, system: string, user: string, model?: string): Promise<string>`, `extractJson<T>(raw: string): T`, `runCliJson<T>(...)`, `CliError` (from `content/cli.ts` and `cli-provider.ts`); `synthesizeVoiceover(beatTexts: string[], workDir: string, voiceOverride?: string | null): Promise<VoiceoverResult>` with `BeatAudio { index, text, file, start, end, speechStart, speechEnd }`; `buildCaptions(beats: BeatAudio[], wordsPerLine?: number): CaptionLine[]`, `toSrt(lines: CaptionLine[]): string`; `writeProject(files: ProjectFiles)`, `checkProject(dir): Promise<CheckResult>`, `renderProject(dir, outputAbs, quality, mode?)`; and the named error classes below.

- [ ] **Step 1: Copy the generic layer**

```bash
SRC=/Users/vims/Desktop/Test/git-automation
DST=/Users/vims/Desktop/Test/YT-Book
mkdir -p "$DST/src/lib/media" "$DST/src/lib/video" "$DST/src/lib/auth" "$DST/src/lib/content" "$DST/scripts" "$DST/tests"

for f in paths.ts db.ts reap.ts format-duration.ts; do cp "$SRC/src/lib/$f" "$DST/src/lib/$f"; done
for f in fetch-guard.ts ffmpeg.ts tts.ts pocket-tts.ts captions.ts; do cp "$SRC/src/lib/media/$f" "$DST/src/lib/media/$f"; done
for f in render.ts theme.ts; do cp "$SRC/src/lib/video/$f" "$DST/src/lib/video/$f"; done
cp "$SRC"/src/lib/auth/*.ts "$DST/src/lib/auth/"
for f in cli.ts cli-provider.ts anthropic.ts openai.ts; do cp "$SRC/src/lib/content/$f" "$DST/src/lib/content/$f"; done
cp "$SRC/scripts/fetch-ffmpeg.mjs" "$SRC/scripts/setup-voice.mjs" "$DST/scripts/"
cp "$SRC/tests/fetch-guard.test.mts" "$DST/tests/"
for f in tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs; do cp "$SRC/$f" "$DST/$f" 2>/dev/null || true; done
```

Note: `paths.ts` contains `path.join(process.cwd(), ".reporeel")`. Change that literal to `".bookreel"` and update the surrounding comment to say BookReel. Leave the rest of the file — including the explanation of why these constants live alone — exactly as it is.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "bookreel",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test tests/*.test.mts",
    "db:push": "DATABASE_URL=\"file:./dev.db\" prisma db push --skip-generate",
    "db:studio": "DATABASE_URL=\"file:./dev.db\" prisma studio",
    "setup": "npm run db:push && prisma generate && node scripts/fetch-ffmpeg.mjs",
    "setup:voice": "node scripts/setup-voice.mjs",
    "e2e:seek": "node --import tsx scripts/e2e-seek.mjs",
    "e2e:highlight": "node --import tsx scripts/e2e-highlight.mjs",
    "e2e:audio-tail": "node --import tsx scripts/e2e-audio-tail.mjs",
    "e2e:budget": "node --import tsx scripts/e2e-budget.mjs"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.117.1",
    "@prisma/client": "^6.19.3",
    "next": "16.3.1",
    "nodemailer": "^9.0.5",
    "playwright-core": "^1.62.1",
    "prisma": "^6.19.3",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "sharp": "^0.34.4",
    "tesseract.js": "^6.0.1"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/nodemailer": "^8.0.1",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.3.1",
    "tailwindcss": "^4",
    "tsx": "^4.23.12",
    "typescript": "^5"
  }
}
```

`marked`, `pdfkit` and `docx` are omitted deliberately — they belong to the docs layer, which this milestone does not build.

- [ ] **Step 3: Write `src/lib/errors.ts`**

```typescript
/**
 * Named errors, so an API handler can always answer with something the client
 * can distinguish from a dropped connection. An empty 500 is indistinguishable
 * from a network failure, and the UI hangs on exactly that.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export class BadUpload extends AppError {
  constructor(message: string) {
    super("bad_upload", message, 400);
  }
}

export class IngestFailed extends AppError {
  constructor(message: string) {
    super("ingest_failed", message, 500);
  }
}

/** Raised when the grounding check refuses the script, so the pipeline stops
 *  before the voiceover. Carries the report so the operator can read why. */
export class ContentRejectedError extends AppError {
  readonly report: unknown;
  constructor(message: string, report: unknown) {
    super("content_rejected", message, 422);
    this.report = report;
  }
}

/** Turn any thrown value into a JSON body. Never returns an empty object. */
export function errorBody(err: unknown): { error: string; code: string } {
  if (err instanceof AppError) return { error: err.message, code: err.code };
  const message = err instanceof Error ? err.message : String(err);
  return { error: message || "Something failed without saying what.", code: "unknown" };
}

export function errorStatus(err: unknown): number {
  return err instanceof AppError ? err.status : 500;
}
```

- [ ] **Step 4: Install and verify the copy landed intact**

```bash
npm install
npm run typecheck
node --import tsx --test tests/fetch-guard.test.mts
```

Expected: `typecheck` passes (the copied files have no dangling imports because nothing GitHub-related was copied), and the fetch-guard tests pass. If `typecheck` reports a missing module, a file was copied that imports something not on the copy list — remove that file, it belongs to a later milestone.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: fork the RepoReel generic layer into BookReel

Copies auth, db, paths, media, render and CLI-provider layers verbatim.
Omits publish/ and docs/ deliberately: they reference prisma.creation,
which this schema renames, and neither is in milestone one."
```

---

### Task 2: The schema

**Files:**
- Create: `prisma/schema.prisma`
- Modify: `src/lib/step-timer.ts` (creationId → episodeId)
- Test: `tests/schema.test.mts`

**Interfaces:**
- Consumes: `prisma` from Task 1.
- Produces: models `Book`, `Upload`, `Page`, `Episode`, `StepRun`, `Setting`, `User`, `Session`, `LoginCode`; and `StepTimer` with constructor `new StepTimer(episodeId: string)` and methods `begin()`, `start(name: string)`, `finish(): Promise<number>`, `fail()`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schema.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";

test("a book holds an upload holds pages, and an episode belongs to both", async () => {
  const book = await prisma.book.create({
    data: { title: "Test Title", rightsStatus: "in-copyright", archetype: "motivation" },
  });

  assert.equal(book.author, null, "author starts absent, never placeholdered");
  assert.equal(book.authorVerified, false, "author starts unverified");

  const upload = await prisma.upload.create({ data: { bookId: book.id } });
  await prisma.page.create({
    data: { uploadId: upload.id, pageIndex: 0, filePath: "/tmp/a.jpg", width: 100, height: 200 },
  });

  const episode = await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, partNumber: 1, seriesTotal: 1, theme: "marginalia" },
  });

  const loaded = await prisma.upload.findUniqueOrThrow({
    where: { id: upload.id },
    include: { pages: true, episodes: true },
  });
  assert.equal(loaded.pages.length, 1);
  assert.equal(loaded.episodes[0].id, episode.id);

  await prisma.book.delete({ where: { id: book.id } });
  const orphans = await prisma.page.count({ where: { uploadId: upload.id } });
  assert.equal(orphans, 0, "deleting a book cascades to its pages");
});

test("an idea can only be claimed once per book", async () => {
  const book = await prisma.book.create({ data: { title: "Once", rightsStatus: "own-work" } });
  await prisma.usedIdea.create({ data: { bookId: book.id, ideaKey: "discipline-beats-motivation" } });

  await assert.rejects(
    () => prisma.usedIdea.create({ data: { bookId: book.id, ideaKey: "discipline-beats-motivation" } }),
    /Unique constraint/i,
    "the same angle must not be claimable twice for one book",
  );

  await prisma.book.delete({ where: { id: book.id } });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/schema.test.mts`
Expected: FAIL — `prisma.book` is undefined, because no schema exists yet.

- [ ] **Step 3: Write the schema**

Copy `Setting`, `User`, `Session` and `LoginCode` verbatim from `/Users/vims/Desktop/Test/git-automation/prisma/schema.prisma`, removing `creations Creation[]` from `User` and replacing it with `episodes Episode[]`. Then add:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

/// A book the operator photographs, returned to over many uploads.
model Book {
  id             String  @id @default(cuid())
  title          String
  openLibraryId  String?
  coverPath      String?
  year           Int?
  subjects       String? // JSON string[]
  /// story | motivation | philosophy | howto | memoir
  archetype      String  @default("motivation")
  /// public-domain | in-copyright | own-work — drives the quotation budget.
  rightsStatus   String  @default("in-copyright")

  /// Null unless every link of the verification chain held. Never a
  /// placeholder: an unverified author is ABSENT, not "unknown".
  author               String?
  authorVerified       Boolean @default(false)
  /// Which link broke, so the omission is explainable rather than mysterious.
  authorOmissionReason String?

  uploads   Upload[]
  episodes  Episode[]
  usedHooks UsedHook[]
  usedIdeas UsedIdea[]
  createdAt DateTime @default(now())
}

/// One batch of photographs.
model Upload {
  id        String  @id @default(cuid())
  bookId    String
  book      Book    @relation(fields: [bookId], references: [id], onDelete: Cascade)
  userId    String?
  status    String  @default("QUEUED")
  step      String  @default("Queued")
  error     String?
  pages     Page[]
  episodes  Episode[]
  createdAt DateTime @default(now())

  @@index([bookId])
}

/// One photograph of one page.
model Page {
  id          String  @id @default(cuid())
  uploadId    String
  upload      Upload  @relation(fields: [uploadId], references: [id], onDelete: Cascade)
  /// Reading order. This is what the operator reorders before ingest starts.
  pageIndex   Int
  filePath    String  // EXIF-stripped original, under WORK_ROOT
  derivedPath String? // downscaled derivative used by the composition
  width       Int
  height      Int

  visionText          String? // JSON PageText
  ocrBoxes            String? // JSON OcrWord[]
  alignment           String? // JSON AlignedWord[]
  alignmentConfidence Float?

  @@index([uploadId])
  @@unique([uploadId, pageIndex])
}

/// One video.
model Episode {
  id       String  @id @default(cuid())
  bookId   String
  book     Book    @relation(fields: [bookId], references: [id], onDelete: Cascade)
  uploadId String
  upload   Upload  @relation(fields: [uploadId], references: [id], onDelete: Cascade)
  userId   String?
  user     User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  partNumber  Int    @default(1)
  seriesTotal Int    @default(1)
  theme       String @default("marginalia")
  ideaKey     String?

  status String  @default("QUEUED")
  step   String  @default("Queued")
  error  String?
  notes  String? // JSON string[] of advisory findings

  title        String?
  hook         String?
  script       String? // JSON Beat[]
  voScript     String?
  description  String?
  hashtags     String? // JSON string[]
  cta          String?

  verification String? // JSON GroundingReport
  groundedness Int?
  revised      Boolean @default(false)

  visualPlan  String? // JSON: page, word ranges, sweep timings, cue placements
  captions    String? // JSON CaptionLine[]
  srt         String?
  durationSec Float?
  audioPath   String?
  projectPath String?
  videoPath   String?

  startedAt  DateTime?
  finishedAt DateTime?
  totalMs    Int?
  steps      StepRun[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([bookId])
  @@index([uploadId])
  @@index([userId])
}

model StepRun {
  id         String   @id @default(cuid())
  episodeId  String
  episode    Episode  @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  step       String
  position   Int
  status     String   @default("RUNNING") // RUNNING | DONE | FAILED
  startedAt  DateTime
  endedAt    DateTime?
  durationMs Int?

  @@index([episodeId])
}

model UsedHook {
  id        String   @id @default(cuid())
  bookId    String
  book      Book     @relation(fields: [bookId], references: [id], onDelete: Cascade)
  hook      String
  hash      String   @unique
  createdAt DateTime @default(now())

  @@index([bookId])
}

/// The "one video, one idea" guarantee, enforceable rather than aspirational.
model UsedIdea {
  id        String   @id @default(cuid())
  bookId    String
  book      Book     @relation(fields: [bookId], references: [id], onDelete: Cascade)
  ideaKey   String
  episodeId String?
  createdAt DateTime @default(now())

  @@unique([bookId, ideaKey])
  @@index([bookId])
}
```

- [ ] **Step 4: Adapt `StepTimer`**

In `src/lib/step-timer.ts`, rename the constructor parameter and private field `creationId` → `episodeId`, and replace every `prisma.creation.update({ where: { id: this.creationId } ...})` with `prisma.episode.update({ where: { id: this.episodeId } ... })` and `prisma.stepRun.deleteMany({ where: { creationId: ... } })` with `{ where: { episodeId: this.episodeId } }`. Keep the class comment — the reason the timings tile the run with no gaps is unchanged.

- [ ] **Step 5: Push the schema and run the test**

```bash
npm run db:push && npx prisma generate
node --import tsx --test tests/schema.test.mts
npm run typecheck
```

Expected: both tests PASS, typecheck passes.

If `prisma.book` is still undefined after `prisma generate`, a `next dev` server is holding the old client. **Stop it and restart.** This is the documented trap that cost the original project hours, twice.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: BookReel schema — Book, Upload, Page, Episode

Creation splits into four models because a book is a source returned to
over weeks. UsedKeyword becomes UsedIdea, unique per (bookId, ideaKey),
which is what makes the one-video-one-idea guarantee enforceable.
Author is nullable and starts unverified."
```

---

### Task 3: Auth and the app shell

Sign in with an email code and see an empty library. Nothing else.

**Files:**
- Create (copy verbatim): `src/app/api/auth/request/route.ts`, `src/app/api/auth/verify/route.ts`, `src/app/api/auth/me/route.ts`, `src/app/login/page.tsx`, `src/components/SignIn.tsx`, `src/components/Toast.tsx`, `src/components/RunClock.tsx`, `src/components/CopyBlock.tsx`, `src/app/globals.css`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/Studio.tsx`, `src/app/api/episodes/route.ts`
- Test: `tests/episodes-api.test.mts`

**Interfaces:**
- Consumes: `prisma`, `errorBody`, `errorStatus` from Tasks 1–2; the copied session helpers from `src/lib/auth/session.ts`.
- Produces: `GET /api/episodes` returning `{ episodes: EpisodeSummary[] }` where `EpisodeSummary = { id, title, status, step, theme, partNumber, seriesTotal, durationSec, createdAt, bookTitle }`.

- [ ] **Step 1: Copy the auth layer and shared components**

```bash
SRC=/Users/vims/Desktop/Test/git-automation
mkdir -p src/app/api/auth src/app/login src/components
cp -R "$SRC/src/app/api/auth/." src/app/api/auth/
cp "$SRC/src/app/login/page.tsx" src/app/login/page.tsx
cp "$SRC/src/components/Toast.tsx" "$SRC/src/components/RunClock.tsx" "$SRC/src/components/CopyBlock.tsx" src/components/ 2>/dev/null
cp "$SRC/src/components/SignIn.tsx" src/components/ 2>/dev/null
cp "$SRC/src/app/globals.css" src/app/globals.css
cp "$SRC/src/app/layout.tsx" src/app/layout.tsx
```

Read `src/app/layout.tsx` after copying. Keep its pre-paint theme bootstrap exactly as it is — that inline script is what prevents a flash of the wrong theme. Change only the page title and metadata to BookReel.

If any copied file imports something not yet present (for example a settings component), delete that import and the JSX that uses it. Settings arrive in a later milestone.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/episodes-api.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../src/app/api/episodes/route";
import { prisma } from "../src/lib/db";

test("the library lists episodes newest first, with the book title attached", async () => {
  const book = await prisma.book.create({ data: { title: "Deep Work", rightsStatus: "in-copyright" } });
  const upload = await prisma.upload.create({ data: { bookId: book.id } });
  await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, title: "Older", partNumber: 1 },
  });
  await prisma.episode.create({
    data: { bookId: book.id, uploadId: upload.id, title: "Newer", partNumber: 2 },
  });

  const res = await GET();
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.episodes[0].title, "Newer", "newest first");
  assert.equal(body.episodes[0].bookTitle, "Deep Work");

  await prisma.book.delete({ where: { id: book.id } });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --import tsx --test tests/episodes-api.test.mts`
Expected: FAIL — cannot find module `../src/app/api/episodes/route`.

- [ ] **Step 4: Write the route**

```typescript
// src/app/api/episodes/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { errorBody, errorStatus } from "@/lib/errors";

export async function GET() {
  try {
    const rows = await prisma.episode.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { book: { select: { title: true } } },
    });

    return NextResponse.json({
      episodes: rows.map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        step: e.step,
        theme: e.theme,
        partNumber: e.partNumber,
        seriesTotal: e.seriesTotal,
        durationSec: e.durationSec,
        createdAt: e.createdAt,
        bookTitle: e.book.title,
      })),
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
```

- [ ] **Step 5: Write the shell**

```tsx
// src/app/page.tsx
import Studio from "@/components/Studio";
import { currentUser } from "@/lib/auth/session";
import SignIn from "@/components/SignIn";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <SignIn />;
  return <Studio />;
}
```

Check the exact export name in the copied `src/lib/auth/session.ts` before writing this — use whatever that file actually exports for "who is signed in", not `currentUser` if it is named something else.

`src/components/Studio.tsx` for this task is deliberately minimal: a heading, a `Toast` mount, and a list fetched from `/api/episodes` with an empty state that reads "No episodes yet — upload some book pages to make your first one." The upload entry point arrives in Task 5. Give the list `role="list"`, each row `role="listitem"`, and a visible focus ring on every interactive element.

- [ ] **Step 6: Run the test and the type check**

```bash
node --import tsx --test tests/episodes-api.test.mts
npm run typecheck
npm run dev   # visit http://localhost:3000, sign in, see the empty state
```

Expected: test PASSES, typecheck passes, and signing in lands on an empty library.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: auth layer and app shell with an empty episode library"
```

---

### Task 4: Photo validation and normalisation

Uploaded photographs are attacker-controlled binaries. This task makes them safe before anything else touches them.

**Files:**
- Create: `src/lib/ingest/validate.ts`, `src/lib/ingest/normalize.ts`
- Test: `tests/ingest-validate.test.mts`

**Interfaces:**
- Consumes: `BadUpload` from `src/lib/errors.ts`.
- Produces:
  - `detectImageType(buf: Buffer): "jpeg" | "png" | "heic" | "webp" | null` — magic-byte sniff, pure.
  - `MAX_PHOTO_BYTES = 12 * 1024 * 1024`, `MAX_UPLOAD_BYTES = 60 * 1024 * 1024`, `MAX_PHOTOS = 20`
  - `checkPhotoBatch(files: { name: string; bytes: number }[]): void` — throws `BadUpload`, pure.
  - `normalizePhoto(buf: Buffer, outPath: string): Promise<{ width: number; height: number }>` — strips EXIF, auto-rotates, writes JPEG.
  - `deriveForComposition(srcPath: string, outPath: string, longEdge?: number): Promise<void>` — downscale to 1,600 px long edge.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ingest-validate.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  detectImageType,
  checkPhotoBatch,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
} from "../src/lib/ingest/validate";
import { normalizePhoto } from "../src/lib/ingest/normalize";

test("the declared extension is not trusted; the bytes are", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const script = Buffer.from("<?php system($_GET['c']); ?>", "utf8");

  assert.equal(detectImageType(jpeg), "jpeg");
  assert.equal(detectImageType(png), "png");
  assert.equal(detectImageType(script), null, "a php file named photo.jpg is not a photo");
});

test("a batch that is too big, or too many, is refused with a readable reason", () => {
  assert.throws(
    () => checkPhotoBatch([{ name: "huge.jpg", bytes: MAX_PHOTO_BYTES + 1 }]),
    /huge\.jpg/,
    "the message names the offending file",
  );

  const tooMany = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => ({
    name: `p${i}.jpg`,
    bytes: 1000,
  }));
  assert.throws(() => checkPhotoBatch(tooMany), /at most/i);

  assert.doesNotThrow(() => checkPhotoBatch([{ name: "ok.jpg", bytes: 500_000 }]));
});

test("normalising a photo removes its EXIF, GPS included", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-exif-"));
  const out = path.join(dir, "clean.jpg");

  const withGps = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#ffffff" },
  })
    .withExif({ IFD0: { Copyright: "somebody" }, GPS: { GPSLatitudeRef: "N" } })
    .jpeg()
    .toBuffer();

  assert.ok(
    (await sharp(withGps).metadata()).exif,
    "precondition: the fixture actually carries EXIF",
  );

  const size = await normalizePhoto(withGps, out);
  const cleaned = await sharp(out).metadata();

  assert.equal(cleaned.exif, undefined, "no EXIF survives — a published video must not carry home coordinates");
  assert.equal(size.width, 40);
  assert.equal(size.height, 30);

  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/ingest-validate.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/validate`.

- [ ] **Step 3: Write `src/lib/ingest/validate.ts`**

```typescript
import { BadUpload } from "../errors";

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
export const MAX_PHOTOS = 20;

export type ImageType = "jpeg" | "png" | "heic" | "webp";

const starts = (buf: Buffer, bytes: number[], at = 0) =>
  bytes.every((b, i) => buf[at + i] === b);

/**
 * Sniff the container from its own bytes. The filename is supplied by whoever
 * is uploading and is therefore not evidence of anything.
 */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length < 12) return null;
  if (starts(buf, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return "webp";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

/** Throws BadUpload naming the offending file, so the UI can say which one. */
export function checkPhotoBatch(files: { name: string; bytes: number }[]): void {
  if (files.length === 0) throw new BadUpload("No photographs were attached.");
  if (files.length > MAX_PHOTOS)
    throw new BadUpload(`That is ${files.length} photographs; at most ${MAX_PHOTOS} can go in one upload.`);

  for (const f of files) {
    if (f.bytes > MAX_PHOTO_BYTES)
      throw new BadUpload(
        `${f.name} is ${(f.bytes / 1024 / 1024).toFixed(1)} MB. Each photograph must be under ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`,
      );
  }

  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > MAX_UPLOAD_BYTES)
    throw new BadUpload(
      `The upload totals ${(total / 1024 / 1024).toFixed(1)} MB. Keep it under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
}
```

- [ ] **Step 4: Write `src/lib/ingest/normalize.ts`**

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BadUpload } from "../errors";
import { detectImageType } from "./validate";

/**
 * Re-encode through a decoder before anything else touches the file, and drop
 * every metadata block on the way through. Phone photographs of books carry GPS
 * coordinates; a published video must not.
 *
 * `rotate()` with no argument applies the EXIF orientation and then discards it,
 * which is the only reason the orientation tag is read at all.
 */
export async function normalizePhoto(
  buf: Buffer,
  outPath: string,
): Promise<{ width: number; height: number }> {
  if (!detectImageType(buf)) throw new BadUpload("That file is not an image the app can read.");

  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const out = await sharp(buf, { failOn: "error" })
    .rotate()
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outPath);

  return { width: out.width, height: out.height };
}

/**
 * The composition frame is 1,080 px wide; phone photographs arrive around
 * 4,000 px. Handing the full-resolution file to the renderer costs frame time
 * for detail the viewer cannot see. The original is kept for OCR geometry.
 */
export async function deriveForComposition(
  srcPath: string,
  outPath: string,
  longEdge = 1600,
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(srcPath)
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outPath);
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test tests/ingest-validate.test.mts`
Expected: all three PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: photo validation and EXIF-stripping normalisation

Magic-byte sniffing, per-file and per-batch size caps, and a re-encode
that drops every metadata block. Phone photographs carry GPS."
```

---

### Task 5: The upload endpoint and dropzone

**Files:**
- Create: `src/app/api/uploads/route.ts`, `src/app/api/pages/[id]/image/route.ts`, `src/components/UploadDropzone.tsx`
- Modify: `src/components/Studio.tsx`
- Test: `tests/uploads-api.test.mts`

**Interfaces:**
- Consumes: `checkPhotoBatch`, `normalizePhoto`, `WORK_ROOT`, `BadUpload`, `errorBody`, `errorStatus`.
- Produces: `POST /api/uploads` accepting `multipart/form-data` with repeated `photos` fields plus `title` and `rightsStatus`, returning `{ uploadId, bookId, pages: { id, pageIndex, width, height }[] }`. `GET /api/pages/[id]/image` streams the photograph to a signed-in user.
- Produces: `uploadDir(uploadId: string): string` exported from `src/lib/paths.ts` (append it there — it belongs with the other path constants).

**Note on testing an authenticated route.** The handler needs a session, and a
unit test has no cookie jar. Keep the route thin and put the work in
`src/lib/ingest/create-upload.ts` as `createUpload(form: FormData, userId: string | null)`
— the route does auth then delegates, and the test calls `createUpload` directly.
This is the "logic in pure functions, I/O at the edges" constraint doing real
work rather than being decoration. The test below is written against the route
for readability; adjust the import to `createUpload` and pass `null` for the
user id when you split it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/uploads-api.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { POST } from "../src/app/api/uploads/route";
import { prisma } from "../src/lib/db";

async function photo(width: number, height: number): Promise<Blob> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: "#eeeeee" },
  }).jpeg().toBuffer();
  return new Blob([buf], { type: "image/jpeg" });
}

test("an upload creates a book, an upload and one page per photo, in order", async () => {
  const form = new FormData();
  form.set("title", "Atomic Habits");
  form.set("rightsStatus", "in-copyright");
  form.append("photos", await photo(80, 120), "page-1.jpg");
  form.append("photos", await photo(80, 120), "page-2.jpg");

  const res = await POST(new Request("http://x/api/uploads", { method: "POST", body: form }));
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.pages.length, 2);
  assert.deepEqual(body.pages.map((p: { pageIndex: number }) => p.pageIndex), [0, 1],
    "page order is the order they were sent — it is the reading order");

  const book = await prisma.book.findUniqueOrThrow({ where: { id: body.bookId } });
  assert.equal(book.author, null, "an upload never sets an author");
  assert.equal(book.authorVerified, false);

  await prisma.book.delete({ where: { id: body.bookId } });
});

test("a non-image is refused with a named error, not an empty 500", async () => {
  const form = new FormData();
  form.set("title", "Nope");
  form.append("photos", new Blob([Buffer.from("not an image")], { type: "image/jpeg" }), "evil.jpg");

  const res = await POST(new Request("http://x/api/uploads", { method: "POST", body: form }));
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.code, "bad_upload");
  assert.ok(body.error.length > 0, "the client must never receive an empty body");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/uploads-api.test.mts`
Expected: FAIL — cannot find module `../src/app/api/uploads/route`.

- [ ] **Step 3: Add `uploadDir` to `src/lib/paths.ts`**

```typescript
/** Photographs live beside the renders, outside `public/`, for the same reason. */
export const UPLOAD_DIR = path.join(WORK_ROOT, "uploads");

export function uploadDir(uploadId: string): string {
  return path.join(UPLOAD_DIR, uploadId);
}
```

- [ ] **Step 4: Write `src/app/api/uploads/route.ts`**

```typescript
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { uploadDir } from "@/lib/paths";
import { checkPhotoBatch } from "@/lib/ingest/validate";
import { normalizePhoto } from "@/lib/ingest/normalize";
import { BadUpload, errorBody, errorStatus } from "@/lib/errors";

const RIGHTS = new Set(["public-domain", "in-copyright", "own-work"]);

export async function POST(req: Request) {
  try {
    // Photographs are private; this route creates them. Use whatever
    // `src/lib/auth/session.ts` exports, matching the copied auth routes.
    const user = await requireUser();

    const form = await req.formData();
    const title = String(form.get("title") ?? "").trim();
    if (!title) throw new BadUpload("Give the book a title so its episodes can be grouped.");

    const rightsStatus = String(form.get("rightsStatus") ?? "in-copyright");
    if (!RIGHTS.has(rightsStatus)) throw new BadUpload(`"${rightsStatus}" is not a rights status.`);

    const entries = form.getAll("photos").filter((v): v is File => v instanceof File);
    checkPhotoBatch(entries.map((f) => ({ name: f.name, bytes: f.size })));

    // The book is looked up by title so a second upload of the same book adds to
    // it rather than forking a parallel series with its own used-idea history.
    const book =
      (await prisma.book.findFirst({ where: { title } })) ??
      (await prisma.book.create({ data: { title, rightsStatus } }));

    const upload = await prisma.upload.create({ data: { bookId: book.id } });
    const dir = uploadDir(upload.id);

    const pages = [];
    for (let i = 0; i < entries.length; i++) {
      const buf = Buffer.from(await entries[i].arrayBuffer());
      const filePath = path.join(dir, `page-${String(i).padStart(2, "0")}.jpg`);
      const { width, height } = await normalizePhoto(buf, filePath);
      pages.push(
        await prisma.page.create({
          data: { uploadId: upload.id, pageIndex: i, filePath, width, height },
        }),
      );
    }

    return NextResponse.json({
      uploadId: upload.id,
      bookId: book.id,
      pages: pages.map((p) => ({ id: p.id, pageIndex: p.pageIndex, width: p.width, height: p.height })),
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
```

- [ ] **Step 5: Write the image delivery route**

```typescript
// src/app/api/pages/[id]/image/route.ts
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { errorBody, errorStatus } from "@/lib/errors";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const page = await prisma.page.findUnique({ where: { id } });
    if (!page) return NextResponse.json({ error: "No such page.", code: "not_found" }, { status: 404 });

    const bytes = await readFile(page.derivedPath ?? page.filePath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" },
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
```

Add the session check this route needs using whatever helper `src/lib/auth/session.ts` exports, matching how the copied auth routes do it. Photographs are private.

- [ ] **Step 6: Write `src/components/UploadDropzone.tsx`**

A client component. Requirements, all of which are testable by hand:

- Drag-and-drop plus a visible "choose files" button — dragging alone is not keyboard-reachable, so the button is not optional.
- Local object-URL thumbnails appear immediately, before any upload starts.
- Each thumbnail shows its page number and a remove control.
- **Reordering by drag, with keyboard alternatives** (move-up / move-down buttons on each thumbnail). Page order is the reading order; getting it wrong ruins the video, so it must be visible and adjustable before ingest.
- Title field and a rights-status select with three options: "Public domain", "Still in copyright", "My own work".
- Per-file error state showing the server's named message.
- `aria-live="polite"` region announcing "3 photographs ready" as files are added.
- Honours `prefers-reduced-motion`: no thumbnail animation when it is set.

Wire it into `Studio.tsx` above the episode list. On success it stores the returned `uploadId` and shows an "Ingest these pages" button, which Task 11 makes functional.

- [ ] **Step 7: Run the tests**

```bash
node --import tsx --test tests/uploads-api.test.mts
npm run typecheck
```

Expected: both tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: upload endpoint and dropzone with reorderable page sequence"
```

---

### Task 6: Reading the page with a vision model

**The existing CLI runner cannot do this.** `runClaudeCli` in the copied `src/lib/content/cli.ts` passes `--allowed-tools ""` and runs in a throwaway directory, so the model has no way to open an image file. This task adds an image-capable sibling rather than weakening the text path, which is correct as it stands.

**Files:**
- Create: `src/lib/content/cli-vision.ts`, `src/lib/ingest/vision.ts`
- Test: `tests/vision-parse.test.mts`

**Interfaces:**
- Consumes: `runCli`'s internals are *not* reused; `extractJson<T>` and `CliError` from `src/lib/content/cli.ts` are.
- Produces:
  - `PageText { pageIndex: number; chapterHeading: string | null; paragraphs: string[]; legible: boolean; note: string | null }`
  - `wordsOf(text: PageText): string[]` — pure, reading-order tokens.
  - `readPage(imagePath: string, pageIndex: number, provider: CliProvider, model?: string): Promise<PageText>`
  - `runCliVisionJson<T>(provider, system, user, imagePaths, schema, model?): Promise<T>`

- [ ] **Step 1: Write the failing test**

The model call itself is not unit-tested — it is exercised by the pipeline. What *is* tested is the pure tokenisation, because everything downstream indexes into it.

```typescript
// tests/vision-parse.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { wordsOf } from "../src/lib/ingest/vision";

test("words are taken in reading order, paragraph by paragraph", () => {
  const words = wordsOf({
    pageIndex: 0,
    chapterHeading: "Chapter Two",
    paragraphs: ["The first sentence.", "A second one, here."],
    legible: true,
    note: null,
  });

  assert.deepEqual(words, ["The", "first", "sentence.", "A", "second", "one,", "here."]);
});

test("the chapter heading is not part of the word stream", () => {
  const words = wordsOf({
    pageIndex: 0,
    chapterHeading: "Deep Work",
    paragraphs: ["Body text."],
    legible: true,
    note: null,
  });

  assert.ok(!words.includes("Deep"), "the heading is shown, not narrated, so it is not alignable body text");
  assert.deepEqual(words, ["Body", "text."]);
});

test("a hyphen broken across a line is rejoined", () => {
  const words = wordsOf({
    pageIndex: 0,
    chapterHeading: null,
    paragraphs: ["concen-\ntration matters"],
    legible: true,
    note: null,
  });

  assert.deepEqual(words, ["concentration", "matters"], "otherwise the highlight sweeps half a word");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/vision-parse.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/vision`.

- [ ] **Step 3: Write `src/lib/content/cli-vision.ts`**

```typescript
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractJson, CliError, type CliProvider } from "./cli";

const TIMEOUT_MS = 6 * 60_000;

function run(bin: string, args: string[], opts: { cwd: string; input: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new CliError(`${bin} timed out after ${Math.round(TIMEOUT_MS / 1000)}s reading a page.`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CliError(`${bin} could not be started: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) resolve(stdout);
      else reject(new CliError(`${bin} exited with ${code}: ${stderr.slice(-400) || "no output"}`));
    });

    child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * A CLI call that can see images.
 *
 * The text path deliberately runs with `--allowed-tools ""`, so it cannot open a
 * file at all. Reading a photograph needs the Read tool, so this variant enables
 * exactly that one tool and nothing else, and copies the images into a scratch
 * directory that becomes the working directory — so the only files reachable by
 * the enabled tool are the pages we chose to show it.
 */
export async function runCliVisionJson<T>(
  provider: CliProvider,
  system: string,
  user: string,
  imagePaths: string[],
  schema: object,
  model?: string,
): Promise<T> {
  if (provider !== "claude-cli") {
    throw new CliError(
      "Reading book pages needs the Claude Code CLI. Choose it under Settings → Provider, or add an Anthropic API key.",
    );
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-vision-"));
  try {
    const names: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const name = `page-${String(i).padStart(2, "0")}.jpg`;
      await fs.copyFile(imagePaths[i], path.join(cwd, name));
      names.push(name);
    }

    const contract =
      `\n\nRead these image files in this order: ${names.join(", ")}.` +
      `\n\nReturn ONLY a single JSON object — no prose, no markdown fence, no explanation before or after.` +
      ` It must validate against this JSON Schema:\n${JSON.stringify(schema)}`;

    const args = [
      "-p",
      "--output-format", "json",
      "--append-system-prompt", system + contract,
      "--allowed-tools", "Read",
      "--permission-mode", "acceptEdits",
    ];
    if (model) args.push("--model", model);

    const stdout = await run(process.env.CLAUDE_CLI_BIN?.trim() || "claude", args, { cwd, input: user });

    let envelope: { result?: string; subtype?: string };
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new CliError(
        `The Claude CLI did not return JSON while reading a page. Run \`claude\` once in a terminal to confirm you are signed in.\n${stdout.slice(0, 200)}`,
      );
    }

    if (typeof envelope.result === "string" && envelope.result.trim())
      return extractJson<T>(envelope.result);

    throw new CliError(
      `The Claude CLI read no content from the page (${envelope.subtype ?? "unknown"}).`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
```

If the CLI still refuses to run the Read tool under `acceptEdits`, change that one argument to `bypassPermissions`. It is defensible **only** because the working directory is a fresh temporary folder containing nothing but the page images that were deliberately copied into it. Do not widen `--allowed-tools`.

- [ ] **Step 4: Write `src/lib/ingest/vision.ts`**

```typescript
import { runCliVisionJson } from "../content/cli-vision";
import type { CliProvider } from "../content/cli";

export interface PageText {
  pageIndex: number;
  chapterHeading: string | null;
  paragraphs: string[];
  legible: boolean;
  /** Why a page could not be read, when `legible` is false. */
  note: string | null;
}

export const PAGE_TEXT_SCHEMA = {
  type: "object",
  required: ["chapterHeading", "paragraphs", "legible", "note"],
  additionalProperties: false,
  properties: {
    chapterHeading: { type: ["string", "null"] },
    paragraphs: { type: "array", items: { type: "string" }, minItems: 0 },
    legible: { type: "boolean" },
    note: { type: ["string", "null"] },
  },
} as const;

const SYSTEM = `You transcribe a photographed page of a printed book.

Transcribe the body text exactly as printed, paragraph by paragraph, in
reading order. Do not summarise, correct, modernise or improve the wording.

Rules:
- Running heads, page numbers and footnote markers are not body text. Leave them out.
- A chapter or section heading goes in chapterHeading, never in paragraphs.
- Keep a word broken across lines by a hyphen as it appears, hyphen and all.
- If the photograph is too blurred, cropped or dark to read with confidence,
  set legible to false and say why in note rather than guessing at the words.`;

/**
 * `words` is DERIVED here rather than asked for, so the token stream is a pure
 * function of the transcription. Asking the model for both invites the two to
 * disagree, and every downstream index — the alignment, the highlight, the
 * sweep timing — is an index into this array.
 */
export function wordsOf(text: PageText): string[] {
  return text.paragraphs
    .flatMap((p) =>
      p
        // A hyphen at a line break is a typesetting artefact, not part of the
        // word. Left in, the marker sweeps half a word and stops.
        .replace(/-\s*\n\s*/g, "")
        .split(/\s+/),
    )
    .map((w) => w.trim())
    .filter(Boolean);
}

export async function readPage(
  imagePath: string,
  pageIndex: number,
  provider: CliProvider,
  model?: string,
): Promise<PageText> {
  const raw = await runCliVisionJson<Omit<PageText, "pageIndex">>(
    provider,
    SYSTEM,
    `Transcribe this page.`,
    [imagePath],
    PAGE_TEXT_SCHEMA,
    model,
  );

  return {
    pageIndex,
    chapterHeading: raw.chapterHeading ?? null,
    paragraphs: Array.isArray(raw.paragraphs) ? raw.paragraphs : [],
    legible: raw.legible !== false,
    note: raw.note ?? null,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test tests/vision-parse.test.mts`
Expected: all three PASS.

- [ ] **Step 6: Verify against a real photograph**

Photograph one page of any book to `/tmp/page.jpg`, then:

```bash
node --import tsx -e "
import { readPage, wordsOf } from './src/lib/ingest/vision';
const t = await readPage('/tmp/page.jpg', 0, 'claude-cli');
console.log(t.chapterHeading, '|', t.legible, '|', wordsOf(t).length, 'words');
console.log(t.paragraphs[0]?.slice(0, 200));
"
```

Expected: a real paragraph of the book prints. **Look at it.** If it has been paraphrased rather than transcribed, the system prompt needs strengthening before anything is built on top.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: read a page photograph with the vision-capable CLI path

The text CLI path runs with --allowed-tools \"\" and cannot open a file,
so this adds a sibling that enables Read alone, in a scratch cwd holding
only the pages we chose to show it."
```

---

### Task 7: Measuring the page — OCR geometry

The vision model supplies the words. This supplies where they sit. Nothing here is trusted for *text*.

**Files:**
- Create: `src/lib/ingest/ocr.ts`
- Test: `tests/ocr.test.mts`

**Interfaces:**
- Produces:
  - `Box { x0: number; y0: number; x1: number; y1: number }`
  - `OcrWord { text: string; confidence: number; box: Box }`
  - `measurePage(imagePath: string): Promise<OcrWord[]>`
  - `OcrEngine` interface, so a native `tesseract` binary can replace `tesseract.js` later without touching a caller.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ocr.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { measurePage } from "../src/lib/ingest/ocr";

test("a rendered line of text comes back as words with plausible boxes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-ocr-"));
  const img = path.join(dir, "line.png");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
    <rect width="900" height="200" fill="white"/>
    <text x="40" y="120" font-family="Georgia, serif" font-size="64" fill="black">discipline beats motivation</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(img);

  const words = await measurePage(img);

  assert.ok(words.length >= 3, `expected at least 3 words, got ${words.length}`);
  const texts = words.map((w) => w.text.toLowerCase());
  assert.ok(texts.some((t) => t.includes("discipline")), `no 'discipline' in ${texts.join(" ")}`);

  // Boxes must be ordered left to right and sit inside the image.
  for (const w of words) {
    assert.ok(w.box.x1 > w.box.x0 && w.box.y1 > w.box.y0, "a box must have area");
    assert.ok(w.box.x1 <= 900 && w.box.y1 <= 200, "a box must sit inside the image");
  }
  const xs = words.map((w) => w.box.x0);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "words come back in reading order");

  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/ocr.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/ocr`.

- [ ] **Step 3: Write `src/lib/ingest/ocr.ts`**

```typescript
import { createWorker, type Worker } from "tesseract.js";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  box: Box;
}

/**
 * Kept behind an interface on purpose. `tesseract.js` is chosen because it needs
 * no system install, which keeps setup to one `npm install` — but it is WASM and
 * therefore slower than a native binary. If the performance harness shows ingest
 * over budget, a native `tesseract` engine drops in here and no caller changes.
 */
export interface OcrEngine {
  measure(imagePath: string): Promise<OcrWord[]>;
  dispose(): Promise<void>;
}

let shared: Promise<Worker> | null = null;

/** One worker, reused. Spinning one up per page dominates the ingest budget. */
function worker(): Promise<Worker> {
  if (!shared) shared = createWorker("eng");
  return shared;
}

export async function measurePage(imagePath: string): Promise<OcrWord[]> {
  const w = await worker();
  const { data } = await w.recognize(imagePath, {}, { blocks: true });

  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text?.trim();
          if (!text) continue;
          words.push({
            text,
            confidence: word.confidence ?? 0,
            box: { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 },
          });
        }
      }
    }
  }
  return words;
}

/** Called once when the process shuts down; a live worker holds the event loop open. */
export async function disposeOcr(): Promise<void> {
  if (!shared) return;
  const w = await shared;
  shared = null;
  await w.terminate();
}
```

Check `tesseract.js` v6's actual result shape before finalising — if `data.blocks` is undefined, the recognise options need `{ blocks: true }` passed differently, or `data.words` is available directly. Adjust the traversal to whatever the installed version returns; the exported `OcrWord[]` shape must not change.

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test tests/ocr.test.mts`
Expected: PASS. First run downloads language data and may take 30 seconds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: OCR geometry pass behind a swappable engine interface

tesseract.js for zero-install setup. Used for word boxes only — the
vision model supplies the text, because OCR reads phone photographs of
books badly and measures them well."
```

---

### Task 8: Alignment — mapping words onto geometry

The heart of the highlight. Pure, and therefore heavily tested.

**Files:**
- Create: `src/lib/ingest/align.ts`
- Test: `tests/align.test.mts`

**Interfaces:**
- Consumes: `OcrWord`, `Box` from Task 7.
- Produces:
  - `AlignedWord { visionIndex: number; word: string; box: Box | null; ocrIndex: number | null }`
  - `alignWords(visionWords: string[], ocrWords: OcrWord[]): { aligned: AlignedWord[]; confidence: number }`
  - `ALIGNMENT_FLOOR = 0.55`
  - `normalizeToken(s: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/align.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { alignWords, normalizeToken, ALIGNMENT_FLOOR } from "../src/lib/ingest/align";
import type { OcrWord } from "../src/lib/ingest/ocr";

const ocr = (words: string[]): OcrWord[] =>
  words.map((text, i) => ({
    text,
    confidence: 90,
    box: { x0: i * 100, y0: 0, x1: i * 100 + 90, y1: 40 },
  }));

test("punctuation and case do not stop a word matching its box", () => {
  assert.equal(normalizeToken("Discipline,"), "discipline");
  assert.equal(normalizeToken("“beats”"), "beats");
  assert.equal(normalizeToken("—"), "");
});

test("a clean page maps every word onto its own box", () => {
  const vision = ["Discipline", "beats", "motivation."];
  const { aligned, confidence } = alignWords(vision, ocr(["Discipline", "beats", "motivation"]));

  assert.equal(confidence, 1);
  assert.deepEqual(aligned.map((a) => a.ocrIndex), [0, 1, 2]);
  assert.equal(aligned[1].box?.x0, 100);
});

test("a word OCR misread is left without a box rather than given the wrong one", () => {
  const vision = ["Discipline", "beats", "motivation"];
  // OCR mangles the middle word into something unrecognisable.
  const { aligned, confidence } = alignWords(vision, ocr(["Discipline", "bcats", "motivation"]));

  assert.equal(aligned[0].ocrIndex, 0);
  assert.equal(aligned[1].ocrIndex, null, "a guess here paints the marker over the wrong words");
  assert.equal(aligned[2].ocrIndex, 2, "alignment recovers after the gap");
  assert.ok(confidence > 0.6 && confidence < 1);
});

test("OCR inventing extra words does not shift every later word one box left", () => {
  const vision = ["the", "quick", "brown", "fox"];
  const { aligned } = alignWords(vision, ocr(["the", "|", "quick", "brown", "fox"]));

  assert.deepEqual(
    aligned.map((a) => a.ocrIndex),
    [0, 2, 3, 4],
    "spurious OCR tokens must be skipped, not absorbed",
  );
});

test("OCR dropping words leaves those words unboxed and keeps the rest correct", () => {
  const vision = ["one", "two", "three", "four"];
  const { aligned } = alignWords(vision, ocr(["one", "three", "four"]));

  assert.deepEqual(aligned.map((a) => a.ocrIndex), [0, null, 1, 2]);
});

test("a page OCR could not read at all falls under the floor", () => {
  const vision = ["alpha", "beta", "gamma", "delta"];
  const { confidence } = alignWords(vision, ocr(["zzz", "qqq"]));

  assert.ok(confidence < ALIGNMENT_FLOOR, "this page must degrade to block highlighting");
});

test("an empty OCR result is survivable, not a crash", () => {
  const { aligned, confidence } = alignWords(["a", "b"], []);
  assert.equal(confidence, 0);
  assert.deepEqual(aligned.map((a) => a.box), [null, null]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/align.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/align`.

- [ ] **Step 3: Write `src/lib/ingest/align.ts`**

```typescript
import type { Box, OcrWord } from "./ocr";

export interface AlignedWord {
  visionIndex: number;
  word: string;
  ocrIndex: number | null;
  box: Box | null;
}

/**
 * Below this share of words carrying a box, a page highlights by paragraph block
 * instead of by word. A marker that lands on the wrong words is worse than one
 * that covers a whole paragraph.
 */
export const ALIGNMENT_FLOOR = 0.55;

/** Case, punctuation and quote marks differ between the two engines constantly. */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Longest common subsequence between what the vision model read and what OCR
 * measured.
 *
 * A subsequence rather than a nearest-neighbour walk, because the two failure
 * modes are insertion and deletion: OCR invents a token from a speck of dust, or
 * misses a word entirely. Either one shifts a positional walk by one and every
 * subsequent highlight lands on the wrong word — visibly, for the rest of the
 * video. LCS absorbs both without drift.
 *
 * A vision word with no confident counterpart gets `null`, never a nearby box.
 */
export function alignWords(
  visionWords: string[],
  ocrWords: OcrWord[],
): { aligned: AlignedWord[]; confidence: number } {
  const a = visionWords.map(normalizeToken);
  const b = ocrWords.map((w) => normalizeToken(w.text));

  const n = a.length;
  const m = b.length;

  const aligned: AlignedWord[] = visionWords.map((word, visionIndex) => ({
    visionIndex,
    word,
    ocrIndex: null,
    box: null,
  }));

  if (n === 0 || m === 0) return { aligned, confidence: 0 };

  // dp[i][j] = length of the LCS of a[i..] and b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      aligned[i].ocrIndex = j;
      aligned[i].box = ocrWords[j].box;
      matched++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++; // this vision word has no counterpart
    } else {
      j++; // this OCR token is spurious
    }
  }

  return { aligned, confidence: matched / n };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/align.test.mts`
Expected: all seven PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: LCS alignment of vision words onto OCR word boxes

Subsequence rather than positional walk: OCR inserts and deletes tokens,
and either one shifts a positional walk by one so every later highlight
lands on the wrong word for the rest of the video."
```

---

### Task 9: Line runs — turning boxes into a marker stroke

A highlighter does not paint word-shaped rectangles with gaps. It paints one continuous stroke per line.

**Files:**
- Create: `src/lib/ingest/lines.ts`
- Test: `tests/lines.test.mts`

**Interfaces:**
- Consumes: `Box`, `OcrWord` from Task 7; `AlignedWord` from Task 8.
- Produces:
  - `LineRun { box: Box; wordIndices: number[] }` — `wordIndices` are *vision* indices.
  - `clusterLineRuns(aligned: AlignedWord[]): LineRun[]`
  - `inheritBoxes(aligned: AlignedWord[], lines: LineRun[]): AlignedWord[]`
  - `runsForRange(lines: LineRun[], startWord: number, endWord: number): LineRun[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/lines.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { clusterLineRuns, inheritBoxes, runsForRange } from "../src/lib/ingest/lines";
import type { AlignedWord } from "../src/lib/ingest/align";

/** Three words on line one at y 0-40, three on line two at y 60-100. */
const twoLines = (): AlignedWord[] =>
  [
    { visionIndex: 0, word: "a", ocrIndex: 0, box: { x0: 10, y0: 0, x1: 90, y1: 40 } },
    { visionIndex: 1, word: "b", ocrIndex: 1, box: { x0: 100, y0: 2, x1: 180, y1: 42 } },
    { visionIndex: 2, word: "c", ocrIndex: 2, box: { x0: 190, y0: 1, x1: 270, y1: 41 } },
    { visionIndex: 3, word: "d", ocrIndex: 3, box: { x0: 10, y0: 60, x1: 90, y1: 100 } },
    { visionIndex: 4, word: "e", ocrIndex: 4, box: { x0: 100, y0: 61, x1: 180, y1: 101 } },
    { visionIndex: 5, word: "f", ocrIndex: 5, box: { x0: 190, y0: 60, x1: 270, y1: 100 } },
  ];

test("words sharing a baseline become one continuous stroke", () => {
  const lines = clusterLineRuns(twoLines());

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].wordIndices, [0, 1, 2]);
  assert.equal(lines[0].box.x0, 10, "the stroke starts at the first word");
  assert.equal(lines[0].box.x1, 270, "and runs to the last — no gaps between words");
  assert.deepEqual(lines[1].wordIndices, [3, 4, 5]);
});

test("lines come out in reading order, top to bottom", () => {
  const shuffled = [...twoLines()].reverse();
  const lines = clusterLineRuns(shuffled);
  assert.ok(lines[0].box.y0 < lines[1].box.y0);
});

test("an unmatched word inherits the line its neighbours are on", () => {
  const words = twoLines();
  words[1].box = null;
  words[1].ocrIndex = null;

  const lines = clusterLineRuns(words);
  const filled = inheritBoxes(words, lines);

  assert.ok(filled[1].box, "a word between two boxed neighbours is not left unpaintable");
  assert.equal(filled[1].box!.y0, lines[0].box.y0, "and it sits on their line, not somewhere else");
});

test("a word range spanning two lines yields both strokes, clipped to the range", () => {
  const lines = clusterLineRuns(twoLines());
  const runs = runsForRange(lines, 1, 4);

  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].wordIndices, [1, 2], "line one contributes only the words in range");
  assert.deepEqual(runs[1].wordIndices, [3, 4]);
  assert.equal(runs[0].box.x0, 100, "the stroke starts at the first word IN RANGE, not the line start");
});

test("a range with no boxes at all yields nothing rather than throwing", () => {
  const bare: AlignedWord[] = [{ visionIndex: 0, word: "x", ocrIndex: null, box: null }];
  assert.deepEqual(clusterLineRuns(bare), []);
  assert.deepEqual(runsForRange([], 0, 5), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/lines.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/lines`.

- [ ] **Step 3: Write `src/lib/ingest/lines.ts`**

```typescript
import type { Box } from "./ocr";
import type { AlignedWord } from "./align";

export interface LineRun {
  box: Box;
  /** Vision indices, ascending. */
  wordIndices: number[];
}

const centreY = (b: Box) => (b.y0 + b.y1) / 2;
const heightOf = (b: Box) => b.y1 - b.y0;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

function hull(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * Group boxed words into one stroke per line.
 *
 * Clustering is on the vertical centre with a tolerance derived from the median
 * word height, rather than a fixed pixel figure: a photograph taken closer to
 * the page has taller words and proportionally larger baseline jitter, and a
 * fixed tolerance splits one line into two on exactly those photographs.
 */
export function clusterLineRuns(aligned: AlignedWord[]): LineRun[] {
  const boxed = aligned.filter((w): w is AlignedWord & { box: Box } => w.box !== null);
  if (boxed.length === 0) return [];

  const tolerance = median(boxed.map((w) => heightOf(w.box))) * 0.6;

  const sorted = [...boxed].sort((a, b) => centreY(a.box) - centreY(b.box));
  const groups: (AlignedWord & { box: Box })[][] = [];

  for (const word of sorted) {
    const last = groups[groups.length - 1];
    const sameLine =
      last && Math.abs(centreY(word.box) - centreY(last[last.length - 1].box)) <= tolerance;
    if (sameLine) last.push(word);
    else groups.push([word]);
  }

  return groups.map((group) => {
    const inOrder = [...group].sort((a, b) => a.box.x0 - b.box.x0);
    return {
      box: hull(inOrder.map((w) => w.box)),
      wordIndices: inOrder.map((w) => w.visionIndex).sort((a, b) => a - b),
    };
  });
}

/**
 * Give an unboxed word the vertical extent of the line its neighbours sit on, so
 * a single OCR miss does not punch a hole in the middle of a stroke. The
 * horizontal extent is interpolated between the neighbours, never invented
 * beyond them.
 */
export function inheritBoxes(aligned: AlignedWord[], lines: LineRun[]): AlignedWord[] {
  return aligned.map((word, i) => {
    if (word.box) return word;

    const line = lines.find((l) => {
      const first = l.wordIndices[0];
      const last = l.wordIndices[l.wordIndices.length - 1];
      return i > first && i < last;
    });
    if (!line) return word;

    const before = aligned.slice(0, i).reverse().find((w) => w.box);
    const after = aligned.slice(i + 1).find((w) => w.box);
    if (!before?.box || !after?.box) return word;

    return {
      ...word,
      box: { x0: before.box.x1, y0: line.box.y0, x1: after.box.x0, y1: line.box.y1 },
    };
  });
}

/**
 * The strokes covering a word range, each clipped to the words actually in
 * range — a beat that starts mid-line must not paint the words before it.
 */
export function runsForRange(lines: LineRun[], startWord: number, endWord: number): LineRun[] {
  const out: LineRun[] = [];

  for (const line of lines) {
    const inRange = line.wordIndices.filter((i) => i >= startWord && i <= endWord);
    if (inRange.length === 0) continue;

    const fraction =
      (line.box.x1 - line.box.x0) / Math.max(1, line.wordIndices.length);
    const firstOffset = line.wordIndices.indexOf(inRange[0]);
    const lastOffset = line.wordIndices.indexOf(inRange[inRange.length - 1]);

    out.push({
      wordIndices: inRange,
      box: {
        x0: line.box.x0 + firstOffset * fraction,
        y0: line.box.y0,
        x1: line.box.x0 + (lastOffset + 1) * fraction,
        y1: line.box.y1,
      },
    });
  }

  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/lines.test.mts`
Expected: all five PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: cluster word boxes into per-line marker strokes

Baseline tolerance scales with median word height, because a photograph
taken closer to the page has proportionally larger baseline jitter and a
fixed pixel tolerance splits one line into two on exactly those."
```

---

### Task 10: Book identity and the author verification chain

The operator's rule: the author is revealed only when it can be established with certainty, and nothing waits on it.

**Files:**
- Create: `src/lib/ingest/names.ts`, `src/lib/ingest/identity.ts`
- Test: `tests/author-chain.test.mts`

**Interfaces:**
- Consumes: `guardedFetch` from the copied `src/lib/media/fetch-guard.ts` (check its real export name and use it — Open Library is a third-party URL and every hop must be re-checked).
- Produces:
  - `normalizePersonName(s: string): string`
  - `sameName(a: string, b: string): boolean`
  - `AuthorEvidence { works: { authors: string[] }[]; modelGuess: string | null; adversarialConfirmed: boolean }`
  - `AuthorResolution { author: string | null; verified: boolean; reason: string | null }`
  - `resolveAuthor(e: AuthorEvidence): AuthorResolution`
  - `lookupBook(title: string): Promise<{ openLibraryId: string | null; year: number | null; subjects: string[]; works: { authors: string[] }[] }>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/author-chain.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePersonName, sameName } from "../src/lib/ingest/names";
import { resolveAuthor } from "../src/lib/ingest/identity";

test("initials, case, punctuation and accents do not make two names different", () => {
  assert.equal(normalizePersonName("J. R. R. Tolkien"), normalizePersonName("J.R.R. Tolkien"));
  assert.ok(sameName("Gabriel García Márquez", "Gabriel Garcia Marquez"));
  assert.ok(sameName("cal newport", "Cal  Newport"));
  assert.ok(!sameName("Cal Newport", "Carl Newport"));
});

test("every link holding is the only way an author is revealed", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }],
    modelGuess: "cal newport",
    adversarialConfirmed: true,
  });

  assert.equal(r.verified, true);
  assert.equal(r.author, "Cal Newport", "the canonical spelling wins, not the model's casing");
  assert.equal(r.reason, null);
});

test("two candidate works means the author is absent, not the first one", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }, { authors: ["Someone Else"] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: true,
  });

  assert.equal(r.author, null);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "multiple-works");
});

test("an anthology with two authors is absent, not joined with an ampersand", () => {
  const r = resolveAuthor({
    works: [{ authors: ["A Writer", "Another Writer"] }],
    modelGuess: "A Writer",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "multiple-authors");
});

test("the model disagreeing with the catalogue breaks the chain", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }],
    modelGuess: "James Clear",
    adversarialConfirmed: true,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "model-disagreed");
});

test("the adversarial pass declining breaks the chain even when everything else agrees", () => {
  const r = resolveAuthor({
    works: [{ authors: ["Cal Newport"] }],
    modelGuess: "Cal Newport",
    adversarialConfirmed: false,
  });
  assert.equal(r.author, null);
  assert.equal(r.reason, "adversarial-declined");
});

test("no catalogue match at all is survivable and named", () => {
  const r = resolveAuthor({ works: [], modelGuess: "Someone", adversarialConfirmed: true });
  assert.equal(r.author, null);
  assert.equal(r.reason, "no-catalogue-match");
});

test("there is no partial-confidence state", () => {
  const cases = [
    { works: [], modelGuess: null, adversarialConfirmed: false },
    { works: [{ authors: [] }], modelGuess: "X", adversarialConfirmed: true },
    { works: [{ authors: ["X"] }], modelGuess: null, adversarialConfirmed: true },
  ];

  for (const c of cases) {
    const r = resolveAuthor(c);
    assert.equal(r.verified, false);
    assert.equal(r.author, null, "unverified means absent — never a placeholder or a maybe");
    assert.ok(r.reason, "and the broken link is always named");
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/author-chain.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/names`.

- [ ] **Step 3: Write `src/lib/ingest/names.ts`**

```typescript
/**
 * Two catalogues spell the same person differently — "J. R. R. Tolkien" and
 * "J.R.R. Tolkien" are one author, and a chain that treats them as two would
 * suppress an author it had in fact confirmed twice.
 */
export function normalizePersonName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sameName(a: string, b: string): boolean {
  return normalizePersonName(a) === normalizePersonName(b);
}
```

- [ ] **Step 4: Write `src/lib/ingest/identity.ts`**

```typescript
import { sameName } from "./names";

export interface AuthorEvidence {
  /** Works the catalogue returned for the identified title. */
  works: { authors: string[] }[];
  /** What the model independently read off the page images. */
  modelGuess: string | null;
  /** Whether the adversarial pass confirmed the name against those images. */
  adversarialConfirmed: boolean;
}

export interface AuthorResolution {
  author: string | null;
  verified: boolean;
  /** Which link broke, so the omission is explainable rather than mysterious. */
  reason: string | null;
}

const absent = (reason: string): AuthorResolution => ({ author: null, verified: false, reason });

/**
 * All four links or nothing. There is deliberately no intermediate confidence
 * state: a "probably" would eventually be rendered, and a wrong author on a real
 * channel is worse than no author at all.
 */
export function resolveAuthor(e: AuthorEvidence): AuthorResolution {
  if (e.works.length === 0) return absent("no-catalogue-match");
  if (e.works.length > 1) return absent("multiple-works");

  const authors = e.works[0].authors.filter((a) => a.trim());
  if (authors.length === 0) return absent("no-catalogue-author");
  if (authors.length > 1) return absent("multiple-authors");

  if (!e.modelGuess?.trim()) return absent("model-silent");
  if (!sameName(authors[0], e.modelGuess)) return absent("model-disagreed");
  if (!e.adversarialConfirmed) return absent("adversarial-declined");

  // The catalogue's spelling is canonical; the model's casing is not.
  return { author: authors[0], verified: true, reason: null };
}
```

- [ ] **Step 5: Add the catalogue lookup to the same file**

```typescript
const OPEN_LIBRARY = "https://openlibrary.org/search.json";

export interface BookIdentity {
  openLibraryId: string | null;
  year: number | null;
  subjects: string[];
  works: { authors: string[] }[];
}

/**
 * Open Library is a third-party URL, so it goes through the same guard as every
 * other outbound fetch. A catalogue failure is non-fatal: the title stands and
 * the author is simply absent.
 */
export async function lookupBook(title: string): Promise<BookIdentity> {
  const url = `${OPEN_LIBRARY}?title=${encodeURIComponent(title)}&limit=5&fields=key,title,author_name,first_publish_year,subject`;

  try {
    const res = await guardedFetch(url);
    const data = (await res.json()) as {
      docs?: { key?: string; title?: string; author_name?: string[]; first_publish_year?: number; subject?: string[] }[];
    };

    // Only exact title matches count as candidates. A fuzzy match is how an
    // author from a different book ends up on this video.
    const docs = (data.docs ?? []).filter(
      (d) => (d.title ?? "").trim().toLowerCase() === title.trim().toLowerCase(),
    );

    return {
      openLibraryId: docs[0]?.key ?? null,
      year: docs[0]?.first_publish_year ?? null,
      subjects: (docs[0]?.subject ?? []).slice(0, 12),
      works: docs.map((d) => ({ authors: d.author_name ?? [] })),
    };
  } catch {
    return { openLibraryId: null, year: null, subjects: [], works: [] };
  }
}
```

Import the guard from `@/lib/media/fetch-guard` using whatever it actually exports — read the file first. If it exports a checker rather than a fetcher, call the checker on the URL and then use `fetch`, following redirects manually so each hop is re-checked, exactly as the guard's own comment describes.

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --test tests/author-chain.test.mts`
Expected: all eight PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: book identity and the four-link author verification chain

Unverified means absent, never a placeholder. Every break is named so
the omission is explainable, and nothing downstream waits on it."
```

---

### Task 11: The episode planner and idea reservation

**Files:**
- Create: `src/lib/ingest/plan-episodes.ts`, `src/lib/content/idea.ts`
- Test: `tests/plan-episodes.test.mts`

**Interfaces:**
- Produces:
  - `EpisodePlan { ideaKey: string; title: string; startPage: number; endPage: number; startWord: number; endWord: number }`
  - `validatePlan(plan: EpisodePlan[], pageCount: number, wordsPerPage: number[]): EpisodePlan[]` — pure; repairs what it can, drops what it cannot.
  - `reserveIdea(bookId: string, ideaKey: string): Promise<string>` — throws if already claimed.
  - `releaseIdea(bookId: string, ideaKey: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/plan-episodes.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan, type EpisodePlan } from "../src/lib/ingest/plan-episodes";

const plan = (over: Partial<EpisodePlan>): EpisodePlan => ({
  ideaKey: "k",
  title: "T",
  startPage: 0,
  endPage: 0,
  startWord: 0,
  endWord: 10,
  ...over,
});

test("a well-formed plan passes through untouched", () => {
  const p = [plan({ ideaKey: "a", startPage: 0, endPage: 1 }), plan({ ideaKey: "b", startPage: 2, endPage: 2 })];
  assert.deepEqual(validatePlan(p, 3, [50, 50, 50]), p);
});

test("a page index past the end of the upload is clamped, not trusted", () => {
  const [only] = validatePlan([plan({ startPage: 0, endPage: 9 })], 3, [50, 50, 50]);
  assert.equal(only.endPage, 2);
});

test("a word range past the end of the page is clamped", () => {
  const [only] = validatePlan([plan({ startPage: 1, endPage: 1, startWord: 0, endWord: 999 })], 3, [50, 40, 50]);
  assert.equal(only.endWord, 39);
});

test("two episodes claiming the same idea keep only the first", () => {
  const out = validatePlan([plan({ ideaKey: "same" }), plan({ ideaKey: "same", title: "Dupe" })], 1, [50]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "T");
});

test("an inverted range is dropped rather than silently reversed", () => {
  assert.deepEqual(validatePlan([plan({ startWord: 30, endWord: 10 })], 1, [50]), []);
});

test("an empty plan falls back to one episode covering everything", () => {
  const out = validatePlan([], 3, [50, 40, 30]);
  assert.equal(out.length, 1, "an upload always produces at least one episode");
  assert.equal(out[0].startPage, 0);
  assert.equal(out[0].endPage, 2);
  assert.equal(out[0].endWord, 29, "ending on the last word of the last page");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/plan-episodes.test.mts`
Expected: FAIL — cannot find module `../src/lib/ingest/plan-episodes`.

- [ ] **Step 3: Write `src/lib/ingest/plan-episodes.ts`**

```typescript
export interface EpisodePlan {
  /** Kebab-case, stable, unique per book. The one-video-one-idea guarantee. */
  ideaKey: string;
  title: string;
  startPage: number;
  endPage: number;
  /** Word index within `startPage` / `endPage`, into that page's vision words. */
  startWord: number;
  endWord: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * A model proposing a split is proposing indices into arrays it never saw the
 * length of. Repair what is repairable, drop what is not, and never end an
 * upload with zero episodes — the operator uploaded pages to get a video.
 */
export function validatePlan(
  plan: EpisodePlan[],
  pageCount: number,
  wordsPerPage: number[],
): EpisodePlan[] {
  const seen = new Set<string>();
  const out: EpisodePlan[] = [];

  for (const raw of plan) {
    const key = raw.ideaKey?.trim();
    if (!key || seen.has(key)) continue;

    const startPage = clamp(raw.startPage, 0, pageCount - 1);
    const endPage = clamp(raw.endPage, startPage, pageCount - 1);
    const startWord = clamp(raw.startWord, 0, Math.max(0, wordsPerPage[startPage] - 1));
    const endWord = clamp(raw.endWord, 0, Math.max(0, wordsPerPage[endPage] - 1));

    // An inverted range on a single page is not a typo we can fix — reversing it
    // would narrate the passage backwards. Drop it.
    if (startPage === endPage && endWord < startWord) continue;

    seen.add(key);
    out.push({ ideaKey: key, title: raw.title?.trim() || key, startPage, endPage, startWord, endWord });
  }

  if (out.length > 0) return out;

  return [
    {
      ideaKey: "whole-upload",
      title: "The whole upload",
      startPage: 0,
      endPage: Math.max(0, pageCount - 1),
      startWord: 0,
      endWord: Math.max(0, (wordsPerPage[pageCount - 1] ?? 1) - 1),
    },
  ];
}
```

- [ ] **Step 4: Write `src/lib/content/idea.ts`**

```typescript
import { prisma } from "../db";
import { AppError } from "../errors";

export class IdeaTakenError extends AppError {
  constructor(ideaKey: string) {
    super("idea_taken", `This book already has an episode about "${ideaKey}".`, 409);
  }
}

/**
 * Claimed BEFORE the script is written, not after.
 *
 * Reserved afterwards, a run stores one angle while the video argues another,
 * and the guarantee that no two episodes of a book make the same point becomes
 * a hope. The unique index is what makes it enforceable.
 */
export async function reserveIdea(bookId: string, ideaKey: string): Promise<string> {
  try {
    await prisma.usedIdea.create({ data: { bookId, ideaKey } });
    return ideaKey;
  } catch {
    throw new IdeaTakenError(ideaKey);
  }
}

/** A claim burned by a failed run is an angle no future episode could ever use. */
export async function releaseIdea(bookId: string, ideaKey: string): Promise<void> {
  await prisma.usedIdea.deleteMany({ where: { bookId, ideaKey } });
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test tests/plan-episodes.test.mts`
Expected: all six PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: episode planner with index repair, and idea reservation

A model proposing a split is proposing indices into arrays whose lengths
it never saw. Reservation happens before writing so the stored angle and
the argued angle cannot diverge."
```

---

### Task 12: The content schema and prompt

This is the product's voice. It is rewritten wholesale, not adapted.

**Files:**
- Create: `src/lib/content/schema.ts`, `src/lib/content/prompt.ts` (overwriting nothing — the RepoReel versions were not copied)
- Test: `tests/content-schema.test.mts`

**Interfaces:**
- Produces:
  - `Beat { id: string; voiceover: string; onScreen: string; sourcePage: number; startWord: number; endWord: number }`
  - `ContentPackage { title; hook; hookKeywords?; beats: Beat[]; cta; description; hashtags: string[]; ideaKey; takeaway: string[] }`
  - `CONTENT_JSON_SCHEMA`
  - `voScriptFromPackage(pkg: ContentPackage): string`
  - `beatTexts(pkg: ContentPackage): string[]`
  - `buildSystemPrompt(opts: { hasAuthor: boolean }): string`
  - `buildUserPrompt(input: GenerateInput, revisionBrief?: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/content-schema.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { voScriptFromPackage, beatTexts, type ContentPackage } from "../src/lib/content/schema";
import { buildSystemPrompt } from "../src/lib/content/prompt";

const pkg = (): ContentPackage => ({
  title: "The two-minute rule",
  hook: "Most habits die in the first week.",
  hookKeywords: ["die", "first week"],
  ideaKey: "two-minute-rule",
  beats: [
    { id: "hook", voiceover: "Most habits die in the first week.", onScreen: "Week one", sourcePage: 0, startWord: 0, endWord: 12 },
    { id: "idea", voiceover: "The page argues you start too big.", onScreen: "Start smaller", sourcePage: 0, startWord: 13, endWord: 40 },
    { id: "cta", voiceover: "Follow for part two.", onScreen: "Part two tomorrow", sourcePage: 0, startWord: 41, endWord: 50 },
  ],
  cta: "Follow for part two.",
  description: "d",
  hashtags: ["books", "reading"],
  takeaway: ["Start smaller than feels useful."],
});

test("the spoken script is the beats in order, and nothing else", () => {
  const vo = voScriptFromPackage(pkg());
  assert.ok(vo.startsWith("Most habits die"));
  assert.ok(vo.endsWith("Follow for part two."));
  assert.ok(!vo.includes("Week one"), "on-screen labels are shown, not spoken");
});

test("one text per beat, because each becomes its own audio file", () => {
  assert.equal(beatTexts(pkg()).length, 3, "beat boundaries must be measurable, not estimated");
});

test("with no verified author, the prompt forbids naming one", () => {
  const s = buildSystemPrompt({ hasAuthor: false });
  assert.match(s, /do not name|never name|no author/i);
});

test("with a verified author, the prompt does not forbid it", () => {
  const s = buildSystemPrompt({ hasAuthor: true });
  assert.doesNotMatch(s, /do not name the author/i);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/content-schema.test.mts`
Expected: FAIL — cannot find module `../src/lib/content/schema`.

- [ ] **Step 3: Write `src/lib/content/schema.ts`**

```typescript
export type Archetype = "story" | "motivation" | "philosophy" | "howto" | "memoir";

export const ARCHETYPES: Archetype[] = ["story", "motivation", "philosophy", "howto", "memoir"];

export interface Beat {
  /** "hook" | "context" | "idea-1" .. | "turn" | "takeaway" | "cta" */
  id: string;
  voiceover: string;
  /** Short on-screen label, six words at most. */
  onScreen: string;
  /** Which page this beat is about, and which words on it. Drives the marker. */
  sourcePage: number;
  startWord: number;
  endWord: number;
}

export interface ContentPackage {
  title: string;
  hook: string;
  /** The two or three words in `hook` carrying its meaning, painted in accent. */
  hookKeywords?: string[];
  ideaKey: string;
  archetype?: Archetype;
  beats: Beat[];
  cta: string;
  description: string;
  hashtags: string[];
  /** Bullet points for the takeaway sheet. Written now, rendered in milestone three. */
  takeaway: string[];
}

export const CONTENT_JSON_SCHEMA = {
  type: "object",
  required: ["title", "hook", "ideaKey", "beats", "cta", "description", "hashtags", "takeaway"],
  additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 100 },
    hook: { type: "string", maxLength: 140 },
    hookKeywords: { type: "array", items: { type: "string" }, maxItems: 3 },
    ideaKey: { type: "string", pattern: "^[a-z0-9-]+$" },
    archetype: { type: "string", enum: ARCHETYPES },
    beats: {
      type: "array",
      minItems: 4,
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "voiceover", "onScreen", "sourcePage", "startWord", "endWord"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          voiceover: { type: "string", maxLength: 320 },
          onScreen: { type: "string", maxLength: 42 },
          sourcePage: { type: "integer", minimum: 0 },
          startWord: { type: "integer", minimum: 0 },
          endWord: { type: "integer", minimum: 0 },
        },
      },
    },
    cta: { type: "string", maxLength: 160 },
    description: { type: "string", maxLength: 1200 },
    hashtags: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 12 },
    takeaway: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
  },
} as const;

export interface GenerateInput {
  bookTitle: string;
  /** Absent unless verified. The writer is never handed an unverified name. */
  author: string | null;
  archetype: Archetype;
  rightsStatus: "public-domain" | "in-copyright" | "own-work";
  ideaKey: string;
  /** Page text the episode covers, page by page, as transcribed. */
  pages: { pageIndex: number; chapterHeading: string | null; words: string[] }[];
  avoidHooks: string[];
}

export function voScriptFromPackage(pkg: ContentPackage): string {
  return pkg.beats.map((b) => b.voiceover.trim()).filter(Boolean).join(" ");
}

/** One string per beat — each becomes its own audio file, so beat boundaries are
 *  measured rather than estimated. */
export function beatTexts(pkg: ContentPackage): string[] {
  return pkg.beats.map((b) => b.voiceover.trim());
}
```

- [ ] **Step 4: Write `src/lib/content/prompt.ts`**

```typescript
import type { GenerateInput } from "./schema";

const QUOTE_RULE = `You may quote the page directly ONCE, for at most 25 words, and only
where the author's exact wording is the point. Everything else is your own
sentences about what the page says. You are making commentary, not an audiobook.`;

export function buildSystemPrompt(opts: { hasAuthor: boolean }): string {
  return `You write 60-to-90-second vertical video scripts about single passages of books.

The viewer sees the real photographed page scrolling, with a yellow marker
sweeping the exact words you are talking about. Your beats therefore have to
name which words they are about — that is what drives the marker.

Voice: direct, specific, unhurried. One idea, argued properly. No throat-clearing,
no "in this video", no "let's dive in". Open on the sharpest thing you have.

${QUOTE_RULE}

${
  opts.hasAuthor
    ? `You may name the author where it helps.`
    : `The author of this book has NOT been established. Do not name an author,
do not guess at one, do not write "the author of" as a stand-in for a name, and
do not write any sentence whose sense depends on knowing who wrote this. Refer to
"the page", "the passage", or "the book" instead. This is not a formatting
preference — a name here would be a fabrication.`
}

Rules that are not negotiable:
- Every claim must be supported by the page text you are given. Invent nothing —
  no statistics, no study, no biographical detail, no anecdote that is not printed
  on the page.
- Each beat's startWord and endWord are indices into the word list of the page you
  name in sourcePage. They must point at the words the beat is actually about, and
  they must move forward through the passage.
- onScreen is a label, not a subtitle. Six words at most.
- The call to action is the last beat, and it asks for one thing.
- ideaKey is the single angle this episode takes, in kebab-case.`;
}

export function buildUserPrompt(input: GenerateInput, revisionBrief?: string): string {
  const pages = input.pages
    .map((p) => {
      const heading = p.chapterHeading ? `Heading: ${p.chapterHeading}\n` : "";
      const numbered = p.words.map((w, i) => `${i}:${w}`).join(" ");
      return `--- PAGE ${p.pageIndex} ---\n${heading}${numbered}`;
    })
    .join("\n\n");

  return [
    `Book: ${input.bookTitle}`,
    input.author ? `Author: ${input.author}` : `Author: not established — do not name one.`,
    `Archetype: ${input.archetype}`,
    `The angle this episode must take: ${input.ideaKey}`,
    input.avoidHooks.length
      ? `Openings already used for this book — do not reuse or paraphrase any of them:\n${input.avoidHooks.map((h) => `- ${h}`).join("\n")}`
      : "",
    ``,
    `Each word below is prefixed with its index. Use those indices for startWord and endWord.`,
    ``,
    pages,
    revisionBrief ? `\n\nThe checker rejected your previous draft. Fix this:\n${revisionBrief}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test tests/content-schema.test.mts`
Expected: all four PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: book content schema and prompt

Beats carry the word indices they are about, which is what drives the
marker. The writer is told up front when no author is established, so no
sentence is composed that needs one and then has to be patched."
```

---

### Task 13: The grounding check and the quotation budget

**Files:**
- Create: `src/lib/content/quotation.ts`, `src/lib/content/verify.ts`, `src/lib/content/index.ts`
- Test: `tests/quotation.test.mts`

**Interfaces:**
- Produces:
  - `QuotationReport { longestRun: number; verbatimShare: number; withinBudget: boolean; excerpt: string | null }`
  - `checkQuotationBudget(narration: string, source: string, rights: RightsStatus): QuotationReport`
  - `MAX_QUOTE_WORDS = 25`, `MAX_VERBATIM_SHARE = 0.08`, `RUN_FLOOR = 5`
  - `findAuthorMentions(pkg: ContentPackage, author: string | null): string[]`
  - `generateContent(opts): Promise<{ pkg, report, revised }>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/quotation.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { checkQuotationBudget, MAX_QUOTE_WORDS } from "../src/lib/content/quotation";

const source =
  "Discipline is not the same as motivation. Motivation is a feeling and feelings " +
  "are weather. Discipline is a decision you made once and keep. The page argues " +
  "that starting smaller than feels useful is the only reliable way through the " +
  "first fortnight of any new habit whatsoever.";

test("original commentary passes with room to spare", () => {
  const r = checkQuotationBudget(
    "The page draws a line between wanting to act and deciding to. One is a mood; the other is a standing choice.",
    source,
    "in-copyright",
  );

  assert.equal(r.withinBudget, true);
  assert.ok(r.longestRun < MAX_QUOTE_WORDS);
});

test("one short quote is allowed — that is the point of the budget", () => {
  const r = checkQuotationBudget(
    `The page puts it plainly: "Motivation is a feeling and feelings are weather." That framing is the whole argument, and it is worth sitting with for a moment before moving on to what follows from it.`,
    source,
    "in-copyright",
  );

  assert.equal(r.withinBudget, true);
});

test("reading the page aloud is refused for an in-copyright book", () => {
  const r = checkQuotationBudget(source, source, "in-copyright");

  assert.equal(r.withinBudget, false);
  assert.ok(r.longestRun > MAX_QUOTE_WORDS);
  assert.ok(r.excerpt, "the report names the offending passage so it can be shown");
});

test("the same narration is fine for a public-domain book", () => {
  assert.equal(checkQuotationBudget(source, source, "public-domain").withinBudget, true);
  assert.equal(checkQuotationBudget(source, source, "own-work").withinBudget, true);
});

test("many small lifts add up and are caught by the share, not the longest run", () => {
  const patchwork =
    "Discipline is not the same as motivation. Right. Motivation is a feeling. Right. " +
    "Discipline is a decision you made once. Right. Starting smaller than feels useful. Right.";

  const r = checkQuotationBudget(patchwork, source, "in-copyright");
  assert.equal(r.withinBudget, false, "a collage of short quotes is still a reproduction");
});

test("empty narration does not divide by zero", () => {
  const r = checkQuotationBudget("", source, "in-copyright");
  assert.equal(r.verbatimShare, 0);
  assert.equal(r.withinBudget, true);
});
```

And the author gate, in the same file — spec §10 requires this checked across
every field that reaches an output, not just the resolver in isolation:

```typescript
import { findAuthorMentions } from "../src/lib/content/verify";
import type { ContentPackage } from "../src/lib/content/schema";

const withAuthorIn = (field: string, value: string): ContentPackage => ({
  title: "T", hook: "H", ideaKey: "k", cta: "C", description: "D",
  hashtags: ["books"], takeaway: ["x", "y"],
  beats: [
    { id: "hook", voiceover: "V", onScreen: "O", sourcePage: 0, startWord: 0, endWord: 1 },
    { id: "cta", voiceover: "C", onScreen: "O", sourcePage: 0, startWord: 2, endWord: 3 },
  ],
  ...(field === "beatVoiceover"
    ? { beats: [
        { id: "hook", voiceover: value, onScreen: "O", sourcePage: 0, startWord: 0, endWord: 1 },
        { id: "cta", voiceover: "C", onScreen: "O", sourcePage: 0, startWord: 2, endWord: 3 },
      ] }
    : { [field]: value }),
});

test("a fabricated byline is caught in every field that reaches an output", () => {
  for (const field of ["title", "hook", "cta", "description", "beatVoiceover"]) {
    const pkg = withAuthorIn(field, "A passage by Cal Newport on focus.");
    assert.ok(
      findAuthorMentions(pkg, null).length > 0,
      `an author named in ${field} would reach a real channel unchallenged`,
    );
  }
});

test("a verified author is not flagged", () => {
  const pkg = withAuthorIn("hook", "A passage by Cal Newport on focus.");
  assert.deepEqual(findAuthorMentions(pkg, "Cal Newport"), []);
});

test("ordinary prose is not mistaken for a byline", () => {
  const pkg = withAuthorIn("hook", "Most habits die in the first week, by any measure.");
  assert.deepEqual(findAuthorMentions(pkg, null), [], "a false positive here blocks good runs");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/quotation.test.mts`
Expected: FAIL — cannot find module `../src/lib/content/quotation`.

- [ ] **Step 3: Write `src/lib/content/quotation.ts`**

```typescript
export type RightsStatus = "public-domain" | "in-copyright" | "own-work";

export const MAX_QUOTE_WORDS = 25;
export const MAX_VERBATIM_SHARE = 0.08;
/** Runs shorter than this are ordinary shared phrasing, not quotation. */
export const RUN_FLOOR = 5;

export interface QuotationReport {
  longestRun: number;
  verbatimShare: number;
  withinBudget: boolean;
  /** The offending passage, so the operator can be shown what tripped it. */
  excerpt: string | null;
}

const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Two limits, because there are two ways to reproduce a page: one long lift, or
 * a collage of short ones. A single-metric check catches only one of them.
 */
export function checkQuotationBudget(
  narration: string,
  source: string,
  rights: RightsStatus,
): QuotationReport {
  const n = tokens(narration);
  const s = tokens(source);

  if (n.length === 0) return { longestRun: 0, verbatimShare: 0, withinBudget: true, excerpt: null };

  const positions = new Map<string, number[]>();
  s.forEach((tok, i) => {
    const list = positions.get(tok);
    if (list) list.push(i);
    else positions.set(tok, [i]);
  });

  const covered = new Array<boolean>(n.length).fill(false);
  let longestRun = 0;
  let longestAt = 0;

  for (let i = 0; i < n.length; i++) {
    let best = 0;
    for (const start of positions.get(n[i]) ?? []) {
      let len = 0;
      while (i + len < n.length && start + len < s.length && n[i + len] === s[start + len]) len++;
      if (len > best) best = len;
    }

    if (best > longestRun) {
      longestRun = best;
      longestAt = i;
    }
    if (best >= RUN_FLOOR) for (let k = 0; k < best; k++) covered[i + k] = true;
  }

  const verbatimShare = covered.filter(Boolean).length / n.length;

  const unlimited = rights !== "in-copyright";
  const withinBudget =
    unlimited || (longestRun <= MAX_QUOTE_WORDS && verbatimShare <= MAX_VERBATIM_SHARE);

  return {
    longestRun,
    verbatimShare,
    withinBudget,
    excerpt: longestRun >= RUN_FLOOR ? n.slice(longestAt, longestAt + longestRun).join(" ") : null,
  };
}
```

- [ ] **Step 4: Write `src/lib/content/verify.ts`**

Model this on the copied RepoReel `verify.ts` — read `/Users/vims/Desktop/Test/git-automation/src/lib/content/verify.ts` first and keep its structure. Change the checks to:

1. every claim in every beat traces to the supplied page text;
2. no invented numbers, studies, biographical detail or anecdotes;
3. `startWord`/`endWord` on each beat actually point at words the beat discusses, and move forward through the passage;
4. **no author is named** — a hard blocker whenever `authorVerified` is false;
5. the hook differs from every previously used hook for this book;
6. the voiceover contains nothing a speech engine would mangle.

Export `GROUNDING_SYSTEM`, `GROUNDING_SCHEMA`, `buildGroundingPrompt(...)`, and `revisionBrief(report)`. The report shape is `{ verdict: "pass" | "revise"; groundedness: number; authorNamed: boolean; issues: { field: string; severity: "blocker" | "note"; problem: string }[] }`.

Add a deterministic pre-check that runs *before* the model call and short-circuits it:

```typescript
/** Cheap, certain, and not a matter of model judgement. */
export function findAuthorMentions(pkg: ContentPackage, author: string | null): string[] {
  if (author) return [];
  const fields = [pkg.title, pkg.hook, pkg.cta, pkg.description, ...pkg.beats.flatMap((b) => [b.voiceover, b.onScreen])];
  // "by <Capitalised Name>" and "author" are the two shapes a fabricated byline takes.
  const pattern = /\b(?:by|written by|author(?:ed)? by)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z.]+)+/g;
  return fields.flatMap((f) => f?.match(pattern) ?? []);
}
```

- [ ] **Step 5: Write `src/lib/content/index.ts`**

Model it on the copied RepoReel `index.ts` — read it first. Keep: the hook Jaccard similarity guard, the two-rewrite ceiling, the `try/catch` that releases the reservation on every failing path, and the `usedHook` upsert on success. Change: `reserveKeyword` → `reserveIdea(bookId, plan.ideaKey)`; `applyKeyword` is not needed because the idea key is not spoken; and add, immediately after each draft is produced and **before** the model check:

```typescript
const mentions = findAuthorMentions(candidate, book.author);
if (mentions.length) {
  // Deterministic, so it does not depend on the checker noticing. A fabricated
  // byline on a real channel is worse than a run that stops.
  throw new ContentRejectedError(
    `The script named an author (${mentions[0]}) for a book whose author has not been established.`,
    { authorNamed: true, mentions },
  );
}

const quotation = checkQuotationBudget(voScriptFromPackage(candidate), sourceText, book.rightsStatus);
if (!quotation.withinBudget) {
  throw new ContentRejectedError(
    `The narration reproduces too much of the page (longest run ${quotation.longestRun} words, ${Math.round(quotation.verbatimShare * 100)}% verbatim).`,
    quotation,
  );
}
```

Both throws must sit inside the existing `try`, so the idea reservation is released.

- [ ] **Step 6: Run the tests**

```bash
node --import tsx --test tests/quotation.test.mts
npm run typecheck
```

Expected: all six PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: quotation budget and grounding check with a deterministic author gate

Two limits because there are two ways to reproduce a page: one long lift
or a collage of short ones. The author gate is deterministic rather than
left to the checker noticing."
```

---

### Task 14: Sweep timing

Where the marker is, at every moment, derived from measured audio.

**Files:**
- Create: `src/lib/video/sweep.ts`
- Test: `tests/sweep.test.mts`

**Interfaces:**
- Consumes: `LineRun` from Task 9; `Box` from Task 7; `BeatAudio` from the copied `media/tts.ts`.
- Produces:
  - `SweepStep { box: Box; start: number; end: number }`
  - `sweepForBeat(lines: LineRun[], startWord: number, endWord: number, speechStart: number, speechEnd: number): SweepStep[]`
  - `cameraTrack(steps: SweepStep[], frameHeight: number, pageHeight: number): { t: number; y: number }[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/sweep.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { sweepForBeat, cameraTrack } from "../src/lib/video/sweep";
import type { LineRun } from "../src/lib/ingest/lines";

const lines: LineRun[] = [
  { box: { x0: 0, y0: 0, x1: 300, y1: 40 }, wordIndices: [0, 1, 2] },
  { box: { x0: 0, y0: 60, x1: 300, y1: 100 }, wordIndices: [3, 4, 5, 6, 7, 8, 9] },
];

test("the sweep starts when the beat starts and finishes when it finishes", () => {
  const steps = sweepForBeat(lines, 0, 9, 2, 6);

  assert.equal(steps[0].start, 2);
  assert.equal(steps[steps.length - 1].end, 6, "the marker must not still be moving in silence");
});

test("time is shared between lines in proportion to their words, not evenly", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 10);

  assert.equal(steps.length, 2);
  const first = steps[0].end - steps[0].start;
  const second = steps[1].end - steps[1].start;

  assert.ok(Math.abs(first - 3) < 0.01, `3 of 10 words should take ~3s, got ${first}`);
  assert.ok(Math.abs(second - 7) < 0.01, `7 of 10 words should take ~7s, got ${second}`);
});

test("steps are contiguous — no gap where the marker sits still mid-sentence", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 10);
  assert.equal(steps[0].end, steps[1].start);
});

test("a beat whose words have no geometry yields no sweep rather than a wrong one", () => {
  assert.deepEqual(sweepForBeat(lines, 40, 50, 0, 5), []);
  assert.deepEqual(sweepForBeat([], 0, 5, 0, 5), []);
});

test("the camera keeps the active stroke inside the middle third", () => {
  const tall: LineRun[] = [
    { box: { x0: 0, y0: 100, x1: 300, y1: 140 }, wordIndices: [0] },
    { box: { x0: 0, y0: 3000, x1: 300, y1: 3040 }, wordIndices: [1] },
  ];
  const steps = sweepForBeat(tall, 0, 1, 0, 4);
  const track = cameraTrack(steps, 1920, 4000);

  for (const key of track) {
    const step = steps.find((s) => key.t >= s.start && key.t <= s.end);
    if (!step) continue;
    const onScreen = (step.box.y0 + step.box.y1) / 2 - key.y;
    assert.ok(
      onScreen > 1920 / 3 - 1 && onScreen < (1920 * 2) / 3 + 1,
      `stroke at ${onScreen} is outside the middle third at t=${key.t}`,
    );
  }
});

test("the camera never scrolls past the ends of the page", () => {
  const steps = sweepForBeat(lines, 0, 9, 0, 4);
  const track = cameraTrack(steps, 1920, 2400);

  for (const key of track) {
    assert.ok(key.y >= 0, "never above the top of the page");
    assert.ok(key.y <= 2400 - 1920, "never below the bottom");
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/sweep.test.mts`
Expected: FAIL — cannot find module `../src/lib/video/sweep`.

- [ ] **Step 3: Write `src/lib/video/sweep.ts`**

```typescript
import type { Box } from "../ingest/ocr";
import type { LineRun } from "../ingest/lines";
import { runsForRange } from "../ingest/lines";

export interface SweepStep {
  box: Box;
  start: number;
  end: number;
}

/**
 * Split a beat's measured speech window across the strokes it covers.
 *
 * Proportional to word count rather than evenly, because a line holding seven
 * words takes longer to say than one holding three — and a marker that finishes
 * a line while the voice is still reading it is the single most obvious way this
 * effect looks fake.
 */
export function sweepForBeat(
  lines: LineRun[],
  startWord: number,
  endWord: number,
  speechStart: number,
  speechEnd: number,
): SweepStep[] {
  const runs = runsForRange(lines, startWord, endWord);
  if (runs.length === 0) return [];

  const totalWords = runs.reduce((sum, r) => sum + r.wordIndices.length, 0);
  if (totalWords === 0) return [];

  const span = Math.max(0, speechEnd - speechStart);
  const steps: SweepStep[] = [];
  let t = speechStart;

  for (let i = 0; i < runs.length; i++) {
    // The last step ends exactly on speechEnd rather than on an accumulated sum,
    // so floating-point drift cannot leave the marker moving after the voice stops.
    const end = i === runs.length - 1 ? speechEnd : t + (runs[i].wordIndices.length / totalWords) * span;
    steps.push({ box: runs[i].box, start: t, end });
    t = end;
  }

  return steps;
}

/** Where the top of the viewport sits, in page pixels, over time. */
export interface CameraKey {
  t: number;
  y: number;
}

const MIDDLE = 0.5;

/**
 * The camera follows the MARKER, not the beat text.
 *
 * RepoReel learned that steering a scroll to whichever passage a beat mentioned
 * was worse than a straight top-to-bottom pass: it jumped between sections and
 * skipped parts of the page. That failure cannot occur here, because the marker
 * advances monotonically through the document — every line is visited, in order,
 * by construction. But the camera has to follow it or the marker leaves frame.
 */
export function cameraTrack(
  steps: SweepStep[],
  frameHeight: number,
  pageHeight: number,
): CameraKey[] {
  const maxY = Math.max(0, pageHeight - frameHeight);
  const clamp = (y: number) => Math.min(maxY, Math.max(0, y));

  const keys: CameraKey[] = [];
  for (const step of steps) {
    const centre = (step.box.y0 + step.box.y1) / 2;
    const y = clamp(centre - frameHeight * MIDDLE);
    // Two keys per stroke: in place when it starts, in place when it ends. The
    // easing between strokes is the timeline's job, not this function's.
    keys.push({ t: step.start, y });
    keys.push({ t: step.end, y });
  }

  return keys;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/sweep.test.mts`
Expected: all six PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: sweep timing and a camera that follows the marker

Time is shared between strokes by word count, not evenly: a marker that
finishes a line while the voice is still reading it is the most obvious
way this effect looks fake."
```

---

### Task 15: The theme contract, the composition, and Marginalia

**Files:**
- Create: `src/lib/video/composition/theme-contract.ts`, `src/lib/video/composition/build.ts`, `src/lib/video/composition/themes/marginalia.ts`
- Test: `tests/composition.test.mts`

**Interfaces:**
- Consumes: `SweepStep`, `CameraKey`, `CaptionLine`, `Beat`.
- Produces:
  - `BookTheme` interface (below)
  - `buildComposition(input: CompositionInput): string` — a single self-contained HTML file
  - `CompositionInput { pkg; beats: BeatAudio[]; captions: CaptionLine[]; pages: { src: string; width: number; height: number }[]; sweeps: SweepStep[][]; camera: CameraKey[]; theme: BookTheme; totalDuration: number }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/composition.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { buildComposition } from "../src/lib/video/composition/build";
import { marginalia } from "../src/lib/video/composition/themes/marginalia";

const input = () => ({
  pkg: {
    title: "T", hook: "A hook.", ideaKey: "k", cta: "Follow.", description: "", hashtags: [], takeaway: [],
    beats: [
      { id: "hook", voiceover: "A hook.", onScreen: "Hook", sourcePage: 0, startWord: 0, endWord: 2 },
      { id: "cta", voiceover: "Follow.", onScreen: "Follow", sourcePage: 0, startWord: 3, endWord: 5 },
    ],
  },
  beats: [
    { index: 0, text: "A hook.", file: "b0.wav", start: 0, end: 2, speechStart: 0.1, speechEnd: 1.9 },
    { index: 1, text: "Follow.", file: "b1.wav", start: 2, end: 4, speechStart: 2.1, speechEnd: 3.9 },
  ],
  captions: [{ text: "A hook.", start: 0.1, end: 1.9, beatIndex: 0, words: [] }],
  pages: [{ src: "assets/page-00.jpg", width: 1000, height: 1400 }],
  sweeps: [
    [{ box: { x0: 0, y0: 0, x1: 500, y1: 40 }, start: 0.1, end: 1.9 }],
    [{ box: { x0: 0, y0: 60, x1: 500, y1: 100 }, start: 2.1, end: 3.9 }],
  ],
  camera: [{ t: 0, y: 0 }, { t: 4, y: 100 }],
  theme: marginalia,
  totalDuration: 4,
});

test("the composition is one self-contained file with a paused timeline", () => {
  const html = buildComposition(input());

  assert.ok(html.includes("<style"), "CSS is inline");
  assert.ok(!html.includes("<link rel=\"stylesheet\""), "nothing is fetched at render time");
  assert.match(html, /\.pause\(\)|paused:\s*true/, "the timeline must start paused — the renderer seeks it");
});

test("no CSS animation survives into the output", () => {
  const html = buildComposition(input());
  assert.doesNotMatch(html, /@keyframes|animation\s*:/, "seeking cannot reproduce a CSS animation's state");
});

test("nothing is random at render time", () => {
  const html = buildComposition(input());
  assert.doesNotMatch(html, /Math\.random/, "two renders of one frame must be identical");
});

test("every fromTo away from zero disables immediate render", () => {
  const html = buildComposition(input());
  const fromTos = html.match(/fromTo\(/g) ?? [];
  const guarded = html.match(/immediateRender:\s*false/g) ?? [];
  assert.ok(
    guarded.length >= fromTos.length,
    `${fromTos.length} fromTo calls but only ${guarded.length} immediateRender guards — a chain of them parks elements at the wrong offset`,
  );
});

test("a closing script tag in page text cannot end the embedded JSON early", () => {
  const evil = input();
  evil.pkg.beats[0].onScreen = "</script><b>gotcha";

  const html = buildComposition(evil);
  const payload = html.split("id=\"composition-data\"")[1] ?? "";
  assert.ok(!payload.slice(0, 4000).includes("</script><b>"), "'<' must be escaped inside embedded JSON");
});

test("the timeline runs at least as long as the audio", () => {
  const html = buildComposition(input());
  const match = html.match(/data-duration="([\d.]+)"/);
  assert.ok(match, "the duration is declared for the renderer");
  assert.ok(Number(match![1]) >= 4, "a composition shorter than its audio truncates the CTA");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/composition.test.mts`
Expected: FAIL — cannot find module `../src/lib/video/composition/build`.

- [ ] **Step 3: Write `src/lib/video/composition/theme-contract.ts`**

```typescript
export interface ThemePalette {
  paper: string;
  ink: string;
  marker: string;
  markerEdge: string;
  captionBg: string;
  captionInk: string;
  accent: string;
  vignette: string;
}

/**
 * Everything a theme is allowed to change. The highlight ENGINE — geometry,
 * timing, the camera — is shared, because it is the product. A theme changes how
 * it looks, never where or when the marker goes.
 */
export interface BookTheme {
  id: string;
  palette: ThemePalette;
  /** Music mood passed through to the ffmpeg bed generator. */
  mood: "calm" | "warm" | "driving" | "sparse";
  /** Extra CSS, appended after the shared rules. */
  css(): string;
  /** Markup layered behind the page — desk, texture, vignette. */
  backdrop(): string;
  /** Markup layered over the page — annotations, sticky notes, light pool. */
  overlay(): string;
  /** How one stroke is drawn. Must be a single scaleX tween, for seek-safety. */
  strokeMarkup(index: number): string;
}
```

- [ ] **Step 4: Write `src/lib/video/composition/themes/marginalia.ts`**

```typescript
import type { BookTheme } from "../theme-contract";

/**
 * The page as a student's copy: warm paper, a felt-tip yellow that bleeds
 * slightly past the words, and annotations in the margin.
 */
export const marginalia: BookTheme = {
  id: "marginalia",
  mood: "warm",
  palette: {
    paper: "#f6f1e4",
    ink: "#221d16",
    marker: "#ffe14d",
    markerEdge: "#f2c200",
    captionBg: "rgba(20,17,12,0.86)",
    captionInk: "#fdfaf2",
    accent: "#d9531e",
    vignette: "rgba(60,45,20,0.35)",
  },

  css: () => `
    .backdrop { background: radial-gradient(120% 80% at 50% 20%, #fbf7ec 0%, #e8dfc9 100%); }
    .grain { position:absolute; inset:0; opacity:.14; mix-blend-mode:multiply;
             background-image: radial-gradient(#8a7a58 1px, transparent 1px);
             background-size: 3px 3px; pointer-events:none; }
    .stroke { position:absolute; border-radius:3px; transform-origin:left center;
              background: linear-gradient(180deg, #ffe97a 0%, #ffe14d 55%, #f2c200 100%);
              mix-blend-mode: multiply; box-shadow: 0 0 6px 2px rgba(255,225,77,.45); }
    .annot { position:absolute; color:#d9531e; font-family: "Bradley Hand", "Segoe Script", cursive;
             font-size: 34px; transform: rotate(-4deg); }
    .vignette { position:absolute; inset:0; pointer-events:none;
                box-shadow: inset 0 0 220px 60px rgba(60,45,20,.35); }
  `,

  backdrop: () => `<div class="backdrop"></div><div class="grain"></div>`,
  overlay: () => `<div class="vignette"></div>`,

  // One element, one transform. The tween that drives it is a single scaleX,
  // which is the only shape a stroke may take: two tweens on one property are
  // order-dependent, and order does not survive a seek.
  strokeMarkup: (index: number) =>
    `<div class="stroke" data-stroke="${index}" style="transform: scaleX(0)"></div>`,
};
```

- [ ] **Step 5: Write `src/lib/video/composition/build.ts`**

The shared skeleton. It must satisfy every assertion in Step 1. Structure:

```typescript
import type { BookTheme } from "./theme-contract";
// ... other imports

/**
 * `<` is escaped inside the embedded JSON because a single `</script>` anywhere
 * in book text closes the tag early, GSAP never runs, and the render comes out
 * blank — a failure that looks like a renderer bug and is not.
 */
function embed(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function buildComposition(input: CompositionInput): string {
  const { theme, pages, sweeps, camera, captions, pkg, totalDuration } = input;
  const duration = totalDuration + OUTRO_TAIL;

  const data = embed({ sweeps, camera, captions, beats: pkg.beats, pageOffsets: offsetsFor(pages) });

  return `<div class="stage" data-duration="${duration.toFixed(3)}">
  ${theme.backdrop()}
  <div class="column" id="column">
    ${pages.map((p, i) => pageMarkup(p, i)).join("\n")}
    ${sweeps.flat().map((_, i) => theme.strokeMarkup(i)).join("\n")}
  </div>
  ${theme.overlay()}
  <div class="captions" id="captions"></div>
</div>
<style>${SHARED_CSS}${theme.css()}</style>
<script id="composition-data" type="application/json">${data}</script>
<script>${TIMELINE_JS}</script>`;
}
```

The timeline script must obey, in this order:

1. `const tl = gsap.timeline({ paused: true });` — the renderer seeks it.
2. Position every stroke absolutely from its `box` plus its page's offset in the column, then `gsap.set(el, { scaleX: 0 })` at time zero.
3. One tween per stroke: `tl.to(el, { scaleX: 1, duration: step.end - step.start, ease: "none" }, step.start)`. **One property, one tween, never overlapping.**
4. Camera: `tl.to(column, { y: -key.y, duration, ease: "power2.inOut" }, key.t)` for each key, skipping keys whose `y` equals the previous key's — a zero-distance tween on the same property at the same time is exactly the overlap that reads as a jump.
5. Captions: show and hide by `autoAlpha`, one `fromTo` per line with `immediateRender: false`, because none of them are at time zero.
6. An `OUTRO_TAIL` of 1.8 s after the last word, so the CTA card holds.

Constants at the top of the file:

```typescript
const AUDIO_OFFSET = 0.7;   // the page settles before the first word
const OUTRO_TAIL = 1.8;     // the CTA holds after the last word
const FRAME = { width: 1080, height: 1920 };
const FPS = 30;
```

- [ ] **Step 6: Run the tests**

```bash
node --import tsx --test tests/composition.test.mts
npm run typecheck
```

Expected: all six PASS. The `immediateRender` test is the one most likely to fail first — every `fromTo` that is not at time zero needs the guard.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: theme contract, shared composition and the Marginalia theme

The highlight engine is shared because it is the product; a theme
changes how the marker looks, never where or when it goes."
```

---

### Task 16: The seek-safety harness

**Build this before the full render, not after.** A frame-by-frame render of a composition that is not seek-safe produces artefacts that look like renderer bugs and are not.

**Files:**
- Create: `scripts/e2e-seek.mjs`

**Interfaces:**
- Consumes: `buildComposition`, `marginalia`, `playwright-core`.
- Produces: exit code 0 on success, 1 with a named mismatch on failure.

- [ ] **Step 1: Read the harness this one is modelled on**

```bash
sed -n '1,120p' /Users/vims/Desktop/Test/git-automation/scripts/e2e-intro.mjs
```

Keep its structure: launch Chromium from `playwright-core`, load the built HTML, drive the timeline through `window.__tl`, and compare **computed styles, not pixels**. Two identical states can rasterise a sub-pixel apart depending on compositing, and a check that fails on that is a check nobody will trust.

- [ ] **Step 2: Write the harness**

```javascript
// scripts/e2e-seek.mjs
import { chromium } from "playwright-core";
import { buildComposition } from "../src/lib/video/composition/build";
import { marginalia } from "../src/lib/video/composition/themes/marginalia";
import { fixtureInput } from "./fixtures/composition-fixture.mjs";

const TRACKED = ["transform", "opacity", "visibility", "width", "height", "left", "top"];

async function stateAt(page, t) {
  return page.evaluate(
    ({ t, props }) => {
      window.__tl.pause(t);
      const out = {};
      for (const el of document.querySelectorAll("[data-stroke], .caption, #column")) {
        const cs = getComputedStyle(el);
        const key = el.dataset.stroke ?? el.className ?? el.id;
        out[key] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
      }
      return out;
    },
    { t, props: TRACKED },
  );
}

const html = buildComposition(fixtureInput({ theme: marginalia }));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.setContent(`<!doctype html><body>${html}</body>`);
await page.waitForFunction(() => !!window.__tl);

const duration = await page.evaluate(() => window.__tl.duration());
const samples = Array.from({ length: 24 }, (_, i) => (duration * (i + 0.5)) / 24);

let failures = 0;
for (const t of samples) {
  const first = await stateAt(page, t);
  // Seek away in both directions, then back. The bug this catches is GSAP
  // reverting a fromTo to a different from-state after a backward seek.
  await stateAt(page, Math.min(duration, t + duration * 0.4));
  await stateAt(page, Math.max(0, t - duration * 0.4));
  const again = await stateAt(page, t);

  for (const key of Object.keys(first)) {
    for (const prop of TRACKED) {
      if (first[key][prop] !== again[key][prop]) {
        failures++;
        console.error(
          `NOT SEEK-SAFE at t=${t.toFixed(3)}s — ${key}.${prop}: "${first[key][prop]}" then "${again[key][prop]}"`,
        );
      }
    }
  }
}

await browser.close();

if (failures) {
  console.error(`\n${failures} state mismatches. The same timestamp renders two different frames.`);
  process.exit(1);
}
console.log(`Seek-safe across ${samples.length} timestamps.`);
```

- [ ] **Step 3: Write the fixture**

`scripts/fixtures/composition-fixture.mjs` exports `fixtureInput({ theme })` returning the same shape `tests/composition.test.mts` builds, but with three pages, six beats and sweeps spanning two pages — enough that the camera actually moves and strokes exist on more than one page.

- [ ] **Step 4: Expose the timeline for the harness**

In `build.ts`'s timeline script, assign the timeline to `window.__tl` after construction. The renderer needs a handle on it too, so this is not test-only scaffolding.

- [ ] **Step 5: Run it**

Run: `npm run e2e:seek`
Expected: `Seek-safe across 24 timestamps.` and exit 0.

If it fails, the cause is almost always one of: a `fromTo` without `immediateRender: false`, two tweens touching one property at the same time, or a CSS transition left on an element. Fix the composition, not the harness.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: seek-safety harness comparing computed styles across seeks

Built before the renderer on purpose: artefacts from a non-seek-safe
composition look like renderer bugs and are not."
```

---

### Task 17: The highlight-accuracy harness

Does the yellow actually land on the words?

**Files:**
- Create: `scripts/e2e-highlight.mjs`, `tests/fixtures/page-fixture.json`

**Interfaces:**
- Produces: exit code 0 when every sampled stroke overlaps its target word boxes by ≥90% of their area.

- [ ] **Step 1: Build the fixture**

Render a synthetic "page" with `sharp` from an SVG containing 12 known words at known coordinates, and save both the PNG and the ground-truth boxes to `tests/fixtures/`. A synthetic page rather than a photograph, because the ground truth has to be exact for the assertion to mean anything — the real-photograph check is Step 4.

- [ ] **Step 2: Write the harness**

```javascript
// scripts/e2e-highlight.mjs
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { measurePage } from "../src/lib/ingest/ocr";
import { alignWords } from "../src/lib/ingest/align";
import { clusterLineRuns } from "../src/lib/ingest/lines";
import { sweepForBeat } from "../src/lib/video/sweep";

const OVERLAP_FLOOR = 0.9;

const truth = JSON.parse(await readFile("tests/fixtures/page-fixture.json", "utf8"));
const ocr = await measurePage("tests/fixtures/page-fixture.png");
const { aligned, confidence } = alignWords(truth.words, ocr);
console.log(`alignment confidence ${(confidence * 100).toFixed(1)}%`);

const lines = clusterLineRuns(aligned);
const steps = sweepForBeat(lines, 3, 7, 0, 4);
if (steps.length === 0) {
  console.error("No sweep produced for a range that has geometry.");
  process.exit(1);
}

// Overlap is checked in page coordinates, not by reading pixels off a frame:
// geometry is what the assertion is about, and a pixel check would fail on
// antialiasing that no viewer could see.
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const intersect = (a, b) => ({
  x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
});

let worst = 1;
for (let w = 3; w <= 7; w++) {
  const target = truth.boxes[w];
  const covered = steps.reduce((sum, s) => sum + area(intersect(s.box, target)), 0);
  const ratio = covered / area(target);
  worst = Math.min(worst, ratio);
  if (ratio < OVERLAP_FLOOR) console.error(`word ${w} ("${truth.words[w]}") only ${(ratio * 100).toFixed(1)}% covered`);
}

if (worst < OVERLAP_FLOOR) {
  console.error(`\nWorst coverage ${(worst * 100).toFixed(1)}%, floor is ${OVERLAP_FLOOR * 100}%.`);
  process.exit(1);
}
console.log(`Every targeted word at least ${(worst * 100).toFixed(1)}% covered.`);
```

- [ ] **Step 3: Run it**

Run: `npm run e2e:highlight`
Expected: exit 0 with coverage above 90%.

- [ ] **Step 4: Check it against a real photograph, and look at the result**

Photograph a real page, run ingest on it, build a one-beat composition, and screenshot a frame mid-sweep:

```bash
node --import tsx scripts/shoot-frame.mjs /tmp/page.jpg 1.5 /tmp/frame.png
open /tmp/frame.png
```

Write `scripts/shoot-frame.mjs` for this — it runs the ingest chain on one photograph, builds the composition with a single synthetic beat covering words 0–20, seeks to the given timestamp and screenshots.

**Look at the picture.** The synthetic fixture proves the maths; only your eyes prove it works on a curved page under a lamp. If the marker is consistently offset in one direction, the cause is `deriveForComposition` scaling geometry that was measured on the full-resolution original — the boxes need scaling by the same factor, and that is a real bug this step exists to catch.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: highlight-accuracy harness with a 90% coverage floor

Geometry, not pixels: a pixel check fails on antialiasing no viewer
could see, and a check nobody trusts is a check nobody runs."
```

---

### Task 18: The pipeline and the rail

Wire it all together and produce a video.

**Files:**
- Create: `src/lib/pipeline.ts`, `src/app/api/uploads/[id]/ingest/route.ts`, `src/app/api/episodes/[id]/route.ts`, `src/app/api/episodes/[id]/video/route.ts`
- Modify: `src/components/PipelineRail.tsx`, `src/components/Studio.tsx`
- Test: `tests/pipeline-steps.test.mts`

**Interfaces:**
- Produces: `runIngest(uploadId: string): Promise<string[]>` returning created episode ids; `runEpisode(episodeId: string): Promise<void>`; `INGEST_STEPS: string[]`; `EPISODE_STEPS: string[]`.

- [ ] **Step 1: Write the failing test**

This is the test that stops the rail trap recurring.

```typescript
// tests/pipeline-steps.test.mts
import test from "node:test";
import assert from "node:assert/strict";
import { INGEST_STEPS, EPISODE_STEPS } from "../src/lib/pipeline";
import { STEPS } from "../src/components/PipelineRail";

test("every pipeline stage is known to the rail", () => {
  const known = new Set(STEPS);
  const missing = [...INGEST_STEPS, ...EPISODE_STEPS].filter((s) => !known.has(s));

  assert.deepEqual(
    missing,
    [],
    `the rail does not know ${missing.join(", ")} — findIndex returns -1 and the rail renders as though nothing has started`,
  );
});

test("the rail lists no stage the pipeline never runs", () => {
  const real = new Set([...INGEST_STEPS, ...EPISODE_STEPS]);
  const phantom = STEPS.filter((s) => !real.has(s));
  assert.deepEqual(phantom, [], `the rail waits forever on ${phantom.join(", ")}`);
});

test("the stages are in pipeline order in the rail", () => {
  const ordered = [...INGEST_STEPS, ...EPISODE_STEPS];
  assert.deepEqual(STEPS, ordered, "the rail's order is the order the operator watches");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test tests/pipeline-steps.test.mts`
Expected: FAIL — cannot find module `../src/lib/pipeline`.

- [ ] **Step 3: Write `src/lib/pipeline.ts`**

```typescript
export const INGEST_STEPS = [
  "Reading the pages",
  "Measuring the pages",
  "Aligning text to geometry",
  "Identifying the book",
  "Planning the episodes",
] as const;

export const EPISODE_STEPS = [
  "Reserving the idea",
  "Writing the script",
  "Grounding check",
  "Preparing page assets",
  "Recording the voiceover",
  "Timing the captions",
  "Building the composition",
  "Checking the composition",
  "Rendering the video",
] as const;
```

`runIngest(uploadId)` then:

1. **Reading the pages** and **Measuring the pages** run **concurrently**, not in sequence — they are independent, and only alignment needs both. Pages are processed with a concurrency cap of 4:

```typescript
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const [texts, boxes] = await Promise.all([
  mapLimit(pages, 4, (p) => readPage(p.filePath, p.pageIndex, provider, model)),
  mapLimit(pages, 4, (p) => measurePage(p.filePath)),
]);
```

2. **Aligning** — per page: `alignWords`, then `clusterLineRuns`, then `inheritBoxes`. Store `alignment` and `alignmentConfidence`. A page below `ALIGNMENT_FLOOR` is recorded as a note and will highlight by block; it does not fail the run.
3. **Identifying the book** — `lookupBook`, then `resolveAuthor`. Both non-fatal: on failure the title stands and the author is absent with the reason recorded.
4. **Planning the episodes** — model call, then `validatePlan`. On failure fall back to the single whole-upload plan. Create one `Episode` row per plan entry.

`runEpisode(episodeId)` follows `EPISODE_STEPS` in order, with the failure policy from spec §4. The ordering rules that must not be reordered:

- The grounding check gates the voiceover — nothing is spoken until the script passes.
- Captions are timed from measured audio, never from a words-per-minute estimate.
- Sweeps are computed from `beats[i].speechStart` / `speechEnd`, which only exist after the voiceover is recorded.

`POST /api/uploads/[id]/ingest` fires `void runIngest(id).catch(() => {})` and returns immediately; the client polls `GET /api/episodes/[id]` every 1.5 s. Long work never blocks a request.

- [ ] **Step 4: Update the rail in the same commit**

```typescript
// src/components/PipelineRail.tsx
import { INGEST_STEPS, EPISODE_STEPS } from "@/lib/pipeline";

export const STEPS = [...INGEST_STEPS, ...EPISODE_STEPS];
```

Deriving `STEPS` from the pipeline rather than restating it is what makes the trap structurally impossible rather than merely tested. Keep the test anyway — it catches a future author who reintroduces a literal array.

- [ ] **Step 5: Copy the video route**

Copy `src/app/api/creations/[id]/video/route.ts` from the source tree to `src/app/api/episodes/[id]/video/route.ts`, changing `prisma.creation` to `prisma.episode`. Keep its range-request handling exactly — a browser will not scrub a video served without it.

- [ ] **Step 6: Run everything**

```bash
node --import tsx --test tests/pipeline-steps.test.mts
npm test
npm run typecheck
npm run e2e:seek
```

Expected: all pass.

- [ ] **Step 7: Run the real thing**

```bash
npm run dev
```

Upload three photographs of one book's pages, ingest, and watch the rail. Then open the finished episode and **watch the video**.

Check, with your eyes, not with an assertion: does the marker land on the words being spoken? Does the camera follow it without lurching? Does the CTA card hold, with sound? Is any caption cut off at the frame edge?

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: ingest and episode pipelines, with the rail derived from them

Vision and OCR run concurrently — they are independent and only alignment
needs both. STEPS is derived from the pipeline rather than restated, which
makes the -1 findIndex trap structurally impossible."
```

---

### Task 19: The audio-tail and performance harnesses

Two measurements that turn spec §14's numbers into gates.

**Files:**
- Create: `scripts/e2e-audio-tail.mjs`, `scripts/e2e-budget.mjs`

**Interfaces:**
- Produces: exit 0 when the final second of a render carries audio energy, and when a reference run completes inside four minutes.

- [ ] **Step 1: Write the audio-tail harness**

This is spec §10's fix for the inherited defect — the CTA card, the most valuable frame in the video, currently plays in silence.

```javascript
// scripts/e2e-audio-tail.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const video = process.argv[2];
if (!video) {
  console.error("usage: npm run e2e:audio-tail -- <path-to-mp4>");
  process.exit(2);
}

const FFMPEG = process.env.FFMPEG_PATH || "tools/bin/ffmpeg";

const { stdout: durOut } = await exec("tools/bin/ffprobe", [
  "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video,
]);
const duration = Number(durOut.trim());

// Measure the mean volume of the last 1.2 seconds only.
const { stderr } = await exec(FFMPEG, [
  "-v", "info",
  "-ss", String(Math.max(0, duration - 1.2)),
  "-i", video,
  "-af", "volumedetect",
  "-f", "null", "-",
]);

const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? "-999");
console.log(`last 1.2s mean volume: ${mean} dB (duration ${duration.toFixed(2)}s)`);

// Digital silence reads as -91 dB. Anything above -60 is real signal.
if (mean < -60) {
  console.error("The tail of the render is silent — the CTA card plays with no sound.");
  console.error("Pad the voiceover and extend the timeline rather than chasing it into the renderer.");
  process.exit(1);
}
console.log("The tail carries audio.");
```

- [ ] **Step 2: Write the performance harness**

```javascript
// scripts/e2e-budget.mjs
import { prisma } from "../src/lib/db";
import { runIngest, runEpisode } from "../src/lib/pipeline";

const BUDGET_MS = 4 * 60_000;
const uploadId = process.argv[2];
if (!uploadId) {
  console.error("usage: npm run e2e:budget -- <uploadId with 6 pages>");
  process.exit(2);
}

const t0 = Date.now();
const episodeIds = await runIngest(uploadId);
const ingestMs = Date.now() - t0;

const t1 = Date.now();
await runEpisode(episodeIds[0]);
const episodeMs = Date.now() - t1;
const totalMs = Date.now() - t0;

const steps = await prisma.stepRun.findMany({
  where: { episodeId: episodeIds[0] },
  orderBy: { position: "asc" },
});
for (const s of steps) console.log(`  ${String(s.durationMs).padStart(7)}ms  ${s.step}`);
console.log(`\ningest ${ingestMs}ms | episode ${episodeMs}ms | total ${totalMs}ms | budget ${BUDGET_MS}ms`);

if (totalMs > BUDGET_MS) {
  console.error(`\nOver budget by ${((totalMs - BUDGET_MS) / 1000).toFixed(1)}s.`);
  console.error("The per-step table above says where. Revise the budget deliberately or fix the stage.");
  process.exit(1);
}
console.log("Within budget.");
```

- [ ] **Step 3: Run both against a real render**

```bash
npm run e2e:budget -- <uploadId>
npm run e2e:audio-tail -- .bookreel/renders/<episodeId>.mp4
```

Expected: both exit 0. If the audio tail fails, apply the fix its own message names — pad the voiceover with silence and extend the composition duration to match — and re-run.

If the budget fails, read the per-step table before changing anything. The likely offenders in order: OCR (swap `tesseract.js` for a native binary behind `OcrEngine`), the render (confirm hardware encoding is actually being used), and the vision calls (confirm they really are running in parallel with the OCR pass).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: audio-tail and performance-budget harnesses

The audio-tail check fixes an inherited defect rather than carrying it:
the CTA card is the most valuable frame and it was playing in silence."
```

---

## Milestone one is complete when

- `npm test` passes: 40+ unit tests across validation, alignment, line runs, sweep timing, the author chain, the quotation budget, episode planning, composition safety and rail coverage.
- `npm run e2e:seek` reports seek-safe across 24 timestamps.
- `npm run e2e:highlight` reports every targeted word at least 90% covered.
- `npm run e2e:budget` completes a 6-page reference run in under four minutes.
- `npm run e2e:audio-tail` finds audio in the final second.
- You have uploaded real photographs of a real book and **watched the finished video**, and the marker lands on the words being spoken.

The last one is the only one that matters. The rest exist to make it repeatable.

## What comes next

Milestone two: the remaining three themes (Spotlight, Study Desk, Torn Page) against the theme contract, plus thumbnails in both aspect ratios.

Milestone three: the publish layer copied and adapted from RepoReel — `lib/publish/**` and `lib/docs/**`, which this milestone deliberately left behind — the takeaway sheet, the schedule queue and the approval window.
