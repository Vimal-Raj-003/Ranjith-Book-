// Render three videos on substantially different topics, through the REAL
// pipeline, and report what each one actually produced.
//
// Fresh episodes rather than re-renders: the theme is stamped at creation, so
// re-rendering an existing episode would reuse the theme that was stamped
// before the content-derived picker existed and would prove nothing about it.
//
//   node --import tsx scripts/_validate3.mjs
import { prisma } from "../src/lib/db.ts";
import { createIdeaEpisodes } from "../src/lib/episodes/idea-episode.ts";
import { runEpisode } from "../src/lib/pipeline.ts";

// One upload per subject, chosen to be as far apart as this library goes:
// how to spend a day, how money behaves, and Roman stoicism.
const UPLOADS = [
  { id: "cmus6k11a00cnn6dcl96re8r8", subject: "time management (Arnold Bennett)" },
  { id: "cmup1tydo0001n6w8xkrd5t3t", subject: "money (Morgan Housel)" },
  { id: "cmukwhyoi0002n6ckexsfp2s1", subject: "stoic philosophy (Meditations)" },
];

const results = [];
for (const up of UPLOADS) {
  // The best-ranked idea that does not already have an episode, so each run
  // renders something new rather than colliding with the reservation on an
  // idea that has already been made.
  const ideas = await prisma.contentIdea.findMany({
    where: { uploadId: up.id },
    include: { episodes: true },
    orderBy: { rank: "asc" },
  });
  const idea = ideas.find((i) => i.episodes.length === 0) ?? ideas[0];
  if (!idea) {
    console.log(`[${up.subject}] no ideas on this upload — skipped`);
    continue;
  }

  const t0 = Date.now();
  const [created] = await createIdeaEpisodes(up.id, [idea.id], null);
  const row = await prisma.episode.findUniqueOrThrow({ where: { id: created.episodeId } });
  console.log(`\n=== ${up.subject}`);
  console.log(`  idea:    ${idea.title}`);
  console.log(`  episode: ${created.episodeId}  (created=${created.created})`);
  // Say WHICH path produced the theme. An unconditional "content-derived"
  // label here once made three runs look like a demonstration of the picker
  // when every one of them was really the operator's pinned setting being
  // honoured — the report was wrong because the log was.
  const setting = await prisma.setting.findUnique({ where: { key: "theme" } });
  const pinned = setting?.value && setting.value !== "auto" ? setting.value : null;
  console.log(`  theme:   ${row.theme}   <- ${pinned ? `operator setting "${pinned}"` : "derived from the idea's own text"}`);

  try {
    await runEpisode(created.episodeId);
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    results.push({ ...up, episodeId: created.episodeId, theme: row.theme, error: String(err) });
    continue;
  }

  const done = await prisma.episode.findUniqueOrThrow({ where: { id: created.episodeId } });
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`  status:  ${done.status}  in ${mins} min`);
  console.log(`  video:   ${done.videoPath ?? "(none)"}`);
  results.push({
    ...up,
    episodeId: created.episodeId,
    title: idea.title,
    theme: done.theme,
    status: done.status,
    minutes: mins,
    videoPath: done.videoPath,
    projectPath: done.projectPath,
  });
}

console.log("\n\n================ SUMMARY ================");
for (const r of results) {
  console.log(`${(r.theme ?? "?").padEnd(11)} ${String(r.status ?? "ERROR").padEnd(7)} ${String(r.minutes ?? "-").padStart(5)}min  ${r.subject}`);
  console.log(`            ${r.videoPath ?? r.error ?? ""}`);
}
console.log("distinct themes:", new Set(results.map((r) => r.theme)).size, "of", results.length);
await prisma.$disconnect();
