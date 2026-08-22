/**
 * Auth configuration, read from the environment only. Nothing here is ever
 * committed: the SMTP password lives in the deployment's env file.
 */
export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function mailConfig(): MailConfig | null {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!user || !pass) return null;

  const port = Number(process.env.SMTP_PORT ?? 465);
  return {
    // Zoho splits by datacenter: .in for accounts created in India, .com elsewhere.
    host: process.env.SMTP_HOST?.trim() || "smtp.zoho.in",
    port,
    secure: port === 465,
    user,
    pass,
    from: process.env.SMTP_FROM?.trim() || `BookReel <${user}>`,
  };
}

/**
 * Who may sign in. This app spends the machine's Claude/Codex subscription on
 * every run, so an open signup on a public URL is a direct cost exposure —
 * the allowlist is the control that keeps it closed by default.
 *
 * `AUTH_ALLOWED_EMAILS` accepts exact addresses, `*@domain` wildcards, and a
 * bare `*` meaning "any address that can receive a code".
 * Unset means "only the mailbox that sends the codes", never "anyone".
 */
export function allowedEmails(): string[] {
  const raw = process.env.AUTH_ALLOWED_EMAILS?.trim();
  if (raw) {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  const owner = process.env.SMTP_USER?.trim().toLowerCase();
  return owner ? [owner] : [];
}

export function isAllowed(email: string): boolean {
  const addr = email.trim().toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  return allowedEmails().some(
    (rule) =>
      // A bare `*` opens signup to anyone who can read the code we email them.
      // On a public URL that is a direct cost exposure, not just an auth choice.
      rule === "*" ||
      rule === addr ||
      (rule.startsWith("*@") && rule.slice(2) === domain),
  );
}

/**
 * Dev-only sign-in bypass: lets `/api/auth/request` hand back the generated
 * code instead of emailing it, for local development where SMTP isn't set up.
 *
 * Both conditions are required, not either: `NODE_ENV !== "production"` means
 * a production build/deploy can never take this path regardless of what env
 * vars leak into it, and `AUTH_DEV_LOGIN=1` means it stays off even in dev
 * unless someone opts in on purpose. A single flag would be a backdoor that
 * only needs one stray env var in production to open; this needs both.
 */
export function isDevLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_LOGIN === "1";
}

export const SESSION_COOKIE = "bookreel_session";
export const SESSION_DAYS = 30;
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
