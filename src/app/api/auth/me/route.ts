import { NextResponse } from "next/server";
import { currentUser, destroySession } from "@/lib/auth/session";

export async function GET() {
  return NextResponse.json({ user: await currentUser() });
}

/** Sign out. */
export async function DELETE() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
