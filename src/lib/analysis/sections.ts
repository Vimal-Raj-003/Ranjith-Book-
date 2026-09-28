/**
 * Where the chapters are. Three sources, most to least trustworthy:
 *
 *   1. The PDF outline (bookmarks) — the publisher's own table of contents.
 *   2. Headings found on the pages — large type, or "Chapter N", near the top.
 *   3. Fixed runs of pages — when a book has neither, sections are still needed
 *      so ideas spread across the whole book rather than clustering.
 *
 * Front and back matter (contents, copyright, index, notes…) is marked `skip`:
 * it is kept for page references but never mined for video ideas.
 */
import type { SectionPlan, StructuredPage, TocEntry } from "./types";

const FALLBACK_PAGES = 10;

const MATTER_RE =
  /^(table of )?contents$|^copyright|^acknowledg|^index$|^bibliography|^references$|^(end)?notes$|^about the (author|authors|publisher)|^also by|^dedication|^praise for|^title page|^cover$|^half[- ]title|^epigraph|^permissions|^credits|^further reading|^glossary$|^list of (figures|tables|illustrations)/i;

export function isMatterTitle(title: string): boolean {
  return MATTER_RE.test(title.trim().replace(/[^\p{L}\p{N}\s'-]/gu, "").trim());
}

function wordsIn(pages: StructuredPage[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i <= end && i < pages.length; i++) n += pages[i].words.length;
  return n;
}

/** Turn ordered (title, startPage) pairs into contiguous sections. */
function fromStarts(
  starts: { title: string; page: number; level: number }[],
  pages: StructuredPage[],
  source: SectionPlan["source"],
): SectionPlan[] {
  const last = pages.length - 1;
  const sorted = [...starts].sort((a, b) => a.page - b.page);

  // Two entries on one page ("Part One" then "Chapter 1") are one section.
  const merged: typeof sorted = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.page === s.page) prev.title = `${prev.title}: ${s.title}`;
    else merged.push({ ...s });
  }

  const plans: Omit<SectionPlan, "index">[] = [];
  if (merged.length && merged[0].page > 0) {
    plans.push({
      title: "Front matter",
      level: 1,
      startPage: 0,
      endPage: merged[0].page - 1,
      source,
      skip: true,
      wordCount: 0,
    });
  }
  merged.forEach((s, i) => {
    const endPage = i + 1 < merged.length ? merged[i + 1].page - 1 : last;
    plans.push({ title: s.title, level: s.level, startPage: s.page, endPage, source, skip: false, wordCount: 0 });
  });

  return plans.map((p, index) => {
    const wordCount = wordsIn(pages, p.startPage, p.endPage);
    return { ...p, index, wordCount, skip: p.skip || isMatterTitle(p.title) || wordCount < 30 };
  });
}

function fromToc(toc: TocEntry[], pages: StructuredPage[]): SectionPlan[] | null {
  const valid = toc.filter((e) => e.page >= 0 && e.page < pages.length && e.title.trim());
  for (const level of [1, 2]) {
    const entries = valid.filter((e) => e.level === level);
    // A single level-1 entry ("Part One") covering everything says nothing
    // about where the chapters are; try the next level down.
    if (entries.length >= 2) {
      return fromStarts(entries.map((e) => ({ title: e.title.trim(), page: e.page, level })), pages, "toc");
    }
  }
  return null;
}

function fromHeadings(pages: StructuredPage[]): SectionPlan[] | null {
  // A chapter opens near the top of a page. A heading lower down is a
  // subsection, which is too fine a grain for spreading ideas across a book.
  const openers = pages
    .map((p) => ({ page: p.pageIndex, heading: p.headings.find((h) => h.top < 0.45) }))
    .filter((o): o is { page: number; heading: NonNullable<typeof o.heading> } => !!o.heading);
  if (openers.length < 2) return null;

  // If most pages "open a chapter", the size threshold is catching subheads.
  // Raise it, one heading size at a time, to the lowest size that leaves at
  // most one opener per two pages — chapters are the biggest headings that
  // still occur more than once. Short books are exempt: in eight pages a
  // title page, a contents page and three chapters really are five openers.
  let chosen = openers;
  if (pages.length >= 12 && openers.length > pages.length / 2) {
    const scales = [...new Set(openers.map((o) => Math.round(o.heading.scale * 20) / 20))].sort((a, b) => a - b);
    chosen = [];
    for (const s of scales) {
      const set = openers.filter((o) => o.heading.scale >= s - 0.001);
      if (set.length >= 2 && set.length <= pages.length / 2) {
        chosen = set;
        break;
      }
    }
    if (chosen.length < 2) return null;
  }
  return fromStarts(chosen.map((o) => ({ title: o.heading.text, page: o.page, level: 1 })), pages, "heading");
}

function fallback(pages: StructuredPage[]): SectionPlan[] {
  const plans: SectionPlan[] = [];
  for (let start = 0; start < pages.length; start += FALLBACK_PAGES) {
    const end = Math.min(pages.length - 1, start + FALLBACK_PAGES - 1);
    const wordCount = wordsIn(pages, start, end);
    plans.push({
      index: plans.length,
      title: start === end ? `Page ${start + 1}` : `Pages ${start + 1}–${end + 1}`,
      level: 1,
      startPage: start,
      endPage: end,
      source: "fallback",
      skip: wordCount < 30,
      wordCount,
    });
  }
  return plans;
}

export function detectSections(pages: StructuredPage[], toc: TocEntry[]): SectionPlan[] {
  if (pages.length === 0) return [];
  return fromToc(toc, pages) ?? fromHeadings(pages) ?? fallback(pages);
}

/** The section a page belongs to. Sections are contiguous and cover every page. */
export function sectionOfPage(sections: SectionPlan[], pageIndex: number): SectionPlan | undefined {
  return sections.find((s) => pageIndex >= s.startPage && pageIndex <= s.endPage);
}
