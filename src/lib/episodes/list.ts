import { prisma } from "@/lib/db";
import { parseThumbnails } from "@/lib/thumbnails/store";
import { publicThumbs, type PublicThumb } from "@/lib/episode-view";

export interface EpisodeListItem {
  id: string;
  title: string | null;
  status: string;
  step: string;
  theme: string;
  partNumber: number;
  seriesTotal: number;
  durationSec: number | null;
  createdAt: Date;
  bookTitle: string;
  thumbnails: PublicThumb[];
}

/**
 * The library listing, as a plain function of the viewer.
 *
 * This lives outside the route handler for the same reason `createUpload`
 * does: `requireUser()` reads `cookies()`, which throws outside a request
 * scope, so a test that calls the route directly can only ever assert on that
 * throw. Keeping the query here lets the visibility rule — the security-
 * relevant part — be tested directly, and leaves the route responsible for
 * exactly one thing: establishing who is asking.
 *
 * Visibility matches `GET /api/episodes/[id]` exactly: an episode is visible
 * when it has no owner, or when its owner is the viewer. Episodes created
 * before sign-in existed carry no `userId`, and excluding them would empty
 * the operator's own library.
 */
export async function listEpisodes(userId: string): Promise<EpisodeListItem[]> {
  const rows = await prisma.episode.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { book: { select: { title: true } } },
  });

  return rows.map((e) => ({
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
    // Lets the library grid show a real poster instead of a placeholder.
    thumbnails: publicThumbs(parseThumbnails(e)),
  }));
}
