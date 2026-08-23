"use client";

import { useSyncExternalStore } from "react";
import { strings } from "@/lib/strings";

const KEY = "bookreel-theme";

/**
 * Light / dark, persisted under the same key the pre-paint script in
 * `layout.tsx` reads, so a reload never flashes the other theme.
 *
 * The live value is an attribute on <html>, i.e. state outside React, so it is
 * read through `useSyncExternalStore`: the server snapshot is `null` (there is
 * no document), hydration matches, and the observer means the label stays
 * right even if something else flips the attribute.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function readTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore<"light" | "dark" | null>(subscribe, readTheme, () => null);

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A browser with storage blocked still gets the theme for this session.
    }
  }

  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={theme === null}
      className="nav-item justify-between"
      aria-label={isLight ? strings.themeToggle.toDark : strings.themeToggle.toLight}
    >
      <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--mute-2)" }}>
        {strings.themeToggle.label}
      </span>
      <span className="text-[13px]" style={{ color: "var(--ink)", minWidth: 42, textAlign: "right" }}>
        {theme === null ? "" : isLight ? strings.themeToggle.light : strings.themeToggle.dark}
      </span>
    </button>
  );
}
