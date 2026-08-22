import path from "node:path";
import sharp from "sharp";
import { prisma, getSetting } from "./db";
import { WORK_ROOT, RENDER_DIR } from "./paths";
import { IngestFailed } from "./errors";
import { StepTimer } from "./step-timer";
import { readPage, wordsOf, type PageText } from "./ingest/vision";
import { measurePage, disposeOcr, type OcrWord } from "./ingest/ocr";
import { alignWords, ALIGNMENT_FLOOR, type AlignedWord } from "./ingest/align";
import { buildLineRuns, clusterLineRuns } from "./ingest/lines";
import { lookupBook, resolveAuthor } from "./ingest/identity";
import { validatePlan, type EpisodePlan } from "./ingest/plan-episodes";
import { generateContent, beatTexts, voScriptFromPackage, type Archetype } from "./content";
import { releaseIdea } from "./content/idea";
import { runCliJson } from "./content/cli-provider";
import { numberedWordLines } from "./content/prompt";
import type { CliProvider } from "./content/cli";
import type { RightsStatus } from "./content/quotation";
import { synthesizeVoiceover } from "./media/tts";
import { generateMusicBed } from "./media/ffmpeg";
import { buildCaptions, toSrt } from "./media/captions";
import { sweepForBeat, cameraTrack, type SweepStep } from "./video/sweep";
import { buildComposition, FRAME, AUDIO_OFFSET, OUTRO_TAIL } from "./video/composition/build";
import { marginalia } from "./video/composition/themes/marginalia";
import { writeProject, checkProject, renderProject } from "./video/render";
import type { BookTheme } from "./video/composition/theme-contract";

/**
 * `BookTheme.mood` and `generateMusicBed`'s `style` option come from two
 * different vocabularies — the theme contract names a *feeling*, the bed
 * generator names a specific chord progression (see `MUSIC_MOODS` in
 * `media/ffmpeg.ts`). This is the one place that translates between them.
 * `editorial` for `warm` is not an arbitrary pick: its own doc comment reads
 * "Warm paper, magazine feature" — Marginalia's palette, in one sentence.
 */
const MOOD_TO_STYLE: Record<BookTheme["mood"], string> = {
  warm: "editorial",
  calm: "blueprint",
  driving: "spotlight",
  sparse: "terminal",
};

/**
 * Re-exported from `./pipeline-steps`, which is the actual source of truth.
 * That module has zero imports; this one imports sharp, Prisma, ffmpeg, the
 * CLI spawner, etc., so `PipelineRail.tsx` (a `"use client"` component) must
 * import the step names from `./pipeline-steps` directly, never from here —
 * importing this module from client code drags all of the above into the
 * browser bundle, where `child_process` (among others) cannot resolve.
 */
export { INGEST_STEPS, EPISODE_STEPS } from "./pipeline-steps";
import { INGEST_STEPS, EPISODE_STEPS } from "./pipeline-steps";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Vision and OCR
 * are independent per-page work, so a straight `Promise.all` over every page
 * would open one CLI process and one OCR job per page simultaneously — fine
 * for three pages, a self-inflicted denial of service for twenty.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Which CLI provider drives content generation (writing, grounding, planning,
 * the author guess). Vision is exempt from this setting — `readPage` only
 * works with the Claude Code CLI (see `cli-vision.ts`), so it is always called
 * with `"claude-cli"` regardless of what the operator has chosen here.
 */
async function contentProvider(): Promise<CliProvider> {
  const v = await getSetting("cliProvider");
  return v === "codex-cli" ? "codex-cli" : "claude-cli";
}

async function cliModel(): Promise<string | undefined> {
  return (await getSetting("cliModel")) || undefined;
}

// --- Identity: the two model calls `resolveAuthor` needs beyond the catalogue ---

const AUTHOR_GUESS_SCHEMA = {
  type: "object",
  required: ["author"],
  additionalProperties: false,
  properties: { author: { type: ["string", "null"] } },
} as const;

/**
 * An independent reading of who wrote this book, from the same page text
 * vision already transcribed — never from the catalogue, which is checked
 * separately in `resolveAuthor`. Best-effort: any failure here (a CLI outage,
 * an unparseable reply) is swallowed and reported as "no guess", the same as
 * a title page that genuinely never names an author. See `resolveAuthor` for
 * why an absent guess is treated as an unverified author, not a placeholder.
 */
async function guessAuthor(
  pages: PageText[],
  provider: CliProvider,
  model?: string,
): Promise<string | null> {
  try {
    const sample = pages
      .slice(0, 3)
      .map((p) => [p.chapterHeading, ...p.paragraphs].filter(Boolean).join("\n"))
      .join("\n\n")
      .slice(0, 4000);
    if (!sample.trim()) return null;

    const system =
      "You read the first pages of a photographed book and report who wrote it, ONLY if a title page, " +
      "byline or copyright page on these pages actually states it. If it is not clearly stated, answer " +
      "null. Never guess from writing style or subject matter.";
    const { author } = await runCliJson<{ author: string | null }>(
      provider,
      system,
      `Pages:\n\n${sample}`,
      AUTHOR_GUESS_SCHEMA,
      model,
    );
    return typeof author === "string" && author.trim() ? author.trim() : null;
  } catch {
    return null;
  }
}

const AUTHOR_CONFIRM_SCHEMA = {
  type: "object",
  required: ["confirmed"],
  additionalProperties: false,
  properties: { confirmed: { type: "boolean" } },
} as const;

/**
 * A SEPARATE, adversarial pass over the same page text — the same shape as the
 * grounding checker in `content/verify.ts`: a model given a claim and told to
 * find reasons to reject it produces a more trustworthy answer than asking the
 * same context that made the claim to grade itself. Best-effort like
 * `guessAuthor` above: any failure here reads as "not confirmed", which is the
 * safe default for `resolveAuthor` — an unconfirmed guess never reveals a name.
 */
async function confirmAuthor(
  candidate: string,
  pages: PageText[],
  provider: CliProvider,
  model?: string,
): Promise<boolean> {
  try {
    const sample = pages
      .slice(0, 3)
      .map((p) => [p.chapterHeading, ...p.paragraphs].filter(Boolean).join("\n"))
      .join("\n\n")
      .slice(0, 4000);

    const system =
      "You are an adversarial checker. You did not make the claim below and have no stake in it holding up. " +
      "Given the page text, decide whether these pages truly state that the named person wrote this book — " +
      "not merely that the name sounds plausible. Answer false on any doubt.";
    const { confirmed } = await runCliJson<{ confirmed: boolean }>(
      provider,
      system,
      `Candidate author: ${candidate}\n\nPages:\n\n${sample}`,
      AUTHOR_CONFIRM_SCHEMA,
      model,
    );
    return confirmed === true;
  } catch {
    return false;
  }
}

// --- Planning: segment the upload into one or more single-idea episodes ---

const PLAN_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["ideaKey", "title", "startPage", "endPage", "startWord", "endWord"],
    additionalProperties: false,
    properties: {
      ideaKey: { type: "string" },
      title: { type: "string" },
      startPage: { type: "integer" },
      endPage: { type: "integer" },
      startWord: { type: "integer" },
      endWord: { type: "integer" },
    },
  },
} as const;

const PLAN_SYSTEM = `You split a photographed batch of book pages into one or more short-form video episodes, each covering a single, distinct idea from the pages.

Rules:
- Prefer ONE episode covering the whole batch unless the pages clearly contain more than one genuinely separate, video-worthy idea.
- Every episode needs a unique, kebab-case ideaKey naming its angle (lowercase letters, digits and hyphens only).
- startPage/endPage are the page numbers (labelled "PAGE n") the episode covers; startWord/endWord are word indices on those pages, using the exact numbers shown.
- Episodes must not overlap, and together should not skip meaningful content.
- If in doubt, return a single episode covering every page from 0 to the last page shown.`;

function buildPlanPrompt(
  bookTitle: string,
  pages: { pageIndex: number; chapterHeading: string | null; words: string[] }[],
): string {
  const body = pages
    .map((p) => {
      const heading = p.chapterHeading ? `Heading: ${p.chapterHeading}\n` : "";
      return `--- PAGE ${p.pageIndex} ---\n${heading}${numberedWordLines(p.words)}`;
    })
    .join("\n\n");
  return `Book: ${bookTitle}\n\n${body}`;
}

// --- runIngest ---------------------------------------------------------------

/**
 * Turns one uploaded batch of photographs into one or more `Episode` rows,
 * ready for `runEpisode`. Every step here is recorded on the `Upload` row
 * (there is no `Episode` yet for most of it) so the rail has something to show
 * before a single episode exists.
 *
 * Reading and measuring run CONCURRENTLY — they are independent, and only
 * alignment needs both (binding decision #2). Reading a page (vision) is
 * FATAL on failure; everything else in this function is non-fatal and is
 * recorded as a note instead (binding decision #5).
 */
export async function runIngest(uploadId: string): Promise<string[]> {
  const upload = await prisma.upload.findUniqueOrThrow({
    where: { id: uploadId },
    include: { book: true, pages: { orderBy: { pageIndex: "asc" } } },
  });

  const visionProvider: CliProvider = "claude-cli";
  const provider = await contentProvider();
  const model = await cliModel();
  const notes: string[] = [];

  try {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: "RUNNING", step: INGEST_STEPS[0], error: null },
    });

    // 1 & 2: Reading and measuring run concurrently — see the doc comment
    // above. Both start under the same `Reading the pages` step name since
    // neither is done yet. The moment vision (reading) finishes, the step is
    // advanced to `Measuring the pages` even though OCR may still be running
    // — vision has a proven, fast path (the CLI), while OCR is the one doing
    // real, sometimes-slow work (and the one `measurePage`'s own hard
    // timeout below exists to bound). Without this, an operator watching a
    // stalled OCR pass sees the misleading "Reading the pages" and has no
    // way to tell which of the two concurrent jobs is actually stuck.
    const visionJob = mapLimit(upload.pages, 4, async (p) => {
      if (!p.derivedPath) {
        throw new IngestFailed(
          `Page ${p.pageIndex + 1} has no derived image; re-upload this photograph.`,
        );
      }
      const text = await readPage(p.derivedPath, p.pageIndex, visionProvider, model);
      await prisma.page.update({ where: { id: p.id }, data: { visionText: JSON.stringify(text) } });
      return text;
    });
    // Best-effort: if this update loses a race with the upload being deleted,
    // or the DB hiccups, that must never fail (or delay) the real ingest.
    void visionJob
      .then(() => prisma.upload.update({ where: { id: uploadId }, data: { step: INGEST_STEPS[1] } }))
      .catch(() => {});

    const [texts, boxesList] = await Promise.all([
      visionJob,
      mapLimit(upload.pages, 4, async (p): Promise<OcrWord[]> => {
        try {
          if (!p.derivedPath) return [];
          const boxes = await measurePage(p.derivedPath);
          await prisma.page.update({ where: { id: p.id }, data: { ocrBoxes: JSON.stringify(boxes) } });
          return boxes;
        } catch (err) {
          notes.push(
            `Page ${p.pageIndex + 1}: OCR measurement failed (${message(err)}) — this page highlights by block instead of by word.`,
          );
          return [];
        }
      }),
    ]);

    // 3: Aligning text to geometry.
    await prisma.upload.update({ where: { id: uploadId }, data: { step: INGEST_STEPS[2] } });
    for (let i = 0; i < upload.pages.length; i++) {
      const page = upload.pages[i];
      const visionWords = wordsOf(texts[i]);
      const { aligned, confidence } = alignWords(visionWords, boxesList[i]);
      const { words } = buildLineRuns(aligned);
      await prisma.page.update({
        where: { id: page.id },
        data: { alignment: JSON.stringify(words), alignmentConfidence: confidence },
      });
      if (confidence < ALIGNMENT_FLOOR) {
        notes.push(
          `Page ${page.pageIndex + 1}: alignment confidence ${Math.round(confidence * 100)}% is below the reliable threshold — this page highlights by block instead of by word.`,
        );
      }
    }

    // 4: Identifying the book. Every link is non-fatal — a broken catalogue
    // lookup, a silent model, a declined adversarial pass all leave the title
    // standing on its own and simply omit the author (see `resolveAuthor`).
    await prisma.upload.update({ where: { id: uploadId }, data: { step: INGEST_STEPS[3] } });
    try {
      const identity = await lookupBook(upload.book.title);
      const modelGuess = await guessAuthor(texts, provider, model);
      const adversarialConfirmed = modelGuess
        ? await confirmAuthor(modelGuess, texts, provider, model)
        : false;
      const resolved = resolveAuthor({ works: identity.works, modelGuess, adversarialConfirmed });

      await prisma.book.update({
        where: { id: upload.book.id },
        data: {
          openLibraryId: identity.openLibraryId,
          year: identity.year,
          subjects: JSON.stringify(identity.subjects),
          author: resolved.author,
          authorVerified: resolved.verified,
          authorOmissionReason: resolved.reason,
        },
      });
    } catch (err) {
      notes.push(`Identifying the book failed (${message(err)}) — continuing with no verified author.`);
    }

    // 5: Planning the episodes.
    await prisma.upload.update({ where: { id: uploadId }, data: { step: INGEST_STEPS[4] } });
    const wordsPerPage = texts.map((t) => wordsOf(t).length);
    let rawPlan: EpisodePlan[] = [];
    try {
      const planPages = texts.map((t) => ({
        pageIndex: t.pageIndex,
        chapterHeading: t.chapterHeading,
        words: wordsOf(t),
      }));
      rawPlan = await runCliJson<EpisodePlan[]>(
        provider,
        PLAN_SYSTEM,
        buildPlanPrompt(upload.book.title, planPages),
        PLAN_SCHEMA,
        model,
      );
    } catch (err) {
      notes.push(
        `Episode planning failed (${message(err)}) — falling back to one episode covering the whole upload.`,
      );
      rawPlan = [];
    }
    // validatePlan guarantees at least one usable episode even from `[]` — the
    // whole-upload fallback IS the planner-failure recovery path.
    const plan = validatePlan(rawPlan, upload.pages.length, wordsPerPage);

    const episodeIds: string[] = [];
    for (let i = 0; i < plan.length; i++) {
      const ep = plan[i];
      const created = await prisma.episode.create({
        data: {
          bookId: upload.book.id,
          uploadId: upload.id,
          userId: upload.userId,
          partNumber: i + 1,
          seriesTotal: plan.length,
          theme: "marginalia",
          ideaKey: ep.ideaKey,
          title: ep.title,
          status: "QUEUED",
          step: "Queued",
          notes: notes.length ? JSON.stringify(notes) : null,
          visualPlan: JSON.stringify({
            startPage: ep.startPage,
            endPage: ep.endPage,
            startWord: ep.startWord,
            endWord: ep.endWord,
          }),
        },
      });
      episodeIds.push(created.id);
    }

    await prisma.upload.update({ where: { id: uploadId }, data: { status: "DONE", step: "Done" } });
    return episodeIds;
  } catch (err) {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: "FAILED", step: "Failed", error: message(err) },
    });
    throw err;
  } finally {
    // A live tesseract.js worker holds the Node event loop open — see the doc
    // comment on `disposeOcr`. Called unconditionally, success or failure.
    await disposeOcr().catch(() => {});
  }
}

// --- runEpisode ----------------------------------------------------------------

interface PlanRange {
  startPage: number;
  endPage: number;
  startWord: number;
  endWord: number;
}

/** Cumulative top offset of each page inside the composition's one scrolling
 *  column — mirrors `build.ts`'s own private `offsetsFor`, which is not
 *  exported: the camera track this function feeds must be computed in the
 *  same column space `buildComposition` lays pages out in. */
function columnOffsets(pages: { height: number }[]): number[] {
  const offsets: number[] = [];
  let y = 0;
  for (const p of pages) {
    offsets.push(y);
    y += p.height;
  }
  return offsets;
}

/**
 * Runs one episode through `EPISODE_STEPS` in order. The ordering rules that
 * must not be reordered (spec): the grounding check gates the voiceover —
 * nothing is spoken until the script passes; captions are timed from measured
 * audio, never estimated; sweeps use the real `speechStart`/`speechEnd`, which
 * only exist after the voiceover is recorded.
 */
export async function runEpisode(episodeId: string): Promise<void> {
  const episode = await prisma.episode.findUniqueOrThrow({
    where: { id: episodeId },
    include: { book: true, upload: { include: { pages: { orderBy: { pageIndex: "asc" } } } } },
  });

  const timer = new StepTimer(episodeId);
  await timer.begin();

  const provider = await contentProvider();
  const model = await cliModel();

  // `visualPlan` is set at creation time in `runIngest` to exactly this shape
  // (see there); the fallback below only guards against a row created by some
  // other path, so this episode still covers *something* rather than nothing.
  const range: PlanRange = episode.visualPlan
    ? (JSON.parse(episode.visualPlan) as PlanRange)
    : { startPage: 0, endPage: Math.max(0, episode.upload.pages.length - 1), startWord: 0, endWord: 0 };

  const pages = episode.upload.pages.filter(
    (p) => p.pageIndex >= range.startPage && p.pageIndex <= range.endPage,
  );

  const fail = async (err: unknown) => {
    await timer.fail();
    await prisma.episode.update({
      where: { id: episodeId },
      data: { status: "FAILED", error: message(err) },
    });
  };

  // Phase 1: write, ground-check and revise the script. Fatal on failure — a
  // rejected grounding verdict, an exceeded quotation budget, or a CLI failure
  // all propagate out here. `generateContent` reserves the idea itself and
  // releases it on every one of its own failure paths, so nothing further is
  // needed on this branch (binding decision #6 covers everything AFTER it
  // succeeds, in the second try block below).
  let pkg: Awaited<ReturnType<typeof generateContent>>["pkg"];
  let report: Awaited<ReturnType<typeof generateContent>>["report"];
  let revised: boolean;
  try {
    const genPages = pages.map((p) => {
      const vt = p.visionText ? (JSON.parse(p.visionText) as PageText) : null;
      return {
        pageIndex: p.pageIndex,
        chapterHeading: vt?.chapterHeading ?? null,
        words: vt ? wordsOf(vt) : [],
      };
    });

    await timer.start(EPISODE_STEPS[0]); // Reserving the idea
    const result = await generateContent({
      bookId: episode.bookId,
      bookTitle: episode.book.title,
      author: episode.book.authorVerified ? episode.book.author : null,
      authorVerified: episode.book.authorVerified,
      archetype: episode.book.archetype as Archetype,
      rightsStatus: episode.book.rightsStatus as RightsStatus,
      ideaKey: episode.ideaKey ?? episode.id,
      pages: genPages,
      provider,
      model,
      onStep: async (step) => {
        if (/checking/i.test(step)) await timer.start(EPISODE_STEPS[2]); // Grounding check
        else if (/rewriting/i.test(step)) await timer.start(EPISODE_STEPS[1]); // Writing the script
      },
    });
    pkg = result.pkg;
    report = result.report;
    revised = result.revised;
  } catch (err) {
    await fail(err);
    throw err;
  }

  // Phase 2: everything from here needs a video to count as a success. Any
  // failure in this block must release the idea reservation the phase above
  // just earned (binding decision #6) — `releaseIdea` is idempotent, so this
  // is safe even alongside a path above that already released it.
  try {
    await prisma.episode.update({
      where: { id: episodeId },
      data: {
        title: pkg.title,
        hook: pkg.hook,
        script: JSON.stringify(pkg.beats),
        voScript: voScriptFromPackage(pkg),
        description: pkg.description,
        hashtags: JSON.stringify(pkg.hashtags),
        cta: pkg.cta,
        verification: report ? JSON.stringify(report) : null,
        groundedness: report?.groundedness ?? null,
        revised,
      },
    });

    await timer.start(EPISODE_STEPS[3]); // Preparing page assets
    const compPages = await Promise.all(
      pages.map(async (p) => {
        const derivedPath = p.derivedPath ?? p.filePath;
        const meta = await sharp(derivedPath).metadata();
        return {
          pageId: p.id,
          pageIndex: p.pageIndex,
          src: `assets/${path.basename(derivedPath)}`,
          from: derivedPath,
          to: path.basename(derivedPath),
          width: meta.width ?? p.width,
          height: meta.height ?? p.height,
        };
      }),
    );

    await timer.start(EPISODE_STEPS[4]); // Recording the voiceover
    const workDir = path.join(WORK_ROOT, "audio", episodeId);
    const voice = await synthesizeVoiceover(beatTexts(pkg), workDir);

    await timer.start(EPISODE_STEPS[5]); // Timing the captions
    const captions = buildCaptions(voice.beats);

    // Sweeps: one array of strokes per beat, in PAGE-LOCAL coordinates (what
    // `buildComposition` itself expects — it adds each beat's page offset).
    // A page whose alignment fell below `ALIGNMENT_FLOOR` (or has none at
    // all, e.g. an OCR failure) highlights by a single whole-page block
    // instead of by line (binding decision #5).
    const offsets = columnOffsets(compPages);
    const offsetByPageIndex = new Map(compPages.map((p, i) => [p.pageIndex, offsets[i]]));
    const dimsByPageIndex = new Map(compPages.map((p) => [p.pageIndex, { width: p.width, height: p.height }]));

    const sweeps: SweepStep[][] = [];
    const columnSteps: SweepStep[] = [];

    pkg.beats.forEach((beat, i) => {
      const audio = voice.beats[i];
      const page = pages.find((p) => p.pageIndex === beat.sourcePage);
      if (!page || !audio) {
        sweeps.push([]);
        return;
      }

      let steps: SweepStep[];
      const confidence = page.alignmentConfidence ?? 0;
      if (!page.alignment || confidence < ALIGNMENT_FLOOR) {
        const dims = dimsByPageIndex.get(page.pageIndex);
        steps = dims
          ? [
              {
                box: { x0: 0, y0: 0, x1: dims.width, y1: dims.height },
                start: audio.speechStart,
                end: audio.speechEnd,
              },
            ]
          : [];
      } else {
        const words = JSON.parse(page.alignment) as AlignedWord[];
        const lines = clusterLineRuns(words);
        steps = sweepForBeat(lines, beat.startWord, beat.endWord, audio.speechStart, audio.speechEnd);
      }

      sweeps.push(steps);

      const offset = offsetByPageIndex.get(page.pageIndex) ?? 0;
      for (const s of steps) {
        columnSteps.push({
          box: { x0: s.box.x0, y0: offset + s.box.y0, x1: s.box.x1, y1: offset + s.box.y1 },
          start: s.start,
          end: s.end,
        });
      }
    });

    const columnHeight = compPages.reduce((sum, p) => sum + p.height, 0);
    const camera = cameraTrack(columnSteps, FRAME.height, columnHeight);

    // The music bed: a full-composition-length pad, sidechain-ducked against
    // the voice, that is what actually carries the CTA's outro hold — the
    // voice track itself only ever spans AUDIO_OFFSET..AUDIO_OFFSET+totalDuration,
    // never the OUTRO_TAIL past it (see spec §10, "A known gap fixed rather
    // than inherited"). Generation is best-effort, same contract as
    // `writeProject`'s own optional-asset copies below: a failed bed must
    // never sink an otherwise-good render, it just plays dry, exactly as it
    // did before this was wired in.
    const compositionDuration = AUDIO_OFFSET + voice.totalDuration + OUTRO_TAIL;
    const musicPath = path.join(workDir, "music.wav");
    let hasMusic = false;
    try {
      await generateMusicBed(compositionDuration, musicPath, {
        style: MOOD_TO_STYLE[marginalia.mood],
        voicePath: voice.audioPath,
        voiceOffsetSec: AUDIO_OFFSET,
      });
      hasMusic = true;
    } catch (err) {
      const existing: string[] = episode.notes ? JSON.parse(episode.notes) : [];
      await prisma.episode.update({
        where: { id: episodeId },
        data: {
          notes: JSON.stringify([
            ...existing,
            `Music bed generation failed (${message(err)}) — rendering without one.`,
          ]),
        },
      });
    }

    await timer.start(EPISODE_STEPS[6]); // Building the composition
    const html = buildComposition({
      pkg,
      beats: voice.beats,
      captions,
      pages: compPages.map((p) => ({ src: p.src, width: p.width, height: p.height })),
      sweeps,
      camera,
      theme: marginalia,
      totalDuration: voice.totalDuration,
      music: hasMusic,
    });

    await prisma.episode.update({
      where: { id: episodeId },
      data: {
        captions: JSON.stringify(captions),
        srt: toSrt(captions),
        durationSec: voice.totalDuration,
        audioPath: voice.audioPath,
        visualPlan: JSON.stringify({ ...range, sweeps, camera }),
      },
    });

    const projectDir = path.join(WORK_ROOT, "projects", episodeId);
    await writeProject({
      dir: projectDir,
      indexHtml: html,
      audioSource: voice.audioPath,
      musicSource: hasMusic ? musicPath : null,
      assets: compPages.map((p) => ({ from: p.from, to: p.to })),
    });
    await prisma.episode.update({ where: { id: episodeId }, data: { projectPath: projectDir } });

    // Checking the composition is non-fatal: any finding is recorded as a
    // note, but the render still runs — only the render itself is fatal.
    await timer.start(EPISODE_STEPS[7]); // Checking the composition
    const check = await checkProject(projectDir);
    if (!check.ok || check.notes.length) {
      const existing: string[] = episode.notes ? JSON.parse(episode.notes) : [];
      const combined = [...existing, ...check.notes.map((n) => `Composition check: ${n}`)];
      await prisma.episode.update({ where: { id: episodeId }, data: { notes: JSON.stringify(combined) } });
    }

    await timer.start(EPISODE_STEPS[8]); // Rendering the video
    const quality = ((await getSetting("renderQuality")) as "draft" | "high" | null) ?? "draft";
    const mode = ((await getSetting("renderMode")) as "local" | "cloud" | null) ?? "local";
    const outputAbs = path.join(RENDER_DIR, `${episodeId}.mp4`);
    await renderProject(projectDir, outputAbs, quality, mode);

    await timer.finish();
    // `StepTimer.finish()` deliberately only stamps `finishedAt`/`totalMs` —
    // it has no opinion on terminal status, the same way `fail()` (below,
    // and in this function's own `fail` wrapper) leaves it to the caller.
    // Leaving this unset here would strand a genuinely finished episode
    // showing "RUNNING" / "Rendering the video" forever.
    await prisma.episode.update({
      where: { id: episodeId },
      data: { status: "DONE", videoPath: outputAbs },
    });
  } catch (err) {
    await releaseIdea(episode.bookId, episode.ideaKey ?? episode.id);
    await fail(err);
    throw err;
  }
}
