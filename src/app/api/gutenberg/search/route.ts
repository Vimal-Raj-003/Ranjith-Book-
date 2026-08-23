import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { searchCatalog } from "@/lib/gutenberg/catalog";
import { toPage } from "@/lib/gutenberg/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Search Project Gutenberg — locally.
 *
 * This route used to call `gutendex.com`, and that is exactly why the operator
 * could not use the page: an uncached search there takes 30–45 seconds, so
 * every honest timeout became "Project Gutenberg took too long to answer".
 * There is no outbound request here any more. `searchCatalog` reads the
 * catalogue this app imported once, so the answer is a SQLite query and the
 * only remaining "failure" is a catalogue that has never been synced — which
 * is a state with a button, not an error.
 *
 * Still session-guarded. It reads a table only signed-in users are entitled to
 * query, and leaving it open would hand an anonymous caller unmetered access
 * to run `LIKE` scans against 76,000 rows.
 *
 * A failure is still answered with 200 and an `error` field, unchanged from
 * before: the client already distinguishes the two shapes and there is no
 * reason to churn it.
 */
export async function GET(req: Request) {
  try {
    await requireUser();

    const params = new URL(req.url).searchParams;
    const result = await searchCatalog({
      search: params.get("q") ?? undefined,
      page: toPage(params.get("page") ?? 1),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: 200 });
    }

    return NextResponse.json(result.value, {
      // Nothing to cache away any more — the query is local and fast, and a
      // stale page after a re-sync would be a worse trade than the microsecond
      // it saves.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
