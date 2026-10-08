"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { strings } from "@/lib/strings";
import { Badge, RailToggle } from "./ui";
import ThemeToggle from "./ThemeToggle";
import type { View } from "./types";

/**
 * One glyph per section, drawn here rather than imported.
 *
 * `@tabler/icons` is a dependency of this project, but it ships raw `.svg`
 * files that `src/lib/video/scenes/icons.ts` reads off disk with `node:fs` —
 * which a `"use client"` component can never do. Five 24px paths are smaller
 * than any client-side icon package and add no runtime dependency, which the
 * brief for this work forbids.
 */
const GLYPHS: Record<View, string> = {
  // A clapperboard: the studio.
  studio: "M4 7h16v12H4zM4 7l2.5-3h3L7 7M11 7l2.5-3h3L14 7",
  // A book.
  books: "M5 4h9a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM16 6h3v14h-3",
  // Stacked frames: the library.
  library: "M4 5h6v14H4zM12 5h3v14h-3M17 6l3 1-3 12",
  // A download arrow onto a shelf: free books come from elsewhere.
  "free-books": "M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M5 17v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2",
  // A queue of bars.
  queue: "M5 6h14M5 12h14M5 18h8",
};

function Glyph({ view }: { view: View }) {
  return (
    <span className="nav-glyph" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={GLYPHS[view]} />
      </svg>
    </span>
  );
}

const ITEMS: { id: View; label: string; available: boolean }[] = [
  { id: "studio", label: strings.nav.studio, available: true },
  { id: "books", label: strings.nav.books, available: true },
  { id: "library", label: strings.nav.library, available: true },
  { id: "free-books", label: strings.nav.freeBooks, available: true },
  { id: "queue", label: strings.nav.queue, available: false },
];

/**
 * Brand, the five sections, and the account footer — and, since the operator
 * asked for it, a control that folds the whole rail down to a 54px strip of
 * glyphs so the workbench gets the width back.
 *
 * Collapsed, nothing is removed: the same five buttons are there in the same
 * order with the same `aria-current`, carrying their label as the accessible
 * name and the tooltip instead of as text. The account block and the theme
 * toggle fold with it, which is the one real loss — both are one click away
 * again and neither is touched during a run.
 *
 * "Queue" has no backend. It is still listed — the operator asked to see where
 * the app is going — but it is `aria-disabled`, never `disabled`: a disabled
 * button leaves the tab order, so the one row explaining what is coming would
 * become unreachable by keyboard. The click is refused in the handler.
 */
export default function Sidebar({
  view,
  onView,
  email,
  collapsed = false,
  onToggleCollapsed,
}: {
  view: View;
  onView: (v: View) => void;
  email: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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

  /**
   * One tree, two shapes — never an early return.
   *
   * `.rail-top` is present in both states and the toggle is its first child in
   * both, so React reconciles the same button rather than unmounting one and
   * mounting another. That is what keeps keyboard focus on it across a click
   * and what lets a screen reader hear `aria-expanded` flip on an element it
   * is already following.
   *
   * The two bodies are both rendered and the inactive one carries `hidden`,
   * which takes it out of layout, the tab order and the accessibility tree
   * while leaving its DOM alive.
   */
  return (
    <div className={collapsed ? "rail-strip" : "side-inner"}>
      <div className="rail-top">
        {onToggleCollapsed && (
          <RailToggle
            rail="side"
            expanded={!collapsed}
            label={strings.layout.toggleSections}
            onToggle={onToggleCollapsed}
          />
        )}
        <div className="side-brand min-w-0 flex-1" hidden={collapsed}>
          <div className="font-display text-[17px] font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
            {strings.app.brand}
          </div>
          <p className="mt-1 text-[12px] leading-snug" style={{ color: "var(--mute-2)" }}>
            {strings.app.tagline}
          </p>
        </div>
      </div>

      <nav aria-label={strings.nav.label} className="rail-strip-nav" hidden={!collapsed}>
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="rail-chip"
            data-view={item.id}
            aria-current={view === item.id ? "page" : undefined}
            aria-disabled={!item.available}
            aria-label={item.available ? strings.layout.goTo(item.label) : `${item.label} — ${strings.nav.comingSoonHint}`}
            title={item.available ? item.label : `${item.label} — ${strings.nav.comingSoonHint}`}
            onClick={() => item.available && onView(item.id)}
          >
            <Glyph view={item.id} />
            <span className="rail-text">{item.label}</span>
          </button>
        ))}
      </nav>

      <nav className="side-nav" aria-label={strings.nav.label} hidden={collapsed}>
        <ul role="list" className="flex flex-col gap-1">
          {ITEMS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="nav-item"
                data-view={item.id}
                aria-current={view === item.id ? "page" : undefined}
                aria-disabled={!item.available}
                title={item.available ? undefined : strings.nav.comingSoonHint}
                onClick={() => item.available && onView(item.id)}
              >
                <Glyph view={item.id} />
                <span className="flex-1">{item.label}</span>
                {!item.available && <Badge tone="soon">{strings.nav.comingSoon}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="side-foot" hidden={collapsed}>
        <ThemeToggle />
        <div className="side-account px-3 pt-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
            {strings.account.label}
          </div>
          <div className="mt-1 truncate text-[13px]" style={{ color: "var(--ink)" }} title={email}>
            {email}
          </div>
        </div>
        {/* `aria-disabled` while the request is out, for the same reason the
            voice preview uses it: a button that disables itself drops keyboard
            focus mid-action. `signOut` returns early instead. */}
        <button type="button" onClick={signOut} aria-disabled={signingOut} aria-busy={signingOut} className="nav-item">
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
