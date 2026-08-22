import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "../db";
import { SESSION_COOKIE, SESSION_DAYS } from "./config";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

/** Issue a session and set the cookie. The raw token never touches the database. */
export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt } });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Behind the nginx TLS terminator the app itself speaks http, so the flag
    // has to come from configuration rather than from the request protocol.
    secure: process.env.AUTH_COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;

  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

/** Route-handler guard: returns the user or throws a 401-shaped error. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const err = new Error("Sign in to continue.") as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  return user;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }
  jar.delete(SESSION_COOKIE);
}

export async function purgeExpired() {
  const now = new Date();
  await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.loginCode.deleteMany({ where: { expiresAt: { lt: now } } });
}
