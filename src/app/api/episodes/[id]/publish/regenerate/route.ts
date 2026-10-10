import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { regenerateField } from "@/lib/publish/regenerate";
import { isMetadataField, loadForRegenerate, publishView, storeRegenerated, wasHandEdited } from "@/lib/publish/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A model call, and this one inherits the operator's CLI configuration (it is
 * not one of `EPISODE_KINDS`, so `cli.ts` does not isolate it), so the floor is
 * a few seconds and the watchdogs in `cli.ts` are the ceiling: 150 s of silence
 * or 11 minutes outright. Next's default function timeout would cut that short,
 * so it is raised to just past the hard ceiling rather than left to chance.
 */
export const maxDuration = 700;

/**
 * Re-derive ONE metadata field from the book and the script.
 *
 * `{ field }` names which: `title`, `description`, `hashtags`, `tags` (YouTube
 * keyword tags), or the independent Instagram `igHook` / `igCaption` /
 * `igHashtags`.
 *
 * THE CONFIRMATION. A field the operator has typed over is NOT overwritten on
 * the first ask. The route answers 409 `needs_confirmation` and the client puts
 * the question to them; a second request carrying `confirm: true` goes through.
 * That is the whole protection behind "never overwrite a manual edit without
 * explicit confirmation", and it lives here rather than in the component so a
 * second client (or curl) cannot skip it.
 *
 * Nothing is written unless the writer returns something usable. A refused,
 * empty or over-long reply leaves the stored field exactly as it was and says
 * so — a half-applied regenerate that blanked a description would cost the
 * operator words they cannot get back.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "Sign in to continue.", code: "unauthorized" }, { status: 401 });

    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { field?: unknown; confirm?: unknown } | null;
    const field = body?.field;
    if (!isMetadataField(field)) {
      return NextResponse.json(
        {
          error:
            "Name the field to regenerate: title, description, hashtags, tags, igHook, igCaption or igHashtags.",
          code: "bad_field",
        },
        { status: 400 },
      );
    }

    const row = await loadForRegenerate(user.id, id);

    if (wasHandEdited(row, field) && body?.confirm !== true) {
      return NextResponse.json(
        {
          error: `You edited this ${field} by hand. Regenerating replaces what you wrote.`,
          code: "needs_confirmation",
          field,
        },
        { status: 409 },
      );
    }

    const result = await regenerateField(field, {
      bookTitle: row.book.title,
      // The pipeline's own rule, not a copy of the condition: an author that was
      // never verified is ABSENT, never a placeholder and never implied.
      author: row.book.authorVerified ? row.book.author : null,
      archetype: row.book.archetype,
      bookLink: row.book.bookLink,
      title: row.title,
      hook: row.hook,
      cta: row.cta,
      script: row.script,
      voScript: row.voScript,
    });

    await storeRegenerated(id, field, result.value);
    return NextResponse.json(await publishView(user.id, id));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
