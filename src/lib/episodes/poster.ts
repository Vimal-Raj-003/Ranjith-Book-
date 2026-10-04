import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { posterFields, publicThumbs } from "@/lib/episode-view";
import { generateThumbnails, parseThumbnails, serializeThumbnails, thumbsDir, type ThumbSpec } from "@/lib/thumbnails";
import { normaliseHeadline } from "@/lib/thumbnails/choose";
import { loadPosterSource } from "@/lib/thumbnails/source";
import { gridDir, THUMB_KEYS } from "@/lib/thumbnails/types";

export interface PosterEditResult {
  status: number;
  body: Record<string, unknown>;
}

const refuse = (status: number, code: string, error: string): PosterEditResult => ({ status, body: { error, code } });

/**
 * Choose which poster represents an episode, and/or retitle all of them.
 *
 * This lives outside the route handler for the same reason `listEpisodes` does:
 * the route's other job is `currentUser()`, which reads `cookies()` and cannot
 * run outside a request, so the rules -- the part worth testing -- stay here.
 *
 * `body.choice` records a selection and renders nothing. `body.headline`
 * redraws ALL SIX posters (three variants, both aspects) with that headline,
 * and stores it. Not one variant: `thumbHeadline` is a single value on the
 * episode, so a retitle that reached only some posters would leave the rest
 * contradicting the field the operator reads it back from. An empty headline
 * means "go back to the generated one" and redraws just the same.
 *
 * Everything is validated before anything is rendered or written, and the row
 * is updated once, so a request is applied whole or not at all.
 *
 * `deps.render` is for tests; production always uses `generateThumbnails`.
 */
export async function editPoster(
  userId: string,
  episodeId: string,
  body: unknown,
  deps: { render?: typeof generateThumbnails } = {},
): Promise<PosterEditResult> {
  const episode = await prisma.episode.findFirst({ where: { id: episodeId, userId } });
  if (!episode) return refuse(404, "not_found", "Not found");

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(400, "bad_body", "Expected a JSON object.");
  }
  const { choice, headline } = body as { choice?: unknown; headline?: unknown };
  const specs = parseThumbnails(episode);

  // Validated against the keys this episode actually has, the same rule the
  // delivery route applies. An unknown key is a 400, not a stored value that
  // would later resolve to nothing.
  if (choice !== undefined && (typeof choice !== "string" || !specs.some((s) => s.key === choice))) {
    return refuse(400, "bad_choice", "That is not a poster on this episode.");
  }

  const data: { thumbChoice?: string | null; thumbnails?: string; thumbHeadline?: string | null } = {};
  if (typeof choice === "string") data.thumbChoice = choice;

  let failed = 0;
  if (headline !== undefined) {
    const override = normaliseHeadline(headline);

    // A redo needs the script, the plan and the page photograph the original
    // used, all reachable from the episode row. If any is gone -- an old
    // episode whose work dir was cleaned up -- say so plainly rather than draw
    // a poster with no photograph on it.
    const pages = await prisma.page.findMany({
      where: { uploadId: episode.uploadId },
      select: { pageIndex: true, filePath: true, derivedPath: true, width: true, height: true },
      orderBy: { pageIndex: "asc" },
    });
    const source = await loadPosterSource(episode, pages);
    if (!source) {
      return refuse(409, "no_source", "The source pages for this episode are no longer available, so its posters cannot be redrawn.");
    }

    let rendered: ThumbSpec[] = [];
    try {
      rendered = await (deps.render ?? generateThumbnails)({
        episodeId,
        pkg: source.pkg,
        pages: source.pages,
        focus: source.focus,
        theme: source.theme,
        headline: override,
        outDir: thumbsDir(episodeId),
      });
    } catch (err) {
      console.warn(`[thumbnails] retitle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Nothing drawn means nothing on disk changed and nothing should be
    // recorded: keep the posters the operator already has.
    if (rendered.length === 0) {
      return refuse(500, "render_failed", "The posters could not be redrawn, so nothing was changed.");
    }

    // A revision must move forward for a key that already has one. It is a file
    // mtime, and on a coarse-grained or network file system two writes inside
    // one tick report the same value; reused, the URL would not change and the
    // browser would keep the first headline, `immutable`, for a year -- the
    // full-resolution download included. The previous revision comes from the
    // row, not the disk, so this holds however the clock behaves.
    const was = new Map(specs.map((s) => [s.key, s.rev]));
    const kept = rendered.map((r) => ({ ...r, rev: Math.max(r.rev, (was.get(r.key) ?? -1) + 1) }));

    // Only posters that carry the new headline are kept. A poster that failed
    // to redraw would still show the old words, contradicting the stored
    // headline, so it is dropped rather than left stale. `failed` tells the
    // operator how many that was.
    failed = Math.max(0, THUMB_KEYS.length - kept.length);
    data.thumbnails = serializeThumbnails(kept);
    data.thumbHeadline = override;

    // The same reasoning for the choice: one that names a poster that was just
    // dropped would disagree with the tile marked "In use". `pickPoster`
    // already degrades to the default silently, so nothing breaks either way;
    // this keeps the column telling the truth. It covers a choice sent in this
    // very request as well as an earlier one.
    const chosen = typeof choice === "string" ? choice : episode.thumbChoice;
    if (chosen && !kept.some((k) => k.key === chosen)) data.thumbChoice = null;

    // The grid derivative is a pure function of the poster it came from and
    // `deriveGrid` would notice the newer original on its own; removing it is
    // belt and braces against a filesystem whose timestamps are too coarse to.
    await Promise.all(kept.map((r) => fs.rm(path.join(gridDir(episodeId), `${r.key}.webp`), { force: true }).catch(() => {})));
  }

  const after = Object.keys(data).length > 0 ? await prisma.episode.update({ where: { id: episodeId }, data }) : episode;
  return {
    status: 200,
    body: { thumbnails: publicThumbs(parseThumbnails(after)), ...posterFields(after), failed },
  };
}
