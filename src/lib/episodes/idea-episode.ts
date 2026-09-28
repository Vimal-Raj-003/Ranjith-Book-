/**
 * Phase 3a: a selected ContentIdea becomes an Episode, and the Episode is run
 * by the same `runEpisode` a photographed page is — same writer, grounding
 * check, quotation budget, voice, composition and renderer. What an idea adds
 * is only this:
 *
 *   - the pages the writer sees: the idea's own source pages first, then the
 *     related pages book analysis retrieved, capped — never the whole book;
 *   - a brief of the idea, with its located quotes, so the script is about
 *     THAT idea;
 *   - the long (1–2 minute) script length.
 */
import { prisma, getSetting } from "../db";
import { isBookThemeId, DEFAULT_BOOK_THEME_ID } from "../video/composition/themes";
import type { IdeaBrief } from "../content/schema";
import type { SourceRef } from "../analysis/types";

/** Pages a writer is shown for one idea. Eight pages is ~2,500 words. */
export const MAX_IDEA_PAGES = 8;

export interface IdeaSource {
  pageIndices: number[];
  brief: IdeaBrief;
}

export interface IdeaLike {
  title: string;
  coreIdea: string;
  hook: string;
  whyItMatters: string;
  sourcePages: string;
  sourceRefs: string;
  relatedPages: string | null;
}

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Which pages, and what brief. Source pages always come first and are never
 * dropped for a related one; related pages fill what room is left, in the
 * order analysis ranked them. Only pages that actually have text are used.
 */
export function ideaEpisodeSource(
  idea: IdeaLike,
  pagesWithText: { pageIndex: number; words: string[] }[],
): IdeaSource {
  const byIndex = new Map(pagesWithText.map((p) => [p.pageIndex, p]));
  const refs = parse<SourceRef[]>(idea.sourceRefs, []);
  const source = parse<number[]>(idea.sourcePages, [...new Set(refs.map((r) => r.pageIndex))]);
  const related = parse<number[]>(idea.relatedPages, []);

  const chosen: number[] = [];
  for (const p of [...source, ...related]) {
    if (chosen.length >= MAX_IDEA_PAGES) break;
    if (!chosen.includes(p) && (byIndex.get(p)?.words.length ?? 0) > 0) chosen.push(p);
  }
  if (!source.some((p) => chosen.includes(p))) {
    throw new Error(`The pages this idea came from (${source.map((p) => p + 1).join(", ")}) have no readable text.`);
  }

  const quotes = refs
    .filter((r) => chosen.includes(r.pageIndex))
    .map((r) => ({
      ...r,
      text: byIndex.get(r.pageIndex)!.words.slice(r.startWord, r.endWord + 1).join(" "),
    }));

  return {
    pageIndices: chosen.sort((a, b) => a - b),
    brief: {
      title: idea.title,
      coreIdea: idea.coreIdea,
      hook: idea.hook,
      whyItMatters: idea.whyItMatters,
      quotes,
    },
  };
}

/** The finished video's target, and the hard limits outside which nothing is rendered. */
export const IDEA_VIDEO_TARGET = { min: 60, max: 120 };
export const IDEA_VIDEO_HARD = { min: 50, max: 130 };

/** "ok" inside the target, "note" just outside it, "fail" past the hard limits. */
export function ideaVideoDuration(seconds: number): "ok" | "note" | "fail" {
  if (seconds < IDEA_VIDEO_HARD.min || seconds > IDEA_VIDEO_HARD.max) return "fail";
  if (seconds < IDEA_VIDEO_TARGET.min || seconds > IDEA_VIDEO_TARGET.max) return "note";
  return "ok";
}

export interface CreatedEpisode {
  ideaId: string;
  episodeId: string;
  /** False when the idea already had a queued, running or finished episode. */
  created: boolean;
  status: string;
}

const ACTIVE_OR_DONE = new Set(["QUEUED", "RUNNING", "DONE"]);

/**
 * One queued Episode per idea. An idea that already has a queued, running or
 * finished episode is returned as-is rather than duplicated — a second click
 * on "Generate videos" must not render the same video twice. A FAILED episode
 * does not count, so generating again after a failure starts a fresh run.
 */
export async function createIdeaEpisodes(
  uploadId: string,
  ideaIds: string[],
  userId: string | null,
): Promise<CreatedEpisode[]> {
  const ideas = await prisma.contentIdea.findMany({
    where: { id: { in: ideaIds }, uploadId },
    include: { episodes: { orderBy: { createdAt: "desc" } } },
  });
  const settingTheme = await getSetting("theme");
  const theme = isBookThemeId(settingTheme) ? settingTheme : DEFAULT_BOOK_THEME_ID;

  const out: CreatedEpisode[] = [];
  for (const id of ideaIds) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) continue;
    const existing = idea.episodes.find((e) => ACTIVE_OR_DONE.has(e.status));
    if (existing) {
      out.push({ ideaId: id, episodeId: existing.id, created: false, status: existing.status });
      continue;
    }
    const episode = await prisma.episode.create({
      data: {
        bookId: idea.bookId,
        uploadId,
        userId: userId ?? undefined,
        kind: "idea",
        format: "9:16",
        contentIdeaId: idea.id,
        ideaKey: idea.ideaKey,
        title: idea.title,
        theme,
        status: "QUEUED",
        step: "Queued",
      },
    });
    out.push({ ideaId: id, episodeId: episode.id, created: true, status: episode.status });
  }
  return out;
}
