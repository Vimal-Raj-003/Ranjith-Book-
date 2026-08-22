"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Stage = "email" | "code";

export default function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stage === "code") codeRef.current?.focus();
  }, [stage]);

  async function post(path: string, body: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function sendCode(resend = false) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await post("/api/auth/request", { email });
      setStage("code");
      setNote(resend ? "New code sent." : `Code sent to ${email}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/verify", { email, code });
      // The code was right and the server issued a session — but the browser
      // drops the cookie silently if it refuses it, most often a Secure cookie
      // delivered over plain http. Navigating then bounces straight back to
      // /login and this button spins forever with nothing to explain why, so
      // confirm the session actually stuck before leaving the page.
      const me = await fetch("/api/auth/me", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => ({ user: null }));
      if (!me?.user) {
        throw new Error(
          "Your code was correct, but the browser did not keep the session cookie. " +
            "This site is served over http, so set AUTH_COOKIE_SECURE=false on the " +
            "server or put it behind https.",
        );
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-lg border px-3.5 py-3 text-[15px] outline-none transition-colors focus:border-[var(--amber)]";
  const fieldStyle = {
    background: "var(--field)",
    borderColor: "var(--line)",
    color: "var(--ink)",
  };

  return (
    <main
      className="grid min-h-dvh place-items-center px-5 py-10"
      style={{ background: "var(--void)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-[400px]">
        <div className="mb-7">
          <div
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]"
            style={{ color: "var(--mute)" }}
          >
            RepoReel
          </div>
          <h1 className="mt-2 text-[26px] font-semibold leading-tight">
            {stage === "email" ? "Sign in" : "Check your inbox"}
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--mute)" }}>
            {stage === "email"
              ? "We'll email you a six-digit code. No password to remember."
              : `We sent a six-digit code to ${email}. It expires in 10 minutes.`}
          </p>
        </div>

        <div
          className="rounded-xl border p-5"
          style={{ background: "var(--slab)", borderColor: "var(--line)" }}
        >
          {stage === "email" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim() && !busy) void sendCode();
              }}
            >
              <label
                htmlFor="email"
                className="mb-2 block font-mono text-[11px] uppercase tracking-[0.14em]"
                style={{ color: "var(--mute)" }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={field}
                style={fieldStyle}
              />
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="mt-4 w-full rounded-lg px-4 py-3 text-[15px] font-semibold transition-opacity disabled:opacity-45"
                style={{ background: "var(--amber)", color: "var(--on-accent)" }}
              >
                {busy ? "Sending…" : "Email me a code"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 6 && !busy) void submitCode();
              }}
            >
              <label
                htmlFor="code"
                className="mb-2 block font-mono text-[11px] uppercase tracking-[0.14em]"
                style={{ color: "var(--mute)" }}
              >
                Six-digit code
              </label>
              <input
                id="code"
                ref={codeRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                className={`${field} text-center font-mono text-[26px] tracking-[0.4em]`}
                style={fieldStyle}
              />
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="mt-4 w-full rounded-lg px-4 py-3 text-[15px] font-semibold transition-opacity disabled:opacity-45"
                style={{ background: "var(--amber)", color: "var(--on-accent)" }}
              >
                {busy ? "Verifying…" : "Sign in"}
              </button>

              <div className="mt-4 flex items-center justify-between text-[13px]">
                <button
                  type="button"
                  onClick={() => {
                    setStage("email");
                    setCode("");
                    setError(null);
                    setNote(null);
                  }}
                  className="underline underline-offset-4"
                  style={{ color: "var(--mute)" }}
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sendCode(true)}
                  className="underline underline-offset-4 disabled:opacity-45"
                  style={{ color: "var(--mute)" }}
                >
                  Resend code
                </button>
              </div>
            </form>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed"
              style={{ borderColor: "var(--rose)", color: "var(--rose)" }}
            >
              {error}
            </p>
          )}
          {note && !error && (
            <p className="mt-4 text-[13px]" style={{ color: "var(--cyan)" }}>
              {note}
            </p>
          )}
        </div>

        <p className="mt-5 text-[12px] leading-relaxed" style={{ color: "var(--mute-2)" }}>
          Access is limited to approved addresses. Every video run spends the host machine&apos;s
          model subscription, so signup is closed by design.
        </p>
      </div>
    </main>
  );
}
