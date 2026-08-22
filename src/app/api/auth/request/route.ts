import { NextResponse } from "next/server";
import { requestCode, AuthError } from "@/lib/auth/otp";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    const result = await requestCode(String(email ?? ""));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
