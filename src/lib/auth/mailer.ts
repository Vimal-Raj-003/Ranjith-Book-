import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { mailConfig } from "./config";

const globalForMail = globalThis as unknown as { mailer?: Transporter };

function transport(): Transporter {
  const cfg = mailConfig();
  if (!cfg) {
    throw new Error(
      "Email is not configured. Set SMTP_USER and SMTP_PASS in the server environment.",
    );
  }
  if (globalForMail.mailer) return globalForMail.mailer;

  const t = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 2,
  });
  globalForMail.mailer = t;
  return t;
}

function codeEmail(code: string) {
  const spaced = code.split("").join(" ");
  return {
    text: `Your BookReel sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    html: `<!doctype html>
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;padding:40px 20px">
  <div style="max-width:440px;margin:0 auto;background:#14181d;border:1px solid #232a31;border-radius:14px;padding:32px">
    <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#7d8794;font-weight:600">BookReel</div>
    <h1 style="margin:14px 0 8px;font-size:20px;line-height:1.35;color:#e8edf2;font-weight:650">Your sign-in code</h1>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#9aa5b1">Enter this code to finish signing in. It expires in 10 minutes.</p>
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;letter-spacing:.34em;color:#f2b544;background:#0b0d10;border:1px solid #232a31;border-radius:10px;padding:18px;text-align:center;font-weight:600">${spaced}</div>
    <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7480">If you didn't request this, you can ignore this email. Nobody can sign in without the code.</p>
  </div>
</div>`,
  };
}

export async function sendLoginCode(to: string, code: string) {
  const cfg = mailConfig();
  if (!cfg) {
    throw new Error(
      "Email is not configured. Set SMTP_USER and SMTP_PASS in the server environment.",
    );
  }
  const body = codeEmail(code);
  await transport().sendMail({
    from: cfg.from,
    to,
    subject: `${code} is your BookReel sign-in code`,
    ...body,
  });
}

/** Used by the health endpoint so a broken mailbox surfaces before a user hits it. */
export async function verifyMailer(): Promise<{ ok: boolean; detail: string }> {
  const cfg = mailConfig();
  if (!cfg) return { ok: false, detail: "SMTP_USER / SMTP_PASS are not set" };
  try {
    await transport().verify();
    return { ok: true, detail: `${cfg.host}:${cfg.port} as ${cfg.user}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}
