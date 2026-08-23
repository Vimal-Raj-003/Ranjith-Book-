import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { errorBody, errorStatus } from "@/lib/errors";
import { catalogStatus, startCatalogSync } from "@/lib/gutenberg/catalog";
import { copy } from "@/lib/gutenberg/copy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The catalogue's state, and the button that fills it.
 *
 * `GET` is what the pane polls: whether a catalogue exists at all, how many
 * rows it has, when it was synced, and — while a sync is running — which phase
 * it is in and how many rows have landed.
 *
 * `POST` starts a sync and returns immediately. It does not await it. The work
 * takes about half a minute, which is longer than any proxy in front of this
 * app is obliged to hold a connection open, and a sync that dies because the
 * request that started it was cut would be a genuinely confusing bug. The
 * background run reports through the same `GET`.
 *
 * There is no parameter on either verb. The URL the sync fetches is a
 * constant, so there is nothing here a caller could point somewhere else.
 */
export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(await catalogStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}

export async function POST() {
  try {
    await requireUser();

    const { started } = startCatalogSync();
    // Read the status *after* starting, so the body the client gets back
    // already carries the running progress rather than the state before it.
    const status = await catalogStatus();

    // 409 rather than an error body: a second click while a sync is running is
    // not a failure, and the client shows the running sync either way.
    return NextResponse.json(
      { started, ...status, ...(started ? {} : { error: copy.catalogBusy }) },
      { status: started ? 202 : 409, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
