import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db";
import { WORK_ROOT } from "../paths";
import { canSee, visibleTo } from "./visibility";
import { compareAttempts, videoIdentity, type AttemptHistoryItem } from "./attempt-groups";

/** Read-only history: existing rows plus snapshots saved by the existing retry path. */
export async function readAttemptHistory(episodeId: string, userId: string) {
  const requested = await prisma.episode.findUnique({ where: { id: episodeId } });
  if (!canSee(requested, userId)) return null;
  const candidates = await prisma.episode.findMany({
    where: { bookId: requested.bookId, ...visibleTo(userId),
      ...(requested.contentIdeaId ? { contentIdeaId: requested.contentIdeaId } :
        requested.kind === "idea" && requested.ideaKey ? { ideaKey: requested.ideaKey, contentIdeaId: null, kind: "idea" } : { id: requested.id }) },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  const rows = candidates.filter((r) => videoIdentity(r) === videoIdentity(requested)).sort(compareAttempts);
  const history: AttemptHistoryItem[] = [];
  let incomplete = false;
  for (const row of rows) {
    const item: AttemptHistoryItem = {
      key: `episode:${row.id}`, episodeId: row.id, status: row.status, step: row.step, error: row.error,
      startedAt: row.startedAt?.toISOString() ?? row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null, hasVideo: Boolean(row.videoPath) && row.status === "DONE", archived: false,
      steps: row.steps.map(({ step, status, durationMs }) => ({ step, status, durationMs })),
    };
    if (row.id !== rows[0].id) history.push(item);
    if (!/^[\w-]+$/.test(row.id)) continue;
    const dir = path.join(WORK_ROOT, "generation-evidence", row.id);
    const files = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") incomplete = true;
      return [] as string[];
    });
    const seen = new Set<string>();
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const snapshot = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
        // Validation-only archives supplement a retry snapshot; they are not extra attempts.
        if (snapshot.reason !== "before-retry" || snapshot.episode?.id !== row.id) continue;
        const old = snapshot.episode;
        if (old.userId && old.userId !== userId) continue;
        // A transaction may archive successfully then roll back. That snapshot
        // is still the current record, not an additional historical attempt.
        if (old.status === row.status && old.startedAt === (row.startedAt?.toISOString() ?? null) &&
            old.finishedAt === (row.finishedAt?.toISOString() ?? null)) continue;
        const key = `archive:${row.id}:${old.startedAt ?? old.finishedAt ?? file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        history.push({
          key, episodeId: row.id, status: String(old.status), step: String(old.step),
          error: typeof old.error === "string" ? old.error : null,
          startedAt: old.startedAt ?? old.createdAt ?? null, finishedAt: old.finishedAt ?? null,
          // A snapshot's path can have been overwritten; never advertise it as a preserved render.
          hasVideo: false, archived: true,
          steps: Array.isArray(snapshot.steps) ? snapshot.steps.map((s: AttemptHistoryItem["steps"][number]) =>
            ({ step: s.step, status: s.status, durationMs: s.durationMs })) : [],
        });
      } catch { incomplete = true; }
    }
  }
  history.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || a.key.localeCompare(b.key));
  return { latestEpisodeId: rows[0]?.id ?? requested.id, attempts: history, incomplete };
}
