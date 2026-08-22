import { NextResponse } from "next/server";
import { verifyCode, AuthError } from "@/lib/auth/otp";

export async function POST(req: Request) {
  try {
    const { email, code } = await req.json();
    const user = await verifyCode(String(email ?? ""), String(code ?? ""));
    return NextResponse.json({ ok: true, user });
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
