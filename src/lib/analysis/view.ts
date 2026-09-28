/**
 * What the ideas screen is sent. Scores stay on the server: the operator sees
 * ideas in ranked order, not the arithmetic behind the order (the spec is
 * explicit that the scoring detail is internal). Page numbers go out 1-based,
 * with the book's own printed label when it has one, because "p. 37" should
 * mean the page a reader would turn to.
 */
import type { ContentIdea, Episode, Page, Upload, Book } from "@prisma/client";
import type { SourceRef } from "./types";
import type { AnalysisView, IdeaView } from "@/components/types";

export type { AnalysisView, IdeaView, AnalysisSummary, IdeaSourcePage } from "@/components/types";

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

type IdeaRow = ContentIdea & { episodes?: Pick<Episode, "id" | "status" | "createdAt">[] };

export function ideaView(idea: IdeaRow, pages: Pick<Page, "id" | "pageIndex" | "pageLabel">[]): IdeaView {
  const byIndex = new Map(pages.map((p) => [p.pageIndex, p]));
  const refs = parse<SourceRef[]>(idea.sourceRefs, []);
  const indices = parse<number[]>(idea.sourcePages, [...new Set(refs.map((r) => r.pageIndex))]);
  return {
    id: idea.id,
    rank: idea.rank,
    title: idea.title,
    hook: idea.hook,
    coreIdea: idea.coreIdea,
    whyItMatters: idea.whyItMatters,
    angle: idea.angle,
    hookPotential: idea.hookPotential,
    storyPotential: idea.storyPotential,
    practicalValue: idea.practicalValue,
    visualPotential: idea.visualPotential,
    sectionTitle: idea.sectionTitle,
    sourcePages: indices.map((i) => {
      const page = byIndex.get(i);
      const label = page?.pageLabel && page.pageLabel !== String(i + 1) ? page.pageLabel : null;
      return { number: i + 1, label, pageId: page?.id ?? null };
    }),
    relatedPages: parse<number[]>(idea.relatedPages, []).map((i) => i + 1),
    sourceText: idea.sourceText,
    selected: idea.status === "SELECTED",
    episode: latestEpisode(idea.episodes),
  };
}

function latestEpisode(episodes: IdeaRow["episodes"]): IdeaView["episode"] {
  if (!episodes?.length) return null;
  const latest = [...episodes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return { id: latest.id, status: latest.status };
}

export function analysisView(
  upload: Upload & { book: Book; ideas: IdeaRow[]; pages: Pick<Page, "id" | "pageIndex" | "pageLabel">[] },
): AnalysisView {
  return {
    id: upload.id,
    bookTitle: upload.book.title,
    status: upload.status,
    step: upload.step,
    error: upload.error,
    progress: parse(upload.progress, null),
    notes: parse<string[]>(upload.notes, []),
    pageCount: upload.pageCount,
    stats: parse(upload.stats, null),
    ideas: [...upload.ideas].sort((a, b) => a.rank - b.rank).map((i) => ideaView(i, upload.pages)),
    createdAt: upload.createdAt.toISOString(),
  };
}
