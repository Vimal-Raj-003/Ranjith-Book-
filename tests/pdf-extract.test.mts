/**
 * The real extraction path: PDFs built by PyMuPDF, read back by `extract.py`,
 * structured by `page-text.ts`, and — for the scanned copy — OCR'd by
 * tesseract.js. Skipped (not failed) on a machine with no Python + PyMuPDF,
 * since that is an install step, not a code defect; `npm run setup:pdf` fixes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractPdf, readRawPage, resolvePython } from "../src/lib/pdf/extract";
import { bodyFontSize, linesFromOcr, linesFromRaw, needsOcr, structurePages, type LinedPage } from "../src/lib/pdf/page-text";
import { detectSections } from "../src/lib/analysis/sections";
import { chunkSections } from "../src/lib/analysis/chunks";
import { measurePage, disposeOcr } from "../src/lib/ingest/ocr";
import { createPdfUpload } from "../src/lib/pdf/create-pdf-upload";
import { prisma } from "../src/lib/db";
import { uploadDir } from "../src/lib/paths";
import type { RawPdfPage } from "../src/lib/analysis/types";

const MAKE = path.join(process.cwd(), "scripts", "fixtures", "make-book-pdf.py");

const CHAPTERS = [
  {
    title: "The Surprising Power of Tiny Gains",
    paragraphs: [
      "Small improvements compound over time when they are repeated consistently every single day, and the accumulated effect of tiny choices becomes extraordinary over the years.",
      "A plane leaving Los Angeles for New York that shifts its heading by three and a half degrees lands in Washington instead. Small changes in direction produce very different destinations.",
      "Success is the product of daily habits, not once in a lifetime transformations. Your outcomes are a lagging measure of your habits.",
    ],
  },
  {
    title: "Why Motivation Fails",
    paragraphs: [
      "Motivation is unreliable because it rises and falls with mood, sleep and circumstance, while systems keep working on the days when you do not feel like it.",
      "Environment design matters more than motivation because the cues around us trigger behaviour automatically, long before any conscious decision is made.",
    ],
  },
];

let py: { bin: string; args: string[] } | null = null;
let dir = "";

test.before(async () => {
  try {
    py = await resolvePython();
  } catch {
    py = null;
    return;
  }
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bookreel-pdf-"));
  const chapters = path.join(dir, "chapters.json");
  // Repeat the paragraphs so each chapter runs over several pages.
  await fs.writeFile(chapters, JSON.stringify(CHAPTERS.map((c) => ({ ...c, paragraphs: [...c.paragraphs, ...c.paragraphs, ...c.paragraphs] }))));
  execFileSync(py.bin, [...py.args, MAKE, "text", path.join(dir, "book.pdf"), chapters, "--toc"], { windowsHide: true });
  execFileSync(py.bin, [...py.args, MAKE, "text", path.join(dir, "no-toc.pdf"), chapters], { windowsHide: true });
  execFileSync(py.bin, [...py.args, MAKE, "scan", path.join(dir, "book.pdf"), path.join(dir, "scan.pdf"), "--dpi", "200"], { windowsHide: true });
});

test.after(async () => {
  await disposeOcr().catch(() => {});
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function extract(name: string): Promise<{ raws: RawPdfPage[]; toc: { level: number; title: string; page: number }[] }> {
  const out = path.join(dir, `${name}-out`);
  let last = 0;
  const manifest = await extractPdf(path.join(dir, `${name}.pdf`), out, (p) => {
    assert.ok(p.done > last, "progress only moves forward");
    last = p.done;
  });
  assert.equal(last, manifest.pageCount, "progress reported for every page");
  const raws: RawPdfPage[] = [];
  for (let i = 0; i < manifest.pageCount; i++) raws.push(await readRawPage(out, i));
  return { raws, toc: manifest.toc };
}

function lined(raws: RawPdfPage[]): LinedPage[] {
  return raws.map((r) => ({
    pageIndex: r.index, label: r.label || null, width: r.width, height: r.height,
    lines: linesFromRaw(r), source: "text-layer", ocrConfidence: null,
  }));
}

test("a text PDF: outline chapters, no running heads, grounded word coordinates", async (t) => {
  if (!py) return t.skip("no Python with PyMuPDF");
  const { raws, toc } = await extract("book");
  assert.ok(raws.length >= 5, `${raws.length} pages`);
  assert.ok(raws.every((r) => !needsOcr(r)));
  assert.ok(raws.every((r) => Math.max(r.width, r.height) === 1600), "pages render at the composition size");

  const pages = structurePages(lined(raws), bodyFontSize(raws));
  const all = pages.flatMap((p) => p.words).join(" ");
  assert.ok(!/SURPRISING POWER/.test(all), "the upper-case running head never reaches the body text");
  assert.match(all, /Small improvements compound over time/);
  for (const p of pages) {
    assert.ok(!p.words.some((w) => /^\d{1,3}$/.test(w)), `page ${p.pageIndex + 1} has no stray page number: ${p.words.slice(-3)}`);
    if (p.words.length) assert.ok(p.alignmentConfidence > 0.97, `page ${p.pageIndex + 1} alignment ${p.alignmentConfidence}`);
  }

  const sections = detectSections(pages, toc);
  assert.deepEqual(
    sections.filter((s) => !s.skip).map((s) => s.title),
    CHAPTERS.map((c) => c.title),
  );
  assert.equal(sections[0].skip, true, "title and contents pages are front matter");
  const chunks = chunkSections(pages, sections);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => sections[c.sectionIndex].skip === false));
});

test("a text PDF with no outline: chapters come from its headings", async (t) => {
  if (!py) return t.skip("no Python with PyMuPDF");
  const { raws, toc } = await extract("no-toc");
  assert.equal(toc.length, 0);
  const pages = structurePages(lined(raws), bodyFontSize(raws));
  const sections = detectSections(pages, toc).filter((s) => !s.skip);
  assert.deepEqual(sections.map((s) => s.title), CHAPTERS.map((c, i) => `Chapter ${i + 1}: ${c.title}`));
  assert.ok(sections.every((s) => s.source === "heading"));
});

test("a scanned PDF: every page needs OCR, and OCR recovers the text", async (t) => {
  if (!py) return t.skip("no Python with PyMuPDF");
  const { raws } = await extract("scan");
  assert.ok(raws.every(needsOcr), "an image-only PDF has no text layer");

  const out = path.join(dir, "scan-out");
  const target = raws.find((r) => r.index === 2)!; // first chapter page
  const ocr = await measurePage(path.join(out, target.image));
  const page: LinedPage = {
    pageIndex: 2, label: null, width: target.width, height: target.height,
    lines: linesFromOcr(ocr), source: "ocr", ocrConfidence: null,
  };
  const [structured] = structurePages([page], 0);
  const text = structured.words.join(" ").toLowerCase();
  assert.match(text, /small improvements compound over time/);
  const mean = ocr.reduce((s, w) => s + w.confidence, 0) / ocr.length;
  assert.ok(mean > 70, `mean OCR confidence ${mean.toFixed(1)}`);
  assert.equal(structured.headings[0]?.text.startsWith("Chapter 1"), true, "the chapter opener is recognised on an OCR'd page");
});

test("an upload streams a PDF to disk and refuses anything else, leaving nothing behind", async (t) => {
  if (!py) return t.skip("no Python with PyMuPDF");
  const bytes = await fs.readFile(path.join(dir, "book.pdf"));
  const body = new Blob([new Uint8Array(bytes)]).stream();
  const r = await createPdfUpload({ title: "PDF fixture book", body }, null);
  try {
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: r.uploadId } });
    assert.equal(upload.kind, "pdf");
    assert.equal((await fs.stat(upload.sourcePath!)).size, bytes.length);
  } finally {
    await prisma.book.delete({ where: { id: r.bookId } });
    await fs.rm(uploadDir(r.uploadId), { recursive: true, force: true });
  }

  await assert.rejects(
    () => createPdfUpload({ title: "Not a PDF fixture", body: new Blob(["hello, I am text"]).stream() }, null),
    (err: Error & { code?: string }) => err.code === "bad_upload" && /not a PDF/.test(err.message),
  );
  assert.equal(await prisma.book.findFirst({ where: { title: "Not a PDF fixture" } }), null);
});

/** An n-page PDF with a sentence per page, built directly with PyMuPDF. */
function plainPdf(file: string, pages: number) {
  const code = `import pymupdf, sys
d = pymupdf.open()
for i in range(${pages}):
    p = d.new_page(width=432, height=648)
    p.insert_text((54, 120), "Page %d says that small habits compound into remarkable results over time." % (i + 1), fontsize=11)
d.save(sys.argv[1])`;
  execFileSync(py!.bin, [...py!.args, "-c", code, file], { windowsHide: true });
}

test("page bounds: a 1-page and a 200-page PDF are accepted, a 201-page PDF is refused", async (t) => {
  if (!py) return t.skip("no Python with PyMuPDF");
  for (const n of [1, 200]) {
    const file = path.join(dir, `plain-${n}.pdf`);
    plainPdf(file, n);
    const manifest = await extractPdf(file, path.join(dir, `plain-${n}-out`), () => {});
    assert.equal(manifest.pageCount, n);
  }

  // A one-page book still reaches chunks: it is analysed, not refused.
  const raw = await readRawPage(path.join(dir, "plain-1-out"), 0);
  const pages = structurePages(lined([raw]), bodyFontSize([raw]));
  const sections = detectSections(pages, []);
  assert.equal(sections.length, 1);
  // One sentence is under the 30-word floor for a section worth mining; a real
  // one-page chapter is not, so repeat it to a page's worth and check again.
  pages[0].text.paragraphs = Array(8).fill(pages[0].text.paragraphs[0]);
  pages[0].words = pages[0].text.paragraphs.join(" ").split(/\s+/);
  assert.ok(chunkSections(pages, detectSections(pages, [])).length >= 1);

  const over = path.join(dir, "plain-201.pdf");
  plainPdf(over, 201);
  await assert.rejects(
    () => extractPdf(over, path.join(dir, "plain-201-out"), () => {}),
    (err: Error & { code?: string }) =>
      err.code === "pdf_too_many_pages" && err.message === "This PDF has 201 pages; at most 200 can be analysed at once.",
  );
});

test("an encrypted or broken PDF fails with a sentence, not a traceback", async (t) => {
  if (!py) return t.skip("no Python with PyMuPDF");
  const broken = path.join(dir, "broken.pdf");
  await fs.writeFile(broken, "%PDF-1.7\nthis is not really a pdf");
  await assert.rejects(
    () => extractPdf(broken, path.join(dir, "broken-out"), () => {}),
    (err: Error & { code?: string }) => err.code === "pdf_unreadable" && /could not be opened as a PDF/.test(err.message),
  );
});
