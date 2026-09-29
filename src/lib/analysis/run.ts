/**
 * A book PDF, from upload to a shortlist of 14–20 grounded video ideas.
 *
 *   Extracting the PDF     PyMuPDF: words + boxes + fonts + outline, one image per page
 *   Running OCR            Tesseract on pages with no text layer; the vision
 *                          reader re-reads pages OCR was unsure of
 *   Analyzing the book     furniture stripped, sections found, ~200-word chunks, embeddings
 *   Finding content ideas  one model call per ~3,500-word window, quotes located in the book
 *   Ranking the ideas      one call scores all candidates; dedup + diverse selection
 *
 * Progress is written to the Upload row as it goes (step, and a finer
 * "Page 37 of 200" in `progress`), so the UI polls the same way it does for a
 * photo ingest. Long steps heartbeat the row so the reaper never mistakes a
 * slow book for a dead run.
 *
 * Failure policy, in the same spirit as the photo pipeline: fail only when a
 * shortlist is impossible (the PDF cannot be read, has no text even after
 * OCR, or no window produced a single grounded idea). Everything else — an
 * OCR'd page, the vision re-read, embeddings, the ranking call — degrades
 * with a note saying so.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { prisma, getSetting } from "../db";
import { uploadDir } from "../paths";
import { mapLimit } from "../concurrency";
import { callContext } from "../content/cli-metrics";
import { ANALYSIS_STEPS } from "../pipeline-steps";
import { measurePage, disposeOcr, type OcrWord } from "../ingest/ocr";
import { readPage, wordsOf, type PageText } from "../ingest/vision";
import { alignWords } from "../ingest/align";
import { buildLineRuns } from "../ingest/lines";
import { runCliJson } from "../content/cli-provider";
import type { CliProvider } from "../content/cli";
import { extractPdf, readRawPage, PdfError } from "../pdf/extract";
import {
  bodyFontSize,
  linesFromOcr,
  linesFromRaw,
  needsOcr,
  structurePages,
  type LinedPage,
} from "../pdf/page-text";
import { detectSections } from "./sections";
import { buildWindows, chunkSections } from "./chunks";
import { CANDIDATE_SCHEMA, CANDIDATE_SYSTEM, groundCandidates, ideasPerWindow, windowPrompt } from "./candidates";
import { RANK_SCHEMA, RANK_SYSTEM, applyRanking, rankPrompt } from "./rank";
import { ideaKeys, selectIdeas, TARGET_MIN } from "./select";
import { cosine, lexicalEmbedder, toBytes, transformersEmbedder, type Embedder } from "./embed";
import type {
  AnalysisStats,
  Candidate,
  PageHeading,
  RawPdfManifest,
  RawPdfPage,
  ScoredCandidate,
  StructuredPage,
  TextSource,
} from "./types";

/** Below this mean Tesseract confidence, a page is re-read by the vision model. */
const OCR_REREAD_BELOW = 70;
/** At most this many pages are re-read — each is one vision call. */
const MAX_VISION_REREADS = 30;
const WINDOW_CONCURRENCY = 3;
/** The ranker reads every candidate in one prompt; past this, the weakest wait outside. */
const MAX_RANKED = 90;
const HEARTBEAT_MS = 60_000;

/** PageText as stored for a PDF page: the headings ride along for resumption. */
type StoredPageText = PageText & { headings?: PageHeading[] };

/**
 * Uploads being analysed in this process. On `globalThis` for the reason
 * `db.ts` keeps Prisma there: route handlers may each get their own copy of a
 * module, and the analyze route must see the set the run itself writes to.
 */
const globalRuns = globalThis as unknown as { bookAnalysisRuns?: Set<string> };
const running = (globalRuns.bookAnalysisRuns ??= new Set<string>());

export function isAnalysisRunning(uploadId: string): boolean {
  return running.has(uploadId);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function contentProvider(): Promise<CliProvider> {
  return (await getSetting("cliProvider")) === "codex-cli" ? "codex-cli" : "claude-cli";
}

async function cliModel(): Promise<string | undefined> {
  return (await getSetting("cliModel")) || undefined;
}

class Reporter {
  private lastWrite = 0;
  private pending: string | null = null;
  readonly notes: string[] = [];

  constructor(private uploadId: string) {}

  async step(step: (typeof ANALYSIS_STEPS)[number]): Promise<void> {
    this.pending = null;
    await prisma.upload.update({ where: { id: this.uploadId }, data: { step, progress: null } });
  }

  /** Throttled: a 200-page loop reports every page but writes about once a second. */
  async progress(label: string, done: number, total: number, force = false): Promise<void> {
    this.pending = JSON.stringify({ label, done, total });
    if (!force && Date.now() - this.lastWrite < 1000) return;
    this.lastWrite = Date.now();
    const progress = this.pending;
    await prisma.upload.update({ where: { id: this.uploadId }, data: { progress } }).catch(() => {});
  }

  /** Touch the row so `updatedAt` moves while one long call is in flight. */
  async beat(): Promise<void> {
    const row = await prisma.upload.findUnique({ where: { id: this.uploadId }, select: { progress: true } });
    await prisma.upload.update({ where: { id: this.uploadId }, data: { progress: row?.progress ?? null } });
  }

  note(line: string): void {
    this.notes.push(line);
  }
}

// --- Extraction + OCR -------------------------------------------------------

async function extractAndRead(
  uploadId: string,
  sourcePath: string,
  report: Reporter,
  model: string | undefined,
  stats: AnalysisStats,
): Promise<{ pages: StructuredPage[]; manifest: RawPdfManifest }> {
  const outDir = path.join(uploadDir(uploadId), "pages");
  await report.step("Extracting the PDF");
  await fs.rm(outDir, { recursive: true, force: true });
  const manifest = await extractPdf(sourcePath, outDir, (p) => {
    void report.progress(`Page ${p.done} of ${p.pageCount}`, p.done, p.pageCount);
  });
  await prisma.upload.update({ where: { id: uploadId }, data: { pageCount: manifest.pageCount } });

  const raws: RawPdfPage[] = [];
  for (let i = 0; i < manifest.pageCount; i++) raws.push(await readRawPage(outDir, i));
  const imageOf = (i: number) => path.join(outDir, raws[i].image);

  // --- OCR for pages with no text layer.
  await report.step("Running OCR");
  const scanned = raws.filter(needsOcr).map((r) => r.index);
  const ocrWords = new Map<number, OcrWord[]>();
  const vision = new Map<number, PageText>();
  if (scanned.length) {
    try {
      for (let k = 0; k < scanned.length; k++) {
        const i = scanned[k];
        await report.progress(`Scanned page ${k + 1} of ${scanned.length}`, k, scanned.length);
        try {
          ocrWords.set(i, await measurePage(imageOf(i)));
        } catch (err) {
          report.note(`Page ${i + 1}: OCR failed (${message(err)}) — its text is missing from the analysis.`);
          ocrWords.set(i, []);
        }
      }
    } finally {
      await disposeOcr().catch(() => {});
    }

    // Pages OCR was unsure of get a second reading from the vision model,
    // the same reader photographed pages use. OCR's boxes are kept either way.
    const meanConf = (ws: OcrWord[]) => (ws.length ? ws.reduce((s, w) => s + w.confidence, 0) / ws.length : 0);
    const doubtful = scanned
      .filter((i) => (ocrWords.get(i)?.length ?? 0) > 0 && meanConf(ocrWords.get(i)!) < OCR_REREAD_BELOW)
      .slice(0, MAX_VISION_REREADS);
    if (doubtful.length) {
      let n = 0;
      await mapLimit(doubtful, 3, async (i) => {
        try {
          const text = await readPage(imageOf(i), i, "claude-cli", model);
          if (text.legible && text.paragraphs.length) vision.set(i, text);
        } catch (err) {
          report.note(`Page ${i + 1}: the second reading failed (${message(err)}) — using OCR text as is.`);
        }
        await report.progress(`Re-reading unclear page ${++n} of ${doubtful.length}`, n, doubtful.length);
      });
    }
    const lowConf = scanned.filter((i) => (ocrWords.get(i)?.length ?? 0) > 0 && meanConf(ocrWords.get(i)!) < OCR_REREAD_BELOW);
    if (lowConf.length > MAX_VISION_REREADS) {
      report.note(`${lowConf.length} scanned pages were hard to read; only the first ${MAX_VISION_REREADS} were re-read. The rest use OCR text as is.`);
    }
    stats.ocrPages = scanned.length;
    stats.visionPages = vision.size;
  }

  // --- Structure every page.
  const lined: LinedPage[] = raws.map((r) => {
    const ocr = ocrWords.get(r.index);
    return {
      pageIndex: r.index,
      label: r.label || null,
      width: r.width,
      height: r.height,
      lines: ocr ? linesFromOcr(ocr) : linesFromRaw(r),
      source: (ocr ? "ocr" : "text-layer") as TextSource,
      ocrConfidence: ocr?.length ? Math.round(ocr.reduce((s, w) => s + w.confidence, 0) / ocr.length) : null,
    };
  });
  const pages = structurePages(lined, bodyFontSize(raws));

  for (const [i, text] of vision) {
    const words = wordsOf(text);
    const { aligned, confidence } = alignWords(words, ocrWords.get(i) ?? []);
    pages[i] = {
      ...pages[i],
      text,
      words,
      alignment: buildLineRuns(aligned).words,
      alignmentConfidence: confidence,
      headings: text.chapterHeading ? [{ text: text.chapterHeading, scale: 1, top: 0 }] : [],
      source: "vision",
    };
  }

  const totalWords = pages.reduce((s, p) => s + p.words.length, 0);
  if (totalWords === 0) {
    throw new PdfError(
      "no_text",
      scanned.length
        ? "No readable text was found in this PDF, even after OCR. The scan may be too faint, or the pages may be images without text."
        : "This PDF contains no readable text.",
    );
  }

  // Page rows: the same shape a photographed page has after ingest.
  await prisma.page.deleteMany({ where: { uploadId } });
  for (let i = 0; i < pages.length; i += 50) {
    await prisma.page.createMany({
      data: pages.slice(i, i + 50).map((p) => ({
        uploadId,
        pageIndex: p.pageIndex,
        filePath: imageOf(p.pageIndex),
        derivedPath: imageOf(p.pageIndex),
        width: raws[p.pageIndex].width,
        height: raws[p.pageIndex].height,
        visionText: JSON.stringify({ ...p.text, headings: p.headings } satisfies StoredPageText),
        ocrBoxes: ocrWords.has(p.pageIndex) ? JSON.stringify(ocrWords.get(p.pageIndex)) : null,
        alignment: JSON.stringify(p.alignment),
        alignmentConfidence: p.alignmentConfidence,
        pageLabel: p.label,
        textSource: p.source,
        ocrConfidence: p.ocrConfidence,
      })),
    });
  }
  return { pages, manifest };
}

/**
 * A retry after a crash or a failed idea step need not re-extract (or re-OCR)
 * a book whose pages are already stored in full.
 */
async function loadStoredPages(uploadId: string, pageCount: number | null): Promise<StructuredPage[] | null> {
  if (!pageCount) return null;
  const rows = await prisma.page.findMany({ where: { uploadId }, orderBy: { pageIndex: "asc" } });
  if (rows.length !== pageCount || rows.some((r) => !r.visionText || !r.alignment)) return null;
  return rows.map((r) => {
    const stored = JSON.parse(r.visionText!) as StoredPageText;
    const { headings = [], ...text } = stored;
    return {
      pageIndex: r.pageIndex,
      label: r.pageLabel,
      text,
      words: wordsOf(text),
      alignment: JSON.parse(r.alignment!),
      alignmentConfidence: r.alignmentConfidence ?? 0,
      headings,
      source: (r.textSource ?? "text-layer") as TextSource,
      ocrConfidence: r.ocrConfidence,
    };
  });
}

// --- Embeddings -------------------------------------------------------------

async function embedWithFallback(texts: string[], report: Reporter, stats: AnalysisStats): Promise<{ vectors: Float32Array[]; embedder: Embedder }> {
  try {
    const vectors = await transformersEmbedder.embed(texts);
    stats.embeddings = true;
    return { vectors, embedder: transformersEmbedder };
  } catch (err) {
    report.note(
      `The semantic embedding model could not be loaded (${message(err)}) — duplicate detection and related pages used word overlap instead, which misses paraphrases.`,
    );
    stats.embeddings = false;
    return { vectors: await lexicalEmbedder.embed(texts), embedder: lexicalEmbedder };
  }
}

// --- The run ----------------------------------------------------------------

export async function runBookAnalysis(uploadId: string): Promise<void> {
  if (running.has(uploadId)) return;
  running.add(uploadId);
  callContext.enterWith({ uploadId, step: "Book analysis" });
  const report = new Reporter(uploadId);
  const heartbeat = setInterval(() => void report.beat().catch(() => {}), HEARTBEAT_MS);
  heartbeat.unref?.();

  const stats: AnalysisStats = {
    pages: 0, ocrPages: 0, visionPages: 0, sections: 0, chunks: 0, windows: 0, windowsFailed: 0,
    proposed: 0, ungrounded: 0, duplicates: 0, selected: 0, embeddings: false,
  };

  try {
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId }, include: { book: true } });
    if (upload.kind !== "pdf" || !upload.sourcePath) throw new PdfError("not_pdf", "This upload is not a PDF.");
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: "RUNNING", error: null, notes: null, stats: null, progress: null },
    });

    const provider = await contentProvider();
    const model = await cliModel();
    const bookTitle = upload.book.title;

    // 1–2: pages (reused when a previous run already stored them all).
    let pages = await loadStoredPages(uploadId, upload.pageCount);
    let manifest: RawPdfManifest;
    if (pages) {
      manifest = JSON.parse(await fs.readFile(path.join(uploadDir(uploadId), "pages", "manifest.json"), "utf8"));
      const scanned = pages.filter((p) => p.source === "ocr" || p.source === "vision");
      stats.ocrPages = scanned.length;
      stats.visionPages = pages.filter((p) => p.source === "vision").length;
      report.note("The pages were already extracted by an earlier run, so extraction and OCR were not repeated.");
    } else {
      ({ pages, manifest } = await extractAndRead(uploadId, upload.sourcePath, report, model, stats));
    }
    stats.pages = pages.length;

    // 3: structure, chunks, embeddings.
    await report.step("Analyzing the book");
    const sections = detectSections(pages, manifest.toc);
    stats.sections = sections.filter((s) => !s.skip).length;
    if (sections.every((s) => s.source === "fallback")) {
      report.note("No chapters were found (no outline, no chapter headings), so the book was divided into 10-page parts.");
    }
    const chunks = chunkSections(pages, sections);
    stats.chunks = chunks.length;
    if (chunks.length === 0) {
      throw new PdfError("no_body", "This PDF has no body text to analyse — only front or back matter (contents, copyright, index).");
    }

    await report.progress(`Embedding ${chunks.length} passages`, 0, chunks.length, true);
    const { vectors: chunkVectors, embedder } = await embedWithFallback(chunks.map((c) => c.text), report, stats);

    await prisma.contentIdea.deleteMany({ where: { uploadId } });
    await prisma.chunk.deleteMany({ where: { uploadId } });
    await prisma.section.deleteMany({ where: { uploadId } });
    await prisma.section.createMany({
      data: sections.map((s) => ({ uploadId, ...s })),
    });
    for (let i = 0; i < chunks.length; i += 100) {
      await prisma.chunk.createMany({
        data: chunks.slice(i, i + 100).map((c, j) => ({
          uploadId,
          index: c.index,
          sectionIndex: c.sectionIndex,
          startPage: c.startPage,
          endPage: c.endPage,
          spans: JSON.stringify(c.spans),
          text: c.text,
          wordCount: c.wordCount,
          embedding: toBytes(chunkVectors[i + j]),
        })),
      });
    }

    // 4: candidates, one call per window.
    await report.step("Finding content ideas");
    const windows = buildWindows(chunks);
    stats.windows = windows.length;
    const perWindow = ideasPerWindow(windows.length);
    let finished = 0;
    let lastError = "";
    // Each of these calls is a real Claude CLI subprocess and genuinely runs
    // 40 s to 5+ minutes (measured on real books) — there is no way to make
    // "reading a passage" fast without cutting the passage or the reasoning
    // short, and neither is on the table here. What WAS wrong is that
    // `report.progress` below only fired once a window finished: with
    // WINDOW_CONCURRENCY windows running at once, the very first update could
    // be minutes away, and the progress panel showed nothing at all up to
    // that point — indistinguishable from a hang even though three real model
    // calls were in flight the whole time. This line is the fix: it reports
    // the moment a window is PICKED UP, before its model call is even sent,
    // so the operator sees which passages are actively being read straight
    // away instead of staring at a blank step for however long the slowest
    // of the first batch takes. `done`/`total` still count only FINISHED
    // windows — the progress bar itself never lies about how much is done —
    // only the label changes to say what is happening right now.
    const results = await mapLimit(windows, WINDOW_CONCURRENCY, async (w) => {
      const prompt = windowPrompt(w, chunks, pages!, sections, bookTitle, perWindow);
      for (let attempt = 1; attempt <= 2; attempt++) {
        await report.progress(
          attempt === 1
            ? `Reading passage ${w.index + 1} of ${windows.length}…`
            : `Reading passage ${w.index + 1} of ${windows.length} again…`,
          finished,
          windows.length,
          true,
        );
        try {
          const reply = await runCliJson<unknown>(provider, CANDIDATE_SYSTEM, prompt, CANDIDATE_SCHEMA, model);
          await report.progress(`Read passage ${++finished} of ${windows.length}`, finished, windows.length, true);
          return groundCandidates(reply, w, pages!, sections);
        } catch (err) {
          lastError = message(err);
        }
      }
      stats.windowsFailed++;
      await report.progress(`Read passage ${++finished} of ${windows.length}`, finished, windows.length, true);
      const pagesOf = `${w.pages[0] + 1}–${w.pages[w.pages.length - 1] + 1}`;
      report.note(`Pages ${pagesOf} could not be analysed (${lastError}) — ideas from them are missing.`);
      return null;
    });

    if (results.every((r) => r === null)) {
      throw new PdfError("analysis_failed", `The book could not be analysed: every passage failed. Last error: ${lastError}`);
    }
    let candidates: Candidate[] = [];
    for (const r of results) {
      if (!r) continue;
      candidates.push(...r.candidates);
      stats.proposed += r.proposed;
      stats.ungrounded += r.ungrounded;
    }
    if (stats.ungrounded > 0) {
      report.note(`${stats.ungrounded} proposed idea(s) were discarded because their quotes could not be found in the book.`);
    }
    if (candidates.length === 0) {
      throw new PdfError(
        "no_ideas",
        "No video-worthy ideas could be grounded in this book's text. It may be mostly reference material, or its text may be too damaged to quote from.",
      );
    }
    if (candidates.length > MAX_RANKED) {
      candidates = [...candidates].sort((a, b) => b.strength - a.strength).slice(0, MAX_RANKED);
    }

    // 5: ranking, dedup, selection.
    await report.step("Ranking the ideas");
    // Same reasoning as the window loop above: one real model call, reading
    // every candidate at once, genuinely takes a couple of minutes — this
    // says so up front rather than leaving the step name as the only visible
    // sign that anything is happening for the whole call.
    await report.progress(`Scoring ${candidates.length} candidate ideas…`, 0, candidates.length, true);
    const sectionTitles = new Map(sections.map((s) => [s.index, s.title]));
    let scored: ScoredCandidate[];
    try {
      let reply: unknown = null;
      let rankError: unknown = null;
      for (let attempt = 1; attempt <= 2 && reply === null; attempt++) {
        if (attempt > 1) await report.progress(`Scoring ${candidates.length} candidate ideas again…`, 0, candidates.length, true);
        try {
          reply = await runCliJson<unknown>(provider, RANK_SYSTEM, rankPrompt(bookTitle, candidates, sectionTitles), RANK_SCHEMA, model);
        } catch (err) {
          rankError = err;
        }
      }
      if (reply === null) throw rankError;
      const ranked = applyRanking(candidates, reply);
      scored = ranked.scored;
      if (ranked.missing > 0) {
        report.note(`The ranker skipped ${ranked.missing} idea(s); they were scored from their first reading instead.`);
      }
    } catch (err) {
      report.note(`Ranking failed (${message(err)}) — ideas were ordered by their first reading instead.`);
      scored = applyRanking(candidates, null).scored;
    }

    const candidateVectors = await embedder.embed(scored.map((c) => `${c.title}. ${c.coreIdea}`));
    const vectorOf = new Map(scored.map((c, i) => [c.id, candidateVectors[i]]));
    const { selected, duplicates } = selectIdeas(
      scored,
      vectorOf,
      embedder.id === "lexical" ? { duplicateSimilarity: 0.6 } : {},
    );
    stats.duplicates = duplicates.length;
    stats.selected = selected.length;

    if (selected.length < TARGET_MIN) {
      report.note(
        `This book yielded ${selected.length} distinct, well-grounded idea(s) — fewer than ${TARGET_MIN}. Short or narrowly focused books have fewer ideas that can each carry a video; none were padded out.`,
      );
    }

    // Related passages elsewhere in the book, by similarity — context a
    // script writer can draw on beyond the quoted lines.
    const relatedFloor = embedder.id === "lexical" ? 0.25 : 0.45;
    const keys = ideaKeys(selected.map((c) => c.title));
    await prisma.contentIdea.createMany({
      data: selected.map((c, i) => {
        const own = new Set(c.refs.map((r) => r.pageIndex));
        const v = vectorOf.get(c.id)!;
        const related = chunkVectors
          .map((cv, ci) => ({ ci, s: cosine(v, cv) }))
          .filter((x) => x.s >= relatedFloor)
          .sort((a, b) => b.s - a.s)
          .flatMap((x) => [chunks[x.ci].startPage, chunks[x.ci].endPage])
          .filter((p, k, arr) => !own.has(p) && arr.indexOf(p) === k)
          .slice(0, 6);
        return {
          uploadId,
          bookId: upload.bookId,
          rank: i + 1,
          ideaKey: keys[i],
          title: c.title,
          coreIdea: c.coreIdea,
          hook: c.hook,
          whyItMatters: c.whyItMatters,
          angle: c.angle,
          hookPotential: c.hookPotential,
          storyPotential: c.storyPotential,
          practicalValue: c.practicalValue,
          visualPotential: c.visualPotential,
          sectionTitle: sectionTitles.get(c.sectionIndex) ?? null,
          sourcePages: JSON.stringify([...own].sort((a, b) => a - b)),
          sourceRefs: JSON.stringify(c.refs),
          sourceText: c.quotes.join("\n\n"),
          relatedPages: JSON.stringify(related.sort((a, b) => a - b)),
          scores: JSON.stringify(c.scores),
          score: c.score,
        };
      }),
    });

    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        status: "DONE",
        step: "Done",
        error: null,
        progress: null,
        notes: report.notes.length ? JSON.stringify(report.notes) : null,
        stats: JSON.stringify(stats),
      },
    });
  } catch (err) {
    // `step` is left where it was: the rail shows WHICH stage failed.
    await prisma.upload
      .update({
        where: { id: uploadId },
        data: {
          status: "FAILED",
          error: message(err) || "The analysis failed without saying why.",
          progress: null,
          notes: report.notes.length ? JSON.stringify(report.notes) : null,
          stats: JSON.stringify(stats),
        },
      })
      .catch(() => {});
    throw err;
  } finally {
    clearInterval(heartbeat);
    running.delete(uploadId);
  }
}
