import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { listEpisodes } from "@/lib/episodes/list";

/**
 * The library list.
 *
 * This route previously had no `requireUser()` at all: an unauthenticated
 * request listed every episode in the database, with its title and its book's
 * title, for every account. That was a real disclosure, not just a UI
 * annoyance — and it also produced the reported symptom of a library that
 * listed rows which then 404'd when opened, because `GET /api/episodes/[id]`
 * was scoped and this was not. The visibility rule now lives in one place
 * (`listEpisodes`) so the two cannot drift apart again.
 */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ episodes: await listEpisodes(user.id) });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
