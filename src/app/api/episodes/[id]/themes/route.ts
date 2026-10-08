import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { canSee } from "@/lib/episodes/visibility";
import { themeTop } from "@/lib/video/composition/themes/choose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many suggestions the inspector shows. */
const TOP = 3;

/**
 * Which themes suit this episode, best first.
 *
 * This is `themes/choose.ts`'s OWN ranking surfaced to the picker, never a
 * second matcher: `themeForTextSync` — the function that stamps an episode — is
 * now literally `themeTop(text, 1)[0]`, one pipeline with one scoring, one
 * tie-break and one `spread` fallback.
 *
 * What that does NOT mean, and the panel's copy is careful about it: this is
 * not a reconstruction of the decision an auto-stamped episode already got.
 * That decision was made at creation from the words available then — for a
 * photo episode, the planned part's title, chapter heading and opening prose;
 * for an idea episode, the idea brief — and it was frozen onto the row. This
 * ranks the finished row's own title, hook and script, which is the only text
 * that exists by the time anyone is looking at this panel. Same matcher,
 * different input, so the answers can legitimately differ, and claiming
 * otherwise would be the kind of plausible-sounding falsehood that is worse
 * than saying nothing.
 *
 * The keyword floor (`themeTop`), not the embedding ranker, deliberately. This
 * runs inside a panel the operator is looking at, where loading a sentence
 * model would be seconds of nothing; the ranker's own doc comment makes the
 * same distinction for `createIdeaEpisodes`. The floor needs no model, no cache
 * directory and no network, and it is what the ranker degrades to anyway.
 *
 * The text is the episode's own words as the row already holds them — its
 * title, its hook, and the narration script. Nothing is read off disk and
 * nothing is recomputed, so this is one indexed row read.
 *
 * A suggestion is advisory and the operator stays in control: nothing here
 * writes, and the picker never pre-selects from it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await ctx.params;

  const episode = await prisma.episode.findUnique({
    where: { id },
    select: { id: true, userId: true, title: true, hook: true, voScript: true, book: { select: { title: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
  // `episodes/visibility.ts`, not a hand-rolled copy of it: the poster routes
  // drifted from exactly this line once and the symptom was a card showing the
  // wrong picture.
  if (!canSee(episode, user.id)) {
    return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
  }

  const text = [episode.book.title, episode.title, episode.hook, episode.voScript]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");

  return NextResponse.json({ themes: themeTop(text, TOP) });
}
