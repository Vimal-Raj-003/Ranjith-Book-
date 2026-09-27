import crypto from "node:crypto";
import { prisma } from "../db";
import { sendLoginCode } from "./mailer";
import { CODE_TTL_MS, MAX_ATTEMPTS, isAllowed, isDevLoginEnabled, mailConfig } from "./config";
import { createSession, purgeExpired } from "./session";

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

const normalize = (email: string) => email.trim().toLowerCase();

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Six digits, drawn from a CSPRNG rather than Math.random. */
function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Issue a code and email it. One live code per address: requesting again
 * invalidates the previous one, so a forwarded old email cannot be reused.
 */
export async function requestCode(rawEmail: string) {
  const email = normalize(rawEmail);
  if (!EMAIL_RE.test(email)) throw new AuthError("That doesn't look like an email address.");
  if (!isAllowed(email)) {
    throw new AuthError(
      "This address isn't approved for BookReel. Ask the owner to add it to the allowlist.",
      403,
    );
  }

  // Fail before storing anything. Writing the code first would spend one of the
  // three per-10-minute slots on a request that could never have been delivered,
  // so a misconfigured mailbox would also lock the user out of retrying.
  //
  // AUTH_DEV_LOGIN does two different jobs depending on whether SMTP exists.
  //
  //   no SMTP  -> `devBypass`: nothing is emailed, the code comes back in the
  //               response because there is no other way to get it.
  //   SMTP set -> `devReveal`: the real email is still sent, exactly as in
  //               production, and the code is ALSO returned so a developer on
  //               localhost does not have to go and read an inbox (and dig it
  //               out of a spam folder) on every sign-in.
  //
  // Delivery is never weakened by the second case — that was the original
  // reason SMTP overrode the bypass entirely, and it still holds: configuring
  // real SMTP gets you production-like *delivery*. What it no longer does is
  // hide the code from a developer who has explicitly asked to see it.
  //
  // Both are gated by `isDevLoginEnabled()`, which requires BOTH
  // NODE_ENV !== "production" AND AUTH_DEV_LOGIN=1, so neither can happen on
  // a deployed instance however the env is set.
  const smtp = mailConfig();
  const devReveal = isDevLoginEnabled();
  const devBypass = !smtp && devReveal;
  if (!smtp && !devBypass) {
    throw new AuthError(
      "Email is not configured on this server yet. Set SMTP_USER and SMTP_PASS.",
      503,
    );
  }

  await purgeExpired();

  // Rate limit per address: at most 3 codes in 10 minutes.
  const recent = await prisma.loginCode.count({
    where: { email, createdAt: { gt: new Date(Date.now() - CODE_TTL_MS) } },
  });
  if (recent >= 3) {
    throw new AuthError("Too many codes requested. Wait a few minutes and try again.", 429);
  }

  const code = newCode();
  await prisma.loginCode.deleteMany({ where: { email } });
  await prisma.loginCode.create({
    data: { email, codeHash: sha256(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });

  if (devBypass) {
    // Loud on purpose: this only runs when NODE_ENV !== "production" AND
    // AUTH_DEV_LOGIN=1, so anyone reading server logs (or the response body)
    // sees plainly that no email was sent and why.
    console.warn(
      `[DEV LOGIN BYPASS] SMTP is not configured, so no email was sent. ` +
        `Sign-in code for ${email}: ${code} (expires in ${CODE_TTL_MS / 60_000} min). ` +
        `This bypass only exists because NODE_ENV !== "production" and AUTH_DEV_LOGIN=1 — ` +
        `it cannot run in production.`,
    );
    return {
      email,
      dev: true,
      devCode: code,
      warning:
        "DEVELOPMENT BYPASS: SMTP is not configured, so this code was not emailed — " +
        "it is returned here instead because NODE_ENV !== 'production' and AUTH_DEV_LOGIN=1. " +
        "This never happens in production.",
    };
  }

  await sendLoginCode(email, code);

  if (devReveal) {
    console.warn(
      `[DEV LOGIN] The code was emailed as usual, and is also being returned in ` +
        `the response for ${email}: ${code}. This only happens because ` +
        `NODE_ENV !== "production" and AUTH_DEV_LOGIN=1.`,
    );
    return {
      email,
      dev: true,
      devCode: code,
      warning:
        "DEVELOPMENT ONLY: this code was emailed normally and is shown here as well, " +
        "because NODE_ENV !== 'production' and AUTH_DEV_LOGIN=1. It is never returned in production.",
    };
  }

  return { email };
}

/**
 * Check the code and sign the address in, creating the account on first use.
 * Signup and login are the same act: the allowlist is what decides who exists.
 */
export async function verifyCode(rawEmail: string, rawCode: string) {
  const email = normalize(rawEmail);
  const code = rawCode.replace(/\D/g, "");

  const record = await prisma.loginCode.findFirst({
    where: { email },
    orderBy: { createdAt: "desc" },
  });
  if (!record) throw new AuthError("Ask for a new code — that one is no longer valid.");
  if (record.expiresAt < new Date()) {
    await prisma.loginCode.deleteMany({ where: { email } });
    throw new AuthError("That code expired. Ask for a new one.");
  }
  // Claim an attempt before comparing anything. Reading the counter and then
  // incrementing it would let a burst of concurrent requests all observe the
  // same pre-increment value and sail past the cap together, which turns a
  // five-guess limit into as many guesses as the attacker can open sockets.
  // The conditional update is a single atomic statement: exactly MAX_ATTEMPTS
  // of them can ever match.
  const claimed = await prisma.loginCode.updateMany({
    where: { id: record.id, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    await prisma.loginCode.deleteMany({ where: { email } });
    throw new AuthError("Too many wrong tries. Ask for a new code.", 429);
  }

  // Constant-time compare so a wrong code leaks nothing through timing.
  const given = Buffer.from(sha256(code));
  const want = Buffer.from(record.codeHash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const left = MAX_ATTEMPTS - record.attempts - 1;
    throw new AuthError(
      left > 0 ? `That code is wrong. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code is wrong.",
    );
  }

  await prisma.loginCode.deleteMany({ where: { email } });

  const user = await prisma.user.upsert({
    where: { email },
    create: { email },
    update: { lastSeenAt: new Date() },
  });
  await createSession(user.id);

  return { id: user.id, email: user.email, name: user.name };
}
