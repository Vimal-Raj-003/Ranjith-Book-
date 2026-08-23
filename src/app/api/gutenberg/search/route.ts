import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { searchBooks, toPage } from "@/lib/gutenberg/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browse and search Project Gutenberg.
 *
 * Session-guarded like every other route here: this makes an outbound request
 * on the server's behalf, so leaving it open would hand an anonymous caller a
 * free proxy for scanning someone else's API from this app's IP.
 *
 * `searchBooks` returns a typed failure rather than throwing, so a slow or
 * absent Gutendex becomes a sentence in the UI. It is answered with 200 and an
 * `error` field rather than an upstream status: from the client's point of
 * view the request succeeded, and the thing that failed was Gutenberg. Only
 * the session check produces a non-200 here.
 */
export async function GET(req: Request) {
  try {
    await requireUser();

    const params = new URL(req.url).searchParams;
    const result = await searchBooks({
      search: params.get("q") ?? undefined,
      topic: params.get("topic") ?? undefined,
      languages: params.get("languages") ?? undefined,
      page: toPage(params.get("page") ?? 1),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: 200 });
    }

    return NextResponse.json(result.value, {
      // The catalogue barely moves and Gutendex is slow; a minute of shared
      // caching turns a second search for the same term into a free one.
      // Public is safe: this is a public-domain catalogue, identical for every
      // signed-in user, and carries nothing account-specific.
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
