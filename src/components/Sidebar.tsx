"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { strings } from "@/lib/strings";
import { Badge } from "./ui";
import ThemeToggle from "./ThemeToggle";
import type { View } from "./types";

const ITEMS: { id: View; label: string; available: boolean }[] = [
  { id: "studio", label: strings.nav.studio, available: true },
  { id: "books", label: strings.nav.books, available: true },
  { id: "library", label: strings.nav.library, available: true },
  { id: "free-books", label: strings.nav.freeBooks, available: true },
  { id: "queue", label: strings.nav.queue, available: false },
];

/**
 * Brand, the three sections, and the account footer.
 *
 * "Queue" has no backend. It is still listed — the operator asked to see where
 * the app is going — but it is a real disabled button carrying a "Soon" badge,
 * so it can never be mistaken for a link that is simply broken.
 */
export default function Sidebar({
  view,
  onView,
  email,
}: {
  view: View;
  onView: (v: View) => void;
  email: string;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/me", { method: "DELETE" });
      if (!res.ok) throw new Error();
      router.replace("/login");
      router.refresh();
    } catch {
      setError(strings.account.signOutError);
      setSigningOut(false);
    }
  }

  return (
    <div className="side-inner">
      <div className="side-brand">
        <div className="font-display text-[17px] font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
          {strings.app.brand}
        </div>
        <p className="mt-1 text-[12px] leading-snug" style={{ color: "var(--mute-2)" }}>
          {strings.app.tagline}
        </p>
      </div>

      <nav className="side-nav" aria-label={strings.nav.label}>
        <ul role="list" className="flex flex-col gap-1">
          {ITEMS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="nav-item"
                aria-current={view === item.id ? "page" : undefined}
                disabled={!item.available}
                title={item.available ? undefined : strings.nav.comingSoonHint}
                onClick={() => item.available && onView(item.id)}
              >
                <span className="flex-1">{item.label}</span>
                {!item.available && <Badge tone="soon">{strings.nav.comingSoon}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="side-foot">
        <ThemeToggle />
        <div className="side-account px-3 pt-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
            {strings.account.label}
          </div>
          <div className="mt-1 truncate text-[13px]" style={{ color: "var(--ink)" }} title={email}>
            {email}
          </div>
        </div>
        <button type="button" onClick={signOut} disabled={signingOut} className="nav-item">
          {signingOut ? strings.account.signingOut : strings.account.signOut}
        </button>
        {error && (
          <p role="alert" className="px-3 text-[12px]" style={{ color: "var(--rose)" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
