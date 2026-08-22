import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { createUpload } from "@/lib/ingest/create-upload";
import { errorBody, errorStatus } from "@/lib/errors";

/**
 * Thin by design: establish who is asking, then delegate to `createUpload`
 * for everything else. `createUpload` is unit-tested directly (with
 * `userId: null`, since a test has no cookie jar to authenticate with) —
 * this route exists only to supply the session that a real request carries.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const form = await req.formData();
    const result = await createUpload(form, user.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(errorBody(err), { status: errorStatus(err) });
  }
}
