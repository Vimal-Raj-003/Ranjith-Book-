import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import sharp from "sharp";
import { prisma, getSetting } from "./db";
import { WORK_ROOT, RENDER_DIR } from "./paths";
import { IngestFailed } from "./errors";
import { StepTimer } from "./step-timer";
import { mapLimit } from "./concurrency";
import { callContext } from "./content/cli-metrics";
import { ideaEpisodeSource, ideaVideoDuration, IDEA_VIDEO_HARD, type IdeaSource } from "./episodes/idea-episode";
import { readPage, wordsOf, type PageText } from "./ingest/vision";
import { measurePage, disposeOcr, type OcrWord } from "./ingest/ocr";
import { alignWords, ALIGNMENT_FLOOR, type AlignedWord } from "./ingest/align";
import { buildLineRuns, clusterLineRuns, runsForRange } from "./ingest/lines";
import { lookupBook, resolveAuthor } from "./ingest/identity";
import { validatePlan, type EpisodePlan } from "./ingest/plan-episodes";
import { generateContent, beatTexts, voScriptFromPackage, type Archetype } from "./content";
import { releaseIdea } from "./content/idea";
import { appendBookLink } from "./content/book-link";
import { runCliJson } from "./content/cli-provider";
import { numberedWordLines } from "./content/prompt";
import type { CliProvider } from "./content/cli";
import type { RightsStatus } from "./content/quotation";
import { synthesizeVoiceover } from "./media/tts";
import { generateMusicBed } from "./media/ffmpeg";
import { toSrt } from "./media/captions";
import { timeNarration, serializeTiming } from "./media/narration-timing";
import { sweepForBeat, timedSweepForBeat, cameraTrack, type SweepStep } from "./video/sweep";
import { planScenes, describePlan } from "./video/scenes";
import { buildComposition, AUDIO_OFFSET, OUTRO_TAIL, cardViewportHeight } from "./video/composition/build";
import { generateThumbnails, thumbsDir, serializeThumbnails, type ThumbFocus } from "./thumbnails";
import { bookThemeById, isBookThemeId, DEFAULT_BOOK_THEME_ID } from "./video/composition/themes";
import { writeProject, checkProject, renderProject } from "./video/render";
import type { BookTheme } from "./video/composition/theme-contract";
import { beginCancellable, endCancellable, throwIfCancelled, wasCancelled } from "./cancel";

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
 * Which CLI provider drives content generation (writing, grounding, planning,
 * the author guess). Vision is exempt from this setting — `readPage` only
 * works with the Claude Code CLI (see `cli-vision.ts`), so it is always called
 * with `"claude-cli"` regardless of what the operator has chosen here.
 */
async function contentProvider(): Promise<CliProvider> {
  const v = await getSetting("cliProvider");
  return v === "codex-cli" ? "codex-cli" : "claude-cli";
}

/**
 * Parallel capture workers for a local render. Measured on a 24-thread
 * machine, a 96 s video: HyperFrames' "auto" 147 s, 4 workers 142 s, 8 workers
 * 116 s — and the output no more different from auto than two auto renders are
 * from each other (SSIM 0.997 either way: capture timing, not quality). On a
 * smaller machine 8 would oversubscribe the CPU, so below 16 threads the
 * choice stays with HyperFrames. The `renderWorkers` setting (1–8) overrides.
 */
async function renderWorkers(): Promise<number | undefined> {
  const setting = Number(await getSetting("renderWorkers"));
  if (Number.isInteger(setting) && setting >= 1 && setting <= 8) return setting;
  return os.cpus().length >= 16 ? 8 : undefined;
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

    // The theme the operator picked in Settings, stamped onto each episode at
    // creation so a later change never silently re-skins an episode that has
    // already been rendered with a different one.
    const settingTheme = await getSetting("theme");
    const chosenTheme = isBookThemeId(settingTheme) ? settingTheme : DEFAULT_BOOK_THEME_ID;

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
          theme: chosenTheme,
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

    // `error: null` for the same reason as the episode success path below: a
    // retried upload must not stay branded with the failure it just recovered from.
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: "DONE", step: "Done", error: null },
    });
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
/**
 * Append advisory notes to an episode, re-reading what is already stored.
 *
 * Every note-writing site used to build its list from `episode.notes` on the
 * row fetched at the top of `runEpisode`. That snapshot is minutes stale by the
 * time the later steps run, so each block overwrote whatever the blocks before
 * it had recorded — and the last writer won.
 *
 * This was not theoretical. A real run generated all six thumbnails on disk and
 * then failed to store them; the note explaining why was written correctly and
 * then erased by the composition check a few seconds later, leaving a DONE
 * episode with no thumbnails, no error, and nothing in `notes` to say what
 * happened. Notes are the only diagnostic these best-effort steps have, so
 * losing them is the difference between a bug that explains itself and one that
 * has to be excavated.
 *
 * Best-effort by design, like every caller: a note that cannot be written must
 * never take down the render it is describing.
 */
async function appendNotes(episodeId: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  try {
    const row = await prisma.episode.findUnique({
      where: { id: episodeId },
      select: { notes: true },
    });
    const existing: string[] = row?.notes ? (JSON.parse(row.notes) as string[]) : [];
    await prisma.episode.update({
      where: { id: episodeId },
      data: { notes: JSON.stringify([...existing, ...lines]) },
    });
  } catch {
    // Deliberately swallowed — see the doc comment.
  }
}

/**
 * A script that has ALREADY passed the grounding check, to render again
 * without writing a new one — e.g. to re-time and re-render a finished
 * episode's exact narration (scripts/rerender-episode.mjs). Never used by the
 * queue: every normal run writes and grounds its own script.
 */
export interface ApprovedScript {
  pkg: Awaited<ReturnType<typeof generateContent>>["pkg"];
  report: Awaited<ReturnType<typeof generateContent>>["report"];
  revised: boolean;
}

export async function runEpisode(episodeId: string, opts: { approvedScript?: ApprovedScript } = {}): Promise<void> {
  const episode = await prisma.episode.findUniqueOrThrow({
    where: { id: episodeId },
    include: {
      book: true,
      contentIdea: true,
      upload: { include: { pages: { orderBy: { pageIndex: "asc" } } } },
    },
  });

  const timer = new StepTimer(episodeId);
  await timer.begin();

  // Every model call below is recorded against this episode and the step it
  // ran in (content/cli-metrics.ts).
  const callCtx: { episodeId: string; step?: string } = { episodeId, step: EPISODE_STEPS[1] };
  callContext.enterWith(callCtx);

  // Makes this run's cancellation signal ambient for everything below: the
  // CLI spawner, ffmpeg, faster-whisper, the renderer, all read it without a
  // `signal` parameter threaded through every function in between (the same
  // trick `callContext` above already relies on). `endCancellable` runs from
  // `fail()` (every failure AND cancellation path calls it) and once more
  // after the success path's final write, so the registry never keeps a
  // stale entry for a run that finished.
  beginCancellable(episodeId);

  const provider = await contentProvider();
  const model = await cliModel();

  // Called before every step transition, so a cancellation lands between
  // steps even when the step that was running did not itself spawn anything
  // abort-aware (e.g. the plain DB/sharp work in "Preparing page assets").
  const startStep = async (name: string) => {
    throwIfCancelled();
    await timer.start(name);
  };

  const fail = async (err: unknown) => {
    // `wasCancelled()`, not `err instanceof CancelledError`: most of what
    // reaches here is Node's own `AbortError` from a killed child process or
    // an aborted fetch, not our own class — the ambient signal itself is the
    // only reliable way to tell "the operator cancelled this" from any other
    // failure, across every subprocess kind the pipeline spawns.
    const cancelled = wasCancelled();
    await timer.fail();
    await prisma.episode.update({
      where: { id: episodeId },
      data: {
        status: cancelled ? "CANCELLED" : "FAILED",
        error: cancelled ? "Cancelled by the operator." : message(err),
      },
    });
    endCancellable(episodeId);
  };

  // An idea episode (Phase 3a) is made from one ContentIdea of a book PDF: the
  // writer sees that idea's source and related pages and a brief of it, and
  // writes the long, 1–2 minute script. Everything after the script — voice,
  // composition, render — is the same path a photographed page takes.
  let ideaSource: IdeaSource | null = null;
  if (episode.contentIdea) {
    try {
      ideaSource = ideaEpisodeSource(
        episode.contentIdea,
        episode.upload.pages.map((p) => ({
          pageIndex: p.pageIndex,
          words: p.visionText ? wordsOf(JSON.parse(p.visionText) as PageText) : [],
        })),
      );
    } catch (err) {
      await fail(err);
      throw err;
    }
  }

  // `visualPlan` is set at creation time in `runIngest` to exactly this shape
  // (see there); the fallback below only guards against a row created by some
  // other path, so this episode still covers *something* rather than nothing.
  const range: PlanRange = ideaSource
    ? {
        startPage: ideaSource.pageIndices[0],
        endPage: ideaSource.pageIndices[ideaSource.pageIndices.length - 1],
        startWord: 0,
        endWord: 0,
      }
    : episode.visualPlan
      ? (JSON.parse(episode.visualPlan) as PlanRange)
      : { startPage: 0, endPage: Math.max(0, episode.upload.pages.length - 1), startWord: 0, endWord: 0 };

  const pages = ideaSource
    ? episode.upload.pages.filter((p) => ideaSource.pageIndices.includes(p.pageIndex))
    : episode.upload.pages.filter((p) => p.pageIndex >= range.startPage && p.pageIndex <= range.endPage);

  // Phase 1: write, ground-check and revise the script. Fatal on failure — a
  // rejected grounding verdict, an exceeded quotation budget, or a CLI failure
  // all propagate out here. `generateContent` reserves the idea itself and
  // releases it on every one of its own failure paths, so nothing further is
  // needed on this branch (binding decision #6 covers everything AFTER it
  // succeeds, in the second try block below).
  let pkg: Awaited<ReturnType<typeof generateContent>>["pkg"];
  let report: Awaited<ReturnType<typeof generateContent>>["report"];
  let revised: boolean;
  // Audio prepared WHILE a draft is being grounding-checked (a network wait),
  // instead of after it passes. Used only if the approved script is exactly
  // the draft it was made from; otherwise discarded and the approved script
  // is voiced as usual — nothing unapproved is ever used in a video.
  const workDir = path.join(WORK_ROOT, "audio", episodeId);
  type Prepared = { voice: Awaited<ReturnType<typeof synthesizeVoiceover>>; timing: Awaited<ReturnType<typeof timeNarration>> };
  let speculative: { texts: string[]; job: Promise<Prepared> } | null = null;
  const draftJobs: { dir: string; job: Promise<Prepared> }[] = [];
  let draftNo = 0;
  const prepareAudio = (texts: string[], dir: string): Promise<Prepared> =>
    (async () => {
      const voice = await synthesizeVoiceover(texts, dir);
      return { voice, timing: await timeNarration(voice, dir) };
    })();
  const onCheckStart = (candidate: Awaited<ReturnType<typeof generateContent>>["pkg"]) => {
    const texts = beatTexts(candidate);
    const dir = path.join(workDir, `draft-${++draftNo}`);
    const job = prepareAudio(texts, dir);
    job.catch(() => {}); // a failed speculation just means voicing afterwards
    speculative = { texts, job };
    draftJobs.push({ dir, job });
  };

  if (opts.approvedScript) {
    ({ pkg, report, revised } = opts.approvedScript);
  } else {
    try {
      const genPages = pages.map((p) => {
        const vt = p.visionText ? (JSON.parse(p.visionText) as PageText) : null;
        return {
          pageIndex: p.pageIndex,
          chapterHeading: vt?.chapterHeading ?? null,
          words: vt ? wordsOf(vt) : [],
        };
      });

      await startStep(EPISODE_STEPS[0]); // Reserving the idea
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
        ...(ideaSource ? { brief: ideaSource.brief, length: "long" as const } : {}),
        onCheckStart,
        onStep: async (step) => {
          callCtx.step = /checking/i.test(step) ? EPISODE_STEPS[2] : EPISODE_STEPS[1];
          // `writing` matches the first draft, `rewriting` matches every retry;
          // both belong to the same step. Measured on a real run, the first
          // draft alone was 254s -- 51% of the whole episode -- and it was being
          // billed to "Reserving the idea", a step that does almost nothing.
          if (/checking/i.test(step)) await startStep(EPISODE_STEPS[2]); // Grounding check
          else if (/writing/i.test(step)) await startStep(EPISODE_STEPS[1]); // Writing the script
        },
      });
      pkg = result.pkg;
      report = result.report;
      revised = result.revised;
      if (result.rangeRepairs?.length) {
        await appendNotes(episodeId, result.rangeRepairs.map((r) => `Word range repaired before the grounding check: ${r}`));
      }
    } catch (err) {
      await fail(err);
      throw err;
    }
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
        // The purchase link is appended in code, never asked of the model:
        // a model that invents or mistypes a URL is worse than no URL. With
        // no link on the book this returns the description unchanged.
        description: appendBookLink(pkg.description, episode.book.bookLink),
        hashtags: JSON.stringify(pkg.hashtags),
        cta: pkg.cta,
        verification: report ? JSON.stringify(report) : null,
        groundedness: report?.groundedness ?? null,
        revised,
      },
    });

    await startStep(EPISODE_STEPS[3]); // Preparing page assets
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

    await startStep(EPISODE_STEPS[4]); // Recording the voiceover
    const approvedTexts = beatTexts(pkg);
    let prepared: Prepared | null = null;
    const spec = speculative as { texts: string[]; job: Promise<Prepared> } | null;
    if (spec && spec.texts.length === approvedTexts.length && spec.texts.every((t, i) => t === approvedTexts[i])) {
      prepared = await spec.job.catch(() => null);
      if (prepared) await appendNotes(episodeId, ["The voice was recorded and timed while the grounding check ran, from the exact script it approved."]);
    }
    const voice = prepared?.voice ?? (await synthesizeVoiceover(approvedTexts, workDir));
    // Audio made for drafts that were not approved is deleted once it has
    // finished being written. Best-effort, and never awaited by the render.
    const usedDir = prepared ? path.dirname(prepared.voice.audioPath) : null;
    for (const d of draftJobs) {
      if (d.dir === usedDir) continue;
      void d.job.catch(() => null).then(() => fs.rm(d.dir, { recursive: true, force: true })).catch(() => {});
    }

    // An idea episode must come out 60–120 s. The script's word count is
    // gated before any audio exists; this checks what the voice actually
    // produced, before minutes of rendering are spent on it.
    if (ideaSource) {
      const video = AUDIO_OFFSET + voice.totalDuration + OUTRO_TAIL;
      const verdict = ideaVideoDuration(video);
      if (verdict === "fail") {
        throw new Error(
          `The narration came out ${video.toFixed(1)} s long, outside the ${IDEA_VIDEO_HARD.min}–${IDEA_VIDEO_HARD.max} s this video can run. Nothing was rendered; generate it again.`,
        );
      }
      if (verdict === "note") {
        await appendNotes(episodeId, [
          `The finished video runs ${video.toFixed(1)} s, a little outside the 60–120 s target.`,
        ]);
      }
    }

    await startStep(EPISODE_STEPS[5]); // Timing the captions
    // Word timing from the recorded voice (faster-whisper over the mastered
    // track, matched to the script). Subtitles, highlights and each beat's
    // speech window all come from it. Where it is unavailable the estimate is
    // used instead — and said so, in `timingSource` and in a note.
    const timing = prepared?.timing ?? (await timeNarration(voice, workDir));
    const captions = timing.captions;
    const timedBeats = timing.beats;
    if (timing.notes.length) await appendNotes(episodeId, timing.notes);

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

    // Line geometry per page, built once: the sweeps below need it, and so
    // does the scene planner, which zooms a `book-crop` to the lines a beat
    // cites. Pages whose alignment fell below the floor have none, and both
    // consumers degrade the same way — block highlight, whole-page scene.
    const linesByPage = new Map<number, ReturnType<typeof clusterLineRuns>>();
    for (const page of pages) {
      if (!page.alignment || (page.alignmentConfidence ?? 0) < ALIGNMENT_FLOOR) continue;
      linesByPage.set(page.pageIndex, clusterLineRuns(JSON.parse(page.alignment) as AlignedWord[]));
    }

    pkg.beats.forEach((beat, i) => {
      const audio = timedBeats[i];
      const page = pages.find((p) => p.pageIndex === beat.sourcePage);
      if (!page || !audio) {
        sweeps.push([]);
        return;
      }

      let steps: SweepStep[];
      const lines = linesByPage.get(page.pageIndex);
      if (!lines) {
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
        const words = JSON.parse(page.alignment!) as AlignedWord[];
        // From the audio when this beat was timed from it: strokes start and
        // stop on spoken words, and a passage read aloud is swept as it is
        // said. Otherwise the estimate, as the timing notes already record.
        steps =
          timing.perBeat[i]?.source === "audio"
            ? timedSweepForBeat(
                lines,
                beat.startWord,
                beat.endWord,
                timing.words.filter((w) => w.beatIndex === audio.index),
                words.map((w) => w.word),
              )
            : sweepForBeat(lines, beat.startWord, beat.endWord, audio.speechStart, audio.speechEnd);
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

    // `episode.theme` is whatever was stamped at creation. `bookThemeById`
    // never throws and never returns undefined -- an unknown or null id falls
    // back to the default rather than taking down a render for a bad string.
    const theme = bookThemeById(episode.theme);

    const columnHeight = compPages.reduce((sum, p) => sum + p.height, 0);

    // The window the viewer actually sees is the CARD, not the whole frame:
    // since spec 2026-08-23 the page scrolls inside a 960x1120 paper card
    // rather than filling all 1080x1920. `cameraTrack` works entirely in
    // column pixels, so it must be given the card's height expressed in that
    // space -- `cardViewportHeight` does exactly that conversion.
    //
    // Passing `FRAME.height` here still typechecks and still passes every
    // composition test (they build their own camera), and it fails silently in
    // two ways at once: the camera stops scrolling ~640 column pixels early so
    // the end of the last page is never brought into the card, and the "middle
    // third" the marker is centred in is a third of the wrong number, so the
    // marker drifts out of the bottom of the card. Both look like a highlight
    // bug and are not one.
    const columnWidth = compPages.length ? Math.max(...compPages.map((p) => p.width)) : 0;
    const camera = cameraTrack(columnSteps, cardViewportHeight(columnWidth), columnHeight);

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
    // Started, not awaited: the bed is ffmpeg work and the scene plan below is
    // a model call, so they are independent and the bed costs no wall clock.
    // It is awaited before the composition is built, which is the first thing
    // that needs to know whether there is one.
    const musicJob = generateMusicBed(compositionDuration, musicPath, {
      style: MOOD_TO_STYLE[theme.mood],
      voicePath: voice.audioPath,
      voiceOffsetSec: AUDIO_OFFSET,
    }).then(
      () => true,
      async (err: unknown) => {
        await appendNotes(episodeId, [`Music bed generation failed (${message(err)}) — rendering without one.`]);
        return false;
      },
    );

    // --- the scene plan (§3C) -----------------------------------------------
    // What is on screen, sentence by sentence. Best-effort in the same sense
    // the music bed is: a failed director call costs variety, never the video
    // (`planScenes` falls back to the narration itself, grouped into scenes).
    await startStep(EPISODE_STEPS[6]); // Planning the scenes
    const pageWords = new Map<number, string[]>();
    for (const p of pages) {
      if (p.visionText) pageWords.set(p.pageIndex, wordsOf(JSON.parse(p.visionText) as PageText));
    }
    const scenePlan = await planScenes({
      bookTitle: episode.book.title,
      beats: pkg.beats,
      words: timing.words,
      pageWords,
      hasPage: (page) => compPages.some((p) => p.pageIndex === page),
      cropFor: (page, startWord, endWord) => {
        const lines = linesByPage.get(page);
        if (!lines) return null;
        const runs = runsForRange(lines, startWord, endWord);
        if (runs.length === 0) return null;
        return {
          x0: Math.min(...runs.map((r) => r.box.x0)),
          y0: Math.min(...runs.map((r) => r.box.y0)),
          x1: Math.max(...runs.map((r) => r.box.x1)),
          y1: Math.max(...runs.map((r) => r.box.y1)),
        };
      },
      provider,
      model,
    });
    if (scenePlan.notes.length) await appendNotes(episodeId, scenePlan.notes);
    await appendNotes(episodeId, [describePlan(scenePlan)]);

    const hasMusic = await musicJob;

    await startStep(EPISODE_STEPS[7]); // Building the composition
    const html = buildComposition({
      pkg,
      beats: timedBeats,
      captions,
      pages: compPages.map((p) => ({ src: p.src, width: p.width, height: p.height })),
      sweeps,
      camera,
      theme,
      totalDuration: voice.totalDuration,
      music: hasMusic,
      bookTitle: episode.book.title,
      // The byline shows a name ONLY when the four-link verification chain
      // established one. `authorVerified` is that chain's verdict; an
      // unverified author is passed as null and the byline renders the title
      // alone -- no placeholder, no "Unknown", no guess. Same rule the content
      // writer is held to (it is never handed an unverified name either).
      author: episode.book.authorVerified ? episode.book.author : null,
      // Null unless the operator typed one. No link, no purchase card.
      bookLink: episode.book.bookLink,
      scenes: scenePlan.scenes,
    });

    await prisma.episode.update({
      where: { id: episodeId },
      data: {
        captions: JSON.stringify(captions),
        // In the finished video's clock: the voice starts AUDIO_OFFSET in.
        srt: toSrt(captions, AUDIO_OFFSET),
        wordTimings: serializeTiming(timing),
        timingSource: timing.source,
        scenePlan: JSON.stringify(scenePlan.scenes),
        durationSec: voice.totalDuration,
        audioPath: voice.audioPath,
        visualPlan: JSON.stringify({ ...range, sweeps, camera }),
      },
    });

    // Thumbnails: six posters (quote / bold / split, in 9:16 and 16:9) built
    // from the operator's own photograph. Best-effort, same contract as the
    // music bed above -- a poster that fails to render must never sink a video
    // that is otherwise finished.
    //
    // The focus box is the single widest stroke in the whole episode: the
    // longest continuous run of highlighted words is, by construction, the
    // most quotable line on the page, so it is what the crop centres on.
    // `sweeps[i]` is beat `i`'s strokes in PAGE-LOCAL coordinates, which is
    // exactly what the thumbnail renderer wants -- `columnSteps` would be
    // wrong here, its y values carry the whole column's offset.
    let focus: ThumbFocus | null = null;
    let widest = 0;
    sweeps.forEach((steps, i) => {
      const sourcePage = pkg.beats[i]?.sourcePage;
      // `ThumbFocus.pageIndex` indexes the `pages` ARRAY handed below, not the
      // book's own page numbering; an episode can cover a non-contiguous slice
      // of an upload, so the two are not interchangeable.
      const arrayIndex = compPages.findIndex((p) => p.pageIndex === sourcePage);
      if (arrayIndex < 0) return;
      for (const step of steps) {
        const area = Math.max(0, step.box.x1 - step.box.x0) * Math.max(0, step.box.y1 - step.box.y0);
        if (area <= widest) continue;
        widest = area;
        focus = { pageIndex: arrayIndex, x0: step.box.x0, y0: step.box.y0, x1: step.box.x1, y1: step.box.y1 };
      }
    });

    try {
      const specs = await generateThumbnails({
        episodeId,
        pkg,
        // `p.from` is the real path on disk. `p.src` is the "assets/..."
        // reference the composition uses, which nothing outside the rendered
        // project directory can resolve.
        pages: compPages.map((p) => ({ src: p.from, width: p.width, height: p.height })),
        focus,
        // The poster has to look like the video it is selling. Without this
        // the thumbnails were painted from a hardcoded copy of Marginalia's
        // palette, so a Spotlight episode -- near-black, hot orange -- was
        // advertised in cream and yellow.
        theme: theme.id,
        outDir: thumbsDir(episodeId),
      });
      if (specs.length) {
        await prisma.episode.update({
          where: { id: episodeId },
          data: { thumbnails: serializeThumbnails(specs) },
        });
      }
    } catch (err) {
      await appendNotes(episodeId, [
        `Thumbnail generation failed (${message(err)}) — the video is unaffected.`,
      ]);
    }

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
    await startStep(EPISODE_STEPS[8]); // Checking the composition
    const check = await checkProject(projectDir);
    if (!check.ok || check.notes.length) {
      await appendNotes(episodeId, check.notes.map((n) => `Composition check: ${n}`));
    }

    await startStep(EPISODE_STEPS[9]); // Rendering the video
    const quality = ((await getSetting("renderQuality")) as "draft" | "high" | null) ?? "draft";
    const mode = ((await getSetting("renderMode")) as "local" | "cloud" | null) ?? "local";
    const outputAbs = path.join(RENDER_DIR, `${episodeId}.mp4`);
    await renderProject(projectDir, outputAbs, quality, mode, await renderWorkers());

    await timer.finish();
    // `StepTimer.finish()` deliberately only stamps `finishedAt`/`totalMs` —
    // it has no opinion on terminal status, the same way `fail()` (below,
    // and in this function's own `fail` wrapper) leaves it to the caller.
    // Leaving this unset here would strand a genuinely finished episode
    // showing "RUNNING" / "Rendering the video" forever.
    await prisma.episode.update({
      where: { id: episodeId },
      // `error: null` because this row may be a re-run of one that failed, and
      // a DONE episode still carrying the previous attempt's error reads as a
      // contradiction to anything that looks past `status` — the API returns
      // both fields, and the next reader of them will not be this component.
      data: { status: "DONE", videoPath: outputAbs, error: null },
    });
    endCancellable(episodeId);
  } catch (err) {
    await releaseIdea(episode.bookId, episode.ideaKey ?? episode.id);
    await fail(err);
    throw err;
  }
}
