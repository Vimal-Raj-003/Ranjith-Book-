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
 *   - a script length chosen from the idea's content: 45, 60 or up to 90 seconds.
 */
import { prisma, getSetting } from "../db";
import { VOICES } from "../strings";
import { isBookThemeId } from "../video/composition/themes";
import { themeForTextSync } from "../video/composition/themes/choose";
import {
  chooseAutoReelModel,
  isReelModelId,
  isReelModelSetting,
  preferredThemeForReelModel,
  REEL_MODEL_AUTO,
  type ReelModelId,
} from "../video/reel-models";
import type { IdeaBrief } from "../content/schema";
import { VIDEO_MAX_SECONDS, VIDEO_MIN_HARD_SECONDS, VIDEO_MIN_TARGET_SECONDS, videoSecondsVerdict } from "../content/duration";
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

/**
 * The finished video's target (45–90 s) and the hard limits outside which nothing
 * is rendered. 90 s is a ceiling that is never exceeded; how long a given video is
 * within it is chosen from its content (content/duration.ts).
 */
export const IDEA_VIDEO_TARGET = { min: VIDEO_MIN_TARGET_SECONDS, max: VIDEO_MAX_SECONDS };
export const IDEA_VIDEO_HARD = { min: VIDEO_MIN_HARD_SECONDS, max: VIDEO_MAX_SECONDS };

/** "ok" inside the target, "note" just short of it, "fail" past the hard limits. */
export function ideaVideoDuration(seconds: number): "ok" | "note" | "fail" {
  return videoSecondsVerdict(seconds);
}

/**
 * The fields of an idea that say what it is ABOUT, which is what its theme is
 * chosen from. All five are non-null `String` columns on `ContentIdea`.
 *
 * `sourceText` — the raw page extract — is deliberately not here. It is the
 * longest field and the least about the idea: a page carries the book's own
 * incidental vocabulary (a chapter heading, a footnote, whatever example the
 * author happened to use), and letting a few hundred words of that outvote the
 * four sentences written specifically to state the idea is how the choice
 * drifts back towards "whatever word appeared most".
 */
export interface IdeaTheme {
  title: string;
  hook: string;
  coreIdea: string;
  angle: string;
  whyItMatters: string;
}

export function ideaThemeText(idea: IdeaTheme): string {
  return [idea.title, idea.hook, idea.coreIdea, idea.angle, idea.whyItMatters].join(" ");
}

export interface CreatedEpisode {
  ideaId: string;
  episodeId: string;
  /** False when the idea already had a queued, running or finished episode. */
  created: boolean;
  status: string;
}

const ACTIVE_OR_DONE = new Set(["QUEUED", "RUNNING", "DONE"]);

/** All 32 studio narrator voices (20 Gemini 3.8 Studio + 12 Classic Studio) in rotation order for `"auto"` voice mode. */
const STUDIO_VOICE_ROTATION = VOICES.map((v) => v.id);

const VALID_STUDIO_VOICES = new Set<string>(STUDIO_VOICE_ROTATION);

function pickAutoVoice(textSeed: string, usedVoices: string[], idx: number): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < textSeed.length; i++) {
    h ^= textSeed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const available = STUDIO_VOICE_ROTATION.filter((v) => !usedVoices.includes(v));
  const pool = available.length > 0 ? available : [...STUDIO_VOICE_ROTATION];
  return pool[(h + idx * 7) % pool.length];
}

/**
 * One queued Episode per idea. An idea that already has a queued, running or
 * finished episode is returned as-is rather than duplicated — a second click
 * on "Generate videos" must not render the same video twice. A FAILED episode
 * does not count, so generating again after a failure starts a fresh run.
 */
export interface CreateIdeaEpisodesOptions {
  /** Batch-wide model override (`"auto"` or one of the `ReelModelId`s). */
  reelModel?: string | null;
  /** Optional per-idea model override (`ideaId -> "auto" | ReelModelId`). */
  perIdeaModels?: Record<string, string> | null;
  /** Batch-wide voice mode (`"auto"`, `"inspector"`, or a specific voice id). */
  voiceMode?: string | null;
  /** Optional per-idea voice override (`ideaId -> "auto" | voiceId`). */
  perIdeaVoices?: Record<string, string> | null;
}

export async function createIdeaEpisodes(
  uploadId: string,
  ideaIds: string[],
  userId: string | null,
  opts?: CreateIdeaEpisodesOptions,
): Promise<CreatedEpisode[]> {
  const ideas = await prisma.contentIdea.findMany({
    where: { id: { in: ideaIds }, uploadId },
    include: { episodes: { orderBy: { createdAt: "desc" } } },
  });
  const settingTheme = await getSetting("theme");
  const fixedTheme = isBookThemeId(settingTheme) ? settingTheme : null;
  const settingReelModel = await getSetting("reelModel");
  const fallbackModelPref = isReelModelSetting(opts?.reelModel)
    ? opts.reelModel
    : isReelModelSetting(settingReelModel)
      ? settingReelModel
      : REEL_MODEL_AUTO;

  // Seed `usedModels` and `usedVoices` with the most recently created episode so
  // consecutive single-video `"auto"` runs never repeat the exact same model or voice twice in a row.
  const recentEpisode = await prisma.episode.findFirst({
    where: { OR: [{ reelStyle: { not: null } }, { voiceId: { not: null } }] },
    orderBy: { createdAt: "desc" },
    select: { reelStyle: true, voiceId: true },
  });
  const usedModels: ReelModelId[] = [];
  if (recentEpisode?.reelStyle && isReelModelId(recentEpisode.reelStyle)) {
    usedModels.push(recentEpisode.reelStyle);
  }
  const usedVoices: string[] = [];
  if (recentEpisode?.voiceId && VALID_STUDIO_VOICES.has(recentEpisode.voiceId)) {
    usedVoices.push(recentEpisode.voiceId);
  }

  const out: CreatedEpisode[] = [];
  let createdIdx = 0;
  for (const id of ideaIds) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) continue;
    const existing = idea.episodes.find((e) => ACTIVE_OR_DONE.has(e.status));
    if (existing) {
      out.push({ ideaId: id, episodeId: existing.id, created: false, status: existing.status });
      continue;
    }

    const perIdeaRaw = opts?.perIdeaModels?.[id];
    const requestedModel = isReelModelSetting(perIdeaRaw) ? perIdeaRaw : fallbackModelPref;
    const textForChoice = ideaThemeText(idea);
    const chosenModel: ReelModelId = isReelModelId(requestedModel)
      ? requestedModel
      : chooseAutoReelModel(textForChoice, usedModels, createdIdx);

    if (usedModels.length >= 10) usedModels.length = 0;
    if (!usedModels.includes(chosenModel)) usedModels.push(chosenModel);

    // Resolve per-episode voice (`perIdeaVoices` -> `voiceMode` -> null = Inspector setting)
    const perVoiceRaw = opts?.perIdeaVoices?.[id]?.trim();
    const batchVoiceRaw = opts?.voiceMode?.trim();
    const effectiveVoicePref = perVoiceRaw || batchVoiceRaw || null;
    let chosenVoiceId: string | null = null;
    if (effectiveVoicePref && VALID_STUDIO_VOICES.has(effectiveVoicePref)) {
      chosenVoiceId = effectiveVoicePref;
    } else if (effectiveVoicePref === "auto") {
      chosenVoiceId = pickAutoVoice(textForChoice, usedVoices, createdIdx);
    }
    if (chosenVoiceId) {
      if (usedVoices.length >= STUDIO_VOICE_ROTATION.length) usedVoices.length = 0;
      if (!usedVoices.includes(chosenVoiceId)) usedVoices.push(chosenVoiceId);
    }

    createdIdx += 1;

    const chosenTheme =
      fixedTheme ??
      (isReelModelId(chosenModel) ? preferredThemeForReelModel(chosenModel) : themeForTextSync(textForChoice));

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
        theme: chosenTheme,
        reelStyle: chosenModel,
        ...(chosenVoiceId ? { voiceId: chosenVoiceId } : {}),
        status: "QUEUED",
        step: "Queued",
      },
    });
    out.push({ ideaId: id, episodeId: episode.id, created: true, status: episode.status });
  }
  return out;
}
