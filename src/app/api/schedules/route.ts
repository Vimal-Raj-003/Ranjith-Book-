import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { AppError, errorBody, errorStatus } from "@/lib/errors";
import { episodeSlotView, saveDraft, scheduleView } from "@/lib/schedule/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Weekly Schedule: plan a book's finished videos across a week of YouTube
 * publish times. This route only PLANS; `./[id]/activate` is what puts anything on
 * YouTube.
 *
 * GET `?uploadId=` answers the newest schedule for that book (draft or active) with
 * each slot's status and its live YouTube job, or `{ schedule: null }`. Polled by the
 * panel while a run is going.
 *
 * GET `?episodeId=` answers `{ slot }`: where that one video sits in the newest ACTIVATED
 * schedule of this account that holds it (its exact `assignedAt`), or `{ slot: null }`. The
 * Publish page reads it so a video in an activated schedule is posted at the schedule's
 * instant and no other. Read-only.
 *
 * POST saves the book's DRAFT -- `{ uploadId, weekStart, days, timeSlots, timezone?,
 * madeForKids?, videoIds }` -- computing every slot's exact UTC time in the schedule's
 * zone (Asia/Kolkata unless told otherwise) and replacing the draft's slots. It
 * refuses another account's book, and any video that is not a finished video of
 * this book that this account owns.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const episodeId = params.get("episodeId");
    if (episodeId) return NextResponse.json(await episodeSlotView(user.id, episodeId));
    const uploadId = params.get("uploadId");
    if (!uploadId) throw new AppError("bad_schedule", "Say which book (?uploadId=) or which video (?episodeId=)", 400);
    return NextResponse.json(await scheduleView(user.id, uploadId));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    return NextResponse.json(await saveDraft(user.id, body));
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
